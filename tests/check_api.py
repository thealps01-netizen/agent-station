"""Backend check for subagent-watch: runs plugin_api against a fixture state.db built here.

Run from anywhere with the Hermes venv python (it provides fastapi):
    python tests/check_api.py            (exit 0 = passed)
    python tests/check_api.py --live     also smoke-test the real state.db of this Hermes home

The fixture is rebuilt on every run under tests/.out/, so the result never depends on what the
machine's own history happens to contain. It holds one conversation compressed into two links
(P1 -> P2), a batch of two workers from P1 (one answered, one closed without an answer), a
running worker from P2, and a worker of an unrelated conversation that must never show up.

Locks: the database handle cannot write; batches follow the compression chain; each worker's
status, duration and summary are derived as documented in plugin_api (a worker that has not ended
is running even after it wrote text, until it has been silent past STALE_S); /output serves only delegated workers of the asking chat
(403 for another chat's) and returns the full answer; a changed core liveness API is not a 500 and never fails open; a missing state.db
is a 503 that does not print its path. Background commands: only the chain's own
processes are listed; running / stopped / completed / failed are derived from Hermes' own files;
unreadable files are reported, never silently dropped; /process_output refuses another chat's
process and anything that is not a process id. Files: one row per file however the path is spelled
(the spelling rule is shared with the page through path_vectors.json); a worker's files are its chat's;
refused writes and compressed FAILED / BLOCKED stubs are failures, not edits; a V4A patch is read by
Hermes' own parser (move = delete + write) and an unreadable call is counted, never dropped.
"""

from __future__ import annotations

import importlib
import json
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "dashboard"))

import env  # noqa: E402

import plugin_api as api  # noqa: E402
from fastapi import HTTPException  # noqa: E402

FIXTURE = HERE / ".out" / "fixture_state.db"
PROC_HOME = HERE / ".out" / "proc_home"
PROC_RESULTS = PROC_HOME / "logs" / "process-results"
LONG_ANSWER = "x" * 700  # longer than the 600-char summary cap
NOW = 2100.0  # the clock the fixture is read at: W3 / W5 started 100 s before it

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
        " output_tokens integer default 0, last_activity_at real, source text not null default 'cli',"
        " title text, estimated_cost_usd real, actual_cost_usd real, cost_status text);"
        "create table messages (id integer primary key autoincrement, session_id text,"
        " role text, content text, timestamp real);"
    )

    def session(sid, started, ended=None, reason=None, parent=None, delegate_from=None, model="m", active=None,
                reasoning=None, markers=None, source="cli", title=None, cost=(None, None, None)):
        cfg = {"_delegate_from": delegate_from} if delegate_from else {}
        if reasoning is not None:
            cfg["reasoning_config"] = reasoning
        cfg.update(markers or {})
        cfg = json.dumps(cfg)
        db.execute(
            "insert into sessions values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, model, cfg, parent, started, ended, reason, 3, 100, 20, active, source, title, *cost),
        )

    def message(sid, role, content, ts=0.0):
        db.execute("insert into messages (session_id, role, content, timestamp) values (?,?,?,?)",
                   (sid, role, content, ts))

    session("P1", 900, 1500, "compression")
    session("P2", 1500, parent="P1", title="Refactor fleet routing")
    session("Q", 900)
    session("W1", 1000, 1042, "completed", delegate_from="P1", model="claude-sonnet-5",
            reasoning={"enabled": True, "effort": "medium"}, cost=(1.25, None, "estimated"))
    message("W1", "user", "Read the notes\nsecond line is not part of the goal")
    message("W1", "assistant", LONG_ANSWER)
    session("W2", 1000.5, 1300, "closed", delegate_from="P1", cost=(0.0, None, "included"))
    message("W2", "user", "Count files")
    session("W3", 2000, delegate_from="P2", reasoning={"enabled": False, "effort": "high"})
    message("W3", "user", "Wait")
    session("W4", 1000.2, 1010, "completed", delegate_from="Q")
    message("W4", "assistant", "other conversation")
    # Still working, but it has already said something: an answer so far is not an end state.
    # Hermes could not price it, yet an amount is stored: an unknown status is never a price.
    session("W5", 2000.5, delegate_from="P2", cost=(0.7, None, "unknown"))
    message("W5", "user", "Keep going")
    message("W5", "assistant", "halfway there")
    # Delegated by a worker of this chat (nested): its output belongs to the chat too.
    session("N1", 1001, 1020, "agent_close", delegate_from="W1")
    message("N1", "assistant", "nested answer")
    # Never ended and silent for longer than STALE_S at NOW: the app died under it (C1).
    session("W6", 100, delegate_from="P1")
    message("W6", "user", "Crashed long ago", ts=100)
    # Started just as long ago, but its heartbeat / last message is fresh: still running.
    session("W7", 50, delegate_from="P1", active=NOW - 30)
    message("W7", "user", "Long job", ts=50)
    session("W8", 10, delegate_from="P1")
    message("W8", "user", "Talks often", ts=10)
    message("W8", "assistant", "still at it", ts=NOW - 20)
    # Round 5 — a second conversation R1 -> R2 (compression) with every kind of child Hermes'
    # get_compression_lineage refuses as a continuation: a /branch, a reset fork, a tool child and a
    # delegated worker. The branch starts first, so a walk that takes "the earliest child" picks it.
    session("R1", 3000, 3500, "compression")
    session("RB", 3200, parent="R1", markers={"_branched_from": "R1"})
    session("RR", 3300, parent="R1", markers={"_reset_from": "R1"})
    session("RT", 3250, parent="R1", source="tool")
    session("R2", 3500, parent="R1")
    session("RW", 3100, 3150, "completed", parent="R1", delegate_from="R1", cost=(0.4, 0.38, "actual"))
    message("RW", "user", "Secret task of R1")
    message("RW", "assistant", "SECRET answer of R1")
    # A worker of R2 that was itself compressed: Hermes copies model_config onto the continuation,
    # so CW2 carries _delegate_from=R2 too, but its parent is CW. One worker, answer from the tip.
    session("CW", 3600, 3700, "compression", parent="R2", delegate_from="R2", cost=(0.5, None, "estimated"))
    message("CW", "user", "Audit the repo")
    message("CW", "assistant", "interim note before compression")
    session("CW2", 3700, 3800, "completed", parent="CW", delegate_from="R2", cost=(0.3, 0.25, "actual"))
    message("CW2", "user", "[CONTEXT SUMMARY] earlier turn")
    message("CW2", "assistant", "final audit answer")
    # A worker compressed mid-run whose first half Hermes could not price: only the priced half counts.
    session("U", 5000)
    session("UW", 5001, 5100, "compression", delegate_from="U", cost=(0.7, None, "unknown"))
    message("UW", "user", "Half priced")
    session("UW2", 5100, 5200, "completed", parent="UW", delegate_from="U", cost=(0.5, None, "estimated"))
    message("UW2", "assistant", "done")
    db.commit()
    db.close()


