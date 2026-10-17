# AGENTS.md — agent-station

Rules for anyone (person or coding agent) changing this repository. Build, test and release steps
are in `README.md`; the design notes are in `Docs/agent-station-notes.md`.

## `main` changes only through a green pull request

- Never push to `main` directly. Commit on a branch, push the branch, open a pull request.
- Merge only when every CI check on the pull request is green (`gh pr checks <n>`). A red or
  pending check blocks the merge, including a failure that looks unrelated to the change: fix it or
  report it, do not merge past it.
- Why: GitHub cannot enforce this here (branch protection and rulesets need GitHub Pro on a private
  repository), so the rule is the only guard. 1.1.9 was pushed straight to `main` and left it red:
  canary #12 had stopped applying and nobody saw it until the next change.
- After a merge, check that the `push` run on `main` is green too.
- `.github/workflows/newest-core.yml` checks the panel against the newest Hermes core (latest release
  and `main`) every week. `ci.yml` pins the oldest supported core: `plugin.yaml` `requires_hermes`,
  the README's supported range and `ci.yml` `CORE_SHA` move together.

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

## Looking at the UI

There is no dev server: the panel renders inside the Hermes desktop app. People and reviewers look at
the UI through the real-render harness, which draws the real `desktop/plugin.js` with real React, the
canvas scenes and the app's compiled stylesheet in the core's own Electron, on fixture data:

```bash
python live.py              # 56 shots; last line "LIVE: GREEN — 56 shots, 0 violations, …" or RED with each violation
python live.py --selftest   # breaks each measured rule (M1–M6) once with injected CSS; GREEN = each was caught
```

- Prerequisites: `npm ci` in `tests/`, fastapi (as for `check_api.py`) and a built Hermes core. The
  core is found like the other gates do; with `HERMES_HOME` set to an empty temporary folder, set
  `HERMES_AGENT_DIR` to the core checkout (or `HERMES_ELECTRON` to its Electron binary). Without
  either it exits 1 and says what it could not find.
- Output, git-ignored: `tests/.out/live/<tab>-<data>-<mode>-<width>.png` (tab agents|commands|replay,
  data full|empty, mode dark|light, width 915|560|380, plus opened states such as `agents-detail`),
  each also cut into 560 px bands with 40 px overlap under `bands/`, and every measurement in
  `report.json`. What each rule measures is in the header of `live.py`.
- It runs on a synthetic fixture home under `tests/.out/live_home/` only. It never reads or writes the
  user's Hermes home or the installed panel, and has no switch to do so.

`node preview.mjs` still builds the jsdom preview that `shot.cjs` checks for contrast.
