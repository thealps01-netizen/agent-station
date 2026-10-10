# subagent-watch — notes

Read-only desktop page for `delegate_task` workers of the focused chat, plus that chat's background
shell commands (`terminal(background=true)`).
Sidebar entry "Subagents" → route `/subagent-watch`.

## Layout
- **Header** — the same card as the batches: icon, title, the watched chat's name (its newest
  titled link, else `Chat …<last 6 of the id>`; a `held` tag when the page holds a chat the app no
  longer has focused — see below), batch / worker / background-command counts, a running pill that
  counts workers and commands (`2 workers · 1 command running`), refresh. Its tint is red when a read
  failed, yellow while anything runs, neutral otherwise — never green: it used to fall back to green,
  so a page where nothing could be read looked fine.
- **Cards are flat** (`--ui-bg-secondary`). Only running and failed cards carry the 3 px status
  rail; on every card it carried no meaning.
- **Alert box** — one line per failed source, plus a `Try again` button beside them.
- **Now** — the running batch as a tree: batch root → workers (nested by `parent_id`) → merge node.
- **Earlier** — finished batches, newest first, collapsed. A batch opens to the same tree as Now
  (header = root, workers on one rail); an opened worker's detail is attached under its card.
- Every worker row (live and earlier) is one line: name + model tag; the full goal is the name's
  tooltip. An opened worker shows its goal (up to 3 lines, full text on hover) above a second box
  with the labelled buttons Copy full output and Open session, and tools · tokens (the duration is
  already on the row; no answer preview). While a batch runs it appears only in **Now**, never
  repeated in Earlier.
- **Hand-off** — a finished batch stays in Now (its merge node reads "results returned") until the
  history reload holds it, then moves to Earlier; a worker detail that was open stays open there
  (Now keys it by subagent id, Earlier by session id), and if focus was in the batch it moves to the
  batch's Earlier header. An expandable header stays the same element when it opens, so a toggle
  never drops keyboard focus.
- Copying an empty output toasts "Nothing to copy — the output is empty", never "Copied".
- Cards open and close independently: opening a batch or worker never folds another one. All
  cards fold when the focused chat changes.
- **Background commands** — below the batches (or below the empty state). Shell commands the agent
  started with `terminal(background=true)`: these are NOT subagents, and the section title's tooltip
  says so. Newest first, one row each: status mark (running yellow, exit 0 green, non-zero red,
  killed grey), the command's first line (full text on hover), `exit N` on a failed row, elapsed time
  (live while running, `—` for a killed one). A row opens the full command (copy button; the
  command block is drawn only when the row cannot show it whole), exit code (not repeated on a
  failed row), working directory and the last 8,000 characters of its output. A command with no
  receipt (`has_output: false`, the app closed under it) asks for no output: "No output was
  recorded." A command known only from the checkpoint is cut at 4,000 characters, and the detail says
  so. No section when the chat has none.

## Data
| What | Source |
|---|---|
| Watched chat | the app's focused chat (`focusedStoredSessionId` / `focusedSessionId`), held while the last pointerdown/focusin landed in this page or in a `route-tile:` / `preview-tile:` zone — see below |
| Live workers | gateway events `subagent.spawn_requested/start/progress/tool/complete`, filtered to the focused runtime session id; reconciled every 3 s by `subagent.list({session_id})` — see "Live reconciliation" |
| Earlier batches | `GET /api/plugins/subagent-watch/children?session_id=<stored id>` — `dashboard/plugin_api.py` |
| Full output | `GET /api/plugins/subagent-watch/output?session_id=<stored id>&worker_id=<child id>` — 403 unless the child was delegated from that chat (or a worker of it) |
| Background commands | `GET /api/plugins/subagent-watch/processes?session_id=<stored id>`, polled every 3 s |
| Command output tail | `GET /api/plugins/subagent-watch/process_output?session_id=<stored id>&process_id=<proc_…>` |

The backend opens `state.db` with SQLite `mode=ro` (cannot write) and serves only sessions whose
`model_config` carries `_delegate_from` — any other id gets 403. `/children` takes any chat id on
purpose: the plugin routes sit behind the same dashboard auth as the host's own
`/api/sessions/{id}/messages`, which already returns every session to that client, so an ownership
check there would guard nothing; the 403s exist so one chat's panel never shows another chat's work. Batches = children started within
2 s of each other. A worker closed without an answer is **stopped** and gets no duration: its
`ended_at` is when the app closed, not when the work ended. A worker that never got an end and has
been silent for `STALE_S` (30 min: no `last_activity_at` heartbeat, no message) is also **stopped** —
the app died under it. While a live tree shows, a stored batch that still reads running is hidden
from Earlier only when it started no more than 2 min before the live tree (`LIVE_MATCH_S`).

