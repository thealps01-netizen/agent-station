# Agent Station — notes

Read-only desktop page for the focused chat: the main agent and its `delegate_task` subagents, that
chat's background shell commands (`terminal(background=true)`) and a Replay of its file edits.
Sidebar entry "Agent Station" → route `/agent-station`. The plugin's earlier name and the move from
it are in `CHANGELOG.md` (3.0.0) and the README.

## Layout
- **Header** — the same card as the batches: icon, title, the watched chat's name (its newest
  titled link, else `Chat …<last 6 of the id>` — see below), batch / worker / background-command counts, a running pill that
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
- **Cost** — Hermes' own record, never computed here. The backend reads `estimated_cost_usd`,
  `actual_cost_usd` and `cost_status` of every link of a worker's compression chain: `included`
  (a subscription) costs nothing and is named `subscription`; `unknown` or a missing amount is not
  priced and is never shown as $0; a billed link counts its actual amount, others the estimate; one
  estimated link makes the worker `~` (estimate). A worker's detail adds the cost after tools · tokens;
  every batch header (Earlier and Now) shows the sum, its tooltip counts priced / subscription /
  not priced workers. A live worker's cost is the `cost_usd` of its complete frame, taken only when
  positive — the frame has no status, and 0 is what a subscription or an unpriced model reports.
- **Progress chip** (status bar, right) — the focused chat's running batch: status mark,
  finished/total, a bar, the cost so far; tooltip = accessible name; click opens the page. It reads
  a module-level tracker fed by the same `subagent.*` events for every chat (keyed by the runtime
  session id the event carries), so it works with the page closed. On focus it asks `subagent.list`
  once (a batch already running when the app loaded), then every 3 s while the batch runs; a worker
  the list drops without a complete frame is stopped (a queued one gets 60 s); three failed polls turn
  the chip red with the error and slow its poll to 30 s until one answers. A finished batch lingers 8 s. Why the status bar and not
  `composer.top`: a composer slot is given no session, so in a split layout every composer would show
  the focused chat's batch.
- **Pet line** — with a Hermes pet on screen, the chip's numbers go to the pet's bubble through
  `ctx.pet.say` (id `progress`; tone `wait` while running, `error`/`info` at the end). Only a changed
  line is sent (the pet is rate-limited). No pet shown → nothing is said; the plugin draws no mascot of
  its own.
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
| Watched chat | the app's focused chat (`focusedStoredSessionId` / `focusedSessionId`) — see below |
| Live workers | gateway events `subagent.spawn_requested/start/progress/tool/complete`, filtered to the focused runtime session id; reconciled every 3 s by `subagent.list({session_id})` — see "Live reconciliation" |
| Earlier batches | `GET /api/plugins/agent-station/children?session_id=<stored id>` — `dashboard/plugin_api.py` |
| Full output | `GET /api/plugins/agent-station/output?session_id=<stored id>&worker_id=<child id>` — 403 unless the child was delegated from that chat (or a worker of it) |
| Background commands | `GET /api/plugins/agent-station/processes?session_id=<stored id>`, polled every 3 s |
| Command output tail | `GET /api/plugins/agent-station/process_output?session_id=<stored id>&process_id=<proc_…>` |
| Files | `GET /api/plugins/agent-station/files?session_id=<stored id>`, polled every 3 s and after each file tool call ends — see "Files" |
| Shimmer | gateway events `tool.start` / `tool.complete` of the focused runtime session id |

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
Live polls never stop. Three failures in a row show the alert and slow the poll to `SLOW_POLL_MS`
(30 s); the next answer clears the alert. A 4001 "session not found or not owned by this
transport" is not a failure: Hermes does not hold that runtime on this connection right now (a
resume or reconnect in flight), so the poll says nothing and asks again every 30 s, as the
desktop's own background pollers do.

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
The app's focused chat, as the SDK reports it (`host.state.focusedStoredSessionId` /
`focusedSessionId`), and nothing else. Desktop keeps the chat being worked in focused while a
non-chat zone has focus — this page, another plugin page, a preview, the sidebar
(`store/session-focus.ts`, in every supported core) — so a click on a worker row never moves the
page to the main chat. Up to 3.0.2 the page held the chat itself by reading the app's pane markup
(`data-tree-group` / `data-tree-tab`); that hold predates the app's own and broke catalog rule 8
(plugins stay inside the SDK surface), so 3.0.3 removed it.

