"""subagent-watch backend: read-only history of delegate_task workers.

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

Routes (mounted at /api/plugins/subagent-watch/):
  GET /children?session_id=<id>  -> workers delegated from that conversation, grouped into
                                    batches (children started within BATCH_GAP_S of each other);
                                    each worker carries Hermes' own cost record (see _cost)
  GET /output?session_id=<id>&worker_id=<child> -> the child's final answer, full length; 403 when
                                    the child was not delegated from that conversation
  GET /processes?session_id=<id> -> that conversation's background processes, running and finished
  GET /process_output?session_id=<id>&process_id=<proc_...> -> a finished process's output tail
"""

from __future__ import annotations

import json
import logging
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
        log.warning("subagent-watch: state.db not found at %s", path)
        raise HTTPException(status_code=503, detail="state.db not found in this Hermes home")
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _unreadable(what: str, exc: Exception) -> HTTPException:
    """A 503 that names the file and the error type; the full message (with its path) is only logged."""
    log.warning("subagent-watch: %s unreadable: %s", what, exc)
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
        log.warning("subagent-watch: PID liveness check unavailable (%s: %s); asking psutil",
                    type(exc).__name__, exc)
    try:
        import psutil

        return bool(psutil.pid_exists(pid))
    except Exception as exc:  # noqa: BLE001 - no liveness source left; say so and read stopped
        log.warning("subagent-watch: psutil liveness check failed (%s: %s); treating as stopped",
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
