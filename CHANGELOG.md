# Changelog

All notable changes to subagent-watch. The top `## <version>` heading is checked against
`plugin.yaml` and `dashboard/manifest.json` by `tests/release_gate.py`; bump all three together.

## 2.2.0 — 2026-10-14

The Commands tab gets the FLEET station's treatment, from a draft the user approved on video.

- A new ORBIT panel above the CONSOLE draws the chat's background commands live on a canvas as a
  holographic globe: a see-through sphere of fine particles with thin meridians, outer arc bands with
  tick scales, and a thick tilted band of segments round it, one segment per command in its status
  colour (running pulses, failed flickers red, stopped is dashed; the selected one stands taller in the
  running colour). Each command also rides its own thin orbit; a running one flies with a trail.
- A column of labels names up to six commands (start time and command line, cut with an ellipsis),
  each tied by a leader to its band segment; a ring gauge counts the ended commands. Below 520 px the
  labels and gauge stay out and the globe is centred.
- Everything is read from the tab's own list rows; colours from the theme's tokens. An earlier run or
  reduced motion draws one still frame a second. Without a 2D canvas the panel stays hidden.

## 2.1.0 — 2026-10-14

The FLEET station comes alive, from drafts the user approved on video.

- The station is drawn live on a canvas in thin glowing lines: a ribbed wheel with habitat windows,
  a top rail and hull blocks on four truss spokes round a central column (collar ring, fuel tanks,
  solar arrays), a deck disc with two dishes, a command sphere under the MAIN box and a docking mast.
  It is drawn in part by part on first paint; the wheel, disc and sphere turn, faster while the main
  agent works; a scan ring rides the column and a ping rolls across the wheel.
- Each subagent is a module on the rim, level with its callout: working pulses and a scan bar crosses
  it, done glows steady, failed flickers red, waiting is a dashed outline; the group callout is a row
  of slivers. The top module keeps clear of the command sphere.
- Film-style readouts type in at the station's top corners (scan, core, wings on the left; working,
  failed, waiting counts on the right), callouts slide in from their side, panel titles type in.
- DETAIL reads like the HUD's own panels: boxed counters with gauges, caps headings over hairlines.
- Colours come from the page's tokens, read through the canvas, so the scene follows every theme.
  Reduced motion or an earlier run: one still frame, refreshed once a second. Without a 2D canvas the
  SVG schematic stays.
- Gates: render checks for the canvas, its fallback, token colours and hand-back; four new canaries.
  Readout text is 11.5px, the page's floor.

## 2.0.0 — 2026-10-14

The page is redrawn as a mission-control HUD, from a reference the user picked: a black ground,
near-black panels on hairlines, one mint accent with dark-teal tracks, grey caps titles, a light
monospace. The colours are fixed, so the page looks the same in every app theme; the status-bar chip
still takes the theme's colours. Red marks only a failure, amber only something still running.

### Changed

