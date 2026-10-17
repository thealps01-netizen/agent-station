"""agent-station backend: read-only history of delegate_task workers.

The desktop plugin SDK has no way to list a session's delegated child sessions or read a
child's final output, so this router reads state.db directly — opened with SQLite's
``mode=ro`` URI, so it can never write. Only sessions whose ``model_config`` carries
``_delegate_from`` (the marker delegate_task writes on every child) are ever returned;
any other session id is refused, so the router cannot be used to read arbitrary chats.

Background shell processes (terminal background=true) are read from the two files Hermes itself
keeps: ``processes.json`` (running, the crash-recovery checkpoint) and
``logs/process-results/proc_*.json`` (finished, one durable receipt each, 7 days / 64 files).
A process belongs to a conversation when its ``parent_session_id`` is a link of that
conversation's compression chain — the same ownership rule Hermes applies when it reloads a
receipt (tools/process_registry_results.py::_owns_result).

Routes (mounted at /api/plugins/agent-station/):
  GET /children?session_id=<id>  -> workers delegated from that conversation, grouped into
                                    batches (children started within BATCH_GAP_S of each other);
                                    each worker carries Hermes' own cost record (see _cost)
  GET /output?session_id=<id>&worker_id=<child> -> the child's final answer, full length; 403 when
                                    the child was not delegated from that conversation
  GET /processes?session_id=<id> -> that conversation's background processes, running and finished
  GET /process_output?session_id=<id>&process_id=<proc_...> -> a finished process's output tail
  GET /files?session_id=<id>     -> the files that conversation and its workers read or wrote with
                                    the file tools (read_file, write_file, patch); see list_files
  GET /replay?session_id=<id>    -> that conversation's edits (write_file, patch) grouped under the user's
                                    request they followed, newest first, without their lines; see build_replay
  GET /replay_step?session_id=<id>&step_id=<id> -> one edit's removed / added lines; 403 for another chat's

Files are read from the tool calls state.db recorded — the same messages the chat shows. Edits made
through terminal commands or code runs carry no file path Hermes records, so they never appear here;
the page says so next to the list.
"""

from __future__ import annotations

import json
import logging
import os
import posixpath
from contextlib import closing
import re
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()
log = logging.getLogger(__name__)

BATCH_GAP_S = 2.0  # delegate_task starts a batch's children within ~1 s of each other
MAX_CHAIN = 100  # compression chains deeper than this are pathological
GOAL_CHARS = 240
COMMAND_CHARS = 4000  # a command longer than this is cut for display and flagged
OUTPUT_TAIL = 8000  # last chars of a finished process's output served to the detail
STALE_S = 1800  # a worker silent this long (no heartbeat, no message) with no end is not running
PROC_ID = re.compile(r"proc_\w+")
_RECEIPTS: dict[tuple[str, float, int], dict | bool] = {}
FILE_TOOLS = ("read_file", "write_file", "patch")
MAX_FILES = 400  # a conversation that touched more lists its newest MAX_FILES and says how many more
_FILES_CACHE: dict[tuple, dict] = {}
_DRIVE = re.compile(r"^[A-Za-z]:/")
EDIT_TOOLS = ("write_file", "patch")
MAX_TURNS = 40  # newest requests with edits; older ones are counted in `more_turns`
MAX_STEPS = 200  # edits listed per request; the rest are counted in `more_steps`
STEP_LINES = 400  # lines served per edit; the rest are counted in `cut`
LINE_CHARS = 400
ASK_CHARS = 300
_REPLAY_CACHE: dict[tuple, dict] = {}
# Messages Hermes itself posts in the user's place: they continue a request, they are not one.
_NOT_A_REQUEST = re.compile(
    r"^\[(CONTEXT COMPACTION|ASYNC DELEGATION|IMPORTANT: Background process|IMPORTANT: \d+ background process"
    r"|IMPORTANT: You are running|OUT-OF-BAND USER MESSAGE|Your active task list|STILL IN PROGRESS|System"
    r"|Background process)")
_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)")


def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _db_path() -> Path:
    return _home() / "state.db"


def _checkpoint_path() -> Path:
    return _home() / "processes.json"


def _results_dir() -> Path:
    return _home() / "logs" / "process-results"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not path.is_file():
        log.warning("agent-station: state.db not found at %s", path)
        raise HTTPException(status_code=503, detail="state.db not found in this Hermes home")
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _unreadable(what: str, exc: Exception) -> HTTPException:
    """A 503 that names the file and the error type; the full message (with its path) is only logged."""
    log.warning("agent-station: %s unreadable: %s", what, exc)
    return HTTPException(status_code=503, detail=f"{what} unreadable ({type(exc).__name__})")


def _delegate_from(model_config: str | None) -> str | None:
    parent = _fork_markers(model_config).get("_delegate_from")
    return parent if isinstance(parent, str) and parent else None


def _effort(model_config: str | None) -> str | None:
    """The worker's reasoning effort from model_config.reasoning_config; None when off, absent or unreadable."""
    try:
        cfg = json.loads(model_config) if model_config else None
    except (TypeError, ValueError):
        return None
    reasoning = cfg.get("reasoning_config") if isinstance(cfg, dict) else None
    if not isinstance(reasoning, dict) or reasoning.get("enabled") is False:
        return None
    effort = reasoning.get("effort")
    return effort if isinstance(effort, str) and effort else None


