"""Canary run for subagent-watch: every lock is broken once and the gate that owns it must go red.

Why: a test that passes is only evidence when it is also known to FAIL on the bug it is named
after. The notes used to say "mutation canaries were run by hand"; this is that list, repeatable.
Each mutation is applied to a COPY of the panel (the repo is never edited) and the owning gate is
run against the copy:

  render    tests/render_check.mjs <copy of plugin.js>      (behaviour: scoping, marks, failures)
  backend   tests/check_api.py  with the copy's plugin_api  (read-only, lineage, statuses, 403s)
  audit     tests/audit_static.py over the copied tree      (i18n, a11y, colours, silent catches)

Run: python canary_audit.py        (exit 0 = every mutation caught, the repo untouched)
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
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
    ("render", JS, "const time = w.status === 'stopped' ? '—' : fmtDuration(w.duration_s)",
     "const time = fmtDuration(w.duration_s ?? 1)", "a stopped worker shows a duration"),
    ("render", JS, "if (alive && fails.current >= MAX_POLL_FAILS) setError(String(err?.message || err))", "",
     "failed live polls are swallowed"),
    ("render", JS, "`/output?session_id=${encodeURIComponent(sid)}`", "`/output?session_id=c-b`",
     "copy reads another worker's output"),
    ("render", JS, ".filter(b => !(live.batches.length && b.workers.some(w => w.status === 'running')))", "",
     "a running batch is repeated under Earlier"),
    ("render", JS, "    if (next.has(key)) next.delete(key)\n    else next.add(key)\n    return next",
     "    return next.has(key) ? new Set() : new Set([key])", "opening one card folds the others"),
    ("render", JS, "p.status === 'stopped' ? '—' : fmtDuration(p.duration_s)", "fmtDuration(p.duration_s)",
     "a killed command shows a duration"),
    ("render", JS, "err => alive && setOut({ loading: false, data: null, error: String(err?.message || err) })",
     "() => alive && setOut({ loading: false, data: null, error: null })", "a failed output read is swallowed"),
    ("render", JS, "process_id=${encodeURIComponent(p.id)}`", "process_id=proc_ok`",
     "a command's output is read for the wrong process"),
    ("render", JS, "    clearBatches()\n    clearWorkers()\n    clearProcs()\n", "",
     "switching chats keeps the old chat's cards open"),
    # ── backend: plugin_api.py ──────────────────────────────────────────────────────────────
    ("backend", PY, "?mode=ro", "?mode=rw", "state.db is opened writable"),
    ("backend", PY, "or entry.get(\"parent_session_id\") not in owners", "",
     "another chat's running commands are listed"),
    ("backend", PY, "if record.get(\"parent_session_id\") not in owners:\n            continue", "if False:\n            continue",
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
    ("backend", PY, "if final:\n        status = \"completed\"", "if True:\n        status = \"completed\"",
     "a worker closed without an answer reads as completed"),
    # ── audit: the static rules ─────────────────────────────────────────────────────────────
    ("audit", JS, "t('sw.refresh')", "t('sw.refreshNow')", "i18n: a key missing from the bundle"),
    ("audit", JS, "stopped: 'Stopped — closed before it finished'", "halted: 'Stopped'",
     "i18n: a template leaf the page can ask for"),
    ("audit", JS, "'aria-label': label, disabled", "disabled", "iconLabel: an icon button without a name"),
    ("audit", JS, "'data-st': p.status, 'aria-expanded': false,", "'data-st': p.status,",
     "expanded: an accordion row without aria-expanded"),
    ("audit", JS, "const GLYPH_INK = 'var(--dt-destructive-foreground)'", "const GLYPH_INK = '#fff'",
     "hexColor: a hard-coded colour"),
    ("audit", JS, ".sw-px{font-size:11px;color:var(--ui-text-secondary)", ".sw-px{font-size:11px;color:var(--ui-red)",
     "toneInk: a tone used as text ink (the 3.3:1 exit code)"),
    ("audit", JS, "className: 'sw-more', onClick", "className: 'sw-more', title: 'more', onClick",
     "nativeTitle: a native tooltip"),
    ("audit", JS, "console.warn(`[${ID}] openSession failed`, err)\n      onToast(String(err?.message || err), true)", "void err",
     "silentCatch: a page catch that hides the error"),
    ("audit", PY, "        except FileNotFoundError:\n            continue", "        except OSError:\n            continue",
     "silentCatch: a backend except that hides every error"),
    ("audit", PY, "@router.get(\"/output\")", "@router.post(\"/output\")", "readOnly: a writing route"),
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
        for n, (gate, rel, old, new, what) in enumerate(MUTATIONS, 1):
            tree = Path(tmp) / f"m{n}"
            _copy_panel(tree)
            path = tree / rel
            text = path.read_text(encoding="utf-8")
            if old not in text:
                print(f"FAIL  #{n:02d} {what}: anchor not found — the mutation could not be applied")
                failures.append(what)
                continue
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
            code, out = _run(gate, tree)
            caught = code != 0
            fired = next((line.strip() for line in out.splitlines()
                          if line.startswith(("FAIL", "PROBLEM"))), f"exit {code}")
            print(f"{'OK  ' if caught else 'FAIL'}  #{n:02d} [{gate}] {what}  ->  {fired[:110]}")
            if not caught:
                failures.append(what)
            shutil.rmtree(tree, ignore_errors=True)
    untouched = _sha_tree(ROOT) == before
    if not untouched:
        failures.append("the repo's own files changed during the run")
    print(f"\ncanary: {len(MUTATIONS) - len(failures)}/{len(MUTATIONS)} caught · repo untouched {untouched}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
