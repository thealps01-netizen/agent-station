"""Real-render harness for agent-station: the real panel in the app's own Electron, on fixture data.

Run from tests/ with the interpreter that runs check_api.py (it needs fastapi only):
    python live.py              the 56 shots below; exit 0 = no violation in any of them
    python live.py --selftest   breaks each measured rule once with injected CSS; exit 0 = each caught

Why: jsdom (render_check, preview.mjs) proves structure, never layout, and the preview draws the SVG
fallback, not the canvas scenes the user sees. This renders the real desktop/plugin.js with the real
React, the real canvas and the app's compiled stylesheet (fonts included), against the panel's own
backend route functions, and measures every shot in the engine (measure.cjs).

Steps: build a synthetic Hermes home under tests/.out/live_home/ (state.db, processes.json,
logs/process-results/), serve plugin_api's route functions on 127.0.0.1 over stdlib http.server, run
one Electron (live.cjs) for the whole shot list, print one line per shot and the verdict.

Shots (tests/.out/live/, git-ignored): <tab>-<data>-<mode>-<width>.png for tab agents|commands|replay,
data full|empty, mode dark|light, width 915|560|380 (36), plus five opened states on `full`
(agents-detail, agents-worker, agents-runpick, commands-failed, replay-failed) in dark|light at 915|380
(20). Each PNG is cut into 560 px bands with 40 px overlap under bands/, and every measurement goes to
report.json.

Rules, each a violation naming the shot, the selector and the text:
  M1 clipped   a visible text cut by its own box or a clipping ancestor (ellipsis, scrolled-out rows
               and .sw-sr screen-reader text exempt)
  M2 overlap   text boxes of two elements in one HUD panel intersect by more than 1 px
  M3 sideways  anything ends past the page's right edge
  M4 half row  at scroll position 0 a scroll box with more content than it shows cuts a row
  M5 numerals  a value (count, ratio, cost, %, tokens, duration, clock) not in --code with tabular-nums;
               two values of one size with different text-shadows
  M6 contrast  reading / tone-as-text ink below 4.5:1 (3:1 large), shot.cjs's rule
  M7 engine    an engine error, no route, an alert box on fixture data, or (full base shots) a FLEET /
               ORBIT / WORMHOLE panel that did not switch to its canvas
  M8 narrow    the panel is narrower than its page's content box (a max-width cap on a wide pane)

It reads and writes only tests/.out/: the fixture home is synthetic and English, and the user's own
Hermes home and installed panel are never opened. There is no switch to point it elsewhere.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / ".out" / "live"
HOME = HERE / ".out" / "live_home"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "dashboard"))

import env  # noqa: E402

TABS = ("agents", "commands", "replay")
DATA = ("full", "empty")
MODES = ("dark", "light")
WIDTHS = (915, 560, 380)
STATES = ("agents-detail", "agents-worker", "agents-runpick", "commands-failed", "replay-failed")
STATE_WIDTHS = (915, 380)
SESSION = {"full": "chat-full", "empty": "chat-empty"}
CWD = {"full": "/work/atlas", "empty": "/work/notes"}
# --selftest: one CSS break per measured rule, each must be reported under its rule's name
BREAKS = {
    "M1": ".sw-hp .sw-hpt{max-width:18px!important;overflow:hidden!important;text-overflow:clip!important}",
    "M2": ".sw-hp .sw-hph{margin-bottom:-26px!important}",
    "M3": ".sw-panel{min-width:1400px!important}",
    # mid-row at 915 px; 101 px fell on a row edge once the panel took the full width (M8)
    "M4": ".sw-hlog{max-height:90px!important}",
    # :root + .sw-page[data-theme] outranks the theme's own `.sw-page[data-theme=terminal] :is(…)` rules
    "M5": ":root .sw-page[data-theme] .sw-hbig,:root .sw-page[data-theme] .sw-hbig *{font-family:serif!important}",
    # mid grey #777 is under 4.5:1 on both the dark (~4.0:1) and the light (~4.1:1) panel fill
    "M6": ":root .sw-page[data-theme] .sw-hp .sw-hpt,:root .sw-page[data-theme] .sw-hp .sw-hpt *{color:#777!important}",
    "M8": ".sw-panel{max-width:600px!important;margin:0 auto!important}",
}


def fail(message: str) -> None:
    print(f"LIVE: cannot run — {message}")
    sys.exit(1)


# ── fixture ───────────────────────────────────────────────────────────────────────────────────────

GOALS = [
    "Map every route the fleet console exposes and note which handlers read the session store directly",
    "Collect the slowest queries from the last load test and propose an index for each of them",
    "Summarise the open review comments on the console branch, grouped by the file they touch",
    "Draft the migration notes for the station layout so the next release can ship them unchanged",
    "Check every corner readout of the station at narrow widths and list the ones that are cut",
    "Rewrite the legend of the files panel so all three labels fit beside the cells",
    "Audit the numbers on the fleet page and list the ones not set in the code font",
    "Measure the scroll lists and report the ones that end on half a row",
    "Profile the canvas intro of the station and note the frames over sixteen milliseconds",
    "Trace why the wormhole callouts overlap the left readouts on a narrow pane",
    "Compare the empty states of the three tabs and propose one sentence for each panel",
    "Verify the light theme contrast of every grey label on the fleet page",
    "Port the orbit scene's colour probe to the wormhole so both read the theme the same way",
    "Find the console lines that wrap inside the output box and shorten the longest ones",
    "Inventory the keyboard paths through the run picker and the detail panel",
    "Write the test plan for the background commands panel, failure cases first",
    "Benchmark the replay step loader against the largest request in the sample data",
    "Rename the station callout classes so they match the readout names",
    "List every tooltip that repeats the text of its own label",
    "Reduce the bundle's inline styles to the ones the canvas really needs",
    "Check that the stopped command keeps its last output line visible",
]
ANSWER = ("Done. The routes are listed in docs/console.md with the handler, the store it reads and the cache "
          "it skips; three handlers read the store twice per request and are marked for a follow-up.")


def build_fixture(now: float) -> dict:
    """The synthetic home: two chats (`full`, `empty`), their workers, files, edits and commands."""
    shutil.rmtree(HOME, ignore_errors=True)
    (HOME / "logs" / "process-results").mkdir(parents=True)
    db = sqlite3.connect(HOME / "state.db")
    db.executescript(
        "create table sessions (id text primary key, model text, model_config text, parent_session_id text,"
        " started_at real not null, ended_at real, end_reason text, tool_call_count integer default 0,"
        " input_tokens integer default 0, output_tokens integer default 0, last_activity_at real,"
        " source text not null default 'cli', title text, estimated_cost_usd real, actual_cost_usd real,"
        " cost_status text, cwd text);"
        "create table messages (id integer primary key autoincrement, session_id text, role text, content text,"
        " timestamp real, tool_calls text, tool_call_id text, display_kind text);")
    calls = {"n": 0}

    def session(sid, started, ended=None, reason=None, delegate_from=None, model="claude-sonnet-5", effort=None,
                tools=0, tokens=(0, 0), active=None, title=None, cost=(None, None, None), cwd=None):
        cfg = {"_delegate_from": delegate_from} if delegate_from else {}
        if effort:
            cfg["reasoning_config"] = {"enabled": True, "effort": effort}
        db.execute("insert into sessions values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (sid, model, json.dumps(cfg), None, started, ended, reason, tools, tokens[0], tokens[1], active,
                    "cli", title, *cost, cwd))

    def say(sid, ts, text, role="user"):
        db.execute("insert into messages (session_id, role, content, timestamp) values (?,?,?,?)", (sid, role, text, ts))

    def call(sid, ts, name, args, result='{"success": true}'):
        calls["n"] += 1
        cid = f"c{calls['n']}"
        fn = {"name": name, "arguments": json.dumps(args)}
        db.execute("insert into messages (session_id, role, content, timestamp, tool_calls) values (?,?,?,?,?)",
                   (sid, "assistant", "", ts, json.dumps([{"id": cid, "type": "function", "function": fn}])))
        db.execute("insert into messages (session_id, role, content, timestamp, tool_call_id) values (?,?,?,?,?)",
                   (sid, "tool", result, ts + 0.1, cid))

    def diff(path, start, removed, added):
        body = "".join(f" {line}\n" for line in ("// context",)) + "".join(f"-{r}\n" for r in removed) + \
            "".join(f"+{a}\n" for a in added)
        hunk = f"@@ -{start},{len(removed) + 1} +{start},{len(added) + 1} @@\n"
        return json.dumps({"success": True, "diff": f"--- a/{path}\n+++ b/{path}\n{hunk}{body}"})

    main = SESSION["full"]
    session(main, now - 7200, title="Fleet console polish", cwd=CWD["full"], model="claude-opus-5-5")
    session(SESSION["empty"], now - 600, title="Notes", cwd=CWD["empty"], model="claude-opus-5-5")

    # four runs of workers; the newest is live (12 workers, more than the station's six wings)
    costs = [(0.42, None, "estimated"), (1.25, 1.18, "actual"), (0.0, None, "included"), (0.87, None, "estimated")]
    runs = [(now - 5400, 3), (now - 3600, 4), (now - 1800, 2), (now - 300, 12)]
    live, goal_i, workers = [], 0, {}
    for r, (start, count) in enumerate(runs):
        for i in range(count):
            sid = f"w{r + 1}-{i + 1:02d}"
            goal = GOALS[goal_i % len(GOALS)]
            goal_i += 1
            began = start + i * 0.2
            newest = r == len(runs) - 1
            kind = ("completed" if i < 8 else "failed" if i < 10 else "stopped" if i < 11 else "running") if newest \
                else ("stopped" if (r, i) == (1, 3) else "completed")
            ended = None if kind == "running" else min(now - 5, began + 40 + 23 * i + 61 * r)
            cost = costs[(r + i) % len(costs)] if kind == "completed" else (None, None, None)
            tokens = (12000 + 9000 * i + 31000 * r, 2400 + 700 * i)
            session(sid, began, ended, None if kind == "running" else ("completed" if kind == "completed" else "error"),
                    delegate_from=main, model="claude-sonnet-5" if i % 3 else "claude-opus-5-5",
                    effort=("medium", "high", None)[i % 3], tools=6 + 3 * i, tokens=tokens,
                    active=now - 4 if kind == "running" else None, cost=cost, cwd=CWD["full"])
            say(sid, began, goal)
            if kind == "completed":
                say(sid, ended, ANSWER, role="assistant")
            workers[sid] = (began, ended)
            if newest:
                rec = {
                    "subagent_id": f"sa-{i + 1:02d}", "delegation_id": "dl-live", "depth": 0, "goal": goal,
                    "model": "claude-sonnet-5" if i % 3 else "claude-opus-5-5", "task_index": i, "child_session_id": sid,
                    "status": {"completed": "completed", "failed": "failed", "stopped": "interrupted", "running": "running"}[kind],
                    "started_at": began, "tool_count": 6 + 3 * i, "tokens": sum(tokens),
                }
                if kind != "running":
                    rec.update({"ended_at": ended, "duration_s": ended - began})
                if kind == "completed":
                    rec.update({"summary": ANSWER, "cost_usd": cost[0] or None, "cost_status": cost[2]})
                if kind == "failed":
                    rec["summary"] = "Error: the station scene could not read the theme tokens"
                if kind == "running":
                    rec.update({"last_tool": "patch", "tool_preview": "src/console/fleet.ts"})
                live.append(rec)

    # files: reads, writes, a failed edit; some by workers
    reads = ["src/console/fleet.ts", "src/console/station.ts", "src/console/legend.ts", "src/console/theme.ts",
             "src/console/numbers.ts", "src/console/scroll.ts", "package.json", "README.md", "docs/console.md",
             "src/console/routes.ts"]
    for k, path in enumerate(reads):
        call(main, now - 6900 + k * 3, "read_file", {"path": path})
    for k, path in enumerate(["src/server/queries.sql", "src/server/index.ts", "docs/review.md"]):
        call("w1-02" if k < 2 else "w1-03", workers["w1-02"][0] + 5 + k, "read_file", {"path": path})

    # nine requests with edits; the newest carries fourteen of every kind
    asks = [
        "Add the fleet console's route table to the docs",
        "Index the two slow queries from the load test",
        "Fold the review comments into the console branch",
        "Write the migration notes for the station layout",
        "Stop the corner readouts from being cut at narrow widths",
        "Make the files legend fit beside its cells",
        "Set every number on the fleet page in the code font",
        "Size the scroll lists to whole rows",
        "Polish the console: readouts, legend, numbers, scroll lists and the empty states, then rename the key map",
    ]
    first = now - 6000
    for k, ask in enumerate(asks):
        at = first + k * 420
        say(main, at, ask)
        if k < len(asks) - 1:
            for e in range(1 + k % 3):
                path = f"src/console/part_{k}_{e}.ts"
                call(main, at + 10 + e, "patch", {"path": path, "old_string": "a", "new_string": "b"},
                     result=diff(path, 10 + e, [f"const width = {k}{e}"], [f"const width = {k}{e} + 1", "// fits"]))
            continue
        t = at + 5
        long_old = [f"  readout({n}, 'WORKING', counts.running)" for n in range(9)]
        long_new = [f"  readout({n}, 'WORKING', pad(counts.running))" for n in range(9)] + \
            [f"  // row {n} keeps its value in the code font" for n in range(14)]
        call(main, t, "patch", {"path": "src/console/fleet.ts", "old_string": "x", "new_string": "y"},
             result=diff("src/console/fleet.ts", 40, long_old, long_new))
        call(main, t + 1, "write_file", {"path": "src/console/readouts.ts",
                                         "content": "\n".join(f"export const R{n} = {n}" for n in range(12))})
        call(main, t + 2, "patch", {"path": "src/console/station.ts", "old_string": "x", "new_string": "y"},
             result=diff("src/console/station.ts", 12, ["drawKey(ctx)"], ["if (subs) drawKey(ctx)"]))
        call(main, t + 3, "patch", {"path": "src/console/legend.ts", "old_string": "x", "new_string": "y"},
             result=diff("src/console/legend.ts", 3, ["wrap: false"], ["wrap: true"]))
        call(main, t + 4, "write_file", {"path": "docs/console.md", "content": "# Console\n\nRoutes and readouts.\n"})
        call(main, t + 5, "patch", {"mode": "patch", "patch": (
            "*** Begin Patch\n*** Delete File: src/console/old_grid.ts\n"
            "*** Move File: src/console/keys.ts -> src/console/key_map.ts\n*** End Patch")})
        call(main, t + 6, "patch", {"path": "src/console/log.ts", "old_string": "rows(8)", "new_string": "rows(whole)"},
             result=json.dumps({"error": "old_string not found in src/console/log.ts"}))
        for n, name in enumerate(["theme", "numbers", "scroll", "empty", "routes", "tiles", "picker"]):
            path = f"src/console/{name}.ts"
            call(main, t + 7 + n, "patch", {"path": path, "old_string": "x", "new_string": "y"},
                 result=diff(path, 5 + n, [f"const {name} = old()"], [f"const {name} = next()"]))
        # a worker of this chat edits too
        call("w3-01", t + 20, "write_file", {"path": "src/console/notes.md", "content": "worker notes\nline two"})

    # empty chat: one file read, a request with no edits
    say(SESSION["empty"], now - 590, "What does the notes file say?")
    call(SESSION["empty"], now - 580, "read_file", {"path": "notes.md"})
    db.commit()
    db.close()

    # background commands: one running (this process), finished ones, two failed, one killed
    results = HOME / "logs" / "process-results"

    def receipt(pid, command, started, ended, code, output, reason="exited"):
        path = results / f"{pid}.json"
        path.write_text(json.dumps({
            "id": pid, "command": command, "cwd": CWD["full"], "task_id": "t", "owner_task_id": main,
            "session_key": main, "parent_session_id": main, "started_at": started, "exit_code": code,
            "completion_reason": reason, "termination_source": "", "notify_on_complete": True, "output": output}),
            encoding="utf-8")
        os.utime(path, (ended, ended))

    ok_out = "\n".join(f"ok {n} - console renders case {n}" for n in range(1, 13)) + "\n12 passed"
    jobs = [("npm test", 0, ok_out), ("npm run lint", 0, "0 problems"), ("npm run build", 0, "built in 4.2s"),
            ("git status --short", 0, " M src/console/fleet.ts"), ("python tools/sizes.py", 0, "rows: 8\nlines: 13"),
            ("npm run typecheck", 0, "no errors"), ("node scripts/bench.mjs", 0, "replay 12 ms\nfleet 31 ms")]
    for n, (cmd, code, output) in enumerate(jobs):
        start = now - 5000 + n * 400
        receipt(f"proc_ok{n}", cmd, start, start + 20 + 7 * n, code, output)
    fail_lines = ["Running 48 console checks"] + [f"check {n:02d} passed" for n in range(1, 31)] + [
        "Traceback (most recent call last):", '  File "tools/measure.py", line 88, in <module>',
        "    rows = whole_rows(box)", "ValueError: box height 176 is not a whole number of rows"]
    receipt("proc_fail1", "python tools/measure.py --all", now - 1500, now - 1440, 1, "\n".join(fail_lines))
    receipt("proc_fail2", "npm run e2e -- --grep legend", now - 1200, now - 1150, 2,
            "Error: legend label READ is cut at 560 px\n    at check (e2e/legend.spec.ts:14:9)")
    receipt("proc_kill", "npm run watch", now - 1000, now - 700, None, "watching src/ for changes", reason="killed")
    (HOME / "processes.json").write_text(json.dumps([{
        "session_id": "proc_live", "command": "npm run dev -- --port 5173", "cwd": CWD["full"],
        "pid": os.getpid(), "pid_scope": "host", "started_at": now - 240, "parent_session_id": main,
        "session_key": main}]), encoding="utf-8")
    return {"live": live}


# ── backend ───────────────────────────────────────────────────────────────────────────────────────

def serve(api, HTTPException):
    routes = {name: getattr(api, name) for name in
              ("children", "output", "processes", "process_output", "files", "replay", "replay_step")}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's name
            url = urlparse(self.path)
            fn = routes.get(url.path.rstrip("/").rsplit("/", 1)[-1])
            args = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if fn is None:
                    raise HTTPException(status_code=404, detail="no such route")
                code, body = 200, fn(**args)
            except HTTPException as exc:
                code, body = exc.status_code, {"detail": exc.detail}
            except TypeError as exc:  # a missing or extra query parameter, as FastAPI's 422
                code, body = 422, {"detail": str(exc)}
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # the shot lines are the output
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ── shots ─────────────────────────────────────────────────────────────────────────────────────────

def shot_list(selftest: bool) -> list[dict]:
    if selftest:
        return [{"name": f"selftest-{rule}-{mode}", "tab": "agents", "data": "full", "mode": mode, "width": 915,
                 "state": None, "inject": css, "expect": rule}
                for rule, css in BREAKS.items() for mode in MODES]
    shots = [{"name": f"{tab}-{data}-{mode}-{width}", "tab": tab, "data": data, "mode": mode, "width": width, "state": None}
             for tab in TABS for data in DATA for mode in MODES for width in WIDTHS]
    shots += [{"name": f"{state}-{mode}-{width}", "tab": state.split("-")[0], "data": "full", "mode": mode,
               "width": width, "state": state} for state in STATES for mode in MODES for width in STATE_WIDTHS]
    return shots


def main() -> int:
    selftest = "--selftest" in sys.argv[1:]
    core = env.core_dir()
    if core is None or not core.is_dir():
        fail("no Hermes core found — set HERMES_AGENT_DIR to the hermes-agent checkout")
    electron = env.electron_binary()
    if electron is None or not electron.exists():
        fail("no Electron found — set HERMES_ELECTRON, or install the core's apps/desktop dependencies")
    assets = core / "apps" / "desktop" / "dist" / "assets"
    sheets = sorted(assets.glob("index-*.css"), key=lambda p: p.stat().st_mtime) if assets.is_dir() else []
    if not sheets:
        fail(f"no compiled index-*.css under {assets} — build the core's desktop app")
    tips = sorted(assets.glob("tooltip-*.css"), key=lambda p: p.stat().st_mtime)
    if not (HERE / "node_modules" / "react").is_dir():
        fail("tests/node_modules missing — run npm ci in tests/")

    # Anything of the core this run imports (Hermes' V4A parser, its PID check) resolves its home to the
    # fixture, never to the user's.
    os.environ["HERMES_HOME"] = str(HOME)
    if str(core) not in sys.path:
        sys.path.append(str(core))
    now = time.time()
    fixture = build_fixture(now)
    import plugin_api as api
    from fastapi import HTTPException
    api._db_path = lambda: HOME / "state.db"
    api._checkpoint_path = lambda: HOME / "processes.json"
    api._results_dir = lambda: HOME / "logs" / "process-results"
    server = serve(api, HTTPException)

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    shots = shot_list(selftest)
    config = {
        "api": f"http://127.0.0.1:{server.server_address[1]}", "plugin": str(ROOT / "desktop" / "plugin.js"),
        "nodeModules": str(HERE / "node_modules"), "out": str(OUT), "sheets": [str(sheets[-1])] + [str(t) for t in tips[-1:]],
        "sessions": SESSION, "live": fixture["live"], "shots": shots,
    }
    (OUT / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
    started = time.time()
    run_env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
    proc = subprocess.run([str(electron), str(HERE / "live.cjs"), str(OUT / "config.json")], env=run_env, cwd=HERE)
    server.shutdown()
    report_path = OUT / "report.json"
    if not report_path.is_file():
        fail(f"Electron exited {proc.returncode} without a report")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("fatal"):
        fail(report["fatal"])
    seconds = round(time.time() - started)

    if selftest:
        missed = []
        for shot in report["shots"]:
            rules = sorted({v["rule"] for v in shot["violations"]})
            hit = shot["expect"] in rules
            print(f"{'CAUGHT' if hit else 'MISSED'}  {shot['expect']} [{shot['mode']}] {BREAKS[shot['expect']]}"
                  f"  ->  {', '.join(rules) or 'nothing reported'}")
            if not hit:
                missed.append(shot["name"])
        if missed or len(report["shots"]) != len(shots):
            print(f"LIVE SELFTEST: RED — not caught: {', '.join(missed) or 'shots missing'}")
            return 1
        print(f"LIVE SELFTEST: GREEN — M1–M6 and M8 each caught in dark and light ({len(shots)} shots, {seconds} s)")
        return 0

    violations = []
    for shot in report["shots"]:
        print(f"{shot['name']:<34} {shot['height']:>6} px  {len(shot['violations'])} violation(s)")
        violations += [f"{shot['name']}  {v['rule']}  {v['sel']}  [{v['text']}]  {v.get('detail', '')}" for v in shot["violations"]]
    if len(report["shots"]) != len(shots):
        violations.append(f"{len(shots) - len(report['shots'])} shot(s) were not taken")
    if violations:
        print(f"LIVE: RED ({len(violations)} violation(s))")
        for line in violations:
            print(f"  {line}")
        return 1
    print(f"LIVE: GREEN — {len(shots)} shots, 0 violations, {seconds} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