def run_fixture() -> None:
    api._db_path = lambda: HERE / ".out" / "no_such_dir" / "state.db"
    try:
        api._connect()
        check(False, "a missing state.db is a 503")
    except HTTPException as exc:
        check(exc.status_code == 503 and "no_such_dir" not in str(exc.detail) and ":" not in str(exc.detail).split("state.db")[0],
              f"a missing state.db is a 503 that does not print the absolute path [{exc.detail}]")
    build_fixture()
    api._db_path = lambda: FIXTURE  # the router reads the fixture, not this machine's history
    with api._connect() as conn:
        try:
            conn.execute("create table _sw_probe(a)")
            check(False, "database handle is read-only")
        except sqlite3.OperationalError:
            check(True, "database handle is read-only")

        data = api.list_children(conn, "P2", now=NOW)
        check(data["lineage"] == ["P1", "P2"], f"lineage follows compression ({data['lineage']})")
        sizes = [len(b["workers"]) for b in data["batches"]]
        check(sizes == [1, 1, 1, 2, 2], f"workers grouped into batches by start time ({sizes})")
        workers = {w["session_id"]: w for b in data["batches"] for w in b["workers"]}
        check("W4" not in workers, "an unrelated conversation's worker is not listed")

        w1, w2, w3, w5 = workers["W1"], workers["W2"], workers["W3"], workers["W5"]
        check(w1["status"] == "completed" and w1["duration_s"] == 42, "answered worker: completed, 42 s")
        check(w1["goal"] == "Read the notes", "goal is the first line of the task")
        check(w1["model"] == "claude-sonnet-5", "worker model is reported")
        check(w1.get("effort") == "medium", f"reasoning effort is reported from model_config ({w1.get('effort')!r})")
        check("effort" in w2 and w2["effort"] is None, f"no reasoning_config: effort is null ({w2.get('effort', 'absent')!r})")
        check("effort" in w3 and w3["effort"] is None, f"reasoning disabled: effort is null ({w3.get('effort', 'absent')!r})")
        effort = getattr(api, "_effort", None)
        cases = (("{not json", None), (None, None), ("[]", None), ('{"reasoning_config": "x"}', None),
                 ('{"reasoning_config": {"effort": 3}}', None), ('{"reasoning_config": {"effort": "low"}}', "low"))
        check(effort is not None and all(effort(cfg) == want for cfg, want in cases),
              "effort never raises: bad JSON, no config, wrong shapes read null; enabled by default")
        check(len(w1["summary"]) == 600 and w1["summary_truncated"], "summary capped at 600 chars and flagged")
        check(w2["status"] == "stopped" and w2["duration_s"] is None, "closed without answer: stopped, no duration")
        check(w3["status"] == "running" and w3["duration_s"] is None, "open worker: running, no duration")
        check(w5["status"] == "running" and w5["duration_s"] is None,
              f"open worker that already wrote text: still running ({w5['status']})")
        check(w1["tokens"] == 120 and w1["tool_calls"] == 3, "tokens and tool calls summed from the session")
        # Cost: Hermes' own record, never a guess and never a fake $0.
        check((w1["cost_usd"], w1["cost_status"]) == (1.25, "estimated"), f"an estimated worker reports its estimate ({w1['cost_usd']}, {w1['cost_status']})")
        check((w2["cost_usd"], w2["cost_status"]) == (0.0, "included"), f"a subscription worker reads included, not unpriced ({w2['cost_usd']}, {w2['cost_status']})")
        check((w3["cost_usd"], w3["cost_status"]) == (None, "unknown"), f"no cost record reads unknown, not $0 ({w3['cost_usd']}, {w3['cost_status']})")
        check((w5["cost_usd"], w5["cost_status"]) == (None, "unknown"), f"an unknown status is not priced, whatever amount is stored ({w5['cost_usd']}, {w5['cost_status']})")
        w6, w7, w8 = workers["W6"], workers["W7"], workers["W8"]
        check(w6["status"] == "stopped" and w6["duration_s"] is None,
              f"a worker never ended and silent past STALE_S reads stopped, not running forever ({w6['status']})")
        check(w7["status"] == "running", f"an old worker with a fresh heartbeat is still running ({w7['status']})")
        check(w8["status"] == "running", f"an old worker with a fresh message is still running ({w8['status']})")
        check(api.list_children(conn, "P2", now=NOW + api.STALE_S * 2)["batches"][-1]["workers"][0]["status"] == "stopped",
              "the same running worker reads stopped once it has been silent past STALE_S")
        # A chat that has no row yet (just opened) is an empty history, not an error.
        check(api.list_children(conn, "no-such-chat")["batches"] == [], "/children for a chat with no row yet is empty, not an error")

        check(api.read_output(conn, "P2", "W1")["text"] == LONG_ANSWER, "/output returns the full answer")
        check(api.read_output(conn, "P2", "N1")["text"] == "nested answer", "/output serves a nested worker of this chat")
        # Each refusal is named: a non-worker is refused as such, before any ownership walk.
        for sid, code, detail, what in (("P1", 403, "not a delegated worker session", "a non-worker session is refused (403)"),
                                        ("W4", 403, "worker belongs to another conversation",
                                         "another conversation's worker output is refused (403)"),
                                        ("nope", 404, "session not found", "an unknown session is 404")):
            try:
                api.read_output(conn, "P2", sid)
                check(False, what)
            except HTTPException as exc:
                check(exc.status_code == code and str(exc.detail).startswith(detail), f"{what} [{exc.detail}]")

        check(data.get("title") == "Refactor fleet routing", f"/children names the conversation ({data.get('title')!r})")
        check(api.list_children(conn, "P1").get("title") == "Refactor fleet routing",
              "an untitled link takes the conversation's newest title")
        # Hermes' lineage rule: branches, reset forks, tool children and workers are their own conversations.
        check(api._lineage(conn, "R1") == ["R1", "R2"],
              f"the walk down skips a branch, a reset fork and a tool child ({api._lineage(conn, 'R1')})")
        for sid, what in (("RB", "a /branch"), ("RR", "a reset fork"), ("RT", "a tool child"), ("RW", "a worker session")):
            got = api.list_children(conn, sid)
            check(got["lineage"] == [sid] and got["batches"] == [],
                  f"{what} of a compressed chat is its own conversation, with no inherited workers ({got['lineage']})")
        try:
            api.read_output(conn, "RB", "RW")
            check(False, "a branch cannot read its source chat's worker output (403)")
        except HTTPException as exc:
            check(exc.status_code == 403, "a branch cannot read its source chat's worker output (403)")
        compressed = [w for b in api.list_children(conn, "R2", now=NOW)["batches"] for w in b["workers"]]
        check([w["session_id"] for w in compressed] == ["RW", "CW"],
              f"a worker compressed mid-run is one row, not two ({[w['session_id'] for w in compressed]})")
        cw = compressed[-1]
        check(cw["status"] == "completed" and cw["duration_s"] == 200 and cw["goal"] == "Audit the repo",
              f"its status and end come from the tip, start and goal from the root ({cw['status']}, {cw['duration_s']})")
        check(cw["tool_calls"] == 6 and cw["tokens"] == 240, "its tool calls and tokens are summed over both halves")
        check((cw["cost_usd"], cw["cost_status"]) == (0.75, "estimated"),
              f"its cost sums both halves, the billed half at its actual amount; one estimate makes it estimated ({cw['cost_usd']}, {cw['cost_status']})")
        uw = [w for b in api.list_children(conn, "U", now=NOW)["batches"] for w in b["workers"]]
        check([(w["cost_usd"], w["cost_status"]) for w in uw] == [(0.5, "estimated")],
              f"an unpriced half adds nothing to a compressed worker's cost ({[(w['cost_usd'], w['cost_status']) for w in uw]})")
        rw = compressed[0]
        check((rw["cost_usd"], rw["cost_status"]) == (0.38, "actual"), f"a billed worker reports the actual amount ({rw['cost_usd']}, {rw['cost_status']})")
        check(cw["summary"] == "final audit answer" and api.read_output(conn, "R2", "CW")["text"] == "final audit answer",
              "its answer is the tip's, not the interim note before compression")

        run_processes(conn)
    run_routes_close()
    run_no_path_leak()


