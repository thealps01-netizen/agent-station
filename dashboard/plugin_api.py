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
                                    batches (children started within BATCH_GAP_S of each other)
  GET /output?session_id=<id>&worker_id=<child> -> the child's final answer, full length; 403 when
                                    the child was not delegated from that conversation
  GET /processes?session_id=<id> -> that conversation's background processes, running and finished
  GET /process_output?session_id=<id>&process_id=<proc_...> -> a finished process's output tail
"""

from __future__ import annotations

import json
import logging
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


def _delegate_from(model_config: str | None) -> str | None:
    if not model_config:
        return None
    try:
        return (json.loads(model_config) or {}).get("_delegate_from")
    except (TypeError, ValueError):
        return None


def _lineage(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """All ids of one conversation: compression ancestors, the session, and its continuations.

    Delegation children name the session id that was live when they were spawned, which can be
    any link of the compression chain, so every link is a valid parent key.
    """
    ids = [session_id]
    current = session_id
    for _ in range(MAX_CHAIN):  # walk up while the parent was closed by compression
        row = conn.execute(
            "select p.id from sessions c join sessions p on p.id = c.parent_session_id "
            "where c.id = ? and p.end_reason = 'compression'",
            (current,),
        ).fetchone()
        if not row or row["id"] in ids:
            break
        current = row["id"]
        ids.insert(0, current)
    current = session_id
    for _ in range(MAX_CHAIN):  # walk down through compression continuations
        row = conn.execute(
            "select c.id from sessions c join sessions p on p.id = c.parent_session_id "
            "where p.id = ? and p.end_reason = 'compression' "
            "and json_extract(c.model_config, '$._delegate_from') is null "
            "order by c.started_at limit 1",
            (current,),
        ).fetchone()
        if not row or row["id"] in ids:
            break
        current = row["id"]
        ids.append(current)
    return ids


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


def _worker(conn: sqlite3.Connection, row: sqlite3.Row, now: float) -> dict:
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
    duration = (ended - row["started_at"]) if (status == "completed" and ended) else None
    return {
        "session_id": row["id"],
        "goal": _goal(conn, row["id"]),
        "model": row["model"],
        "status": status,
        "end_reason": row["end_reason"],
        "started_at": row["started_at"],
        "ended_at": ended,
        "duration_s": duration,
        "tool_calls": row["tool_call_count"] or 0,
        "tokens": (row["input_tokens"] or 0) + (row["output_tokens"] or 0),
        "summary": final[:600],
        "summary_truncated": len(final) > 600,
    }


def list_children(conn: sqlite3.Connection, session_id: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    ids = _lineage(conn, session_id)
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        "select id, model, started_at, ended_at, end_reason, tool_call_count, input_tokens, "
        "output_tokens, last_activity_at from sessions "
        f"where json_extract(model_config, '$._delegate_from') in ({marks}) order by started_at",
        ids,
    ).fetchall()
    batches: list[dict] = []
    for row in rows:
        worker = _worker(conn, row, now)
        if batches and row["started_at"] - batches[-1]["started_at"] < BATCH_GAP_S:
            batches[-1]["workers"].append(worker)
        else:
            batches.append({"started_at": row["started_at"], "workers": [worker]})
    return {"session_id": session_id, "lineage": ids, "batches": batches}


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
    row = conn.execute("select model_config from sessions where id = ?", (child_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"session not found: {child_id}")
    parent = _delegate_from(row["model_config"])
    if not parent:
        raise HTTPException(status_code=403, detail="not a delegated worker session")
    if not _owned_by(conn, parent, set(_lineage(conn, session_id))):
        raise HTTPException(status_code=403, detail="worker belongs to another conversation")
    return {"session_id": child_id, "parent": parent, "text": _final_text(conn, child_id)}


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


def _read_running() -> list[dict]:
    path = _checkpoint_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"processes.json unreadable: {exc}") from exc
    return data if isinstance(data, list) else []


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


def list_processes(conn: sqlite3.Connection, session_id: str) -> dict:
    owners = set(_lineage(conn, session_id))
    procs: dict[str, dict] = {}
    for entry in _read_running():
        pid_id = str(entry.get("session_id") or "")
        if not PROC_ID.fullmatch(pid_id) or entry.get("parent_session_id") not in owners:
            continue
        alive = entry.get("pid_scope", "host") != "host" or _pid_is_ours(entry.get("pid"), entry.get("host_start_time"))
        procs[pid_id] = {
            "id": pid_id, **_command(entry.get("command")), "cwd": entry.get("cwd"),
            # Checkpointed but gone, with no receipt: the app closed under it.
            "status": "running" if alive else "stopped",
            "started_at": entry.get("started_at"), "ended_at": None, "duration_s": None,
            "exit_code": None, "reason": None,
        }
    results, unreadable = _read_results()
    for record, mtime in results:
        if record.get("parent_session_id") not in owners:
            continue
        started = record.get("started_at")
        # The receipt is written at the moment the process leaves the running set, so its mtime is
        # the end time; Hermes records no separate field for it.
        duration = mtime - started if isinstance(started, (int, float)) and mtime >= started else None
        procs[record["id"]] = {
            "id": record["id"], **_command(record.get("command")), "cwd": record.get("cwd"),
            "status": _finished_status(record), "started_at": started, "ended_at": mtime,
            "duration_s": duration, "exit_code": record.get("exit_code"),
            "reason": record.get("completion_reason"),
        }
    rows = sorted(procs.values(), key=lambda p: p["started_at"] or 0)
    return {"session_id": session_id, "processes": rows, "unreadable": unreadable}


def read_process_output(conn: sqlite3.Connection, session_id: str, process_id: str) -> dict:
    if not PROC_ID.fullmatch(process_id):
        raise HTTPException(status_code=400, detail="not a process id")
    path = _results_dir() / f"{process_id}.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"no finished record for {process_id}") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"record unreadable: {exc}") from exc
    if record.get("parent_session_id") not in set(_lineage(conn, session_id)):
        raise HTTPException(status_code=403, detail="process belongs to another conversation")
    text = str(record.get("output") or "")
    return {
        "id": process_id, "command": str(record.get("command") or ""),
        "output": text[-OUTPUT_TAIL:], "output_truncated": len(text) > OUTPUT_TAIL,
    }


@router.get("/children")
def children(session_id: str) -> dict:
    with _connect() as conn:
        return list_children(conn, session_id)


@router.get("/output")
def output(session_id: str, worker_id: str) -> dict:
    with _connect() as conn:
        return read_output(conn, session_id, worker_id)


@router.get("/processes")
def processes(session_id: str) -> dict:
    with _connect() as conn:
        return list_processes(conn, session_id)


@router.get("/process_output")
def process_output(session_id: str, process_id: str) -> dict:
    with _connect() as conn:
        return read_process_output(conn, session_id, process_id)