### Files
Source: the `tool_calls` of every message in the chat's compression chain and its workers' sessions
(nested and compressed workers included), joined to each call's result by `tool_call_id`. Only
`read_file`, `write_file` and `patch` name a file; `search_files` names a folder and is left out.
- **One row per file.** `path_key`: backslashes to `/`, dot segments folded (`posixpath.normpath`), a
  drive path lowercased (Windows paths are case-insensitive; a POSIX path keeps its case). A relative
  path is joined to its session's `cwd` first. The page applies the same rule to a live call
  (`pathKey`); `tests/path_vectors.json` holds the cases both must agree on, and both gates read it.
- **Patch mode.** A `patch` call with `mode: "patch"` names its files inside V4A text; the backend
  asks Hermes' own `tools.patch_parser.parse_v4a_patch` (never a copy of the grammar). Update / add
  write, delete deletes, move deletes its source and writes its target. Without the parser, or with
  text it cannot read, the call is counted as unreadable — shown, never dropped.
- **Failed is not edited.** A result `{"error": …}` / `{"success": false}`, or the one-line stub
  Hermes writes over an old result when it compresses a conversation (`[patch] … FAILED: …`,
  `… BLOCKED, not run`), counts as a failure.
- **Blind spot, said on the page.** A terminal command or code run that writes a file records no
  path. In a 30-day sample of this install's calls, file tools were 59% of write-like calls (5,853 vs
  4,021 terminal / execute_code calls matching a write pattern). The section points to Review › Last
  turn, which reads git and lists every change.
- **Shimmer.** `tool.start` for the focused runtime id adds the call's files; `tool.complete` reloads
  the list and ends the shimmer `TOUCH_LINGER_MS` (4 s) later — a file call takes milliseconds.
  `write_file` / `patch` keep their lifecycle events even with tool progress off; `read_file` shimmers
  only with tool progress on. A worker's calls are mirrored without arguments and a V4A patch's
  files are in its text, so neither shimmers; both appear on reload.
- At most `MAX_FILES` (400) files are returned, the rest counted in `more`; the page draws 40 and a
  "N more" button. The answer is cached until a message lands in any covered session.
- **One call, once.** Compressing a conversation keeps the original rows and writes copies of the
  turns it keeps, under the same session id and the same call id; in this install 12,235 of 32,214
  call ids over 20 days sat in state.db twice. Every call is read once by `(session id, call id)`
  (`_tool_calls`); before 1.8.0 such a copy counted as a second edit. A result's copy may be a
  one-line stub where the original holds the full answer, so the longer result text wins.