class _TrackedConn:
    """A real read-only connection that remembers whether close() was called."""

    def __init__(self, real: sqlite3.Connection) -> None:
        self._real, self.closed = real, False

    def close(self) -> None:
        self.closed = True
        self._real.close()

    def __enter__(self):
        self._real.__enter__()
        return self

    def __exit__(self, *exc):
        return self._real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._real, name)


def run_routes_close() -> None:
    """Every route closes its connection before it returns (the panel polls them every 3 s)."""
    real_connect, opened = api._connect, []

    def tracking():
        conn = _TrackedConn(real_connect())
        opened.append(conn)
        return conn

    api._connect = tracking
    try:
        for name, call in (("/children", lambda: api.children("P2")),
                           ("/output", lambda: api.output("P2", "W1")),
                           ("/processes", lambda: api.processes("P2")),
                           ("/process_output", lambda: api.process_output("P2", "proc_none")),
                           ("/output refused", lambda: api.output("P2", "W4"))):
            opened.clear()
            try:
                call()
            except HTTPException:
                pass
            check(len(opened) == 1 and opened[0].closed, f"{name} closes its state.db connection when it returns")
    finally:
        api._connect = real_connect


class _Unreadable:
    """A path whose read fails with an OSError that names an absolute path."""

    SECRET = "C:\\Users\\someone\\secret-home\\hermes"

    def is_file(self) -> bool:
        return True

    def __truediv__(self, _name):
        return self

    def read_text(self, *a, **k):
        raise PermissionError(13, "Permission denied", self.SECRET + "\\file.json")