def _fork_markers(model_config) -> dict:
    try:
        cfg = json.loads(model_config) if isinstance(model_config, str) else model_config
    except (TypeError, ValueError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def _is_fork_child(row, *, include_reset: bool = False) -> bool:
    """Hermes' own test (SessionDB._is_explicit_fork_child_row): a branch, delegated worker or tool child
    is its own conversation, never a compression continuation. A marker only counts when it names the
    parent, because compression copies model_config — markers included — onto the continuation."""
    if row["source"] == "tool":
        return True
    cfg = _fork_markers(row["model_config"])
    markers = [cfg.get("_branched_from"), cfg.get("_delegate_from")]
    if include_reset:
        markers.append(cfg.get("_reset_from"))
    parent = row["parent_session_id"]
    return parent in markers if parent else any(m is not None for m in markers)


_LINK_COLUMNS = "id, parent_session_id, end_reason, model_config, source, started_at"


def _link(conn: sqlite3.Connection, session_id) -> sqlite3.Row | None:
    return conn.execute(f"select {_LINK_COLUMNS} from sessions where id = ?", (session_id,)).fetchone()


def _is_continuation(conn: sqlite3.Connection, row) -> bool:
    """A compression continuation: a child of a compression-ended parent that is no kind of fork."""
    if not row["parent_session_id"] or _is_fork_child(row, include_reset=True):
        return False
    parent = _link(conn, row["parent_session_id"])
    return bool(parent and parent["end_reason"] == "compression")


def _lineage(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """All ids of one conversation: compression ancestors, the session, and its continuations.

    Delegation children name the session id that was live when they were spawned, which can be
    any link of the compression chain, so every link is a valid parent key. The walk is Hermes'
    get_compression_lineage: a branch, reset fork, tool child or delegated worker is its own
    conversation, so a branch of this chat never sees (or reads) this chat's workers.
    """
    session = _link(conn, session_id)
    if not session:
        return [session_id]
    root, seen = session, {session["id"]}
    for _ in range(MAX_CHAIN):  # walk up while this link continues a compression-ended parent
        if not _is_continuation(conn, root):
            break
        parent = _link(conn, root["parent_session_id"])
        if not parent or parent["id"] in seen:
            break
        root = parent
        seen.add(root["id"])
    ids = [root["id"]]
    ids += [c["id"] for c in _continuations(conn, root, set(ids))]
    return ids if session_id in ids else [session_id]


def _continuations(conn: sqlite3.Connection, current, seen: set[str], columns: str = _LINK_COLUMNS) -> list:
    """The compression continuations after `current`, each the earliest real (non-fork) child."""
    out = []
    for _ in range(MAX_CHAIN):
        if current["end_reason"] != "compression":
            break
        children = conn.execute(f"select {columns} from sessions where parent_session_id = ? "
                                "order by started_at", (current["id"],)).fetchall()
        nxt = next((c for c in children if _is_continuation(conn, c)), None)
        if not nxt or nxt["id"] in seen:
            break
        seen.add(nxt["id"])
        out.append(nxt)
        current = nxt
    return out


def _title(conn: sqlite3.Connection, ids: list[str]) -> str | None:
    """The conversation's name as the app shows it: the newest link that has a title."""
    marks = ",".join("?" * len(ids))
    rows = {r["id"]: r["title"] for r in conn.execute(
        f"select id, title from sessions where id in ({marks})", ids).fetchall()}
    return next((rows[i] for i in reversed(ids) if rows.get(i)), None)


def _final_text(conn: sqlite3.Connection, sid: str) -> str:
    row = conn.execute(
        "select content from messages where session_id = ? and role = 'assistant' "
        "and content is not null and content != '' order by id desc limit 1",
        (sid,),
    ).fetchone()
    return row["content"] if row else ""


def _goal(conn: sqlite3.Connection, sid: str) -> str:
    row = conn.execute(
        "select content from messages where session_id = ? and role = 'user' order by id limit 1",
        (sid,),
    ).fetchone()
    text = (row["content"] if row else "") or ""
    return text.strip().split("\n", 1)[0][:GOAL_CHARS]


def _last_seen(conn: sqlite3.Connection, row: sqlite3.Row) -> float:
    """Freshest sign of life: the activity heartbeat, the newest message, else the start."""
    msg = conn.execute("select max(timestamp) t from messages where session_id = ?", (row["id"],)).fetchone()
    return max(v for v in (row["last_activity_at"], msg["t"] if msg else None, row["started_at"]) if v is not None)


_WORKER_COLUMNS = ("id, model, model_config, parent_session_id, source, started_at, ended_at, end_reason, "
                   "tool_call_count, input_tokens, output_tokens, last_activity_at, "
                   "estimated_cost_usd, actual_cost_usd, cost_status")


def _chain(conn: sqlite3.Connection, root: sqlite3.Row) -> list[sqlite3.Row]:
    """A worker and its own compression continuations, oldest first (one worker, many sessions).

    Hermes' lineage of a worker is the worker alone (it is a fork of its parent), so the walk
    starts at the worker and only goes down."""
    return [root, *_continuations(conn, root, {root["id"]}, _WORKER_COLUMNS)]


# Hermes' CostStatus (agent/usage_pricing.py): what each link's cost columns mean.
_PRICED = ("actual", "estimated")


def _cost(chain: list[sqlite3.Row]) -> tuple[float | None, str]:
    """A worker's spend from Hermes' own per-session record, summed over its compression chain.

    Never a guess: a link whose status is "included" (a subscription) costs nothing and says so,
    a link Hermes could not price ("unknown", or no amount) is not counted as $0. Returns
    (usd, status) where status is "actual" when every priced link was billed, "estimated" when any
    was estimated, "included" when every link was a subscription, "unknown" when nothing was priced.
    """
    total, kinds = 0.0, []
    for r in chain:
        status = r["cost_status"] if isinstance(r["cost_status"], str) else "unknown"
        if status == "included":
            kinds.append("included")
            continue
        actual, estimate = r["actual_cost_usd"], r["estimated_cost_usd"]
        amount = actual if isinstance(actual, (int, float)) and status == "actual" else estimate
        if status not in _PRICED or not isinstance(amount, (int, float)):
            kinds.append("unknown")
            continue
        total += amount
        kinds.append(status)
    priced = [k for k in kinds if k in _PRICED]
    if not priced:
        return (0.0, "included") if kinds and all(k == "included" for k in kinds) else (None, "unknown")
    return round(total, 6), "actual" if all(k == "actual" for k in priced) else "estimated"


def _worker(conn: sqlite3.Connection, root: sqlite3.Row, now: float) -> dict:
    chain = _chain(conn, root)
    row = chain[-1]  # a worker compressed mid-run lives on in its tip: status, end and answer come from there
    final = _final_text(conn, row["id"])
    ended = row["ended_at"]
    # The session's end is the only end state: a worker that has not ended is running even when
    # it has already written assistant text (an interim reply is not a final answer) — unless it has
    # been silent for STALE_S: then the app died under it and it will never get an end.
    if ended is None and now - _last_seen(conn, row) > STALE_S:
        status = "stopped"
    elif ended is None:
        status = "running"
    elif final:
        status = "completed"
    else:
        # Closed without an answer: the app or the parent went away mid-run.
        status = "stopped"
    duration = (ended - root["started_at"]) if (status == "completed" and ended) else None
    cost_usd, cost_status = _cost(chain)
    return {
        "session_id": root["id"],
        "goal": _goal(conn, root["id"]),
        "model": row["model"],
        "effort": _effort(row["model_config"]),
        "status": status,
        "end_reason": row["end_reason"],
        "started_at": root["started_at"],
        "ended_at": ended,
        "duration_s": duration,
        "tool_calls": sum(r["tool_call_count"] or 0 for r in chain),
        "tokens": sum((r["input_tokens"] or 0) + (r["output_tokens"] or 0) for r in chain),
        "cost_usd": cost_usd,
        "cost_status": cost_status,
        "summary": final[:600],
        "summary_truncated": len(final) > 600,
    }


def list_children(conn: sqlite3.Connection, session_id: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    ids = _lineage(conn, session_id)
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"select {_WORKER_COLUMNS} from sessions "
        f"where json_extract(model_config, '$._delegate_from') in ({marks}) order by started_at",
        ids,
    ).fetchall()
    batches: list[dict] = []
    for row in rows:
        if _is_continuation(conn, row):
            continue  # a compressed worker's later half: folded into the worker it continues
        worker = _worker(conn, row, now)
        if batches and row["started_at"] - batches[-1]["started_at"] < BATCH_GAP_S:
            batches[-1]["workers"].append(worker)
        else:
            batches.append({"started_at": row["started_at"], "workers": [worker]})
    return {"session_id": session_id, "lineage": ids, "title": _title(conn, ids), "batches": batches}


def _owned_by(conn: sqlite3.Connection, parent: str, owners: set[str]) -> bool:
    """True when a worker's delegating session is one of `owners`, directly or via nested workers."""
    seen: set[str] = set()
    for _ in range(MAX_CHAIN):
        if parent in owners:
            return True
        if parent in seen:
            return False
        seen.add(parent)
        row = conn.execute("select model_config from sessions where id = ?", (parent,)).fetchone()
        parent = _delegate_from(row["model_config"]) if row else None
        if not parent:
            return False
    return False


def read_output(conn: sqlite3.Connection, session_id: str, child_id: str) -> dict:
    row = conn.execute(f"select {_WORKER_COLUMNS} from sessions where id = ?", (child_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"session not found: {child_id}")
    parent = _delegate_from(row["model_config"])
    if not parent:
        raise HTTPException(status_code=403, detail="not a delegated worker session")
    if not _owned_by(conn, parent, set(_lineage(conn, session_id))):
        raise HTTPException(status_code=403, detail="worker belongs to another conversation")
    # A worker compressed mid-run answers in its last continuation, not in the half it was listed by.
    tip = _chain(conn, row)[-1]["id"]
    return {"session_id": child_id, "parent": parent, "text": _final_text(conn, tip)}


def _pid_is_ours(pid, start) -> bool:
    """Hermes' own liveness test (PID alive and not recycled), else psutil's bare existence test.

    Fails closed: when neither can be asked the process reads stopped, never running forever.
    """
    if not pid:
        return False
    try:
        from tools.process_registry import ProcessRegistry

        return bool(ProcessRegistry._host_pid_is_ours(pid, start))
    except Exception as exc:  # noqa: BLE001 - a private core API; any change must not become a 500
        log.warning("agent-station: PID liveness check unavailable (%s: %s); asking psutil",
                    type(exc).__name__, exc)
    try:
        import psutil

        return bool(psutil.pid_exists(pid))
    except Exception as exc:  # noqa: BLE001 - no liveness source left; say so and read stopped
        log.warning("agent-station: psutil liveness check failed (%s: %s); treating as stopped",
                    type(exc).__name__, exc)
        return False


def _read_running() -> tuple[list[dict], int]:
    """Checkpoint entries that have the shape Hermes writes, plus how many did not."""
    path = _checkpoint_path()
    if not path.is_file():
        return [], 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            raise ValueError(f"top level is {type(data).__name__}, not a list")
    except (OSError, ValueError) as exc:
        raise _unreadable("processes.json", exc) from exc
    entries = [e for e in data if isinstance(e, dict)]
    return entries, len(data) - len(entries)


def _read_results() -> tuple[list[tuple[dict, float]], int]:
    """(record without its output, mtime) per readable receipt, plus how many could not be read.

    A receipt never changes after Hermes writes it and can carry 200k chars of output, so each
    one is parsed once and kept by (path, mtime, size); the panel polls this every few seconds.
    """
    directory = _results_dir()
    if not directory.is_dir():
        return [], 0
    found, unreadable, seen = [], 0, set()
    for path in directory.glob("proc_*.json"):
        try:
            stat = path.stat()
            key = (str(path), stat.st_mtime, stat.st_size)
            seen.add(key)
            record = _RECEIPTS.get(key)
            if record is None:
                record = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(record, dict) or record.get("id") != path.stem:
                    record = False
                else:
                    record = {k: v for k, v in record.items() if k != "output"}
                _RECEIPTS[key] = record
        except FileNotFoundError:
            continue  # Hermes pruned it between the listing and the read.
        except (OSError, ValueError):
            unreadable += 1
            continue
        if record:
            found.append((record, stat.st_mtime))
        else:
            unreadable += 1
    for key in set(_RECEIPTS) - seen:
        del _RECEIPTS[key]
    return found, unreadable


def _command(text) -> dict:
    text = str(text or "")
    return {"command": text[:COMMAND_CHARS], "command_truncated": len(text) > COMMAND_CHARS}


def _finished_status(record: dict) -> str:
    if record.get("completion_reason") == "killed":
        return "stopped"
    return "completed" if record.get("exit_code") == 0 else "failed"


def _number(value) -> float | None:
    """A timestamp as Hermes writes it (epoch seconds); anything else — text, a list, a bool — is unknown."""
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _owned(record: dict, owners: set[str]) -> bool:
    parent = record.get("parent_session_id")
    return isinstance(parent, str) and parent in owners


def list_processes(conn: sqlite3.Connection, session_id: str) -> dict:
    owners = set(_lineage(conn, session_id))
    procs: dict[str, dict] = {}
    entries, unreadable = _read_running()
    for entry in entries:
        pid_id = str(entry.get("session_id") or "")
        if not PROC_ID.fullmatch(pid_id) or not _owned(entry, owners):
            continue
        alive = entry.get("pid_scope", "host") != "host" or _pid_is_ours(entry.get("pid"), entry.get("host_start_time"))
        procs[pid_id] = {
            "id": pid_id, **_command(entry.get("command")), "cwd": entry.get("cwd"),
            # Checkpointed but gone, with no receipt: the app closed under it.
            "status": "running" if alive else "stopped",
            "started_at": _number(entry.get("started_at")), "ended_at": None, "duration_s": None,
            "exit_code": None, "reason": None,
            "has_output": False,  # only a receipt carries output; the detail must not ask for one
        }
    results, bad = _read_results()
    unreadable += bad
    for record, mtime in results:
        if not _owned(record, owners):
            continue
        started = _number(record.get("started_at"))
        # The receipt is written at the moment the process leaves the running set, so its mtime is
        # the end time; Hermes records no separate field for it.
        duration = mtime - started if started is not None and mtime >= started else None
        procs[record["id"]] = {
            "id": record["id"], **_command(record.get("command")), "cwd": record.get("cwd"),
            "status": _finished_status(record), "started_at": started, "ended_at": mtime,
            "duration_s": duration, "exit_code": record.get("exit_code"),
            "reason": record.get("completion_reason"), "has_output": True,
        }
    rows = sorted(procs.values(), key=lambda p: p["started_at"] or 0)
    return {"session_id": session_id, "processes": rows, "unreadable": unreadable}


def read_process_output(conn: sqlite3.Connection, session_id: str, process_id: str) -> dict:
    if not PROC_ID.fullmatch(process_id):
        raise HTTPException(status_code=400, detail="not a process id")
    path = _results_dir() / f"{process_id}.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            raise ValueError(f"top level is {type(record).__name__}, not an object")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"no finished record for {process_id}") from exc
    except (OSError, ValueError) as exc:
        raise _unreadable("process record", exc) from exc
    if not _owned(record, set(_lineage(conn, session_id))):
        raise HTTPException(status_code=403, detail="process belongs to another conversation")
    text = str(record.get("output") or "")
    return {
        "id": process_id, "command": str(record.get("command") or ""),
        "output": text[-OUTPUT_TAIL:], "output_truncated": len(text) > OUTPUT_TAIL,
    }


def path_key(path: str) -> str:
    """One spelling per file: forward slashes, dot segments folded, a drive path lowercased.

    The page applies the same rule to a live tool call's path (desktop/plugin.js pathKey), so the
    file the agent is touching now is matched to its row; tests/path_vectors.json holds the cases
    both sides must agree on.
    """
    text = str(path or "")
    text = text.replace("\\", "/")
    unc = text.startswith("//") and not text.startswith("///")  # three or more slashes fold to one
    folded = posixpath.normpath(text) if text else ""
    if folded == ".":
        folded = ""
    if unc and not folded.startswith("//"):
        folded = "/" + folded
    return folded.lower() if _DRIVE.match(folded) else folded


def _absolute(path: str, cwd: str | None) -> str:
    """A tool's path as the tool read it: ~ expanded, a relative path joined to the session's cwd."""
    text = os.path.expanduser(path) if path.startswith("~") else path
    unixish = text.replace("\\", "/")
    if unixish.startswith("/") or _DRIVE.match(unixish) or not cwd:
        return text
    sep = "\\" if "\\" in cwd else "/"
    return cwd.rstrip("/\\") + sep + text


def _patch_targets(args: dict) -> list[tuple[str, str]] | None:
    """(path, op) per file a patch call names; None when its V4A text cannot be read.

    Replace mode names one file. Patch mode is parsed by Hermes' own V4A parser, never a copy of its
    grammar: an update or add writes, a delete deletes, a move deletes its source and writes its target.
    """
    if args.get("mode", "replace") != "patch":
        path = args.get("path")
        return [(path, "write")] if isinstance(path, str) and path else None
    text = args.get("patch")
    if not isinstance(text, str):
        return None
    try:
        from tools.patch_parser import parse_v4a_patch

        ops, error = parse_v4a_patch(text)
    except Exception as exc:  # noqa: BLE001 - a changed core parser must not become a 500
        log.warning("agent-station: V4A parser unavailable (%s: %s)", type(exc).__name__, exc)
        return None
    if error or not ops:
        return None
    out = []
    for op in ops:
        kind = getattr(getattr(op, "operation", None), "value", None)
        if kind == "move":
            out += [(op.file_path, "delete"), (op.new_path, "write")]
        else:
            out.append((op.file_path, "delete" if kind == "delete" else "write"))
    return [(p, o) for p, o in out if isinstance(p, str) and p] or None


def _targets(name: str, args) -> list[tuple[str, str]] | None:
    if not isinstance(args, dict):
        return None
    if name == "patch":
        return _patch_targets(args)
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return None
    return [(path, "read" if name == "read_file" else "write")]


def _failed(result: str | None) -> bool:
    """A tool result that reports a failure.

    The file tools answer {"error": ...} or {"success": false}. Once a conversation is compressed,
    Hermes rewrites old results in state.db as one-line stubs (agent/context_compressor.py) that keep
    the outcome: "[patch] ... FAILED: <error>" (" FAILED" when no message), or "... BLOCKED, not run" / "... not run" for a refused call.
    """
    head = (result or "")[:400].lstrip()
    if head.startswith("["):
        line = head.split("\n", 1)[0]
        end = line.rstrip()
        return " FAILED:" in line or end.endswith((" FAILED", "not run")) or "not run;" in line
    if not head.startswith("{"):
        return False
    try:
        data = json.loads(result)
    except ValueError:
        return head.startswith('{"error"')
    return isinstance(data, dict) and (bool(data.get("error")) or data.get("success") is False)


def _worker_ids(conn: sqlite3.Connection, owners: list[str]) -> dict[str, str]:
    """Every session of the workers delegated from `owners`, nested workers and continuations included,
    mapped to the worker it belongs to: the first session of its chain, the id the batches list names."""
    found: dict[str, str] = {}
    seen = set(owners)
    frontier = list(owners)
    for _ in range(MAX_CHAIN):
        if not frontier:
            break
        marks = ",".join("?" * len(frontier))
        rows = conn.execute(
            f"select {_WORKER_COLUMNS} from sessions "
            f"where json_extract(model_config, '$._delegate_from') in ({marks})", frontier).fetchall()
        frontier = []
        for row in sorted(rows, key=lambda r: _is_continuation(conn, r)):
            for link in _chain(conn, row):
                if link["id"] not in seen:
                    seen.add(link["id"])
                    found[link["id"]] = row["id"]
                    frontier.append(link["id"])
    return found


def _scope(conn: sqlite3.Connection, session_id: str) -> tuple[list[str], dict[str, str], list[str], str | None, tuple]:
    """One conversation's sessions (its links, then its workers' sessions), its folder, and a stamp
    that changes when a message lands in any of them."""
    ids = _lineage(conn, session_id)
    workers = _worker_ids(conn, ids)
    every = ids + list(workers)
    marks = ",".join("?" * len(every))
    stamp = conn.execute(f"select count(*) n, max(id) m from messages where session_id in ({marks})", every).fetchone()
    cwd_row = conn.execute(
        f"select cwd from sessions where id in ({','.join('?' * len(ids))}) and cwd is not null and cwd != '' "
        "order by started_at desc limit 1", ids).fetchone()
    cwd = cwd_row["cwd"] if cwd_row else None
    return ids, workers, every, cwd, (session_id, tuple(every), stamp["n"], stamp["m"], cwd)


def _tool_calls(conn: sqlite3.Connection, every: list[str], names: tuple[str, ...]):
    """Each call to one of `names` in these sessions, once, oldest first: (session_id, timestamp, call id,
    name, parsed arguments or None).

    Compressing a conversation keeps the original rows and writes copies of the turns it keeps, so one
    call can sit in state.db twice under the same call id; the first row is the call."""
    marks = ",".join("?" * len(every))
    seen: set = set()
    rows = conn.execute(
        f"select session_id, tool_calls, timestamp from messages where session_id in ({marks}) "
        "and tool_calls is not null and tool_calls != '' order by id", every)
    for row in rows:
        try:
            batch = json.loads(row["tool_calls"])
        except ValueError:
            continue
        for call in batch if isinstance(batch, list) else []:
            fn = call.get("function") if isinstance(call, dict) else None
            name = fn.get("name") if isinstance(fn, dict) else None
            if name not in names:
                continue
            cid = call.get("id") or call.get("call_id")
            once = (row["session_id"], cid) if cid else (row["session_id"], name, str(fn.get("arguments")), row["timestamp"])
            if once in seen:
                continue
            seen.add(once)
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (TypeError, ValueError):
                args = None
            yield row["session_id"], row["timestamp"], cid, name, args


def _results(conn: sqlite3.Connection, every: list[str], chars: int) -> dict[str, str]:
    """Each call id's result text (first `chars`). A compressed copy may hold a one-line stub where the
    original row holds the full answer: the longer text wins."""
    marks = ",".join("?" * len(every))
    out: dict[str, str] = {}
    for r in conn.execute(
            f"select tool_call_id, substr(content, 1, {int(chars)}) content from messages where session_id in ({marks}) "
            "and role = 'tool' and tool_call_id is not null order by id", every):
        text = r["content"] or ""
        if len(text) > len(out.get(r["tool_call_id"], "")):
            out[r["tool_call_id"]] = text
    return out


def list_files(conn: sqlite3.Connection, session_id: str) -> dict:
    """The files one conversation (and its workers) read or wrote with the file tools, newest first.

    Each file: how often it was read and written, when it was last touched, whether its last write
    failed, and who touched it (`who`: "" for the chat itself, else the worker's session id) and who
    changed it (`editors`, same ids: a successful write or delete). Calls whose arguments cannot be read are counted, never
    dropped. The answer is cached until a new message lands in any of the sessions it covers.
    """
    ids, workers, every, cwd, key = _scope(conn, session_id)
    cached = _FILES_CACHE.get(key)
    if cached is not None:
        return cached
    marks = ",".join("?" * len(every))
    cwds = {r["id"]: r["cwd"] for r in conn.execute(f"select id, cwd from sessions where id in ({marks})", every)}
    results = _results(conn, every, 2000)
    files: dict[str, dict] = {}
    calls = unreadable = 0
    for sid, at, cid, name, args in _tool_calls(conn, every, FILE_TOOLS):
        calls += 1
        targets = _targets(name, args)
        if not targets:
            unreadable += 1
            continue
        failed = _failed(results.get(cid))
        for raw, op in targets:
            path = _absolute(raw, cwds.get(sid) or cwd)
            k = path_key(path)
            f = files.setdefault(k, {"key": k, "path": path, "reads": 0, "writes": 0, "deletes": 0, "failed": 0,
                                     "first_at": at, "last_at": at, "last_op": op,
                                     "last_failed": False, "who": [], "editors": []})
            f["path"] = path
            if failed:
                f["failed"] += 1
            elif op == "read":
                f["reads"] += 1
            elif op == "delete":
                f["deletes"] += 1
            else:
                f["writes"] += 1
            who = workers.get(sid, "")
            if who not in f["who"]:
                f["who"].append(who)
            if not failed and op != "read" and who not in f["editors"]:
                f["editors"].append(who)
            f["last_at"] = at
            f["last_op"] = op
            f["last_failed"] = failed
    ordered = sorted(files.values(), key=lambda f: f["last_at"] or 0, reverse=True)
    answer = {"session_id": session_id, "cwd": cwd, "files": ordered[:MAX_FILES],
              "more": max(0, len(ordered) - MAX_FILES), "calls": calls, "unreadable": unreadable}
    if len(_FILES_CACHE) > 32:
        _FILES_CACHE.clear()
    _FILES_CACHE[key] = answer
    return answer


def _message_text(content) -> str:
    """A message's words. Hermes stores a message made of parts (text plus an image) as the reserved
    prefix '\\x00json:' and the parts as JSON; only the text parts are words."""
    text = str(content or "")
    if not text.startswith("\x00json:"):
        return text
    try:
        parts = json.loads(text[len("\x00json:"):])
    except ValueError:
        return ""
    if isinstance(parts, str):
        return parts
    return " ".join(str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("type") in ("text", "input_text")) \
        if isinstance(parts, list) else ""


def _requests(conn: sqlite3.Connection, ids: list[str]) -> list[tuple[float, str]]:
    """The user's own requests in this conversation, oldest first: (time, text). A message Hermes posts in
    the user's place (a finished delegation, a background process, a compression summary) is not one;
    a compressed copy of a request is the same request."""
    marks = ",".join("?" * len(ids))
    has_kind = any(c[1] == "display_kind" for c in conn.execute("pragma table_info(messages)"))
    kind = "display_kind" if has_kind else "null"
    out, seen = [], set()
    for r in conn.execute(f"select timestamp, content, {kind} kind from messages where session_id in ({marks}) "
                          "and role = 'user' order by timestamp, id", ids):
        text = _message_text(r["content"])
        if r["kind"] not in (None, "") or _NOT_A_REQUEST.match(text.lstrip()):
            continue
        once = (round(float(r["timestamp"] or 0), 3), text[:400])
        if once in seen:
            continue
        seen.add(once)
        out.append((float(r["timestamp"] or 0), text))
    return out


def _one_line(text: str, limit: int) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "\u2026"


def _cap(lines: list[list[str]]) -> tuple[list[list[str]], int]:
    kept = [[tag, text if len(text) <= LINE_CHARS else text[: LINE_CHARS - 1] + "\u2026"] for tag, text in lines[:STEP_LINES]]
    return kept, max(0, len(lines) - STEP_LINES)


def _unified(diff: str) -> list[list[str]]:
    """A unified diff as [tag, text] rows: '@' opens a hunk (its text is the new file's first line number),
    then ' ' context, '-' removed, '+' added. File headers and 'no newline' notes are dropped."""
    out: list[list[str]] = []
    in_hunk = False
    for raw in diff.splitlines():
        hunk = _HUNK.match(raw)
        if hunk or raw.startswith("@@"):
            in_hunk = True
            out.append(["@", hunk.group(1) if hunk else ""])
        elif not in_hunk or raw.startswith("\\"):
            continue
        elif raw[:1] in (" ", "-", "+"):
            out.append([raw[:1], raw[1:]])
        elif raw == "":
            out.append([" ", ""])
    return out


def _snippet_diff(old: str, new: str) -> list[list[str]]:
    import difflib

    rows = _unified("\n".join(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=2)))
    return [["@", ""] if tag == "@" else [tag, text] for tag, text in rows]


def _error(result: str | None) -> str:
    head = (result or "").strip()
    if head.startswith("{"):
        try:
            data = json.loads(head)
        except ValueError:
            return _one_line(head, ASK_CHARS)
        if isinstance(data, dict):
            return _one_line(str(data.get("error") or data.get("message") or ""), ASK_CHARS)
    line = head.split("\n", 1)[0]
    return _one_line(line.split(" FAILED:", 1)[1] if " FAILED:" in line else "", ASK_CHARS)


def _edit_steps(name: str, args, result: str | None) -> list[dict] | None:
    """One step per file an edit call changed: its kind and its lines. None when the arguments cannot be read.

    A patch's own result carries the unified diff Hermes applied (real line numbers, context); a result
    rewritten by compression no longer does, so the step falls back to the call's own text: the replaced
    snippet, or the hunks of a V4A patch read by Hermes' parser. write_file writes a whole file."""
    if not isinstance(args, dict):
        return None
    if name == "write_file":
        path = args.get("path")
        if not isinstance(path, str) or not path:
            return None
        content = args.get("content")
        lines = [["+", line] for line in str(content or "").splitlines()]
        return [{"path": path, "kind": "whole", "lines": lines, "total": len(lines)}]
    if args.get("mode", "replace") != "patch":
        path = args.get("path")
        if not isinstance(path, str) or not path:
            return None
        diff = None
        try:
            data = json.loads(result) if (result or "").lstrip().startswith("{") else None
            diff = data.get("diff") if isinstance(data, dict) else None
        except ValueError:
            diff = None
        lines = _unified(diff) if isinstance(diff, str) and diff.strip() else _snippet_diff(
            str(args.get("old_string") or ""), str(args.get("new_string") or ""))
        return [{"path": path, "kind": "diff", "lines": lines}]
    text = args.get("patch")
    if not isinstance(text, str):
        return None
    try:
        from tools.patch_parser import parse_v4a_patch

        ops, error = parse_v4a_patch(text)
    except Exception as exc:  # noqa: BLE001 - a changed core parser must not become a 500
        log.warning("agent-station: V4A parser unavailable (%s: %s)", type(exc).__name__, exc)
        return None
    if error or not ops:
        return None
    steps = []
    for op in ops:
        kind = getattr(getattr(op, "operation", None), "value", None)
        if not isinstance(op.file_path, str) or not op.file_path:
            continue
        if kind == "delete":
            steps.append({"path": op.file_path, "kind": "delete", "lines": []})
            continue
        lines = []
        for hunk in getattr(op, "hunks", None) or []:
            lines.append(["@", ""])
            lines += [[hl.prefix if hl.prefix in (" ", "-", "+") else " ", str(hl.content)] for hl in hunk.lines]
        if kind == "add":
            steps.append({"path": op.file_path, "kind": "whole", "lines": [l for l in lines if l[0] != "@"],
                          "total": sum(1 for l in lines if l[0] == "+")})
        elif kind == "move":
            steps.append({"path": op.file_path, "kind": "move", "to": op.new_path, "lines": lines})
        else:
            steps.append({"path": op.file_path, "kind": "diff", "lines": lines})
    return steps or None


def build_replay(conn: sqlite3.Connection, session_id: str) -> dict:
    """The file edits of one conversation (and its workers), grouped under the user's request they
    followed, newest request first; each edit with the lines it removed and added. Cached until a new
    message lands in any session it covers."""
    ids, workers, every, cwd, key = _scope(conn, session_id)
    cached = _REPLAY_CACHE.get(key)
    if cached is not None:
        return cached
    marks = ",".join("?" * len(every))
    cwds = {r["id"]: r["cwd"] for r in conn.execute(f"select id, cwd from sessions where id in ({marks})", every)}
    results = _results(conn, every, 200000)
    asks = _requests(conn, ids)
    turns = [{"id": f"t{i}", "at": at, "ask": _one_line(text, ASK_CHARS), "steps": []} for i, (at, text) in enumerate(asks)]
    early = {"id": "t-", "at": None, "ask": "", "steps": []}
    calls = unreadable = 0
    for sid, at, cid, name, args in _tool_calls(conn, every, EDIT_TOOLS):
        calls += 1
        result = results.get(cid)
        steps = _edit_steps(name, args, result)
        if not steps:
            unreadable += 1
            continue
        failed = _failed(result)
        turn = early
        for t in turns:
            if t["at"] <= (at or 0):
                turn = t
            else:
                break
        for n, step in enumerate(steps):
            lines, cut = _cap(step.pop("lines"))
            step.update({
                "id": f"{cid or calls}#{n}", "at": at, "who": workers.get(sid, ""), "tool": name,
                "path": _absolute(step["path"], cwds.get(sid) or cwd),
                "added": sum(1 for l in lines if l[0] == "+"), "removed": sum(1 for l in lines if l[0] == "-"),
                "lines": lines, "cut": cut, "failed": failed, "error": _error(result) if failed else "",
            })
            if step.get("to"):
                step["to"] = _absolute(step["to"], cwds.get(sid) or cwd)
            turn["steps"].append(step)
    with_edits = [t for t in ([early] + turns) if t["steps"]]
    for t in with_edits:
        t["files"] = len({path_key(s["path"]) for s in t["steps"]})
        t["more_steps"] = max(0, len(t["steps"]) - MAX_STEPS)
        t["steps"] = t["steps"][:MAX_STEPS]
    with_edits.reverse()
    answer = {"session_id": session_id, "cwd": cwd, "turns": with_edits[:MAX_TURNS],
              "more_turns": max(0, len(with_edits) - MAX_TURNS), "calls": calls, "unreadable": unreadable}
    if len(_REPLAY_CACHE) > 8:
        _REPLAY_CACHE.clear()
    _REPLAY_CACHE[key] = answer
    return answer


def list_replay(conn: sqlite3.Connection, session_id: str) -> dict:
    """The replay list: every request and its edits without their lines (the page loads those per edit)."""
    full = build_replay(conn, session_id)
    return {**full, "turns": [{**t, "steps": [{k: v for k, v in s.items() if k != "lines"} for s in t["steps"]]}
                              for t in full["turns"]]}


def read_replay_step(conn: sqlite3.Connection, session_id: str, step_id: str) -> dict:
    """One edit's lines; 403 when the edit is not in this conversation's replay."""
    for t in build_replay(conn, session_id)["turns"]:
        for s in t["steps"]:
            if s["id"] == step_id:
                return {"id": step_id, "lines": s["lines"], "cut": s["cut"]}
    raise HTTPException(status_code=403, detail="edit belongs to another conversation")


@router.get("/children")
def children(session_id: str) -> dict:
    with closing(_connect()) as conn:
        return list_children(conn, session_id)


@router.get("/output")
def output(session_id: str, worker_id: str) -> dict:
    with closing(_connect()) as conn:
        return read_output(conn, session_id, worker_id)


@router.get("/processes")
def processes(session_id: str) -> dict:
    with closing(_connect()) as conn:
        return list_processes(conn, session_id)


@router.get("/process_output")
def process_output(session_id: str, process_id: str) -> dict:
    with closing(_connect()) as conn:
        return read_process_output(conn, session_id, process_id)



@router.get("/files")
def files(session_id: str) -> dict:
    with closing(_connect()) as conn:
        return list_files(conn, session_id)


@router.get("/replay")
def replay(session_id: str) -> dict:
    with closing(_connect()) as conn:
        return list_replay(conn, session_id)


@router.get("/replay_step")
def replay_step(session_id: str, step_id: str) -> dict:
    with closing(_connect()) as conn:
        return read_replay_step(conn, session_id, step_id)
