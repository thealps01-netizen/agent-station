"""subagent-watch backend: read-only history of delegate_task workers.

The desktop plugin SDK has no way to list a session's delegated child sessions or read a
child's final output, so this router reads state.db directly — opened with SQLite's
``mode=ro`` URI, so it can never write. Only sessions whose ``model_config`` carries
``_delegate_from`` (the marker delegate_task writes on every child) are ever returned;
any other session id is refused, so the router cannot be used to read arbitrary chats.

Routes (mounted at /api/plugins/subagent-watch/):
  GET /children?session_id=<id>  -> workers delegated from that conversation, grouped into
                                    batches (children started within BATCH_GAP_S of each other)
  GET /output?session_id=<child> -> the child's final answer, full length
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

BATCH_GAP_S = 2.0  # delegate_task starts a batch's children within ~1 s of each other
MAX_CHAIN = 100  # compression chains deeper than this are pathological
GOAL_CHARS = 240


def _db_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "state.db"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"state.db not found: {path}")
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


def _worker(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    final = _final_text(conn, row["id"])
    ended = row["ended_at"]
    if final:
        status = "completed"
    elif ended is None:
        status = "running"
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


def list_children(conn: sqlite3.Connection, session_id: str) -> dict:
    ids = _lineage(conn, session_id)
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        "select id, model, started_at, ended_at, end_reason, tool_call_count, input_tokens, "
        "output_tokens from sessions "
        f"where json_extract(model_config, '$._delegate_from') in ({marks}) order by started_at",
        ids,
    ).fetchall()
    batches: list[dict] = []
    for row in rows:
        worker = _worker(conn, row)
        if batches and row["started_at"] - batches[-1]["started_at"] < BATCH_GAP_S:
            batches[-1]["workers"].append(worker)
        else:
            batches.append({"started_at": row["started_at"], "workers": [worker]})
    return {"session_id": session_id, "lineage": ids, "batches": batches}


def read_output(conn: sqlite3.Connection, child_id: str) -> dict:
    row = conn.execute("select model_config from sessions where id = ?", (child_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"session not found: {child_id}")
    parent = _delegate_from(row["model_config"])
    if not parent:
        raise HTTPException(status_code=403, detail="not a delegated worker session")
    return {"session_id": child_id, "parent": parent, "text": _final_text(conn, child_id)}


@router.get("/children")
def children(session_id: str) -> dict:
    with _connect() as conn:
        return list_children(conn, session_id)


@router.get("/output")
def output(session_id: str) -> dict:
    with _connect() as conn:
        return read_output(conn, session_id)