def run_no_path_leak() -> None:
    """A 503 names the file and the error type, never an absolute path from the exception."""
    saved = api._checkpoint_path, api._results_dir
    api._checkpoint_path = lambda: _Unreadable()
    api._results_dir = lambda: _Unreadable()
    try:
        with api._connect() as conn:
            for what, call in (("processes.json", lambda: api.list_processes(conn, "P2")),
                               ("a process record", lambda: api.read_process_output(conn, "P2", "proc_x"))):
                try:
                    call()
                    check(False, f"an unreadable {what} is a 503")
                except HTTPException as exc:
                    detail = str(exc.detail)
                    check(exc.status_code == 503 and "secret-home" not in detail and "Users" not in detail
                          and "PermissionError" in detail,
                          f"an unreadable {what} is a 503 that names the error but not the path [{detail}]")
    finally:
        api._checkpoint_path, api._results_dir = saved


def write_json(path: Path, data, mtime: float | None = None) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def receipt(pid: str, parent: str, started: float, ended: float, exit_code, reason="exited", output="") -> None:
    write_json(PROC_RESULTS / f"{pid}.json", {
        "id": pid, "command": f"echo {pid}\nsecond line", "cwd": "/w", "task_id": "t",
        "owner_task_id": parent, "session_key": parent, "parent_session_id": parent,
        "started_at": started, "exit_code": exit_code, "completion_reason": reason,
        "termination_source": "", "notify_on_complete": True, "output": output,
    }, mtime=ended)


