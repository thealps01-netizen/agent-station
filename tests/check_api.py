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
process and anything that is not a process id.
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
        " output_tokens integer default 0, last_activity_at real);"
        "create table messages (id integer primary key autoincrement, session_id text,"
        " role text, content text, timestamp real);"
    )

    def session(sid, started, ended=None, reason=None, parent=None, delegate_from=None, model="m", active=None,
                reasoning=None):
        cfg = {"_delegate_from": delegate_from} if delegate_from else {}
        if reasoning is not None:
            cfg["reasoning_config"] = reasoning
        cfg = json.dumps(cfg)
        db.execute(
            "insert into sessions values (?,?,?,?,?,?,?,?,?,?,?)",
            (sid, model, cfg, parent, started, ended, reason, 3, 100, 20, active),
        )

    def message(sid, role, content, ts=0.0):
        db.execute("insert into messages (session_id, role, content, timestamp) values (?,?,?,?)",
                   (sid, role, content, ts))

    session("P1", 900, 1500, "compression")
    session("P2", 1500, parent="P1")
    session("Q", 900)
    session("W1", 1000, 1042, "completed", delegate_from="P1", model="claude-sonnet-5",
            reasoning={"enabled": True, "effort": "medium"})
    message("W1", "user", "Read the notes\nsecond line is not part of the goal")
    message("W1", "assistant", LONG_ANSWER)
    session("W2", 1000.5, 1300, "closed", delegate_from="P1")
    message("W2", "user", "Count files")
    session("W3", 2000, delegate_from="P2", reasoning={"enabled": False, "effort": "high"})
    message("W3", "user", "Wait")
    session("W4", 1000.2, 1010, "completed", delegate_from="Q")
    message("W4", "assistant", "other conversation")
    # Still working, but it has already said something: an answer so far is not an end state.
    session("W5", 2000.5, delegate_from="P2")
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
        sys.modules["tools.process_registry"] = None
        check(api._pid_is_ours(live_pid, None) is True, "a disabled registry falls back to psutil without depending on another plugin")
        sys.modules["tools.process_registry"] = types.ModuleType("tools.process_registry")
        check(api._pid_is_ours(live_pid, None) is True, "a missing registry class falls back to psutil")
        sys.modules["tools.process_registry"] = fake
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
        if not owner:
            print("SKIP  live: no process receipts in this home")
            return
        procs = api.list_processes(conn, owner)
        check(bool(procs["processes"]) and all(p["status"] in {"completed", "failed", "stopped", "running"}
                                               for p in procs["processes"]),
              f"live: {len(procs['processes'])} background commands read, every status known, "
              f"{procs['unreadable']} unreadable")


run_fixture()
if "--live" in sys.argv:
    run_live()
print("\nALL PASSED" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
