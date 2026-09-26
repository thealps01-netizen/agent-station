# Changelog

All notable changes to subagent-watch. The top `## <version>` heading is checked against
`plugin.yaml` and `dashboard/manifest.json` by `tests/release_gate.py`; bump all three together.

## 1.1.8 — 2026-09-26

Fixes from a fourth blind review.

### Fixes

- **Every route now closes its state.db connection.** The routes used `with _connect() as conn:`,
  which on a `sqlite3.Connection` only commits or rolls back and never closes, so each 3-second poll
  left a handle open until garbage collection. They now use `contextlib.closing`, and
  `check_api.py` proves each of the four routes (including a refused request) closes its connection.
- **A 503 for an unreadable file no longer prints the exception text.** `processes.json unreadable`
  and `record unreadable` put the raw OS error in the HTTP detail, which carries the absolute file
  path. The detail is now `processes.json unreadable (PermissionError)` /
  `process record unreadable (<error type>)`; the full error is logged server-side.
- **The worker's model chip is readable and shows the reasoning effort.** Beside a docked chat the
  chip shrank to "cl…" (it took the ellipsis instead of the name), and the effort the worker ran with
  was never shown. `/children` now returns `effort` per worker, read from
  `model_config.reasoning_config.effort` (null when missing, disabled or unparseable, never an error);
  the chip reads `claude-opus-5-5 · medium` (the model alone when there is no effort), keeps its full
  width while the worker name ellipsizes, and its tooltip names the full model id and the effort. It
  is still hidden below 420 px. The preview gains a 480 px frame where the Electron gate measures that
  no chip is cut.
- Seven new canaries break each fix and require its gate to go red (63 mutations).

## 1.1.7 — 2026-09-25

Fixes from a second blind review.

### Fixes

- **A crashed worker no longer reads "running" forever.** A worker session that never got an end
  (the app died under it) was running for good, and while any live tree showed, its whole batch was
  hidden from Earlier. A worker with no end that has been silent (no heartbeat, no message) for
  30 minutes now reads **stopped**, and a stored running batch is only matched to the live tree when
  it started around the same time; an older one stays under Earlier.
- **A dead background command no longer reads running when the core's PID check changes.** The
  liveness test used to fail open (unknown = alive); it now falls back to psutil and, when nothing
  can be asked, reads stopped.
- **Switching chats drops the previous chat's errors.** A failed history read of one chat stayed on
  screen after switching to another until the new read answered.
- **A finished batch stays finished.** When `subagent.list` still returned a finished batch's
  workers, the batch came back under Now and history was reloaded again; handed-over workers are
  now ignored.
- **An earlier batch of several workers is no longer labelled as its first worker alone:** the name
  is followed by "+N more".
- **Background commands show a loader** while their first read is pending, instead of nothing.
- **The 503 for a missing `state.db` no longer prints the absolute path** (it is logged instead).
- **Shadows and the check-mark ink come from the theme** (`--shadow-sm` / `--shadow-xs`,
  `--dt-background`) instead of hard-coded `rgb()` values and the destructive token; the static
  audit's colour rule now also rejects `rgb()`/`hsl()` literals.
- **Less noise inside frames:** rows inside a framed box keep their status mark but no longer draw
  their own coloured rail and shadow; the frame carries the one accent.
- Removed the unused `sw-muted` rule; the worker detail and the command detail share one
  `Branches` component instead of two copies.

### Accessibility

- Buttons, rows, header counts and tooltip triggers draw a **visible focus ring** (the app removes
  every ring); header counts, the batch-root and merge marks and the section tooltip are focusable.
- The title is an `h2` and Now / Earlier / Background commands are `h3` headings.
- Times, counts, the current-tool and model chips and the output label use the secondary reading
  token (measured 4.0–4.2:1 before, below WCAG AA); no text is smaller than 11.5 px.
- The toast's live region stays mounted, so screen readers announce "Copied" / "Copy failed".
- Copy full output shows a busy state ("Copying…", `aria-busy`) while it reads.