def run_processes(conn) -> None:
    """Background commands: running from processes.json, finished from process-results receipts."""
    import shutil
    shutil.rmtree(PROC_HOME, ignore_errors=True)
    PROC_RESULTS.mkdir(parents=True)
    api._checkpoint_path = lambda: PROC_HOME / "processes.json"
    api._results_dir = lambda: PROC_RESULTS
    api._RECEIPTS.clear()

    live_pid = os.getpid()  # a PID that is certainly alive: this test process
    write_json(PROC_HOME / "processes.json", [
        {"session_id": "proc_run", "command": "npm run dev", "pid": live_pid, "pid_scope": "host",
         "host_start_time": None, "started_at": 3000.0, "parent_session_id": "P2", "cwd": "/w"},
        {"session_id": "proc_gone", "command": "sleep 99", "pid": 0, "pid_scope": "host",
         "host_start_time": None, "started_at": 2900.0, "parent_session_id": "P1", "cwd": "/w"},
        {"session_id": "proc_foreign_run", "command": "x", "pid": live_pid, "pid_scope": "host",
         "started_at": 3000.0, "parent_session_id": "Q"},
    ])
    receipt("proc_ok", "P1", 1000.0, 1042.0, 0, output="done")
    receipt("proc_bad", "P2", 2000.0, 2005.5, 1, output="E" * (api.OUTPUT_TAIL + 50))
    receipt("proc_kill", "P2", 2100.0, 2200.0, -15, reason="killed")
    receipt("proc_foreign", "Q", 1000.0, 1001.0, 0, output="secret of another chat")
    receipt("proc_r1", "R1", 3100.0, 3101.0, 0, output="R1's command")
    (PROC_RESULTS / "proc_broken.json").write_text("{not json", encoding="utf-8")

    data = api.list_processes(conn, "P2")
    rows = {p["id"]: p for p in data["processes"]}
    check(set(rows) == {"proc_run", "proc_gone", "proc_ok", "proc_bad", "proc_kill"},
          f"processes of the whole compression chain, nothing foreign ({sorted(rows)})")
    check([p["id"] for p in data["processes"]] == ["proc_ok", "proc_bad", "proc_kill", "proc_gone", "proc_run"],
          "processes ordered by start time")
    check(data["unreadable"] == 1, f"an unreadable receipt is counted, not hidden ({data['unreadable']})")
    check(rows["proc_run"]["status"] == "running" and rows["proc_run"]["duration_s"] is None,
          "a checkpointed live PID is running, no duration")
    check(rows["proc_gone"]["status"] == "stopped", "a checkpointed PID that is gone reads stopped, not running")
    check(rows["proc_ok"]["status"] == "completed" and abs(rows["proc_ok"]["duration_s"] - 42) < 0.01,
          "exit 0: completed, duration from the receipt's write time")
    check(rows["proc_bad"]["status"] == "failed" and rows["proc_bad"]["exit_code"] == 1,
          "non-zero exit: failed, exit code kept")
    check(rows["proc_kill"]["status"] == "stopped", "killed: stopped, never completed")
    check(all("output" not in p for p in data["processes"]), "the list never carries output")
    check(rows["proc_gone"].get("has_output") is False and rows["proc_ok"].get("has_output") is True,
          "a checkpoint-only row says it has no output to ask for; a receipt row says it has")
    check(any(p["id"] == "proc_r1" for p in api.list_processes(conn, "R2")["processes"]) and
          api.list_processes(conn, "RB")["processes"] == [],
          "a branch of a compressed chat does not list the source chat's commands")

    receipt("proc_run", "P2", 3000.0, 3010.0, 0)
    api._RECEIPTS.clear()
    rows = {p["id"]: p for p in api.list_processes(conn, "P2")["processes"]}
    check(rows["proc_run"]["status"] == "completed", "a receipt wins over a stale checkpoint entry")

    long_cmd = "y" * (api.COMMAND_CHARS + 10)
    write_json(PROC_RESULTS / "proc_long.json", {"id": "proc_long", "command": long_cmd, "parent_session_id": "P2",
                                                 "started_at": 1.0, "exit_code": 0, "output": ""}, mtime=2.0)
    row = {p["id"]: p for p in api.list_processes(conn, "P2")["processes"]}["proc_long"]
    check(len(row["command"]) == api.COMMAND_CHARS and row["command_truncated"], "long command capped and flagged")

    out = api.read_process_output(conn, "P2", "proc_bad")
    check(len(out["output"]) == api.OUTPUT_TAIL and out["output_truncated"], "output served as a flagged tail")
    check(api.read_process_output(conn, "P2", "proc_long")["command"] == long_cmd, "/process_output returns the full command")
    for pid, code, what in (("proc_foreign", 403, "another conversation's output is refused (403)"),
                            ("proc_none", 404, "a missing receipt is 404"),
                            ("../state", 400, "a non-process id is refused (400)")):
        try:
            api.read_process_output(conn, "P2", pid)
            check(False, what)
        except HTTPException as exc:
            check(exc.status_code == code, what)

    import types
    fake = types.ModuleType("tools.process_registry")
    fake.ProcessRegistry = type("ProcessRegistry", (), {})  # the private liveness test is gone
    saved = {k: sys.modules.get(k) for k in ("tools", "tools.process_registry")}
    sys.modules["tools"] = types.ModuleType("tools")
    sys.modules["tools.process_registry"] = fake
    dead_pid = 4_194_303 * 7  # above any PID limit: never alive
    try:
        check(api._pid_is_ours(live_pid, None) is True, "a changed liveness API falls back to psutil: a live PID reads alive, never a 500")
        check(api._pid_is_ours(dead_pid, None) is False, "a changed liveness API never reads a dead PID as alive (no fail-open)")
        saved_psutil = sys.modules.get("psutil")
        sys.modules["psutil"] = None  # import psutil now raises ImportError
        try:
            check(api._pid_is_ours(live_pid, None) is False, "with no liveness source at all the process reads stopped, not running forever")
        finally:
            if saved_psutil is None:
                sys.modules.pop("psutil", None)
            else:
                sys.modules["psutil"] = saved_psutil
    except Exception as exc:  # noqa: BLE001
        check(False, f"a changed liveness API never becomes a 500 ({type(exc).__name__}: {exc})")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    shutil.rmtree(PROC_RESULTS)
    (PROC_HOME / "processes.json").unlink()
    empty = api.list_processes(conn, "P2")
    check(empty["processes"] == [] and empty["unreadable"] == 0, "no files yet: empty list, not an error")
    (PROC_HOME / "processes.json").write_text("[{broken", encoding="utf-8")
    try:
        api.list_processes(conn, "P2")
        check(False, "an unreadable processes.json is an error, not an empty list")
    except HTTPException as exc:
        check(exc.status_code == 503, "an unreadable processes.json is an error, not an empty list")
    run_bad_shapes(conn)


