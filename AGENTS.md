# AGENTS.md — subagent-watch

Rules for anyone (person or coding agent) changing this repository. Build, test and release steps
are in `README.md`; the design notes are in `Docs/subagent-watch-notes.md`.

## `main` changes only through a green pull request

- Never push to `main` directly. Commit on a branch, push the branch, open a pull request.
- Merge only when every CI check on the pull request is green (`gh pr checks <n>`). A red or
  pending check blocks the merge, including a failure that looks unrelated to the change: fix it or
  report it, do not merge past it.
- Why: GitHub cannot enforce this here (branch protection and rulesets need GitHub Pro on a private
  repository), so the rule is the only guard. 1.1.9 was pushed straight to `main` and left it red:
  canary #12 had stopped applying and nobody saw it until the next change.
- After a merge, check that the `push` run on `main` is green too.

## Fresh checkout: setup and validation

Every command runs from `tests/`. Setup once per checkout:

```bash
python -m pip install "fastapi==0.115.*" "psutil==7.2.2"   # or use the Hermes core's venv (HERMES_PYTHON)
npm ci
```

Validation, in this order (all must pass; what each asserts is in its file header):

```bash
python check_api.py            # backend against a fixture state.db
node render_check.mjs          # jsdom + real React, driven like a user
python audit_static.py         # i18n, a11y, colours, silent catches, read-only backend, release rules
python contract_core.py && python contract_core.py --selftest   # the core APIs the panel reads still exist
python release_gate.py         # version / changelog / installed-copy rules each fire
python canary_audit.py         # every lock must turn its gate red when broken (slow: run last)
```

Outside the user's own checkout (a worktree, an agent run, CI), set `HERMES_HOME` to an empty temporary
folder before the gates. Without it, `audit_static.py` compares `desktop/plugin.js` against the
user's installed copy of the panel and fails on any change; never copy a work-in-progress file into
the user's install to silence it — that changes the app he is using.

There is no dev server. The panel renders inside the Hermes desktop app; `node preview.mjs` builds a
jsdom preview, and the measured Electron render needs the core's Electron (`HERMES_ELECTRON`).
