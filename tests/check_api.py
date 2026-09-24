"""Backend check for subagent-watch: runs plugin_api against a fixture state.db built here.

Run from anywhere with the Hermes venv python (it provides fastapi):
    python tests/check_api.py            (exit 0 = passed)
    python tests/check_api.py --live     also smoke-test the real state.db of this Hermes home

The fixture is rebuilt on every run under tests/.out/, so the result never depends on what the
machine's own history happens to contain. It holds one conversation compressed into two links
(P1 -> P2), a batch of two workers from P1 (one answered, one closed without an answer), a
running worker from P2, and a worker of an unrelated conversation that must never show up.

Locks: the database handle cannot write; batches follow the compression chain; each worker's
status, duration and summary are derived as documented in plugin_api; /output serves only
delegated worker sessions and returns the full answer.
"""

from __future__ import annotations

import importlib
import json
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "dashboard"))

import plugin_api as api  # noqa: E402
from fastapi import HTTPException  # noqa: E402

FIXTURE = HERE / ".out" / "fixture_state.db"
LONG_ANSWER = "x" * 700  # longer than the 600-char summary cap

fails = 0


def check(ok: bool, what: str) -> None:
    global fails
    print(("PASS  " if ok else "FAIL  ") + what)
    fails += 0 if ok else 1


def build_fixture() -> None:
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.unlink(missing_ok=True)
    db = sqlite3.connect(FIXTURE)
    db.executescript(
        "create table sessions (id text primary key, model text, model_config text,"
        " parent_session_id text, started_at real not null, ended_at real, end_reason text,"
        " tool_call_count integer default 0, input_tokens integer default 0,"
        " output_tokens integer default 0);"
        "create table messages (id integer primary key autoincrement, session_id text,"
        " role text, content text);"
    )

    def session(sid, started, ended=None, reason=None, parent=None, delegate_from=None, model="m"):
        cfg = json.dumps({"_delegate_from": delegate_from}) if delegate_from else "{}"
        db.execute(
            "insert into sessions values (?,?,?,?,?,?,?,?,?,?)",
            (sid, model, cfg, parent, started, ended, reason, 3, 100, 20),
        )

    def message(sid, role, content):
        db.execute("insert into messages (session_id, role, content) values (?,?,?)", (sid, role, content))

    session("P1", 900, 1500, "compression")
    session("P2", 1500, parent="P1")
    session("Q", 900)
    session("W1", 1000, 1042, "completed", delegate_from="P1", model="claude-sonnet-5")
    message("W1", "user", "Read the notes\nsecond line is not part of the goal")
    message("W1", "assistant", LONG_ANSWER)
    session("W2", 1000.5, 1300, "closed", delegate_from="P1")
    message("W2", "user", "Count files")
    session("W3", 2000, delegate_from="P2")
    message("W3", "user", "Wait")
    session("W4", 1000.2, 1010, "completed", delegate_from="Q")
    message("W4", "assistant", "other conversation")
    db.commit()
    db.close()


def run_fixture() -> None:
    build_fixture()
    api._db_path = lambda: FIXTURE  # the router reads the fixture, not this machine's history
    with api._connect() as conn:
        try:
            conn.execute("create table _sw_probe(a)")
            check(False, "database handle is read-only")
        except sqlite3.OperationalError:
            check(True, "database handle is read-only")

        data = api.list_children(conn, "P2")
        check(data["lineage"] == ["P1", "P2"], f"lineage follows compression ({data['lineage']})")
        sizes = [len(b["workers"]) for b in data["batches"]]
        check(sizes == [2, 1], f"workers grouped into batches by start time ({sizes})")
        workers = {w["session_id"]: w for b in data["batches"] for w in b["workers"]}
        check("W4" not in workers, "an unrelated conversation's worker is not listed")

        w1, w2, w3 = workers["W1"], workers["W2"], workers["W3"]
        check(w1["status"] == "completed" and w1["duration_s"] == 42, "answered worker: completed, 42 s")
        check(w1["goal"] == "Read the notes", "goal is the first line of the task")
        check(w1["model"] == "claude-sonnet-5", "worker model is reported")
        check(len(w1["summary"]) == 600 and w1["summary_truncated"], "summary capped at 600 chars and flagged")
        check(w2["status"] == "stopped" and w2["duration_s"] is None, "closed without answer: stopped, no duration")
        check(w3["status"] == "running" and w3["duration_s"] is None, "open worker: running, no duration")
        check(w1["tokens"] == 120 and w1["tool_calls"] == 3, "tokens and tool calls summed from the session")

        check(api.read_output(conn, "W1")["text"] == LONG_ANSWER, "/output returns the full answer")
        for sid, code, what in (("P1", 403, "a non-worker session is refused (403)"),
                                ("nope", 404, "an unknown session is 404")):
            try:
                api.read_output(conn, sid)
                check(False, what)
            except HTTPException as exc:
                check(exc.status_code == code, what)


def run_live() -> None:
    sys.path.insert(0, os.environ.get("HERMES_AGENT_DIR") or str(HERE.parents[2] / "hermes-agent"))
    importlib.reload(api)  # drop the fixture override; hermes_constants locates the real state.db
    with api._connect() as conn:
        parent = conn.execute(
            "select json_extract(model_config, '$._delegate_from') p from sessions "
            "where json_extract(model_config, '$._delegate_from') is not null "
            "group by p order by count(*) desc limit 1"
        ).fetchone()
        if not parent:
            print("SKIP  live: no delegated sessions in this state.db")
            return
        workers = [w for b in api.list_children(conn, parent["p"])["batches"] for w in b["workers"]]
        check(bool(workers) and all(w["status"] in {"completed", "stopped", "running"} for w in workers),
              f"live: {len(workers)} workers read, every status known")


run_fixture()
if "--live" in sys.argv:
    run_live()
print("\nALL PASSED" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