def run_bad_shapes(conn) -> None:
    """Valid JSON in the wrong shape is a named unreadable record (or a 503), never a 500 that hides the rest."""
    api._RECEIPTS.clear()
    PROC_RESULTS.mkdir(parents=True, exist_ok=True)
    write_json(PROC_HOME / "processes.json", {"proc_x": {}})
    try:
        api.list_processes(conn, "P2")
        check(False, "processes.json with a dict top level is a 503")
    except HTTPException as exc:
        check(exc.status_code == 503, "processes.json with a dict top level is a 503")
    except Exception as exc:  # noqa: BLE001
        check(False, f"processes.json with a dict top level is a 503, not a 500 ({type(exc).__name__})")
    write_json(PROC_HOME / "processes.json", [
        None, "proc_abc", 7,
        {"session_id": "proc_listparent", "command": "x", "pid": os.getpid(), "pid_scope": "host",
         "started_at": 5.0, "parent_session_id": ["P2"]},
        {"session_id": "proc_textstart", "command": "y", "pid": os.getpid(), "pid_scope": "host",
         "started_at": "yesterday", "parent_session_id": "P2"},
    ])
    receipt("proc_good", "P2", 10.0, 11.0, 0, output="fine")
    write_json(PROC_RESULTS / "proc_badparent.json", {"id": "proc_badparent", "parent_session_id": ["P2"],
                                                       "started_at": 1.0, "exit_code": 0})
    write_json(PROC_RESULTS / "proc_badstart.json", {"id": "proc_badstart", "parent_session_id": "P2",
                                                      "started_at": "yesterday", "exit_code": 0, "command": "z"})
    write_json(PROC_RESULTS / "proc_list.json", [1, 2, 3])
    try:
        data = api.list_processes(conn, "P2")
    except Exception as exc:  # noqa: BLE001
        check(False, f"wrong-shape entries and receipts never become a 500 ({type(exc).__name__}: {exc})")
        return
    ids = {p["id"] for p in data["processes"]}
    check({"proc_good", "proc_badstart", "proc_textstart"} <= ids and "proc_listparent" not in ids and "proc_badparent" not in ids,
          f"one bad record never hides the rest; a non-text owner is never ours ({sorted(ids)})")
    bad = {p["id"]: p for p in data["processes"]}
    check(bad["proc_badstart"]["started_at"] is None and bad["proc_badstart"]["duration_s"] is None,
          "a text started_at reads as unknown, with no duration")
    check(data["unreadable"] == 4, f"3 non-object checkpoint entries + 1 non-object receipt are counted ({data['unreadable']})")
    for pid, what in (("proc_list", "a receipt that is a JSON list"),):
        try:
            api.read_process_output(conn, "P2", pid)
            check(False, f"/process_output on {what} is a 503")
        except HTTPException as exc:
            check(exc.status_code == 503, f"/process_output on {what} is a 503 [{exc.detail}]")
        except Exception as exc:  # noqa: BLE001
            check(False, f"/process_output on {what} is a 503, not a 500 ({type(exc).__name__})")
    try:
        api.read_process_output(conn, "P2", "proc_badparent")
        check(False, "/process_output refuses a receipt whose owner is not text (403)")
    except HTTPException as exc:
        check(exc.status_code == 403, "/process_output refuses a receipt whose owner is not text (403)")
    except Exception as exc:  # noqa: BLE001
        check(False, f"/process_output on a non-text owner is a 403, not a 500 ({type(exc).__name__})")
    check(api._delegate_from("[1, 2]") is None and api._delegate_from('{"_delegate_from": ["P2"]}') is None,
          "a model_config that is a list, or a non-text _delegate_from, is not a worker marker")


FILES_DB = HERE / ".out" / "files_state.db"


