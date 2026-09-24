# Changelog

All notable changes to subagent-watch. The top `## <version>` heading is checked against
`plugin.yaml` and `dashboard/manifest.json` by `tests/release_gate.py`; bump all three together.

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