### Copy

- When every read fails, the page says "Nothing could be read. Press Refresh to try again." instead
  of a blank body.
- At 380 px sibling workers whose goals share a long opening ("Blind-review desktop panel 1: …")
  drop the shared words so each row stays distinguishable; the batch strip hides at that width.
- Duration and token units and the "what: detail" error format come from the string bundle;
  "Output (end)" reads "End of output"; "1 tool" is singular.
- The render check no longer mutates its shared fixtures mid-run (they are frozen; scenarios use
  their own data).

## 1.1.6 — 2026-09-25

Fixes from a blind review:

- **A running worker no longer reads as done.** Status used to come from "has it written any
  answer text", so a worker that had replied once but was still working showed a green check. It
  now comes from the session's end: a worker whose session has not ended is running.
- **Full output is served only to the chat that delegated the worker.** `/output` used to return any
  delegated worker's answer to any caller. It now takes the chat (`session_id`) and the worker
  (`worker_id`) and refuses (403) a worker delegated from another conversation, the same rule
  `/process_output` applies.
- **Refresh restarts live updates.** After three failed polls the live view stopped for good and
  Refresh did not bring it back; Refresh now resets the failure count and polls again.
- **A refused clipboard is a "Copy failed" toast** on both copy buttons, not an unhandled error.
- **A change in the core's private PID check no longer breaks the command list** with a 500: any
  failure is logged and the process is treated as alive (unknown), as before for a missing module.
- **Plurals:** "1 batch", "1 worker", "1 background command".
- **Screen readers hear the status marks and header counts:** each carries the same text as its
  tooltip as an accessible name (new `markName` audit rule and canaries).
- **Counts whose source failed read "—"** instead of a 0 that looks like real data.

## 1.1.5 — 2026-09-25

- **Background commands share the Earlier batches' structure.** A command used to open as a row
  with loose pieces under it, while a batch opened into a framed box. Now both behave the same:
  folded, a command is one card with a chevron; opened, it becomes the same framed box (status
  tint, left rail), its header is the root and the command, actions and output hang off the same
  tree rail the batch's workers hang off. The render check asserts that layout.

## 1.1.4 — 2026-09-25

Background command detail, reported from the app:

- **The output leaf has its own card** like the command and actions above it. It used to be a bare
  label with the "shown when the command finishes" note floating under it. The text inside needs no
  second box, so the output `<pre>` inside the card is unframed.
- **Meta line sits next to the copy button**, left-aligned, instead of right-aligned text that broke
  a path into a ragged column.
- **Monospace on Windows.** The host's mono stack (Menlo, Monaco, SF Mono…) has none of its fonts on
  Windows and fell through to Courier. The panel now puts `ui-monospace`, Cascadia Mono and Consolas
  first and keeps the host stack as the fallback.
- The preview's narrow frame also opens a still-running command, the state the report showed.

## 1.1.3 — 2026-09-25

- **Opened details hang as tree branches.** A worker's detail (goal, actions) and a background
  command's detail (command, actions, output) used to sit in a second outer frame glued under the
  row. That frame is gone: each piece hangs off the row on the same connector lines the live batch
  tree draws, so the batch tree, the history and the background commands read as one structure.
  The render check asserts every piece of an opened detail sits on its own branch.

## 1.1.2 — 2026-09-25

Narrow-pane layout, reported from the docked app (about 380 px wide):

- **Header.** The count pills painted over the "Subagents" title and "6 running" broke onto two
  lines. The counts and refresh are now one group that drops under the title as a whole when the
  pane is narrow; the title and every pill stay on one line.
- **Command detail.** The `exit 0 · in <working directory>` line ran past the right edge and made
  the whole page scroll sideways. It now wraps inside its box.
- **Worker rows.** Below 420 px the model chip (cut to `c…`, saying nothing) is hidden, and the
  worker name takes the freed width instead of stopping at 70%.