def build_files_fixture() -> None:
    """A chat F1 -> F2 (compression), its worker FW and an unrelated chat G, with file tool calls."""
    FILES_DB.unlink(missing_ok=True)
    db = sqlite3.connect(FILES_DB)
    db.executescript(
        "create table sessions (id text primary key, model text, model_config text, parent_session_id text,"
        " started_at real not null, ended_at real, end_reason text, tool_call_count integer default 0,"
        " input_tokens integer default 0, output_tokens integer default 0, last_activity_at real,"
        " source text not null default 'cli', title text, estimated_cost_usd real, actual_cost_usd real,"
        " cost_status text, cwd text);"
        "create table messages (id integer primary key autoincrement, session_id text, role text, content text,"
        " timestamp real, tool_calls text, tool_call_id text);")

    def session(sid, started, ended=None, reason=None, parent=None, delegate_from=None, cwd=None):
        cfg = json.dumps({"_delegate_from": delegate_from} if delegate_from else {})
        db.execute("insert into sessions (id, model, model_config, parent_session_id, started_at, ended_at,"
                   " end_reason, cwd) values (?,?,?,?,?,?,?,?)", (sid, "m", cfg, parent, started, ended, reason, cwd))

    seq = [0]

    def call(sid, ts, name, args, result='{"success": true}', raw_args=None):
        seq[0] += 1
        cid = f"c{seq[0]}"
        fn = {"name": name, "arguments": raw_args if raw_args is not None else json.dumps(args)}
        db.execute("insert into messages (session_id, role, content, timestamp, tool_calls) values (?,?,?,?,?)",
                   (sid, "assistant", "", ts, json.dumps([{"id": cid, "type": "function", "function": fn}])))
        db.execute("insert into messages (session_id, role, content, timestamp, tool_call_id) values (?,?,?,?,?)",
                   (sid, "tool", result, ts + 0.1, cid))

    session("F1", 100, 200, "compression", cwd="D:\\Proj")
    session("F2", 200, parent="F1", cwd="D:\\Proj")
    session("FW", 150, 170, "compression", delegate_from="F1", cwd="D:\\Proj")
    session("FW2", 170, 180, "completed", parent="FW", delegate_from="F1", cwd="D:\\Proj")
    session("G", 100, cwd="/other")
    call("F1", 101, "read_file", {"path": "D:\\Proj\\src\\a.py"})
    call("F1", 102, "patch", {"mode": "replace", "path": "src/a.py", "old_string": "x", "new_string": "y"})
    call("F1", 103, "write_file", {"path": "D:/Proj/README.md", "content": "hi"},
         result='{"error": "Refusing to overwrite"}')
    call("F1", 104, "terminal", {"command": "echo hi > D:/Proj/x.txt"})
    call("F1", 105, "read_file", {}, raw_args="{not json")
    call("FW", 160, "read_file", {"path": "D:/Proj/docs/guide.md"})
    call("FW", 161, "write_file", {"path": "d:\\proj\\SRC\\..\\src\\A.py", "content": "z"})
    call("FW2", 171, "read_file", {"path": "D:/Proj/docs/guide.md"})
    call("F2", 201, "patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: D:/Proj/src/b.py\n@@\n-a\n+b\n"
                                                       "*** Move File: D:/Proj/old.txt -> D:/Proj/new.txt\n"
                                                       "*** Delete File: D:/Proj/gone.txt\n*** End Patch"})
    call("F2", 202, "patch", {"mode": "patch", "patch": "nothing a parser can read"})
    call("F2", 203, "write_file", {"path": "D:/Proj/README.md"}, result="[write_file] `D:/Proj/README.md` BLOCKED, not run")
    call("F2", 204, "patch", {"path": "D:/Proj/src/c.py"}, result="[patch] D:/Proj/src/c.py FAILED: no match")
    call("F2", 205, "write_file", {"path": "D:/Proj/src/d.py"}, result="[write_file] wrote to D:/Proj/src/d.py")
    call("F2", 206, "write_file", {"path": "D:/Proj/src/e.py"}, result="[write_file] D:/Proj/src/e.py FAILED")
    call("G", 101, "write_file", {"path": "/other/secret.txt", "content": "s"})
    db.commit()
    db.close()