- **The HUD follows the Hermes theme.** It uses the app's own tokens as they are: a see-through ground
  (the window's glass shows through, as behind the chat), the app's translucent card for panels, its
  strokes, text levels, diff colours, active-row fill and mono font. The accent is the theme accent, held
  light enough to read on a dark ground; red and amber are the theme's status colours. No colour is fixed.
- **HUD light and motion.** Panels carry accent corner ticks and power on one after another; time bars and
  the chart fill in, with glowing markers and a filled curve; the picked tab, big numbers and changed-file
  tiles glow faintly; the tabs sit on the title row; the playback strip is a band of ticks with text
  PREVIOUS / PLAY / NEXT; callout chips are filled. While Play types, a scan line sweeps the diff and a
  number that changes rolls in. Reduced motion stops all of it.
- **One order on every tab.** Three type sizes (11.5 px text, 14 px names, 28 px numbers) and two letter
  spacings; the line under the title is the same strip on every tab (Replay's text shortened to one line);
  TIME PER AGENT draws its shared scale once instead of under every agent; the FILES legend stays on one
  line. DETAIL starts folded under its title row (click to open). The done count is no longer repeated in
  SPENT and the main agent card. Replay: PLAYBACK is a full-width strip under the diff, then LINES CHANGED,
  LINES SO FAR and FILE in one row, then the log; FILE no longer repeats the diff's file name and status.
- **11 px text.** The HUD page is scaled (CSS zoom .9566) so its smallest text lands at 11 px, and the
  leader lines convert screen pixels back to the scaled page so they still meet their rows.
- **Denser, like the draft.** 11.5 px body text, one 8 px gutter and no frame around the panels, tighter
  fleet nodes and smaller large numbers, no text glow. DETAIL sits on the same ground as the other panels,
  names its agent in its title instead of a second focus label, and has a smaller portrait.
- **Play types the edit out, as in the draft.** Each removed line is struck through and dims, then each
  added line is typed in letter by letter, one line every 0.9 s (faster on a long edit, so it ends near
  9 s), behind a block cursor with an accent bar on the line being typed; the list follows that line.
  Play stays on an edit until it is done. A failed edit was never applied, so it stands still. Reduced
  motion shows every edit whole. (The typing was a CSS width on an inline span, which does nothing: lines
  showed whole at once. It is now done in script, so it also types wrapped lines.)
- **Replay shows the code whole.** The diff takes the panel's full width and long lines wrap instead of
  being cut off behind a callout column; each row has its line number. What a part of the edit did
  ("2 LINES REPLACED −2 +3") sits on its FROM LINE header row, and a whole-file write gets one from line 1.
- **Run text keeps its case in HUD titles.** A command or a file name next to a caps title
  (`CØNSØLE · python build.py`, `DIFF · plugin.js`) and the agent names in TIME PER AGENT read as typed;
  only our own labels are capitalised.
- **Shorter list times.** Within a week a time reads `Tue 23:56` instead of `yesterday 23:56`, which
  left the command column a few letters wide.
- A failed command's gauge says FAILED, not FINISHED; the fleet says SUBAGENTS DØNE, not RUN CØMPLETE,
  while the main agent still works; FILES groups its cells changed, failed, read; DETAIL's file
  sections use the HUD's caps headings instead of boxed frames.
- **Replay is a HUD.** A six-column grid: your requests on top; the edit's lines on a faint grid, each
  part headed by where it starts and what it did; LINES CHANGED (added, removed, this edit, each against the request's largest); LINES SO FAR
  (applied lines up to this edit over the request's total, a curve with failed edits ticked in red);
  PLAYBACK (one cell per edit, Previous / Play / Next); FILE (name, folder, what changed, the request);
  LOG (every edit with its time, EDIT / WRITE / DELETE / MOVE / FAILED and its +/−; a row opens it).
  Below 540 px the panels stack and the callouts give way.
- **Agents is a HUD.** FLEET is a wireframe space station drawn in isometric lines. Its core is the main
  agent, with a box above it saying what it does and how many subagents are done. Each subagent is a wing
  of 8 × 2 cells: amber cells run along it while it works, it fills in the accent when done (its frame
  flashes once), three cells turn red and it shakes once when it fails, a waiting wing is dashed. A
  callout per wing (name, state, time) sits in a column at each side on a leader line to the wing's
  nearest corner; a click selects it. At most six wings fit, three a side, without touching: past six
  subagents five wings go to those that need eyes (failed, then working, then waiting) and an outer sixth
  holds the rest, its callout a coloured mark and count per state (+9 MØRE ■6 ■2 ⬚1). Below 540 px the
  station stays and the callouts drop under it as a list. Then TIME PER AGENT (as many tracks as wings,
  the rest counted) (each run time against the longest),
  SPENT (cost, tokens, tools, done n/N), FILES (a cell per file: changed, failed, only read), AGENT (the
  selected agent's model, time, tools · tokens · cost, task), LOG (a row per subagent; a row selects it)
  and DETAIL (the full focus panel: files worked on now, changed and read, the answer, its buttons).
- **Type as in the reference: a light grey mono.** Cascadia Mono Light where the system has it
  (Windows 11), else the app's own mono, at one light weight everywhere; caps labels keep a slight
  .04em letter spacing instead of .12em.
- **Commands is a HUD.** CONSOLE across the grid: the picked command's output on the faint grid with
  line numbers, failing lines marked red, a FINISHED / RUNNING gauge and a FIRST ERROR callout tied by a
  leader line to that line; below it COMMANDS (one row per command: start time, a status square and
  word, the command on one line, its exit and duration; a row picks it, the newest by default) and
  PROCESS (command, folder, ran, exit, lines, Copy output / Copy command). Rows no longer fold open.
- **Agents and Commands take the same look:** caps titles and tabs ("01 AGENTS"), square hairline
  panels, no scanlines, quiet outlined buttons.
- A failed request's count keeps its text in the reading colour and carries a red mark.

## 1.8.0 — 2026-10-12

### Added

- **Replay tab** (Agents | Commands | Replay). Your requests in this chat, newest first, each with
  "N edits · N files" (and how many failed). Pick one and its edits play one at a time: "Edit 3 of 4",
  Previous / Next, Play (one edit every 1.5 s), and a row of numbered marks named by file. Each edit
  names its file and folder, says in words what it did (+N lines added · −N lines removed, wrote the
  whole file, deleted, moved), who made it (the main agent or a helper) and when, then shows the
  lines: removed on red with −, added on green with +, context dimmed, "from line N" where Hermes
  recorded it. 40 lines first, then Show the rest; long lines scroll inside the box. A failed edit
  says why and that the file did not change. Read-only: no undo here. Changes made by scripts or
  commands are not shown, and the tab says so.
- Backend: `GET /replay` (the list, without lines) and `GET /replay_step` (one edit's lines; 403
  for another chat's edit).

### Fixed

- **An edit no longer counts twice after compression.** Compressing a chat writes a copy of the kept
  turns under the same call id; the files list counted the copy as a second edit (in this install
  12,235 of 32,214 recent call ids had such a copy). Each call is now read once.

## 1.7.0 — 2026-10-11

One look, one layout. The 1.6.0 deck tied agents to files with letters and colours, which read as a
code to learn; the page now names each agent by what it is doing and shows one agent at a time.

### Changed

- **One look: Terminal.** A CRT console whose ink and glow are your theme's accent (its statuses the
  theme's green, red and yellow, its ground derived from the theme background), with ASCII sprite
  boxes and `[RUN]` / `[OK ]` / `[ERR]` tags. No colour is hard-coded anywhere — the static audit's
  former exception for a fixed Terminal palette is gone. The status-bar chip takes the same look.
  Looks tried during 1.7.0 (Cockpit, Dot matrix, Live map) were removed; a choice an earlier build kept
  in `ctx.storage` reads as Terminal. Run text is never laid out in full: one line with an ellipsis,
  the whole of it (up to 300 characters) in the tooltip.
- **The main agent is a unit too,** the first one, starred (★ main-agent) and selected by default.
  Each unit's sprite is what it is doing — editing, reading, running a command, waiting, done, failed,
  stopped, idle. No letter badges anywhere.
- **One focus panel** below the units shows the selected agent. Its top is a hero: a bordered
  portrait with its status glyph, tagged MAIN or with its status tag, a verb line
  (▶ EDITING NOW, ✕ STOPPED WITH AN ERROR, …), a large headline — the file the main agent works on
  now, a subagent's task — and where / how long, with a subagent's model · effort chip. Labelled stat
  tiles follow: the main agent's on task (its first to last file touch) / files touched / changed /
  only read; a subagent's run time / tool calls / tokens / cost. Changed files are a grid of cards
  (name, folder, one block per edit up to 8 — more fill the row and the label says the real count —
  N EDITS / FAILED / DELETED; 1 block = 1 edit); the file worked on now leads with a NOW badge. Files
  only read are small chips with ×count and + N more. Terminal draws the same as bordered boxes with
  bar rows. A subagent's task (Show all) and its answer as a transmission card in its status colour
  (Terminal: a box labelled >> its answer), Copy answer and Open its chat as cut-corner keys. Hover a
  file for its full path, click to copy it; the note that terminal and code-run changes are not
  listed (Review › Last turn) stays.
- **Run picker** replaces the Earlier list: "Current run ▾" lists earlier runs with mini status
  cells, time ago, done/total and cost (+ Show N older runs); an earlier run is shown calmly with
  Back to now.
- **Tabs:** Agents | Commands (the badge counts running commands). The Commands tab says once what
  these are and opens each command in place: its exit code in an EXIT box, dir / ran chips, the output tail in a CRT box with line numbers and error lines highlighted,
  Copy output / Copy command. While it runs a radar says its output appears when it finishes; while
  the output is read a scan bar runs; an unreadable output says NO SIGNAL with Try again; an empty
  one says — IT PRINTED NOTHING —.
- **More than 8 subagents become a swarm:** the main agent on top ("waiting on N"), failed ones by
  name, working ones as small cells (hover names them, click selects), waiting and done collapsed.
  At narrow widths units wrap; nothing scrolls sideways.
- **Motion:** the score counts up as units finish, a failing one shakes red, the busy main agent
  breathes; a unit retypes its tag and the headline blinks a cursor. When a panel opens its
  numbers count up, the file cards appear in turn, a light sweeps the NOW card and the answer
  reveals. All of it is off under reduced motion.

### Removed

- Agent letters and colours, the live log, the separate Files section and the Earlier list — their
  information lives in the units, the focus panel and the run picker.

## 1.6.0 — 2026-10-11

A redesign: the page read as a plain admin list, every part the same weight, and nothing said which
agent touched which file. It is now a command deck — the running batch at a glance, each agent and its
files tied together by one letter and colour.

### Changed

- **The command deck replaces the live tree.** One big score (agents finished / all), one status cell
  per agent, the cost so far, and one unit per agent: its letter in an orb whose ring is its status
  (spinning yellow working, green done, red failed, dashed waiting), its name, model and time, and
  what it does right now ("editing desktop/plugin.js", from `subagent.tool`) — once ended, what it
  changed. A nested worker sits right after its parent and names it ("from F"). With nothing running
  the last batch is the deck (from state.db) and Earlier lists the rest; a finished batch keeps its
  open details and focus when it lands there.
- **Files are tiles in the colour of the agent that touched them,** with the badges of everyone who
  did (the chat's own as "Chat"); a file touched more glows brighter, the one being touched now has a
  band of light sweeping over it. `GET /files` now names who touched each file (`who`, the worker's
  first session id, its compressed later halves folded in) and who changed it (`editors`), replacing
  the `by_worker` count.
- Earlier rows carry the same letters.

### Added

- **Live log:** the last six things the chat's agents did while the page was open (started, each
  tool and its target, finished / failed), newest first, each with its agent's badge. Events only,
  nothing stored.

## 1.5.0 — 2026-10-11

Adds what a comparison with File Tree (a Claude Code mod that makes a file shimmer in a tree while
the agent touches it) found missing: Hermes' own file tree colours what git sees changed, but nothing
shows which file the agent is reading or editing right now. Every new lock has a canary that breaks it.

### Added

- **Files section.** The files the chat and its workers read or wrote with the file tools
  (`read_file`, `write_file`, `patch`), newest first, grouped by folder (the chat's folder by name,
  its sub-folders relative). Each file says read only / edited / deleted / last change failed, how
  often it was read and edited, and whether a worker touched it; a click copies its path. Read by the
  new `GET /files` from the tool calls `state.db` recorded: one file however its path is spelled
  (`path_key`, shared with the page through `tests/path_vectors.json`), a V4A patch read with Hermes'
  own parser (a move deletes its source and writes its target), a refused write or a compressed
  `FAILED` / `BLOCKED` stub counted as a failure, never an edit.
- **Shimmer.** A file tool call in the focused chat makes its row shimmer from `tool.start` until a
  moment after `tool.complete` (a file not yet recorded appears at the top); the finished call reloads
  the list. Stops for reduced motion.

### Not covered, on purpose and said on the page

- Edits made by terminal commands or code runs carry no path Hermes records (about 40% of
  write-like calls in a 30-day sample of this install's history). The section says so and points to
  Review › Last turn, which lists every change from git.
- A worker's calls reach the page as mirrored rows without arguments, and a V4A patch's files are
  inside its text: neither shimmers; both appear when the list reloads.

## 1.4.0 — 2026-10-11

Closes the gaps a comparison with Savvy Progress (a Claude Code subagent panel) found: cost, a
progress bar beside the chat, and a mascot. Every new lock has a canary that breaks it.

### Added

- **Cost per worker and per batch.** Each worker's spend as Hermes recorded it in `state.db`
  (`estimated_cost_usd` / `actual_cost_usd` / `cost_status`), summed over a compressed worker's
  halves. Shown as `~$1.25` (estimate), `$0.38` (billed) or `subscription`; a worker Hermes could not
  price is never shown as $0 — the batch tooltip counts priced, subscription and unpriced workers.
  A worker's detail shows its cost; Earlier and live batch headers show the batch total. A live
  worker's cost comes from its complete frame (`cost_usd`), taken only when positive: the frame has no
  cost status, so a 0 can be a subscription.
- **Progress chip in the status bar** for the focused chat's running batch: finished/total, a bar,
  the cost so far; red when a worker failed; click opens the page. It lingers 8 s after the batch ends.
  A status-bar chip, not a composer banner: a composer slot is given no session, so in a split layout
  every composer would show the focused chat's batch. Fed by a tracker of its own (the same events),
  so it shows while the page is closed; `subagent.list` picks up a batch already running and ends a
  worker whose complete frame never arrived; three failed polls turn it red and say so.
- **Pet line.** With a Hermes pet on screen (Settings → pet), the same progress is a line in its
  speech bubble (`Subagents 3/5 done · ~$4.20`), through `ctx.pet` — no mascot of the plugin's own,
  so there is one mascot system. Nothing is said while no pet is shown.

### Gates

- Core contract: `subagent.complete` still carries `cost_usd`; `CostStatus` still names exactly the
  four statuses read; `ctx.pet` keeps `say` / `clear` / `visible`; `host.navigate` and
  `STATUSBAR_AREAS` exist. CI's pinned core moves to the revision that has `ctx.pet`.

## 1.3.0 — 2026-10-10

1.2.0 was the reverted Attention Desk release; this version skips its number so the two are never
confused. Found by a design critique and an exploratory bug hunt; every fix has a check that fails on
1.1.10 and a canary that breaks it (98 canaries).

### Fixes

- **A queued worker is no longer marked stopped before it starts.** Hermes announces a worker
  (`spawn_requested`) before it registers it with `subagent.list`; the first poll in that window
  marked it stopped, and a batch whose workers were all queued was hidden from Now for its whole run.
  A queued worker the list does not show yet now waits up to 60 s.
- **A finished worker stays finished.** The registry lists a worker as running until Hermes' cleanup
  unregisters it; a poll in that window turned Done into running, then stopped.
- **Another conversation's workers are no longer served to a branch.** The compression lineage took
  a `/branch`, a reset fork, a tool child or a worker session for a continuation, so a branch listed
  (and could read the full output of) its source chat's workers and commands, and the walk down could
  follow a branch instead of the real continuation. It now uses Hermes' own fork rule.
- **A worker compressed mid-run is one row**, with its final answer, not two rows with the interim
  note as "Done".
- **Wrong-shape records no longer become a 500.** A checkpoint entry or receipt that is valid JSON of
  the wrong shape is counted as unreadable (the rest still list); a `processes.json` that is not a
  list is a 503.
- **A command with no receipt no longer shows a red 404.** It reads "No output was recorded." A
  command cut at 4,000 characters says so in its detail.
- **Toggling an Earlier batch or a command keeps keyboard focus** (it fell to the page body).
- **A finished batch no longer flashes the empty state**: it stays in Now until history has it.
- **A failed poll of the chat the page left no longer counts against the new chat.**
- **Copying an empty output says so** instead of "Copied". Two stored batches with the same start no
  longer share an open state.

### Design

- The header names the watched chat and marks it `held` when the page holds a chat the app no longer
  has focused. Its tint is red when a read failed, yellow while anything runs, neutral otherwise (it
  was green above an all-failed page). The running pill counts commands too.
- Copy full output and Open session are labelled buttons; the alert box has a Try again button.
- Cards are flat; only running and failed cards carry the status rail.
- A finished batch moves to Earlier with its open worker detail and keyboard focus.
- Below 420 px, Earlier counts and times keep their right-hand column. Opened cards no longer repeat
  the row's duration or exit code; the command block shows only when the row cannot show it whole.
- Unreadable records carry the failed mark.

### Checks

- `check_api.py`: lineage forks, compressed workers, conversation title, wrong-shape records.
- `render_check.mjs`: 25 new checks (header, focus, live races, hand-off, commands).
- `audit_static.py`: the `aria-expanded` rule reads class names inside a ternary (the open/closed
  header made it skip both expandable rows).
- `contract_core.py`: `sessions.source` and `sessions.title` are checked in the core.
- `canary_audit.py` runs the mutations in parallel (`SW_CANARY_JOBS`, default 8); one at a time the
  longer list outgrew the CI job's 25-minute limit. `render_check.mjs` takes `SW_RENDER_OUT` so
  parallel runs keep separate build folders.

## 1.1.10 — 2026-09-28

### Fixes

- **A click inside the panel no longer switches it to another chat.** The page followed the app's
  focused chat, and the app names its MAIN chat as focused once a zone that is not a chat is
  clicked. With the watched chat open as a tab beside another main chat, clicking a worker row
  moved the panel to the main chat ("No subagents yet"). The page now keeps the chat it shows while
  the last click or focus move landed in the panel or in another page's tile (`route-tile:` /
  `preview-tile:`), and follows the app on any other click (a chat, the Sessions sidebar).
  Copy full output reads for the watched chat too. `render_check.mjs` gains six checks (three fail
  on 1.1.9).
- **Canary #12 applies again.** 1.1.9 renamed the Earlier filter (`isLiveStored`) and the mutation's
  anchor stopped matching; it now targets the new line. Three canaries lock the watched-chat hold.

## 1.1.9 — 2026-09-27

### Fixes

- **Workers that finish early stay in the live tree.** The backend drops a worker from
  `subagent.list` the moment it finishes, and while any worker of a batch was still running the
  stored copy of that batch was hidden from Earlier, so a six-worker batch with five done read
  "1 worker 0/1" and the five finished workers showed nowhere. Those workers are now taken from
  state.db into the live tree, done, and counted in the header ("6 workers 5/6"); a worker the live
  tree already has is not added twice. `render_check.mjs` gains three checks (the first fails on 1.1.8).
- **The panel uses the full width of its pane.** `.sw-panel` no longer caps itself at 560 px.

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