### Conversation lineage
A chat's stored ids are its compression chain, walked with Hermes' own rule
(`SessionDB.get_compression_lineage` + `_is_explicit_fork_child_row`): a child of a
compression-ended session continues it unless it is a fork — `source == 'tool'`, or a
`_branched_from` / `_delegate_from` / `_reset_from` marker naming that parent. A marker counts only
when it names the parent, because compression copies `model_config` (markers included) onto the
continuation. So a `/branch`, a reset fork or a worker session is its own conversation: it lists
none of its source chat's workers or commands, and their output is a 403 there.
A worker that is itself compressed mid-run is one row: start and goal from its first session,
status, end and answer from the last continuation, tools and tokens summed over the chain.

### Live reconciliation
Hermes sends `spawn_requested` while it builds a worker — before it stamps the `delegation_id` and
before `subagent.list` shows it. A queued worker the list does not show stays queued for
`QUEUE_GRACE_S` (60 s) before it reads stopped. A worker's end is final: the registry lists a
finished worker as running until Hermes' cleanup unregisters it, and that snapshot never revives
it. A poll of a chat the page has left does not count toward the new chat's three failures.

### Background commands — where they come from
Nothing is parsed out of chat text. Both sources are files Hermes itself writes, read-only:

| File | Written by | Holds |
|---|---|---|
| `<HERMES_HOME>/processes.json` | `tools/process_registry_checkpoint.py::_write_checkpoint` | every RUNNING process (crash-recovery checkpoint) |
| `<HERMES_HOME>/logs/process-results/proc_*.json` | `tools/process_registry_results.py::save_completed_result` | one receipt per FINISHED process: command, cwd, `parent_session_id`, `started_at`, `exit_code`, `completion_reason`, output (redacted by Hermes) |

- **Ownership:** a process belongs to the chat when its `parent_session_id` is a link of the chat's
  compression chain — the rule Hermes uses itself (`_owns_result`). Another chat's process is never
  listed, and its output is refused with 403.
- **Status:** receipt with `completion_reason == "killed"` → stopped; exit 0 → completed; any other
  exit → failed. A checkpoint entry whose PID is gone (asked through Hermes'
  `ProcessRegistry._host_pid_is_ours`, which also rejects a recycled PID; psutil when that API is
  unavailable; stopped when neither can answer — never fail-open) → stopped. A receipt wins
  over a stale checkpoint entry for the same id.
- **End time:** Hermes records none; the receipt's file mtime is used, because the receipt is
  written at the moment the process leaves the running set.
- **Limits (Hermes', not ours):** receipts are kept 7 days, at most 64 files; older commands are gone.
- **Cost:** a receipt never changes after it is written, so each is parsed once and cached by
  (path, mtime, size) without its output; a poll is a directory listing plus `processes.json`
  (~3 ms on this machine). The list never carries output; `/process_output` reads one receipt.
- **Failures are shown:** an unreadable receipt — or valid JSON of the wrong shape (a list, a
  non-text owner) — is counted and printed beside the section title with the failed mark (the text
  keeps its reading colour for contrast); the other records are still listed. A checkpoint entry
  that is not an object is counted the same way. An unreadable `processes.json`, or one whose top
  level is not a list, is a 503 shown in the page's alert box.

### Which chat the page watches
The app derives its focused chat from the last clicked zone (`store/session-focus.ts`): a
`session-tile:` pane is that chat, ANY other zone falls back to the main chat. This page is such a
zone, so following the app blindly made a click on a worker row switch the page to the main chat
whenever the watched chat was open as a tab beside another main chat (1.1.10 fix).
`useWatchedChat` listens to `pointerdown` / `focusin` (capture) and holds the watched chat while
the target is inside this page, or in a zone whose tab (clicked or active) is a `route-tile:` /
`preview-tile:` pane. Any other interaction — a chat tile, the Sessions sidebar, outside every
zone — follows the app again. Depends on the app's `data-tree-group` / `data-tree-tab` /
`aria-selected` markup; if the app renames it, the hold stops working and the page falls back to
the old behaviour (it never shows a wrong chat that the app did not name). A chat switch made only
by keyboard while the hold is on is picked up at the next click outside the panel.

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
- `python tests/canary_audit.py` (Hermes venv python) — the mutation canaries, no longer by hand: 98 mutations, run in parallel (render,
  backend, static audit), each applied to a copy and required to turn its owning gate red. The first
  run found two behaviours no check covered (a failed command-output read, cards left open after a
  chat switch); both are now render checks.
- `python tests/audit_static.py` — i18n, native `title`, icon names, `aria-expanded`, status-mark / header-count names, hard-coded
  colour, tone used as text ink, silent catches, read-only backend, release gate.
- `python tests/contract_core.py [--selftest]` — every column, marker, field, event and SDK export
  read from the core still exists (source read, no import).
- Visual pass: `node tests/preview.mjs` then `<electron> tests/shot.cjs preview.html preview.png` —
  real React output in the compiled app stylesheet, WCAG contrast gated in the app's own engine.
  It found the red `exit N` text at 3.3:1; failure text now uses the reading token (6.4:1).
