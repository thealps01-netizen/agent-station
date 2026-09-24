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

`HERMES_HOME` is the install root: `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` otherwise.

```bash
git clone <this repository> "$HERMES_HOME/plugins/subagent-watch"
hermes plugins enable subagent-watch
```

The **Desktop** page loads a *copy* of the panel, not the file in `plugins/`:

```bash
mkdir -p "$HERMES_HOME/desktop-plugins/subagent-watch"
cp "$HERMES_HOME/plugins/subagent-watch/desktop/plugin.js" "$HERMES_HOME/desktop-plugins/subagent-watch/plugin.js"
```

Restart the desktop app (nav items and routes register at load). Every edit to `desktop/plugin.js`
needs the copy step repeated — the release gate fails when the two drift apart.

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
python canary_audit.py              # 32 mutations, each must turn its gate red
node preview.mjs && <electron> shot.cjs preview.html preview.png   # 4 frames (one 380 px) + WCAG / overflow / overlap gate
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

## Versioning

`plugin.yaml` is the source; `dashboard/manifest.json` and the top `CHANGELOG.md` heading must match.
Release checklist: bump the three, run every gate, re-copy the desktop panel, then tag.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Muhammed Enes Alpler.