def run_files() -> None:
    core = env.core_dir()
    if core is not None and str(core) not in sys.path:
        sys.path.append(str(core))  # Hermes' own V4A parser reads a patch in patch mode
    build_files_fixture()
    saved = api._db_path
    api._db_path = lambda: FILES_DB
    try:
        for vec_in, vec_key in json.loads((HERE / "path_vectors.json").read_text(encoding="utf-8"))["cases"]:
            check(api.path_key(vec_in) == vec_key, f"files: path_key({vec_in!r}) == {vec_key!r} (shared with the page)")
        with api._connect() as conn:
            got = api.list_files(conn, "F2")
            again = api.list_files(conn, "F2")
        by = {f["key"]: f for f in got["files"]}
        check(again is got, "files: a second read with no new message is served from the cache")
        check(got["cwd"] == "D:\\Proj", f"files: the chat's folder comes from the newest link [{got['cwd']}]")
        a = by.get("d:/proj/src/a.py")
        check(bool(a) and a["reads"] == 1 and a["writes"] == 2 and a["who"] == ["", "FW"] and a["editors"] == ["", "FW"],
              "files: one file under three spellings (absolute, relative to the chat's folder, '..' and case) "
              "is one row: read 1, edited 2, touched by the chat first and then by the worker")
        guide = by.get("d:/proj/docs/guide.md")
        check(bool(guide) and guide["who"] == ["FW"] and guide["editors"] == [] and guide["reads"] == 2,
              f"files: a worker's file names the worker; its compressed later half counts as the same worker [{guide and guide['who']}]")
        readme = by.get("d:/proj/readme.md")
        check(bool(readme) and readme["writes"] == 0 and readme["failed"] == 2 and readme["last_failed"],
              "files: a refused write ({\"error\"}) and a compressed BLOCKED stub count as failed, not as edits")
        c_py = by.get("d:/proj/src/c.py")
        check(bool(c_py) and c_py["failed"] == 1 and c_py["writes"] == 0, "files: a compressed 'FAILED:' stub is a failure")
        e_py = by.get("d:/proj/src/e.py")
        check(bool(e_py) and e_py["failed"] == 1 and e_py["writes"] == 0, "files: a compressed bare ' FAILED' stub is a failure")
        d_py = by.get("d:/proj/src/d.py")
        check(bool(d_py) and d_py["writes"] == 1 and not d_py["last_failed"], "files: a compressed success stub is an edit")
        check("d:/proj/src/b.py" in by and by["d:/proj/src/b.py"]["writes"] == 1, "files: a V4A update names its file")
        check(by.get("d:/proj/old.txt", {}).get("last_op") == "delete" and by.get("d:/proj/new.txt", {}).get("writes") == 1,
              "files: a V4A move deletes its source and writes its target")
        check(by.get("d:/proj/gone.txt", {}).get("deletes") == 1, "files: a V4A delete is a delete")
        check(not any("x.txt" in k for k in by), "files: a terminal command's redirect is not a file-tool call")
        check(not any("secret" in k for k in by), "files: another chat's files never show")
        check(got["unreadable"] == 2 and got["calls"] == 13,
              f"files: unparseable arguments and an unreadable patch are counted, not dropped "
              f"[unreadable {got['unreadable']}, calls {got['calls']}]")
        fresh = sqlite3.connect(FILES_DB)
        fresh.execute("insert into messages (session_id, role, content, timestamp, tool_calls) values (?,?,?,?,?)",
                      ("F2", "assistant", "", 300, json.dumps([{"id": "late", "function": {
                          "name": "read_file", "arguments": json.dumps({"path": "D:/Proj/late.md"})}}])))
        fresh.commit()
        fresh.close()
        with api._connect() as conn:
            later = api.list_files(conn, "F2")
        check(later["files"][0]["key"] == "d:/proj/late.md", "files: a new message is read at once, not served stale from the cache")
        stamps = [f["last_at"] for f in got["files"]]
        check(stamps == sorted(stamps, reverse=True), "files: newest first")
        api.MAX_FILES, cap = 3, api.MAX_FILES
        api._FILES_CACHE.clear()
        try:
            with api._connect() as conn:
                capped = api.list_files(conn, "F2")
        finally:
            api.MAX_FILES = cap
            api._FILES_CACHE.clear()
        check(len(capped["files"]) == 3 and capped["more"] == len(later["files"]) - 3,
              "files: past MAX_FILES the rest is counted in `more`, never silently cut")
        real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__
        import builtins

        def no_parser(name, *a, **k):
            if name == "tools.patch_parser":
                raise ImportError("parser moved")
            return real_import(name, *a, **k)

        builtins.__import__ = no_parser
        try:
            check(api._patch_targets({"mode": "patch", "patch": "*** Begin Patch\n*** Add File: z\n+1\n*** End Patch"}) is None,
                  "files: without Hermes' V4A parser a patch is unreadable (counted), not a crash")
        finally:
            builtins.__import__ = real_import
        check(api.files.__name__ == "files" and any(getattr(r, "path", "") == "/files" and "GET" in r.methods
                                                    for r in api.router.routes), "files: /files is a GET route")
    finally:
        api._db_path = saved


def run_live() -> None:
    core = env.core_dir()
    if core is None:
        print("SKIP  live: no Hermes core found (set HERMES_AGENT_DIR)")
        return
    sys.path.insert(0, str(core))
    importlib.reload(api)  # drop the fixture override; hermes_constants locates the real state.db
    with api._connect() as conn:
        parent = conn.execute(
            "select json_extract(model_config, '$._delegate_from') p from sessions "
            "where json_extract(model_config, '$._delegate_from') is not null "
            "group by p order by count(*) desc limit 1"
        ).fetchone()
        if not parent:
            print("SKIP  live: no delegated sessions in this state.db")
        else:
            workers = [w for b in api.list_children(conn, parent["p"])["batches"] for w in b["workers"]]
            check(bool(workers) and all(w["status"] in {"completed", "stopped", "running"} for w in workers),
                  f"live: {len(workers)} workers read, every status known")
        owner = next((json.loads(p.read_text(encoding="utf-8")).get("parent_session_id")
                      for p in sorted(api._results_dir().glob("proc_*.json"))), None)
        busy = conn.execute("select session_id from messages where tool_calls like '%write_file%' "
                            "order by id desc limit 1").fetchone()
        if busy:
            seen = api.list_files(conn, busy["session_id"])
            check(bool(seen["files"]), f"live: {len(seen['files'])} files read for a chat that wrote one, "
                                       f"{seen['unreadable']} of {seen['calls']} calls unreadable")
        if not owner:
            print("SKIP  live: no process receipts in this home")
            return
        procs = api.list_processes(conn, owner)
        check(bool(procs["processes"]) and all(p["status"] in {"completed", "failed", "stopped", "running"}
                                               for p in procs["processes"]),
              f"live: {len(procs['processes'])} background commands read, every status known, "
              f"{procs['unreadable']} unreadable")


run_fixture()
run_files()
if "--live" in sys.argv:
    run_live()
print("\nALL PASSED" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
