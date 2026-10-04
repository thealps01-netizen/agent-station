# subagent-watch — notes

Read-only desktop page for `delegate_task` workers of the focused chat, plus that chat's background
shell commands (`terminal(background=true)`).
Sidebar entry "Subagents" → route `/subagent-watch`.

## Current composition: Attention Desk

The working surface is a priority queue of this watched chat's workers and background commands,
with one selected original-evidence inspector. Failed and stopped work comes first, then queued
and running work, then completed work. Selecting a worker reads its owned original answer; a live
worker without a stored child id shows any received live result summary with its provenance,
not as a full stored answer; otherwise it says the answer is not available yet. Selecting a command keeps
its full command, exit/stop evidence and output-tail limit. Copy and Open session keep their
existing routes. A late deselected answer cannot replace the selected inspector.

The live tree, earlier batches and independent expansion controls remain in a closed contextual
view. They are not a second worker system. Empty, loading and all-failed guidance stays visible
without opening that context. The explicit watched-chat adapter is unchanged: clicking the panel
must not silently move it to the main chat. Removal of the focused selected queue row hands focus
to the deterministic surviving row, or the existing Refresh action when empty; unrelated controls
retain their focus.

History/process reads share one request-lifecycle helper: one in-flight read and one coalesced
refresh, with ownership invalidated on chat change or unmount. Live snapshots have a separate
single-flight boundary and retain the existing stop-after-three-failures/Refresh recovery. The
pure reconciliation seam retains the existing time window, goal-prefix fallback, early-finished
child handling, `db:` identities and newest-first stored order.

This is a behavior-preserving extraction, not a durable identity migration. When several live
trees overlap and the producer has no child-session identity, the existing newest-tree fallback
and goal-prefix ambiguity remain. Changing that host contract requires a separate scoped change;
this panel does not claim to have solved the attribution ambiguity or to have changed SQL.

## Contextual layout
- **Header** — the same card as the batches: icon, title, batch / worker / background-command counts, a
  running pill while workers run, refresh. Its accent is yellow while anything (worker or command)
  runs, green otherwise.
- **Now** — the running batch as a tree: batch root → workers (nested by `parent_id`) → merge node.
- **Earlier** — finished batches, newest first, collapsed. A batch opens to the same tree as Now
  (header = root, workers on one rail); an opened worker's detail is attached under its card.
- Every worker row (live and earlier) is one line: name + model tag; the full goal is the name's
  tooltip. An opened worker shows its goal (up to 3 lines, full text on hover) above a second box
  with Copy full output, Open session and duration · tools · tokens (no answer preview). While a batch runs it appears only in **Now**, never repeated in Earlier.
- Cards open and close independently: opening a batch or worker never folds another one. All
  cards fold when the focused chat changes.
- **Background commands** — below the batches (or below the empty state). Shell commands the agent
  started with `terminal(background=true)`: these are NOT subagents, and the section title's tooltip
  says so. Newest first, one row each: status mark (running yellow, exit 0 green, non-zero red,
  killed grey), the command's first line (full text on hover), `exit N` on a failed row, elapsed time
  (live while running, `—` for a killed one). A row opens the full command (copy button), exit code,
  working directory and the last 8,000 characters of its output. No section when the chat has none.

