"""Canary run for subagent-watch: every lock is broken once and the gate that owns it must go red.

Why: a test that passes is only evidence when it is also known to FAIL on the bug it is named
after. The notes used to say "mutation canaries were run by hand"; this is that list, repeatable.
Each mutation is applied to a COPY of the panel (the repo is never edited) and the owning gate is
run against the copy:

  render    tests/render_check.mjs <copy of plugin.js>      (behaviour: scoping, marks, failures)
  backend   tests/check_api.py  with the copy's plugin_api  (read-only, lineage, statuses, 403s)
  audit     tests/audit_static.py over the copied tree      (i18n, a11y, colours, silent catches)

Run: python canary_audit.py        (exit 0 = every mutation caught, the repo untouched)

Mutations run in parallel (`SW_CANARY_JOBS`, default 8): a render run mostly waits on poll timers,
and one at a time the list outgrew the CI job's time limit.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JS = "desktop/plugin.js"
PY = "dashboard/plugin_api.py"

# (gate, file, old, new, what the mutation breaks)
MUTATIONS = [
    # ── render: the page ────────────────────────────────────────────────────────────────────
    ("render", JS, "if (event?.session_id !== runtimeId) return", "",
     "events of another chat are no longer filtered out"),
    ("render", JS, "queued: 'queued', running", "queued: 'completed', running",
     "a queued worker is drawn as done"),
    ("render", JS, "failed: 'failed', error: 'failed'", "failed: 'failed', error: 'completed'",
     "an errored worker is drawn as done"),
    ("render", JS, "const time = w.status === 'stopped' ? '—' : fmtDuration(w.duration_s, t)",
     "const time = fmtDuration(w.duration_s ?? 1, t)", "a stopped worker shows a duration"),
    ("render", JS, "        if (fails.current >= MAX_POLL_FAILS) setError(String(err?.message || err))", "",
     "failed live polls are swallowed"),
    ("render", JS, "&worker_id=${encodeURIComponent(sid)}`", "&worker_id=c-b`",
     "copy reads another worker's output"),
    ("render", JS, "/output?session_id=${encodeURIComponent(storedId || '')}", "/output?session_id=",
     "copy output no longer names the chat it is read for"),
    ("render", JS, "    fails.current = 0\n    setError(null)\n    void pollRef.current?.()", "    void 0",
     "Refresh does not restart live polling that gave up"),
    ("render", JS, "    ok = await ctxRef.os.writeClipboard(text)\n  } catch (err) {\n    console.warn(`[${ID}] clipboard write failed`, err)\n  }",
     "    ok = await ctxRef.os.writeClipboard(text)\n  } finally {}", "a clipboard rejection escapes the copy button"),
    ("render", JS, "nBatches: n => `${n} batch${n === 1 ? '' : 'es'}`", "nBatches: n => `${n} batches`",
     "'1 batches'"),
    ("render", JS, "value: procs.error ? '—' : procRows.length", "value: procRows.length",
     "a failed count reads 0 like real data"),
    ("render", JS, "  const past = stored\n    .filter(b => !isLiveStored(b))\n", "  const past = stored\n",
     "a running batch is repeated under Earlier"),
    ("render", JS, "    if (next.has(key)) next.delete(key)\n    else next.add(key)\n    return next",
     "    return next.has(key) ? new Set() : new Set([key])", "opening one card folds the others"),
    ("render", JS, "p.status === 'stopped' ? '—' : fmtDuration(p.duration_s, t)", "fmtDuration(p.duration_s, t)",
     "a killed command shows a duration"),
    ("render", JS, "err => alive && setOut({ loading: false, data: null, error: String(err?.message || err) })",
     "() => alive && setOut({ loading: false, data: null, error: null })", "a failed output read is swallowed"),
    ("render", JS, "process_id=${encodeURIComponent(p.id)}`", "process_id=proc_ok`",
     "a command's output is read for the wrong process"),
    ("render", JS, "    clearBatches()\n    clearWorkers()\n    clearProcs()\n", "",
     "switching chats keeps the old chat's cards open"),
    ("render", JS, "b.started_at >= liveFrom && ", "", "a crashed running batch is hidden while a live tree shows"),
    ("render", JS, "{ key: storedId, data: null, error: null, loading: true }", "{ ...prev, key: storedId, data: null, loading: true }",
     "a chat switch carries the previous chat's history error"),
    ("render", JS, "            if (gone.current.has(r.subagent_id)) continue\n", "",
     "a finished batch still listed by subagent.list is re-added"),
    ("render", JS, "statuses.length > 1 ? jsx('span', { className: 'sw-bmore'", "false ? jsx('span', { className: 'sw-bmore'",
     "a batch of several workers is labelled as its first worker alone"),
    ("render", JS, "  if (!rows.length && !unreadable && !procs.loading) return null", "  if (!rows.length && !unreadable) return null",
     "background commands have no loading state"),
    ("render", JS, "body = jsx('p', { className: 'sw-hint', children: t('sw.err.hint') })", "body = null",
     "the all-failed view is blank"),
    ("render", JS, "'aria-busy': busy ? 'true' : undefined,", "", "copy has no busy state"),
    ("render", JS, "            className: 'sw-live', role: 'status', 'aria-live': 'polite',", "            className: 'sw-live',",
     "the toast live region is not a status region"),
    ("render", JS, "  if (words.length < 2 || words.join(' ').length < 12) return names", "  return names",
     "sibling names sharing a prefix stay identical at 380 px"),
    ("render", JS, "return m && effort ? `${m} · ${effort}` : m", "return m",
     "the model chip drops the reasoning effort"),
    ("render", JS, "white-space:nowrap;flex:0 0 auto}", "white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
     "the model chip shrinks to an unreadable stub"),
    ("render", JS, "label: t('sw.modelTip', String(model), effort)", "label: ''",
     "the model chip has no tooltip with the full model id and effort"),
    ("render", JS, "      held.current = heldBy(event.target, pageRef.current)", "      held.current = false",
     "a click inside the panel moves it to the app's main chat"),
    ("render", JS, "  return HOLD_PANES.some(p => pane.startsWith(p))", "  return false",
     "a click on another page's tab moves the panel to the app's main chat"),
    ("render", JS, "    return ctxRef.setTimeout(() => {\n      if (!held.current)", "    return ((fn) => fn())(() => {\n      if (!held.current)",
     "the follow runs before the click is classified (the app's own listener fires first)"),
    # ── render: 1.3.0 locks ──────────────────────────────────────────────────────────────────
    ("render", JS, "            if (r.status === 'queued' && at - (r.queued_at ?? at) < QUEUE_GRACE_S) {", "            if (false) {",
     "a queued worker Hermes has not listed yet reads stopped"),
    ("render", JS, "const status = TERMINAL.has(had?.status) ? had.status : (STATUS_OF[r.status] || r.status)",
     "const status = STATUS_OF[r.status] || r.status", "a stale subagent.list snapshot revives a finished worker"),
    ("render", JS, "    return ctxRef.rest(`/children?session_id=", "    ctxRef.rest(`/children?session_id=",
     "a finished batch leaves Now before history has it (the empty state flashes)"),
    ("render", JS, "        if (!alive) return // a poll of the chat the page has left: its failure is not this chat's\n", "",
     "a failed poll of the chat the page left counts against the new chat"),
    ("render", JS, "  return jsxs('div', {\n    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': st,",
     "  return jsxs(open ? 'section' : 'div', {\n    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': st,",
     "toggling an Earlier batch remounts its header and drops focus"),
    ("render", JS, "  return jsxs('div', {\n    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': p.status,",
     "  return jsxs(open ? 'section' : 'div', {\n    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': p.status,",
     "toggling a command row remounts it and drops focus"),
    ("render", JS, "    header.focus()\n", "", "focus does not follow a finished batch to Earlier"),
    ("render", JS, "      if (opened.length) addWorkers(opened)\n", "", "an open worker detail is lost when its batch finishes"),
    ("render", JS, "const fetches = p.status !== 'running' && p.has_output !== false", "const fetches = p.status !== 'running'",
     "a command with no receipt asks for output and shows a 404"),
    ("render", JS, "    cut ? t('sw.proc.commandCut', command.length) : ''", "    ''", "a cut command does not say it is cut"),
    ("render", JS, "  if (!text) return onToast(t('sw.nothingToCopy'), true)\n", "", "copying an empty output reads Copied"),
    ("render", JS, "const headState = errors.length ? 'failed' : runningN || procsRunning ? 'running' : 'idle'",
     "const headState = runningN || procsRunning ? 'running' : 'completed'", "the header reads green when every read failed"),
    ("render", JS, "t('sw.running', runningN, procsRunning)", "t('sw.running', runningN, 0)", "the running pill ignores running commands"),
    ("render", JS, "jsx('span', { className: 'sw-chatn', children: chatName }, 'n'),", "null,", "the header does not name the watched chat"),
    ("render", JS, "watched.held ? jsx(Tip", "false ? jsx(Tip", "a held chat is not marked as held"),
    ("render", JS, ".sw-acc[data-st=running]::after,.sw-acc[data-st=failed]::after{content", ".sw-acc::after{content",
     "every card carries the status rail again"),
    ("render", JS, "label: t('sw.retry')", "label: t('sw.refresh')", "the alert has no Try again button"),
    ("render", JS, "p.status !== 'failed' && p.exit_code", "p.exit_code", "an opened failed command repeats its exit code"),
    ("render", JS, " .sw-panel .sw-bl .sw-bc{margin-left:auto}", "", "below 420 px counts lose their right-hand column"),
    ("render", JS, "className: 'sw-mk', 'data-st': 'failed', 'aria-hidden'", "className: 'sw-mk', 'data-st': 'stopped', 'aria-hidden'",
     "unreadable records lose their failed mark"),
    # ── backend: plugin_api.py ──────────────────────────────────────────────────────────────
    ("backend", PY, "?mode=ro", "?mode=rw", "state.db is opened writable"),
    ("backend", PY, "or not _owned(entry, owners)", "",
     "another chat's running commands are listed"),
    ("backend", PY, "if not _owned(record, owners):\n            continue", "if False:\n            continue",
     "another chat's finished commands are listed"),
    ("backend", PY, "if record.get(\"completion_reason\") == \"killed\":\n        return \"stopped\"", "",
     "a killed command reads as failed"),
    ("backend", PY, "return \"completed\" if record.get(\"exit_code\") == 0 else \"failed\"", "return \"completed\"",
     "a non-zero exit reads as completed"),
    ("backend", PY, "\"status\": \"running\" if alive else \"stopped\"", "\"status\": \"running\"",
     "a dead checkpoint PID reads as running"),
    ("backend", PY, "            unreadable += 1\n            continue\n", "            continue\n",
     "unreadable receipts are hidden"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"process belongs to another conversation\")", "pass",
     "a command's output is served to another chat"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"not a delegated worker session\")", "pass",
     "/output serves any session"),
    ("backend", PY, "elif final:\n        status = \"completed\"", "elif True:\n        status = \"completed\"",
     "a worker closed without an answer reads as completed"),
    ("backend", PY, "    elif ended is None:\n        status = \"running\"\n    elif final:", "    elif final:\n        status = \"completed\"\n    elif ended is None:",
     "a running worker that already wrote text reads as completed"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"worker belongs to another conversation\")", "pass",
     "/output serves another chat's worker"),
    ("backend", PY, "    except Exception as exc:  # noqa: BLE001 - a private core API", "    except ImportError as exc:  # noqa: BLE001 - a private core API",
     "a changed liveness API becomes a 500"),
    ("backend", PY, "    if ended is None and now - _last_seen(conn, row) > STALE_S:", "    if False:",
     "a crashed worker reads running forever"),
    ("backend", PY, "        return False\n\n\ndef _read_running", "        return True\n\n\ndef _read_running",
     "liveness fails open: a process nobody can check reads running"),
    ("backend", PY, "detail=\"state.db not found in this Hermes home\"", "detail=f\"state.db not found: {path}\"",
     "the 503 prints the absolute state.db path"),
    ("backend", PY, "    with closing(_connect()) as conn:\n        return list_children", "    with _connect() as conn:\n        return list_children",
     "a route leaves its state.db connection open"),
    ("backend", PY, 'detail=f"{what} unreadable ({type(exc).__name__})"', 'detail=f"{what} unreadable: {exc}"',
     "a 503 prints the exception text with its absolute path"),
    ("backend", PY, "\"effort\": _effort(row[\"model_config\"]),", "\"effort\": None,",
     "a worker's reasoning effort is not reported"),
    ("backend", PY, "reasoning.get(\"enabled\") is False", "False",
     "a disabled reasoning config still reports an effort"),
    # ── backend: 1.3.0 locks ─────────────────────────────────────────────────────────────────
    ("backend", PY, "    if row[\"source\"] == \"tool\":\n        return True\n", "", "a tool child is taken as a compression continuation"),
    ("backend", PY, "markers = [cfg.get(\"_branched_from\"), cfg.get(\"_delegate_from\")]", "markers = [cfg.get(\"_delegate_from\")]",
     "a /branch is taken as its source chat's continuation"),
    ("backend", PY, "        markers.append(cfg.get(\"_reset_from\"))", "        pass", "a reset fork is taken as a continuation"),
    ("backend", PY, "        if _is_continuation(conn, row):\n            continue", "        if False:\n            continue",
     "a worker compressed mid-run is listed twice"),
    ("backend", PY, "    tip = _chain(conn, row)[-1][\"id\"]", "    tip = child_id", "a compressed worker's output is its interim note"),
    ("backend", PY, "\"tool_calls\": sum(r[\"tool_call_count\"] or 0 for r in chain),", "\"tool_calls\": root[\"tool_call_count\"] or 0,",
     "a compressed worker counts only its first half's tools"),
    ("backend", PY, "    entries = [e for e in data if isinstance(e, dict)]", "    entries = data",
     "a non-object checkpoint entry becomes a 500"),
    ("backend", PY, "    return isinstance(parent, str) and parent in owners", "    return parent in owners",
     "a list-valued owner becomes a 500"),
    ("backend", PY, "\"started_at\": started, \"ended_at\": mtime,", "\"started_at\": record.get(\"started_at\"), \"ended_at\": mtime,",
     "a text started_at is passed through (and breaks the sort)"),
    ("backend", PY, "        if not isinstance(record, dict):\n            raise ValueError", "        if False:\n            raise ValueError",
     "a receipt that is a JSON list becomes a 500 on /process_output"),
    ("backend", PY, "\"has_output\": False,", "\"has_output\": True,", "a checkpoint-only row claims it has output"),
    ("backend", PY, "\"title\": _title(conn, ids),", "\"title\": None,", "/children does not name the conversation"),
    # ── audit: the static rules ─────────────────────────────────────────────────────────────
    ("audit", JS, "t('sw.refresh')", "t('sw.refreshNow')", "i18n: a key missing from the bundle"),
    ("audit", JS, "t(busy ? 'sw.copying' : 'sw.copy')", "t(busy ? 'sw.copyingNow' : 'sw.copy')",
     "i18n: a key picked by a ternary is missing from the bundle"),
    ("audit", JS, "stopped: 'Stopped — closed before it finished'", "halted: 'Stopped'",
     "i18n: a template leaf the page can ask for"),
    ("audit", JS, "'aria-label': label, 'aria-busy'", "'aria-busy'", "iconLabel: an icon button without a name"),
    ("audit", JS, "'data-st': p.status,\n        'aria-expanded': open,", "'data-st': p.status,",
     "expanded: an accordion row without aria-expanded"),
    ("audit", JS, "const GLYPH_INK = 'var(--dt-background)'", "const GLYPH_INK = '#fff'",
     "hexColor: a hard-coded colour"),
    ("audit", JS, "box-shadow:var(--shadow-sm);--sw-tint", "box-shadow:0 2px 8px rgb(0 0 0 / .22);--sw-tint",
     "hexColor: a hard-coded rgb() shadow"),
    ("audit", JS, ".sw-px{font-size:11.5px;color:var(--ui-text-secondary)", ".sw-px{font-size:11.5px;color:var(--ui-red)",
     "toneInk: a tone used as text ink (the 3.3:1 exit code)"),
    ("audit", JS, "className: 'sw-more', onClick", "className: 'sw-more', title: 'more', onClick",
     "nativeTitle: a native tooltip"),
    ("audit", JS, "console.warn(`[${ID}] openSession failed`, err)\n      onToast(String(err?.message || err), true)", "void err",
     "silentCatch: a page catch that hides the error"),
    ("audit", PY, "        except FileNotFoundError:\n            continue", "        except OSError:\n            continue",
     "silentCatch: a backend except that hides every error"),
    ("audit", PY, "@router.get(\"/output\")", "@router.post(\"/output\")", "readOnly: a writing route"),
    ("audit", JS, "'data-st': st, role: 'img', 'aria-label': name,", "'data-st': st, role: 'img',",
     "markName: a status mark without an accessible name"),
    ("audit", JS, "className: 'sw-stat', role: 'img', 'aria-label': label,", "className: 'sw-stat', role: 'img',",
     "markName: a header count without an accessible name"),
]


def _sha_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for rel in (JS, PY):
        digest.update((root / rel).read_bytes())
    return digest.hexdigest()


def _copy_panel(dest: Path) -> None:
    for rel in ("desktop", "dashboard", "plugin.yaml", "CHANGELOG.md"):
        src = ROOT / rel
        if src.is_dir():
            shutil.copytree(src, dest / rel, ignore=shutil.ignore_patterns("__pycache__"))
        else:
            shutil.copy2(src, dest / rel)
    (dest / "tests").mkdir()
    for name in ("audit_static.py", "release_gate.py", "env.py", "check_api.py"):
        shutil.copy2(HERE / name, dest / "tests" / name)


def _run(gate: str, tree: Path) -> tuple[int, str]:
    run_env = dict(os.environ)
    if gate == "render":
        run_env["SW_RENDER_OUT"] = f"canary-{tree.name}"  # its own build folder, under tests/.out/
        cmd, cwd = ["node", "render_check.mjs", str(tree / JS).replace("\\", "/")], HERE
    elif gate == "backend":
        cmd, cwd = [sys.executable, str(tree / "tests" / "check_api.py")], tree / "tests"
    else:
        # A copy has no installed twin of its own; point the release gate at an empty home.
        run_env["HERMES_HOME"] = str(tree / "_no_home")
        cmd, cwd = [sys.executable, str(tree / "tests" / "audit_static.py")], tree / "tests"
    proc = subprocess.run(cmd, cwd=cwd, env=run_env, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    before = _sha_tree(ROOT)
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="sw-canary-") as tmp:
        base = Path(tmp) / "clean"
        _copy_panel(base)
        for gate in ("render", "backend", "audit"):
            code, out = _run(gate, base)
            if code != 0:
                print(f"the {gate} gate is not green on the unmutated copy (exit {code}):\n{out[-2000:]}")
                return 1
        def one(n: int, gate: str, rel: str, old: str, new: str, what: str) -> tuple[bool, str]:
            tree = Path(tmp) / f"m{n}"
            _copy_panel(tree)
            path = tree / rel
            text = path.read_text(encoding="utf-8")
            if old not in text:
                return False, f"FAIL  #{n:02d} {what}: anchor not found — the mutation could not be applied"
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
            try:
                code, out = _run(gate, tree)
            finally:
                shutil.rmtree(tree, ignore_errors=True)
                shutil.rmtree(HERE / ".out" / f"canary-{tree.name}", ignore_errors=True)
            caught = code != 0
            fired = next((line.strip() for line in out.splitlines()
                          if line.startswith(("FAIL", "PROBLEM"))), f"exit {code}")
            return caught, f"{'OK  ' if caught else 'FAIL'}  #{n:02d} [{gate}] {what}  ->  {fired[:110]}"

        jobs = max(1, int(os.environ.get("SW_CANARY_JOBS", "8")))
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            runs = [pool.submit(one, n, *m) for n, m in enumerate(MUTATIONS, 1)]
            for (*_, what), run in zip(MUTATIONS, runs):  # printed in list order
                caught, line = run.result()
                print(line, flush=True)
                if not caught:
                    failures.append(what)
    untouched = _sha_tree(ROOT) == before
    if not untouched:
        failures.append("the repo's own files changed during the run")
    print(f"\ncanary: {len(MUTATIONS) - len(failures)}/{len(MUTATIONS)} caught · repo untouched {untouched}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