- **Output box** sizes to its content (48–180 px) instead of a fixed 180 px of empty space.
- **The measured render now catches this class.** `preview.mjs` draws a fourth, 380 px frame; `shot.cjs`
  fails on anything wider than its frame, on header pieces that overlap and on a pill whose text wraps.
  It was red on all three before the fix (16 violations) and is green after it.

## 1.1.1 — 2026-09-24

Release hardening. Two visible changes, both found by the new measured render:

- **Readable failure text.** The `exit N` of a failed command and the "records could not be read"
  note were inked in the theme's red on the dark card: 3.3:1 and 4.3:1, below WCAG AA (4.5:1). They
  now use the reading token (6.4:1); the red stays on the status mark and the stripe, where it is
  a colour, not text. The audit's `toneInk` rule keeps it that way.
- The tick and cross drawn on the done and failed marks follow the theme instead of hard-coded white.

- **Version drift fixed.** `dashboard/manifest.json` still said 1.0.0 while `plugin.yaml` said 1.1.0.
  Both now carry one version, and `release_gate.py` turns the audit red when they, this changelog or
  the installed desktop copy drift apart.
- **Core contract gate** (`tests/contract_core.py`). Reads the core's source and fails, naming the
  piece, when anything this panel reads moves: a `sessions` / `messages` column, the
  `_delegate_from` marker, the `compression` end reason, the process receipt and checkpoint fields,
  the `killed` completion reason, `_host_pid_is_ours`, the `subagent.*` events, `subagent.list`,
  a `SubagentStatus` value without a mark, an SDK export or a `host.state` atom.
  `--selftest` breaks each of those 12 rules once and requires the gate to name it.
- **Static audit** (`tests/audit_static.py`). i18n keys resolve (template keys included), no
  native `title=` tooltip, icon buttons named, accordion rows carry `aria-expanded`, no hard-coded
  colour, no silent catch in the page or the backend, and the backend stays read-only
  (`mode=ro`, GET routes only, no file writes).
- **Canary run** (`tests/canary_audit.py`). The hand-run mutation list from the notes is now a
  script: 32 mutations, each applied to a copy and required to turn its owning gate red. The first
  run caught two behaviours no test covered (a failed command-output read, cards left open after a
  chat switch); `render_check.mjs` now checks both.
- **Preview and measured render** (`tests/preview.mjs`, `tests/shot.cjs`). Three frames of the
  page's real React output in the app's compiled stylesheet, then a WCAG contrast gate in the app's
  own Electron. `tests/preview.png` is the result.
- **Portable tests.** `tests/env.py` / `env.mjs` resolve `HERMES_HOME` and the core from the
  environment; `check_api.py --live` no longer assumes the repo sits inside the install.
- **Clean test output.** The render check used the deprecated `react-dom/test-utils` `act` and
  fired events outside an async `act`; both React warnings are gone.
- README, this changelog, the MIT licence and CI (`.github/workflows/ci.yml`, Ubuntu + Windows).

## 1.1.0 — 2026-09-24

- **Background commands.** A section below the batches lists the shell commands the agent started
  with `terminal(background=true)` in this chat, running and finished: status mark, first line of
  the command, `exit N` on a failure, elapsed time (live while running, `—` for a killed one). A row
  opens the full command, its exit code, working directory and the last 8,000 characters of output.
- Read only from files Hermes writes itself (`processes.json` and `logs/process-results/`), scoped
  by the chat's compression chain; another chat's command is never listed and its output is refused.
- An unreadable receipt is counted and shown; an unreadable `processes.json` is a visible error.

## 1.0.0 — 2026-09-24

- First release. Read-only page for `delegate_task` workers of the focused chat: the running batch
  as a live tree (events scoped to the focused runtime session, reconciled by `subagent.list`),
  earlier batches from `state.db` opened `mode=ro`, full worker output on demand, open session.
- Five status marks (queued, running, completed, failed, stopped); a worker closed without an answer
  is stopped and shows no duration.