### Replay
Source: the same calls as Files, only `write_file` and `patch`, read by `build_replay`.
- **Grouped under the request they followed.** A request is a `user` message of the chat's own
  compression chain; a message Hermes posts in the user's place is not one: a `display_kind` set
  (finished delegation, background process, steer, model switch) or text starting with one of
  Hermes' own markers (`[CONTEXT COMPACTION`, `[ASYNC DELEGATION`, `[IMPORTANT: …background
  process`, `[System`, …; `_NOT_A_REQUEST`). A compressed copy of a request (same time, same text)
  is the same request. A message made of parts (`\x00json:` + JSON) reads as its text parts. An
  edit belongs to the last request before it in time, a worker's edit too; edits before the first
  request sit under "Before your first request". A request with no edit is not listed.
- **The lines of an edit.** A `patch` (replace mode) shows the unified diff Hermes returned in its
  result (`diff`), with the real line number of each hunk. A result compression replaced with a stub
  no longer has it, so the edit falls back to `difflib` over the call's own `old_string` /
  `new_string` (no line number: "next part"). A V4A patch is one edit per file it names, its hunks
  read by Hermes' own parser; a delete has no lines, a move names its target. A `write_file` is the
  whole file as added lines.
- **Failed.** The same rule as Files; the edit carries the error text (300 characters) and says it
  was tried, not applied.
- **Blind spot, said on the page.** Like Files: a script or command that writes a file leaves no
  edit here.
- **Limits.** 40 newest requests (`more_turns`), 200 edits each (`more_steps`), 400 lines per edit
  (`cut`), 400 characters per line. `/replay` sends the list without lines; the page reads one edit's
  lines from `/replay_step` when it is shown (403 for an edit of another chat). Cached like Files.
- **Read-only.** No undo or restore: Hermes' own checkpoints (`/rollback`) own that.

## Not here on purpose
Interrupt / steer / live transcript — the composer status stack already owns them.

## Install
1. In the app: Settings → Capabilities → Plugins → **Install from Git**, paste the repository's web
   address, **Review repository**, leave "Enable agent plugin after install" on, install. The CLI
   equivalent is `hermes plugins install <repository URL> --enable`. Hermes puts the folder at
   `<HERMES_HOME>/plugins/agent-station/` — the folder name comes from `plugin.yaml` `name`, not from
   the repository's name.
2. The desktop half needs no copy step: the app copies `plugins/agent-station/desktop/` to
   `<HERMES_HOME>/desktop-plugins/agent-station/` (with a `.hermes-package.json` marker), re-copies it
   when the source is newer, and removes the copy when the plugin is uninstalled.
3. Two switches on the plugin's row: **Agent** (the backend routes under `/api/plugins/agent-station/`
   mount only for enabled plugins) and **Desktop** (the page and sidebar entry). A unified desktop half
   loads opt-in; the install flow turns it on when the agent half is installed enabled. Nav items and
   routes register at load, so a newly enabled page may need a restart.
4. `plugin.yaml` `requires_hermes: ">=0.21.7"`: an older core skips the agent half with "requires
   hermes …, running …". The id `agent-station` is also the key of the page's stored settings
   (`hermes.plugin.agent-station.*`).

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
  colour (the HUD palette included: it is mixed from the theme's tokens), tone used as text ink, silent
  catches, read-only backend, release gate (versions, supported range), the old name, the licence,
  and no personal account or `<drive>:/Users/<name>` path in a shipped file.
- `python tests/contract_core.py [--selftest]` — every column, marker, field, event and SDK export
  read from the core still exists (source read, no import). CI runs it against the oldest supported
  core (`ci.yml` `CORE_SHA`, v0.21.7) and weekly against the latest release and `main`
  (`newest-core.yml`).
- Visual pass: `node tests/preview.mjs` then `<electron> tests/shot.cjs preview.html preview.png` —
  real React output in the compiled app stylesheet, WCAG contrast gated in the app's own engine.
  It found the red `exit N` text at 3.3:1; failure text now uses the reading token (6.4:1).
- `cd tests && python live.py [--selftest]` — the real-render harness: the real panel, canvas and app
  stylesheet in the core's Electron on a synthetic fixture home, 56 shots (3 tabs × full/empty ×
  dark/light × 915/560/380 px, plus opened states), each measured in the engine for clipped text,
  overlap, sideways overflow, half rows in scroll lists, numerals off the code font, contrast and engine
  errors. Its first run found cut corner readouts at 560 px, a FILES legend running out at 380 px,
  scroll lists ending on half a row and numerals in mixed faces; all are fixed and locked in
  render_check. `--selftest` proves each rule fires.
