/**
 * Agent Station — read-only page for the focused chat's agents: the main agent, the delegate_task
 * subagents it started, and the shell commands it left running in the background.
 *
 *   Agents    one run at a time — the running one, else the last; the run picker opens earlier
 *             ones, calm, with "Back to now". A HUD: the FLEET schematic — the main agent (first and
 *             selected) as the core of an isometric station, each subagent a wing on it with a callout
 *             (its name, how it is doing); past ORBIT_WINGS subagents five wings for those that need eyes
 *             and one holding the rest — then time per agent, SPENT (cost, done / all), FILES, the selected AGENT, a LOG row per subagent, and
 *             one DETAIL focus panel for the selected agent: what it works on now, the files it changed and the ones it only
 *             read (from the backend's /files `who` / `editors`); a subagent's panel adds its task,
 *             model, answer, Copy answer (/output) and Open its chat.
 *             Fed by gateway `subagent.*` and `tool.*` events for the watched runtime session,
 *             reconciled by a `subagent.list` poll (session-scoped, so other chats never leak in),
 *             and by this plugin's backend (dashboard/plugin_api.py: /children, /files, /output;
 *             state.db opened read-only). Edits made through terminal commands or code runs carry
 *             no path and are not listed: the panel says so and points to Review › Last turn.
 *   Commands  shell commands the agent started with terminal(background=true), running and
 *             finished, from the backend's /processes; a row opens its exit code, folder and the
 *             end of its output (/process_output).
 *   Look      Terminal: a palette derived from the app theme's tokens (TM_PALETTE), a light mono and
 *             [RUN] / [OK ] tags. THEMES and the read of a kept look in ctx.storage stay for a
 *             second look (nothing writes it today); any kept value an earlier version wrote (Cockpit, Dot matrix, Live
 *             map) reads as Terminal.
 *   Progress  the focused chat's running batch as a status-bar chip (finished/total, a bar, the
 *             cost so far) and, when a pet is on screen, as a line in its speech bubble. Fed by
 *             a small tracker of its own, so it shows while the page is closed.
 *   Cost      each worker's spend as Hermes recorded it in state.db (estimated / billed / in a
 *             subscription / not priced) — shown, never computed or guessed here.
 *
 * Nothing here writes: no interrupt, no steer (the composer status stack already owns those).
 * Every failed read is shown in the page; nothing is swallowed. All motion stops under
 * prefers-reduced-motion.
 */
import { host, STATUSBAR_AREAS, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'agent-station'
const ROUTE = '/agent-station'
const POLL_MS = 3000
// A live poll that failed this many times in a row says so and slows to SLOW_POLL_MS; it never stops,
// so the page recovers by itself once the gateway answers again.
const MAX_POLL_FAILS = 3
const SLOW_POLL_MS = 30000
// Earlier runs listed in the run picker before "Show N older runs".
const HISTORY_PAGE = 8
// A stored batch still reading "running" is the live tree only when it started around the same time:
// one that started well before the live tree began is a crashed run and stays an earlier run.
const LIVE_MATCH_S = 120
// Hermes announces a worker (spawn_requested) while it is still being built and only registers it
// with subagent.list when it starts running. A queued worker the list does not show yet is waiting,
// not gone, until it has been unlisted this long.
const QUEUE_GRACE_S = 60
// A single-line command up to this length is read whole on its row in a 380 px dock; a longer or
// multi-line one gets the full text in its opened detail.
const ROW_COMMAND_CHARS = 28
const SUBAGENT_EVENTS = [
  'subagent.spawn_requested', 'subagent.start', 'subagent.progress', 'subagent.tool', 'subagent.complete'
]
// Hermes answers 4001 "session not found or not owned by this transport" while the focused runtime id
// is not live on this connection: a resume or reconnect in flight, or a reaped runtime the app is
// re-binding. That is not this page's failure, so a live poll says nothing and asks again slowly. The
// desktop's own pollers read the code the same way (apps/desktop/src/store/session-gone-latch.ts).
function isRuntimeGone(err) {
  if (typeof err?.code === 'number') return err.code === 4001
  return /session not found/i.test(String(err?.message ?? err ?? ''))
}
// Wire statuses (tui_gateway/contracts/common.py SubagentStatus) -> the five states this page draws.
const STATUS_OF = {
  queued: 'queued', running: 'running', completed: 'completed',
  failed: 'failed', error: 'failed', timeout: 'failed', interrupted: 'stopped', stopped: 'stopped'
}
const TERMINAL = new Set(['completed', 'failed', 'stopped'])
// Hermes' CostStatus values that carry an amount (agent/usage_pricing.py); 'included' is a
// subscription, 'unknown' could not be priced — neither is ever shown as $0.
const PRICED = new Set(['actual', 'estimated'])
// A finished batch stays on the status-bar chip (and in the pet's bubble) this long, then goes.
const PROGRESS_LINGER_MS = 8000
// The pet clamps a line's life to 30 s; a running batch's line is refreshed on every change.
const PET_LINE_MS = 30000
// The file tools whose calls name a file (tools/file_tools.py). search_files names a folder to look in.
const FILE_TOOLS = new Set(['read_file', 'write_file', 'patch'])
// A file tool call takes milliseconds: "working on now" keeps it this long after it ends, or nobody sees it.
const TOUCH_LINGER_MS = 4000
// A folder path longer than this is cut from the left (the end names it).
const DIR_CHARS = 48
// Rows a focus panel lists before "Show N more": changed files, files only read.
const CHANGED_ROWS = 8
// The only-read chips shown before '+ N more'.
const READ_ROWS = 6
// Blocks on a changed file's card: one per edit; more edits fill the row and the label says how many.
const PIPS = 8
// A subagent's task is shown up to this many characters before "Show all".
const TASK_CHARS = 180
// Text that comes from the run (a command, a task, an error) is never laid out in full: a label is
// one line ending in an ellipsis, and its tooltip holds at most TIP_CHARS of it.
const TIP_CHARS = 300
// An answer longer than this (or than ANSWER_LINES lines) opens folded to ANSWER_LINES lines.
const ANSWER_CHARS = 360
const ANSWER_LINES = 6
// How long a unit that just finished (or failed) plays its moment.
const FLASH_MS = 1400
const THEMES = ['terminal']
const THEME_KEY = 'theme'
// The main agent's unit key: never a subagent id or a session id.
const MAIN = 'main'

let ctxRef = null
// The stored id of the chat the page watches (see useWatchedChat), for reads deep in the tree.
const WatchedChat = createContext(null)

const BUNDLES = {
  en: {
    sw: {
      title: 'Agent Station',
      chat: {
        untitled: id => `Chat …${id}`
      },
      tabs: {
        label: 'Sections', agents: 'Agents', commands: 'Commands', replay: 'Replay',
        running: n => `${n} command${n === 1 ? '' : 's'} running`
      },
      retry: 'Try again',
      refresh: 'Refresh',
      nothingToCopy: 'Nothing to copy — it is empty',
      copying: 'Copying…',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      countFailed: 'Unknown — its source could not be read',
      loading: 'Reading this chat…',
      allFailed: 'Nothing to show while every read fails.',
      noChat: { title: 'No chat selected', body: 'Open a chat to see its agents and their files.' },
      run: {
        current: 'Current run',
        last: 'Last run',
        live: ago => `live · started ${ago}`,
        lastMeta: (ago, took) => ['last run', ago, took ? `took ${took}` : ''].filter(Boolean).join(' · '),
        past: (ago, took) => ['earlier run', ago, took ? `took ${took}` : ''].filter(Boolean).join(' · '),
        back: 'Back to now',
        earlier: 'Earlier runs',
        older: n => `Show ${n} older run${n === 1 ? '' : 's'}`,
        name: (first, others) => (others ? `${first} +${others}` : first),
        meta: (ago, done, total, cost) => [ago, `${done}/${total}`, cost].filter(Boolean).join(' · '),
        liveMeta: (done, total, cost) => ['live', `${done}/${total}`, cost].filter(Boolean).join(' · '),
        pick: 'Choose which run to show'
      },
      ago: { now: 'just now', m: n => `${n}m ago`, h: n => `${n}h ago`, yesterday: 'yesterday', d: n => `${n}d ago` },
      score: {
        status: 'Status',
        done: 'Subagents done',
        none: 'No subagents yet',
        spent: 'Spent',
        leg: (n, word) => `${n} ${word}`,
        label: (done, total) => `${done} of ${total} subagents done`
      },
      agents: 'Agents of this run',
      noSubagents: 'Subagents appear here when the main agent hands work off to a helper.',
      main: { name: 'Main agent', tag: 'main' },
      st: {
        running: 'working', completed: 'done', failed: 'failed', stopped: 'stopped', queued: 'waiting', idle: 'idle',
        waitingOn: n => `waiting on ${n}`
      },
      act: { edit: 'editing', read: 'reading', run: 'running', think: 'working', wait: 'waiting' },
      tag: {
        edit: '[EDIT]', read: '[READ]', run: '[RUN]', think: '[RUN]', wait: '[WAIT]', completed: '[OK ]', failed: '[ERR]',
        stopped: '[STP]', queued: '[WAIT]', idle: '[IDLE]'
      },
      verb: {
        read: 'reading', write: 'writing', edit: 'editing', search: 'searching', run: 'running a command',
        code: 'running code', delegate: 'starting subagents', web: 'on the web', other: name => `using ${name}`
      },
      focus: {
        mainLabel: 'Focus · main agent · this chat',
        subLabel: 'Focus · subagent',
        main: {
          working: verb => `${verb[0].toUpperCase()}${verb.slice(1)}`,
          waiting: n => `Waiting on ${n} subagent${n === 1 ? '' : 's'}`,
          busy: 'No tool running right now',
          idle: 'Waiting for your message',
          unknown: 'No tool running right now',
          in: dir => `in ${dir}`
        },
        line: {
          running: (time, act) => [time ? `Working ${time}` : 'Working', act].filter(Boolean).join(' — '),
          queued: 'Waiting in the queue',
          completed: time => (time ? `Done in ${time}` : 'Done'),
          failed: time => (time ? `Failed after ${time}` : 'Failed'),
          stopped: 'Stopped — closed before it finished'
        },
        did: (changed, read) => (changed
          ? `changed ${changed} file${changed === 1 ? '' : 's'}`
          : read ? `changed nothing, read ${read} file${read === 1 ? '' : 's'}` : 'touched no files'),
        startedBy: name => `started by ${name}`,
        now: 'Working on now',
        // the counts stand in the tiles above the lists, so the headings carry none
        changed: 'Changed',
        failedH: 'Edit failed',
        read: 'Only read',
        files: 'Files',
        noFiles: 'No files read or changed in this chat yet.',
        noFilesSub: 'No files read or changed with the file tools.',
        more: n => `Show ${n} more`,
        note: 'Click a file to copy its path. Changes made by terminal commands or code runs are not listed — Review › Last turn shows every change.',
        task: 'Task',
        showAll: 'Show all',
        showLess: 'Show less',
        answer: 'Its answer',
        answerCut: 'Shortened here — Copy answer copies all of it.',
        noAnswer: 'No answer was recorded.',
        copy: 'Copy answer',
        open: 'Open its chat'
      },
      hero: {
        // ▶ carries U+FE0E (text presentation): without it Windows draws a colour emoji
        now: verb => `▶\uFE0E ${verb.toUpperCase()} NOW`,
        waiting: n => `⧗ WAITING ON ${n} SUBAGENT${n === 1 ? '' : 'S'}`,
        working: '▶\uFE0E WORKING',
        idle: '○ IDLE',
        queued: '⧗ WAITING TO START',
        completed: '✓ DONE',
        failed: '✕ STOPPED WITH AN ERROR',
        stopped: '■ STOPPED BEFORE IT FINISHED'
      },
      tile: {
        onTask: 'first to last file', changed: 'changed', failed: 'edit failed', read: 'only read',
        runTime: 'run time', tools: 'tool calls', tokens: 'tokens', cost: 'cost'
      },
      hudAgents: {
        fleet: run => (run ? `Fleet · ${run}` : 'Fleet'),
        done: (done, total) => `${done}/${total} done`,
        orbitMain: word => `main · ${word}`,
        teleScan: 'scan', teleActive: 'active', teleStandby: 'standby', teleCore: 'core', teleWings: 'wings',
        orbitMore: n => `+${n} more`,
        orbitMoreLabel: (n, parts) => `${n} more subagents: ${parts}`,
        time: 'Time per agent',
        timeMore: (n, done) => `+${n} more · ${done} done`,
        noTime: 'Each subagent\'s run time appears here when it starts.',
        noSpent: 'Cost, tokens and tool calls appear here when a subagent runs.',
        spent: 'Spent',
        tokens: 'tokens',
        toolCalls: 'tools',
        agents: 'agents',
        agentsV: (n, done) => `${n} · ${done} done`,
        doneK: 'done',
        files: 'Files',
        changedN: n => `changed ${n}`,
        readN: n => `read ${n}`,
        legChanged: 'changed',
        legFailed: 'failed',
        legRead: 'read',
        filesLabel: (changed, failed, read) => `${changed} changed, ${failed} failed, ${read} only read`,
        moreFiles: n => `+${n}`,
        noFiles: 'Files appear here when an agent reads or changes one.',
        agent: 'Agent',
        model: 'model',
        timeK: 'time',
        toolsK: 'tools',
        toolsV: (tools, tokens, cost) => [String(tools), tokens ? `${tokens} tokens` : '', cost].filter(Boolean).join(' · '),
        task: 'task',
        state: 'state',
        subagents: 'subagents',
        filesK: 'files',
        filesV: (changed, failed, read) => [changed ? `${changed} changed` : '', failed ? `${failed} failed` : '', read ? `${read} read` : ''].filter(Boolean).join(' · '),
        log: 'Log',
        noLog: 'Each subagent gets a line here when it starts.',
        detail: 'Detail',
        pastRun: 'earlier run'
      },
      modelTip: (model, effort) => (effort ? `${model} · reasoning effort ${effort}` : model),
      replay: {
        why: 'Each request\'s file edits, one at a time. Read-only; script and command changes are not shown.',
        requests: 'Your requests, newest first',
        beforeFirst: 'Before your first request',
        noText: '(a request with no text)',
        count: (edits, files) => `${edits} edit${edits === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`,
        failedCount: n => `${n} failed`,
        olderTurns: n => `${n} older request${n === 1 ? '' : 's'} with edits not listed`,
        moreSteps: n => `${n} more edit${n === 1 ? '' : 's'} in this request not listed`,
        unreadable: n => `${n} edit${n === 1 ? '' : 's'} could not be read`,
        none: 'File edits appear here when the AI changes a file.',
        of: (i, n) => `Edit ${i} of ${n}`,
        prev: 'Previous edit',
        next: 'Next edit',
        play: 'Play',
        pause: 'Pause',
        playTip: 'Plays the edits on its own: removed lines are struck out, added lines typed in, then the next edit',
        stepLabel: (i, name, failed) => `Edit ${i}: ${name}${failed ? ' (failed)' : ''}`,
        markTip: (path, failed) => (failed ? `${path}
This edit failed` : path),
        by: name => `by helper: ${name}`,
        byMain: 'by the main agent',
        at: when => `at ${when}`,
        whole: n => `Wrote the whole file · ${n} line${n === 1 ? '' : 's'}`,
        changed: (added, removed) => `+${added} line${added === 1 ? '' : 's'} added · −${removed} line${removed === 1 ? '' : 's'} removed`,
        deleted: 'Deleted the file',
        moved: to => `Moved the file to ${to}`,
        failed: why => (why ? `This edit failed: ${why}` : 'This edit failed'),
        failedNote: 'It was tried, not applied: the file did not change.',
        noLines: 'No lines changed',
        from: n => (n ? `from line ${n}` : 'next part'),
        part: (added, removed) => (added && removed ? `${removed} line${removed === 1 ? '' : 's'} replaced` : added ? `${added} line${added === 1 ? '' : 's'} added` : `${removed} line${removed === 1 ? '' : 's'} removed`),
        removedSign: 'removed',
        addedSign: 'added',
        rest: n => `Show the rest (${n} more line${n === 1 ? '' : 's'})`,
        notLoaded: n => `${n} more line${n === 1 ? '' : 's'} of this edit not loaded (too long)`,
        reading: 'Reading this edit…',
        diff: 'Diff',
        applied: 'Applied',
        notApplied: 'Not applied',
        replaying: 'Replaying…',
        paused: 'Paused',
        playback: 'Playback',
        linesChanged: 'Lines changed',
        thisEdit: 'This edit',
        lines: n => `${n} line${n === 1 ? '' : 's'}`,
        max: n => `${n} max`,
        soFar: 'Lines so far',
        file: 'File',
        folder: 'Folder',
        change: 'Change',
        request: 'Request',
        log: n => `Log · ${n} edit${n === 1 ? '' : 's'}`,
        word: { edit: 'EDIT', whole: 'WRITE', delete: 'DELETE', move: 'MOVE', failed: 'FAILED' },
        worm: 'Wormhole',
        wormLabel: 'Edits of this request as rings on a wormhole',
        wormMain: (k, n) => `replay · edit ${k} of ${n}`,
        teleEdits: 'edits', teleWrites: 'writes', teleFailed: 'failed', teleAdded: 'added', teleRemoved: 'removed', teleFiles: 'files'
      },
      hudCommands: {
        console: 'Console',
        list: n => `Commands · ${n}`,
        process: 'Process',
        command: 'command',
        lines: 'lines',
        finished: 'Finished',
        failed: 'Failed',
        running: 'Running',
        stopped: 'Stopped',
        firstError: 'First error',
        line: n => `Line ${n}`,
        orbit: 'Orbit',
        orbitLabel: 'Background commands in orbit',
        orbitMain: n => n ? `orbit · ${n} in flight` : 'orbit · parked',
        teleLink: 'link', teleOrbits: 'orbits', teleEnded: 'ended'
      },
      file: {
        op: {
          active: 'now', write: n => `${n} edit${n === 1 ? '' : 's'}`, delete: 'deleted', failed: n => `${n} failed`, read: n => `read ×${n}`
        },
        nowBadge: 'NOW',
        nowLabel: label => `${label}, worked on now`,
        tip: path => `${path}\nClick to copy the path`,
        name: (name, dir, label) => `${name} in ${dir}: ${label}`,
        copied: 'Path copied',
        here: 'chat folder',
        notListed: n => `${n} older file${n === 1 ? '' : 's'} not listed`,
        unreadable: n => `${n} tool call${n === 1 ? '' : 's'} could not be read`
      },
      proc: {
        why: 'Terminal commands the agent started and left running in the background — not subagents.',
        none: 'Background commands appear here when the agent leaves one running.',
        short: { running: 'Running', completed: 'Finished', failed: 'Failed', stopped: 'Stopped' },
        status: {
          running: 'Running', completed: 'Finished (exit 0)', failed: 'Failed', stopped: 'Stopped before it finished'
        },
        exit: c => `exit ${c}`,
        noExit: 'no exit code recorded',
        exitTag: 'exit',
        killed: 'killed',
        killedTag: 'killed',
        dirK: 'dir',
        ranK: 'ran',
        runningK: 'running',
        lines: n => `${n} line${n === 1 ? '' : 's'}`,
        noSignal: 'NO SIGNAL',
        copyCommand: 'Copy command',
        copyOutput: 'Copy output',
        output: 'Last lines of output',
        outputCut: n => `last ${n} characters`,
        commandCut: n => `Only the first ${n} characters of this command are shown and copied.`,
        noOutput: 'No output was recorded.',
        printedNothing: '— IT PRINTED NOTHING —',
        whileRunning: 'Still running — its output appears here when it finishes.',
        reading: 'Reading its output…',
        unreadable: n => `${n} record${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'is' : 'are'} not listed`
      },
      status: {
        completed: 'Done', failed: 'Failed', running: 'Running', queued: 'Queued',
        stopped: 'Stopped — closed before it finished'
      },
      cost: {
        est: amount => `~${amount}`,
        under: '<$0.01',
        included: 'subscription',
        tip: (priced, included, unknown) => [
          'Cost as Hermes recorded it (~ is an estimate)',
          priced ? `${priced} priced` : '',
          included ? `${included} in a subscription` : '',
          unknown ? `${unknown} not priced (yet)` : ''
        ].filter(Boolean).join(' · ')
      },
      progress: {
        tip: (finished, total, failed, running, cost) => [
          `Subagents in this chat: ${finished} of ${total} finished`,
          failed ? `${failed} failed or stopped` : '',
          running ? `${running} running` : '',
          cost ? `cost ${cost}` : ''
        ].filter(Boolean).join(' · ') + '. Click to open Agent Station.',
        pet: (finished, total, cost) => [`Subagents ${finished}/${total} done`, cost].filter(Boolean).join(' · '),
        stalled: detail => `Subagent progress is not updating, retrying: ${detail}`
      },
      units: {
        hm: (h, m) => `${h}h ${m}m`,
        ms: (m, s) => `${m}m ${s}s`,
        s: s => `${s}s`,
        k: n => `${n}k`
      },
      err: {
        replay: 'Replay',
        replayStep: 'This edit',
        title: 'Some parts could not be read:',
        history: 'earlier runs',
        live: 'live updates failing, retrying',
        procs: 'background commands',
        files: 'the files list',
        item: (what, detail) => `${what} — ${detail}`,
        output: 'Could not read the full answer',
        procOutput: 'Could not read its output',
        withDetail: (what, detail) => `${what}: ${detail}`
      }
    }
  }
}

// ── pure helpers (exported for the render check) ─────────────────────────────

/** The English bundle as a `t`, for helpers called without the page's translator. */
function enT(key, ...args) {
  let node = BUNDLES.en
  for (const part of key.split('.')) node = node?.[part]
  return typeof node === 'function' ? node(...args) : (node ?? key)
}

export function fmtDuration(s, t = enT) {
  if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return ''
  const v = Math.round(s)
  if (v >= 3600) return t('sw.units.hm', Math.floor(v / 3600), Math.floor((v % 3600) / 60))
  if (v >= 60) return t('sw.units.ms', Math.floor(v / 60), String(v % 60).padStart(2, '0'))
  return t('sw.units.s', v)
}

export function fmtTokens(n, t = enT) {
  if (!n) return ''
  return n >= 1000 ? t('sw.units.k', Math.round(n / 1000)) : String(n)
}

/** How long ago, in words: 'just now', '5m ago', '2h ago', 'yesterday', '3d ago'. */
export function fmtAgo(s, t = enT) {
  if (s === null || s === undefined || !Number.isFinite(s)) return ''
  const v = Math.max(0, Math.round(s))
  if (v < 60) return t('sw.ago.now')
  if (v < 3600) return t('sw.ago.m', Math.floor(v / 60))
  if (v < 86400) return t('sw.ago.h', Math.floor(v / 3600))
  if (v < 2 * 86400) return t('sw.ago.yesterday')
  return t('sw.ago.d', Math.floor(v / 86400))
}

/** Hermes' cost record as text: '~$1.25' estimated, '$0.38' billed, 'subscription', '' unpriced. */
export function fmtCost(usd, status, t = enT) {
  if (status === 'included') return t('sw.cost.included')
  if (!PRICED.has(status) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return ''
  if (usd > 0 && usd < 0.005) return t('sw.cost.under')
  const amount = `$${usd.toFixed(2)}`
  return status === 'estimated' ? t('sw.cost.est', amount) : amount
}

/** A set of workers' spend: priced ones summed; subscription and unpriced ones counted, never as $0. */
export function sumCost(workers) {
  let usd = 0
  let priced = 0
  let included = 0
  let unknown = 0
  let estimated = false
  for (const w of workers) {
    if (w.cost_status === 'included') included++
    else if (PRICED.has(w.cost_status) && typeof w.cost_usd === 'number' && Number.isFinite(w.cost_usd)) {
      usd += w.cost_usd
      priced++
      estimated = estimated || w.cost_status === 'estimated'
    } else unknown++
  }
  const status = priced ? (estimated ? 'estimated' : 'actual') : included && !unknown ? 'included' : 'unknown'
  return { usd: priced ? usd : null, status, priced, included, unknown }
}

/** One line a person can read: the goal's first line, a quoted slug when there is one. */
export function workerName(goal) {
  const line = String(goal || '').trim().split('\n', 1)[0]
  const slug = line.match(/'([a-z0-9][a-z0-9._-]{2,40})'/i)
  return slug ? slug[1] : line
}

/**
 * Names for sibling units: when several share a long opening ('Blind-review desktop panel 1: …',
 * '… panel 2: …') a narrow pane cuts them all to the same text. The shared words are dropped (the
 * last one kept for context) so what tells the units apart is what stays visible.
 */
export function distinctNames(goals) {
  const names = goals.map(workerName)
  if (names.length < 2) return names
  let common = names[0]
  for (const n of names) while (common && !n.startsWith(common)) common = common.slice(0, -1)
  const words = common.slice(0, common.lastIndexOf(' ') + 1).split(' ').filter(Boolean)
  if (words.length < 2 || words.join(' ').length < 12) return names
  const cut = words.slice(0, -1).join(' ').length + 1
  // No leading ellipsis: the label is already cut at its end where the pane is narrow, and a name cut
  // at both ends reads as damaged. The tooltip keeps the whole task.
  return names.map(n => (n.length > cut ? n.slice(cut) : n))
}

/** A name as the Terminal theme prints it: 'Pact weapon marker' -> 'pact-weapon-marker'. */
export function slugName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9…]+/g, '-').replace(/^-+|-+$/g, '') || '-'
}

/** Model slug without a provider prefix: 'anthropic/claude-opus-5-5' -> 'claude-opus-5-5'. */
export function modelLabel(model) {
  return String(model || '').split('/').pop()
}

/** Chip text: the model label, then the reasoning effort when the worker ran with one. */
/** A tooltip's text: the whole of a short text, the first TIP_CHARS of a long one. */
export function tipText(text) {
  const s = String(text ?? '').trim()
  return s.length > TIP_CHARS ? `${s.slice(0, TIP_CHARS - 1)}…` : s
}

/** One line of run text: cut with an ellipsis by CSS, the whole of it (capped) in the tooltip. */
function OneLine({ text, className = '' }) {
  const s = String(text ?? '')
  return jsx(Tip, { label: tipText(s), children: jsx('span', { className: `sw-1l ${className}`.trim(), tabIndex: 0, children: s }) })
}

export function modelChip(model, effort) {
  const m = modelLabel(model)
  return m && effort ? `${m} · ${effort}` : m
}

export function batchState(statuses) {
  for (const s of ['running', 'queued', 'failed', 'stopped']) if (statuses.includes(s)) return s
  return 'completed'
}

/** Live records -> batches keyed by delegation_id, each a forest by parent_id. */
export function liveBatches(records) {
  const byDelegation = new Map()
  for (const r of records) {
    const key = r.delegation_id || `solo:${r.subagent_id}`
    if (!byDelegation.has(key)) byDelegation.set(key, [])
    byDelegation.get(key).push(r)
  }
  return [...byDelegation.entries()].map(([id, rows]) => {
    const ids = new Set(rows.map(r => r.subagent_id))
    const kids = new Map()
    const roots = []
    for (const r of rows.sort((a, b) => (a.task_index ?? 0) - (b.task_index ?? 0))) {
      if (r.parent_id && ids.has(r.parent_id)) {
        if (!kids.has(r.parent_id)) kids.set(r.parent_id, [])
        kids.get(r.parent_id).push(r)
      } else {
        roots.push(r)
      }
    }
    return { id, rows, roots, kids }
  })
}

// What a tool call reads as: the verb of a sentence ("running a command npm test") and the icon a
// unit draws for it (edit pencil, read eye, run prompt; anything else is plain working).
const VERB = {
  read_file: 'read', write_file: 'write', patch: 'edit', search_files: 'search', terminal: 'run', process: 'run',
  execute_code: 'code', delegate_task: 'delegate', web_search: 'web', web_extract: 'web', browser_exec: 'web'
}
const ACT_OF = { read: 'read', search: 'read', web: 'read', write: 'edit', edit: 'edit', run: 'run', code: 'run', delegate: 'wait' }

/** The icon of a running agent's current tool: 'edit' | 'read' | 'run' | 'wait' (it started subagents) | 'think'. */
export function toolAct(tool) {
  return ACT_OF[VERB[tool]] || 'think'
}

/** A tool's preview as a short target: a path keeps its last two parts, anything else its first line. */
export function shortTarget(text) {
  const line = String(text || '').trim().split('\n', 1)[0]
  if (!/[\\/]/.test(line) || /\s/.test(line)) return line
  return line.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')
}

/** What a unit's icon shows: its activity while it runs, else its end (or the queue). */
export function unitIcon(u) {
  if (u.status === 'running') return u.act || 'think'
  return { completed: 'ok', failed: 'bad', stopped: 'stop', queued: 'wait' }[u.status] || 'idle'
}

/** A live batch as units: each root, then the workers it started (right after it). */
export function liveUnits(batch, now) {
  const out = []
  const walk = (rows, parent) => {
    rows.forEach(r => {
      out.push({
        key: r.subagent_id, sid: r.child_session_id || r.session_id || null, rec: r, parent,
        status: r.status, act: r.status === 'running' ? toolAct(r.last_tool) : null,
        duration: r.duration_s ?? (r.started_at ? now - r.started_at : null)
      })
      walk(batch.kids.get(r.subagent_id) || [], r.subagent_id)
    })
  }
  walk(batch.roots, null)
  // Named across the whole run: a nested worker sits beside its parent's siblings, not under them.
  const names = distinctNames(out.map(u => u.rec.goal))
  return out.map((u, i) => ({ ...u, name: names[i] }))
}

/** A stored batch as units, keyed by session id. */
export function storedUnits(batch) {
  const names = distinctNames(batch.workers.map(w => w.goal))
  return batch.workers.map((w, i) => ({
    key: w.session_id, sid: w.session_id, rec: w, name: names[i], parent: null, status: w.status, act: null, duration: w.duration_s
  }))
}

// ── marks ────────────────────────────────────────────────────────────────────

const svg = (children, cls) => jsx('svg', { viewBox: '0 0 24 24', className: cls, 'aria-hidden': 'true', children })
const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const path = (d, key) => jsx('path', { d, ...LINE }, key)
// What a unit's icon draws: its activity while it works (edit pencil, read eye, run prompt, waiting
// hourglass, plain working pulse), else how it ended. Never a letter.
const ICON = {
  edit: () => svg([path('M12 20h9', 'a'), path('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 'b')]),
  read: () => svg([path('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'a'), jsx('circle', { cx: 12, cy: 12, r: 3, ...LINE }, 'b')]),
  run: () => svg([path('M4 17l6-5-6-5', 'a'), path('M12 19h8', 'b')]),
  think: () => svg(path('M3 12h4l3-7 4 14 3-7h4')),
  wait: () => svg([path('M6 3h12M6 21h12', 'a'), path('M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9', 'b')]),
  ok: () => svg(path('M20 6L9 17l-5-5')),
  bad: () => svg(path('M18 6L6 18M6 6l12 12')),
  stop: () => svg(jsx('rect', { x: 6, y: 6, width: 12, height: 12, rx: 1.5, ...LINE })),
  idle: () => svg([jsx('circle', { cx: 12, cy: 12, r: 8, ...LINE }, 'a'), path('M9 12h6', 'b')]),
  copy: () => svg([jsx('rect', { x: 9, y: 9, width: 12, height: 12, rx: 2, ...LINE }, 'a'), path('M5 15V5a2 2 0 0 1 2-2h10', 'b')]),
  open: () => svg([path('M14 4h6v6', 'a'), path('M20 4l-9 9', 'b'), path('M18 14v6H4V6h6', 'c')]),
  refresh: () => svg([path('M20 12a8 8 0 1 1-2.3-5.6', 'a'), path('M20 4v4h-4', 'b')]),
  chev: open => svg(path(open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'))
}
// The Terminal look draws the same icon as a glyph inside an ASCII box.
const GLYPH = { edit: '✎', read: '◉', run: '>_', think: '··', wait: '⧗', ok: '✓', bad: '✗', stop: '■', idle: '○' }
// Status-bar marks (the chip): a filled disc for an end, a ring for running or waiting.
const GLYPH_INK = 'var(--dt-background)'
const MARKS = {
  completed: () => svg([jsx('circle', { cx: 12, cy: 12, r: 10, fill: 'var(--ui-green)' }, 'c'), jsx('path', { d: 'M7.5 12.3l3 3 6-6.2', fill: 'none', stroke: GLYPH_INK, strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' }, 'p')]),
  failed: () => svg([jsx('circle', { cx: 12, cy: 12, r: 10, fill: 'var(--ui-red)' }, 'c'), jsx('path', { d: 'M8.5 8.5l7 7M15.5 8.5l-7 7', stroke: GLYPH_INK, strokeWidth: 2.6, strokeLinecap: 'round' }, 'p')]),
  stopped: () => svg([jsx('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'var(--ui-text-tertiary)', strokeWidth: 2 }, 'c'), jsx('rect', { x: 8.5, y: 8.5, width: 7, height: 7, rx: 1, fill: 'var(--ui-text-tertiary)' }, 'r')]),
  running: () => svg([jsx('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'var(--ui-stroke-secondary)', strokeWidth: 2.4 }, 'c'), jsx('path', { d: 'M12 3a9 9 0 0 1 9 9', fill: 'none', stroke: 'var(--ui-yellow)', strokeWidth: 2.4, strokeLinecap: 'round' }, 'a')], 'sw-spin'),
  queued: () => svg(jsx('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'var(--ui-text-quaternary)', strokeWidth: 2, strokeDasharray: '3.4 3' }))
}

// `text`: the label is also drawn beside the icon — the page's primary verbs are read, not hovered for.
function IconButton({ label, icon, onClick, disabled, busy, text, primary }) {
  const button = jsx('button', {
    type: 'button', className: `sw-ib${text ? ' is-text' : ''}${primary ? ' is-pri' : ''}${busy ? ' is-busy' : ''}`, 'aria-label': label, 'aria-busy': busy ? 'true' : undefined,
    disabled: disabled || busy, onClick, children: text ? [jsx('span', { className: 'sw-ibi', children: icon() }, 'i'), jsx('span', { children: label }, 't')] : icon()
  })
  return text ? button : jsx(Tip, { label, children: button })
}

/** One cell per agent, in its status colour. */
function Cells({ statuses, className = 'sw-cells' }) {
  return jsx('span', {
    className, 'aria-hidden': 'true',
    children: statuses.map((s, i) => jsx('i', { 'data-st': s }, i))
  })
}

// ── look: Terminal ───────────────────────────────────────────────────────────
//
// A look is read from the plugin's own storage (ctx.storage); nothing on the page writes it while
// Terminal is the only look. Storage is a convenience: when
// it is missing, holds something else, or throws, the page draws Terminal and keeps working. A look an
// earlier version kept (Cockpit, Dot matrix, Live map) is no longer a look, so it reads as Terminal too.

function readTheme() {
  try {
    const kept = ctxRef?.storage?.get?.(THEME_KEY, THEMES[0])
    return THEMES.includes(kept) ? kept : THEMES[0]
  } catch (err) {
    console.warn(`[${ID}] could not read the kept look; using ${THEMES[0]}`, err)
    return THEMES[0]
  }
}

function useTheme() {
  const [theme] = useState(readTheme)
  return [theme]
}

// ── data hooks ───────────────────────────────────────────────────────────────

function useNow(active) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!active) return undefined
    return ctxRef.setInterval(() => setNow(Date.now() / 1000), 1000)
  }, [active])
  return now
}

/** Earlier batches for one stored session, from the plugin backend. */
function useHistory(storedId) {
  const [state, setState] = useState({ key: null, data: null, error: null, loading: false })
  const gen = useRef(0)
  const load = useCallback(() => {
    if (!storedId) {
      setState({ key: null, data: null, error: null, loading: false })
      return
    }
    const mine = ++gen.current
    // Another chat's data and error never ride along into this one.
    setState(prev => (prev.key === storedId ? { ...prev, loading: true } : { key: storedId, data: null, error: null, loading: true }))
    // Returned so a caller can wait for the answer (a finished batch stays in Now until history has it).
    return ctxRef.rest(`/children?session_id=${encodeURIComponent(storedId)}`).then(
      data => {
        if (mine === gen.current) setState({ key: storedId, data, error: null, loading: false })
        return mine === gen.current ? data : null
      },
      err => { if (mine === gen.current) setState(prev => ({ ...prev, error: String(err?.message || err), loading: false })) }
    )
  }, [storedId])
  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

/**
 * Background shell processes of one stored session, from the plugin backend, polled every POLL_MS
 * so a command started after the page opened appears without a refresh. The backend parses each
 * finished receipt once, so a poll is a directory listing plus a small JSON file.
 */
function useProcesses(storedId) {
  const [state, setState] = useState({ key: null, data: null, error: null })
  const gen = useRef(0)
  const load = useCallback(() => {
    if (!storedId) {
      setState({ key: null, data: null, error: null })
      return
    }
    const mine = ++gen.current
    setState(prev => (prev.key === storedId ? prev : { key: storedId, data: null, error: null }))
    ctxRef.rest(`/processes?session_id=${encodeURIComponent(storedId)}`).then(
      data => { if (mine === gen.current) setState({ key: storedId, data, error: null }) },
      err => { if (mine === gen.current) setState(prev => ({ ...prev, key: storedId, error: String(err?.message || err) })) }
    )
  }, [storedId])
  useEffect(() => {
    load()
    if (!storedId) return undefined
    return ctxRef.setInterval(load, POLL_MS)
  }, [load])
  const own = state.key === storedId ? state : { data: null, error: null }
  // Loading = this chat's first read has not answered yet (later polls keep the last answer shown).
  return { ...own, loading: Boolean(storedId) && !own.data && !own.error, reload: load }
}

/** The files one stored session read or wrote, from the plugin backend; polled like the commands. */
function useFiles(storedId) {
  const [state, setState] = useState({ key: null, data: null, error: null })
  const gen = useRef(0)
  const load = useCallback(() => {
    if (!storedId) {
      setState({ key: null, data: null, error: null })
      return
    }
    const mine = ++gen.current
    setState(prev => (prev.key === storedId ? prev : { key: storedId, data: null, error: null }))
    ctxRef.rest(`/files?session_id=${encodeURIComponent(storedId)}`).then(
      data => { if (mine === gen.current) setState({ key: storedId, data, error: null }) },
      err => { if (mine === gen.current) setState(prev => ({ ...prev, key: storedId, error: String(err?.message || err) })) }
    )
  }, [storedId])
  useEffect(() => {
    load()
    if (!storedId) return undefined
    return ctxRef.setInterval(load, POLL_MS)
  }, [load])
  const own = state.key === storedId ? state : { data: null, error: null }
  return { ...own, loading: Boolean(storedId) && !own.data && !own.error, reload: load }
}

/**
 * The edits one stored session made, grouped under the user's requests, from the plugin backend:
 * read while the Replay tab is open and polled like the commands (the backend answers from a cache
 * until a message lands). An edit's lines are read when it is shown, once each.
 */
function useReplay(storedId, on) {
  const [state, setState] = useState({ key: null, data: null, error: null })
  const gen = useRef(0)
  const load = useCallback(() => {
    if (!storedId || !on) return
    const mine = ++gen.current
    setState(prev => (prev.key === storedId ? prev : { key: storedId, data: null, error: null }))
    ctxRef.rest(`/replay?session_id=${encodeURIComponent(storedId)}`).then(
      data => { if (mine === gen.current) setState({ key: storedId, data, error: null }) },
      err => { if (mine === gen.current) setState(prev => ({ ...prev, key: storedId, error: String(err?.message || err) })) }
    )
  }, [storedId, on])
  useEffect(() => {
    load()
    if (!storedId || !on) return undefined
    return ctxRef.setInterval(load, POLL_MS)
  }, [load])
  const own = state.key === storedId ? state : { data: null, error: null }
  return { ...own, loading: Boolean(storedId) && on && !own.data && !own.error, reload: load }
}

function useReplayStep(storedId, stepId) {
  const cache = useRef(new Map())
  const [, bump] = useState(0)
  useEffect(() => { cache.current = new Map() }, [storedId])
  const key = storedId && stepId ? `${storedId}|${stepId}` : ''
  useEffect(() => {
    if (!key || cache.current.has(key)) return
    cache.current.set(key, { loading: true })
    ctxRef.rest(`/replay_step?session_id=${encodeURIComponent(storedId)}&step_id=${encodeURIComponent(stepId)}`).then(
      data => { cache.current.set(key, { data }); bump(n => n + 1) },
      err => { cache.current.set(key, { error: String(err?.message || err) }); bump(n => n + 1) }
    )
  }, [key])
  return key ? cache.current.get(key) || { loading: true } : {}
}

/**
 * What the focused chat's own agent (the main agent) is doing, from its `tool.*` events: the tool it
 * runs now, and the files its file tool calls touch now. tool.start adds a file, tool.complete ends
 * it, and each stays TOUCH_LINGER_MS after its call ends (a file call takes milliseconds). A
 * finished file call reloads the files list. Workers' calls reach the page only as a mirrored row
 * without arguments, so they show when the list reloads.
 */
function useMainTools(runtimeId, cwd, onDone) {
  const [touching, setTouching] = useState(() => new Map())
  const [tools, setTools] = useState(() => new Map())
  const calls = useRef(new Map())
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    setTouching(new Map())
    setTools(new Map())
    calls.current = new Map()
    if (!runtimeId) return undefined
    const timers = new Set()
    const offStart = ctxRef.onEvent('tool.start', event => {
      if (event?.session_id !== runtimeId) return
      const p = event.payload || {}
      if (!p.tool_id) return
      const args = p.args && typeof p.args === 'object' ? p.args : {}
      const target = shortTarget(args.path || args.command || args.query || args.url || '')
      setTools(prev => new Map(prev).set(p.tool_id, { name: p.name, target }))
      const targets = fileTargets(p.name, p.args)
      if (!targets.length) return
      const keys = targets.map(({ path: file, op }) => {
        const full = resolvePath(file, cwdRef.current)
        return { key: pathKey(full), path: full, op }
      })
      calls.current.set(p.tool_id, keys)
      setTouching(prev => {
        const next = new Map(prev)
        for (const k of keys) next.set(k.key, { path: k.path, op: k.op, live: (prev.get(k.key)?.live || 0) + 1 })
        return next
      })
    })
    const offDone = ctxRef.onEvent('tool.complete', event => {
      if (event?.session_id !== runtimeId) return
      const id = event.payload?.tool_id
      setTools(prev => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      const keys = calls.current.get(id)
      if (!keys) return
      calls.current.delete(id)
      doneRef.current?.()
      const stop = ctxRef.setTimeout(() => {
        timers.delete(stop)
        setTouching(prev => {
          const next = new Map(prev)
          for (const k of keys) {
            const cur = next.get(k.key)
            if (!cur) continue
            if (cur.live > 1) next.set(k.key, { ...cur, live: cur.live - 1 })
            else next.delete(k.key)
          }
          return next
        })
      }, TOUCH_LINGER_MS)
      timers.add(stop)
    })
    return () => {
      offStart()
      offDone()
      timers.forEach(stop => stop())
    }
  }, [runtimeId])
  // The newest tool still running is what the main agent does now.
  const tool = [...tools.values()].pop() || null
  return { touching, tool }
}

/**
 * A complete frame's `cost_usd` is Hermes' session estimate. The frame carries no cost status, so a
 * 0 can be a subscription or an unpriced model: only a positive amount is taken (as an estimate).
 */
function eventCost(p) {
  return typeof p.cost_usd === 'number' && Number.isFinite(p.cost_usd) && p.cost_usd > 0
    ? { cost_usd: p.cost_usd, cost_status: 'estimated' }
    : {}
}

function mergeRecord(prev, patch) {
  const next = { ...prev }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) next[k] = v
  return next
}

/** Live workers of the focused runtime session: events + a reconciling `subagent.list` poll. */
function useLive(runtimeId, onBatchEnded) {
  const [records, setRecords] = useState({})
  const [error, setError] = useState(null)
  const fails = useRef(0)
  const pollRef = useRef(null)
  // Workers already handed to history: a later subagent.list that still returns them must not
  // bring the batch back (and trigger another history reload).
  const gone = useRef(new Set())
  const endedRef = useRef(onBatchEnded)
  endedRef.current = onBatchEnded

  useEffect(() => {
    setRecords({})
    setError(null)
    fails.current = 0
    gone.current = new Set()
    if (!runtimeId) return undefined

    const upsert = patch => setRecords(prev => ({ ...prev, [patch.subagent_id]: mergeRecord(prev[patch.subagent_id] || {}, patch) }))
    const offs = SUBAGENT_EVENTS.map(type => ctxRef.onEvent(type, event => {
      if (event?.session_id !== runtimeId) return
      const p = event.payload || {}
      if (!p.subagent_id || gone.current.has(p.subagent_id)) return
      const base = {
        subagent_id: p.subagent_id, parent_id: p.parent_id, delegation_id: p.delegation_id, depth: p.depth,
        goal: p.goal, model: p.model, task_index: p.task_index, child_session_id: p.child_session_id,
        tool_count: p.tool_count
      }
      if (type === 'subagent.spawn_requested') upsert({ ...base, status: 'queued', queued_at: Date.now() / 1000 })
      else if (type === 'subagent.start') upsert({ ...base, status: 'running', started_at: Date.now() / 1000 })
      else if (type === 'subagent.tool') upsert({ ...base, last_tool: p.tool_name, tool_preview: p.tool_preview })
      else if (type === 'subagent.progress') upsert(base)
      else if (type === 'subagent.complete') {
        upsert({
          ...base, status: STATUS_OF[p.status] || 'completed', summary: p.summary, duration_s: p.duration_seconds,
          tokens: (p.input_tokens || 0) + (p.output_tokens || 0), ended_at: Date.now() / 1000,
          ...eventCost(p)
        })
      }
    }))

    let alive = true
    let next = () => {}
    const poll = async () => {
      if (!alive) return
      let wait = POLL_MS
      try {
        const snap = await host.request('subagent.list', { session_id: runtimeId })
        if (!alive) return
        fails.current = 0
        setError(null)
        const seen = new Set()
        const at = Date.now() / 1000
        setRecords(prev => {
          const next = { ...prev }
          for (const r of snap?.subagents || []) {
            if (gone.current.has(r.subagent_id)) continue
            seen.add(r.subagent_id)
            const had = prev[r.subagent_id]
            // A worker's end is final: the registry still lists it as running for a moment after its
            // complete frame (Hermes unregisters it in cleanup), and that snapshot must not revive it.
            const status = TERMINAL.has(had?.status) ? had.status : (STATUS_OF[r.status] || r.status)
            next[r.subagent_id] = mergeRecord(had || {}, { ...r, status })
          }
          // A worker the backend no longer tracks ended without a complete frame reaching us — unless
          // it is still queued: Hermes lists a worker only once it starts, so give it QUEUE_GRACE_S.
          for (const [id, r] of Object.entries(next)) {
            if (seen.has(id) || TERMINAL.has(r.status)) continue
            if (r.status === 'queued' && at - (r.queued_at ?? at) < QUEUE_GRACE_S) {
              if (r.queued_at == null) next[id] = { ...r, queued_at: at } // first unlisted poll starts its grace
              continue
            }
            next[id] = { ...r, status: 'stopped', ended_at: at }
          }
          return next
        })
      } catch (err) {
        if (!alive) return // a poll of the chat the page has left: its failure is not this chat's
        if (isRuntimeGone(err)) {
          fails.current = 0
          setError(null)
          wait = SLOW_POLL_MS
        } else {
          fails.current += 1
          console.warn(`[${ID}] subagent.list failed (${fails.current}/${MAX_POLL_FAILS})`, err)
          if (fails.current >= MAX_POLL_FAILS) {
            setError(String(err?.message || err))
            wait = SLOW_POLL_MS
          }
        }
      }
      // One timer at a time: a Refresh during a pending wait replaces it.
      if (alive) {
        next()
        next = ctxRef.setTimeout(() => void poll(), wait)
      }
    }
    pollRef.current = poll
    void poll()
    return () => {
      alive = false
      pollRef.current = null
      next()
      offs.forEach(off => off())
    }
  }, [runtimeId])

  // A batch whose workers are all terminal moves to history: reload it, THEN drop it from "Now", so
  // the page never shows an empty Now (or a stale running copy) while the reload is in flight. The
  // page is told which session each worker had and whether focus was in the batch, so an open
  // detail and keyboard focus follow the batch into Earlier.
  const batches = useMemo(() => liveBatches(Object.values(records)), [records])
  const finished = batches.filter(b => b.rows.every(r => TERMINAL.has(r.status))).map(b => b.id).join('|')
  useEffect(() => {
    if (!finished) return
    const ids = new Set(finished.split('|'))
    const sessions = new Map()
    for (const b of batches) {
      if (!ids.has(b.id)) continue
      for (const r of b.rows) {
        gone.current.add(r.subagent_id)
        if (r.child_session_id) sessions.set(r.subagent_id, r.child_session_id)
      }
    }
    const holder = document.activeElement?.closest?.('[data-batch]')
    const focused = Boolean(holder && ids.has(holder.getAttribute('data-batch')))
    Promise.resolve(endedRef.current?.({ sessions, focused })).finally(() => {
      setRecords(prev => {
        const next = { ...prev }
        for (const [k, r] of Object.entries(next)) if (ids.has(r.delegation_id || `solo:${k}`)) delete next[k]
        return next
      })
    })
  }, [finished])

  // Refresh: reset the failure count and poll now instead of after the slowed wait.
  const retry = useCallback(() => {
    fails.current = 0
    setError(null)
    void pollRef.current?.()
  }, [])

  // A finished batch stays listed (its merge node reads "results returned") until history has it.
  return { batches, error, retry }
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** Clipboard write that never rejects out of a click handler: a refusal is a "Copy failed" toast. */
async function writeClip(text, t, onToast, done) {
  // An empty clipboard is not a copy: saying "Copied" would hide that there was nothing to paste.
  if (!text) return onToast(t('sw.nothingToCopy'), true)
  let ok = false
  try {
    ok = await ctxRef.os.writeClipboard(text)
  } catch (err) {
    console.warn(`[${ID}] clipboard write failed`, err)
  }
  onToast(ok ? done || t('sw.copied') : t('sw.copyFailed'), !ok)
}

/** A tool's name as the verb of a sentence: 'patch' -> 'editing'. */
function toolVerb(t, name) {
  return VERB[name] ? t(`sw.verb.${VERB[name]}`) : t('sw.verb.other', name)
}

/** A unit's status word: what it does while it works ('editing', 'waiting on 3'), else how it ended. */
function statusWord(t, u, waitingOn) {
  if (u.status !== 'running') return t(`sw.st.${u.status}`)
  if (u.act === 'wait' && u.main) return t('sw.st.waitingOn', waitingOn)
  return t(`sw.act.${u.act || 'think'}`)
}

/** One line on what a unit does or did: 'editing plugin.js · 3m 10s', 'done · 5m 12s'. */
function unitLine(t, u) {
  const time = u.status === 'stopped' || u.main ? '' : fmtDuration(u.duration, t)
  const what = u.status === 'running' && u.rec?.last_tool
    ? [toolVerb(t, u.rec.last_tool), shortTarget(u.rec.tool_preview)].filter(Boolean).join(' ')
    : u.status === 'running' ? t(`sw.act.${u.act || 'think'}`) : t(`sw.st.${u.status}`)
  return [what, time].filter(Boolean).join(' · ')
}

/**
 * An agent as a node of the fleet schematic: its activity sprite, its name, its status tag and one
 * meta line (model · time; the main agent's state). The same node heads the swarm.
 */
// ── the orbit: the agents hero ────────────────────────────────────────────────

// The station is drawn in an isometric box of ORBIT_W × ORBIT_H; the labels sit in the same box as
// percentages, so lines and labels meet at any width.
const ORBIT_W = 666, ORBIT_H = 360, ORBIT_CX = 333, ORBIT_CY = 192, ORBIT_S = 0.74
// At most six wings, three a side: past that the wings touch and the lines cross. Five go to the
// agents that need eyes (failed, then working, then waiting), the sixth holds the rest.
export const ORBIT_WINGS = 6
const ORBIT_SLOTS = [[-170, 1], [-170, -1], [170, 1], [170, -1], [-92, 1], [92, -1]]
// the group takes an outer slot (3), so its line never runs past the core
const ORBIT_GROUP_SLOTS = [0, 1, 2, 4, 5, 3]
const ORBIT_RANK = { failed: 0, running: 1, queued: 2, stopped: 3, completed: 3 }
const ORBIT_COLS = 8, ORBIT_ROWS = 2

/** The wings, in slot order: every subagent while they fit, else the five that need eyes and a group. */
export function orbitWings(subs) {
  if (subs.length <= ORBIT_WINGS) return subs.map((u, i) => ({ u, slot: i }))
  const order = subs.map((u, i) => [u, i])
    .sort((a, b) => (ORBIT_RANK[a[0].status] ?? 3) - (ORBIT_RANK[b[0].status] ?? 3) || a[1] - b[1])
    .map(x => x[0])
  return [
    ...order.slice(0, ORBIT_WINGS - 1).map((u, i) => ({ u, slot: ORBIT_GROUP_SLOTS[i] })),
    { rest: order.slice(ORBIT_WINGS - 1), slot: ORBIT_GROUP_SLOTS[ORBIT_WINGS - 1] }
  ]
}

const iso = (x, y, z = 0) => [ORBIT_CX + (x - y) * 0.866 * ORBIT_S, ORBIT_CY + ((x + y) * 0.5 - z) * ORBIT_S]
const ptxt = pts => pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
const isoLine = (a, b, cls, key) => {
  const [x1, y1] = iso(...a), [x2, y2] = iso(...b)
  return jsx('line', { className: cls, x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1) }, key)
}

/** A wired cylinder along x: its shell, rings and six struts. */
function cylinder(x0, x1, r, rings, key, className) {
  const ring = x => Array.from({ length: 37 }, (_, k) => { const a = (k / 36) * Math.PI * 2; return iso(x, Math.cos(a) * r, Math.sin(a) * r) })
  const A = ring(x0), B = ring(x1)
  const out = [jsx('polygon', { className: 'sw-orcore', points: ptxt([...A, ...B.slice().reverse()]) }, 'shell')]
  for (let i = 0; i <= rings; i++) out.push(jsx('polyline', { className: i === 0 || i === rings ? 'sw-orw1' : 'sw-orw2', style: { '--r': i }, points: ptxt(ring(x0 + ((x1 - x0) * i) / rings)) }, `r${i}`))
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3
    out.push(isoLine([x0, Math.cos(a) * r, Math.sin(a) * r], [x1, Math.cos(a) * r, Math.sin(a) * r], 'sw-orw2', `s${k}`))
  }
  return jsx('g', { className, children: out }, key)
}

/** The truss the wings hang on. */
function truss() {
  const out = []
  const h = 5
  for (const z of [-h, h]) for (const x of [-h, h]) out.push(isoLine([x, -200, z], [x, 200, z], 'sw-orw2', `b${x}${z}`))
  for (let y = -200; y < 200; y += 12) {
    out.push(isoLine([-h, y, -h], [h, y + 12, h], 'sw-orw2', `d${y}`))
    out.push(isoLine([h, y, -h], [h, y, h], 'sw-orw2', `v${y}`))
  }
  const [ax, ay] = iso(0, -200, 0), [bx, by] = iso(0, 200, 0)
  out.push(jsx('line', { className: 'sw-ortrail', x1: ax.toFixed(1), y1: ay.toFixed(1), x2: bx.toFixed(1), y2: by.toFixed(1), pathLength: 100 }, 'trail'))
  return jsx('g', { children: out }, 'truss')
}

/** One wing: 8 × 2 cells in a frame. Its cells say the state; a group's cells are its members. */
function wing(w, flash, sel) {
  const [y, side] = ORBIT_SLOTS[w.slot]
  const half = 26, x0 = 16 * side, x1 = 116 * side
  const st = w.rest ? 'group' : w.u.status
  const cells = []
  for (let c = 0; c < ORBIT_COLS; c++) {
    for (let r = 0; r < ORBIT_ROWS; r++) {
      const ax = x0 + ((x1 - x0) * c) / ORBIT_COLS, bx = x0 + ((x1 - x0) * (c + 1)) / ORBIT_COLS
      const ay = y - half + (2 * half * r) / ORBIT_ROWS, by = y - half + (2 * half * (r + 1)) / ORBIT_ROWS
      let k = ''
      if (w.rest) k = w.rest[r * ORBIT_COLS + c] ? w.rest[r * ORBIT_COLS + c].status : 'none'
      else if (st === 'completed') k = 'completed'
      else if (st === 'failed') k = c < 3 ? 'failed' : ''
      else if (st === 'running') k = 'running'
      cells.push(jsx('polygon', {
        className: 'sw-orc', 'data-k': k || undefined, style: { '--i': c },
        points: ptxt([iso(ax, ay), iso(bx, ay), iso(bx, by), iso(ax, by)])
      }, `${c}-${r}`))
    }
  }
  return jsxs('g', {
    className: `sw-orw${flash ? ` is-${flash}` : ''}${sel ? ' is-sel' : ''}`, 'data-st': st,
    children: [
      isoLine([0, y, 0], [x0, y, 0], 'sw-orw1', 'arm'),
      ...cells,
      jsx('polygon', { className: 'sw-orf', points: ptxt([iso(x0, y - half), iso(x1, y - half), iso(x1, y + half), iso(x0, y + half)]) }, 'f')
    ]
  }, w.rest ? 'group' : w.u.key)
}

/** Where a wing's line lands: its corner nearest its label column, so the line never crosses the wing. */
function wingPin(slot) {
  const [y, side] = ORBIT_SLOTS[slot]
  const c = [[16, y - 26], [16, y + 26], [116, y - 26], [116, y + 26]].map(([x, yy]) => iso(x * side, yy))
  const left = c.reduce((n, p) => n + p[0], 0) / 4 < ORBIT_CX
  return { left, pin: c.reduce((a, b) => ((left ? b[0] < a[0] : b[0] > a[0]) ? b : a)) }
}

const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`

/**
 * The fleet hero: an isometric station. The core is the main agent (its box up top: what it does, how
 * many subagents are done); each subagent is a wing with a callout — its name and how it is doing — on
 * a leader line. A wing's cells carry its state: amber cells run along it while it works, it fills in
 * the accent when done, a failure turns three cells red and shakes it once, a waiting wing is dashed.
 * Narrow, the callouts drop under the station as a list.
 */
/* The FLEET station: the main agent as a ring station drawn in thin glowing lines on a canvas — a ribbed
 * wheel with habitat windows, a top rail and hull blocks on four truss spokes round a column (collar ring,
 * fuel tanks, solar arrays below), a deck disc with two dishes, a command sphere with an antenna under the
 * MAIN box, a docking mast with claws. Each subagent is a module on the wheel's rim placed level with its
 * callout: working pulses and a scan bar crosses it, done glows steady, failed flickers, waiting is a
 * dashed outline; the group callout is a row of slivers, one per member. The wheel, disc and sphere turn
 * (faster while the main agent works), a scan ring rides the column, a ping rolls across the wheel. The
 * canvas also draws the leader lines, the MAIN box and the frame, so the SVG schematic under it is hidden
 * while the scene runs (it stays as the fallback when there is no 2D canvas).
 * State is read from the panel's own DOM, colours from the page's tokens. An earlier run (data-calm) or
 * reduced motion draws one still frame, refreshed once a second. window.__swStationClock, when set,
 * drives the clock (frame-exact recordings of the scene). */
export function startStationScene(canvas) {
  const root = canvas.closest('.sw-orbit')
  const ctx = canvas?.getContext?.('2d')
  const swatch = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true })
  if (!root || !ctx || !swatch) return () => {}
  root.classList.add('has-scene')
  const still = root.dataset.calm === 'true' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'
  root.appendChild(probe)
  // a token resolved to sRGB 0..1 by painting it: works for any colour syntax the theme uses
  const tok = v => {
    probe.style.color = `var(${v})`
    swatch.clearRect(0, 0, 1, 1); swatch.fillStyle = window.getComputedStyle(probe).color; swatch.fillRect(0, 0, 1, 1)
    const d = swatch.getImageData(0, 0, 1, 1).data
    return [d[0] / 255, d[1] / 255, d[2] / 255]
  }
  let P
  const readPal = () => { P = { line: tok('--a'), hot: tok('--run'), ok: tok('--ok'), bad: tok('--bad'), idle: tok('--idle'), bg: tok('--solid') } }
  const C = (c, a = 1) => `color(srgb ${c[0]} ${c[1]} ${c[2]} / ${Math.max(0, Math.min(1, a))})`
  const stCol = st => ({ running: P.hot, completed: P.ok, failed: P.bad, queued: P.idle, stopped: P.idle })[st] || P.line
  const clamp = x => Math.max(0, Math.min(1, x))

  // ── camera: tilt the top toward the viewer, lean right, breathe a little ──
  const TILT = 0.64, ROLL = -0.24
  let W = 0, H = 0, dpr = 1, U = 1, CX = 0, CY = 0, yaw = 0
  const cam = ([x, y, z]) => {
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw)
    const x1 = x * cy0 + z * sy0, z1 = -x * sy0 + z * cy0
    const ct = Math.cos(TILT), st = Math.sin(TILT)
    const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct
    const cr = Math.cos(ROLL), sr = Math.sin(ROLL)
    return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2]
  }
  const proj = p => { const c = cam(p), k = U * 900 / (900 - c[2]); return [CX + c[0] * k, CY - c[1] * k, c[2]] }
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight, d = Math.min(2, window.devicePixelRatio || 1)
    if (w === W && h === H && d === dpr) return false
    W = w; H = h; dpr = d
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d)
    U = Math.min(W / 666, H / 360); CX = W * 0.5; CY = H * 0.55
    return true
  }

  // ── geometry (model units; y is the station's axis) ──
  const R = 150, RI = 132, BH = 17, HUB = 14, SPH = [0, 86, 0], SR = 19
  const pt = (r, y, a) => [r * Math.cos(a), y, r * Math.sin(a)]
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const build = (spin) => {
    const S = []   // [p1, p2, group, order, mul]
    const ring = (g, r, y, n, ph, mul = 1, o0 = 0, o1 = 1) => { for (let k = 0; k < n; k++) { const a = ph + k / n * 6.2832, b = ph + (k + 1) / n * 6.2832; S.push([pt(r, y, a), pt(r, y, b), g, o0 + (o1 - o0) * k / n, mul]) } }
    // wheel: outer and inner rims top and bottom, a faint mid seam, ribs that turn with it
    ring('band', R, BH, 96, spin); ring('band', R, -BH, 96, spin); ring('band', RI, BH, 96, spin); ring('band', RI, -BH, 96, spin)
    ring('band', R, 0, 96, spin, 0.4)
    for (let k = 0; k < 64; k++) {
      const a = spin + k / 64 * 6.2832, o = k / 64, m = k % 8 === 0 ? 1.4 : 0.7
      S.push([pt(R, -BH, a), pt(R, BH, a), 'band', o, m], [pt(RI, BH, a), pt(R, BH, a), 'band', o, m], [pt(RI, -BH, a), pt(R, -BH, a), 'band', o, m])
    }
    // column
    for (let y = -130; y <= 66; y += 14) ring('hub', HUB, y, 20, spin * 2, 0.8, (y + 130) / 200, (y + 130) / 200)
    for (let k = 0; k < 6; k++) { const a = spin * 2 + k / 6 * 6.2832; S.push([pt(HUB, -130, a), pt(HUB, 66, a), 'hub', 0, 0.6]) }
    // deck disc
    ring('disc', 62, 46, 48, -spin * 1.6); ring('disc', 62, 39, 48, -spin * 1.6); ring('disc', 48, 46, 48, -spin * 1.6, 0.6)
    for (let k = 0; k < 24; k++) { const a = -spin * 1.6 + k / 24 * 6.2832; S.push([pt(62, 39, a), pt(62, 46, a), 'disc', k / 24, 0.8], [pt(HUB, 42, a), pt(48, 46, a), 'disc', k / 24, 0.35]) }
    // command sphere
    for (let j = 1; j < 6; j++) { const la = -1.5708 + j / 6 * 3.1416; ring('sph', SR * Math.cos(la), SPH[1] + SR * Math.sin(la), 28, spin * 3, 0.9, j / 6, j / 6) }
    for (let k = 0; k < 10; k++) {
      const a = spin * 3 + k / 10 * 6.2832
      for (let j = 0; j < 12; j++) { const l0 = -1.5708 + j / 12 * 3.1416, l1 = -1.5708 + (j + 1) / 12 * 3.1416; S.push([pt(SR * Math.cos(l0), SPH[1] + SR * Math.sin(l0), a), pt(SR * Math.cos(l1), SPH[1] + SR * Math.sin(l1), a), 'sph', k / 10, 0.7]) }
    }
    // docking mast: a lattice down to a claw ring
    for (let j = 0; j < 6; j++) {
      const y0 = -130 - j * 8, y1 = y0 - 8
      S.push([[-6, y0, 0], [-6, y1, 0], 'mast', j / 7, 1], [[6, y0, 0], [6, y1, 0], 'mast', j / 7, 1], [[j % 2 ? -6 : 6, y0, 0], [j % 2 ? 6 : -6, y1, 0], 'mast', j / 7, 0.6])
    }
    ring('mast', 12, -182, 20, spin, 1, 0.9, 1); ring('mast', 8, -188, 16, spin, 0.7, 0.9, 1)

    // ── detail pass ──
    const L = (g, a, b, o, m) => S.push([a, b, g, o, m])
    const off = (p, a, w) => [p[0] - Math.sin(a) * w, p[1], p[2] + Math.cos(a) * w]   // sideways from a radial line
    const box = (g, c, dr, dy, dw, a, o, m) => {   // a radial-aligned box: centre c=[r,y], half sizes
      const v = []; for (const sr of [-1, 1]) for (const sy of [-1, 1]) for (const sw of [-1, 1]) v.push(off(pt(c[0] + sr * dr, c[1] + sy * dy, a), a, sw * dw))
      for (const [i, j] of [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]]) L(g, v[i], v[j], o, m)
    }
    const cyl = (g, cx, cz, r, y0, y1, o, m, n = 12) => {
      for (const y of [y0, (y0 + y1) / 2, y1]) for (let k = 0; k < n; k++) { const a = k / n * 6.2832, b = (k + 1) / n * 6.2832; L(g, [cx + r * Math.cos(a), y, cz + r * Math.sin(a)], [cx + r * Math.cos(b), y, cz + r * Math.sin(b)], o, y === (y0 + y1) / 2 ? m * 0.5 : m) }
      for (let k = 0; k < 4; k++) { const a = k / 4 * 6.2832 + 0.4; L(g, [cx + r * Math.cos(a), y0, cz + r * Math.sin(a)], [cx + r * Math.cos(a), y1, cz + r * Math.sin(a)], o, m * 0.7) }
    }
    // wheel: two rows of habitat windows on the outer face, a raised rail on top, pipes inside, hull blocks
    for (let k = 0; k < 120; k++) {
      if (k % 10 === 0) continue
      const a0 = spin + (k + 0.2) / 120 * 6.2832, a1 = spin + (k + 0.75) / 120 * 6.2832
      for (const [y0, y1] of [[5, 10], [-10, -5]]) {
        const c = [pt(R + 0.3, y0, a0), pt(R + 0.3, y0, a1), pt(R + 0.3, y1, a1), pt(R + 0.3, y1, a0)]
        for (let i = 0; i < 4; i++) L('win', c[i], c[(i + 1) % 4], k / 120, 0.5)
      }
    }
    ring('detail', (R + RI) / 2, BH + 5, 96, spin, 0.7)
    for (let k = 0; k < 32; k++) { const a = spin + k / 32 * 6.2832; L('detail', pt((R + RI) / 2, BH, a), pt((R + RI) / 2, BH + 5, a), k / 32, 0.6) }
    ring('detail', RI - 3, 10, 96, spin, 0.55); ring('detail', RI - 3, -10, 96, spin, 0.55)
    for (let k = 0; k < 8; k++) { const a = spin + (k + 0.5) / 8 * 6.2832; box('detail', [R + 5, 0], 5, 13, 9, a, k / 8, 0.9); box('detail', [R + 12, 0], 2, 6, 4, a, k / 8, 0.7) }
    // spokes become box trusses: four longerons with cross bracing
    for (let k = 0; k < 4; k++) {
      const a = spin + k * 1.5708 + 0.4
      for (const w of [-4, 4]) for (const y of [-5, 5]) L('spoke', off(pt(HUB, y, a), a, w), off(pt(RI, y, a), a, w), k / 4, 0.8)
      for (let j = 1; j < 9; j++) { const r0 = HUB + (RI - HUB) * (j - 1) / 8, r1 = HUB + (RI - HUB) * j / 8
        for (const y of [-5, 5]) L('spoke', off(pt(r0, y, a), a, j % 2 ? -4 : 4), off(pt(r1, y, a), a, j % 2 ? 4 : -4), k / 4, 0.4)
        L('spoke', off(pt(r1, -5, a), a, -4), off(pt(r1, 5, a), a, -4), k / 4, 0.35); L('spoke', off(pt(r1, -5, a), a, 4), off(pt(r1, 5, a), a, 4), k / 4, 0.35) }
    }
    // column: a collar ring on its own short spokes, fuel tanks, thicker segment bands
    const cs = spin * 2
    ring('detail', 38, -42, 48, cs); ring('detail', 38, -36, 48, cs); ring('detail', 30, -39, 48, cs, 0.5)
    for (let k = 0; k < 6; k++) { const a = cs + k / 6 * 6.2832; L('detail', pt(HUB, -39, a), pt(30, -39, a), k / 6, 0.7); L('detail', pt(38, -42, a), pt(38, -36, a), k / 6, 0.8) }
    for (let k = 0; k < 4; k++) { const a = cs + k / 4 * 6.2832 + 0.78; cyl('detail', 25 * Math.cos(a), 25 * Math.sin(a), 6.5, -112, -78, k / 4, 0.85) }
    for (const y of [-10, 22]) { ring('hub', HUB + 4, y, 20, cs, 0.9); ring('hub', HUB + 4, y + 6, 20, cs, 0.9); for (let k = 0; k < 10; k++) { const a = cs + k / 10 * 6.2832; L('hub', pt(HUB + 4, y, a), pt(HUB + 4, y + 6, a), 0.5, 0.6) } }
    // solar arrays on a boom under the wheel, panels gridded
    for (const s of [0, 3.1416]) {
      const a = cs + s + 1.1, y = -62
      L('solar', pt(HUB, y, a), pt(118, y, a), 0, 0.8)
      for (const [r0, r1] of [[42, 76], [82, 116]]) {
        const c = [off(pt(r0, y, a), a, -15), off(pt(r1, y, a), a, -15), off(pt(r1, y, a), a, 15), off(pt(r0, y, a), a, 15)]
        for (let i = 0; i < 4; i++) L('solar', c[i], c[(i + 1) % 4], r0 / 120, 1)
        for (let j = 1; j < 6; j++) { const rr = r0 + (r1 - r0) * j / 6; L('solar', off(pt(rr, y, a), a, -15), off(pt(rr, y, a), a, 15), r0 / 120, 0.4) }
        for (const w of [-5, 5]) L('solar', off(pt(r0, y, a), a, w), off(pt(r1, y, a), a, w), r0 / 120, 0.4)
      }
    }
    // deck disc: window band, two dishes
    for (let k = 0; k < 36; k++) { const a = -spin * 1.6 + k / 36 * 6.2832; if (k % 3) L('win', pt(62.3, 42.5, a), pt(62.3, 42.5, a + 0.09), k / 36, 0.7) }
    for (const s of [0.6, 3.7]) {
      const a = -spin * 1.6 + s, base = pt(40, 46, a), top = pt(44, 58, a)
      L('detail', base, top, 0.5, 0.8)
      for (let k = 0; k < 14; k++) { const b0 = k / 14 * 6.2832, b1 = (k + 1) / 14 * 6.2832, q = (b) => add3(top, [7 * Math.cos(b) * Math.cos(a), 7 * Math.sin(b) * 0.7, 7 * Math.cos(b) * Math.sin(a)]); L('detail', q(b0), q(b1), 0.6, 0.9); if (k % 4 === 0) L('detail', q(b0), add3(top, [Math.cos(a) * 6, 2, Math.sin(a) * 6]), 0.6, 0.5) }
    }
    // command sphere: antenna mast with crossbars
    L('detail', [0, SPH[1] + SR, 0], [0, SPH[1] + SR + 14, 0], 0.9, 0.9)
    for (const [y, w] of [[SPH[1] + SR + 5, 6], [SPH[1] + SR + 10, 3.5]]) L('detail', [-w, y, 0], [w, y, 0], 0.95, 0.8)
    // docking mast: claws
    for (let k = 0; k < 4; k++) { const a = spin + k / 4 * 6.2832; L('mast', pt(12, -182, a), pt(20, -190, a), 0.95, 0.8); L('mast', pt(20, -190, a), pt(17, -198, a), 0.97, 0.7) }
    return S
  }
  const INTRO = { hub: [0, 0.7], mast: [0.3, 0.6], band: [0.35, 1.0], spoke: [0.8, 0.5], disc: [0.9, 0.5], sph: [1.1, 0.6], mod: [1.9, 0.6], win: [1.2, 0.6], detail: [1.3, 0.6], solar: [0.95, 0.5] }

  // ── state from the DOM, modules placed near their labels ──
  let S = null, frame = 0, mods = []
  const readState = () => {
    const main = root.querySelector('.sw-ormain')
    const calls = [...root.querySelectorAll('.sw-orl')].map((el, i) => {
      const grp = el.classList.contains('is-grp')
      return {
        el, i, grp, st: grp ? 'group' : el.dataset.st || 'queued', sel: el.classList.contains('is-sel'), side: el.dataset.side,
        members: grp ? [...el.querySelectorAll('.sw-orm')].flatMap(m => Array(Number(m.textContent) || 0).fill(m.dataset.st)) : null
      }
    })
    S = { main, mainSt: main?.dataset.st || 'idle', mainSel: !!main?.classList.contains('is-sel'), calls }
    place()
  }
  const labelY = c => parseFloat(c.el.style.top) / 100 * H + 6
  const place = () => {
    const taken = [], sph = proj(SPH)
    mods = S.calls.slice().sort((a, b) => labelY(a) - labelY(b)).map(c => {
      let best = null, bc = 1e9
      for (let d = 0; d < 360; d += 2) {
        const a = d * Math.PI / 180, q = proj(pt(R, 0, a))
        if ((c.side === 'l') !== (q[0] < CX)) continue
        const n = cam([Math.cos(a), 0, Math.sin(a)]), facing = n[2]
        let cost = Math.abs(q[1] - labelY(c)) + (1 - facing) * 70
        if (Math.hypot(q[0] - sph[0], q[1] - sph[1]) < 46 * U) cost += 300
        for (const t of taken) { const dd = Math.abs(((a - t + 9.4248) % 6.2832) - 3.1416); if (dd < 0.42) cost += 1e4 }
        if (cost < bc) { bc = cost; best = a }
      }
      taken.push(best)
      return { c, a: best, span: c.grp ? 0.34 : 0.17 }
    })
  }

  const rnd = (() => { let x = 7654321; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
  const STARS = Array.from({ length: 150 }, () => ({ x: rnd(), y: rnd(), z: 0.2 + rnd() * 0.8, p: rnd() * 6.28, s: rnd() }))
  const glow = (x, y, r, c, a) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, C(c, a)); g.addColorStop(1, C(c, 0)); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2) }
  const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath() }
  const t0 = performance.now() / 1000

  const render = () => {
    if (resize() || frame % 30 === 0) { readPal(); readState() }
    frame++
    if (!W || !H) return
    const t = still ? 30 : (window.__swStationClock ?? performance.now() / 1000 - t0)
    const busy = S.mainSt !== 'idle' && S.mainSt !== 'completed'
    yaw = 0.05 * Math.sin(t * 0.13)
    const spin = t * (busy ? 0.11 : 0.05)
    const reveal = g => { const [s, d] = INTRO[g]; return clamp((t - s) / d) }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'

    for (const s of STARS) {
      const a = (0.1 + 0.32 * s.z) * (0.55 + 0.45 * Math.sin(t * (0.5 + s.s) + s.p))
      ctx.fillStyle = C(P.line, a); ctx.fillRect(s.x * W, s.y * H, s.z > 0.88 ? 1.5 : 1, s.z > 0.88 ? 1.5 : 1)
    }
    glow(CX, CY, W * 0.32, P.line, 0.07)

    // ping across the wheel plane, scan ring riding the column
    const ring2 = (r, y, a, w, dash) => {
      ctx.beginPath()
      for (let k = 0; k <= 80; k++) { const q = proj(pt(r, y, k / 80 * 6.2832)); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]) }
      ctx.lineWidth = w; ctx.strokeStyle = C(P.line, a); if (dash) ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
    }
    const ph = (t % 7) / 7
    if (ph < 0.6 && t > 2) ring2(20 + ph / 0.6 * 300, 0, 0.5 * (1 - ph / 0.6), 1.2)
    const sp = (t % 5) / 5, sy = -130 + sp * 230
    ring2(26 + 8 * Math.sin(sp * 3.14), sy, 0.65 * Math.sin(sp * 3.14) * reveal('hub'), 1.4)
    ring2(196, 0, 0.12, 1, [2, 6]); ring2(250, 0, 0.07, 1, [1, 9])

    // wireframe in depth buckets: back lines dim, front lines bright, each stroked as glow + core
    const B = 8, bk = Array.from({ length: B }, () => [])
    for (const [p1, p2, g, o, m] of build(spin)) {
      const [s, d] = INTRO[g], prog = (t - s) / d
      if (prog <= o) continue
      const a1 = proj(p1), a2 = proj(p2)
      const f = clamp(((a1[2] + a2[2]) / 2 + 160) / 320)
      const a = (0.1 + 0.8 * f) * m * clamp((prog - o) * 6)
      bk[Math.min(B - 1, (a * B) | 0)].push(a1, a2)
    }
    bk.forEach((list, b) => {
      if (!list.length) return
      ctx.beginPath(); for (let i = 0; i < list.length; i += 2) { ctx.moveTo(list[i][0], list[i][1]); ctx.lineTo(list[i + 1][0], list[i + 1][1]) }
      const a = (b + 0.5) / B
      ctx.lineWidth = 3; ctx.strokeStyle = C(P.line, a * 0.13); ctx.stroke()
      ctx.lineWidth = 0.8; ctx.strokeStyle = C(P.line, a * 0.95); ctx.stroke()
    })

    // beacons round the rim, command-sphere windows
    for (let k = 0; k < 8; k++) {
      const a = spin + k / 8 * 6.2832 + 0.2, q = proj(pt(R, BH, a)), on = ((t * 0.6 + k / 8) % 1) < 0.08
      if (reveal('band') < 1) continue
      ctx.fillStyle = C(P.line, (q[2] > 0 ? 1 : 0.45) * (on ? 1 : 0.35)); ctx.fillRect(q[0] - 1, q[1] - 1, 2, 2)
    }
    const core = proj(SPH)
    glow(core[0], core[1], 30 * U, P.line, (busy ? 0.18 + 0.12 * Math.sin(t * 4) : 0.14) * reveal('sph'))

    // modules on the rim
    const mr = reveal('mod')
    const patch = (a0, a1, inset = 3) => { const top = [], bot = []; for (let k = 0; k <= 6; k++) { const a = a0 + (a1 - a0) * k / 6; top.push(proj(pt(R + 0.5, BH - inset, a))); bot.push(proj(pt(R + 0.5, -BH + inset, a))) } return [...top, ...bot.reverse()] }
    for (const m of mods) {
      if (mr <= 0) break
      const { c, a } = m, center = proj(pt(R, 0, a)), front = center[2] > 0 ? 1 : 0.7
      m.q = center
      const draw = (a0, a1, st, k) => {
        const col = stCol(st), pts = patch(a0, a1)
        let fa = 0.4
        if (st === 'running') fa = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2 + k))
        if (st === 'completed') fa = 0.45
        if (st === 'failed') fa = Math.sin(t * 17 + k * 3) > 0.2 || Math.sin(t * 5.3 + k) > 0.6 ? 0.55 : 0.12
        const idle = st === 'queued' || st === 'stopped'
        poly(pts)
        if (!idle) { ctx.fillStyle = C(col, fa * front * mr); ctx.fill() }
        ctx.lineWidth = 1; ctx.strokeStyle = C(col, 0.95 * front * mr); if (idle) ctx.setLineDash([3, 2.5]); ctx.stroke(); ctx.setLineDash([])
      }
      if (c.grp) {
        const n = Math.min(10, c.members.length), w = m.span * 2 / Math.max(1, n)
        c.members.slice(0, n).forEach((st, k) => draw(a - m.span + k * w + w * 0.15, a - m.span + (k + 1) * w - w * 0.15, st, k))
      } else {
        draw(a - m.span, a + m.span, c.st, c.i)
        if (c.st === 'running' && mr >= 1) {
          const f = ((t * 0.6 + c.i * 0.23) % 1), aa = a - m.span + 2 * m.span * f
          const p1 = proj(pt(R + 0.5, BH - 3, aa)), p2 = proj(pt(R + 0.5, -BH + 3, aa))
          ctx.lineWidth = 1.4; ctx.strokeStyle = C(P.hot, 0.95 * front * Math.sin(f * 3.1416))
          ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke()
        }
        if (c.st === 'running' && mr >= 1) {   // data packets from the hub
          const h = proj([0, 0, 0]), e = proj(pt(RI, 0, a))
          ctx.lineWidth = 0.8; ctx.strokeStyle = C(P.hot, 0.18 * front); ctx.setLineDash([2, 5]); ctx.lineDashOffset = -t * 20
          ctx.beginPath(); ctx.moveTo(h[0], h[1]); ctx.lineTo(e[0], e[1]); ctx.stroke(); ctx.setLineDash([])
        }
      }
    }

    // frame: chamfered border, accent bars, a tick ruler
    ctx.globalCompositeOperation = 'source-over'
    const i0 = 3, ch = 9
    poly([[i0 + ch, i0], [W - i0 - ch, i0], [W - i0, i0 + ch], [W - i0, H - i0 - ch], [W - i0 - ch, H - i0], [i0 + ch, H - i0], [i0, H - i0 - ch], [i0, i0 + ch]])
    ctx.lineWidth = 1; ctx.strokeStyle = C(P.line, 0.26); ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = C(P.hot, 0.85)
    const bar = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke() }
    bar(i0, H * 0.4, i0, H * 0.4 + 26); bar(W - i0, H * 0.6 - 26, W - i0, H * 0.6)
    bar(W * 0.5 - 30, H - i0, W * 0.5 + 30, H - i0)
    ctx.lineWidth = 1; ctx.strokeStyle = C(P.line, 0.3)
    ctx.beginPath(); for (let x = W * 0.5 - 120; x <= W * 0.5 + 120; x += 8) { if (Math.abs(x - W * 0.5) < 34) continue; ctx.moveTo(x, H - i0); ctx.lineTo(x, H - i0 - ((x / 8 | 0) % 4 ? 3 : 6)) } ctx.stroke()

    // leader lines, brackets, the MAIN box (its text is the panel's own HTML above this canvas)
    if (W >= 520) {
      for (const m of mods) {
        const { c } = m, q = m.q
        if (!q || mr <= 0) continue
        const top = labelY(c) - 6, left = c.side === 'l', u = W / 666
        const x0 = left ? 14 * u : W - 14 * u, x1 = left ? 150 * u : W - 150 * u
        ctx.globalAlpha = mr
        ctx.strokeStyle = c.sel ? C(P.hot, 0.95) : C(P.line, 0.45); ctx.lineWidth = c.sel ? 1.2 : 0.8
        ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x1, top); ctx.lineTo(q[0], q[1]); ctx.stroke()
        ctx.fillStyle = C(P.line, 0.95); ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3)
        if (c.sel) brackets(q[0], q[1], 20 + 2 * Math.sin(t * 3))
        ctx.globalAlpha = 1
      }
      const mb = S.main
      if (mb) {
        const u = W / 666, bx = parseFloat(mb.style.left) / 100 * W, by = parseFloat(mb.style.top) / 100 * H, bw = parseFloat(mb.style.width) / 100 * W, bh = 18 * u
        ctx.strokeStyle = C(P.line, 0.45); ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.moveTo(bx + 24 * u, by + bh); ctx.lineTo(bx + 24 * u, by + bh + 6); ctx.lineTo(core[0], core[1]); ctx.stroke()
        poly([[bx, by], [bx + bw - 10 * u, by], [bx + bw, by + bh / 2], [bx + bw - 10 * u, by + bh], [bx, by + bh]])
        ctx.fillStyle = C(P.bg, 0.88); ctx.fill(); ctx.strokeStyle = S.mainSel ? C(P.hot, 0.95) : C(P.line, 0.85); ctx.lineWidth = S.mainSel ? 1.4 : 0.9; ctx.stroke()
      }
    }
  }
  const brackets = (x, y, r) => {
    ctx.strokeStyle = C(P.hot, 0.95); ctx.lineWidth = 1.3
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.moveTo(x + sx * r, y + sy * (r - 7)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - 7), y + sy * r); ctx.stroke() }
  }
  let raf = 0, tick = 0
  const loop = () => { if (!canvas.isConnected) { stop(); return } render(); if (!still) raf = window.requestAnimationFrame(loop) }
  const stop = () => { window.cancelAnimationFrame(raf); clearInterval(tick); probe.remove(); root.classList.remove('has-scene') }
  canvas.swStationFrame = render
  raf = window.requestAnimationFrame(loop)
  if (still) tick = setInterval(() => { if (canvas.isConnected) render(); else stop() }, 1000)
  return stop
}

function StationScene() {
  const ref = useRef(null)
  useEffect(() => startStationScene(ref.current), [])
  return jsx('canvas', { className: 'sw-orcv', ref, 'aria-hidden': 'true' })
}

/** The Commands tab's ORBIT, drawn live in the FLEET station's style (its camera, thin glowing lines in
 * depth buckets, stars, ping, construction intro, chamfered frame, leader lines): a wireframe planet turns
 * at the centre (latitude rings, meridians, continents, an equator band, a halo); every command shown has
 * its own inclined orbit and is a small wireframe satellite on it. Running flies its orbit with a trail
 * and a pulse, finished is parked and lit, failed flickers red on a dashed red orbit, stopped is a dashed
 * outline, frozen. Each callout's leader runs to a node pin on its orbit on the callout's side, so lines
 * never cross the planet; the selected command's satellite gets the FLEET brackets. State is read from
 * the panel's own DOM, colours from the page's tokens. Reduced motion draws one still frame, refreshed
 * once a second. window.__swStationClock, when set, drives the clock (frame-exact recordings). */
export function startCmdOrbitScene(canvas) {
  const root = canvas?.closest('.sw-orbit')
  const ctx = canvas?.getContext?.('2d')
  const swatch = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true })
  if (!root || !ctx || !swatch) return () => {}
  root.classList.add('has-scene')
  const still = root.dataset.calm === 'true' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'
  root.appendChild(probe)
  // a token resolved to sRGB 0..1 by painting it: works for any colour syntax the theme uses
  const tok = v => {
    probe.style.color = `var(${v})`
    swatch.clearRect(0, 0, 1, 1); swatch.fillStyle = window.getComputedStyle(probe).color; swatch.fillRect(0, 0, 1, 1)
    const d = swatch.getImageData(0, 0, 1, 1).data
    return [d[0] / 255, d[1] / 255, d[2] / 255]
  }
  let P
  const readPal = () => { P = { line: tok('--a'), hot: tok('--run'), ok: tok('--ok'), bad: tok('--bad'), idle: tok('--idle'), bg: tok('--solid') } }
  const paint = (c, a = 1) => `color(srgb ${c[0]} ${c[1]} ${c[2]} / ${Math.max(0, Math.min(1, a))})`
  const stCol = st => ({ running: P.hot, completed: P.ok, failed: P.bad, queued: P.idle, stopped: P.idle })[st] || P.line
  const clamp = x => Math.max(0, Math.min(1, x))

  // ── camera: the station's ──
  const TILT = 0.64, ROLL = -0.24
  let W = 0, H = 0, dpr = 1, U = 1, CX = 0, CY = 0, yaw = 0
  const cam = ([x, y, z]) => {
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw)
    const x1 = x * cy0 + z * sy0, z1 = -x * sy0 + z * cy0
    const ct = Math.cos(TILT), st = Math.sin(TILT)
    const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct
    const cr = Math.cos(ROLL), sr = Math.sin(ROLL)
    return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2]
  }
  const proj = p => { const c = cam(p), k = U * 900 / (900 - c[2]); return [CX + c[0] * k, CY - c[1] * k, c[2]] }
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight, d = Math.min(2, window.devicePixelRatio || 1)
    if (w === W && h === H && d === dpr) return false
    W = w; H = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d)
    U = Math.min(W / 666, H / 360); CX = W * 0.5; CY = H * 0.58
    return true
  }

  // ── model ──
  const PR = 74   // planet radius
  const pt = (r, y, a) => [r * Math.cos(a), y, r * Math.sin(a)]
  // an orbit: radius, inclination about x, node (turn about y)
  const orbitDef = i => ({ r: 118 + i * 16, inc: [0.22, -0.3, 0.38, -0.16, 0.5, -0.44][i % 6], node: [0.4, 2.1, 4.0, 1.2, 3.1, 5.2][i % 6] })
  const onOrbit = (o, a, dr = 0, dy = 0) => {
    let [x, y, z] = [(o.r + dr) * Math.cos(a), dy, (o.r + dr) * Math.sin(a)]
    const ci = Math.cos(o.inc), si = Math.sin(o.inc); [y, z] = [y * ci - z * si, y * si + z * ci]
    const cn = Math.cos(o.node), sn = Math.sin(o.node); [x, z] = [x * cn + z * sn, -x * sn + z * cn]
    return [x, y, z]
  }
  const build = (spin, sats) => {
    const S = []
    const L = (g, a, b, o, m) => S.push([a, b, g, o, m])
    const ring = (g, r, y, n, ph, mul = 1, o0 = 0, o1 = 1) => { for (let k = 0; k < n; k++) { const a = ph + k / n * 6.2832, b = ph + (k + 1) / n * 6.2832; L(g, pt(r, y, a), pt(r, y, b), o0 + (o1 - o0) * k / n, mul) } }
    // planet: latitude rings, meridians that turn, a brighter equator band, a halo, polar caps
    for (let j = 1; j < 10; j++) { const la = -1.5708 + j / 10 * 3.1416; ring('planet', PR * Math.cos(la), PR * Math.sin(la), 64, spin, j === 5 ? 1.2 : 0.7, j / 10, j / 10) }
    for (let k = 0; k < 18; k++) { const a = spin + k / 18 * 6.2832; for (let j = 0; j < 16; j++) { const l0 = -1.5708 + j / 16 * 3.1416, l1 = -1.5708 + (j + 1) / 16 * 3.1416; L('planet', pt(PR * Math.cos(l0), PR * Math.sin(l0), a), pt(PR * Math.cos(l1), PR * Math.sin(l1), a), k / 18, k % 3 ? 0.4 : 0.8) } }
    ring('band', PR + 1, 4, 96, spin, 0.9); ring('band', PR + 1, -4, 96, spin, 0.9)
    for (let k = 0; k < 48; k++) { const a = spin + k / 48 * 6.2832; L('band', pt(PR + 1, -4, a), pt(PR + 1, 4, a), k / 48, 0.5) }
    ring('halo', PR + 9, 0, 96, 0, 0.35)
    for (const s of [1, -1]) { ring('detail', 10, s * (PR - 1), 20, spin, 0.8); L('detail', [0, s * PR, 0], [0, s * (PR + 14), 0], 0.5, 0.9) }
    // continents: a few closed contours on the surface, turning with it
    const blobs = [[0.5, 0.3, 0.42], [2.4, -0.4, 0.36], [4.2, 0.6, 0.3], [5.4, -0.2, 0.26]]
    for (const [lo, la, s] of blobs) {
      let prev = null
      for (let k = 0; k <= 40; k++) {
        const b = k / 40 * 6.2832, rr = s * (1 + 0.25 * Math.sin(b * 3 + lo) + 0.15 * Math.sin(b * 5)), lt = la + rr * Math.sin(b), ln = spin + lo + rr * Math.cos(b) / Math.cos(la)
        const p = pt((PR + 0.5) * Math.cos(lt), (PR + 0.5) * Math.sin(lt), ln)
        if (prev) L('land', prev, p, k / 40, 0.85); prev = p
      }
    }
    // orbits: thin rings with tick marks; failed ones in segments (dashed)
    for (const s of sats) {
      const o = s.o, n = 120
      for (let k = 0; k < n; k++) {
        if ((s.st === 'failed' || s.st === 'stopped') && k % 2) continue
        L(s.st === 'failed' ? 'obad' : 'orbit', onOrbit(o, k / n * 6.2832), onOrbit(o, (k + 1) / n * 6.2832), k / n, s.sel ? 1.1 : 0.55)
        if (k % 10 === 0) L('orbit', onOrbit(o, k / n * 6.2832, -3), onOrbit(o, k / n * 6.2832, 3), k / n, 0.35)
      }
    }
    return S
  }
  const INTRO = { planet: [0, 0.9], band: [0.5, 0.6], halo: [0.7, 0.6], land: [0.9, 0.7], detail: [1.0, 0.5], orbit: [1.1, 0.9], obad: [1.1, 0.9], sat: [1.9, 0.6] }

  // ── state from the DOM ──
  let S = null, frame = 0
  const readState = () => {
    const main = root.querySelector('.sw-ormain')
    const calls = [...root.querySelectorAll('.sw-orl')].map((el, i) => ({ el, i, st: el.dataset.st || 'queued', sel: el.classList.contains('is-sel'), side: el.dataset.side }))
    S = { main, busy: main?.dataset.st === 'running', mainSel: !!main?.classList.contains('is-sel'), calls }
    // order orbits so each callout's node sits on its side, level with it: inner orbits for the upper labels
    S.sats = calls.map((c, i) => ({ ...c, o: orbitDef(i) }))
    for (const s of S.sats) {   // the node: the point of its orbit on the label's side nearest the label's height
      let best = 0, bc = 1e9
      for (let d = 0; d < 360; d += 3) {
        const a = d * Math.PI / 180, q = proj(onOrbit(s.o, a))
        if ((s.side === 'l') !== (q[0] < CX - 40 * U)) continue
        const cost = Math.abs(q[1] - labelY(s)) + (q[2] < 0 ? 60 : 0)
        if (cost < bc) { bc = cost; best = a }
      }
      s.node = best
    }
  }
  const labelY = c => parseFloat(c.el.style.top) / 100 * H + 6

  const rnd = (() => { let x = 7654321; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
  const STARS = Array.from({ length: 150 }, () => ({ x: rnd(), y: rnd(), z: 0.2 + rnd() * 0.8, p: rnd() * 6.28, s: rnd() }))
  const glow = (x, y, r, c, a) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, paint(c, a)); g.addColorStop(1, paint(c, 0)); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2) }
  const poly = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath() }
  const t0 = performance.now() / 1000

  // where a satellite is on its orbit now
  const satAngle = (s, t) => {
    if (s.st === 'running') return s.node + t * (0.5 * 104 / s.o.r)
    if (s.st === 'completed') return s.node + 0.12 * Math.sin(t * 0.3 + s.i)
    return s.node
  }

  const render = () => {
    if (resize() || frame % 30 === 0) { readPal(); readState() }
    frame++
    if (!W || !H) return
    const t = still ? 30 : (window.__swStationClock ?? performance.now() / 1000 - t0)
    yaw = 0.05 * Math.sin(t * 0.13)
    const spin = t * (S.busy ? 0.11 : 0.05)
    const reveal = g => { const [s, d] = INTRO[g]; return clamp((t - s) / d) }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    for (const s of STARS) { const a = (0.1 + 0.32 * s.z) * (0.55 + 0.45 * Math.sin(t * (0.5 + s.s) + s.p)); ctx.fillStyle = paint(P.line, a); ctx.fillRect(s.x * W, s.y * H, s.z > 0.88 ? 1.5 : 1, s.z > 0.88 ? 1.5 : 1) }
    glow(CX, CY, W * 0.3, P.line, 0.07)

    // ping across the equatorial plane, a scan ring riding the planet's latitudes, faint outer rings
    const ring2 = (r, y, a, w, dash) => { ctx.beginPath(); for (let k = 0; k <= 80; k++) { const q = proj(pt(r, y, k / 80 * 6.2832)); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]) } ctx.lineWidth = w; ctx.strokeStyle = paint(P.line, a); if (dash) ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]) }
    const ph = (t % 7) / 7
    if (ph < 0.6 && t > 2) ring2(PR + ph / 0.6 * 260, 0, 0.45 * (1 - ph / 0.6), 1.2)
    const sp = (t % 5) / 5, la = -1.3 + sp * 2.6
    ring2(PR * Math.cos(la) + 2, PR * Math.sin(la), 0.6 * Math.sin(sp * 3.14) * reveal('planet'), 1.4)
    ring2(220, 0, 0.12, 1, [2, 6]); ring2(262, 0, 0.07, 1, [1, 9])

    // wireframe in depth buckets (glow + core), a planet's far side dimmer; failed orbits in red
    const B = 8, bk = Array.from({ length: B }, () => []), red = []
    for (const [p1, p2, g, o, m] of build(spin, S.sats)) {
      const [s, d] = INTRO[g], prog = (t - s) / d
      if (prog <= o) continue
      const a1 = proj(p1), a2 = proj(p2)
      const f = clamp(((a1[2] + a2[2]) / 2 + 120) / 240)
      const a = (0.1 + 0.8 * f) * m * clamp((prog - o) * 6)
      if (g === 'obad') { red.push([a1, a2, a]); continue }
      bk[Math.min(B - 1, (a * B) | 0)].push(a1, a2)
    }
    bk.forEach((list, b) => {
      if (!list.length) return
      ctx.beginPath(); for (let i = 0; i < list.length; i += 2) { ctx.moveTo(list[i][0], list[i][1]); ctx.lineTo(list[i + 1][0], list[i + 1][1]) }
      const a = (b + 0.5) / B
      ctx.lineWidth = 3; ctx.strokeStyle = paint(P.line, a * 0.13); ctx.stroke()
      ctx.lineWidth = 0.8; ctx.strokeStyle = paint(P.line, a * 0.95); ctx.stroke()
    })
    for (const [a1, a2, a] of red) { ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.lineWidth = 0.9; ctx.strokeStyle = paint(P.bad, a * 0.9); ctx.stroke() }
    const core = proj([0, PR + 14, 0])
    glow(CX, CY, 70 * U, P.line, (S.busy ? 0.12 + 0.06 * Math.sin(t * 3) : 0.09) * reveal('planet'))

    // satellites: a small wireframe bus with two panel wings, oriented along the orbit
    const sr = reveal('sat')
    for (const s of S.sats) {
      if (sr <= 0) break
      const a = satAngle(s, t), col = stCol(s.st)
      const c3 = onOrbit(s.o, a), q = proj(c3)
      const behind = q[2] < 0 && Math.hypot(q[0] - CX, q[1] - CY) < PR * U * 1.05
      const vis = (behind ? 0.25 : 1) * sr
      s.q = q
      if (s.st === 'running') for (let k = 1; k < 26; k++) {   // trail
        const p1 = proj(onOrbit(s.o, a - (k - 1) * 0.025)), p2 = proj(onOrbit(s.o, a - k * 0.025))
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineWidth = 1.6; ctx.strokeStyle = paint(P.hot, (1 - k / 26) * 0.85 * vis); ctx.stroke()
      }
      const tang = (da, dr = 0, dy = 0) => proj(onOrbit(s.o, a + da, dr, dy))
      let fa = 0.45
      if (s.st === 'running') fa = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2 + s.i))
      if (s.st === 'failed') fa = Math.sin(t * 17 + s.i * 3) > 0.2 || Math.sin(t * 5.3 + s.i) > 0.6 ? 0.6 : 0.12
      const idle = s.st === 'queued' || s.st === 'stopped'
      const d = 0.06, w = 6
      // bus
      poly([tang(-d * 0.5, -w), tang(d * 0.5, -w), tang(d * 0.5, w), tang(-d * 0.5, w)])
      if (!idle) { ctx.fillStyle = paint(col, fa * vis); ctx.fill() }
      ctx.lineWidth = 1; ctx.strokeStyle = paint(col, 0.95 * vis); if (idle) ctx.setLineDash([2.5, 2]); ctx.stroke()
      // wings, out of the orbit plane
      for (const sy of [-1, 1]) {
        poly([tang(-d * 0.4, 0, sy * 7), tang(d * 0.4, 0, sy * 7), tang(d * 0.4, 0, sy * 24), tang(-d * 0.4, 0, sy * 24)])
        ctx.strokeStyle = paint(P.line, 0.8 * vis); ctx.stroke()
        const m0 = tang(0, 0, sy * 9), m1 = tang(0, 0, sy * 15); ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]); ctx.stroke()
      }
      ctx.setLineDash([])
      if (s.st === 'running' && !behind) { const f = (t * 0.8 + s.i * 0.3) % 1; ctx.beginPath(); ctx.arc(q[0], q[1], 6 + f * 16, 0, 6.2832); ctx.lineWidth = 1; ctx.strokeStyle = paint(P.hot, 0.55 * (1 - f) * sr); ctx.stroke() }
    }

    // frame: the station's chamfered border, accent bars, tick ruler
    ctx.globalCompositeOperation = 'source-over'
    const i0 = 3, ch = 9
    poly([[i0 + ch, i0], [W - i0 - ch, i0], [W - i0, i0 + ch], [W - i0, H - i0 - ch], [W - i0 - ch, H - i0], [i0 + ch, H - i0], [i0, H - i0 - ch], [i0, i0 + ch]])
    ctx.lineWidth = 1; ctx.strokeStyle = paint(P.line, 0.26); ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = paint(P.hot, 0.85)
    const bar = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke() }
    bar(i0, H * 0.4, i0, H * 0.4 + 26); bar(W - i0, H * 0.6 - 26, W - i0, H * 0.6); bar(W * 0.5 - 30, H - i0, W * 0.5 + 30, H - i0)
    ctx.lineWidth = 1; ctx.strokeStyle = paint(P.line, 0.3)
    ctx.beginPath(); for (let x = W * 0.5 - 120; x <= W * 0.5 + 120; x += 8) { if (Math.abs(x - W * 0.5) < 34) continue; ctx.moveTo(x, H - i0); ctx.lineTo(x, H - i0 - ((x / 8 | 0) % 4 ? 3 : 6)) } ctx.stroke()

    // leader lines to each orbit's node pin, brackets on the selected satellite, the box
    if (W >= 520) {
      for (const s of S.sats) {
        if (sr <= 0) continue
        const pin = proj(onOrbit(s.o, s.node)), top = labelY(s) - 6, left = s.side === 'l', u = W / 666
        const x0 = left ? 14 * u : W - 14 * u, x1 = left ? 150 * u : W - 150 * u
        ctx.globalAlpha = sr
        ctx.strokeStyle = s.sel ? paint(P.hot, 0.95) : paint(P.line, 0.45); ctx.lineWidth = s.sel ? 1.2 : 0.8
        ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x1, top); ctx.lineTo(pin[0], pin[1]); ctx.stroke()
        ctx.fillStyle = paint(P.line, 0.95); ctx.fillRect(pin[0] - 1.5, pin[1] - 1.5, 3, 3)
        if (s.sel && s.q) brackets(s.q[0], s.q[1], 16 + 2 * Math.sin(t * 3))
        ctx.globalAlpha = 1
      }
      const mb = S.main
      if (mb) {
        const u = W / 666, bx = parseFloat(mb.style.left) / 100 * W, by = parseFloat(mb.style.top) / 100 * H, bw = parseFloat(mb.style.width) / 100 * W, bh = 18 * u
        ctx.strokeStyle = paint(P.line, 0.45); ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.moveTo(bx + 24 * u, by + bh); ctx.lineTo(bx + 24 * u, by + bh + 6); ctx.lineTo(core[0], core[1]); ctx.stroke()
        poly([[bx, by], [bx + bw - 10 * u, by], [bx + bw, by + bh / 2], [bx + bw - 10 * u, by + bh], [bx, by + bh]])
        ctx.fillStyle = paint(P.bg, 0.88); ctx.fill(); ctx.strokeStyle = S.mainSel ? paint(P.hot, 0.95) : paint(P.line, 0.85); ctx.lineWidth = S.mainSel ? 1.4 : 0.9; ctx.stroke()
      }
    }
  }
  const brackets = (x, y, r) => {
    ctx.strokeStyle = paint(P.hot, 0.95); ctx.lineWidth = 1.3
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.moveTo(x + sx * r, y + sy * (r - 7)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - 7), y + sy * r); ctx.stroke() }
  }
  let raf = 0, tick = 0
  const loop = () => { if (!canvas.isConnected) { stop(); return } render(); if (!still) raf = window.requestAnimationFrame(loop) }
  const stop = () => { window.cancelAnimationFrame(raf); clearInterval(tick); probe.remove(); root.classList.remove('has-scene') }
  canvas.swOrbitFrame = render
  raf = window.requestAnimationFrame(loop)
  if (still) tick = setInterval(() => { if (canvas.isConnected) render(); else stop() }, 1000)
  return stop
}

function CmdOrbitScene() {
  const ref = useRef(null)
  useEffect(() => startCmdOrbitScene(ref.current), [])
  return jsx('canvas', { className: 'sw-orcv', ref, 'aria-hidden': 'true' })
}

/** The Commands tab's ORBIT panel: FLEET's markup (callouts, a box, corner readouts) over the live orbit
 * scene. Up to six commands get a callout (alternating sides, the picked one always among them); a callout
 * picks its command like a list row. Without a 2D canvas the panel stays hidden (the list says it all). */
function CmdOrbit({ t, rows, picked, now, onPick }) {
  let shown = rows.slice(0, 6)
  if (picked && !shown.includes(picked)) shown = [...shown.slice(0, 5), picked]
  const sides = { l: shown.filter((_, i) => i % 2 === 0), r: shown.filter((_, i) => i % 2 === 1) }
  const flying = rows.filter(p => p.status === 'running').length
  const ended = rows.filter(p => p.status === 'completed' || p.status === 'failed').length
  const n = st => String(rows.filter(p => p.status === st).length).padStart(2, '0')
  const callouts = Object.entries(sides).flatMap(([side, list]) => list.map((p, k) => {
    const ly = list.length === 1 ? 190 : 110 + (k * 170) / (list.length - 1)
    const time = p.status === 'running' ? fmtDuration(p.started_at ? now - p.started_at : null, t) : p.status === 'stopped' ? '' : fmtDuration(p.duration_s, t)
    const word = t(`sw.proc.short.${p.status}`)
    return jsx(Tip, {
      label: tipText(p.command),
      children: jsxs('button', {
        type: 'button', className: `sw-orl${p === picked ? ' is-sel' : ''}`, 'data-side': side, 'data-st': p.status,
        style: { top: pct(ly, ORBIT_H), left: pct(side === 'l' ? 14 : ORBIT_W - 164, ORBIT_W), width: pct(150, ORBIT_W) },
        'aria-pressed': p === picked, 'aria-label': `${commandLine(p.command)}: ${word}`, onClick: () => onPick(p.id),
        children: [
          jsx('span', { className: 'sw-orn', children: commandLine(p.command) }, 'n'),
          jsx('span', { className: 'sw-orv', children: [hudCaps(word), time ? ` · ${time}` : ''].join('') }, 'v')
        ]
      })
    }, p.id)
  }))
  const bars = Array.from({ length: 14 }, (_, k) => jsx('i', { className: rows.length && k < Math.round((14 * ended) / rows.length) ? 'on' : undefined, style: { '--k': k } }, k))
  const tele = (side, list) => jsx('div', {
    className: 'sw-ortele', 'data-side': side, 'aria-hidden': 'true',
    children: list.map(([k, v], i) => jsxs('div', { className: 'sw-otl', style: { '--i': i * 2 + (side === 'r' ? 1 : 0) }, children: [jsx('span', { children: hudCaps(k) }, 'k'), jsx('b', { className: isNum(v) ? 'sw-num' : undefined, children: v }, `v-${v}`)] }, k))
  }, `tele-${side}`)
  return jsx(HudPanel, {
    title: t('sw.hudCommands.orbit'), span: 6, className: 'sw-cmorb',
    children: [jsxs('div', {
      className: 'sw-hgrid sw-orbit', role: 'group', 'aria-label': t('sw.hudCommands.orbitLabel'),
      children: [
        jsx(CmdOrbitScene, {}, 'scene'),
        jsxs('div', {
          className: 'sw-ormain', 'data-st': flying ? 'running' : 'completed', 'aria-hidden': 'true',
          style: { top: pct(40, ORBIT_H), left: pct(226, ORBIT_W), width: pct(214, ORBIT_W) },
          children: [
            jsx('span', { className: 'sw-orn', children: `★ ${hudCaps(t('sw.hudCommands.orbitMain', flying))}` }, 'n'),
            jsxs('span', { className: 'sw-orp', children: [jsx('b', { children: `${ended}/${rows.length}` }, 'n'), jsx('span', { className: 'sw-orbars', children: bars }, 'b')] }, 'p')
          ]
        }, 'main'),
        ...callouts,
        tele('l', [[t('sw.hudCommands.teleLink'), hudCaps(t(flying ? 'sw.hudAgents.teleActive' : 'sw.hudAgents.teleStandby'))], [t('sw.hudCommands.teleOrbits'), String(rows.length).padStart(2, '0')], [t('sw.hudCommands.teleEnded'), `${ended}/${rows.length}`]]),
        tele('r', ['running', 'failed', 'stopped'].map(st => [t(`sw.proc.short.${st}`), n(st)]))
      ]
    }, 'orbit')]
  }, 'orbit')
}


function Orbit({ t, main, subs, selected, onSelect, flash, waitingOn, calm }) {
  const wings = orbitWings(subs)
  const done = subs.filter(u => u.status === 'completed').length
  const live = !calm && subs.some(u => u.status === 'running')
  // callouts: a column each side, spread top to bottom in the order of their wings
  const side = wings.map((w, i) => ({ w, i, ...wingPin(w.slot) }))
  const place = list => list.sort((a, b) => a.pin[1] - b.pin[1]).map((o, k) => ({ ...o, ly: Math.round(list.length === 1 ? 190 : 96 + (k * 184) / (list.length - 1)) }))
  const calls = [...place(side.filter(o => o.left)), ...place(side.filter(o => !o.left))].sort((a, b) => a.i - b.i)
  // the main agent's box: wide enough for its longest state (★ MAIN · WAITING ON 12)
  const core = iso(0, 0, 17), bx = 226, by = 40, bw = 214
  const svgKids = [
    truss(),
    ...wings.map(w => wing(w, w.u ? flash.get(w.u.key) : null, w.u && selected === w.u.key)),
    cylinder(-78, 78, 17, 6, 'body', 'sw-orbody'),
    cylinder(78, 104, 10, 2, 'cap1'),
    cylinder(-104, -78, 10, 2, 'cap2'),
    ...calls.flatMap(o => {
      const ex = o.left ? 150 : ORBIT_W - 150, mx = ex + (o.left ? 14 : -14)
      return [
        jsx('path', { className: 'sw-orlead', pathLength: 100, d: `M${o.left ? 14 : ORBIT_W - 14},${o.ly} H${ex} H${mx} L${o.pin[0].toFixed(1)},${o.pin[1].toFixed(1)}` }, `l${o.i}`),
        jsx('circle', { className: 'sw-orpin', cx: o.pin[0].toFixed(1), cy: o.pin[1].toFixed(1), r: 2.2 }, `p${o.i}`)
      ]
    }),
    jsx('path', { className: 'sw-orlead', pathLength: 100, d: `M${bx + 24},${by + 18} V${by + 40} L${core[0].toFixed(1)},${core[1].toFixed(1)}` }, 'lmain'),
    jsx('circle', { className: 'sw-orpin', cx: core[0].toFixed(1), cy: core[1].toFixed(1), r: 2.6 }, 'pmain'),
    jsx('path', { className: `sw-orbox${selected === main.key ? ' is-sel' : ''}`, d: `M${bx},${by} h${bw - 10} l10,9 l-10,9 h-${bw - 10}z` }, 'box')
  ]
  const mainWord = statusWord(t, main, waitingOn)
  const bars = Array.from({ length: 14 }, (_, k) => jsx('i', { className: subs.length && k < Math.round((14 * done) / subs.length) ? 'on' : undefined, style: { '--k': k } }, k))
  const callout = o => {
    const pos = { top: pct(o.ly, ORBIT_H), left: pct(o.left ? 14 : ORBIT_W - 150, ORBIT_W), width: pct(136, ORBIT_W) }
    if (o.w.rest) {
      const rest = o.w.rest
      const counts = ['completed', 'running', 'queued', 'failed', 'stopped'].map(st => [st, rest.filter(u => u.status === st).length]).filter(([, n]) => n)
      return jsxs('div', {
        className: 'sw-orl is-grp', 'data-side': o.left ? 'l' : 'r', style: pos, role: 'img',
        'aria-label': t('sw.hudAgents.orbitMoreLabel', rest.length, counts.map(([st, n]) => `${n} ${t(`sw.st.${st}`)}`).join(', ')),
        children: [
          jsx('span', { className: 'sw-orn', 'aria-hidden': 'true', children: hudCaps(t('sw.hudAgents.orbitMore', rest.length)) }, 'n'),
          jsx('span', { className: 'sw-orv', 'aria-hidden': 'true', children: counts.map(([st, n]) => jsx('span', { className: 'sw-orm', 'data-st': st, children: n }, st)) }, 'v')
        ]
      }, 'group')
    }
    const u = o.w.u
    const time = u.status === 'running' || u.status === 'completed' || u.status === 'failed' ? fmtDuration(u.duration, t) : ''
    return jsx(Tip, {
      label: [tipText(String(u.rec?.goal || '').trim() || u.name), tipText(unitLine(t, u))].filter(Boolean).join('\n'),
      children: jsxs('button', {
        type: 'button', className: `sw-orl${selected === u.key ? ' is-sel' : ''}${flash.get(u.key) ? ` is-${flash.get(u.key)}` : ''}`, 'data-side': o.left ? 'l' : 'r',
        'data-st': u.status, 'data-icon': unitIcon(u), 'data-batch': u.batch, 'data-node': u.key, style: pos, 'aria-pressed': selected === u.key, 'aria-label': `${u.name}: ${statusWord(t, u, waitingOn)}`,
        onClick: () => onSelect(u.key),
        children: [
          jsx('span', { className: 'sw-orn', children: slugName(u.name) }, 'n'),
          jsx('span', { className: 'sw-orv', children: [hudCaps(t(`sw.st.${u.status}`)), time ? ` · ${time}` : ''].join('') }, 'v')
        ]
      })
    }, u.key)
  }
  return jsxs('div', {
    className: 'sw-hgrid sw-orbit', role: 'group', 'aria-label': t('sw.agents'), 'data-done': done, 'data-live': live ? 'true' : undefined,
    'data-calm': calm ? 'true' : undefined, 'data-subs': subs.length,
    children: [
      jsx(StationScene, {}, 'scene'),
      calm ? null : jsx('div', { className: 'sw-orscan', 'aria-hidden': 'true' }, 'scan'),
      jsx('svg', { className: 'sw-ors', viewBox: `0 0 ${ORBIT_W} ${ORBIT_H}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', children: svgKids }, 'svg'),
      jsx(Tip, { label: [tipText(main.name), tipText(unitLine(t, main))].filter(Boolean).join('\n'), children: jsxs('button', {
        type: 'button', className: `sw-ormain${selected === main.key ? ' is-sel' : ''}${flash.get(main.key) ? ` is-${flash.get(main.key)}` : ''}`,
        'data-st': main.status, 'data-icon': unitIcon(main), 'data-main': 'true', 'data-node': main.key,
        style: { top: pct(by, ORBIT_H), left: pct(bx, ORBIT_W), width: pct(bw, ORBIT_W) },
        'aria-pressed': selected === main.key, 'aria-label': `${main.name}: ${mainWord}`, onClick: () => onSelect(main.key),
        children: [
          jsx('span', { className: 'sw-orn', children: `★ ${hudCaps(t('sw.hudAgents.orbitMain', mainWord))}` }, 'n'),
          // no subagent: no n/total counter and bars under MAIN (nothing to count yet)
          subs.length ? jsxs('span', {
            className: 'sw-orp', 'aria-hidden': 'true',
            children: [jsx('b', { children: `${done}/${subs.length}` }, 'n'), jsx('span', { className: 'sw-orbars', children: bars }, 'b')]
          }, 'p') : null
        ]
      }) }, 'main'),
      ...calls.map(callout),
      ...telemetry(t, mainWord, subs, done, live),
      subs.length ? null : jsx('p', { className: 'sw-nosub', children: t('sw.noSubagents') }, 'none'),
      subs.length ? jsx('div', {
        className: 'sw-orkey', 'aria-hidden': 'true',
        children: ['running', 'completed', 'failed', 'queued'].map(st => jsx('span', { 'data-st': st, children: hudCaps(t(`sw.st.${st}`)) }, st))
      }, 'key') : null
    ]
  })
}

/** Station telemetry: two corner columns of the run's own numbers. The left one types in from the left,
 *  the right one from the right, line after line; a changed value rolls in. Decorative (aria-hidden):
 *  every number here is also said by the panels below. */
function telemetry(t, mainWord, subs, done, live) {
  const n = st => subs.filter(u => u.status === st).length
  const col = (side, rows) => jsx('div', {
    className: 'sw-ortele', 'data-side': side, 'aria-hidden': 'true',
    children: rows.map(([k, v], i) => jsxs('div', {
      className: 'sw-otl', style: { '--i': i * 2 + (side === 'r' ? 1 : 0) },
      children: [jsx('span', { children: hudCaps(k) }, 'k'), jsx('b', { className: isNum(v) ? 'sw-num' : undefined, children: v }, `v-${v}`)]
    }, k))
  }, `tele-${side}`)
  // no subagent: no WINGS line and no right column (WORKING / FAILED / WAITING would all read 00)
  return [
    col('l', [
      [t('sw.hudAgents.teleScan'), hudCaps(t(live ? 'sw.hudAgents.teleActive' : 'sw.hudAgents.teleStandby'))],
      [t('sw.hudAgents.teleCore'), hudCaps(mainWord)],
      ...(subs.length ? [[t('sw.hudAgents.teleWings'), `${done}/${subs.length}`]] : [])
    ]),
    subs.length ? col('r', ['running', 'failed', 'queued'].map(st => [t(`sw.st.${st}`), String(n(st)).padStart(2, '0')])) : null
  ]
}

/** SPENT: what the subagents spent, their tokens and tools, and how many are done (one cell each). */
function Score({ t, subs }) {
  const done = subs.filter(u => u.status === 'completed').length
  const sum = sumCost(subs.map(u => u.rec))
  const cost = fmtCost(sum.usd, sum.status, t)
  const tokens = subs.reduce((n, u) => n + (Number(u.rec?.tokens) || 0), 0)
  const tools = subs.reduce((n, u) => n + (Number(u.rec?.tool_calls ?? u.rec?.tool_count) || 0), 0)
  return jsx(HudPanel, {
    title: t('sw.hudAgents.spent'), span: 2, className: 'sw-hspent',
    // no subagent: no cost, tokens, tools, ratio, cells or axis, only what will appear and when
    children: subs.length ? [jsxs('div', {
      className: 'sw-score', role: 'group', 'aria-label': subs.length ? t('sw.score.label', done, subs.length) : t('sw.score.none'),
      children: [
        jsx('div', {
          className: 'sw-hbig sw-spent',
          children: subs.length
            ? jsx(Tip, {
              label: t('sw.cost.tip', sum.priced, sum.included, sum.unknown),
              children: jsx('b', { className: 'sw-money', tabIndex: 0, children: cost || '—' })
            })
            : jsx('b', { children: '—' })
        }, '$'),
        jsx(HudKV, {
          rows: [
            [t('sw.hudAgents.tokens'), fmtTokens(tokens, t) || '—'],
            [t('sw.hudAgents.toolCalls'), String(tools)]
          ]
        }, 'kv'),
        jsxs('div', {
          className: 'sw-tk sw-sdone',
          children: [
            jsxs('div', {
              className: 'sw-tkh',
              children: [
                jsx('span', { 'aria-hidden': 'true', children: hudCaps(t('sw.hudAgents.doneK')) }, 'l'),
                jsx('span', { className: 'sw-sr', children: subs.length ? t('sw.score.done') : t('sw.score.none') }, 's'),
                // Keyed by the count: a new count mounts anew and rolls up into place.
                jsxs('b', { className: 'sw-big', children: [jsx('span', { className: 'sw-bign', children: done }, `n-${done}`), jsx('small', { children: `/${subs.length}` }, 't')] }, 'b')
              ]
            }, 'h'),
            jsx(Cells, { statuses: subs.map(u => u.status), className: 'sw-seg' }, 'c'),
            jsxs('div', { className: 'sw-tks', 'aria-hidden': 'true', children: [jsx('span', { children: '0' }, 'a'), jsx('span', { children: subs.length }, 'b')] }, 's')
          ]
        }, 'done')
      ]
    }, 'score')] : [jsx('p', { className: 'sw-hnote', children: t('sw.hudAgents.noSpent') }, 'none')]
  })
}

/** TIME PER AGENT: one track per subagent, its run time against the longest, in its status colour. */
function FleetTimes({ t, subs }) {
  const top = Math.max(1, ...subs.map(u => (Number.isFinite(u.duration) ? u.duration : 0)))
  // as many tracks as the station has wings: the agents that need eyes first, the rest counted below
  const shown = subs.length > ORBIT_WINGS
    ? subs.map((u, i) => [u, i]).sort((a, b) => (ORBIT_RANK[a[0].status] ?? 3) - (ORBIT_RANK[b[0].status] ?? 3) || a[1] - b[1]).slice(0, ORBIT_WINGS).map(x => x[0])
    : subs
  const rest = subs.filter(u => !shown.includes(u))
  return jsx(HudPanel, {
    title: t('sw.hudAgents.time'), span: 2, className: 'sw-htime',
    children: subs.length
      ? [jsx('div', {
        className: 'sw-tlist', role: 'group', 'aria-label': t('sw.hudAgents.time'),
        children: shown.map(u => jsxs('div', {
        className: 'sw-tk', 'data-st': u.status,
        children: [
          jsxs('div', { className: 'sw-tkh', children: [jsx(OneLine, { text: slugName(u.name), className: 'sw-tkn' }, 'l'), jsx('b', { children: fmtDuration(u.duration, t) || '—' }, 'v')] }, 'h'),
          jsx('div', { className: 'sw-tkb', 'aria-hidden': 'true', children: jsx('i', { style: { width: `${Math.max(1.5, Math.min(100, ((u.duration || 0) / top) * 100)).toFixed(1)}%` } }) }, 'b')
        ]
      }, u.key))
      }, 'l'),
      rest.length ? jsx('p', { className: 'sw-tmore', children: hudCaps(t('sw.hudAgents.timeMore', rest.length, rest.filter(u => u.status === 'completed').length)) }, 'more') : null,
      // every track shares one scale, so it is drawn once under them
      jsxs('div', { className: 'sw-tks sw-tkax', 'aria-hidden': 'true', children: [jsx('span', { children: fmtDuration(0, t) }, 'a'), jsx('span', { children: fmtDuration(top, t) }, 'b')] }, 'ax')]
      : [jsx('p', { className: 'sw-hnote', children: t('sw.hudAgents.noTime') }, 'none')]
  })
}

const FILE_CELLS = 48

/** FILES: the chat's files as cells — changed, failed, only read — with their counts and a legend. */
function FleetFiles({ t, files }) {
  const all = files.data?.files || []
  const kinds = all.map(f => {
    const s = fileState(f, false)
    return s === 'failed' ? 'failed' : s === 'read' ? 'read' : 'changed'
  })
  const n = k => kinds.filter(x => x === k).length
  const order = { changed: 0, failed: 1, read: 2 }
  const shown = [...kinds].sort((a, b) => order[a] - order[b]).slice(0, FILE_CELLS)
  const leg = (k, word) => jsx('span', { 'data-k': k, children: hudCaps(word) }, k)
  return jsx(HudPanel, {
    title: t('sw.hudAgents.files'), span: 2, className: 'sw-hfiles',
    children: all.length
      ? [
        // a kind with no file gets no count (no "CHANGED 0"); its legend entry stays as the key
        jsxs('div', { className: 'sw-hrow', children: [n('changed') ? jsx('b', { children: hudCaps(t('sw.hudAgents.changedN', n('changed'))) }, 'c') : null, n('read') ? jsx('b', { children: hudCaps(t('sw.hudAgents.readN', n('read'))) }, 'r') : null] }, 'n'),
        jsxs('div', {
          className: 'sw-fcells', 'data-big': all.length <= 12 ? 'true' : undefined, role: 'img', 'aria-label': t('sw.hudAgents.filesLabel', n('changed'), n('failed'), n('read')),
          children: [
            ...shown.map((k, i) => jsx('i', { 'data-k': k }, i)),
            kinds.length > FILE_CELLS ? jsx('span', { className: 'sw-fmore', children: t('sw.hudAgents.moreFiles', kinds.length - FILE_CELLS) }, 'more') : null
          ]
        }, 'cells'),
        jsxs('div', { className: 'sw-fleg', 'aria-hidden': 'true', children: [leg('changed', t('sw.hudAgents.legChanged')), leg('failed', t('sw.hudAgents.legFailed')), leg('read', t('sw.hudAgents.legRead'))] }, 'leg')
      ]
      : [jsx('p', { className: 'sw-hnote', children: files.loading ? t('sw.loading') : t('sw.hudAgents.noFiles') }, 'none')]
  })
}

/** An agent's name wherever the HUD prints it (AGENT card, DETAIL): one spelling for one agent. */
const agentLabel = u => `${u.main ? '★ ' : ''}${slugName(u.name)}`

/** AGENT: the selected agent's name, its status chip, and its key facts. */
function FleetAgent({ t, u, subs, files, waitingOn }) {
  const goal = String(u.rec?.goal || '').trim()
  const name = agentLabel(u)
  let rows
  if (u.main) {
    const mine = agentFiles(files.data?.files, '')
    const anyFile = mine.changed.length + mine.failed.length + mine.read.length
    rows = [
      [t('sw.hudAgents.state'), statusWord(t, u, waitingOn)],
      // no file: no FILES row at all; a kind with no file is left out of the line (no "0 changed")
      ...(anyFile ? [[t('sw.hudAgents.filesK'), t('sw.hudAgents.filesV', mine.changed.length, mine.failed.length, mine.read.length)]] : [])
    ]
  } else {
    const rec = u.rec || {}
    rows = [
      [t('sw.hudAgents.model'), modelChip(rec.model, rec.effort) || '—'],
      [t('sw.hudAgents.timeK'), fmtDuration(u.duration, t) || '—'],
      [t('sw.hudAgents.toolsK'), t('sw.hudAgents.toolsV', Number(rec.tool_calls ?? rec.tool_count) || 0, fmtTokens(rec.tokens, t), fmtCost(rec.cost_usd, rec.cost_status, t))],
      [t('sw.hudAgents.task'), goal ? jsx(OneLine, { text: goal }) : '—']
    ]
  }
  return jsx(HudPanel, {
    title: t('sw.hudAgents.agent'), span: 3, className: 'sw-hagent',
    children: [
      jsxs('div', {
        className: 'sw-rfile',
        children: [
          jsx(Tip, { label: tipText(goal || u.name), children: jsx('b', { className: 'sw-rname sw-1l', tabIndex: 0, children: name }) }, 'n'),
          hudChip(u.status, u.main ? statusWord(t, u, waitingOn) : t(`sw.st.${u.status}`))
        ]
      }, `n-${u.key}`),
      jsx(HudKV, { rows }, 'kv')
    ]
  })
}

/** An answer's first line of prose, or '' when it has none: an answer that opens with data (JSON, a
 *  code fence) says nothing in a one-line log, so the row shows what the agent did instead. */
export function logSaid(summary) {
  return String(summary || '').split('\n').map(x => x.trim()).find(x => x && !/^([[{]|```)/.test(x)) || ''
}

/** LOG: one row per subagent — when it started, its name, its answer or what it does; a click selects it. */
function FleetLog({ t, subs, selected, onSelect, now }) {
  return jsx(HudPanel, {
    title: t('sw.hudAgents.log'), span: 3, className: 'sw-hlogp',
    children: subs.length
      ? [jsx('div', {
        className: 'sw-hlog sw-alog',
        children: subs.map(u => {
          const said = logSaid(u.rec?.summary) || unitLine(t, u)
          return jsxs('button', {
            type: 'button', 'data-st': u.status, 'aria-pressed': selected === u.key, onClick: () => onSelect(u.key),
            children: [
              jsx('span', { className: 'sw-hlt', children: fmtWhen(u.rec?.started_at, now, t) || '—' }, 't'),
              jsx('span', { className: 'sw-hle', children: slugName(u.name) }, 'e'),
              jsx(Tip, { label: tipText(u.rec?.summary || said), children: jsx('span', { className: 'sw-hlm', children: said }) }, 'm')
            ]
          }, u.key)
        })
      }, 'l')]
      : [jsx('p', { className: 'sw-hnote', children: t('sw.hudAgents.noLog') }, 'none')]
  })
}

// ── files of an agent ────────────────────────────────────────────────────────

/**
 * One agent's files from /files: `who` names everyone who touched a file ('' is the chat itself,
 * a worker is its first session id) and `editors` who changed it. A change that failed has no
 * editor; it counts as the agent's change when nobody else changed the file.
 */
export function agentFiles(files, who) {
  const changed = []
  const failed = []
  const read = []
  for (const f of files || []) {
    const by = f.who || []
    const editors = f.editors || []
    if (!by.includes(who) && !editors.includes(who)) continue
    const edit = editors.includes(who) || (f.last_failed && !editors.length && f.last_op !== 'read')
    const row = { ...f, key: f.key || pathKey(f.path) }
    const state = edit ? fileState(f, false) : 'read'
    ;(state === 'read' ? read : state === 'failed' ? failed : changed).push({ ...row, state })
  }
  // A failed edit changed nothing: it is listed and counted as failed, never as changed (FILES does the same).
  return { changed, failed, read }
}

/** How many times a file counts: its changes, or its reads. */
function fileCount(f) {
  return f.state === 'read' ? f.reads || 1 : (f.writes || 0) + (f.deletes || 0) + (f.failed || 0) || 1
}

/** A changed file's lit blocks: one per edit, at most PIPS. A longer run fills the row; its label says the real count. */
export function pips(n) {
  return Math.max(0, Math.min(PIPS, Math.floor(Number(n) || 0)))
}

/** The span of an agent's file work in this chat: its first file touch to its last, or null. */
export function fileSpan(rows) {
  const firsts = (rows || []).map(f => f.first_at).filter(Number.isFinite)
  const lasts = (rows || []).map(f => f.last_at).filter(Number.isFinite)
  return firsts.length && lasts.length ? Math.max(0, Math.max(...lasts) - Math.min(...firsts)) : null
}

/**
 * A changed file as a card: name, folder, one block per edit (capped at PIPS), what happened. The
 * file worked on now glows with a NOW badge. Hover names the full path; a click copies it.
 */
function FileCard({ t, f, cwd, label, now, order, onToast }) {
  const { dir, name } = splitPath(f.path)
  const read = f.state === 'read'
  const edits = read ? fileCount(f) : (f.writes || 0) + (f.deletes || 0) + (f.failed || 0) || (now ? 0 : 1)
  const text = label || t(`sw.file.op.${f.state}`, edits)
  const lit = f.state === 'delete' ? 0 : pips(edits)
  const copy = () => writeClip(f.path, t, onToast, t('sw.file.copied'))
  return jsx(Tip, {
    label: t('sw.file.tip', f.path),
    children: jsxs('button', {
      type: 'button', className: `sw-fr sw-ft${now ? ' is-now' : ''}`, 'data-op': f.state, onClick: copy, style: { '--i': order },
      'aria-label': t('sw.file.name', name, dir ? dirLabel(dir, cwd, t) : t('sw.file.here'), now ? t('sw.file.nowLabel', text) : text),
      children: [
        now ? jsx('span', { className: 'sw-nowb', 'aria-hidden': 'true', children: t('sw.file.nowBadge') }, 'now') : null,
        // Keyed by the file: when the file worked on changes, its name slides in anew.
        jsx('span', { className: 'sw-fn', children: name }, `n-${f.key}`),
        dir ? jsx('span', { className: 'sw-fd', children: jsx('bdi', { children: dirLabel(dir, cwd, t, false) }) }, 'd') : null,
        jsxs('span', {
          className: 'sw-pipr',
          children: [
            f.state === 'delete' ? null : jsx('span', {
              className: 'sw-pips', 'aria-hidden': 'true', 'data-lit': lit,
              children: Array.from({ length: PIPS }, (_, i) => jsx('i', { className: i < lit ? 'on' : undefined }, i))
            }, 'p'),
            jsx('span', { className: 'sw-fl', children: text }, 'l')
          ]
        }, 'r')
      ]
    })
  })
}

/** The files worked on right now, in their own block above Changed and Only read. */
function NowFiles({ t, rows, cwd, verbOf, onToast }) {
  if (!rows.length) return null
  return jsxs('div', {
    className: 'sw-fsec', 'data-sec': 'now',
    children: [
      jsx('div', { className: 'sw-fh', children: jsx('h4', { className: 'sw-k', children: t('sw.focus.now') }, 'h') }, 'h'),
      jsx('div', { className: 'sw-fgrid', children: rows.map((f, i) => jsx(FileCard, { t, f, cwd, label: verbOf(f), now: true, order: i, onToast }, `now-${f.key}`)) }, 'g')
    ]
  })
}

function ChangedFiles({ t, rows, cwd, onToast, sec = 'changed', head = 'sw.focus.changed' }) {
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, CHANGED_ROWS)
  return jsxs('div', {
    className: 'sw-fsec', 'data-sec': sec,
    children: [
      jsxs('div', {
        className: 'sw-fh',
        children: [
          jsx('h4', { className: 'sw-k', children: t(head) }, 'h')
        ]
      }, 'h'),
      jsx('div', {
        className: 'sw-fgrid',
        children: shown.map((f, i) => jsx(FileCard, { t, f, cwd, order: i, onToast }, f.key))
      }, 'g'),
      rows.length > shown.length
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setAll(true), children: t('sw.focus.more', rows.length - shown.length) }, 'more')
        : null
    ]
  })
}

function ReadFiles({ t, rows, cwd, onToast }) {
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, READ_ROWS)
  // Same rows as Changed — one block per read — so both lists line up.
  return jsxs('div', {
    className: 'sw-fsec', 'data-sec': 'read',
    children: [
      jsx('div', { className: 'sw-fh', children: jsx('h4', { className: 'sw-k', children: t('sw.focus.read') }, 'h') }, 'h'),
      jsx('div', {
        className: 'sw-fgrid',
        children: shown.map((f, i) => jsx(FileCard, { t, f: { ...f, state: 'read' }, cwd, order: i, onToast }, f.key))
      }, 'g'),
      rows.length > shown.length
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setAll(true), children: t('sw.focus.more', rows.length - shown.length) }, 'more')
        : null
    ]
  })
}

function Files({ t, theme, mine, nowRows = [], verbOf, files, onToast, empty }) {
  const cwd = files.data?.cwd
  if (files.loading && !files.data && !nowRows.length) return jsx('p', { className: 'sw-empty', children: t('sw.loading') })
  if (!mine.changed.length && !mine.failed.length && !mine.read.length && !nowRows.length) {
    return jsxs('div', { className: 'sw-fsec', 'data-sec': 'none', children: [jsx('h4', { className: 'sw-k', children: t('sw.focus.files') }, 'h'), jsx('p', { className: 'sw-empty', children: empty }, 'e')] })
  }
  // A file worked on now is shown once, in its own block, and in neither list below it;
  // each heading counts exactly the rows under it.
  const nowKeys = new Set(nowRows.map(f => f.key))
  const changed = mine.changed.filter(f => !nowKeys.has(f.key))
  // One wrapper so every list shares the same columns (Terminal): names, folders, blocks and
  // labels start at the same place in all three, and a column no row uses takes no room.
  return jsxs('div', {
    className: 'sw-flist',
    children: [
      jsx(NowFiles, { t, rows: nowRows, cwd, verbOf, onToast }, 'n'),
      jsx(ChangedFiles, { t, rows: changed, cwd, onToast }, 'c'),
      jsx(ChangedFiles, { t, rows: mine.failed.filter(f => !nowKeys.has(f.key)), cwd, onToast, sec: 'failed', head: 'sw.focus.failedH' }, 'x'),
      jsx(ReadFiles, { t, rows: mine.read.filter(f => !nowKeys.has(f.key)), cwd, onToast }, 'r')
    ]
  })
}

// ── focus panel ──────────────────────────────────────────────────────────────

/** The selected agent's big portrait: a hex in a status ring (Terminal: a bordered sprite), its tag under it. */
function Portrait({ t, theme, u }) {
  const icon = unitIcon(u)
  const term = theme === 'terminal'
  const tag = u.main ? t('sw.main.tag') : term ? t(`sw.tag.${u.status === 'running' ? u.act || 'think' : u.status}`) : t(`sw.st.${u.status}`)
  return jsxs('span', {
    className: 'sw-por', 'data-st': u.status, 'aria-hidden': 'true',
    children: [
      term ? jsx('span', { className: 'sw-pg', children: GLYPH[icon] || GLYPH.idle }, 'g') : jsx('span', { className: 'sw-pring' }, 'r'),
      term ? null : jsx('span', { className: 'sw-phx' }, 'h'),
      term ? null : jsx('span', { className: 'sw-ic', children: ICON[icon]() }, 'i'),
      jsx('span', { className: 'sw-ptag', children: tag }, 't')
    ]
  })
}

/** The panel's top: portrait, what it does in one verb line, the big headline, where and how long. */
function Hero({ t, theme, u, verb, head, full, file, where, chip, cursor }) {
  const headline = tabIndex => jsxs('div', {
    className: `sw-head${file ? ' is-file' : ''}`, tabIndex,
    children: [jsx('span', { className: 'sw-headt', children: head }, 'h'), cursor ? jsx('span', { className: 'sw-cur', 'aria-hidden': 'true' }, 'c') : null]
  }, 'h')
  return jsxs('div', {
    className: 'sw-hero',
    children: [
      jsx(Portrait, { t, theme, u }, 'p'),
      jsxs('div', {
        className: 'sw-herot',
        children: [
          // Keyed by its text: a new verb types in again.
          jsx('div', { className: 'sw-verb', children: verb }, `v-${verb}`),
          // One line: a long task or command ends in an ellipsis; the whole of it is in the tooltip.
          full ? jsx(Tip, { label: tipText(full), children: headline(0) }, 'h') : headline(undefined),
          jsxs('div', { className: 'sw-meta', children: [where ? jsx(OneLine, { text: where, className: 'sw-metat' }, 'w') : null, chip] }, 'm')
        ]
      }, 't')
    ]
  })
}

/**
 * Labelled stat tiles. A whole number counts up from 0 as the panel opens (a CSS counter, so the
 * reduced-motion lock stops it); any other value rolls in. The real value is always in the DOM.
 */
function Tiles({ tiles }) {
  return jsx('div', {
    className: 'sw-tiles',
    children: tiles.map(x => jsxs('div', {
      className: 'sw-tile', 'data-k': x.k, 'data-tone': x.tone,
      children: [
        Number.isInteger(x.n) && x.n >= 0
          ? jsx('b', { className: 'sw-tn', 'data-count': x.n, style: { '--sw-n': x.n }, children: jsx('span', { children: String(x.n) }) }, `n-${x.n}`)
          : jsx('b', { className: 'sw-tn', children: jsx('span', { children: x.v || '—' }) }, `v-${x.v}`),
        jsx('span', { className: 'sw-tl', children: x.label }, 'l')
      ]
    }, x.k))
  })
}

/** A file tool's preview is a bare path: that file is the one a subagent works on now. */
function subNowPath(rec) {
  const p = String(rec?.tool_preview || '').trim()
  return rec?.last_tool && /[\\/]/.test(p) && !/\s/.test(p) ? p : ''
}

function MainPanel({ t, theme, main, files, touching, tool, waitingOn, onToast }) {
  const all = files.data?.files || []
  const cwd = files.data?.cwd
  const mine = agentFiles(all, '')
  const now = fileGroups(all, touching).filter(f => f.state === 'active')
  const opOf = f => (touching.get(f.key)?.op || f.last_op) === 'read' ? 'read' : 'edit'
  const verbOf = f => t(`sw.verb.${opOf(f)}`)
  // The newest file it touches is the headline; keyed by it, so a new file name slides in.
  const newest = now[now.length - 1]
  let verb
  let head
  if (newest) {
    verb = t('sw.hero.now', verbOf(newest))
    head = jsx('code', { className: 'sw-nowf', children: splitPath(newest.path).name }, `c-${newest.key}`)
  } else if (main.status === 'running' && main.act === 'wait') {
    verb = t('sw.hero.waiting', waitingOn)
    head = t('sw.focus.main.waiting', waitingOn)
  } else if (tool) {
    verb = t('sw.hero.now', toolVerb(t, tool.name))
    head = tool.target ? jsx('code', { children: String(tool.target).split('\n', 1)[0] }, 'c') : t('sw.focus.main.working', toolVerb(t, tool.name))
  } else if (main.status === 'running') {
    verb = t('sw.hero.working')
    head = t('sw.focus.main.busy')
  } else {
    verb = t('sw.hero.idle')
    head = t('sw.focus.main.idle')
  }
  const newestDir = newest ? splitPath(newest.path).dir : ''
  const where = newestDir ? t('sw.focus.main.in', dirLabel(newestDir, cwd, t)) : ''
  const unreadable = files.data?.unreadable || 0
  const more = files.data?.more || 0
  return jsxs('section', {
    className: 'sw-focus', 'data-kind': 'main', 'data-st': main.status, 'aria-label': t('sw.focus.mainLabel'),
    children: [
      jsx('div', { className: 'sw-ph sw-k', children: t('sw.focus.mainLabel') }, 'l'),
      jsx(Hero, { t, theme, u: main, verb, head, full: !newest && tool?.target ? String(tool.target) : newest?.path, file: Boolean(newest || tool?.target), where, cursor: main.status === 'running' }, 'hero'),
      jsx(Tiles, {
        tiles: [
          { k: 'span', label: t('sw.tile.onTask'), v: fmtDuration(fileSpan([...mine.changed, ...mine.failed, ...mine.read]), t), tone: main.status === 'running' ? 'run' : undefined },
          { k: 'changed', label: t('sw.tile.changed'), n: mine.changed.length },
          { k: 'failed', label: t('sw.tile.failed'), n: mine.failed.length, tone: mine.failed.length ? 'bad' : undefined },
          { k: 'read', label: t('sw.tile.read'), n: mine.read.length, tone: 'idle' }
        ]
      }, 'tiles'),
      jsx(Files, { t, theme, mine, nowRows: now, verbOf, files, onToast, empty: t('sw.focus.noFiles') }, 'f'),
      more ? jsx('p', { className: 'sw-fnote', children: t('sw.file.notListed', more) }, 'more') : null,
      unreadable ? jsx('p', { className: 'sw-fnote is-bad', children: t('sw.file.unreadable', unreadable) }, 'u') : null,
      jsx('p', { className: 'sw-note', children: t('sw.focus.note') }, 'n')
    ]
  })
}

/** A subagent's verb line: what it does now while it works, else how it ended. */
function subVerb(t, u) {
  if (u.status !== 'running') return t(`sw.hero.${u.status}`)
  return u.rec?.last_tool ? t('sw.hero.now', toolVerb(t, u.rec.last_tool)) : t('sw.hero.working')
}

function SubPanel({ t, theme, u, parentName, files, onToast }) {
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState(false)
  const [allAnswer, setAllAnswer] = useState(false)
  // The backend serves a worker's output only to the chat that delegated it.
  const storedId = useContext(WatchedChat)
  const rec = u.rec || {}
  const sid = u.sid
  const goal = String(rec.goal || '').trim()
  const title = goal.split('\n', 1)[0] || u.name
  const mine = sid ? agentFiles(files.data?.files, sid) : { changed: [], failed: [], read: [] }
  const time = fmtDuration(u.duration, t)
  const doing = u.status === 'running' && rec.last_tool ? [toolVerb(t, rec.last_tool), shortTarget(rec.tool_preview)].filter(Boolean).join(' ') : ''
  const line = u.status === 'running' ? t('sw.focus.line.running', time, doing)
    : u.status === 'queued' ? t('sw.focus.line.queued')
      : u.status === 'stopped' ? t('sw.focus.line.stopped')
        : t(u.status === 'failed' ? 'sw.focus.line.failed' : 'sw.focus.line.completed', time)
  const ended = TERMINAL.has(u.status)
  const meta = [line, ended ? t('sw.focus.did', mine.changed.length, mine.read.length) : '', parentName ? t('sw.focus.startedBy', parentName) : ''].filter(Boolean).join(' · ')
  const chipText = modelChip(rec.model, rec.effort)
  const chip = chipText ? jsx(Tip, { label: t('sw.modelTip', rec.model, rec.effort), children: jsx('span', { className: 'sw-model', tabIndex: 0, children: chipText }) }, 'chip') : null
  const longTask = goal.length > TASK_CHARS
  const nowPath = doing ? subNowPath(rec) : ''
  const nowRows = nowPath ? [{ key: pathKey(nowPath), path: nowPath, state: 'active' }] : []
  const copy = async () => {
    if (!sid) return
    setBusy(true)
    try {
      const out = await ctxRef.rest(`/output?session_id=${encodeURIComponent(storedId || '')}&worker_id=${encodeURIComponent(sid)}`)
      await writeClip(out?.text || '', t, onToast)
    } catch (err) {
      console.warn(`[${ID}] output read failed`, err)
      onToast(t('sw.err.withDetail', t('sw.err.output'), String(err?.message || err)), true)
    } finally {
      setBusy(false)
    }
  }
  const open = () => {
    if (!sid) return
    host.openSession(sid).catch(err => {
      console.warn(`[${ID}] openSession failed`, err)
      onToast(String(err?.message || err), true)
    })
  }
  const answer = String(rec.summary || '').trim()
  const longAnswer = answer.length > ANSWER_CHARS || answer.split('\n').length > ANSWER_LINES
  const cost = fmtCost(rec.cost_usd, rec.cost_status, t)
  return jsxs('section', {
    className: 'sw-focus', 'data-kind': 'sub', 'data-st': u.status, 'aria-label': t('sw.focus.subLabel'),
    children: [
      jsx('div', { className: 'sw-ph sw-k', children: t('sw.focus.subLabel') }, 'l'),
      jsx(Hero, { t, theme, u, verb: subVerb(t, u), head: title, full: goal, where: meta, chip, cursor: u.status === 'running' }, 'hero'),
      jsx(Tiles, {
        tiles: [
          { k: 'time', label: t('sw.tile.runTime'), v: time, tone: u.status === 'failed' ? 'bad' : u.status === 'running' ? 'run' : undefined },
          { k: 'tools', label: t('sw.tile.tools'), n: rec.tool_calls ?? rec.tool_count ?? 0 },
          { k: 'tokens', label: t('sw.tile.tokens'), v: fmtTokens(rec.tokens, t) },
          { k: 'cost', label: t('sw.tile.cost'), v: cost }
        ]
      }, 'tiles'),
      goal ? jsxs('p', {
        className: 'sw-task',
        children: [
          jsx('b', { children: t('sw.focus.task') }, 'k'), ' — ',
          longTask && !full ? `${goal.slice(0, TASK_CHARS).trimEnd()}…` : goal,
          longTask ? jsx('button', { type: 'button', className: 'sw-more sw-inl', onClick: () => setFull(v => !v), children: t(full ? 'sw.focus.showLess' : 'sw.focus.showAll') }, 'x') : null
        ]
      }, 'task') : null,
      // Its answer arrives like a transmission: corner brackets, a signal mark, its status colour.
      ended ? jsxs('div', {
        className: 'sw-ans', 'data-st': u.status,
        children: [
          jsxs('div', { className: 'sw-k sw-ansh', children: [jsx('span', { className: 'sw-sig', 'aria-hidden': 'true', children: [0, 1, 2, 3].map(i => jsx('i', {}, i)) }, 's'), t('sw.focus.answer')] }, 'k'),
          jsx('div', { className: `sw-anst${longAnswer && !allAnswer ? ' is-folded' : ''}`, style: { '--sw-lines': ANSWER_LINES }, children: answer || t('sw.focus.noAnswer') }, 't'),
          longAnswer ? jsx('button', { type: 'button', className: 'sw-more sw-ansm', 'aria-expanded': allAnswer, onClick: () => setAllAnswer(v => !v), children: t(allAnswer ? 'sw.focus.showLess' : 'sw.focus.showAll') }, 'm') : null,
          rec.summary_truncated && (allAnswer || !longAnswer) ? jsx('div', { className: 'sw-fnote', children: t('sw.focus.answerCut') }, 'c') : null
        ]
      }, 'ans') : null,
      jsx(Files, { t, theme, mine, nowRows, verbOf: () => toolVerb(t, rec.last_tool), files, onToast, empty: t('sw.focus.noFilesSub') }, 'f'),
      jsxs('div', {
        className: 'sw-btns',
        children: [
          jsx(IconButton, { label: t(busy ? 'sw.copying' : 'sw.focus.copy'), icon: ICON.copy, onClick: copy, disabled: !sid, busy, text: true, primary: true }, 'c'),
          jsx(IconButton, { label: t('sw.focus.open'), icon: ICON.open, onClick: open, disabled: !sid, text: true }, 'o')
        ]
      }, 'b')
    ]
  })
}

// ── run picker ───────────────────────────────────────────────────────────────

function RunBar({ t, view, runs, onPick, onBack }) {
  const [open, setOpen] = useState(false)
  const [older, setOlder] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const away = event => { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
    const esc = event => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])
  const pick = key => {
    setOpen(false)
    onPick(key)
  }
  const shown = older ? runs.earlier : runs.earlier.slice(0, HISTORY_PAGE)
  const row = (key, run, on) => jsxs('button', {
    type: 'button', role: 'menuitem', className: `sw-mr${on ? ' is-on' : ''}`, 'data-run': key, onClick: () => pick(key),
    children: [
      jsx(Cells, { statuses: run.statuses, className: 'sw-mini' }, 'c'),
      jsx('span', { className: 'sw-mrn', children: run.name }, 'n'),
      jsx('span', { className: 'sw-mrx', children: run.meta }, 'x')
    ]
  }, key)
  return jsxs('div', {
    className: 'sw-runb', ref,
    children: [
      jsx('button', {
        type: 'button', className: 'sw-pick', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': t('sw.run.pick'), onClick: () => setOpen(v => !v),
        children: [jsx('span', { className: 'sw-pickn', children: view.name }, 'n'), jsx('span', { className: 'sw-pickv', 'aria-hidden': 'true', children: ICON.chev(true) }, 'v')]
      }, 'p'),
      view.kind === 'live' ? jsx('span', { className: 'sw-ld', 'aria-hidden': 'true' }, 'ld') : null,
      jsx(OneLine, { text: view.meta, className: 'sw-runm' }, 'm'),
      view.kind === 'past' ? jsx('button', { type: 'button', className: 'sw-back', onClick: onBack, children: t('sw.run.back') }, 'b') : null,
      open ? jsxs('div', {
        className: 'sw-menu', role: 'menu', 'aria-label': t('sw.run.pick'),
        children: [
          runs.now ? row('now', runs.now, view.kind !== 'past') : null,
          runs.earlier.length ? jsx('div', { className: 'sw-mh sw-k', role: 'presentation', children: t('sw.run.earlier') }, 'h') : null,
          ...shown.map(r => row(r.key, r, view.key === r.key)),
          !older && runs.earlier.length > HISTORY_PAGE
            ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setOlder(true), children: t('sw.run.older', runs.earlier.length - HISTORY_PAGE) }, 'more')
            : null
        ]
      }, 'menu') : null
    ]
  })
}

/** A unit that just finished plays its moment: 'done' (ring closes green) or 'fail' (shakes red). */
function useFlash(units, active) {
  const prev = useRef(new Map())
  const timers = useRef(new Set())
  const [flash, setFlash] = useState(() => new Map())
  const sig = units.map(u => `${u.key}:${u.status}`).join('|')
  // Each moment ends on its own timer: a later finish must not cancel an earlier one's end.
  useEffect(() => () => { timers.current.forEach(stop => stop()) }, [])
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(units.map(u => [u.key, u.status]))
    if (!active) return
    const hits = units.filter(u => before.has(u.key) && !TERMINAL.has(before.get(u.key)) && (u.status === 'completed' || u.status === 'failed'))
    if (!hits.length) return
    setFlash(cur => {
      const next = new Map(cur)
      for (const u of hits) next.set(u.key, u.status === 'completed' ? 'done' : 'fail')
      return next
    })
    const stop = ctxRef.setTimeout(() => {
      timers.current.delete(stop)
      setFlash(cur => {
        const next = new Map(cur)
        for (const u of hits) next.delete(u.key)
        return next
      })
    }, FLASH_MS)
    timers.current.add(stop)
  }, [sig, active])
  return flash
}

// ── background commands ──────────────────────────────────────────────────────

/** First non-empty line of a command, for the one-line row; the full text is the tooltip. */
export function commandLine(command) {
  return String(command || '').split('\n').map(s => s.trim()).find(Boolean) || ''
}

/** An output line that reads as an error. */
export const ERROR_LINE = /error|failed|exception|traceback/i

/** Output as numbered lines, each marked when it reads as an error. A final newline adds no empty line. */
export function outputLines(text) {
  return String(text || '').replace(/\r?\n$/, '').split(/\r?\n/).map((line, i) => ({ n: i + 1, line, bad: ERROR_LINE.test(line) }))
}

/** The exit mark in the PROCESS card: the exit code beside a status square (killed says so), a radar while it runs. */
function ExitMark({ t, p }) {
  if (p.status === 'running') return jsx('span', { className: 'sw-radar', role: 'img', 'aria-label': t('sw.proc.status.running') })
  const known = p.exit_code !== null && p.exit_code !== undefined
  const code = known ? String(p.exit_code) : '?'
  return jsxs('span', {
    className: 'sw-exit', 'data-st': p.status, role: 'img',
    'aria-label': p.status === 'stopped' ? t('sw.proc.killed') : known ? t('sw.proc.exit', code) : t('sw.proc.noExit'),
    children: [jsx('b', { children: code }, 'b'), jsx('span', { children: t(p.status === 'stopped' ? 'sw.proc.killedTag' : 'sw.proc.exitTag') }, 's')]
  })
}

/** The selected command's output: read once per command (and per Try again), never while it runs. */
function useProcOutput(p, storedId) {
  // Only a finished command's receipt has output; a checkpoint-only row (the app closed under it)
  // has none, and asking for it was a guaranteed 404 shown as a read failure.
  const fetches = p.status !== 'running' && p.has_output !== false
  const [out, setOut] = useState({ id: null, loading: false, data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!fetches) return undefined
    let alive = true
    setOut({ id: p.id, loading: true, data: null, error: null })
    ctxRef.rest(`/process_output?session_id=${encodeURIComponent(storedId)}&process_id=${encodeURIComponent(p.id)}`).then(
      data => alive && setOut({ id: p.id, loading: false, data, error: null }),
      err => alive && setOut({ id: p.id, loading: false, data: null, error: String(err?.message || err) })
    )
    return () => { alive = false }
  }, [p.id, p.status, storedId, fetches, attempt])
  // A pick of another command shows its own reading state until its answer lands, never the last one's output.
  const got = !fetches ? { loading: false, data: null, error: null } : out.id === p.id ? out : { loading: true, data: null, error: null }
  return { fetches, got, retry: () => setAttempt(n => n + 1) }
}

function ProcRow({ t, p, now, selected, onPick }) {
  const time = p.status === 'running'
    ? fmtDuration(p.started_at ? now - p.started_at : null, t)
    : p.status === 'stopped' ? '—' : fmtDuration(p.duration_s, t)
  const exit = p.status === 'failed' && p.exit_code !== null && p.exit_code !== undefined ? t('sw.proc.exit', p.exit_code) : ''
  return jsxs('button', {
    type: 'button', className: 'sw-cmrow', 'data-st': p.status, 'aria-pressed': selected, onClick: onPick,
    'aria-label': `${commandLine(p.command)}: ${t(`sw.proc.status.${p.status}`)}`,
    children: [
      jsx('span', { className: 'sw-cmlt', children: fmtWhen(p.started_at, now, t) || '—' }, 'w'),
      jsx('span', { className: 'sw-cmls', 'aria-hidden': 'true', children: jsx('span', { children: t(`sw.proc.short.${p.status}`) }) }, 's'),
      jsx(Tip, { label: tipText(p.command), children: jsx('code', { className: 'sw-cmc', children: commandLine(p.command) }) }, 'c'),
      jsxs('span', { className: 'sw-cmx', children: [exit ? jsx('span', { className: 'sw-cmxe', children: `${exit} · ` }, 'e') : null, jsx('span', { className: 'sw-num', children: time }, 't')] }, 'x')
    ]
  })
}

// The Commands tab is a HUD like Replay: the selected command's CONSOLE on top (its output on the grid,
// a gauge and a FIRST ERROR callout tied to its line), the COMMANDS list and the PROCESS card below.
function ProcView({ t, p, rows, now, storedId, onToast, onPick }) {
  const { fetches, got, retry } = useProcOutput(p, storedId)
  const hero = useRef(null)
  const wires = useWires(hero, [p.id, got.data, got.loading, got.error], '.sw-out', 'data-o')
  // The receipt holds the whole command; the list row carries at most COMMAND_CHARS of it.
  const command = got.data?.command || p.command || ''
  const cut = !got.data?.command && p.command_truncated
  const running = p.status === 'running'
  const finished = p.status === 'completed' || p.status === 'failed'
  const ran = running ? fmtDuration(p.started_at ? now - p.started_at : null, t) : fmtDuration(p.duration_s, t)
  const lines = got.data?.output ? outputLines(got.data.output) : []
  const bad = lines.find(l => l.bad)
  const known = p.exit_code !== null && p.exit_code !== undefined
  const word = running ? t('sw.proc.short.running') : p.status === 'stopped' ? t('sw.proc.killed') : t('sw.proc.exit', known ? p.exit_code : '?')
  let body
  if (running) body = jsx('p', { className: 'sw-cmnote', children: t('sw.proc.whileRunning') }, 'b')
  else if (!fetches) body = jsx('div', { className: 'sw-crt', 'data-state': 'none', children: jsx('p', { className: 'sw-cmnote sw-quiet', children: t('sw.proc.noOutput') }) }, 'b')
  else if (got.loading) {
    body = jsxs('div', {
      className: 'sw-crt', 'data-state': 'reading', role: 'status',
      children: [jsx('div', { className: 'sw-crth', children: jsx('span', { children: t('sw.proc.reading') }) }, 'h'), jsx('div', { className: 'sw-scan', 'aria-hidden': 'true' }, 's')]
    }, 'b')
  } else if (got.error) {
    body = jsxs('div', {
      className: 'sw-cmerr', role: 'alert',
      children: [
        jsxs('div', {
          className: 'sw-crt', 'data-state': 'lost',
          children: [jsx('span', { className: 'sw-nosig', children: t('sw.proc.noSignal') }, 'g'), jsx('p', { children: t('sw.err.withDetail', t('sw.err.procOutput'), got.error) }, 'm')]
        }, 'c'),
        jsx('div', { className: 'sw-btns', children: jsx(IconButton, { label: t('sw.retry'), icon: ICON.refresh, onClick: retry, text: true }) }, 'r')
      ]
    }, 'b')
  } else if (!got.data?.output) body = jsx('div', { className: 'sw-crt', 'data-state': 'quiet', children: jsx('p', { className: 'sw-cmnote sw-quiet', children: t('sw.proc.printedNothing') }) }, 'b')
  else {
    body = jsxs('div', {
      className: 'sw-crt', 'data-state': 'output',
      children: [
        jsxs('div', {
          className: 'sw-crth',
          children: [
            jsx('span', { className: 'sw-outl', children: [t('sw.proc.output'), got.data.output_truncated ? ` · ${t('sw.proc.outputCut', got.data.output.length)}` : ''].join('') }, 'l'),
            jsx('span', { children: t('sw.proc.lines', lines.length) }, 'n')
          ]
        }, 'h'),
        // Line numbers are drawn by CSS, so a selection copies the output alone.
        jsx('pre', { className: 'sw-out', tabIndex: 0, children: lines.map(l => jsx('span', { className: `sw-ol${l.bad ? ' is-bad' : ''}`, 'data-n': l.n, 'data-o': l.n, children: l.line || ' ' }, l.n)) }, 'o')
      ]
    }, 'b')
  }
  const bars = on => Array.from({ length: 10 }, (_, k) => jsx('i', { className: k < on ? 'on' : undefined }, k))
  const gauge = p.status === 'failed' ? 'sw.hudCommands.failed' : finished ? 'sw.hudCommands.finished' : running ? 'sw.hudCommands.running' : 'sw.hudCommands.stopped'
  return jsxs('div', {
    className: 'sw-cmgrid',
    children: [
      jsx(CmdOrbit, { t, rows, picked: p, now, onPick }, 'orbit'),
      jsx(HudPanel, {
        title: t('sw.hudCommands.console'), name: commandLine(p.command), span: 6, className: 'sw-hpx sw-cmcon', chip: hudChip(p.status, word),
        children: [
          jsxs('div', {
            className: 'sw-hgrid', 'data-st': p.status, ref: hero,
            children: [
              jsx('svg', { className: 'sw-wires', 'aria-hidden': 'true', children: wires.map(([ax, ay, kx, bx, y], k) => jsxs('g', { children: [jsx('path', { d: `M${ax},${ay} H${kx} L${bx},${y}` }, 'p'), jsx('circle', { cx: bx, cy: y, r: 2.5 }, 'c')] }, k)) }, 'w'),
              body,
              jsxs('div', {
                className: 'sw-cos', 'aria-hidden': 'true',
                children: [
                  jsxs('div', {
                    className: 'sw-co sw-cmgauge', 'data-st': p.status,
                    children: [
                      jsx('span', { className: 'sw-col', children: hudCaps(t(gauge)) }, 'l'),
                      jsxs('span', { className: `sw-cop${running ? ' is-run' : ''}`, children: [jsx('span', { className: 'sw-copn', children: finished ? '100%' : running ? ran || '…' : '—' }, 'n'), jsx('span', { className: 'sw-copb', children: bars(finished ? 10 : running ? 3 : 0) }, 'b')] }, 'p')
                    ]
                  }, 'g'),
                  bad ? jsxs('div', {
                    className: 'sw-co sw-cmfirst', 'data-to': bad.n,
                    children: [jsx('span', { className: 'sw-col', children: hudCaps(t('sw.hudCommands.firstError')) }, 'l'), jsx('span', { className: 'sw-cov', 'data-st': 'failed', children: hudCaps(t('sw.hudCommands.line', bad.n)) }, 'v')]
                  }, 'e') : null
                ]
              }, 'co')
            ]
          }, 'hero')
        ]
      }, 'console'),
      jsx(HudPanel, {
        title: t('sw.hudCommands.list', rows.length), span: 4, className: 'sw-cmlp',
        children: [jsx('div', { className: 'sw-cml', children: rows.map(x => jsx(ProcRow, { t, p: x, now, selected: x.id === p.id, onPick: () => onPick(x.id) }, x.id)) }, 'l')]
      }, 'list'),
      jsx(HudPanel, {
        title: t('sw.hudCommands.process'), span: 2, className: 'sw-cmcard',
        children: [
          jsx(HudKV, {
            rows: [
              [t('sw.hudCommands.command'), jsx(OneLine, { text: command, className: 'sw-cmkv' })],
              [t('sw.proc.dirK'), p.cwd ? jsx(OneLine, { text: p.cwd, className: 'sw-cmkv' }) : '—'],
              [t(running ? 'sw.proc.runningK' : 'sw.proc.ranK'), ran || '—'],
              [t('sw.proc.exitTag'), jsx(ExitMark, { t, p })],
              [t('sw.hudCommands.lines'), lines.length ? String(lines.length) : '—']
            ]
          }, 'kv'),
          cut ? jsx('p', { className: 'sw-cmcut', children: t('sw.proc.commandCut', command.length) }, 'cut') : null,
          jsxs('div', {
            className: 'sw-btns sw-cmfoot',
            children: [
              got.data?.output ? jsx(IconButton, { label: t('sw.proc.copyOutput'), icon: ICON.copy, onClick: () => writeClip(got.data.output, t, onToast), text: true }, 'o') : null,
              jsx(IconButton, { label: t('sw.proc.copyCommand'), icon: ICON.copy, onClick: () => writeClip(command, t, onToast), text: true }, 'c')
            ]
          }, 'b')
        ]
      }, 'card')
    ]
  })
}

function Commands({ t, procs, now, storedId, onToast }) {
  const unreadable = procs.data?.unreadable || 0
  const rows = [...(procs.data?.processes || [])].reverse()
  // The picked command; with none picked (or it left the list) the newest one is shown.
  const [pick, setPick] = useState(null)
  const sel = rows.find(p => p.id === pick) || rows[0]
  return jsxs('div', {
    className: 'sw-cmds', role: 'tabpanel', id: 'sw-tab-commands', 'aria-labelledby': 'sw-tabb-commands',
    children: [
      jsx('p', { className: 'sw-why', children: t('sw.proc.why') }, 'why'),
      procs.loading
        ? jsxs('p', { className: 'sw-cmnote sw-cmwait', children: [jsx('span', { className: 'sw-spin', 'aria-hidden': 'true' }, 's'), t('sw.loading')] }, 'w')
        : sel
          ? jsx(ProcView, { t, p: sel, rows, now, storedId, onToast, onPick: setPick }, 'view')
          : procs.error ? null : jsx('div', {
            // no command: one panel with what will appear and when, no ORBIT and no list
            className: 'sw-cmgrid sw-none',
            children: jsx(HudPanel, { title: t('sw.tabs.commands'), span: 6, children: [jsx('p', { className: 'sw-hnote', children: t('sw.proc.none') }, 'none')] })
          }, 'none'),
      unreadable ? jsx('p', { className: 'sw-pu', children: t('sw.proc.unreadable', unreadable) }, 'u') : null
    ]
  })
}

// ── replay ──────────────────────────────────────────────────────────────────

const PEEK_LINES = 40
const PLAY_MS = 1500

/** When something happened, short enough for a list column: the clock today, 'Tue 22:35' within a week, else the date and clock. */
export function fmtWhen(at, now, t = enT) {
  if (!Number.isFinite(at)) return ''
  const d = new Date(at * 1000)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const n = new Date(now * 1000)
  const gap = Math.round((day(n) - day(d)) / 86400000)
  if (gap <= 0) return clock
  if (gap < 7) return `${d.toLocaleDateString('en', { weekday: 'short' })} ${clock}`
  return `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${clock}`
}

/** What an edit did, in words. */
export function stepSummary(s, t = enT) {
  if (s.kind === 'delete') return t('sw.replay.deleted')
  if (s.kind === 'whole') return t('sw.replay.whole', s.total ?? s.added)
  if (s.kind === 'move') return t('sw.replay.moved', s.to || '')
  if (!s.added && !s.removed) return t('sw.replay.noLines')
  return t('sw.replay.changed', s.added, s.removed)
}

function TurnRow({ t, turn, now, selected, onPick }) {
  const failed = turn.steps.filter(s => s.failed).length
  const ask = turn.id === 't-' ? t('sw.replay.beforeFirst') : turn.ask || t('sw.replay.noText')
  return jsx(Tip, {
    label: tipText(ask),
    children: jsxs('button', {
      type: 'button', className: 'sw-rturn', 'aria-pressed': selected, onClick: onPick,
      children: [
        jsx('span', { className: 'sw-rask sw-1l', children: ask }, 'a'),
        jsxs('span', {
          className: 'sw-rcount',
          children: [
            t('sw.replay.count', turn.steps.length + (turn.more_steps || 0), turn.files),
            failed ? jsx('span', { className: 'sw-rbad', children: ` · ${t('sw.replay.failedCount', failed)}` }, 'f') : null
          ]
        }, 'c'),
        jsx('span', { className: 'sw-rwhen', children: fmtWhen(turn.at ?? turn.steps[0]?.at, now, t) }, 'w')
      ]
    })
  })
}

/** While Play runs, an edit plays out in order: each removed line is struck through and dims, then
 *  each added line is typed in behind a cursor, one after another on the same beat (0.9 s a line, as
 *  in the draft the user picked; a long edit types faster so it stays near 9 s). One entry per diff
 *  row: null (not animated) or its delay and duration in ms; `end` is when the last line is done. */
export function typingPlan(rows) {
  const adds = rows.filter(([tag]) => tag === '+').length
  const rems = rows.filter(([tag]) => tag === '-').length
  const beat = Math.max(250, Math.min(900, Math.round(9000 / Math.max(1, adds))))
  const strike = Math.min(140, Math.round(1500 / Math.max(1, rems)))
  let at = 250
  const plan = rows.map(([tag]) => {
    if (tag === '-') { const p = { d: at, t: 260 }; at += strike; return p }
    if (tag !== '+') return null
    const p = { d: at, t: beat }
    at += beat
    return p
  })
  return { plan, end: at }
}

/** The parts of an edit: the row of its header (h; null for a whole-file write, which has no hunk
 *  header and is one part from line 1), its first changed row (k), the line it starts on and its +/−
 *  counts. The header row says what the part did, so the code below it keeps the panel's full width. */
export function diffParts(lines) {
  const parts = []
  lines.forEach(([tag, text], k) => {
    if (tag === '@') parts.push({ h: k, k: null, at: Number(text) || null, add: 0, rem: 0 })
    else if (tag === '+' || tag === '-') {
      if (!parts.length) parts.push({ h: null, k: null, at: 1, add: 0, rem: 0 })
      const p = parts.at(-1)
      if (p.k == null) p.k = k
      if (tag === '+') p.add++
      else p.rem++
    }
  })
  return parts.filter(p => p.k != null)
}

/** The gutter's line numbers: a removed row its old line, an added or kept row its new one. */
export function diffNumbers(lines) {
  let old = lines[0]?.[0] === '@' ? null : 1, now = old
  return lines.map(([tag, text]) => {
    if (tag === '@') { old = now = Number(text) || null; return null }
    if (tag === '-') return old == null ? null : old++
    const n = now
    if (now != null) now++
    if (tag !== '+' && old != null) old++
    return n
  })
}

/** How long Play stays on an edit: its typing plus a beat to read it, never less than PLAY_MS. */
export const playHold = rows => Math.min(13000, Math.max(PLAY_MS, typingPlan(rows).end + 800))

/** An added line typed in letter by letter (Play), from `d` ms on, over `ms`. Done in script, not with
 *  a CSS width: the code wraps, and a growing width would reflow a wrapped line instead of typing it. */
function TypedText({ text, d, ms }) {
  const chars = [...(text || ' ')]
  const [n, setN] = useState(0)
  useEffect(() => {
    let k = 0, stop = null
    const step = Math.max(8, ms / chars.length)
    const next = () => { k += 1; setN(k); if (k < chars.length) stop = ctxRef.setTimeout(next, step) }
    stop = ctxRef.setTimeout(next, d)
    return () => stop?.()
  }, [text, d, ms])
  return jsx('span', { className: 'sw-rtext', children: chars.slice(0, n).join('') })
}

const stillMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** What one part of an edit did, on its header row: "2 lines replaced −2 +3". */
function PartNote({ t, part, failed }) {
  return jsxs('span', {
    className: 'sw-rpart',
    children: [
      jsx('span', { children: t('sw.replay.part', part.add, part.rem) }, 'l'),
      jsxs('span', {
        className: 'sw-covs',
        children: [
          part.rem ? jsx('span', { className: 'sw-cov', 'data-st': 'failed', children: `−${part.rem}` }, 'r') : null,
          part.add ? jsx('span', { className: 'sw-cov', 'data-st': failed ? 'failed' : 'completed', children: `+${part.add}` }, 'a') : null
        ]
      }, 'v')
    ]
  })
}

function DiffLines({ t, step, got, typing }) {
  const [all, setAll] = useState(false)
  // while Play types: the added row being typed, which carries the cursor
  const [cur, setCur] = useState(null)
  const box = useRef(null)
  const lines = got.data?.lines || []
  const shown = all ? lines : lines.slice(0, PEEK_LINES)
  const { plan } = typingPlan(shown)
  const nums = diffNumbers(shown)
  const parts = diffParts(shown)
  const partAt = new Map(parts.map(p => [p.h, p]))
  const typeIn = typing && !stillMotion()
  // move the cursor along and keep the line being typed in view
  useEffect(() => {
    const el = box.current
    if (!typing || !el) return undefined
    const stops = plan.map((p, k) => p && ctxRef.setTimeout(() => {
      if (shown[k]?.[0] === '+') setCur(k)
      const row = el.querySelector(`[data-k="${k}"]`)
      if (row && row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight + 24
    }, p.d)).filter(Boolean)
    return () => { stops.forEach(stop => stop()); setCur(null) }
  }, [typing, got.data, all])
  const header = (key, from, part) => jsxs('div', {
    className: 'sw-rl', 'data-tag': '@',
    children: [jsx('span', { children: t('sw.replay.from', from) }, 'f'), part ? jsx(PartNote, { t, part, failed: step.failed }, 'p') : null]
  }, key)
  if (got.loading) return jsxs('p', { className: 'sw-cmnote sw-cmwait', children: [jsx('span', { className: 'sw-spin', 'aria-hidden': 'true' }, 's'), t('sw.replay.reading')] })
  if (got.error) return jsx('p', { className: 'sw-cmnote sw-rbad', children: t('sw.err.withDetail', t('sw.err.replayStep'), got.error) })
  if (!lines.length) return null
  const hidden = lines.length - shown.length
  return jsxs('div', {
    className: 'sw-rdiff', 'data-failed': step.failed ? 'true' : undefined,
    children: [
      jsx('div', {
        className: 'sw-rlines', ref: box, tabIndex: 0, role: 'group', 'aria-label': stepSummary(step, t), 'data-play': typing ? 'true' : undefined,
        children: [
          // a whole-file write has no hunk header: its part still gets one, from line 1
          partAt.has(null) ? header('top', 1, partAt.get(null)) : null,
          ...shown.map(([tag, text], i) => (tag === '@'
          ? header(i, text, partAt.get(i))
          : jsxs('div', {
            className: 'sw-rl', 'data-tag': tag, 'data-k': i, 'data-cur': cur === i ? 'true' : undefined,
            style: typing && plan[i] ? { '--d': `${plan[i].d}ms`, '--t': `${plan[i].t}ms` } : undefined,
            children: [
              jsx('span', { className: 'sw-rln', 'aria-hidden': 'true', children: nums[i] ?? '' }, 'n'),
              jsx('span', { className: 'sw-rsign', 'aria-label': tag === '+' ? t('sw.replay.addedSign') : tag === '-' ? t('sw.replay.removedSign') : undefined, children: tag === '+' ? '+' : tag === '-' ? '−' : ' ' }, 's'),
              typeIn && tag === '+' && plan[i]
                ? jsx(TypedText, { text, d: plan[i].d, ms: plan[i].t }, 'x')
                : jsx('span', { className: 'sw-rtext', children: text || ' ' }, 'x')
            ]
          }, i)))
        ]
      }, 'l'),
      hidden ? jsx('div', { className: 'sw-rmore', children: jsx(IconButton, { label: t('sw.replay.rest', hidden), icon: ICON.chev.bind(null, true), onClick: () => setAll(true), text: true }) }, 'm') : null,
      got.data?.cut ? jsx('p', { className: 'sw-cmnote', children: t('sw.replay.notLoaded', got.data.cut) }, 'c') : null
    ]
  }, step.id)
}

// The Replay tab is laid out as a HUD (the look the user picked from a mission-control reference): a
// six-column grid of hairline panels with caps titles. A title is drawn in caps; the letters stay as
// written (an O is an O): a swapped letter read worse and spelled one word two ways across the page.
const hudCaps = text => String(text).toUpperCase()

/** A HUD panel. `title` is our own label and reads in caps; `name` is text from the run (a command, a
 *  file) and keeps its case, so a path or a command reads as typed. */
function HudPanel({ title, name, chip, span, className = '', fold = false, children }) {
  const plain = name ? `${title} · ${name}` : title
  // fold: a details element, closed until its title row is clicked; the content stays in the DOM
  return jsxs(fold ? 'details' : 'section', {
    className: `sw-hp ${className}${fold ? ' sw-hfold' : ''}`.trim(), 'data-span': span,
    children: [
      jsxs(fold ? 'summary' : 'div', {
        className: 'sw-hph',
        children: [
          jsxs('h3', {
            className: 'sw-hpt',
            children: [
              jsxs('span', { className: 'sw-hptv', 'aria-hidden': 'true', children: [hudCaps(title), name ? ' · ' : null, name ? jsx('span', { className: 'sw-hpn', children: name }, 'n') : null] }, 'v'),
              jsx('span', { className: 'sw-sr', children: plain }, 's')
            ]
          }, 't'),
          chip || null
        ]
      }, 'h'),
      ...children
    ]
  })
}

const hudChip = (st, word) => jsx('span', { className: 'sw-hchip', 'data-st': st, children: word }, 'chip')

function HudTrack({ label, value, frac, top, st }) {
  return jsxs('div', {
    className: 'sw-tk', 'data-st': st,
    children: [
      jsxs('div', { className: 'sw-tkh', children: [jsx('span', { 'aria-hidden': 'true', children: hudCaps(label) }, 'l'), jsx('span', { className: 'sw-sr', children: label }, 's'), jsx('b', { children: value }, 'v')] }, 'h'),
      jsx('div', { className: 'sw-tkb', 'aria-hidden': 'true', children: jsx('i', { style: { width: `${Math.max(1.5, Math.min(100, frac * 100)).toFixed(1)}%` } }) }, 'b'),
      jsxs('div', { className: 'sw-tks', 'aria-hidden': 'true', children: [jsx('span', { children: '0' }, 'a'), jsx('span', { children: top }, 'b')] }, 's')
    ]
  })
}

/** A smooth area chart through the values (a cubic between each pair), for an svg 300 × 96. */
export function areaPath(vals, W = 300, H = 96) {
  const max = Math.max(...vals, 1)
  const xs = vals.map((_, k) => 6 + (W - 12) * (vals.length > 1 ? k / (vals.length - 1) : 0.5))
  const ys = vals.map(v => H - 8 - (H - 22) * (v / max))
  let d = `M${xs[0]},${ys[0]}`
  for (let k = 1; k < xs.length; k++) {
    const cx = (xs[k - 1] + xs[k]) / 2
    d += ` C${cx},${ys[k - 1]} ${cx},${ys[k]} ${xs[k]},${ys[k]}`
  }
  return { d, xs, ys }
}

function HudChart({ vals, at, failed }) {
  const W = 300, H = 96
  const { d, xs, ys } = areaPath(vals, W, H)
  return jsxs('svg', {
    className: 'sw-ch', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
    children: [
      jsx('defs', { children: jsxs('linearGradient', { id: 'sw-chfill', x1: 0, x2: 0, y1: 0, y2: 1, children: [jsx('stop', { offset: 0, className: 'sw-chs0' }, 'a'), jsx('stop', { offset: 1, className: 'sw-chs1' }, 'b')] }) }, 'd'),
      ...[0.25, 0.5, 0.75].map(f => jsx('line', { className: 'sw-chg', x1: 0, x2: W, y1: H * f, y2: H * f }, `h${f}`)),
      ...[0.2, 0.4, 0.6, 0.8].map(f => jsx('line', { className: 'sw-chg', y1: 0, y2: H, x1: W * f, x2: W * f }, `v${f}`)),
      jsx('path', { className: 'sw-cha', d: `${d} L${xs.at(-1)},${H} L${xs[0]},${H} Z` }, 'a'),
      jsx('path', { className: 'sw-chl', d }, 'l'),
      ...failed.map(k => jsx('rect', { className: 'sw-chx', x: xs[k] - 1, y: H - 5, width: 2, height: 5 }, `x${k}`)),
      jsx('line', { className: 'sw-chm', x1: xs[at], x2: xs[at], y1: 0, y2: H }, 'm'),
      jsx('circle', { className: 'sw-chp', cx: xs[at], cy: ys[at], r: 4 }, 'p'),
      jsx('circle', { className: 'sw-chd', cx: xs[at], cy: ys[at], r: 4 }, 'c')
    ]
  })
}

/** Leader lines from each `.sw-co[data-to]` callout in the hero to the row of `list` whose `attr`
 *  equals its data-to (only while that row is scrolled into view), measured from the laid-out page.
 *  Shared by the Replay diff (rows carry data-h) and any other HUD hero with the same shape. */
/** The page's scale: a rect's width on screen over its layout width (1 where layout is unknown). */
export const wireScale = (onScreen, layout) => (layout ? onScreen / layout || 1 : 1)

function useWires(heroRef, deps, list = '.sw-rlines', attr = 'data-h') {
  const [wires, setWires] = useState('')
  useEffect(() => {
    const hero = heroRef.current
    if (!hero || typeof hero.getBoundingClientRect !== 'function') return undefined
    const draw = () => {
      const box = hero.getBoundingClientRect()
      // the page is scaled (CSS zoom): rects come back in screen pixels, the svg draws in the page's own
      const k = wireScale(box.width, hero.offsetWidth)
      const rows = hero.querySelector(list)
      const view = rows ? rows.getBoundingClientRect() : box
      const out = []
      for (const co of hero.querySelectorAll('.sw-co[data-to]')) {
        const row = rows?.querySelector(`[${attr}="${co.dataset.to}"]`)
        const tag = co.querySelector('.sw-col')
        if (!row || !tag || !tag.offsetParent) continue
        const a = tag.getBoundingClientRect(), b = row.getBoundingClientRect()
        const by = b.top + b.height / 2
        if (by < view.top || by > view.bottom) continue
        const ax = Math.round((a.left - box.left) / k), ay = Math.round((a.top + a.height / 2 - box.top) / k)
        const bx = Math.round((view.right - box.left) / k - 10), y = Math.round((by - box.top) / k)
        out.push([ax, ay, ax - 18, bx, y])
      }
      const next = JSON.stringify(out)
      setWires(prev => (prev === next ? prev : next))
    }
    draw()
    const rows = hero.querySelector(list)
    rows?.addEventListener('scroll', draw)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null
    ro?.observe(hero)
    return () => { rows?.removeEventListener('scroll', draw); ro?.disconnect() }
  }, deps)
  return wires ? JSON.parse(wires) : []
}

/** The scroll lists and line boxes that must end on a whole row. Their CSS max-height is the cap. */
const WHOLE_ROWS = '.sw-hlog,.sw-cml,.sw-rtlist,.sw-rlines,.sw-out'

/** Lower `el`'s max-height to the bottom of the last row that fits under its CSS cap, so a list that
 * scrolls never ends on half a row or half a line at any width. A box whose rows all fit keeps its cap.
 * Rows are the element's children; a wrapped row taller than the cap is left to its cap. */
export function fitWholeRows(el) {
  if (!el || typeof getComputedStyle !== 'function') return
  el.style.maxHeight = ''
  const cs = getComputedStyle(el)
  const cap = parseFloat(cs.maxHeight)
  if (!(cap > 0) || el.scrollHeight <= el.clientHeight + 1) return
  // rows scroll under the padding too: the visible band is the padding box, from its top
  const px = k => parseFloat(cs[k]) || 0
  const borders = px('borderTopWidth') + px('borderBottomWidth'), pads = px('paddingTop') + px('paddingBottom')
  const border = cs.boxSizing === 'border-box'
  const room = border ? cap - borders : cap + pads
  // rects are on-screen px; the page is zoomed (.sw-page zoom), so turn them back into CSS px
  const box = el.getBoundingClientRect()
  const k = el.offsetHeight && box.height ? box.height / el.offsetHeight : 1
  const top = box.top + el.clientTop * k - el.scrollTop * k
  let fit = 0
  for (const row of el.children) {
    const r = row.getBoundingClientRect()
    if (!r.height) continue
    const bottom = (r.bottom - top) / k
    if (bottom > room + 0.5) break
    fit = bottom
  }
  if (fit > 0) el.style.maxHeight = `${Math.floor((border ? fit + borders : fit - pads) * 100) / 100}px`
}

/** Keep every WHOLE_ROWS box under `pageRef` fitted: on any change of the page's content or size. */
function useWholeRows(pageRef) {
  useEffect(() => {
    const page = pageRef.current
    if (!page || typeof MutationObserver !== 'function') return undefined
    let frame = 0
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => soon()) : null
    const fit = () => { frame = 0; page.querySelectorAll(WHOLE_ROWS).forEach(el => { ro?.observe(el); fitWholeRows(el) }) }
    const soon = () => { if (!frame) frame = requestAnimationFrame(fit) }
    fit()
    // rows change height on new content, on a state flip (typing done, a row picked, a fold opened)
    // and on a width or font change; this hook only ever writes `style`, which it does not watch
    const mo = new MutationObserver(soon)
    mo.observe(page, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'open', 'hidden', 'data-play', 'aria-pressed', 'aria-current', 'aria-expanded'] })
    ro?.observe(page)
    document.fonts?.ready?.then(soon)
    page.addEventListener('animationend', soon)
    return () => { mo.disconnect(); ro?.disconnect(); page.removeEventListener('animationend', soon); if (frame) cancelAnimationFrame(frame); frame = -1 }
  }, [])
}

/** True when a key/value row's value is a value (a number, ratio, cost, %, tokens, duration or clock
 * time), not words: such a value gets `.sw-num` (code font, tabular figures). */
const NUM_RE = /^(?:[~≈]?[+\-−]?[$€£]?\d[\d,.]*\s?(?:[kKMB]|%)?|\d+\s?\/\s?\d+|\d{1,2}:\d{2}(?::\d{2})?|(?:\d+(?:\.\d+)?\s?(?:ms|s|m|h|d)\s*){1,3})$/
export const isNum = v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUM_RE.test(v.trim()))

/** A HUD key : value card. rows: [[label, value node], …]; labels are drawn in caps. */
function HudKV({ rows, className = '' }) {
  return jsx('dl', { className: `sw-kv ${className}`.trim(), children: rows.flatMap(([k, v], n) => [jsx('dt', { children: hudCaps(k) }, `k${n}`), jsx('dd', { className: isNum(v) ? 'sw-num' : undefined, children: v }, `v${n}`)]) })
}

function stepWord(s, t) {
  if (s.failed) return t('sw.replay.word.failed')
  return t(`sw.replay.word.${s.kind === 'whole' || s.kind === 'delete' || s.kind === 'move' ? s.kind : 'edit'}`)
}

/** The Replay tab's WORMHOLE, drawn live in the FLEET station's style (thin glowing lines in depth buckets,
 * stars, construction intro, chamfered frame, leader lines): two warped grid sheets joined by a narrow
 * throat, the grid's circles flowing into it. The edits shown are rings on the throat, the oldest at the
 * bottom, the newest at the top; a ring's colour says what the edit did (edit / write / delete / failed),
 * its weight how many lines it changed, a failed one is dashed and flickers. A scan plane (rings, radial
 * lines, a turning radar sweep) rides the throat to the current edit and rests there; on arrival the ring
 * sends a ripple across its sheet. Each callout's leader runs to its ring's edge on the callout's side.
 * State is read from the panel's own DOM (data-steps / data-kinds / data-sizes, .sw-orl[data-k], .is-sel),
 * colours from the page's tokens. Reduced motion draws one still frame, refreshed once a second.
 * window.__swStationClock, when set, drives the clock (frame-exact recordings). */
export function startReplayWormScene(canvas) {
  const root = canvas?.closest('.sw-orbit')
  const ctx = canvas?.getContext?.('2d')
  const swatch = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true })
  if (!root || !ctx || !swatch) return () => {}
  root.classList.add('has-scene')
  const still = root.dataset.calm === 'true' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'
  root.appendChild(probe)
  // a token resolved to sRGB 0..1 by painting it: works for any colour syntax the theme uses
  const tok = v => {
    probe.style.color = `var(${v})`
    swatch.clearRect(0, 0, 1, 1); swatch.fillStyle = window.getComputedStyle(probe).color; swatch.fillRect(0, 0, 1, 1)
    const d = swatch.getImageData(0, 0, 1, 1).data
    return [d[0] / 255, d[1] / 255, d[2] / 255]
  }
  let P
  const readPal = () => { P = { line: tok('--a'), hot: tok('--run'), ok: tok('--ok'), bad: tok('--bad'), idle: tok('--idle'), ink: tok('--ink') } }
  const paint = (c, a = 1) => `color(srgb ${c[0]} ${c[1]} ${c[2]} / ${Math.max(0, Math.min(1, a))})`
  const KC = { edit: 'line', write: 'ok', delete: 'idle', failed: 'bad' }
  const clamp = x => Math.max(0, Math.min(1, x))
  const ease = x => x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2

  // ── camera: low, looking across the sheets ──
  const TILT = 0.3, ROLL = -0.06
  let W = 0, H = 0, dpr = 1, U = 1, CX = 0, CY = 0, yaw = 0
  const cam = ([x, y, z]) => {
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw)
    const x1 = x * cy0 + z * sy0, z1 = -x * sy0 + z * cy0
    const ct = Math.cos(TILT), st = Math.sin(TILT)
    const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct
    const cr = Math.cos(ROLL), sr = Math.sin(ROLL)
    return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2]
  }
  const proj = p => { const c = cam(p), k = U * 800 / (800 - c[2]); return [CX + c[0] * k, CY - c[1] * k, c[2]] }
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight, d = Math.min(2, window.devicePixelRatio || 1)
    if (w === W && h === H && d === dpr) return false
    W = w; H = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d)
    U = Math.min(W / 666, H / 360) * 0.92; CX = W * 0.5; CY = H * 0.55
    return true
  }

  // ── the surface: a throat of radius R0 flaring into two sheets that level off at ±HS ──
  const R0 = 17, HS = 92, RMAX = 340
  const yOf = (r, s) => s * HS * Math.tanh(2 * Math.sqrt(R0 * Math.max(0, r - R0)) / HS)
  const rOf = y => { const q = Math.atanh(Math.min(0.999, Math.abs(y) / HS)) * HS / 2; return R0 + q * q / R0 }
  const S = (r, a, s) => [r * Math.cos(a), yOf(r, s), r * Math.sin(a)]
  const SY = (y, a) => { const r = rOf(y); return [r * Math.cos(a), y, r * Math.sin(a)] }
  const ringY = (k, n) => n < 2 ? 0 : -60 + 120 * k / (n - 1)

  const build = (t, spin) => {
    const L = [], seg = (a, b, o, m, g) => L.push([a, b, o, m, g])
    const fadeR = r => clamp((RMAX - r) / 110)
    for (const s of [1, -1]) for (let j = 0; j < 56; j++) {   // meridians, sampled closer near the throat
      const a = spin + j / 56 * 6.2832
      for (let i = 0; i < 34; i++) { const r0 = R0 + (RMAX - R0) * (i / 34) ** 2, r1 = R0 + (RMAX - R0) * ((i + 1) / 34) ** 2; seg(S(r0, a, s), S(r1, a, s), i / 34, (j % 4 ? 0.45 : 0.8) * fadeR(r1), 'grid') }
    }
    const ph = 1 - ((t * 0.12) % 1)   // circles flowing into the throat
    for (const s of [1, -1]) for (let k = 0; k < 22; k++) {
      const w = (k + ph) / 22, r = R0 + (RMAX - R0) * w ** 2.1, m = fadeR(r) * (k === 0 ? ph : 1) * (0.5 + 0.5 * (1 - w))
      for (let j = 0; j < 96; j++) seg(S(r, j / 96 * 6.2832, s), S(r, (j + 1) / 96 * 6.2832, s), w, m, 'grid')
    }
    for (let y = -HS * 0.86; y <= HS * 0.86; y += 6) for (let j = 0; j < 48; j++) seg(SY(y, j / 48 * 6.2832), SY(y, (j + 1) / 48 * 6.2832), 0.5 + y / HS / 2, 0.35, 'throat')
    return L
  }
  const INTRO = { grid: [0, 1.6], throat: [0.6, 1.0], ring: [1.4, 0.8], scan: [2.1, 0.5] }

  // ── state from the DOM ──
  let S0 = null, frame = 0
  const readState = () => {
    const calls = [...root.querySelectorAll('.sw-orl')].map(el => ({ el, k: Number(el.dataset.k), side: el.dataset.side, sel: el.classList.contains('is-sel') }))
    const sizes = (root.dataset.sizes || '').split(',').map(Number)
    S0 = { calls, n: Number(root.dataset.steps) || calls.length, kinds: (root.dataset.kinds || '').split(','), sizes, max: Math.max(1, ...sizes.filter(x => x > 0)), cur: Math.max(0, Number(root.dataset.cur) || 0) }
  }
  const labelY = c => parseFloat(c.el.style.top) / 100 * H
  const labelX = c => { const l = parseFloat(c.el.style.left) / 100 * W, w = parseFloat(c.el.style.width) / 100 * W; return [l, l + w] }

  const rnd = (() => { let x = 7654321; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
  const STARS = Array.from({ length: 220 }, () => ({ x: rnd(), y: rnd(), z: 0.2 + rnd() * 0.8, p: rnd() * 6.28, s: rnd() }))
  const glow = (x, y, r, c, a) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, paint(c, a)); g.addColorStop(1, paint(c, 0)); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2) }
  const poly = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath() }
  const hring = (r, y, a0, a1, n = 48) => { ctx.beginPath(); for (let j = 0; j <= n; j++) { const a = a0 + (a1 - a0) * j / n, q = proj([r * Math.cos(a), y, r * Math.sin(a)]); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]) } }
  const line3 = (p1, p2, c, al, w = 1) => { const q1 = proj(p1), q2 = proj(p2); ctx.beginPath(); ctx.moveTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]); ctx.lineWidth = w; ctx.strokeStyle = paint(c, al); ctx.stroke() }
  const t0 = performance.now() / 1000
  let from = null, to = null, moveAt = -9

  const render = () => {
    if (resize() || frame % 10 === 0) { readPal(); readState() }
    frame++
    if (!W || !H) return
    const t = still ? 30 : (window.__swStationClock ?? performance.now() / 1000 - t0)
    if (to !== S0.cur) { from = to ?? S0.cur; to = S0.cur; moveAt = from === to || still ? -9 : t }
    const fly = clamp((t - moveAt) / 1.6)
    yaw = 0.04 * Math.sin(t * 0.1)
    const reveal = g => { const [s, d] = INTRO[g]; return clamp((t - s) / d) }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    for (const s of STARS) { const a = (0.12 + 0.4 * s.z) * (0.55 + 0.45 * Math.sin(t * (0.5 + s.s) + s.p)); ctx.fillStyle = paint(s.s > 0.85 ? P.ink : P.line, a); ctx.fillRect(s.x * W, s.y * H, s.z > 0.9 ? 1.6 : 1, s.z > 0.9 ? 1.6 : 1) }
    const th = proj([0, 0, 0])
    glow(th[0], th[1], 150 * U, P.line, 0.12)
    glow(th[0], th[1], 46 * U, P.ink, 0.1 * reveal('throat'))

    // the grid in depth buckets (glow + core)
    const B = 8, bk = Array.from({ length: B }, () => [])
    for (const [p1, p2, o, m, g] of build(t, t * 0.03)) {
      const [s, d] = INTRO[g], prog = (t - s) / d
      if (prog <= o || m <= 0.01) continue
      const a1 = proj(p1), a2 = proj(p2)
      const f = clamp(((a1[2] + a2[2]) / 2 + 300) / 500)
      const a = (0.12 + 0.85 * f) * m * clamp((prog - o) * 5)
      bk[Math.min(B - 1, (a * B) | 0)].push(a1, a2)
    }
    bk.forEach((list, b) => {
      if (!list.length) return
      ctx.beginPath(); for (let i = 0; i < list.length; i += 2) { ctx.moveTo(list[i][0], list[i][1]); ctx.lineTo(list[i + 1][0], list[i + 1][1]) }
      const a = (b + 0.5) / B
      ctx.lineWidth = 3; ctx.strokeStyle = paint(P.line, a * 0.12); ctx.stroke()
      ctx.lineWidth = 0.75; ctx.strokeStyle = paint(P.line, a * 0.95); ctx.stroke()
    })

    // the edits: rings on the throat, two hairlines beside each; the current one wears a turning dashed
    // halo, and on arrival sends a ripple out across its sheet
    const rr = reveal('ring'), ringsUp = []
    for (let k = 0; k < S0.n; k++) {
      const y = ringY(k, S0.n), kind = S0.kinds[k] || 'edit', col = P[KC[kind] || 'line'], cur = k === S0.cur
      const sz = Math.sqrt((S0.sizes[k] || 0) / S0.max), pop = clamp(rr * S0.n - k * 0.6)
      ringsUp.push(pop > 0)
      if (pop <= 0) continue
      const flick = kind === 'failed' ? (Math.sin(t * 17 + k * 3) > 0.2 || Math.sin(t * 5.3 + k) > 0.6 ? 1 : 0.35) : 1
      const ring = (yy, w, al, dash) => { ctx.beginPath(); for (let j = 0; j <= 72; j++) { const q = proj(SY(yy, j / 72 * 6.2832)); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]) } ctx.setLineDash(dash || []); ctx.lineWidth = w; ctx.strokeStyle = paint(col, al); ctx.stroke(); ctx.setLineDash([]) }
      const al = (cur ? 1 : 0.7) * pop * flick
      ring(y, 4, al * 0.18); ring(y, 1.3 + sz, al, kind === 'failed' ? [5, 4] : null)
      ring(y - 2.5, 0.6, al * 0.5); ring(y + 2.5, 0.6, al * 0.5)
      if (cur) {
        hring(rOf(y) + 9, y, t * 0.7, t * 0.7 + 6.2832, 72)
        ctx.setLineDash([9, 6]); ctx.lineWidth = 1.1; ctx.strokeStyle = paint(P.hot, 0.85 * pop); ctx.stroke(); ctx.setLineDash([])
        if (fly >= 1 && moveAt > 0 && t - moveAt < 4.4) {
          const f = clamp((t - moveAt - 1.6) / 2.4), s = y >= 0 ? 1 : -1, r0 = rOf(y), rw = r0 + (RMAX - r0) * f ** 1.4
          ctx.beginPath(); for (let j = 0; j <= 96; j++) { const q = proj(S(rw, j / 96 * 6.2832, s)); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]) }
          ctx.lineWidth = 1.4; ctx.strokeStyle = paint(col, 0.75 * (1 - f)); ctx.stroke()
        }
      }
    }

    // the scan plane: a flat disk of rings and radial lines rides the throat to the current edit and rests
    // there, a radar sweep turning on it, a tick ruler on its rim
    const ex = reveal('scan')
    if (ex > 0 && S0.n) {
      const y0 = ringY(from ?? S0.cur, S0.n), y1 = ringY(S0.cur, S0.n), ccol = P[KC[S0.kinds[S0.cur] || 'edit'] || 'line']
      const ys = (fly < 1 ? y0 + (y1 - y0) * ease(fly) : y1) + (fly < 1 ? 0 : 1.5 * Math.sin(t * 1.4)), rin = rOf(ys) + 3, rout = rin + 86
      for (let r = rin; r <= rout; r += 9) { hring(r, ys, 0, 6.2832, 96); ctx.lineWidth = r === rin ? 1.4 : 0.7; ctx.strokeStyle = paint(r === rin ? ccol : P.line, (r === rin ? 0.95 : 0.45 * (1 - (r - rin) / 100)) * ex); ctx.stroke() }
      for (let d = 0; d < 36; d++) { const a = d / 36 * 6.2832; line3([rin * Math.cos(a), ys, rin * Math.sin(a)], [rout * Math.cos(a), ys, rout * Math.sin(a)], P.line, 0.22 * ex, 0.6) }
      for (let k = 0; k < 24; k++) { const a = t * 1.3 - k * 0.025; line3([rin * Math.cos(a), ys, rin * Math.sin(a)], [rout * Math.cos(a), ys, rout * Math.sin(a)], P.hot, (1 - k / 24) * 0.85 * ex, 1.1) }
      for (let d = 0; d < 120; d++) { const a = d / 120 * 6.2832, l = d % 10 ? 3 : 8; line3([rout * Math.cos(a), ys, rout * Math.sin(a)], [(rout + l) * Math.cos(a), ys, (rout + l) * Math.sin(a)], P.line, 0.6 * ex, 0.8) }
    }

    // frame: the station's chamfered border, accent bars
    ctx.globalCompositeOperation = 'source-over'
    const i0 = 3, ch = 9
    poly([[i0 + ch, i0], [W - i0 - ch, i0], [W - i0, i0 + ch], [W - i0, H - i0 - ch], [W - i0 - ch, H - i0], [i0 + ch, H - i0], [i0, H - i0 - ch], [i0, i0 + ch]])
    ctx.lineWidth = 1; ctx.strokeStyle = paint(P.line, 0.26); ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = paint(P.hot, 0.85)
    const bar = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke() }
    bar(i0, H * 0.4, i0, H * 0.4 + 26); bar(W - i0, H * 0.6 - 26, W - i0, H * 0.6); bar(W * 0.5 - 30, H - i0, W * 0.5 + 30, H - i0)

    // leaders from each callout to its ring's edge on the callout's side
    if (W >= 520) for (const c of S0.calls) {
      if (!ringsUp[c.k]) continue
      const g = proj(SY(ringY(c.k, S0.n), c.side === 'l' ? 3.1416 : 0)), y = labelY(c), [x0, x1] = labelX(c), left = c.side === 'l'
      ctx.globalAlpha = rr
      ctx.strokeStyle = c.sel ? paint(P.hot, 0.95) : paint(P.line, 0.5); ctx.lineWidth = c.sel ? 1.2 : 0.8
      ctx.beginPath(); ctx.moveTo(left ? x0 : x1, y); ctx.lineTo(left ? x1 : x0, y); ctx.lineTo(g[0], g[1]); ctx.stroke()
      ctx.fillStyle = paint(P.ink, 0.95); ctx.fillRect(g[0] - 1.5, g[1] - 1.5, 3, 3)
      ctx.globalAlpha = 1
    }
  }
  let raf = 0, tick = 0
  const loop = () => { if (!canvas.isConnected) { stop(); return } render(); if (!still) raf = window.requestAnimationFrame(loop) }
  const stop = () => { window.cancelAnimationFrame(raf); clearInterval(tick); probe.remove(); root.classList.remove('has-scene') }
  canvas.swOrbitFrame = render
  raf = window.requestAnimationFrame(loop)
  if (still) tick = setInterval(() => { if (canvas.isConnected) render(); else stop() }, 1000)
  return stop
}

function ReplayWormScene() {
  const ref = useRef(null)
  useEffect(() => startReplayWormScene(ref.current), [])
  return jsx('canvas', { className: 'sw-orcv', ref, 'aria-hidden': 'true' })
}

const WORM_RINGS = 8
const wormKind = s => (s.failed ? 'failed' : s.kind === 'whole' ? 'write' : s.kind === 'delete' ? 'delete' : 'edit')

/** The Replay tab's WORMHOLE panel: FLEET's markup (callouts, a box, corner readouts) over the live
 * wormhole. Up to eight edits round the current one are rings (oldest at the bottom); each gets a callout
 * on alternating sides near its ring's height, and a callout opens its edit like a log row. The readouts
 * count the whole request. Without a 2D canvas the panel stays hidden (the log says it all). */
function ReplayWorm({ t, steps, i, go }) {
  const n = steps.length, m = Math.min(WORM_RINGS, n)
  const w0 = Math.max(0, Math.min(n - m, i - Math.floor(m / 2)))
  const shown = steps.slice(w0, w0 + m)
  const kinds = shown.map(wormKind), sizes = shown.map(s => (s.failed ? 0 : (s.added || 0) + (s.removed || 0)))
  // labels: newest at the top, sides alternating, each near its ring's projected height, kept apart
  const slot = {}
  for (const side of ['l', 'r']) {
    let last = 62
    for (let k = m - 1; k >= 0; k--) {
      if ((m - 1 - k) % 2 !== (side === 'l' ? 0 : 1)) continue
      const ry = ORBIT_H * 0.55 - 0.88 * (m < 2 ? 0 : -60 + (120 * k) / (m - 1)) - 24
      last = Math.max(last + 56, Math.min(318, Math.max(118, ry)))
      slot[k] = { side, y: Math.min(318, last) }
    }
  }
  const callouts = shown.map((s, k) => jsx(Tip, {
    label: tipText(s.path),
    children: jsxs('button', {
      type: 'button', className: `sw-orl${w0 + k === i ? ' is-sel' : ''}`, 'data-k': k, 'data-side': slot[k].side, 'data-st': s.failed ? 'failed' : 'completed',
      style: { top: pct(slot[k].y, ORBIT_H), left: pct(slot[k].side === 'l' ? 14 : ORBIT_W - 164, ORBIT_W), width: pct(150, ORBIT_W) },
      'aria-pressed': w0 + k === i, 'aria-label': t('sw.replay.stepLabel', w0 + k + 1, splitPath(s.path).name, s.failed), onClick: () => go(w0 + k),
      children: [
        jsx('span', { className: 'sw-orn', children: splitPath(s.path).name }, 'n'),
        jsx('span', { className: 'sw-orv', children: hudCaps(stepWord(s, t)) + (s.failed ? '' : ` · +${s.added || 0} −${s.removed || 0}`) }, 'v')
      ]
    })
  }, s.id))
  const done = steps.filter(s => !s.failed)
  const count = kind => String(steps.filter(s => wormKind(s) === kind).length).padStart(2, '0')
  const bars = Array.from({ length: 14 }, (_, k) => jsx('i', { className: k < Math.round((14 * (i + 1)) / n) ? 'on' : undefined, style: { '--k': k } }, k))
  const tele = (side, list) => jsx('div', {
    className: 'sw-ortele', 'data-side': side, 'aria-hidden': 'true',
    children: list.map(([k, v], j) => jsxs('div', { className: 'sw-otl', style: { '--i': j * 2 + (side === 'r' ? 1 : 0) }, children: [jsx('span', { children: hudCaps(k) }, 'k'), jsx('b', { className: isNum(v) ? 'sw-num' : undefined, children: v }, `v-${v}`)] }, k))
  }, `tele-${side}`)
  return jsx(HudPanel, {
    title: t('sw.replay.worm'), span: 6, className: 'sw-rworm',
    children: [jsxs('div', {
      className: 'sw-hgrid sw-orbit', role: 'group', 'aria-label': t('sw.replay.wormLabel'),
      'data-steps': m, 'data-kinds': kinds.join(), 'data-sizes': sizes.join(), 'data-cur': i - w0,
      children: [
        jsx(ReplayWormScene, {}, 'scene'),
        jsxs('div', {
          className: 'sw-ormain', 'data-st': 'running', 'aria-hidden': 'true',
          style: { top: pct(40, ORBIT_H), left: pct(226, ORBIT_W), width: pct(214, ORBIT_W) },
          children: [
            jsx('span', { className: 'sw-orn', children: `★ ${hudCaps(t('sw.replay.wormMain', i + 1, n))}` }, 'n'),
            jsxs('span', { className: 'sw-orp', children: [jsx('b', { children: `${i + 1}/${n}` }, 'n'), jsx('span', { className: 'sw-orbars', children: bars }, 'b')] }, 'p')
          ]
        }, 'main'),
        ...callouts,
        tele('l', [[t('sw.replay.teleEdits'), count('edit')], [t('sw.replay.teleWrites'), count('write')], [t('sw.replay.teleFailed'), count('failed')]]),
        tele('r', [[t('sw.replay.teleAdded'), `+${done.reduce((x, s) => x + (s.added || 0), 0)}`], [t('sw.replay.teleRemoved'), `−${done.reduce((x, s) => x + (s.removed || 0), 0)}`], [t('sw.replay.teleFiles'), String(new Set(steps.map(s => s.path)).size).padStart(2, '0')]])
      ]
    }, 'worm')]
  }, 'worm')
}

function Player({ t, turn, cwd, now, names, storedId, index, setIndex, playing, setPlaying, setHold, onToast }) {
  const steps = turn.steps
  const i = Math.min(index, steps.length - 1)
  const step = steps[i]
  const got = useReplayStep(storedId, step?.id)
  const marks = useRef(null)
  const log = useRef(null)
  useEffect(() => { setHold(got.data && !step?.failed ? playHold((got.data.lines || []).slice(0, PEEK_LINES)) : PLAY_MS) }, [step?.id, got.data])
  useEffect(() => {
    for (const box of [marks.current, log.current]) {
      const el = box?.querySelector('[aria-current=step]')
      if (el && box.scrollHeight > box.clientHeight) box.scrollTop = Math.max(0, el.offsetTop - box.offsetTop - box.clientHeight / 2)
    }
  }, [i, turn.id])
  if (!step) return null
  const { dir, name } = splitPath(step.path)
  const who = step.who ? t('sw.replay.by', names.get(step.who) || step.who) : t('sw.replay.byMain')
  const st = step.failed ? 'failed' : 'completed'
  const sizes = steps.map(s => (s.failed ? 0 : (s.added || 0) + (s.removed || 0)))
  const sums = sizes.map((_, k) => sizes.slice(0, k + 1).reduce((x, y) => x + y, 0))
  const failed = steps.map((s, k) => (s.failed ? k : -1)).filter(k => k >= 0)
  const all = sums.at(-1) || 0
  const pct = Math.round(100 * (i + 1) / steps.length)
  const maxA = Math.max(1, ...steps.map(s => s.added || 0))
  const maxR = Math.max(1, ...steps.map(s => s.removed || 0))
  const maxS = Math.max(1, ...sizes)
  const go = k => { setPlaying(false); setIndex(k) }
  return jsxs('div', {
    className: 'sw-rplay',
    children: [
      jsx(ReplayWorm, { t, steps, i, go }, 'worm'),
      jsx(HudPanel, {
        title: t('sw.replay.diff'), name, span: 6, className: 'sw-hpx', chip: hudChip(st, step.failed ? t('sw.replay.notApplied') : t('sw.replay.applied')),
        children: [
          // the code takes the panel's full width and wraps: what each part did is on its header row
          jsx('div', { className: 'sw-hgrid sw-rhero', children: jsx(DiffLines, { t, step, got, typing: playing && !step.failed }, step.id) }, 'hero'),
          step.failed ? jsxs('p', { className: 'sw-rfail', children: [jsx(OneLine, { text: t('sw.replay.failed', step.error) }, 'e'), jsx('span', { children: t('sw.replay.failedNote') }, 'n')] }, 'x') : null
        ]
      }, 'diff'),
      jsx(HudPanel, {
        title: playing ? t('sw.replay.replaying') : t('sw.replay.playback'), span: 6, className: 'sw-rpb',
        children: [
          jsxs('div', { className: 'sw-hrow', children: [jsx('b', { className: 'sw-rof', 'aria-live': 'polite', children: t('sw.replay.of', i + 1, steps.length) }, 'of'), jsx('b', { className: 'sw-num', 'aria-hidden': 'true', children: `${pct}%` }, 'p')] }, 'r'),
          jsx('div', {
            className: 'sw-rmarks', ref: marks, role: 'list',
            children: steps.map((s, k) => jsx('span', {
              role: 'listitem',
              children: jsx(Tip, {
                label: t('sw.replay.markTip', tipText(s.path), s.failed),
                children: jsx('button', {
                  type: 'button', className: 'sw-rmark', 'data-at': k < i ? 'past' : k === i ? 'now' : 'next', 'data-failed': s.failed ? 'true' : undefined,
                  'aria-current': k === i ? 'step' : undefined,
                  'aria-label': t('sw.replay.stepLabel', k + 1, splitPath(s.path).name, s.failed), onClick: () => go(k)
                })
              })
            }, s.id))
          }, 'marks'),
          jsx('div', {
            className: 'sw-rbar',
            children: jsxs('div', {
              className: 'sw-btns',
              children: [
                jsx(IconButton, { label: t('sw.replay.prev'), icon: ICON.chev.bind(null, false), onClick: () => go(i - 1), disabled: i === 0, text: true }, 'p'),
                jsx(Tip, { label: t('sw.replay.playTip'), children: jsx('span', { children: jsx(IconButton, { label: t(playing ? 'sw.replay.pause' : 'sw.replay.play'), icon: ICON.run, onClick: () => { if (!playing && i >= steps.length - 1) setIndex(0); setPlaying(!playing) }, disabled: steps.length < 2, text: true, primary: true }) }) }, 'go'),
                jsx(IconButton, { label: t('sw.replay.next'), icon: ICON.chev.bind(null, false), onClick: () => go(i + 1), disabled: i >= steps.length - 1, text: true }, 'n')
              ]
            })
          }, 'bar')
        ]
      }, 'play'),
      jsx(HudPanel, {
        title: t('sw.replay.linesChanged'), span: 2,
        children: [
          jsx(HudTrack, { label: t('sw.replay.addedSign'), value: `+${step.added || 0}`, frac: (step.added || 0) / maxA, top: maxA, st: 'completed' }, 'a'),
          jsx(HudTrack, { label: t('sw.replay.removedSign'), value: `−${step.removed || 0}`, frac: (step.removed || 0) / maxR, top: maxR, st: 'failed' }, 'r'),
          jsx(HudTrack, { label: t('sw.replay.thisEdit'), value: t('sw.replay.lines', sizes[i]), frac: sizes[i] / maxS, top: t('sw.replay.max', maxS) }, 's')
        ]
      }, 'lines'),
      jsx(HudPanel, {
        title: t('sw.replay.soFar'), span: 2,
        children: [
          jsxs('div', { className: 'sw-hbig', children: [jsx('span', { className: 'sw-roll', children: sums[i] }, `n${sums[i]}`), jsx('small', { children: `/ ${all}` }, 's')] }, 'b'),
          jsx(HudChart, { vals: sums, at: i, failed }, 'c'),
          jsxs('div', { className: 'sw-chax', 'aria-hidden': 'true', children: [jsx('span', { children: '#1' }, 'a'), jsx('span', { children: `#${steps.length}` }, 'b')] }, 'x')
        ]
      }, 'sofar'),
      jsx(HudPanel, {
        title: t('sw.replay.file'), span: 2, className: 'sw-rstep',
        children: [
          // the file name and APPLIED are the DIFF title's; this panel adds where, what and why
          jsx(HudKV, {
            rows: [
              [t('sw.replay.folder'), dir ? jsx(OneLine, { text: dirLabel(dir, cwd, t), className: 'sw-rdir' }) : '—'],
              [t('sw.replay.change'), jsx('p', { className: 'sw-rwhat sw-1l', children: [stepSummary(step, t), who, t('sw.replay.at', fmtWhen(step.at, now, t))].join(' · ') })],
              [t('sw.replay.request'), jsx(OneLine, { text: turn.id === 't-' ? t('sw.replay.beforeFirst') : turn.ask || t('sw.replay.noText') })]
            ]
          }, 'kv')
        ]
      }, `step-${step.id}`),
      jsx(HudPanel, {
        title: t('sw.replay.log', steps.length), span: 6,
        children: [jsx('div', {
          className: 'sw-hlog', ref: log,
          children: steps.map((s, k) => jsxs('button', {
            type: 'button', 'data-st': s.failed ? 'failed' : 'completed', 'aria-current': k === i ? 'step' : undefined,
            'aria-label': t('sw.replay.stepLabel', k + 1, splitPath(s.path).name, s.failed), onClick: () => go(k),
            children: [
              jsx('span', { className: 'sw-hlt', children: fmtWhen(s.at, now, t) }, 't'),
              jsx('span', { className: 'sw-hle', children: stepWord(s, t) }, 'e'),
              jsx('span', { className: 'sw-hlm', children: splitPath(s.path).name }, 'm'),
              jsx('span', { className: 'sw-hln', children: `+${s.added || 0} −${s.removed || 0}` }, 'n')
            ]
          }, s.id))
        }, 'l')]
      }, 'log')
    ]
  })
}

function Replay({ t, replay, now, names, storedId, onToast }) {
  const turns = replay.data?.turns || []
  const [turnId, setTurnId] = useState(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [hold, setHold] = useState(PLAY_MS)
  const turn = turns.find(x => x.id === turnId) || turns[0]
  const count = turn ? turn.steps.length : 0
  useEffect(() => {
    if (!playing) return undefined
    if (index >= count - 1) { setPlaying(false); return undefined }
    return ctxRef.setTimeout(() => setIndex(index + 1), hold)
  }, [playing, index, count, hold])
  const pick = id => { setTurnId(id); setIndex(0); setPlaying(false) }
  return jsxs('div', {
    className: 'sw-replay', role: 'tabpanel', id: 'sw-tab-replay', 'aria-labelledby': 'sw-tabb-replay',
    children: [
      jsx('p', { className: 'sw-why', children: t('sw.replay.why') }, 'why'),
      replay.loading
        ? jsxs('p', { className: 'sw-cmnote sw-cmwait', children: [jsx('span', { className: 'sw-spin', 'aria-hidden': 'true' }, 's'), t('sw.loading')] }, 'w')
        : !turns.length
          ? (replay.error ? null : jsx('div', {
            // no edit: one panel with what will appear and when, no WORMHOLE
            className: 'sw-rgrid sw-none',
            children: jsx(HudPanel, { title: t('sw.tabs.replay'), span: 6, children: [jsx('p', { className: 'sw-hnote', children: t('sw.replay.none') }, 'none')] })
          }, 'none'))
          : jsxs('div', {
            className: 'sw-rgrid',
            children: [
              jsx(HudPanel, {
                title: t('sw.replay.requests'), span: 6, className: 'sw-rturns',
                children: [
                  jsx('div', { className: 'sw-rtlist', children: turns.map(x => jsx(TurnRow, { t, turn: x, now, selected: x.id === turn.id, onPick: () => pick(x.id) }, x.id)) }, 'l'),
                  replay.data.more_turns ? jsx('p', { className: 'sw-pu', children: t('sw.replay.olderTurns', replay.data.more_turns) }, 'o') : null
                ]
              }, 'turns'),
              jsx(Player, { t, turn, cwd: replay.data.cwd, now, names, storedId, index, setIndex, playing, setPlaying, setHold, onToast }, `play-${turn.id}`),
              turn.more_steps ? jsx('p', { className: 'sw-pu', children: t('sw.replay.moreSteps', turn.more_steps) }, 'ms') : null
            ]
          }, 'g'),
      replay.data?.unreadable ? jsx('p', { className: 'sw-pu', children: t('sw.replay.unreadable', replay.data.unreadable) }, 'u') : null
    ]
  })
}

// ── files: pure helpers (exported for the render check) ────────────────────

/** posixpath.normpath, so a path folds the same way here as in the backend. */
function normpath(text) {
  if (!text) return '.'
  const lead = text.startsWith('//') && !text.startsWith('///') ? 2 : text.startsWith('/') ? 1 : 0
  const out = []
  for (const part of text.split('/')) {
    if (!part || part === '.') continue
    if (part !== '..' || (!lead && !out.length) || (out.length && out[out.length - 1] === '..')) out.push(part)
    else if (out.length) out.pop()
  }
  return '/'.repeat(lead) + out.join('/') || '.'
}

/**
 * One spelling per file — the backend's path_key: forward slashes, dot segments folded, a drive path
 * lowercased. tests/path_vectors.json holds the cases both sides must agree on.
 */
export function pathKey(path) {
  const text = String(path || '').replace(/\\/g, '/')
  let folded = text ? normpath(text) : ''
  if (folded === '.') folded = ''
  if (text.startsWith('//') && !text.startsWith('///') && !folded.startsWith('//')) folded = `/${folded}`
  return /^[A-Za-z]:\//.test(folded) ? folded.toLowerCase() : folded
}

/** A live tool call's path as the backend will record it: a relative path joined to the chat's folder. */
export function resolvePath(path, cwd) {
  const text = String(path || '')
  const unixish = text.replace(/\\/g, '/')
  if (!cwd || text.startsWith('~') || unixish.startsWith('/') || /^[A-Za-z]:\//.test(unixish)) return text
  return `${cwd.replace(/[/\\]+$/, '')}${cwd.includes('\\') ? '\\' : '/'}${text}`
}

/**
 * The files a live tool call names, as (path, op). A patch in V4A form names its files inside the
 * patch text; reading that grammar is the backend's job (it asks Hermes' own parser), so such a call
 * shimmers nothing here and shows up when the list reloads after it.
 */
export function fileTargets(name, args) {
  if (!FILE_TOOLS.has(name) || !args || typeof args !== 'object') return []
  if (name === 'patch' && (args.mode || 'replace') === 'patch') return []
  const path = typeof args.path === 'string' ? args.path : ''
  return path ? [{ path, op: name === 'read_file' ? 'read' : 'write' }] : []
}

/** What a file's mark says: now, the last change failed, deleted, edited, or only read. */
export function fileState(f, active) {
  if (active) return 'active'
  if (f.last_failed) return 'failed'
  if (f.last_op === 'delete' && f.deletes) return 'delete'
  if (f.writes || f.deletes) return 'write'
  return 'read'
}

function splitPath(path) {
  const text = String(path || '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut < 0 ? { dir: '', name: text } : { dir: text.slice(0, cut) || text.slice(0, 1), name: text.slice(cut + 1) }
}

/** A folder as its group heading: relative to the chat's folder when inside it, else cut from the left. */
export function dirLabel(dir, cwd, t = enT, cut = true) {
  const d = pathKey(dir)
  const c = cwd ? pathKey(cwd) : ''
  if (c && d === c) return t('sw.file.here')
  if (c && d.startsWith(`${c}/`)) return `./${dir.replace(/\\/g, '/').slice(cwd.replace(/[/\\]+$/, '').length + 1)}`
  return cut && dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

/**
 * The main agent's files with what it touches now: the backend's files plus any file touched now that
 * the backend has not recorded yet. Files being touched come first (state 'active'), then the newest.
 */
export function fileGroups(files, touching) {
  const byKey = new Map((files || []).map(f => [f.key || pathKey(f.path), f]))
  const now = []
  for (const [key, tc] of touching) {
    now.push(byKey.get(key) || {
      key, path: tc.path, reads: 0, writes: 0, deletes: 0, failed: 0, who: [], editors: [], last_op: tc.op, last_failed: false
    })
  }
  const nowKeys = new Set(now.map(f => f.key))
  const ordered = [...now, ...(files || []).filter(f => !nowKeys.has(f.key || pathKey(f.path)))]
  return ordered.map(f => ({ ...f, key: f.key || pathKey(f.path), state: fileState(f, nowKeys.has(f.key || pathKey(f.path))) }))
}

// ── page ─────────────────────────────────────────────────────────────────────

/**
 * The chat this page watches: the app's focused chat, as the SDK reports it. Desktop keeps the chat
 * being worked in focused while a non-chat pane (this page, another plugin page, a preview, the
 * sidebar) has focus (apps/desktop/src/store/session-focus.ts, in every supported core), so a click
 * inside the page never moves it and the page reads no app markup to tell.
 */
function useWatchedChat() {
  const runtimeId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId)
  return { runtimeId, storedId }
}

const NO_ATOM = { get: () => null, listen: () => () => {} }

export function Page() {
  const t = usePluginI18n(ID)
  const pageRef = useRef(null)
  const [theme] = useTheme()
  const watched = useWatchedChat()
  useWholeRows(pageRef)
  const { runtimeId, storedId } = watched
  const busyBy = useValue(host.state.busyBySession || NO_ATOM)
  const history = useHistory(storedId)
  const [tab, setTab] = useState('agents')
  const [selected, setSelected] = useState(MAIN)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [runKey, setRunKey] = useState(null)
  const [refocus, setRefocus] = useState(false)
  // A finished batch leaves the live run for its stored copy (the last run): a selected worker stays
  // selected (live keys it by subagent id, stored by session id) and keyboard focus moves along.
  const onBatchEnded = ({ sessions, focused }) => Promise.resolve(history.reload()).then(() => {
    const sid = sessions.get(selectedRef.current)
    if (sid) setSelected(sid)
    if (focused) setRefocus(true)
  })
  const live = useLive(runtimeId, onBatchEnded)
  const procs = useProcesses(storedId)
  const files = useFiles(storedId)
  const replay = useReplay(storedId, tab === 'replay')
  const { touching, tool } = useMainTools(runtimeId, files.data?.cwd, files.reload)
  const [toast, setToast] = useState(null)
  const procRows = procs.data?.processes || []
  const procsRunning = procRows.filter(p => p.status === 'running').length
  const now = useNow(live.batches.length > 0 || procsRunning > 0)

  useEffect(() => {
    setSelected(MAIN)
    setRunKey(null)
    setRefocus(false)
  }, [storedId])
  // Runs after every render until the moved run is drawn, then hands the focus once to its selected unit.
  useEffect(() => {
    if (!refocus) return
    const el = pageRef.current?.querySelector('.sw-orbit button[data-node][aria-pressed=true]')
    if (!el) return
    el.focus()
    setRefocus(false)
  })
  useEffect(() => {
    if (!toast) return undefined
    return ctxRef.setTimeout(() => setToast(null), 2400)
  }, [toast])
  const onToast = (text, bad) => setToast({ text, bad })

  const liveSessions = new Set(live.batches.flatMap(b => b.rows.map(r => r.child_session_id).filter(Boolean)))
  // subagent.list carries no child_session_id, so a batch still running on the backend is matched by
  // state and time: while a live run is drawn, a stored batch with an unfinished worker that started
  // no earlier than the live run (less LIVE_MATCH_S) IS that run.
  const liveStarts = live.batches.flatMap(b => b.rows.map(r => r.started_at)).filter(Number.isFinite)
  const liveFrom = (liveStarts.length ? Math.min(...liveStarts) : now) - LIVE_MATCH_S
  const isLiveStored = b => live.batches.length > 0 && b.started_at >= liveFrom && b.workers.some(w => w.status === 'running')
  const stored = history.data?.batches || []
  // The backend drops a worker from subagent.list the moment it finishes, so a half-done batch's
  // finished workers exist only in state.db. They join the live run; hiding the stored batch
  // without them turned '6 workers 5/6' into '1 worker 0/1'.
  const liveDoneGoals = live.batches.flatMap(b => b.rows).filter(r => TERMINAL.has(r.status)).map(r => String(r.goal || '').trim())
  const storedDone = stored.filter(isLiveStored).flatMap(b => b.workers)
    .filter(w => w.status !== 'running' && !liveSessions.has(w.session_id)
      && !liveDoneGoals.some(g => g && w.goal && g.startsWith(w.goal)))
  const nowBatches = storedDone.length
    ? live.batches.map((b, i) => (i < live.batches.length - 1 ? b : liveBatches([
      ...b.rows,
      ...storedDone.map(w => ({ ...w, subagent_id: `db:${w.session_id}`, delegation_id: b.id, tool_count: w.tool_calls, task_index: -1 }))
    ])[0]))
    : live.batches
  const past = stored
    .filter(b => !isLiveStored(b))
    .map(b => ({ ...b, workers: b.workers.filter(w => !liveSessions.has(w.session_id)) }))
    .filter(b => b.workers.length)
    .reverse()
  const isLive = nowBatches.length > 0
  // The run shown "now": the running one; with none running, the last one. The picker lists the rest.
  const earlier = isLive ? past : past.slice(1)
  const picked = runKey ? earlier.find(b => batchKey(b) === runKey) : null
  const nowSubs = isLive
    ? nowBatches.flatMap(b => liveUnits(b, now).map(u => ({ ...u, batch: b.id })))
    : past.length ? storedUnits(past[0]) : []
  const subs = picked ? storedUnits(picked) : nowSubs
  const viewing = picked ? 'past' : isLive ? 'live' : 'last'
  const calm = viewing === 'past'
  const active = viewing === 'live' ? subs.filter(u => u.status === 'running' || u.status === 'queued').length : 0
  const busy = Boolean(runtimeId && busyBy?.[runtimeId])
  const mainAct = calm ? null : tool ? (tool.name === 'delegate_task' && active ? 'wait' : toolAct(tool.name)) : active ? 'wait' : busy || touching.size ? 'think' : null
  const main = { key: MAIN, main: true, name: t('sw.main.name'), status: mainAct ? 'running' : 'idle', act: mainAct, rec: null }
  const units = [main, ...subs]
  const sel = units.find(u => u.key === selected) || main
  const flash = useFlash(subs, !calm)
  const byKey = new Map(subs.map(u => [u.key, u]))

  const runOf = b => {
    const units = storedUnits(b)
    const times = b.workers.map(w => w.duration_s).filter(v => v !== null && v !== undefined)
    const cost = sumCost(b.workers)
    return {
      key: batchKey(b),
      name: t('sw.run.name', workerName(b.workers[0]?.goal), b.workers.length - 1),
      statuses: units.map(u => u.status),
      meta: t('sw.run.meta', fmtAgo(now - b.started_at, t), units.filter(u => u.status === 'completed').length, units.length, fmtCost(cost.usd, cost.status, t)),
      ago: fmtAgo(now - b.started_at, t),
      took: times.length ? fmtDuration(Math.max(...times), t) : ''
    }
  }
  const nowCost = sumCost(nowSubs.map(u => u.rec))
  const runs = {
    now: isLive || past.length ? {
      name: t(isLive ? 'sw.run.current' : 'sw.run.last'),
      statuses: nowSubs.map(u => u.status),
      meta: isLive
        ? t('sw.run.liveMeta', nowSubs.filter(u => u.status === 'completed').length, nowSubs.length, fmtCost(nowCost.usd, nowCost.status, t))
        : runOf(past[0]).meta
    } : null,
    earlier: earlier.map(runOf)
  }
  let view
  if (picked) {
    const r = runOf(picked)
    view = { kind: 'past', key: r.key, name: r.name, meta: t('sw.run.past', r.ago, r.took) }
  } else if (isLive) {
    view = { kind: 'live', name: t('sw.run.current'), meta: t('sw.run.live', fmtAgo(now - (liveStarts.length ? Math.min(...liveStarts) : now), t)) }
  } else if (past.length) {
    const r = runOf(past[0])
    view = { kind: 'last', name: t('sw.run.last'), meta: t('sw.run.lastMeta', r.ago, r.took) }
  }
  const pickRun = key => {
    setRunKey(key === 'now' ? null : key)
    setSelected(MAIN)
  }

  const errors = [
    history.error ? t('sw.err.item', t('sw.err.history'), history.error) : null,
    live.error ? t('sw.err.item', t('sw.err.live'), live.error) : null,
    procs.error ? t('sw.err.item', t('sw.err.procs'), procs.error) : null,
    files.error ? t('sw.err.item', t('sw.err.files'), files.error) : null,
    tab === 'replay' && replay.error ? t('sw.err.item', t('sw.err.replay'), replay.error) : null
  ].filter(Boolean)
  const refreshAll = () => { history.reload(); procs.reload(); files.reload(); replay.reload(); live.retry() }
  const chatName = storedId ? history.data?.title || t('sw.chat.untitled', String(storedId).slice(-6)) : ''
  const noChat = !storedId && !runtimeId
  const loading = !noChat && history.loading && !history.data && !live.batches.length
  const nothing = !isLive && !past.length && history.error && procs.error && (files.error || !files.data?.files?.length)

  let body
  if (noChat) {
    body = jsxs('div', { className: 'sw-hint', children: [jsx('b', { children: t('sw.noChat.title') }, 't'), jsx('span', { children: t('sw.noChat.body') }, 'b'), jsx('span', { className: 'sw-cur', 'aria-hidden': 'true' }, 'c')] })
  } else if (loading) {
    body = jsxs('div', {
      className: 'sw-skel', role: 'status', 'aria-label': t('sw.loading'),
      children: [jsxs('div', { className: 'sw-sks', 'aria-hidden': 'true', children: [0, 1, 2].map(i => jsx('span', { className: 'sw-sk' }, i)) }, 's'), jsx('div', { className: 'sw-k', children: t('sw.loading') }, 'k')]
    })
  } else if (tab === 'commands') {
    body = jsx(Commands, { t, procs, now, storedId, onToast })
  } else if (tab === 'replay') {
    const names = new Map(stored.flatMap(b => b.workers.map(w => [w.session_id, workerName(w.goal)])))
    // Keyed by chat: another chat starts on its newest request, even when a live run keeps the page drawn.
    body = jsx(Replay, { t, replay, now, names, storedId, onToast }, `replay-${storedId}`)
  } else if (nothing) {
    body = jsx('p', { className: 'sw-empty', children: t('sw.allFailed') })
  } else {
    const parentName = sel.parent ? byKey.get(sel.parent)?.name : ''
    body = jsxs('div', {
      className: 'sw-agents', role: 'tabpanel', id: 'sw-tab-agents', 'aria-labelledby': 'sw-tabb-agents',
      children: [
        view ? jsx(RunBar, { t, view, runs, onPick: pickRun, onBack: () => pickRun('now') }, 'run') : null,
        jsxs('div', {
          className: 'sw-agrid',
          children: [
            jsx(HudPanel, {
              title: t('sw.hudAgents.fleet', view ? t(view.kind === 'live' ? 'sw.run.current' : view.kind === 'last' ? 'sw.run.last' : 'sw.hudAgents.pastRun') : ''),
              span: 6, className: 'sw-hpx sw-hfleet',
              chip: subs.length ? hudChip(batchState(subs.map(u => u.status)), t('sw.hudAgents.done', subs.filter(u => u.status === 'completed').length, subs.length)) : null,
              children: [jsx(Orbit, { t, main, subs, selected: sel.key, onSelect: setSelected, flash, waitingOn: active, calm }, `orbit-${view?.key || 'now'}`)]
            }, 'fleet'),
            jsx(FleetTimes, { t, subs }, 'time'),
            jsx(Score, { t, subs }, 'score'),
            jsx(FleetFiles, { t, files }, 'files'),
            jsx(FleetAgent, { t, u: sel, subs, files, waitingOn: active }, 'agent'),
            jsx(FleetLog, { t, subs, selected: sel.key, onSelect: setSelected, now }, 'log'),
            jsx(HudPanel, {
              title: t('sw.hudAgents.detail'), name: agentLabel(sel.main ? main : sel), span: 6, className: 'sw-hdetail', fold: true,
              children: [sel.main
                ? jsx(MainPanel, { t, theme, main, files, touching: calm ? new Map() : touching, tool: calm ? null : tool, waitingOn: active, onToast }, 'focus-main')
                : jsx(SubPanel, { t, theme, u: sel, parentName, files, onToast }, `focus-${sel.key}`)]
            }, 'detail')
          ]
        }, 'grid')
      ]
    })
  }

  const tabs = noChat || loading ? null : jsxs('div', {
    className: 'sw-tabs', role: 'tablist', 'aria-label': t('sw.tabs.label'),
    children: ['agents', 'commands', 'replay'].map(id => jsxs('button', {
      type: 'button', role: 'tab', id: `sw-tabb-${id}`, className: 'sw-tab', 'data-tab': id, 'aria-selected': tab === id,
      'aria-controls': `sw-tab-${id}`, onClick: () => setTab(id),
      children: [
        t(`sw.tabs.${id}`),
        id === 'commands' && (procsRunning || procs.error)
          ? jsx(Tip, {
            label: procs.error ? t('sw.countFailed') : t('sw.tabs.running', procsRunning),
            children: jsx('span', { className: 'sw-tabn', role: 'img', 'aria-label': procs.error ? t('sw.countFailed') : t('sw.tabs.running', procsRunning), children: procs.error ? '—' : procsRunning })
          }, 'n')
          : null
      ]
    }, id))
  }, 'tabs')

  return jsx(WatchedChat.Provider, { value: storedId, children: jsxs('div', {
    className: 'sw-page', ref: pageRef, 'data-theme': theme,
    children: [
      jsx('style', { children: CSS }, 'css'),
      jsxs('div', {
        className: 'sw-panel', 'data-calm': calm ? 'true' : undefined, 'data-tab': tab,
        children: [
          jsxs('header', {
            className: 'sw-hd',
            children: [
              jsx('h2', { className: 'sw-ht', children: theme === 'terminal' ? ID : t('sw.title') }, 't'),
              // Which chat this is.
              chatName ? jsx('span', { className: 'sw-chatn', children: theme === 'terminal' ? `// ${chatName}` : chatName }, 'c') : null,
              noChat ? null : jsx(IconButton, { label: t('sw.refresh'), icon: ICON.refresh, onClick: refreshAll, disabled: !storedId }, 'r')
            ]
          }, 'h'),
          tabs,
          errors.length
            ? jsxs('div', {
              className: 'sw-err', role: 'alert',
              children: [
                jsx('b', { className: 'sw-errt', children: t('sw.err.title') }, 't'),
                jsx('ul', { children: errors.map(e => jsx('li', { children: jsx(OneLine, { text: e }) }, e)) }, 'l'),
                // Recovery sits beside the failure, not only as an unlabeled icon in the header.
                jsx('div', { className: 'sw-erra', children: jsx(IconButton, { label: t('sw.retry'), icon: ICON.refresh, onClick: refreshAll, disabled: !storedId, text: true }) }, 'retry')
              ]
            }, 'e')
            : null,
          jsx('div', { className: 'sw-bd', children: body }, 'b'),
          // The live region stays mounted so a screen reader is already listening when a toast lands.
          jsx('div', {
            className: 'sw-live', role: 'status', 'aria-live': 'polite',
            children: toast ? jsx('div', { className: `sw-toast${toast.bad ? ' is-bad' : ''}`, children: toast.text }) : null
          }, 'toast')
        ]
      }, 'panel')
    ]
  }) })
}

/** A stored batch's identity: its start alone can be shared by two batches; its first worker cannot. */
function batchKey(b) {
  return `${b.started_at}:${b.workers[0]?.session_id || ''}`
}

// ── progress: status-bar chip + pet line ─────────────────────────────────────
//
// The page's live tree exists only while the page is open; the progress has to show while the user
// is in the chat. A small tracker follows the same subagent.* events for every chat (keyed by the
// runtime session id the events carry) and the chip reads the focused chat's entry. A status-bar
// chip, not a composer banner: a composer slot is told no session, so in a split layout every
// composer would show the focused chat's batch; the status bar is one strip for the focused chat.

const tracks = new Map() // runtime session id -> { workers: Map<subagent_id, { status, queued_at, cost_usd, cost_status }>, endedAt }
const trackSubs = new Set()

function settle(track) {
  const all = [...track.workers.values()]
  track.endedAt = all.length && all.every(w => TERMINAL.has(w.status)) ? (track.endedAt ?? Date.now()) : null
}

function changed() {
  trackSubs.forEach(fn => fn())
  petUpdate()
}

/** A new batch starts when a worker the finished batch never had shows up. */
function trackFor(sid, newcomer) {
  const track = tracks.get(sid)
  if (track && !(track.endedAt && newcomer)) return track
  const fresh = { workers: new Map(), endedAt: null }
  tracks.set(sid, fresh)
  return fresh
}

/** One subagent.* event into its chat's tracker. A worker's end is final. */
export function trackEvent(type, event) {
  const sid = event?.session_id
  const p = event?.payload || {}
  if (!sid || !p.subagent_id) return
  const known = tracks.get(sid)?.workers.has(p.subagent_id)
  if (type === 'subagent.complete' && !tracks.get(sid)) return // the end of a worker never seen: nothing to count against
  const track = trackFor(sid, !known && type !== 'subagent.complete')
  const had = track.workers.get(p.subagent_id)
  if (TERMINAL.has(had?.status)) return
  let next
  if (type === 'subagent.spawn_requested') next = { status: 'queued', queued_at: Date.now() / 1000 }
  else if (type === 'subagent.start') next = { status: 'running' }
  else if (type === 'subagent.complete') next = { status: STATUS_OF[p.status] || 'completed', ...eventCost(p) }
  else if (!had) next = { status: 'running' } // progress of a worker whose spawn we missed
  else return
  track.workers.set(p.subagent_id, { ...had, ...next })
  settle(track)
  changed()
}

/**
 * A subagent.list snapshot into the chat's tracker: picks up a batch that was already running when
 * the app loaded, and ends a worker whose complete frame never arrived (the registry no longer
 * lists it). A queued worker is listed only once it starts, so it gets QUEUE_GRACE_S.
 */
export function trackSnapshot(sid, rows, at = Date.now() / 1000) {
  const listed = (rows || []).filter(r => r?.subagent_id)
  const live = listed.filter(r => !TERMINAL.has(STATUS_OF[r.status] || r.status))
  const prev = tracks.get(sid)
  if (!prev && !live.length) return
  const track = trackFor(sid, live.some(r => !prev?.workers.has(r.subagent_id)))
  const seen = new Set()
  for (const r of listed) {
    seen.add(r.subagent_id)
    const had = track.workers.get(r.subagent_id)
    const status = STATUS_OF[r.status] || r.status
    if (TERMINAL.has(had?.status) || (!had && TERMINAL.has(status))) continue
    track.workers.set(r.subagent_id, { ...had, status })
  }
  for (const [id, w] of track.workers) {
    if (seen.has(id) || TERMINAL.has(w.status)) continue
    if (w.status === 'queued' && at - (w.queued_at ?? at) < QUEUE_GRACE_S) continue
    track.workers.set(id, { ...w, status: 'stopped' })
  }
  settle(track)
  changed()
}

/** What the chip and the pet show for one chat's batch. */
export function progressOf(track) {
  const workers = [...(track?.workers.values() || [])]
  const count = st => workers.filter(w => w.status === st).length
  const finished = workers.filter(w => TERMINAL.has(w.status)).length
  const failed = count('failed') + count('stopped')
  const state = batchState(workers.map(w => w.status))
  return { total: workers.length, finished, failed, running: count('running'), state, ended: Boolean(track?.endedAt), cost: sumCost(workers) }
}

let petLine = ''
/** The focused chat's progress as a line in the pet's bubble; nothing when no pet is on screen. */
function petUpdate() {
  const pet = ctxRef?.pet
  if (!pet?.visible?.get?.()) return
  const track = tracks.get(host.state.focusedSessionId.get())
  const shown = track?.workers.size && !(track.endedAt && Date.now() - track.endedAt > PROGRESS_LINGER_MS)
  if (!shown) {
    if (petLine) pet.clear('progress')
    petLine = ''
    return
  }
  const pr = progressOf(track)
  const text = enT('sw.progress.pet', pr.finished, pr.total, fmtCost(pr.cost.usd, pr.cost.status))
  if (text === petLine) return
  petLine = text
  pet.say(text, {
    id: 'progress',
    tone: pr.ended ? (pr.failed ? 'error' : 'info') : 'wait',
    ttlMs: pr.ended ? PROGRESS_LINGER_MS : PET_LINE_MS
  })
}

function useTracks() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump(n => n + 1)
    trackSubs.add(fn)
    return () => { trackSubs.delete(fn) }
  }, [])
}

/** The focused chat's batch: one cell per subagent, finished/total, failures, the cost so far. Opens the page on click. */
function ProgressChip() {
  const t = usePluginI18n(ID)
  const [theme] = useTheme()
  const runtimeId = useValue(host.state.focusedSessionId)
  useTracks()
  const track = runtimeId ? tracks.get(runtimeId) : null
  const live = Boolean(track && track.workers.size && !track.endedAt)
  const [stalled, setStalled] = useState(null)
  // Reconcile with subagent.list: once when a chat gets focus (a batch may already be running),
  // then every POLL_MS while its batch runs. Three failures in a row say so and slow the poll to
  // SLOW_POLL_MS; a runtime Hermes does not hold right now (4001) is not a failure.
  useEffect(() => {
    setStalled(null)
    if (!runtimeId) return undefined
    let alive = true
    let fails = 0
    let next = () => {}
    const poll = async () => {
      if (!alive) return
      let wait = POLL_MS
      try {
        const snap = await host.request('subagent.list', { session_id: runtimeId })
        if (!alive) return
        fails = 0
        setStalled(null)
        trackSnapshot(runtimeId, snap?.subagents)
      } catch (err) {
        if (!alive) return
        if (isRuntimeGone(err)) {
          fails = 0
          setStalled(null)
          wait = SLOW_POLL_MS
        } else {
          fails += 1
          console.warn(`[${ID}] progress: subagent.list failed (${fails}/${MAX_POLL_FAILS})`, err)
          if (fails >= MAX_POLL_FAILS) {
            setStalled(String(err?.message || err))
            wait = SLOW_POLL_MS
          }
        }
      }
      if (alive && live) {
        next()
        next = ctxRef.setTimeout(() => void poll(), wait)
      }
    }
    void poll()
    return () => {
      alive = false
      next()
    }
  }, [runtimeId, live])
  // A finished batch lingers, then the chip goes.
  const endedAt = track?.endedAt
  const [, expire] = useState(0)
  useEffect(() => {
    if (!endedAt) return undefined
    const left = PROGRESS_LINGER_MS - (Date.now() - endedAt)
    if (left <= 0) return undefined
    return ctxRef.setTimeout(() => { expire(n => n + 1); petUpdate() }, left + 50)
  }, [endedAt])
  if (!track?.workers.size || (endedAt && Date.now() - endedAt > PROGRESS_LINGER_MS)) return null
  const pr = progressOf(track)
  const cost = fmtCost(pr.cost.usd, pr.cost.status, t)
  const st = stalled ? 'failed' : pr.state
  const tip = stalled
    ? t('sw.progress.stalled', stalled)
    : t('sw.progress.tip', pr.finished, pr.total, pr.failed, pr.running, cost)
  const pct = pr.total ? Math.round((pr.finished / pr.total) * 100) : 0
  return jsxs('span', {
    className: 'sw-sbw', 'data-theme': theme,
    children: [
      jsx('style', { children: CHIP_CSS }, 'css'),
      jsx(Tip, {
        label: tip,
        children: jsxs('button', {
          type: 'button', className: 'sw-sb', 'data-st': st, 'aria-label': tip,
          onClick: () => host.navigate(ROUTE),
          children: [
            jsx('span', { className: 'sw-sbm', 'aria-hidden': 'true', children: (MARKS[st] || MARKS.stopped)() }, 'm'),
            jsx('span', { className: 'sw-sbn', children: `${pr.finished}/${pr.total}` }, 'n'),
            jsx('span', { className: 'sw-sbbar', 'aria-hidden': 'true', children: jsx('i', { style: { width: `${pct}%` } }) }, 'b'),
            cost ? jsx('span', { className: 'sw-sbc', children: cost }, 'c') : null
          ]
        })
      }, 'chip')
    ]
  })
}

// Two palettes, both drawn from the app theme, so the panel changes with the skin the user picked.
// The page uses the app's own tokens as they are: its ground is transparent (so the window's glass shows
// through, as it does behind the chat), panels are the app's translucent card, hairlines its strokes,
// text its text levels, the diff its diff colours, a picked row its active-row fill. The accent is the
// theme accent, lifted only as far as it needs to read on a dark ground (pressed down on a light one);
// red / yellow are the theme's status colours. The status-bar chip sits in the app's own bar and tints
// everything toward the accent. No colour literals anywhere (audit_static.py).
const TM_PALETTE = `
.sw-page[data-theme=terminal]{--tm-acc:light-dark(oklch(from var(--ui-accent) min(l,.5) c h),oklch(from var(--ui-accent) max(l,.66) c h));--tm-ok:var(--tm-acc);
 --tm-bg:transparent;--tm-raised:color-mix(in srgb,var(--ui-bg-card) 50%,var(--dt-background));--tm-shade:var(--ui-bg-chrome);
 --tm-hi:var(--ui-text-primary);--tm-name:var(--ui-text-primary);--tm-ink:color-mix(in srgb,var(--ui-text-primary) 55%,var(--ui-text-secondary));
 --tm-dim:var(--ui-text-secondary);--tm-line:var(--ui-stroke-tertiary);
 --tm-badline:color-mix(in srgb,var(--ui-red) 40%,transparent);--tm-run:light-dark(oklch(from color-mix(in srgb,var(--ui-yellow) 82%,var(--ui-base)) min(l,.5) c h),color-mix(in srgb,var(--ui-yellow) 82%,var(--ui-base)));
 --tm-bad:light-dark(oklch(from color-mix(in srgb,var(--ui-red) 82%,var(--ui-base)) min(l,.5) c h),color-mix(in srgb,var(--ui-red) 82%,var(--ui-base)));--tm-glow:color-mix(in srgb,var(--tm-acc) 40%,transparent);
 --hud-page:transparent;--hud-hero:color-mix(in srgb,var(--ui-base) 2%,transparent);--hud-line2:var(--ui-stroke-secondary);
 --hud-grid:var(--ui-stroke-quaternary);--hud-track:color-mix(in srgb,var(--ui-base) 8%,transparent);
 --hud-teal:color-mix(in srgb,var(--tm-acc) 24%,transparent);--hud-teal-b:color-mix(in srgb,var(--tm-acc) 34%,transparent);--hud-teal-d:color-mix(in srgb,var(--tm-acc) 13%,transparent);
 --hud-wire:var(--ui-text-tertiary);--hud-frame:var(--ui-text-secondary);--hud-node:var(--ui-stroke-primary);
 --hud-add:var(--ui-diff-add-background);--hud-del:var(--ui-diff-remove-background);--hud-add-ink:var(--ui-diff-add-foreground);--hud-del-ink:var(--ui-diff-remove-foreground);--hud-pick:var(--ui-row-active-background)}
.sw-sbw[data-theme=terminal]{--tm-acc:color-mix(in srgb,var(--ui-accent) 70%,var(--ui-text-primary));
 --tm-bg:color-mix(in srgb,var(--ui-accent) 5%,var(--dt-background));--tm-raised:color-mix(in srgb,var(--ui-accent) 10%,var(--dt-background));
 --tm-ink:color-mix(in srgb,var(--ui-accent) 30%,var(--ui-text-primary));--tm-hi:color-mix(in srgb,var(--ui-accent) 12%,var(--ui-text-primary));
 --tm-name:color-mix(in srgb,var(--ui-accent) 20%,var(--ui-text-primary));--tm-dim:color-mix(in srgb,var(--ui-accent) 30%,var(--ui-text-secondary));
 --tm-line:color-mix(in srgb,var(--ui-accent) 32%,var(--dt-background));--tm-badline:color-mix(in srgb,var(--ui-red) 45%,var(--dt-background));
 --tm-run:color-mix(in srgb,var(--ui-yellow) 82%,var(--ui-text-primary));--tm-bad:color-mix(in srgb,var(--ui-red) 82%,var(--ui-text-primary));
 --tm-ok:color-mix(in srgb,var(--ui-green) 82%,var(--ui-text-primary));--tm-glow:color-mix(in srgb,var(--ui-accent) 70%,transparent);--tm-shade:var(--ui-bg-sidebar)}
`

// The chip sits in the app's status bar, outside the page: both looks take the app's tokens (Terminal
// through TM_PALETTE).
const CHIP_CSS = `${TM_PALETTE}
.sw-sbw{display:inline-flex;align-items:center}
.sw-sb{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border-radius:3px;border:0;background:transparent;
 color:var(--ui-text-secondary);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;--sw-tint:var(--ui-yellow)}
.sw-sb:hover{background:color-mix(in srgb,var(--ui-accent) 14%,transparent);color:var(--ui-text-primary)}
.sw-sb:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px}
.sw-sb[data-st=completed]{--sw-tint:var(--ui-green)}
.sw-sb[data-st=failed]{--sw-tint:var(--ui-red)}
.sw-sb[data-st=stopped],.sw-sb[data-st=queued]{--sw-tint:var(--ui-text-quaternary)}
.sw-sbm{width:13px;height:13px;flex:none}
.sw-sbm svg{width:100%;height:100%;display:block}
.sw-sbbar{width:44px;height:5px;background:var(--ui-bg-tertiary);overflow:hidden;flex:none;transform:skewX(-20deg)}
.sw-sbbar>i{display:block;height:100%;background:var(--sw-tint);transition:width .3s}
.sw-sbw[data-theme=terminal] .sw-sb{background:var(--tm-bg);color:var(--tm-ink);font-family:var(--dt-font-sans,system-ui,sans-serif);box-shadow:inset 0 0 0 1px var(--tm-line);--sw-tint:var(--tm-run)}
.sw-sbw[data-theme=terminal] .sw-sb[data-st=completed]{--sw-tint:var(--tm-ok)}
.sw-sbw[data-theme=terminal] .sw-sb[data-st=failed]{--sw-tint:var(--tm-bad)}
.sw-sbw[data-theme=terminal] .sw-sb[data-st=stopped],.sw-sbw[data-theme=terminal] .sw-sb[data-st=queued]{--sw-tint:var(--tm-dim)}
.sw-sbw[data-theme=terminal] .sw-sbm{display:none}
.sw-sbw[data-theme=terminal] .sw-sbbar{transform:none;background:var(--tm-line)}
.sw-sb .sw-spin{animation:sw-rot 1.1s linear infinite;transform-origin:50% 50%}
@keyframes sw-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sw-sb .sw-spin{animation:none}.sw-sbbar>i{transition:none}}
`


const CSS = `${TM_PALETTE}
.sw-page{height:100%;min-height:0;overflow:auto;padding:16px 20px;font-size:12.5px;--mono:var(--dt-font-mono,ui-monospace,monospace)}
.sw-page:not([data-theme=terminal]){--a:var(--ui-accent);--ink:var(--ui-text-primary);--dim:var(--ui-text-secondary);--bg:var(--dt-background);--solid:var(--bg);
 --run:var(--a);--ok:var(--ink);--bad:var(--ui-red);--idle:var(--ui-text-tertiary);--line:color-mix(in srgb,var(--ink) 11%,transparent);
 --raised:color-mix(in srgb,var(--ink) 8%,var(--bg));--tile:color-mix(in srgb,var(--ink) 5%,var(--bg));--off:color-mix(in srgb,var(--ink) 16%,var(--bg));--pop:var(--raised)}
/* --solid: an opaque ground (Terminal's --bg is transparent, and a canvas reads transparent as black);
   --pop: anything drawn OVER other content (a menu) — opaque, or the content under it shows through */
.sw-page[data-theme=terminal]{--a:var(--tm-acc);--ink:var(--tm-ink);--dim:var(--tm-dim);--bg:var(--tm-bg);--solid:var(--dt-background);
 --pop:color-mix(in srgb,var(--ui-text-primary) 7%,var(--dt-background));
 --run:var(--tm-run);--ok:var(--tm-ok);--bad:var(--tm-bad);--idle:var(--tm-dim);--line:var(--tm-line);--raised:var(--tm-raised)}
.sw-page{font-variant-emoji:text}
.sw-page [data-st=running]{--c:var(--run)}
.sw-page [data-st=completed]{--c:var(--ok)}
.sw-page [data-st=failed]{--c:var(--bad)}
.sw-page [data-st=stopped],.sw-page [data-st=queued],.sw-page [data-st=idle]{--c:var(--idle)}
.sw-panel{position:relative;container-type:inline-size;max-width:860px;margin:0 auto;padding:16px 18px 18px;color:var(--ink);background:var(--bg)}
/* the HUD is scaled so its smallest text (11.5px) lands at 11px, the size the user picked */
.sw-page[data-theme=terminal]{zoom:.9566;padding:8px;background:var(--hud-page)}
.sw-page[data-theme=terminal] .sw-panel{padding:8px 8px 12px;font:350 11.5px/1.5 var(--mono);font-variant-ligatures:none;-webkit-font-smoothing:antialiased;overflow:hidden}
.sw-page :where(button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.sw-page button:focus-visible,.sw-page [tabindex]:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.sw-page button:disabled{opacity:.5;cursor:default}
.sw-k{margin:0;font:600 11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-k{font-size:11.5px;font-weight:400}
.sw-cur{display:none}
.sw-page[data-theme=terminal] .sw-cur{display:inline-block;width:8px;height:14px;margin-left:4px;vertical-align:-2px;background:var(--a);box-shadow:0 0 8px var(--a);animation:sw-blink 1.06s steps(1) infinite}
/* header */
.sw-hd{display:flex;align-items:center;gap:10px;min-width:0}
.sw-ht{flex:none;margin:0;font:700 13px var(--mono);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.sw-page[data-theme=terminal] .sw-ht{letter-spacing:.04em;color:var(--tm-hi)}
.sw-chatn{min-width:0;flex:0 1 auto;font-size:12.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page[data-theme=terminal] .sw-chatn{text-transform:lowercase}
.sw-ib{display:inline-grid;place-items:center;width:26px;height:26px;color:var(--dim);box-shadow:inset 0 0 0 1px var(--line)}
.sw-hd>.sw-ib{flex:none;margin-left:auto}
.sw-ib svg{width:14px;height:14px}
.sw-ib:hover{color:var(--ink);background:color-mix(in srgb,var(--a) 12%,transparent)}
.sw-ib.is-pri{background:color-mix(in srgb,var(--a) 20%,transparent)}
/* labelled buttons are cut-corner keys; the primary one is filled */
.sw-ib.is-text{display:inline-flex;align-items:center;gap:7px;width:auto;height:auto;padding:7px 14px;font:12px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--ink);
 background:color-mix(in srgb,var(--a) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 60%,transparent);clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}
.sw-ib.is-text:hover{background:color-mix(in srgb,var(--a) 26%,transparent)}
.sw-page .sw-ib.is-text:focus-visible{outline-color:var(--ink);outline-offset:-5px}
.sw-ib.is-text.is-pri{background:var(--a);color:var(--dt-primary-foreground);font-weight:700}
.sw-ib.is-text.is-pri:hover{background:color-mix(in srgb,var(--a) 82%,var(--ink))}
.sw-ib.is-busy{opacity:.7}
.sw-ibi{display:inline-flex;width:13px;height:13px}
.sw-ibi svg{width:100%;height:100%}
.sw-page[data-theme=terminal] .sw-ib{box-shadow:none;color:var(--a)}
.sw-page[data-theme=terminal] .sw-ib.is-text{padding:2px 9px;gap:4px;clip-path:none;font-size:11.5px;letter-spacing:.04em;font-weight:400;color:var(--ink);background:none;box-shadow:inset 0 0 0 1px var(--hud-line2)}
.sw-page[data-theme=terminal] .sw-ib.is-text:hover{color:var(--tm-hi);background:none;box-shadow:inset 0 0 0 1px var(--hud-teal-b)}
.sw-page[data-theme=terminal] .sw-ib.is-text .sw-ibi{display:none}
.sw-page[data-theme=terminal] .sw-ib.is-pri{background:none}
.sw-page[data-theme=terminal] .sw-ib.is-text.is-pri{color:var(--a);background:var(--hud-teal-d);box-shadow:inset 0 0 0 1px var(--hud-teal-b)}
/* tabs */
.sw-tabs{display:flex;gap:18px;margin:12px 0;border-bottom:1px solid color-mix(in srgb,var(--a) 25%,transparent)}
.sw-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 0;margin-bottom:-1px;font:12px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid transparent!important}
.sw-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--a)!important}
.sw-tabn{padding:0 5px;font-size:11.5px;letter-spacing:0;background:var(--run);color:var(--bg)}
.sw-page[data-theme=terminal] .sw-tabs{counter-reset:sw-tab;border-bottom-color:var(--line)}
.sw-page[data-theme=terminal] .sw-tab{font-size:11.5px;border-bottom-width:1px!important}
.sw-page[data-theme=terminal] .sw-tab::before{counter-increment:sw-tab;content:"0" counter(sw-tab);color:var(--dim)}
.sw-page[data-theme=terminal] .sw-tab[aria-selected=true]{color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-tab[aria-selected=true]::before{color:var(--a)}
.sw-page[data-theme=terminal] .sw-tabn{background:none;color:var(--run)}
.sw-page[data-theme=terminal] .sw-tabn::before{content:"("}
.sw-page[data-theme=terminal] .sw-tabn::after{content:")"}
/* alert, empty states */
.sw-err{margin:0 0 12px;padding:10px 12px;font-size:12.5px;line-height:1.45;background:color-mix(in srgb,var(--bad) 10%,var(--bg));border-left:3px solid var(--bad)}
.sw-err ul{margin:2px 0 8px;padding-left:16px;color:var(--ink)}
.sw-err li{min-width:0}
.sw-page[data-theme=terminal] .sw-err{background:var(--bg);border:1px solid var(--tm-badline)}
.sw-errt{font-weight:600}
.sw-hint{display:flex;flex-direction:column;align-items:center;gap:4px;padding:26px 8px;text-align:center;color:var(--dim)}
.sw-hint b{font:600 13px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
.sw-page[data-theme=terminal] .sw-hint{align-items:flex-start;text-align:left}
.sw-page[data-theme=terminal] .sw-hint b{letter-spacing:0;text-transform:lowercase}
.sw-page[data-theme=terminal] .sw-hint b::before{content:"> "}
.sw-skel{display:flex;flex-direction:column;align-items:center;gap:12px;margin:18px 0 12px}
.sw-sks{display:flex;gap:16px}
.sw-sk{width:46px;height:52px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:color-mix(in srgb,var(--a) 16%,var(--bg));animation:sw-skp 1.4s ease-in-out infinite}
.sw-page[data-theme=terminal] .sw-sk{clip-path:none;width:120px;height:12px;background:var(--tm-line)}
.sw-empty{margin:0;padding:6px 0;color:var(--dim)}
/* run bar + picker */
.sw-agents{position:relative}
.sw-runb{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;color:var(--dim)}
.sw-pick{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;color:var(--ink)!important;font:12px var(--mono)!important;letter-spacing:.04em;text-transform:uppercase;box-shadow:inset 0 0 0 1px var(--line)}
.sw-pickv{display:inline-flex;width:12px;height:12px}.sw-pickv svg{width:100%;height:100%}
.sw-page[data-theme=terminal] .sw-pick{padding:0;box-shadow:none;text-transform:lowercase;letter-spacing:0}
.sw-page[data-theme=terminal] .sw-pick::before{content:"run:";color:var(--tm-hi)}
.sw-ld{width:7px;height:7px;flex:none;background:var(--run);box-shadow:0 0 8px var(--run);transform:rotate(45deg);animation:sw-pulse 1.6s ease-in-out infinite}
.sw-runm{flex:1 1 0}
.sw-pick{max-width:100%;min-width:0}
.sw-pickn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-back{margin-left:auto;font:12px var(--mono)!important;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)!important;padding:3px 8px!important;box-shadow:inset 0 0 0 1px var(--a)}
.sw-page[data-theme=terminal] .sw-back{box-shadow:none;text-transform:lowercase;letter-spacing:0;color:var(--a)!important;padding:0!important}
.sw-page[data-theme=terminal] :is(.sw-back,.sw-more:not(.sw-inl)){padding:2px 9px!important;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)!important;background:none;box-shadow:inset 0 0 0 1px var(--hud-line2)}
.sw-page[data-theme=terminal] :is(.sw-back,.sw-more:not(.sw-inl)):hover{color:var(--tm-hi)!important;box-shadow:inset 0 0 0 1px var(--hud-teal-b)}
.sw-page[data-theme=terminal] .sw-back::before{content:"← "}
.sw-menu{position:absolute;z-index:8;left:0;top:calc(100% + 6px);width:min(380px,100%);padding:6px;background:var(--pop);color:var(--ink);
 box-shadow:0 10px 30px color-mix(in srgb,var(--bg) 70%,transparent),inset 0 0 0 1px var(--a)}
.sw-mr{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px}
.sw-mr:hover,.sw-mr.is-on{background:color-mix(in srgb,var(--a) 16%,transparent)}
.sw-mrn{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-mrx{flex:none;font:11.5px var(--mono);color:var(--dim);white-space:nowrap}
.sw-mr:hover .sw-mrx,.sw-mr.is-on .sw-mrx{color:var(--ink)}
.sw-mh{padding:6px 10px 2px}
.sw-mini{display:flex;gap:2px;flex:none}
.sw-mini i{width:7px;height:7px;transform:skewX(-20deg);background:var(--c,var(--idle))}
.sw-page[data-theme=terminal] .sw-mini{gap:0}
.sw-page[data-theme=terminal] .sw-mini i{transform:none;width:8px;height:10px}
.sw-more{display:block;margin:4px 0 0 14px;font:12px var(--mono)!important;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)!important;text-decoration:underline;text-decoration-color:var(--a);text-underline-offset:3px}
.sw-more.sw-inl{display:inline;margin:0 0 0 6px}
.sw-page[data-theme=terminal] .sw-more{text-transform:lowercase;letter-spacing:0;text-decoration:none;color:var(--a)!important}
.sw-page[data-theme=terminal] .sw-more.sw-inl::before{content:"+ "}
/* score */
.sw-score{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.sw-sseg{flex:1;min-width:120px}
.sw-big{font:700 36px/1 var(--mono);text-shadow:0 0 18px color-mix(in srgb,var(--a) 60%,transparent);overflow:hidden}
.sw-bign{display:inline-block;animation:sw-up .5s ease-out}
.sw-big small{font-size:18px;color:var(--dim)}
.sw-seg{display:flex;gap:3px;height:8px;margin:6px 0 5px}
.sw-seg i{flex:1;max-width:60px;transform:skewX(-20deg);background:var(--c,var(--idle))}
.sw-spent{text-align:right}
.sw-money{display:block;font:700 19px var(--mono)}
.sw-page[data-theme=terminal] .sw-big{font-size:20px;font-weight:300;text-shadow:none;color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-seg{gap:0;height:12px}
.sw-page[data-theme=terminal] .sw-seg i{transform:none}
.sw-page[data-theme=terminal] .sw-money{font-size:14px;color:var(--tm-hi)}
/* the portrait's icon (the focus panel) */
.sw-ic{position:relative;z-index:1;width:22px;height:22px;color:var(--ink);filter:drop-shadow(0 0 6px var(--c))}
.sw-ic svg{width:100%;height:100%;display:block}
.sw-nosub{flex:1;min-width:160px;margin:0;color:var(--dim)}
/* focus panel */
.sw-focus{position:relative;margin-top:18px;padding:14px 16px 16px;background:color-mix(in srgb,var(--a) 5%,var(--bg))}
.sw-page[data-theme=terminal] .sw-focus{background:var(--bg);border:1px solid var(--line);padding:10px 12px 12px}
.sw-page[data-theme=terminal] .sw-focus[data-st=failed]{border-color:var(--tm-badline)}
.sw-ph{display:flex;align-items:center;gap:10px}
.sw-ph::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--a) 50%,transparent),transparent)}
/* focus: hero */
.sw-hero{display:grid;grid-template-columns:96px minmax(0,1fr);gap:16px;align-items:center;margin-top:12px}
.sw-herot{min-width:0}
.sw-por{position:relative;width:96px;height:104px;display:grid;place-items:center}
.sw-pring{position:absolute;inset:-2px;border-radius:50%;background:repeating-conic-gradient(var(--c) 0 7deg,transparent 7deg 12deg);filter:drop-shadow(0 0 6px var(--c));
 -webkit-mask:radial-gradient(circle,transparent 49px,var(--a) 50px 53px,transparent 54px);mask:radial-gradient(circle,transparent 49px,var(--a) 50px 53px,transparent 54px)}
.sw-page .sw-por[data-st=running] .sw-pring{animation:sw-rot 9s linear infinite}
.sw-por[data-st=completed] .sw-pring,.sw-por[data-st=failed] .sw-pring{background:var(--c)}
.sw-por[data-st=queued] .sw-pring,.sw-por[data-st=idle] .sw-pring,.sw-por[data-st=stopped] .sw-pring{opacity:.45}
.sw-phx{position:absolute;inset:8px 10px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 55%,var(--bg)),var(--bg) 80%)}
.sw-phx::after{content:"";position:absolute;inset:2px;clip-path:inherit;background:radial-gradient(circle at 50% 40%,color-mix(in srgb,var(--c) 22%,var(--bg)),var(--bg) 70%)}
.sw-por .sw-ic{width:34px;height:34px;filter:drop-shadow(0 0 8px var(--c))}
.sw-ptag{position:absolute;bottom:-6px;left:50%;z-index:2;transform:translateX(-50%);padding:1px 7px;font:700 11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;color:var(--ink);background:color-mix(in srgb,var(--c) 25%,var(--bg));box-shadow:inset 0 0 0 1px var(--c)}
.sw-verb{font:12px var(--mono);letter-spacing:.04em;color:color-mix(in srgb,var(--c) 70%,var(--ink));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page .sw-verb{animation:sw-type .6s steps(12,end)}
.sw-head{display:flex;align-items:baseline;min-width:0;margin:2px 0 4px;font-size:18px;font-weight:600;line-height:1.3}
.sw-headt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-head.is-file{font:700 22px/1.2 var(--mono);text-shadow:0 0 16px color-mix(in srgb,var(--c,var(--run)) 60%,transparent)}
.sw-head code{font-family:var(--mono)}
.sw-nowf{display:inline-block;animation:sw-slide .45s ease-out}
.sw-1l{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;font-size:12.5px;color:var(--dim)}
.sw-metat{flex:0 1 auto}
.sw-meta .sw-model{flex:none}
.sw-model{display:inline-block;max-width:100%;vertical-align:1px;font:11.5px var(--mono);padding:1px 7px;box-shadow:inset 0 0 0 1px var(--line);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page[data-theme=terminal] .sw-hero{grid-template-columns:64px minmax(0,1fr);gap:14px;margin-top:8px}
.sw-page[data-theme=terminal] .sw-por{width:58px;height:auto;display:flex;flex-direction:column;align-items:center;gap:2px}
.sw-pg{display:grid;place-items:center;width:58px;height:52px;font:22px/1 var(--mono);color:var(--c);border:1px solid currentColor;box-shadow:inset 0 0 12px color-mix(in srgb,var(--c) 45%,transparent)}
.sw-page[data-theme=terminal] .sw-ptag{position:static;transform:none;padding:0;background:none;box-shadow:none;font-weight:400;letter-spacing:0;color:var(--c)}
.sw-page[data-theme=terminal] .sw-verb{letter-spacing:.04em;color:var(--c)}
.sw-page[data-theme=terminal] .sw-head{font:400 13px/1.35 var(--mono);color:var(--tm-hi);text-shadow:none}
.sw-page[data-theme=terminal] .sw-head.is-file{font-size:16px}
/* focus: stat tiles */
@property --sw-n{syntax:"<integer>";inherits:false;initial-value:0}
.sw-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0 4px}
.sw-tile{--tc:var(--a);position:relative;min-width:0;padding:8px 10px 7px;background:color-mix(in srgb,var(--a) 6%,transparent)}
.sw-tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--tc);box-shadow:0 0 8px var(--tc)}
.sw-tile[data-tone=run]{--tc:var(--run)}
.sw-tile[data-tone=bad]{--tc:var(--bad)}
.sw-tile[data-tone=idle]{--tc:var(--idle)}
.sw-tn{position:relative;display:block;overflow:hidden;font:700 19px/1.15 var(--mono);white-space:nowrap;text-overflow:ellipsis}
.sw-tn>span{display:inline-block}
.sw-page .sw-tn:not([data-count])>span{animation:sw-up .5s ease-out}
.sw-tn[data-count]{counter-reset:sw-n var(--sw-n)}
.sw-tn[data-count]::before{content:counter(sw-n) / ""}
.sw-tn[data-count]>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.sw-page .sw-tn[data-count]{animation:sw-count .9s ease-out}
.sw-tl{display:block;font:11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page[data-theme=terminal] .sw-tiles{display:flex;flex-wrap:wrap;gap:4px 20px;margin:12px 0 2px}
.sw-page[data-theme=terminal] .sw-tile{display:flex;flex-direction:row-reverse;align-items:baseline;gap:6px;padding:0;background:none}
.sw-page[data-theme=terminal] .sw-tile::before{display:none}
.sw-page[data-theme=terminal] .sw-tn{font:600 12.5px/1.6 var(--mono);color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-tl{font-size:12.5px;letter-spacing:0;text-transform:lowercase}
/* focus: task, answer */
.sw-task{margin:12px 0 0;padding:8px 12px;font-size:13px;line-height:1.45;color:var(--dim);border-left:2px solid color-mix(in srgb,var(--a) 50%,transparent);overflow-wrap:anywhere;white-space:pre-line}
.sw-task b{color:var(--ink);font-weight:600}
.sw-page[data-theme=terminal] .sw-task{margin-top:8px;padding:0;border-left:0;font-size:12.5px}
.sw-page[data-theme=terminal] .sw-task b{font-weight:400;color:var(--dim);text-transform:lowercase}
.sw-ans{position:relative;margin-top:14px;padding:12px 14px 12px 16px;font-size:13.5px;line-height:1.55;
 background:linear-gradient(90deg,color-mix(in srgb,var(--c) 14%,var(--bg)),color-mix(in srgb,var(--c) 3%,var(--bg)))}
.sw-ans::before,.sw-ans::after{content:"";position:absolute;width:12px;height:12px;border:2px solid var(--c)}
.sw-ans::before{left:0;top:0;border-right:0;border-bottom:0}
.sw-ans::after{right:0;bottom:0;border-left:0;border-top:0}
.sw-page .sw-ans{animation:sw-reveal .7s ease-out}
.sw-ansh{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.sw-sig{display:inline-flex;gap:2px;align-items:flex-end;height:12px}
.sw-sig i{width:3px;height:4px;background:var(--c)}
.sw-sig i:nth-child(2){height:7px}
.sw-sig i:nth-child(3){height:10px}
.sw-sig i:nth-child(4){height:12px}
.sw-anst{white-space:pre-line;overflow-wrap:anywhere}
.sw-anst.is-folded{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--sw-lines);overflow:hidden}
.sw-ansm{display:inline-block;margin-top:6px}
.sw-page[data-theme=terminal] .sw-ans{margin-top:18px;padding:12px 12px 8px;font-size:12.5px;background:color-mix(in srgb,var(--c) 10%,var(--bg));border:1px solid var(--c)}
.sw-page[data-theme=terminal] .sw-ans::before,.sw-page[data-theme=terminal] .sw-ans::after,.sw-page[data-theme=terminal] .sw-sig{display:none}
.sw-page[data-theme=terminal] .sw-ansh{position:static;margin:0 0 6px;padding:0;background:none;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-ansh::before{content:">> "}
/* focus: files */
.sw-fsec{margin-top:16px}
.sw-fsec>.sw-k{margin-bottom:8px}
.sw-fh{display:flex;align-items:center;gap:14px;margin-bottom:8px}
.sw-leg{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim);white-space:nowrap}
.sw-leg::before{content:"";width:9px;height:9px;background:var(--a);transform:skewX(-20deg)}
.sw-fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:6px}
.sw-ft{--fc:var(--a);position:relative;display:flex;flex-direction:column;min-width:0;overflow:hidden;padding:8px 10px;font:12.5px var(--mono);
 background:linear-gradient(180deg,color-mix(in srgb,var(--fc) 16%,var(--bg)),color-mix(in srgb,var(--fc) 4%,var(--bg)));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--fc) 45%,transparent)}
.sw-page .sw-ft{animation:sw-in .35s ease-out both;animation-delay:calc(min(var(--i,0),12) * 55ms)}
.sw-ft:hover{box-shadow:inset 0 0 0 1px var(--fc)}
.sw-ft[data-op=failed]{--fc:var(--bad)}
.sw-ft[data-op=delete]{--fc:var(--idle)}
.sw-ft[data-op=read]{--fc:color-mix(in srgb,var(--a) 45%,var(--idle))}
.sw-ft.is-now{--fc:var(--run);box-shadow:inset 0 0 0 1px var(--run),0 0 14px color-mix(in srgb,var(--run) 40%,transparent)}
.sw-ft.is-now::after{content:"";position:absolute;top:0;bottom:0;left:-40%;width:40%;pointer-events:none;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--run) 28%,transparent),transparent)}
.sw-page .sw-ft.is-now::after{animation:sw-sweep 1.4s ease-in-out .3s both}
.sw-nowb{position:absolute;top:6px;right:8px;font:700 11.5px var(--mono);letter-spacing:.04em;color:color-mix(in srgb,var(--run) 75%,var(--ink))}
.sw-fn{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sw-ft.is-now .sw-fn{padding-right:36px}
.sw-ft .sw-fn{animation:none}
.sw-page .sw-ft.is-now .sw-fn{animation:sw-slide .45s ease-out}
.sw-ft[data-op=delete] .sw-fn{text-decoration:line-through;color:var(--dim)}
.sw-fd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11.5px var(--mono);color:var(--dim)}
.sw-pipr{display:flex;align-items:center;gap:8px;min-width:0;margin-top:6px}
.sw-pips{display:flex;flex:none;gap:3px}
.sw-pips i{width:8px;height:8px;background:color-mix(in srgb,var(--fc) 18%,transparent);transform:skewX(-20deg)}
.sw-pips i.on{background:var(--fc);box-shadow:0 0 6px var(--fc)}
.sw-fl{min-width:0;margin-left:auto;text-align:right;font:11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-ft[data-op=failed] .sw-fl{color:color-mix(in srgb,var(--bad) 55%,var(--ink))}
.sw-page[data-theme=terminal] .sw-fsec{position:relative;margin-top:18px;padding:12px 10px 8px;border:1px solid var(--line)}
.sw-page[data-theme=terminal] .sw-fsec>.sw-k,.sw-page[data-theme=terminal] .sw-fh{position:static;margin:0 0 6px;padding:0;background:none}
.sw-page[data-theme=terminal] .sw-fsec[data-sec=none]>.sw-k{position:static;padding:0}
.sw-page[data-theme=terminal] .sw-fsec[data-sec=none]{border:0;padding:0}
.sw-page[data-theme=terminal] .sw-fh{gap:0}
.sw-page[data-theme=terminal] .sw-leg{margin:0;font-size:12.5px}
/* the dot separates the heading from its legend, so a heading with no legend ends clean */
.sw-page[data-theme=terminal] .sw-leg{gap:0}
.sw-page[data-theme=terminal] .sw-leg::before{content:"·";width:auto;height:auto;margin:0 .7ch;background:none;transform:none;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-fgrid{display:block}
.sw-page[data-theme=terminal] .sw-fl{margin-left:0;text-align:left}
.sw-flist{display:contents}
/* Terminal: one grid for all file lists; each list and row borrows its columns (subgrid). Columns are
   as wide as their longest entry (a long name or folder is cut at 32 / 24 characters), the spare width
   goes to the end — no gap in the middle of a row. */
.sw-page[data-theme=terminal] .sw-flist{display:grid;grid-template-columns:14px fit-content(32ch) minmax(8ch,1fr) 64px max-content max-content;column-gap:14px}
/* a folder is cut at its start: the end of a path names the folder */
.sw-page .sw-fd{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left}
.sw-page .sw-fd bdi{direction:ltr;unicode-bidi:isolate}
.sw-page[data-theme=terminal] .sw-flist>.sw-fsec{grid-column:1/-1;display:grid;grid-template-columns:subgrid;column-gap:normal;align-content:start}
.sw-page[data-theme=terminal] .sw-flist>.sw-fsec>*{grid-column:1/-1}
.sw-page[data-theme=terminal] .sw-flist .sw-fgrid{display:grid;grid-template-columns:subgrid;column-gap:normal;row-gap:0}
.sw-page[data-theme=terminal] .sw-flist>.sw-fsec>.sw-more{grid-column:2/-1;margin-left:0}
.sw-page[data-theme=terminal] .sw-ft{display:grid;width:100%;grid-column:1/-1;grid-template-columns:subgrid;column-gap:normal;align-items:center;min-height:20px;padding:0 4px;background:none;box-shadow:none}
.sw-page[data-theme=terminal] .sw-ft:hover{background:color-mix(in srgb,var(--a) 10%,transparent)}
.sw-page[data-theme=terminal] .sw-ft::before{content:"";grid-column:1;grid-row:1}
.sw-page[data-theme=terminal] .sw-ft.is-now{background:color-mix(in srgb,var(--run) 12%,transparent);box-shadow:none}
.sw-page[data-theme=terminal] .sw-ft.is-now::before{content:"▶\\FE0E";color:var(--run)}
.sw-page[data-theme=terminal] .sw-pipr{display:contents}
.sw-page[data-theme=terminal] .sw-fn{grid-column:2;grid-row:1;padding:0;font-weight:400}
.sw-page[data-theme=terminal] .sw-fd{grid-column:3;grid-row:1}
.sw-page[data-theme=terminal] .sw-pips{grid-column:4;grid-row:1;gap:1px}
.sw-page[data-theme=terminal] .sw-pips i{width:7px;height:12px;transform:none;background:color-mix(in srgb,var(--fc) 22%,transparent)}
.sw-page[data-theme=terminal] .sw-pips i.on{background:var(--fc);box-shadow:none}
.sw-page[data-theme=terminal] .sw-fl{grid-column:5;grid-row:1;letter-spacing:0;text-transform:lowercase;font-size:12px}
.sw-page[data-theme=terminal] .sw-nowb{grid-column:6;grid-row:1;position:static;letter-spacing:0;font-weight:600}
.sw-fnote{margin:6px 0 0;font-size:12px;color:var(--dim)}
.sw-note{margin:12px 0 0;font-size:12px;line-height:1.45;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-note::before{content:"# "}
.sw-btns{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
/* commands */
.sw-why{margin:0 0 12px;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-why::before{content:"# "}
.sw-cmc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit}
.sw-cmx{flex:none;font-size:11.5px;letter-spacing:.04em;color:var(--dim);white-space:nowrap}
.sw-page .sw-spin{display:inline-block;width:11px;height:11px;flex:none;border-radius:50%;border:2px solid var(--run);border-right-color:transparent;animation:sw-rot 1s linear infinite;vertical-align:-1px;margin-right:6px}
.sw-exit{display:grid;place-items:center;align-content:center;gap:2px;width:72px;height:80px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 50%,var(--bg)),var(--bg))}
.sw-exit b{font:700 24px/1 var(--mono);color:var(--ink);text-shadow:0 0 12px var(--c)}
.sw-exit span{font:11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
.sw-radar{display:block;width:46px;height:46px;margin:4px auto 0;border-radius:50%;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--run) 50%,transparent);
 background:conic-gradient(from 40deg,color-mix(in srgb,var(--run) 60%,transparent),transparent 25%),radial-gradient(circle,transparent 60%,color-mix(in srgb,var(--run) 40%,transparent) 61% 63%,transparent 64%)}
.sw-page .sw-radar{animation:sw-rot 2.4s linear infinite}
.sw-cmnote{margin:8px 0 0;color:var(--dim)}
.sw-crt{position:relative;margin-top:8px;overflow:hidden;font:12px/1.6 var(--mono);background:color-mix(in srgb,var(--a) 3%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 25%,transparent)}
.sw-crt::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,color-mix(in srgb,var(--bg) 45%,transparent) 0 1px,transparent 1px 3px)}
.sw-crth{display:flex;justify-content:space-between;gap:10px;padding:4px 10px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);border-bottom:1px solid color-mix(in srgb,var(--a) 18%,transparent)}
.sw-out{margin:0;padding:4px 0;max-height:260px;overflow:auto;font:12px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.sw-ol{display:grid;grid-template-columns:34px minmax(0,1fr);padding-right:10px}
.sw-ol::before{content:attr(data-n);padding-right:10px;text-align:right;color:var(--dim)}
.sw-ol.is-bad{color:color-mix(in srgb,var(--bad) 25%,var(--ink));background:color-mix(in srgb,var(--bad) 18%,var(--bg))}
.sw-scan{height:46px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--a) 25%,transparent) 50%,transparent) 0 0/40% 100% no-repeat,repeating-linear-gradient(0deg,color-mix(in srgb,var(--a) 8%,transparent) 0 2px,transparent 2px 8px)}
.sw-page .sw-scan{animation:sw-scan 1.6s linear infinite}
.sw-crt[data-state=lost]{display:flex;align-items:center;gap:12px;padding:12px}
.sw-crt[data-state=lost] p{margin:0;color:var(--ink);overflow-wrap:anywhere}
.sw-nosig{flex:none;font:700 12px var(--mono);letter-spacing:.04em;color:color-mix(in srgb,var(--bad) 65%,var(--ink))}
.sw-page .sw-nosig{animation:sw-pulse 1.6s ease-in-out infinite}
.sw-cmerr .sw-btns{margin-top:10px}
.sw-quiet{margin:0;padding:14px;text-align:center;font:12px var(--mono);letter-spacing:.04em;color:var(--dim)}
.sw-pu{margin:8px 0 0;color:var(--dim)}
.sw-pu::before{content:"⚠\\FE0E  ";color:var(--run)}
.sw-page[data-theme=terminal] .sw-exit{width:auto;height:auto;padding:4px 12px;clip-path:none;background:none;border:1px solid currentColor;color:color-mix(in srgb,var(--c) 80%,var(--ink));line-height:1.1}
.sw-page[data-theme=terminal] .sw-exit b{font-size:15px;color:inherit;text-shadow:none}
.sw-page[data-theme=terminal] .sw-exit span{color:inherit;letter-spacing:0}
.sw-page[data-theme=terminal] .sw-radar{width:auto;height:auto;margin:0;border-radius:0;background:none;box-shadow:none;font:20px/1 var(--mono);color:var(--run)}
.sw-page[data-theme=terminal] .sw-radar::before{content:"◜"}
.sw-page[data-theme=terminal] .sw-crt{grid-column:1/-1;margin-top:16px;overflow:visible;background:none;box-shadow:none;border:1px solid var(--line)}
.sw-page[data-theme=terminal] .sw-crt::after{display:none}
.sw-page[data-theme=terminal] .sw-crth{position:static;padding:0 0 6px;border:0;background:none;font-size:11.5px}
.sw-page[data-theme=terminal] .sw-crt[data-state=output]{padding-top:6px}
.sw-page[data-theme=terminal] .sw-ol::before{text-align:left;padding-left:8px}
.sw-page[data-theme=terminal] .sw-scan{height:8px;margin:14px 10px 10px;background:linear-gradient(90deg,var(--a),var(--a)) 0 0/14% 100% no-repeat,repeating-linear-gradient(90deg,var(--line) 0 6px,transparent 6px 8px)}
.sw-page[data-theme=terminal] .sw-crt[data-state=lost]{padding:8px 10px}
.sw-page[data-theme=terminal] .sw-nosig{letter-spacing:.04em}
.sw-page[data-theme=terminal] .sw-quiet{padding:8px;letter-spacing:.04em}
/* commands: HUD */
.sw-cmds{display:flex;flex-direction:column;gap:12px;min-width:0}
.sw-cmds .sw-why,.sw-cmds>.sw-pu,.sw-cmds>.sw-cmnote,.sw-cmds>.sw-empty{margin:0}
.sw-cmgrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;min-width:0}
.sw-hp[data-span="4"]{grid-column:span 4}
.sw-cmcon .sw-hgrid{min-height:150px}
.sw-cmorb:has(.sw-orbit:not(.has-scene)),.sw-rworm:has(.sw-orbit:not(.has-scene)){display:none}
.sw-cmcon .sw-hgrid>.sw-crt,.sw-cmcon .sw-hgrid>.sw-cmerr,.sw-cmcon .sw-hgrid>.sw-cmnote{position:relative;z-index:1;margin:0 196px 0 0}
.sw-page[data-theme=terminal] .sw-cmcon .sw-crt{margin-top:0;padding:8px 0;border:0;background:none}
.sw-page[data-theme=terminal] .sw-cmcon .sw-crt[data-state=lost]{padding:10px 8px}
.sw-page[data-theme=terminal] .sw-cmcon .sw-crth{position:static;padding:0 8px 6px;border:0;background:none}
.sw-cmcon .sw-hgrid>.sw-cmnote{padding:10px 8px}
.sw-cmcon .sw-cmerr .sw-btns{margin:0 0 10px 8px}
.sw-cmcon .sw-out{max-height:260px;scrollbar-width:thin;scrollbar-color:var(--hud-line2,var(--line)) transparent}
.sw-cmcon .sw-ol{color:var(--ink)}
.sw-cmcon .sw-ol.is-bad{color:var(--tm-hi,var(--ink));background:color-mix(in srgb,var(--bad) 7%,transparent);box-shadow:inset 2px 0 0 var(--bad)}
.sw-page .sw-cop.is-run .sw-copb i.on{animation:sw-pulse 1.6s ease-in-out infinite}
.sw-cml{display:grid;grid-template-columns:max-content max-content minmax(0,1fr) max-content;align-content:start;max-height:176px;overflow:hidden auto;scrollbar-width:thin;scrollbar-color:var(--hud-line2,var(--line)) transparent}
.sw-cmrow{display:grid;grid-column:1/-1;grid-template-columns:subgrid;column-gap:14px;align-items:center;padding:2px 6px;white-space:nowrap}
.sw-cmrow>*{grid-row:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sw-cmlt{color:var(--dim)}
.sw-cmls{display:inline-flex;align-items:center;gap:7px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink)}
.sw-cmls::before{content:"";flex:none;width:6px;height:6px;background:var(--c)}
.sw-cmrow .sw-cmc{color:var(--ink)}
.sw-cmrow .sw-cmx{font-size:inherit;letter-spacing:0;text-align:right}
.sw-cmrow:hover{background:color-mix(in srgb,var(--a) 6%,transparent)}
.sw-cmrow[aria-pressed=true]{background:var(--hud-pick,var(--raised));box-shadow:inset 2px 0 0 var(--c,var(--a))}
.sw-cmrow[aria-pressed=true]>*{color:var(--tm-hi,var(--ink))}
.sw-cmcard .sw-kv>dd{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sw-cmkv{color:var(--ink)}
.sw-page[data-theme=terminal] .sw-cmcard .sw-exit{display:inline-flex;align-items:center;gap:7px;padding:0;border:0;color:var(--ink);line-height:inherit}
.sw-page[data-theme=terminal] .sw-cmcard .sw-exit::before{content:"";flex:none;width:6px;height:6px;background:var(--c)}
.sw-page[data-theme=terminal] .sw-cmcard .sw-exit b{font:inherit;color:var(--tm-hi,var(--ink));text-shadow:none}
.sw-page[data-theme=terminal] .sw-cmcard .sw-exit span{font-size:11.5px;color:var(--dim)}
.sw-cmcard .sw-exit:not([data-st=stopped]) span{display:none}
.sw-page[data-theme=terminal] .sw-cmcard .sw-radar{display:inline-block;width:11px;height:11px;border:1.5px solid color-mix(in srgb,var(--run) 30%,transparent);border-top-color:var(--run);border-radius:50%;vertical-align:-1px}
.sw-page[data-theme=terminal] .sw-cmcard .sw-radar::before{content:none}
.sw-cmcut{margin:8px 0 0;font-size:11.5px;color:var(--dim)}
.sw-cmfoot{gap:6px 16px;margin-top:12px}
.sw-page[data-theme=terminal] .sw-cmfoot .sw-ib.is-text{padding:2px 0;gap:6px;color:var(--dim);background:none;box-shadow:none}
.sw-page[data-theme=terminal] .sw-cmfoot .sw-ib.is-text .sw-ibi{display:inline-flex;width:12px;height:12px;color:var(--a)}
.sw-page[data-theme=terminal] .sw-cmfoot .sw-ib.is-text:hover{color:var(--tm-hi,var(--ink))}
@container (max-width:540px){
 .sw-cmcon .sw-hgrid>.sw-crt,.sw-cmcon .sw-hgrid>.sw-cmerr,.sw-cmcon .sw-hgrid>.sw-cmnote{margin-right:0}
 .sw-cmls>span,.sw-cmxe{display:none}
}
/* toast */
.sw-live{position:absolute;right:20px;top:92px;z-index:10;pointer-events:none}
.sw-toast{width:max-content;max-width:min(360px,calc(100cqw - 40px));display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere;padding:8px 10px;font-size:12.5px;background:var(--raised);color:var(--ink);box-shadow:0 8px 24px color-mix(in srgb,var(--bg) 60%,transparent),inset 0 0 0 1px var(--a)}
.sw-toast.is-bad{box-shadow:0 8px 24px color-mix(in srgb,var(--bg) 60%,transparent),inset 0 0 0 1px var(--bad)}
/* narrow: docked beside the chat */
@container (max-width:460px){
 .sw-panel .sw-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
 .sw-panel .sw-hero{grid-template-columns:76px minmax(0,1fr);gap:12px}
 .sw-panel .sw-por{transform:scale(.8);transform-origin:0 50%}
 .sw-panel .sw-head.is-file{font-size:18px}
 .sw-panel .sw-cbody{grid-template-columns:60px minmax(0,1fr);gap:10px}
 .sw-panel .sw-exit{width:56px;height:64px}
 .sw-panel .sw-big{font-size:30px}
 .sw-panel .sw-tabs{gap:14px}
 .sw-panel .sw-hd{flex-wrap:wrap;row-gap:6px}
}
/* narrow Terminal file rows keep the name, thinner blocks and the label on the shared columns; the folder
   and the NOW badge give way (the row sits under "working on now" and keeps its ▶) */
@container (max-width:460px){.sw-page[data-theme=terminal] .sw-panel .sw-flist{grid-template-columns:14px fit-content(22ch) 0 39px max-content 0 1fr;column-gap:6px}
 .sw-page[data-theme=terminal] .sw-panel .sw-fd,.sw-page[data-theme=terminal] .sw-panel .sw-nowb{display:none}
 .sw-page[data-theme=terminal] .sw-panel .sw-pips i{width:4px}
 .sw-page[data-theme=terminal] .sw-panel .sw-por{transform:none}
 .sw-page[data-theme=terminal] .sw-panel .sw-hero{grid-template-columns:64px minmax(0,1fr)}}
/* calm: an earlier run is history, not live — no glow, nothing moves */
.sw-panel[data-calm] *,.sw-panel[data-calm] *::before,.sw-panel[data-calm] *::after{animation:none!important}
.sw-panel[data-calm] .sw-ic{filter:none}
.sw-panel[data-calm] .sw-big{text-shadow:none}
/* motion */
@keyframes sw-rot{to{transform:rotate(360deg)}}
@keyframes sw-shake{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@keyframes sw-up{from{transform:translateY(60%);opacity:0}}
@keyframes sw-slide{from{transform:translateX(-10px);opacity:0}}
@keyframes sw-type{from{clip-path:inset(0 100% 0 0)}}
@keyframes sw-blink{50%{opacity:0}}
@keyframes sw-pulse{50%{opacity:.45}}
@keyframes sw-skp{50%{opacity:.5}}
@keyframes sw-count{from{--sw-n:0}}
@keyframes sw-in{from{opacity:0;transform:translateY(6px)}}
@keyframes sw-sweep{from{left:-40%}to{left:100%}}
@keyframes sw-reveal{from{clip-path:inset(0 0 100% 0)}}
@keyframes sw-scan{from{background-position:-70% 0,0 0}to{background-position:170% 0,0 0}}
/* agents: HUD */
/* the fleet schematic over a faint grid, then time per agent, spent, files, the agent, the log; status colour rides the marks */
.sw-agrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;min-width:0}
.sw-page[data-theme=terminal] .sw-agents .sw-runb{margin-bottom:8px;padding:7px 12px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line)}
.sw-page[data-theme=terminal] .sw-agents .sw-pick{text-transform:uppercase;letter-spacing:.04em;color:var(--tm-hi)!important}
.sw-page[data-theme=terminal] .sw-agents .sw-pick::before{color:var(--dim);letter-spacing:.04em}
.sw-page[data-theme=terminal] .sw-agents .sw-back{text-transform:uppercase;letter-spacing:.04em}
.sw-hnote{margin:0;color:var(--dim)}
/* the orbit: an isometric station; its core is the main agent, each wing a subagent. Lines and labels
   share the drawing's box (percentages of 666 × 360), so they meet at any width. Status colour rides the
   cells, frames and marks; the words stay grey */
.sw-orbit{position:relative;aspect-ratio:666/360;min-height:0;overflow:hidden;
 --orw:color-mix(in srgb,var(--ui-text-primary) 58%,transparent);--orw2:color-mix(in srgb,var(--ui-text-primary) 30%,transparent)}
.sw-ors{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sw-orw1{fill:none;stroke:var(--orw);stroke-width:.8;stroke-linejoin:round}
.sw-orw2{fill:none;stroke:var(--orw2);stroke-width:.6}
.sw-orcore{fill:color-mix(in srgb,var(--raised) 75%,transparent)}
.sw-orc{fill:transparent;stroke:var(--orw2);stroke-width:.5}
.sw-orc[data-k=completed]{fill:color-mix(in srgb,var(--ok) 34%,transparent);stroke:color-mix(in srgb,var(--ok) 70%,transparent)}
.sw-orc[data-k=failed]{fill:color-mix(in srgb,var(--bad) 30%,transparent);stroke:color-mix(in srgb,var(--bad) 75%,transparent)}
.sw-orc[data-k=running]{fill:color-mix(in srgb,var(--run) 12%,transparent);stroke:color-mix(in srgb,var(--run) 40%,transparent)}
.sw-orc[data-k=queued]{stroke:var(--orw);stroke-dasharray:2 2}
.sw-orc[data-k=stopped]{stroke:var(--orw)}
.sw-orc[data-k=none]{stroke:transparent}
.sw-orf{fill:none;stroke:var(--orw);stroke-width:.9}
.sw-orw[data-st=queued] .sw-orf{stroke:var(--orw2);stroke-dasharray:3 3}
.sw-orw[data-st=group] .sw-orf{stroke:var(--orw2);stroke-dasharray:1 3}
.sw-orw[data-st=failed] .sw-orf{stroke:color-mix(in srgb,var(--bad) 80%,transparent)}
.sw-orw.is-sel .sw-orf{stroke:var(--a);stroke-width:1.4}
.sw-orlead{fill:none;stroke:var(--orw);stroke-width:.7}
.sw-orpin{fill:var(--raised);stroke:var(--ink);stroke-width:1}
.sw-orbox{fill:var(--raised);stroke:var(--ink);stroke-width:.9}
.sw-orbox.is-sel{stroke:var(--a);stroke-width:1.4}
.sw-orl,.sw-ormain{position:absolute;z-index:1;min-width:0;padding:0!important}
.sw-orl{display:flex;flex-direction:column;align-items:flex-start;gap:7px;margin-top:-17px}
.sw-orl[data-side=r]{align-items:flex-end;text-align:right!important}
.sw-orn{display:block;max-width:100%;height:14px;line-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.sw-orv{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:15px;padding:0 6px;overflow:hidden;white-space:nowrap;color:var(--ink);
 background:color-mix(in srgb,var(--c,var(--idle)) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c,var(--idle)) 50%,transparent)}
.sw-orl:not(.is-grp)>.sw-orv::before,.sw-orm::before{content:"";flex:none;width:5px;height:5px;background:var(--c)}
.sw-orl.is-grp>.sw-orv{gap:10px;--c:var(--idle)}
.sw-orm{display:inline-flex;align-items:center;gap:5px}
.sw-orm[data-st=queued]::before{background:none;box-shadow:inset 0 0 0 1px var(--c)}
.sw-orl:hover .sw-orn,.sw-ormain:hover .sw-orn,.sw-orl.is-sel .sw-orn{color:var(--tm-hi,var(--ink))}
.sw-orl.is-sel>.sw-orv{box-shadow:inset 0 0 0 1px var(--a)}
.sw-ormain{display:flex;flex-direction:column;gap:5px}
.sw-ormain>.sw-orn{height:18px;line-height:18px;padding:0 14px 0 8px;color:var(--tm-hi,var(--ink))}
.sw-orp{display:flex;align-items:center;gap:6px}
.sw-orp>b{padding:0 4px;line-height:13px;font-weight:inherit;color:var(--tm-hi,var(--ink));background:color-mix(in srgb,var(--a) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 50%,transparent)}
.sw-orbars{display:flex;gap:2px}
.sw-orbars i{width:3px;height:9px;background:color-mix(in srgb,var(--a) 22%,transparent)}
.sw-orbars i.on{background:var(--a)}
.sw-orscan{position:absolute;top:0;bottom:0;left:0;width:24%;pointer-events:none;
 background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--a) 6%,transparent),transparent);animation:sw-orscan 5.5s linear infinite}
.sw-orkey{position:absolute;right:12px;bottom:8px;display:flex;gap:12px;color:var(--dim);white-space:nowrap}
.sw-orkey span{display:inline-flex;align-items:center;gap:5px}
.sw-orkey span::before{content:"";width:7px;height:7px;background:color-mix(in srgb,var(--c) 45%,transparent);box-shadow:inset 0 0 0 1px var(--c)}
.sw-orkey [data-st=queued]::before{background:none;box-shadow:none;outline:1px dashed var(--c);outline-offset:-1px}
.sw-orbit .sw-nosub{position:absolute;left:14px;bottom:8px;max-width:48%;margin:0;color:var(--dim)}
/* a working wing: an amber head runs along its cells; a done wing fills left to right, then its frame
   flashes; a failed wing shakes once */
@keyframes sw-orrun{0%{fill:color-mix(in srgb,var(--run) 62%,transparent);stroke:var(--run)}35%,100%{fill:color-mix(in srgb,var(--run) 12%,transparent);stroke:color-mix(in srgb,var(--run) 40%,transparent)}}
@keyframes sw-orfill{from{fill:transparent;stroke:var(--orw2)}}
@keyframes sw-orhot{to{stroke:var(--a);stroke-width:1.8}}
@keyframes sw-orscan{from{transform:translateX(-100%)}to{transform:translateX(420%)}}
.sw-orc[data-k=running]{animation:sw-orrun 1.6s linear infinite;animation-delay:calc(var(--i) * .2s - 1.6s)}
.sw-orw.is-done .sw-orc[data-k=completed]{animation:sw-orfill .7s steps(1,end) backwards;animation-delay:calc(var(--i) * .07s)}
.sw-orw.is-done .sw-orf{animation:sw-orhot .3s ease-out .6s 2 alternate}
.sw-orw.is-fail{animation:sw-shake .5s ease-in-out}
.sw-hspent .sw-spent{margin-bottom:12px}
.sw-page[data-theme=terminal] .sw-score .sw-money{display:inline;font:250 28px/1 var(--mono);letter-spacing:-.03em;color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-score .sw-big{font:400 12.5px/1 var(--mono);text-shadow:none;color:var(--tm-hi);overflow:visible;letter-spacing:0}
.sw-page[data-theme=terminal] .sw-score .sw-big small{font-size:12.5px;color:var(--dim)}
.sw-hspent .sw-score{display:block}
.sw-page[data-theme=terminal] .sw-score .sw-seg{gap:2px;height:5px;margin:6px 0 4px}
.sw-score .sw-seg i{max-width:none}
.sw-sdone .sw-big{margin-left:auto}
.sw-sdone{margin-top:14px}
.sw-tlist{max-height:340px;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--hud-node) transparent}
.sw-htime .sw-tkh .sw-tkn{flex:0 1 auto;letter-spacing:.02em;color:var(--ink)}
.sw-htime .sw-tkh b{flex:none}
.sw-hfiles .sw-hrow{font-size:12.5px;letter-spacing:.04em}
.sw-fcells{display:grid;grid-template-columns:repeat(auto-fill,minmax(18px,1fr));gap:4px;margin:12px 0 10px}
.sw-fcells[data-big]{grid-template-columns:repeat(auto-fill,minmax(30px,1fr))}
.sw-fcells>i{height:18px;background:var(--hud-teal-d);box-shadow:inset 0 0 0 1px var(--hud-teal)}
.sw-fcells[data-big]>i{height:30px}
.sw-fcells>i[data-k=changed]{background:color-mix(in srgb,var(--a) 62%,var(--raised));box-shadow:none}
.sw-fcells>i[data-k=failed]{background:color-mix(in srgb,var(--bad) 80%,var(--raised));box-shadow:none}
.sw-fmore{grid-column:span 2;align-self:center;font-size:11.5px;color:var(--dim)}
.sw-fleg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;letter-spacing:.04em;color:var(--dim)}
.sw-fleg>span{display:inline-flex;align-items:center;gap:6px}
.sw-fleg>span::before{content:"";width:7px;height:7px;background:var(--hud-teal)}
.sw-fleg>[data-k=changed]::before{background:var(--a)}
.sw-fleg>[data-k=failed]::before{background:var(--bad)}
.sw-hagent .sw-rfile{margin:-2px 0 12px}
.sw-hlog.sw-alog{grid-template-columns:max-content fit-content(18ch) minmax(0,1fr)}
.sw-alog .sw-hle{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-alog .sw-hle::before{display:inline-block;margin:0 7px 2px 0;vertical-align:middle}
.sw-alog>button[aria-pressed=true]{background:var(--hud-pick);box-shadow:inset 2px 0 0 var(--c,var(--a))}
.sw-alog>button[aria-pressed=true]>*{color:var(--tm-hi,var(--ink))}
.sw-page[data-theme=terminal] .sw-hdetail .sw-focus{margin-top:0;padding:0;border:0;background:none}
.sw-page[data-theme=terminal] .sw-hdetail .sw-por{width:42px}
/* DETAIL says each thing once: the panel title names the agent, so the focus label above the hero goes */
.sw-page[data-theme=terminal] .sw-hdetail .sw-ph{display:none}
.sw-page[data-theme=terminal] .sw-hdetail .sw-fsec{margin-top:12px}
/* on the NOW row's amber wash grey would fall under 4.5:1, so its folder and verb read in ink */
.sw-page[data-theme=terminal] .sw-hdetail .sw-ft.is-now :is(.sw-fd,.sw-fl){color:var(--ink)}
.sw-page[data-theme=terminal] .sw-hdetail .sw-pg{width:42px;height:38px;font-size:16px;box-shadow:none}
.sw-page[data-theme=terminal] .sw-hdetail .sw-head.is-file{font-size:13px}
/* inside DETAIL the file sections read like the HUD's own panels: a caps grey heading over a hairline,
   not the boxed sections with a title cut into the frame */
.sw-page[data-theme=terminal] .sw-hdetail .sw-fsec{padding:8px 0 0;border:0;border-top:1px solid var(--hud-line2)}
.sw-page[data-theme=terminal] .sw-hdetail .sw-fsec>.sw-k,.sw-page[data-theme=terminal] .sw-hdetail .sw-fh{position:static;margin:0 0 6px;padding:0;background:none}
@container (max-width:540px){
 .sw-hlog.sw-alog{grid-template-columns:max-content fit-content(12ch) minmax(0,1fr)}
 /* narrow: the station stays, its callouts drop under it as a list */
 .sw-orbit{aspect-ratio:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:8px}
 .sw-ors{position:relative;inset:auto;height:auto;aspect-ratio:666/360}
 .sw-orlead,.sw-orpin,.sw-orbox,.sw-orkey{display:none}
 .sw-orl,.sw-ormain,.sw-orbit .sw-nosub{position:static;width:auto!important;max-width:none;margin:0 8px;align-items:flex-start;text-align:left!important}
 .sw-orl{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
 .sw-ormain{order:-1}
}
/* replay: a HUD — a six-column grid of hairline panels, caps titles, one accent; status colour rides the marks */
.sw-replay{display:flex;flex-direction:column;gap:12px;min-width:0}
.sw-replay .sw-why{margin:0}
.sw-rgrid,.sw-rplay{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;min-width:0}
.sw-rplay,.sw-rgrid>.sw-pu{grid-column:1/-1}
.sw-rgrid>.sw-pu{margin:0}
.sw-hp{position:relative;grid-column:span 6;min-width:0;padding:11px 12px 13px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line)}
.sw-hp[data-span="3"]{grid-column:span 3}
.sw-hp[data-span="2"]{grid-column:span 2}
.sw-hph{display:flex;align-items:center;gap:10px;min-width:0;min-height:18px;margin-bottom:12px}
.sw-hpt{margin:0;min-width:0;font:400 11.5px var(--mono);letter-spacing:.04em;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-hpn{letter-spacing:.02em;color:var(--ink)}
.sw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.sw-hchip{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:1px 7px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink);
 background:color-mix(in srgb,var(--c) 9%,var(--raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 32%,var(--raised))}
.sw-hchip::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--c);box-shadow:0 0 6px var(--c)}
.sw-tk{margin-bottom:14px}
.sw-tk:last-child{margin-bottom:0}
.sw-tkh{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;letter-spacing:.04em;color:var(--dim);white-space:nowrap}
.sw-tkh b{font-weight:400;color:var(--ink);letter-spacing:0}
.sw-tkb{position:relative;height:5px;margin:6px 0 4px;background:var(--hud-track,var(--line))}
.sw-tkb>i{position:absolute;left:0;top:0;bottom:0;--k:var(--c,var(--a));background:linear-gradient(90deg,color-mix(in srgb,var(--k) 8%,var(--raised)),color-mix(in srgb,var(--k) 34%,var(--raised)))}
.sw-tkb>i::after{content:"";position:absolute;right:-1px;top:-2px;bottom:-2px;width:2px;background:var(--k);box-shadow:0 0 6px var(--k)}
.sw-tks{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim)}
.sw-hbig{display:flex;align-items:baseline;gap:6px;font-size:28px;line-height:1;font-weight:250;letter-spacing:-.03em;color:var(--tm-hi,var(--ink))}
.sw-hbig small{font-size:11.5px;font-weight:400;letter-spacing:0;color:var(--dim)}
.sw-ch{display:block;width:100%;height:92px;margin-top:8px}
.sw-chg{stroke:var(--hud-grid,var(--line));stroke-width:1;vector-effect:non-scaling-stroke}
.sw-chs0{stop-color:color-mix(in srgb,var(--a) 50%,var(--raised));stop-opacity:.55}
.sw-chs1{stop-color:color-mix(in srgb,var(--a) 50%,var(--raised));stop-opacity:0}
.sw-cha{fill:url(#sw-chfill)}
.sw-chl{fill:none;stroke:var(--a);stroke-width:1.4;vector-effect:non-scaling-stroke}
.sw-chm{stroke:var(--hud-teal-b,var(--line));stroke-width:1;stroke-dasharray:2 2;vector-effect:non-scaling-stroke}
.sw-chd{fill:var(--a);stroke:var(--raised);stroke-width:2;vector-effect:non-scaling-stroke}
.sw-chx{fill:var(--bad)}
.sw-chax{display:flex;justify-content:space-between;margin-top:4px;font-size:11.5px;color:var(--dim)}
.sw-hrow{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--tm-hi,var(--ink));white-space:nowrap}
.sw-hrow b{font-weight:400}
.sw-rmarks{display:flex;gap:3px;height:30px;margin-top:10px;overflow:hidden}
.sw-rmarks>span{display:flex;flex:1 1 0;min-width:3px}
.sw-rmarks>span>*{display:flex;flex:1 1 auto;min-width:0}
.sw-rmark{flex:1 1 auto;min-width:0;background:var(--hud-teal-d,var(--line));box-shadow:inset 0 0 0 1px var(--hud-teal,var(--line))}
.sw-rmark[data-at=past]{background:color-mix(in srgb,var(--a) 70%,var(--raised));box-shadow:none}
.sw-rmark[data-at=next][data-failed=true]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bad) 60%,var(--raised))}
.sw-rmark[data-at=past][data-failed=true]{background:color-mix(in srgb,var(--bad) 75%,var(--raised))}
.sw-rmark[data-at=now]{background:var(--a);box-shadow:0 0 10px color-mix(in srgb,var(--a) 60%,transparent)}
.sw-rmark[data-at=now][data-failed=true]{background:var(--bad);box-shadow:0 0 10px color-mix(in srgb,var(--bad) 60%,transparent)}
.sw-rmark:hover{box-shadow:inset 0 0 0 1px var(--tm-hi,var(--ink))}
.sw-rbar .sw-btns{gap:6px 10px;margin-top:12px}
.sw-hgrid{position:relative;min-height:190px;background-image:linear-gradient(var(--hud-grid,var(--line)) 1px,transparent 1px),linear-gradient(90deg,var(--hud-grid,var(--line)) 1px,transparent 1px);background-size:28px 28px;background-position:-1px -1px}
.sw-hpx{background:var(--hud-hero,var(--raised))}
.sw-wires{position:absolute;inset:0;z-index:2;width:100%;height:100%;overflow:visible;pointer-events:none}
.sw-wires path{fill:none;stroke:var(--hud-wire,var(--dim));stroke-width:1}
.sw-wires circle{fill:var(--hud-frame,var(--ink))}
.sw-hgrid>.sw-rdiff,.sw-hgrid>.sw-cmnote{position:relative;z-index:1;margin-right:196px}
.sw-rhero.sw-hgrid>.sw-rdiff{margin-right:0}
.sw-cos{position:absolute;top:10px;right:12px;z-index:3;display:flex;flex-direction:column;align-items:flex-start;gap:20px;width:170px}
.sw-co{display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:100%;white-space:nowrap}
.sw-col{max-width:100%;overflow:hidden;text-overflow:ellipsis;padding:3px 9px;font-size:11.5px;letter-spacing:.04em;color:var(--tm-hi,var(--ink));background:var(--hud-hero,var(--raised));box-shadow:inset 0 0 0 1px var(--hud-frame,var(--ink))}
.sw-cov{padding:0 6px;font-size:11.5px;color:var(--ink);background:color-mix(in srgb,var(--c) 10%,var(--hud-hero,var(--raised)));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 40%,var(--hud-hero,var(--raised)))}
.sw-cop{display:flex;align-items:center;gap:7px;font-size:11.5px}
.sw-copn{padding:0 5px;color:var(--a);background:var(--hud-teal-d,var(--raised));box-shadow:inset 0 0 0 1px var(--hud-teal-b,var(--line))}
.sw-copb{display:flex;gap:2px}
.sw-copb i{width:3px;height:10px;background:var(--hud-teal,var(--line))}
.sw-copb i.on{background:var(--a)}
/* HUD light and motion: corner ticks on every panel, panels power on one after another, tracks and the
   chart fill in, the picked callout and the playback ticks glow, and a number that changes rolls in */
@keyframes sw-boot{from{opacity:0;transform:translateY(6px)}}
@keyframes sw-grow{from{transform:scaleX(0)}}
@keyframes sw-wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes sw-roll{from{opacity:0;transform:translateY(45%)}}
@keyframes sw-sweep{from{background-position:0 -60%}to{background-position:0 160%}}
@keyframes sw-ping{0%{r:4;opacity:1}70%{r:9;opacity:0}100%{r:9;opacity:0}}
.sw-page[data-theme=terminal] .sw-panel{display:flex;flex-wrap:wrap;align-items:flex-end;column-gap:18px}
.sw-page[data-theme=terminal] .sw-panel>*{flex:1 0 100%;min-width:0}
.sw-page[data-theme=terminal] .sw-panel>.sw-hd{flex:1 1 260px;margin-bottom:12px}
.sw-page[data-theme=terminal] .sw-panel>.sw-tabs{flex:0 0 auto;margin:0 0 12px}
.sw-page[data-theme=terminal] .sw-hp::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.75;background:linear-gradient(var(--hud-frame),var(--hud-frame)) left top/9px 1px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) left top/1px 9px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) right top/9px 1px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) right top/1px 9px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) left bottom/9px 1px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) left bottom/1px 9px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) right bottom/9px 1px no-repeat,linear-gradient(var(--hud-frame),var(--hud-frame)) right bottom/1px 9px no-repeat}
.sw-page .sw-hp{animation:sw-boot .5s cubic-bezier(.2,.7,.2,1) both}
.sw-page .sw-hp:nth-child(2){animation-delay:.06s}
.sw-page .sw-hp:nth-child(3){animation-delay:.12s}
.sw-page .sw-hp:nth-child(4){animation-delay:.18s}
.sw-page .sw-hp:nth-child(5){animation-delay:.24s}
.sw-page .sw-hp:nth-child(n+6){animation-delay:.3s}
.sw-page[data-theme=terminal] .sw-tkb>i{transform-origin:left;background:linear-gradient(90deg,color-mix(in srgb,var(--k) 6%,transparent),color-mix(in srgb,var(--k) 70%,transparent))}
.sw-page[data-theme=terminal] .sw-tkb>i::after{width:2px;top:-3px;bottom:-3px;box-shadow:0 0 8px var(--k),0 0 2px var(--k)}
.sw-page .sw-tkb>i{animation:sw-grow .9s cubic-bezier(.2,.7,.2,1) .15s both}
.sw-page[data-theme=terminal] .sw-chs0{stop-color:var(--a);stop-opacity:.42}
.sw-page[data-theme=terminal] .sw-chs1{stop-color:var(--a);stop-opacity:0}
.sw-page[data-theme=terminal] .sw-chl{stroke-width:1.8;filter:drop-shadow(0 0 4px var(--tm-glow))}
.sw-page[data-theme=terminal] .sw-chd{filter:drop-shadow(0 0 5px var(--a))}
.sw-page .sw-ch{animation:sw-wipe 1.1s cubic-bezier(.3,.6,.2,1) .1s both}
.sw-chp{fill:none;stroke:var(--a);stroke-width:1.2;vector-effect:non-scaling-stroke}
.sw-page .sw-chp{animation:sw-ping 1.8s ease-out infinite}
.sw-page[data-theme=terminal] .sw-rmarks{gap:4px;height:26px}
.sw-page[data-theme=terminal] .sw-rmark{box-shadow:none;background:repeating-linear-gradient(90deg,var(--hud-teal-b) 0 2px,transparent 2px 5px)}
.sw-page[data-theme=terminal] .sw-rmark[data-at=past]{background:repeating-linear-gradient(90deg,color-mix(in srgb,var(--a) 75%,transparent) 0 2px,transparent 2px 5px)}
.sw-page[data-theme=terminal] .sw-rmark[data-at=now]{background:repeating-linear-gradient(90deg,var(--a) 0 2px,transparent 2px 5px);filter:drop-shadow(0 0 4px var(--a))}
.sw-page[data-theme=terminal] .sw-rmark[data-failed=true]{background:repeating-linear-gradient(90deg,color-mix(in srgb,var(--bad) 75%,transparent) 0 2px,transparent 2px 5px)}
.sw-page[data-theme=terminal] .sw-rmark[data-at=now][data-failed=true]{filter:drop-shadow(0 0 4px var(--bad))}
.sw-page[data-theme=terminal] .sw-rmark:hover{box-shadow:inset 0 -1px 0 var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-rbar .sw-btns{gap:6px 18px}
.sw-page[data-theme=terminal] .sw-rbar .sw-ib.is-text{width:auto;height:auto;padding:2px 0;color:var(--a);background:none;box-shadow:none;letter-spacing:.04em;text-transform:uppercase}
.sw-page[data-theme=terminal] .sw-rbar .sw-ib.is-text:hover{color:var(--tm-hi);background:none;text-shadow:0 0 8px var(--tm-glow)}
.sw-page[data-theme=terminal] .sw-rbar .sw-ib.is-text:disabled{color:var(--dim)}
.sw-page[data-theme=terminal] .sw-cov{color:var(--tm-hi);background:color-mix(in srgb,var(--c) 22%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 55%,transparent)}
.sw-page[data-theme=terminal] .sw-copn{color:var(--tm-hi);background:color-mix(in srgb,var(--a) 26%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 60%,transparent)}
.sw-page[data-theme=terminal] .sw-wires path{filter:drop-shadow(0 0 2px var(--tm-glow))}
.sw-page[data-theme=terminal] .sw-hchip::before{box-shadow:0 0 8px var(--c),0 0 2px var(--c)}
.sw-page .sw-hchip[data-st=running]::before{animation:sw-pulse 1.6s ease-in-out infinite}
.sw-page .sw-roll{display:inline-block;animation:sw-roll .45s cubic-bezier(.2,.7,.2,1) both}
.sw-page .sw-hgrid:has(.sw-rlines[data-play])::after{content:"";position:absolute;inset:0;z-index:2;pointer-events:none;
 background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--a) 8%,transparent) 50%,transparent) no-repeat;background-size:100% 30%;animation:sw-sweep 2.6s linear infinite}
/* the accent carries the light: corner ticks, the picked tab, the hero grids, the big numbers and the
   filled tiles glow faintly in it, the way the draft lit its mint on black */
.sw-page[data-theme=terminal]{--hud-tick:color-mix(in srgb,var(--a) 70%,transparent)}
.sw-page[data-theme=terminal] .sw-hp::before{opacity:1;background:linear-gradient(var(--hud-tick),var(--hud-tick)) left top/10px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left top/1px 10px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right top/10px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right top/1px 10px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left bottom/10px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left bottom/1px 10px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right bottom/10px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right bottom/1px 10px no-repeat}
.sw-page[data-theme=terminal] .sw-hp:has(.sw-hgrid)::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(70% 60% at 30% 45%,color-mix(in srgb,var(--a) 9%,transparent),transparent 70%)}
.sw-page[data-theme=terminal] .sw-tab[aria-selected=true]{text-shadow:0 0 10px var(--tm-glow);box-shadow:inset 0 -2px 0 var(--a),0 6px 12px -8px var(--a)}
.sw-page[data-theme=terminal] .sw-big,.sw-page[data-theme=terminal] .sw-hbig{text-shadow:0 0 18px var(--tm-glow)}
.sw-page[data-theme=terminal] .sw-fcells>i[data-k=changed],.sw-page[data-theme=terminal] .sw-copb i.on{box-shadow:0 0 8px var(--tm-glow)}
.sw-page[data-theme=terminal] .sw-ht{text-shadow:0 0 12px var(--tm-glow)}
/* one order for every tab: three type sizes (11.5 px text, 14 px names, 28 px numbers), two letter
   spacings (.04em for caps labels, none for everything else), the strip under the title the same on each
   tab, a folded panel opening from its title row, the playback a full-width strip */
.sw-page[data-theme=terminal] :is(.sw-chatn,.sw-meta,.sw-meta .sw-1l,.sw-leg,.sw-un,.sw-hrow,.sw-hrow b,.sw-big,.sw-big small,.sw-bign,.sw-tl,.sw-fn,.sw-tn,.sw-verb,.sw-pickn,.sw-note,.sw-fl,.sw-fnote,.sw-nowf,.sw-rtext,.sw-rsign,.sw-ol,.sw-task,.sw-ans,.sw-hdetail .sw-head.is-file){font-size:11.5px}
.sw-page[data-theme=terminal] :is(.sw-ht,.sw-rname){font-size:14px;font-weight:600}
.sw-page[data-theme=terminal] :is(.sw-tab,.sw-hpt,.sw-hptv,.sw-hpt .sw-sr,.sw-hchip,.sw-kv dt,.sw-col,.sw-k,.sw-hrow,.sw-hrow b,.sw-cmls span,.sw-crth,.sw-crth span,.sw-ib,.sw-ib.is-text,.sw-tkh,.sw-tkh>span,.sw-fleg,.sw-fleg span,.sw-pickn,.sw-hle,.sw-rl>span:first-child,.sw-rl[data-tag="@"],.sw-ht,.sw-tmore,.sw-orkey,.sw-ormain .sw-orn,.sw-orv){letter-spacing:.04em}
/* type comes from Hermes, as the user asked: text in the app's own font (--dt-font-sans, which also
   follows the chat font picked in Hermes settings), code and numbers in the app's code font
   (--dt-font-mono, shipped with Hermes, so the same on every machine). One weight, the app's regular;
   rank comes from size and grey. Sizes stay the panel's own. --mono is the panel's text font here. */
.sw-page[data-theme=terminal]{--mono:var(--dt-font-sans,system-ui,sans-serif);--code:var(--dt-font-mono,ui-monospace,monospace)}
.sw-page[data-theme=terminal] .sw-panel,.sw-page[data-theme=terminal] .sw-panel *{font-weight:400!important}
.sw-page[data-theme=terminal] :is(.sw-rlines,.sw-rlines *,.sw-out,.sw-out *,.sw-ol,.sw-hbig,.sw-hbig *,.sw-big,.sw-big *,.sw-money,.sw-roll,.sw-hln,.sw-hlt,.sw-copn,.sw-pg,.sw-chax,.sw-head code){font-family:var(--code)!important;font-variant-numeric:tabular-nums!important}
/* One rule for numerals: every slot whose whole text is a value (count, ratio, cost, %, tokens,
   duration, clock time) is set in the code font with tabular figures, at its own size. A number inside
   a label or a sentence ("CHANGED 12", "DONE · 5m 28s") stays in the text font. .sw-num marks a value
   in a slot that can also hold words (a key/value row). Only the hero numbers glow (.sw-hbig, the
   DETAIL tiles); a small value inside a glowing line does not. */
.sw-page[data-theme=terminal] :is(.sw-num,.sw-tkh>b,.sw-tks>span,.sw-orp>b,.sw-orm,.sw-tabn,.sw-cmlt,.sw-rwhen,.sw-exit>b,.sw-tn){font-family:var(--code)!important;font-variant-numeric:tabular-nums!important}
.sw-page[data-theme=terminal] :is(.sw-tabn,.sw-hbig small){text-shadow:none}
.sw-tmore{margin:-4px 0 8px;color:var(--dim)}
.sw-page[data-theme=terminal] :is(.sw-hpn,.sw-tkh .sw-1l,.sw-un,.sw-verb,.sw-rname,.sw-tl,.sw-tn){letter-spacing:0}
.sw-page[data-theme=terminal] .sw-why{margin:0;padding:7px 12px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line);line-height:1.5}
.sw-page[data-theme=terminal] .sw-runb{margin-bottom:8px;line-height:1.5}
.sw-page[data-theme=terminal] .sw-tk{margin-bottom:12px}
.sw-page[data-theme=terminal] .sw-tkax{margin-top:-4px}
.sw-page[data-theme=terminal] .sw-fleg{flex-wrap:wrap;white-space:nowrap}
.sw-page[data-theme=terminal] .sw-rpb .sw-btns{flex-wrap:nowrap}
.sw-hfold>summary{cursor:pointer;list-style:none}
.sw-hfold>summary::-webkit-details-marker{display:none}
.sw-hfold>summary .sw-hpt::before{content:"";display:inline-block;width:5px;height:5px;margin:0 9px 2px 1px;border:solid var(--a);border-width:0 1.5px 1.5px 0;transform:rotate(-45deg);transition:transform .12s cubic-bezier(.2,0,.38,.9)}
.sw-hfold[open]>summary .sw-hpt::before{transform:rotate(45deg)}
.sw-hfold:not([open])>summary{margin-bottom:0}
.sw-hfold>summary:hover .sw-hptv{color:var(--tm-hi,var(--ink))}
.sw-hfold>summary:focus-visible{outline:1px solid var(--a);outline-offset:2px}

.sw-rdiff{display:flex;flex-direction:column;gap:6px;min-width:0}
.sw-rlines{max-height:300px;overflow:hidden auto;padding:6px 0;font:12px/1.6 var(--mono);white-space:pre-wrap;scrollbar-width:thin;scrollbar-color:var(--hud-line2,var(--line)) transparent}
.sw-rdiff[data-failed=true] .sw-rlines{opacity:.7}
/* code wraps inside the panel (the user wants every line whole); a wrapped line continues under its text, not under the gutter */
.sw-rl{display:flex;min-width:0;padding-right:10px;color:var(--dim)}
.sw-rtext{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.sw-rsign{flex:none;width:24px;text-align:center;color:var(--dim)}
.sw-rln{flex:none;width:5ch;padding-right:4px;text-align:right;color:var(--faint,var(--dim))}
.sw-rl[data-tag="@"] .sw-rln{display:none}
.sw-rl[data-tag="-"] .sw-rtext{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--bad) 60%,transparent)}
.sw-rl[data-tag="+"]{color:var(--tm-hi,var(--ink));background:color-mix(in srgb,var(--ok) 7%,transparent)}
.sw-rl[data-tag="+"] .sw-rsign{color:var(--ok)}
.sw-rl[data-tag="-"]{color:var(--dim);background:color-mix(in srgb,var(--bad) 8%,transparent)}
.sw-rl[data-tag="-"] .sw-rsign{color:var(--bad)}
.sw-page[data-theme=terminal] .sw-rl[data-tag="+"]{background:linear-gradient(90deg,var(--hud-add),transparent 70%)}
.sw-page[data-theme=terminal] .sw-rl[data-tag="-"]{background:linear-gradient(90deg,var(--hud-del),transparent 70%)}
.sw-page[data-theme=terminal] .sw-rl[data-tag="+"] .sw-rsign{color:var(--hud-add-ink)}
.sw-page[data-theme=terminal] .sw-rl[data-tag="-"] .sw-rsign{color:var(--hud-del-ink)}
.sw-rl[data-tag="@"]{align-items:center;gap:8px;margin:8px 0 3px;padding-left:6px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase}
.sw-rl[data-tag="@"]:first-child{margin-top:0}
.sw-rl[data-tag="@"]::before{content:"";flex:none;width:14px;height:1px;background:var(--a)}
.sw-rl[data-tag="@"]::after{content:"";flex:1 1 40px;min-width:0;height:1px;background:var(--line)}
.sw-rmore{display:flex}
/* Play: in order each removed line strikes through and dims; then each added line types in, letter by
   letter, behind a block cursor that stays on the line being typed (data-cur). The text is an
   inline-block: max-width does nothing on an inline span, and the line would show whole at once. */
@keyframes sw-dim{to{opacity:.45}}
@keyframes sw-strike{from{text-decoration-color:transparent}to{text-decoration-color:var(--bad)}}
@keyframes sw-hide{from,to{visibility:hidden}}
.sw-page .sw-rlines[data-play] .sw-rl[data-tag="-"]{animation:sw-dim var(--t) ease-out var(--d) both}
.sw-page .sw-rlines[data-play] .sw-rl[data-tag="-"] .sw-rtext{text-decoration:line-through;animation:sw-strike var(--t) linear var(--d) both}
.sw-page .sw-rlines[data-play] .sw-rl[data-tag="+"]{animation:sw-hide 1ms var(--d) backwards}
.sw-page .sw-rlines[data-play] .sw-rl[data-cur]{box-shadow:inset 2px 0 0 var(--a)}
.sw-page .sw-rlines[data-play] .sw-rl[data-cur] .sw-rtext::after{content:"";display:inline-block;width:.55em;height:1.05em;margin-left:1px;vertical-align:-.2em;background:var(--a)}
/* what a part of the edit did sits at the end of its header row, after the rule: 2 LINES REPLACED −2 +3 */
.sw-rl[data-tag="@"]{white-space:nowrap}
.sw-rl[data-tag="@"]::after{order:2}
.sw-rpart{order:3;flex:none;display:flex;align-items:center;gap:8px;color:var(--ink)}
.sw-covs{display:flex;gap:4px}
.sw-rfail{display:flex;flex-direction:column;margin:10px 0 0;padding:4px 10px;color:var(--ink);background:color-mix(in srgb,var(--bad) 7%,transparent);box-shadow:inset 2px 0 0 var(--bad)}
.sw-rfail>span:last-child{color:var(--dim)}
.sw-rbad{color:var(--ink)}
.sw-rbad::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;vertical-align:1px;background:var(--bad)}
.sw-rfile{display:flex;align-items:center;gap:10px;min-width:0;margin:-4px 0 10px}
.sw-rname{flex:0 1 auto;min-width:0;font-size:14px;font-weight:600;letter-spacing:.04em;color:var(--tm-hi,var(--ink))}
.sw-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:14px;row-gap:5px;margin:0}
.sw-kv>dt{font-size:11.5px;letter-spacing:.04em;line-height:1.8;color:var(--dim)}
.sw-kv>dd{min-width:0;margin:0;color:var(--ink)}
.sw-rwhat{margin:0}
.sw-rtlist,.sw-hlog{display:grid;align-content:start;overflow:hidden auto;scrollbar-width:thin;scrollbar-color:var(--hud-line2,var(--line)) transparent}
.sw-rtlist{grid-template-columns:max-content max-content minmax(0,1fr);max-height:150px}
.sw-hlog{grid-template-columns:max-content max-content minmax(0,1fr) max-content;max-height:176px}
.sw-rturn,.sw-hlog>button{display:grid;grid-column:1/-1;grid-template-columns:subgrid;column-gap:14px;padding:2px 6px;white-space:nowrap}
.sw-rturn>*,.sw-hlog>button>*{grid-row:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sw-rwhen{grid-column:1;color:var(--dim)}
.sw-rcount{grid-column:2;color:var(--dim)}
.sw-rask{grid-column:3;color:var(--ink)}
.sw-hlt,.sw-hln{color:var(--dim)}
.sw-hln{text-align:right}
.sw-hle{display:inline-flex;align-items:center;gap:6px;letter-spacing:.04em;color:var(--ink)}
.sw-hle::before{content:"";flex:none;width:5px;height:5px;background:var(--c)}
.sw-hlm{color:var(--ink)}
.sw-rturn:hover,.sw-hlog>button:hover{background:color-mix(in srgb,var(--a) 6%,transparent)}
.sw-rturn[aria-pressed=true],.sw-hlog>button[aria-current=step]{background:var(--hud-pick,var(--raised));box-shadow:inset 2px 0 0 var(--c,var(--a))}
.sw-rturn[aria-pressed=true]>*,.sw-hlog>button[aria-current=step]>*{color:var(--tm-hi,var(--ink))}
@container (max-width:540px){
 .sw-hp[data-span]{grid-column:span 6}
 .sw-cos,.sw-wires{display:none}
 .sw-hgrid>.sw-cmnote{margin-right:0}
 .sw-hlog{grid-template-columns:max-content minmax(0,1fr) max-content}
 .sw-hle{display:none}
 .sw-rtlist{grid-template-columns:max-content minmax(0,1fr)}
 .sw-rturn>.sw-rcount{grid-column:2;grid-row:2;white-space:normal}
}
/* DETAIL in the HUD's own order: the stats are boxed counters with a caps label over a big light
   number, the file lists are ticked sub-panels, the blocks are the FILES panel's cells, the portrait a
   ticked tile on the station grid, the state a chip. One tick recipe for panels, counters and lists. */
.sw-page[data-theme=terminal]{--hud-ticks:linear-gradient(var(--hud-tick),var(--hud-tick)) left top/8px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left top/1px 8px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right top/8px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right top/1px 8px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left bottom/8px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) left bottom/1px 8px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right bottom/8px 1px no-repeat,linear-gradient(var(--hud-tick),var(--hud-tick)) right bottom/1px 8px no-repeat}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-hero{grid-template-columns:minmax(0,1fr);gap:14px;align-items:center;margin-top:2px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-hero .sw-por{display:none}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tile[data-k=failed]{--tc:var(--bad)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-fsec[data-sec=failed] .sw-ft{--fc:var(--bad)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-por{width:auto;gap:5px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-pg{position:relative;overflow:hidden;width:56px;height:46px;border:0;font-size:18px;color:var(--c);
 background:var(--hud-ticks),linear-gradient(var(--hud-grid) 1px,transparent 1px) -1px -1px/9px 9px,linear-gradient(90deg,var(--hud-grid) 1px,transparent 1px) -1px -1px/9px 9px,color-mix(in srgb,var(--c) 7%,transparent);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 30%,transparent),0 0 16px -6px var(--c);text-shadow:0 0 10px var(--c)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-ptag{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-verb{display:inline-flex;align-items:center;margin-bottom:7px;padding:1px 7px;font-size:11.5px;letter-spacing:.04em;color:var(--ink);
 background:color-mix(in srgb,var(--c) 9%,var(--raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 34%,var(--raised))}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-head{font-size:14px;color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0 0}
@container (max-width:540px){.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tile{--tc:var(--a);position:relative;display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:9px;min-width:0;padding:9px 11px 11px;
 background:color-mix(in srgb,var(--tc) 4%,transparent);box-shadow:inset 0 0 0 1px var(--line)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tile[data-k=read]{--tc:var(--hud-teal-b)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tile::before{display:block;content:"";position:absolute;inset:0;width:auto;pointer-events:none;background:var(--hud-ticks);box-shadow:none}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tile::after{content:"";position:absolute;left:11px;right:11px;bottom:0;height:2px;background:var(--tc);box-shadow:0 0 8px var(--tc);transform-origin:left;transform:scaleX(var(--p,0))}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tiles .sw-tl{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-tiles .sw-tn{font:250 24px/1 var(--mono);letter-spacing:-.02em;color:var(--tm-hi);text-shadow:0 0 18px var(--tm-glow)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-flist{row-gap:8px;margin-top:8px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-fsec{position:relative;margin:0;padding:10px 12px 9px;border:0;background:color-mix(in srgb,var(--a) 3%,transparent);box-shadow:inset 0 0 0 1px var(--line)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-fsec::before{content:"";position:absolute;inset:0;pointer-events:none;background:var(--hud-ticks)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-fh{margin:0 0 8px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-fh .sw-k{font-size:11.5px;letter-spacing:.04em;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-leg{margin-left:auto;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-leg::before{display:none}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-pips{gap:2px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-pips i{width:8px;height:12px;background:var(--hud-teal-d);box-shadow:inset 0 0 0 1px var(--hud-teal)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-pips i.on{background:color-mix(in srgb,var(--fc) 70%,var(--raised));box-shadow:0 0 6px var(--tm-glow)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-ft[data-op=read]{--fc:var(--hud-teal-b)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-ft[data-op=read] .sw-pips i.on{background:var(--hud-teal-b);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 50%,transparent)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-ft:hover{background:color-mix(in srgb,var(--a) 6%,transparent)}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-note{margin-top:10px;font-size:11.5px}
.sw-page[data-theme=terminal] .sw-hp.sw-hdetail .sw-note::before{content:none}

/* DETAIL motion: it opens and closes smoothly; on open the counters power on one after another and
   count up, the bars under them draw in, the blocks fill left to right, the file rows slide in */
.sw-hfold{interpolate-size:allow-keywords}
.sw-hfold::details-content{block-size:0;overflow:clip;opacity:0;transition:block-size .32s cubic-bezier(.2,.7,.2,1),opacity .24s ease-out,content-visibility .32s allow-discrete}
.sw-hfold[open]::details-content{block-size:auto;opacity:1}
@keyframes sw-pipon{from{background:var(--hud-teal-d);box-shadow:inset 0 0 0 1px var(--hud-teal)}}
.sw-page .sw-hfold[open] .sw-tile{animation:sw-boot .45s cubic-bezier(.2,.7,.2,1) both}
.sw-page .sw-hfold[open] .sw-tile:nth-child(2){animation-delay:.07s}
.sw-page .sw-hfold[open] .sw-tile:nth-child(3){animation-delay:.14s}
.sw-page .sw-hfold[open] .sw-tile:nth-child(4){animation-delay:.21s}
.sw-page .sw-hfold[open] .sw-tile::after{animation:sw-grow .8s cubic-bezier(.2,.7,.2,1) .25s both}
.sw-page .sw-hfold[open] .sw-tn[data-count]{animation:sw-count 1.1s cubic-bezier(.2,.7,.2,1) .15s both}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on{animation:sw-pipon .2s steps(1,end) both;animation-delay:calc(min(var(--i,0),12) * 55ms + .3s)}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on:nth-child(2){animation-delay:calc(min(var(--i,0),12) * 55ms + .36s)}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on:nth-child(3){animation-delay:calc(min(var(--i,0),12) * 55ms + .42s)}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on:nth-child(4){animation-delay:calc(min(var(--i,0),12) * 55ms + .48s)}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on:nth-child(5){animation-delay:calc(min(var(--i,0),12) * 55ms + .54s)}
.sw-page .sw-hfold[open] .sw-ft .sw-pips i.on:nth-child(n+6){animation-delay:calc(min(var(--i,0),12) * 55ms + .6s)}
/* working: a scan line runs down the portrait and keeps sweeping the file being written */
@keyframes sw-pgscan{from{background-position:0 -120%}to{background-position:0 220%}}
.sw-page[data-theme=terminal] .sw-hdetail .sw-por[data-st=running] .sw-pg::after{content:"";position:absolute;inset:0;pointer-events:none;
 background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--c) 38%,transparent) 50%,transparent) no-repeat 0 -120%/100% 45%;animation:sw-pgscan 1.8s linear infinite}
.sw-page .sw-hdetail .sw-ft.is-now::after{animation:sw-sweep 2.2s ease-in-out .3s infinite}

/* the station never stands dead still: a light runs down the truss, the core's rings glow one after
   another like an engine at rest, the core pin blinks like a beacon, and while no helper is out a
   standby light walks the main box's bars. Working, the scan is brighter; an earlier run stays still */
@keyframes sw-trail{from{stroke-dashoffset:100}to{stroke-dashoffset:-14}}
@keyframes sw-orflow{0%,55%,100%{stroke:var(--orw2)}18%{stroke:var(--a)}}
@keyframes sw-beacon{0%,86%,100%{fill:var(--raised)}90%{fill:var(--a)}}
@keyframes sw-standby{0%,100%{background:color-mix(in srgb,var(--a) 22%,transparent)}6%{background:var(--a)}}
.sw-ortrail{fill:none;stroke:var(--a);stroke-width:1.6;stroke-linecap:round;stroke-dasharray:14 86;stroke-dashoffset:100;opacity:.75;filter:drop-shadow(0 0 3px var(--a))}
.sw-page .sw-orbit:not([data-calm]) .sw-ortrail{animation:sw-trail 4.8s cubic-bezier(.45,0,.55,1) infinite}
.sw-orbit[data-calm] .sw-ortrail{display:none}
.sw-page .sw-orbit:not([data-calm]) .sw-orbody polyline{animation:sw-orflow 3.6s ease-in-out infinite;animation-delay:calc(var(--r,0) * .16s)}
.sw-page .sw-orbit:not([data-calm]) .sw-orpin:last-of-type{animation:sw-beacon 2.8s linear infinite}
.sw-page .sw-orbit[data-subs="0"]:not([data-calm]) .sw-orbars i{animation:sw-standby 2.8s linear infinite;animation-delay:calc(var(--k,0) * .2s)}
.sw-orbit:not([data-live]) .sw-orscan{opacity:.55;animation-duration:9s}

/* film HUD: text comes in from the sides. The station's corner readouts type in line after line — the
   left column from the left, the right column from the right — hold, flicker out and type in again;
   callouts slide in from their side while their leader lines draw toward the wing; every panel title
   types in behind a blinking block cursor; log lines slide in from the right. An earlier run stays still. */
.sw-ortele{position:absolute;top:10px;z-index:1;display:flex;flex-direction:column;gap:4px;font:300 11.5px/14px var(--mono);letter-spacing:.06em;color:var(--dim);pointer-events:none}
.sw-ortele[data-side=l]{left:14px;align-items:flex-start}
.sw-ortele[data-side=r]{right:14px;align-items:flex-end}
.sw-otl{display:flex;gap:8px;white-space:nowrap}
.sw-ortele[data-side=l] .sw-otl::before{content:"▸";color:var(--a)}
.sw-ortele[data-side=r] .sw-otl::after{content:"◂";color:var(--a)}
.sw-otl b{display:inline-block;font-weight:inherit;color:var(--tm-hi,var(--ink))}
.sw-page .sw-otl b{animation:sw-roll .45s cubic-bezier(.2,.7,.2,1) both}
@keyframes sw-telel{0%{clip-path:inset(0 100% 0 0);transform:translateX(-16px);animation-timing-function:steps(9,end)}7%{clip-path:inset(0 0 0 0);transform:none}80%{opacity:1}81%{opacity:.15}82%{opacity:1}85%,100%{opacity:0}}
@keyframes sw-teler{0%{clip-path:inset(0 0 0 100%);transform:translateX(16px);animation-timing-function:steps(9,end)}7%{clip-path:inset(0 0 0 0);transform:none}80%{opacity:1}81%{opacity:.15}82%{opacity:1}85%,100%{opacity:0}}
.sw-page .sw-orbit:not([data-calm]) .sw-ortele[data-side=l] .sw-otl{animation:sw-telel 11s linear infinite both;animation-delay:calc(var(--i) * .35s + .7s)}
.sw-page .sw-orbit:not([data-calm]) .sw-ortele[data-side=r] .sw-otl{animation:sw-teler 11s linear infinite both;animation-delay:calc(var(--i) * .35s + .7s)}
@keyframes sw-froml{from{opacity:0;transform:translateX(-24px)}}
@keyframes sw-fromr{from{opacity:0;transform:translateX(24px)}}
@keyframes sw-lead{from{stroke-dashoffset:100}}
.sw-orlead{stroke-dasharray:100}
.sw-page .sw-orlead{animation:sw-lead .7s cubic-bezier(.3,.6,.2,1) .3s both}
.sw-page .sw-orl[data-side=l]{animation:sw-froml .5s cubic-bezier(.2,.7,.2,1) .45s both}
.sw-page .sw-orl[data-side=r]{animation:sw-fromr .5s cubic-bezier(.2,.7,.2,1) .45s both}
.sw-page .sw-ormain{animation:sw-type .5s steps(12,end) .25s both}
@keyframes sw-cur{0%,100%{opacity:0}6%,28%,50%,72%{opacity:1}17%,39%,61%,83%{opacity:0}}
.sw-page .sw-hp .sw-hpt{animation:sw-type .5s steps(14,end) .2s both}
.sw-page[data-theme=terminal] .sw-hp .sw-hpt::after{content:"";display:inline-block;width:.55em;height:1em;margin-left:3px;vertical-align:-.15em;background:var(--a);opacity:0;animation:sw-cur 1.4s linear .2s both}
.sw-page .sw-hlog>button{animation:sw-fromr .4s cubic-bezier(.2,.7,.2,1) both}
.sw-page .sw-hlog>button:nth-child(2){animation-delay:.07s}
.sw-page .sw-hlog>button:nth-child(3){animation-delay:.14s}
.sw-page .sw-hlog>button:nth-child(4){animation-delay:.21s}
.sw-page .sw-hlog>button:nth-child(n+5){animation-delay:.28s}
@container (max-width:540px){.sw-ortele{display:none}}
/* Nothing is cut or overlaps at any width: a value or a key word stays whole and never shrinks; the
   name beside it gives way (ellipsis); a legend or a row of tiles wraps instead of running out. */
.sw-orl>.sw-orv,.sw-tkh>b{flex:none;max-width:none}
.sw-orl>.sw-orn,.sw-tkh>.sw-1l{min-width:0}
/* the live station canvas sits under the callouts; it draws the station, lines and MAIN box itself,
   so the SVG schematic hides while it runs (the SVG stays as the fallback without a 2D canvas) */
.sw-orcv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
.sw-orbit.has-scene .sw-ors{visibility:hidden}
@container (max-width:540px){.sw-orcv{bottom:auto;height:auto;aspect-ratio:666/360}}
@media (prefers-reduced-motion:reduce){.sw-page *,.sw-page *::before,.sw-page *::after{animation:none!important;transition:none!important}}
`


function navLabel() {
  const viaApp = ctxRef?.i18n?.t?.('sw.title')
  return viaApp && viaApp !== 'sw.title' ? viaApp : BUNDLES.en.sw.title
}

export default {
  id: ID,
  name: 'Agent Station',
  register(ctx) {
    ctxRef = ctx
    ctx.i18n?.register?.(BUNDLES)
    ctx.register({ id: 'page', area: 'routes', data: { path: ROUTE }, render: () => jsx(Page, {}) })
    ctx.register({ id: 'nav', area: 'sidebar.nav', data: { path: ROUTE, label: navLabel(), codicon: 'type-hierarchy-sub' } })
    ctx.register({ id: 'progress', area: STATUSBAR_AREAS.right, order: 125, render: () => jsx(ProgressChip, {}) })
    for (const type of SUBAGENT_EVENTS) ctx.onEvent(type, event => trackEvent(type, event))
    // A pet shown later, or a chat switch, gets the current line at once.
    ctx.pet?.visible?.listen?.(() => petUpdate())
    host.state.focusedSessionId.listen?.(() => petUpdate())
  }
}
