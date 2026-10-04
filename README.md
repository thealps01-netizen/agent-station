# Subagent Watch

A Hermes **Desktop** plugin. A read-only page for the `delegate_task` workers of the focused chat —
the running batch as a live tree, earlier batches as a list, each worker's full output on demand —
plus the chat's background shell commands (`terminal(background=true)`), running and finished.

Plugin id `subagent-watch` · label **Subagents** · route `/subagent-watch` · MIT.

**Read `Docs/subagent-watch-notes.md` before changing anything** — it holds where every number on the
page comes from and why each status rule is what it is.

## Screenshots

![Subagent Watch — preview.png](tests/preview.png)

## Install

Use **Capabilities → Plugins** in Hermes Desktop and install the unified package from
`https://github.com/thealps01-netizen/subagent-watch`. Pin the verified 40-character source revision in the installer's advanced
options, then enable the package's backend and desktop contribution. Keep existing enable decisions
when updating. The package is independent of the other Attention Desk panels.

The host installer and materializer own the desktop copy. Do not edit or manually copy installed
files. Python route updates require an application/backend restart; save active work first.
Panel state is stored under the active Hermes home and is retained on reinstall.
## Backend

`GET /children` · `GET /output` · `GET /processes` · `GET /process_output` — all read-only.

`state.db` is opened with SQLite `mode=ro`, so the handle cannot write; the process list reads the
files Hermes writes itself (`processes.json`, `logs/process-results/`). A session or process that
belongs to another chat is refused with 403. The static audit fails if a writing route or a file
write ever appears in the backend.

## Gates

Run from `tests/` after `npm ci`. What each lock asserts is in the header of its file.

```bash
python check_api.py                 # backend against a fixture state.db   (--live: this home's too)
node render_check.mjs               # jsdom + real React, driven like a user
python audit_static.py              # i18n, a11y, colours, silent catches, read-only backend, release
python contract_core.py             # everything read from the core still exists (--selftest)
python release_gate.py              # version / changelog / installed copy rules each fire
python canary_audit.py              # 63 mutations, each must turn its gate red
node preview.mjs && <electron> shot.cjs preview.html preview.png   # 5 frames (380 px, 480 px) + WCAG / overflow / overlap gate
```

A rule that has never failed is not evidence: `canary_audit.py`, `release_gate.py` and
`contract_core.py --selftest` break every rule once and require the gate to name it.

## Portability

| Variable | Default | What it points at |
|---|---|---|
| `HERMES_HOME` | `%LOCALAPPDATA%\hermes`, else `~/.hermes` | the install root (state.db, the installed desktop copy) |
| `HERMES_AGENT_DIR` | `<HERMES_HOME>/hermes-agent` when present | the core checkout — contract sources, compiled stylesheet |
| `HERMES_PYTHON` | the core's venv, else the running interpreter | the interpreter with fastapi for `check_api.py` |
| `HERMES_ELECTRON` | the core's `apps/desktop/node_modules/electron` | the binary for the measured render gate |

`python env.py` prints what a run resolved. A missing core is named (`no Hermes core found`), never
silently passed.

## Continuous integration

`.github/workflows/ci.yml` runs the backend check, the static audit, the core contract (and its
selftest), the release gate, the jsdom render check and the canary run on Ubuntu and Windows, against
a sparse checkout of the core pinned at `CORE_SHA`. The measured Electron render needs a built app
and stays local — run it before a release.

It runs once per pull request (a newer commit cancels the older run) and on every push to `main`;
Actions → CI → "Run workflow" runs it by hand. `main` has no GitHub-enforced protection (branch
protection needs GitHub Pro on a private repo), so the rule lives in `AGENTS.md`: every change reaches
`main` through a pull request whose CI is green.

## Compatibility and rollback

CI source contracts are pinned to `54718306e348dbf62ab18a256cb8299615cc0493` and
`fd1a93d319044a6780e8aa95ec9ae1c0cf862ba0` on Windows and Ubuntu. The built runtime smoke target is the latter revision.
Other host builds are unverified; this is not a version-wide compatibility guarantee.

PID registry: missing/disabled/old API fixtures use optional psutil; with neither source available, log the failure and read stopped. No sibling plugin is required.

Time/goal reconciliation is a fallback, not an exact durable worker-identity guarantee. If the host PID-identity API is absent, optional psutil can only test PID existence.

Rollback uses the existing installer at `34b90b6190a19b68981fe2eb32c329dd71f6764b`. Do not delete panel state,
change a shared engine, or replace the delivery classifier as part of a rollback.

## Versioning

`plugin.yaml` is the source; `dashboard/manifest.json` and the top `CHANGELOG.md` heading must match.
Release checklist: bump the three, run every gate, verify the host-materialized desktop copy, then tag.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Muhammed Enes Alpler.
