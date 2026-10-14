# Subagent Watch

A Hermes **Desktop** plugin. A read-only page for the `delegate_task` workers of the focused chat, in
a **Terminal** look laid out as a mission-control HUD (raised panels on hairlines, a light grey mono, one accent; every colour comes from the Hermes theme you picked). The agents are drawn as a wireframe
space station, live on a canvas: the main agent is a ring station turning in thin lines, each subagent a module on its rim that
says how it is doing (working pulses, done glows, failed flickers, waiting is dashed; the drawing stops for reduced motion and earlier
runs, and without a 2D canvas the SVG schematic of wings and cells stands in); film-style readouts type in at the corners; one focus panel
shows the selected agent — what it works on now, the files it changed and read, a subagent's task,
model, answer and cost, with Copy answer and Open its chat. Earlier runs sit in a run picker; past
six subagents the station keeps five wings for those that need eyes and one holding the rest. A Commands tab lists the chat's background shell
commands (`terminal(background=true)`), running and finished. A Replay tab steps through the file
edits the AI made after each of your requests, one edit at a time, as removed and added lines. A status-bar chip (and, with a pet on
screen, a line in its bubble) shows the running batch's progress and cost while the page is closed.

Plugin id `subagent-watch` · label **Subagents** · route `/subagent-watch` · MIT.

**Read `Docs/subagent-watch-notes.md` before changing anything** — it holds where every number on the
page comes from and why each status rule is what it is.

## Screenshots

Every screen of the page, drawn by the page itself (`tests/preview.mjs`) and measured in the app's
engine (`tests/shot.cjs`):

![Subagent Watch — Terminal](tests/preview.png)

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

`GET /children` · `GET /output` · `GET /processes` · `GET /process_output` · `GET /files` ·
`GET /replay` · `GET /replay_step` — all read-only.

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
python canary_audit.py              # every mutation must turn its gate red
node preview.mjs && <electron> shot.cjs preview.html preview.png   # 12 screens (incl. 380 px, the chip, a 40-agent station) + WCAG / overflow / overlap gate
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

## Versioning

`plugin.yaml` is the source; `dashboard/manifest.json` and the top `CHANGELOG.md` heading must match.
Release checklist: bump the three, run every gate, re-copy the desktop panel, then tag.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Muhammed Enes Alpler.
