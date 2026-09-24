# subagent-watch — notes

Read-only desktop page for `delegate_task` workers of the focused chat.
Sidebar entry "Subagents" → route `/subagent-watch`.

## Layout
- **Header** — the same card as the batches: icon, title, batch and worker counts, a running pill while
  workers run, refresh. Its accent is yellow while anything runs, green otherwise.
- **Now** — the running batch as a tree: batch root → workers (nested by `parent_id`) → merge node.
- **Earlier** — finished batches, newest first, collapsed. A batch opens to the same tree as Now
  (header = root, workers on one rail); an opened worker's detail is attached under its card.
- Every worker row (live and earlier) is one line: name + model tag; the full goal is the name's
  tooltip. An opened worker shows its goal (up to 3 lines, full text on hover) above a second box
  with Copy full output, Open session and duration · tools · tokens (no answer preview). While a batch runs it appears only in **Now**, never repeated in Earlier.
- Cards open and close independently: opening a batch or worker never folds another one. All
  cards fold when the focused chat changes.

## Data
| What | Source |
|---|---|
| Live workers | gateway events `subagent.spawn_requested/start/progress/tool/complete`, filtered to the focused runtime session id; reconciled every 3 s by `subagent.list({session_id})` |
| Earlier batches | `GET /api/plugins/subagent-watch/children?session_id=<stored id>` — `dashboard/plugin_api.py` |
| Full output | `GET /api/plugins/subagent-watch/output?session_id=<child id>` |

The backend opens `state.db` with SQLite `mode=ro` (cannot write) and serves only sessions whose
`model_config` carries `_delegate_from` — any other id gets 403. Batches = children started within
2 s of each other. A worker closed without an answer is **stopped** and gets no duration: its
`ended_at` is when the app closed, not when the work ended.

## Not here on purpose
Interrupt / steer / live transcript — the composer status stack already owns them.

## Install
1. Folder lives at `<HERMES_HOME>/plugins/subagent-watch/`.
2. `hermes plugins enable subagent-watch` (backend routes mount only for enabled plugins).
3. Restart the desktop app; it copies `desktop/` into `<HERMES_HOME>/desktop-plugins/subagent-watch/`.

## Checks
- `python tests/check_api.py` (Hermes venv python, it provides fastapi) — backend against a fixture
  state.db rebuilt under `tests/.out/` on every run, so it passes the same on any PC: read-only
  handle, compression lineage, batching, status/duration/summary rules, full output, 403/404.
  `--live` also smoke-tests this home's real state.db (needs `hermes-agent` importable;
  `HERMES_AGENT_DIR` overrides the path).
- `cd tests && npm install && node render_check.mjs` — jsdom render with real React (pinned
  jsdom 30.1.0, react 18.3.1): session scoping, status marks, tree nesting, history, copy/open,
  visible failures, chat switch.
- Mutation canaries were run by hand: removing the session filter, mapping queued/error to done,
  showing a duration for stopped, swallowing poll errors, copying the wrong session, repeating a
  running batch under Earlier, single-open cards — each fails at least one check.
- Visual pass: rendered in both the dark and light app themes (real plugin, real app CSS).