## Data
| What | Source |
|---|---|
| Watched chat | the app's focused chat (`focusedStoredSessionId` / `focusedSessionId`), held while the last pointerdown/focusin landed in this page or in a `route-tile:` / `preview-tile:` zone — see below |
| Live workers | gateway events `subagent.spawn_requested/start/progress/tool/complete`, filtered to the focused runtime session id; reconciled every 3 s by `subagent.list({session_id})` |
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
- **Failures are shown:** an unreadable receipt is counted and printed in red beside the section
  title; an unreadable `processes.json` is a 503 shown in the page's alert box.

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
- `python tests/canary_audit.py` — the mutation canaries, no longer by hand: 56 mutations (render,
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

## Source-format contract and retained rationale

Production modules contain no comments or docstrings. The existing static audit owns this rule,
and its existing mutation suite injects JavaScript/CSS comments, Python comments and Python
docstrings to verify they are rejected. Fresh suite reports carry the proof. Runtime code, source identifiers and route behavior are unchanged; a pre-image
comparison verified the Python executable AST with docstrings excluded.

The explanations below were migrated from the previous source snapshot. They document historical
rationale, not a second implementation or a replacement for the Current composition section.
Model examples are generalized to provider/model roles; the exact source snapshot remains in the
local migration evidence.

### Backend module

subagent-watch backend: read-only history of delegate_task workers.

The desktop plugin SDK has no way to list a session's delegated child sessions or read a
child's final output, so this router reads state.db directly — opened with SQLite's
``mode=ro`` URI, so it can never write. Only sessions whose ``model_config`` carries
``_delegate_from`` (the marker delegate_task writes on every child) are ever returned;
any other session id is refused, so the router cannot be used to read arbitrary chats.

Background shell processes (terminal background=true) are read from the two files Hermes itself
keeps: ``processes.json`` (running, the crash-recovery checkpoint) and
``logs/process-results/proc_*.json`` (finished, one durable receipt each, 7 days / 64 files).
A process belongs to a conversation when its ``parent_session_id`` is a link of that
conversation's compression chain — the same ownership rule Hermes applies when it reloads a
receipt (tools/process_registry_results.py::_owns_result).

Routes (mounted at /api/plugins/subagent-watch/):
  GET /children?session_id=<id>  -> workers delegated from that conversation, grouped into
                                    batches (children started within BATCH_GAP_S of each other)
  GET /output?session_id=<id>&worker_id=<child> -> the child's final answer, full length; 403 when
                                    the child was not delegated from that conversation
  GET /processes?session_id=<id> -> that conversation's background processes, running and finished
  GET /process_output?session_id=<id>&process_id=<proc_...> -> a finished process's output tail

### Backend _unreadable

A 503 that names the file and the error type; the full message (with its path) is only logged.

### Backend _effort

The worker's reasoning effort from model_config.reasoning_config; None when off, absent or unreadable.

### Backend _lineage

All ids of one conversation: compression ancestors, the session, and its continuations.

Delegation children name the session id that was live when they were spawned, which can be
any link of the compression chain, so every link is a valid parent key.

### Backend _last_seen

Freshest sign of life: the activity heartbeat, the newest message, else the start.

### Backend _owned_by

True when a worker's delegating session is one of `owners`, directly or via nested workers.

### Backend _pid_is_ours

Hermes' own liveness test (PID alive and not recycled), else psutil's bare existence test.

Fails closed: when neither can be asked the process reads stopped, never running forever.

### Backend _read_results

(record without its output, mtime) per readable receipt, plus how many could not be read.

A receipt never changes after Hermes writes it and can carry 200k chars of output, so each
one is parsed once and kept by (path, mtime, size); the panel polls this every few seconds.

### Backend inline rationale

- delegate_task starts a batch's children within ~1 s of each other
- compression chains deeper than this are pathological
- a command longer than this is cut for display and flagged
- last chars of a finished process's output served to the detail
- a worker silent this long (no heartbeat, no message) with no end is not running
- walk up while the parent was closed by compression
- walk down through compression continuations
- The session's end is the only end state: a worker that has not ended is running even when
- it has already written assistant text (an interim reply is not a final answer) — unless it has
- been silent for STALE_S: then the app died under it and it will never get an end.
- Closed without an answer: the app or the parent went away mid-run.
- noqa: BLE001 - a private core API; any change must not become a 500
- noqa: BLE001 - no liveness source left; say so and read stopped
- Hermes pruned it between the listing and the read.
- Checkpointed but gone, with no receipt: the app closed under it.
- The receipt is written at the moment the process leaves the running set, so its mtime is
- the end time; Hermes records no separate field for it.

### Desktop rationale


Subagent Watch — read-only page for delegate_task workers of the focused chat.

  Now      the running batch as a tree: batch root -> workers (nested by parent_id) -> merge node.
           Fed by gateway `subagent.*` events for the focused runtime session, reconciled by a
           `subagent.list` poll (the RPC is session-scoped, so other chats never leak in).
  Earlier  finished batches as a collapsed list, from this plugin's backend
           (dashboard/plugin_api.py, state.db opened read-only). A worker row opens a detail with
           its answer, "copy full output" and "open session".
  Background commands
           shell commands the agent started with terminal(background=true), running and finished,
           from the backend's /processes (Hermes' own processes.json + process-results receipts).
           A row opens the full command, its exit code and the end of its output.

Nothing here writes: no interrupt, no steer (the composer status stack already owns those).
Every failed read is shown in the page; nothing is swallowed.


A stored batch still reading "running" is the live tree only when it started around the same time:


one that started well before the live tree began is a crashed run and stays under Earlier.


Wire statuses (tui_gateway/contracts/common.py SubagentStatus) -> the five marks this page draws.


The stored id of the chat the page watches (see useWatchedChat), for reads deep in the tree.


── pure helpers (exported for the render check) ─────────────────────────────


The English bundle as a `t`, for helpers called without the page's translator.


One line a person can read: the goal's first line, a quoted slug when there is one.


Names for sibling rows: when several share a long opening ('Blind-review desktop panel 1: …',
'… panel 2: …') a narrow pane cuts them all to the same text. The shared words are dropped (the
last one kept for context) so what tells the rows apart is what stays visible.


Model slug without a provider prefix: '<provider>/<model>' becomes '<model>'.


Chip text: the model label, then the reasoning effort when the worker ran with one.


Full goal lives in the name's tooltip: the row stays one line, the purpose is one hover away.


The chip keeps its full width; the name is what ellipsizes.


Live records -> batches keyed by delegation_id, each a forest by parent_id.


── marks ────────────────────────────────────────────────────────────────────


Ink of the check / cross drawn ON a filled tone disc: the page ground itself, a cut-out that is


neither a success nor a failure token and follows every skin.


The svg is aria-hidden, so the mark itself carries the Tip's text as its accessible name. A mark


outside a button (`focusable`) is a tab stop of its own, so its tooltip is reachable by keyboard.


A header count: the number (or — when its source failed) with the Tip's text as its name.


── data hooks ───────────────────────────────────────────────────────────────


subagent.list carries no child_session_id, so a batch still running on the backend is matched by


state and time: while a live tree is drawn, a stored batch with an unfinished worker that started


no earlier than the live tree (less LIVE_MATCH_S) IS that tree.


The backend drops a worker from subagent.list the moment it finishes, so a half-done batch's


finished workers exist only in state.db. They join the live tree; hiding the stored batch


without them turned '6 workers 5/6' into '1 worker 0/1'.


Live workers of the focused runtime session: events + a reconciling `subagent.list` poll.


Workers already handed to history: a later subagent.list that still returns them must not


bring the batch back (and trigger another history reload).


A worker the backend no longer tracks ended without a complete frame reaching us.


A batch whose workers are all terminal moves to history: reload it, then drop it from "Now".


Refresh after polling gave up: reset the failure count so the interval polls again, and poll now.


── pieces ───────────────────────────────────────────────────────────────────


Clipboard write that never rejects out of a click handler: a refusal is a "Copy failed" toast.


The backend serves a worker's output only to the chat that delegated it.


The first worker names the batch; the others are counted, so a batch is never read as one task.


Same tree as the live batch: the header is the root, each worker hangs off one rail.


── background commands ──────────────────────────────────────────────────────


First non-empty line of a command, for the one-line row; the full text is the tooltip.


An opened row's pieces hang under it as tree branches, the same lines the live batch tree draws.


Each leaf gets its own wrapper so the connector is drawn outside the leaf (a scrolling <pre> would


clip a connector drawn on itself). A worker's detail branches off its row (`sw-dt`); a command's


hangs off the batch rail of its framed box (`onRail`), exactly like an earlier batch's workers.


── page ─────────────────────────────────────────────────────────────────────


A set of open card keys: toggle(key) flips one card, clear() folds them all (on chat change).


Zones whose click makes the app name its MAIN chat as focused although no chat was picked: this


page's own route tile, other plugin pages and previews. A click in them keeps the watched chat.


The chat this page watches. It follows the app's focused chat, except while the last click (or
focus move) landed in this page or in another page's tile: there the app falls back to the main
chat, and following it made a click on a worker row show another chat's (empty) history.


Decided after the click has run every listener: the app moves its focused chat in its own


pointerdown listener, and React can render that before this page's listener has seen the click.


Each card opens and closes on its own: opening one never folds another.


Counts and refresh are one group: on a narrow pane it drops under the title as a


whole instead of squeezing the title or wrapping a pill onto two lines.


A count whose source failed reads —, never a 0 that looks like real data.


The live region stays mounted so a screen reader is already listening when a toast lands.

### Embedded stylesheet rationale

Docked beside the chat the worker name needs every pixel: a model chip cut to 'c…' says nothing.

The app removes every focus ring; a keyboard user still has to see where focus is.

Inside a framed box the frame already carries the tint: rows keep their mark, lose the rail and
   the lift, so a frame holds one accent instead of one per row.

A command's piece hangs off the rail like a worker row: connector at the first line.

The output leaf is a card like its siblings; the text inside it needs no second box.

## Final review regression fixes

Removed focused worker/process rows recover to a surviving queue item or the stable existing Refresh action. Unrelated controls keep focus. The source-format rule now lives in the existing static audit and mutation suite; explanation moved to this notes file without changing executable Python/JavaScript AST (docstrings and CSS comments excluded).
