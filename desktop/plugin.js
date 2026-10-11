/**
 * Subagent Watch — read-only page for the focused chat's agents: the main agent, the delegate_task
 * subagents it started, and the shell commands it left running in the background.
 *
 *   Agents    one run at a time — the running one, else the last; the run picker opens earlier
 *             ones, calm, with "Back to now". A score (subagents done / all), one status cell per
 *             subagent, the cost the subagents spent, and one unit per agent — the main agent first
 *             and selected — whose icon says what it does now (editing, reading, running a command,
 *             waiting, done, failed, stopped, idle). Past SWARM_AT subagents the units turn into a
 *             swarm grouped by status, failed first by name. One focus panel under the units shows
 *             the selected agent: what it works on now, the files it changed and the ones it only
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
 *   Looks     two themes over the same page: Cockpit (the default; theme tokens only, the accent
 *             is the app's --ui-accent) and Terminal (a fixed phosphor palette, declared once in
 *             TM_PALETTE). The choice is kept in the plugin's ctx.storage; a missing or failing
 *             storage falls back to Cockpit and never breaks the page.
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

const ID = 'subagent-watch'
const ROUTE = '/subagent-watch'
const POLL_MS = 3000
const MAX_POLL_FAILS = 3
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
// More subagents than this and the units turn into the grouped swarm.
const SWARM_AT = 8
// Rows a focus panel lists before "Show N more": changed files, files only read.
const CHANGED_ROWS = 8
const READ_ROWS = 3
// A subagent's task is shown up to this many characters before "Show all".
const TASK_CHARS = 180
// How long a unit that just finished (or failed) plays its moment.
const FLASH_MS = 1400
const THEMES = ['cockpit', 'terminal']
const THEME_KEY = 'theme'
// The main agent's unit key: never a subagent id or a session id.
const MAIN = 'main'

let ctxRef = null
// The stored id of the chat the page watches (see useWatchedChat), for reads deep in the tree.
const WatchedChat = createContext(null)

const BUNDLES = {
  en: {
    sw: {
      title: 'Subagents',
      chat: {
        untitled: id => `Chat …${id}`,
        held: 'held',
        heldTip: 'You clicked inside this page, so it keeps showing this chat. Click a chat to follow it again.'
      },
      theme: { label: 'Look of this page', cockpit: 'Cockpit', terminal: 'Terminal' },
      tabs: {
        label: 'Sections', agents: 'Agents', commands: 'Commands',
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
      allFailed: 'Nothing could be read. Use Try again in the box above.',
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
      swarm: {
        failed: 'Failed', running: 'Working', queued: 'Waiting', completed: 'Done',
        show: 'Show', hide: 'Hide', cell: (name, line) => `${name} — ${line}`
      },
      focus: {
        mainLabel: 'Focus · main agent · this chat',
        subLabel: 'Focus · subagent',
        main: {
          working: verb => `${verb[0].toUpperCase()}${verb.slice(1)}`,
          waiting: n => `Waiting on ${n} subagent${n === 1 ? '' : 's'}`,
          busy: 'Working — no tool running right now',
          idle: 'Idle — waiting for your message',
          unknown: 'No tool running right now',
          touched: n => (n ? `touched ${n} file${n === 1 ? '' : 's'} in this chat` : 'no files touched in this chat yet')
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
        changed: n => `Changed · ${n}`,
        read: n => `Only read · ${n}`,
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
        open: 'Open its chat',
        meta: (tools, tokens, cost) => [`${tools} tool${tools === 1 ? '' : 's'}`, tokens ? `${tokens} tokens` : '', cost || ''].filter(Boolean).join(' · ')
      },
      modelTip: (model, effort) => (effort ? `${model} · reasoning effort ${effort}` : model),
      file: {
        op: {
          active: 'now', write: n => `edit ×${n}`, delete: 'deleted', failed: 'failed', read: n => `read ×${n}`
        },
        tip: path => `${path}\nClick to copy the path`,
        name: (name, dir, label) => `${name} in ${dir}: ${label}`,
        copied: 'Path copied',
        here: 'chat folder',
        notListed: n => `${n} older file${n === 1 ? '' : 's'} not listed`,
        unreadable: n => `${n} tool call${n === 1 ? '' : 's'} could not be read`
      },
      proc: {
        why: 'Terminal commands the agent started and left running in the background — not subagents.',
        none: 'No background commands in this chat.',
        short: { running: 'Running', completed: 'Finished', failed: 'Failed', stopped: 'Stopped' },
        status: {
          running: 'Running', completed: 'Finished (exit 0)', failed: 'Failed', stopped: 'Stopped before it finished'
        },
        exit: c => `exit ${c}`,
        killed: 'killed',
        cwd: d => `in ${d}`,
        copyCommand: 'Copy command',
        copyOutput: 'Copy output',
        output: 'End of output',
        outputCut: n => `last ${n} characters`,
        commandCut: n => `Only the first ${n} characters of this command are shown and copied.`,
        noOutput: 'No output was recorded.',
        printedNothing: 'It printed nothing.',
        whileRunning: 'Still running — the output is shown here when the command finishes.',
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
        ].filter(Boolean).join(' · ') + '. Click to open the Subagents page.',
        pet: (finished, total, cost) => [`Subagents ${finished}/${total} done`, cost].filter(Boolean).join(' · '),
        stalled: detail => `Subagent progress stopped updating: ${detail}`
      },
      units: {
        hm: (h, m) => `${h}h ${m}m`,
        ms: (m, s) => `${m}m ${s}s`,
        s: s => `${s}s`,
        k: n => `${n}k`
      },
      err: {
        title: 'Some parts could not be read:',
        history: 'earlier runs',
        live: 'live updates stopped',
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
  return names.map(n => (n.length > cut ? `…${n.slice(cut)}` : n))
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

/** The swarm's groups, in the order they are drawn: failed (and stopped) first, then working, waiting, done. */
export function swarmGroups(units) {
  const of = { failed: [], running: [], queued: [], completed: [] }
  for (const u of units) {
    if (u.status === 'failed' || u.status === 'stopped') of.failed.push(u)
    else if (of[u.status]) of[u.status].push(u)
    else of.failed.push(u)
  }
  return of
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
export function sprite(icon) {
  const g = GLYPH[icon] || GLYPH.idle
  return `┌──┐\n│${g.length > 1 ? g : `${g} `}│\n└──┘`
}
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

// ── look: Cockpit / Terminal ─────────────────────────────────────────────────
//
// The chosen look is kept in the plugin's own storage (ctx.storage). Storage is a convenience: when
// it is missing, holds something else, or throws, the page draws Cockpit and keeps working.

let themeNow = null
const themeSubs = new Set()

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
  const [theme, setTheme] = useState(() => themeNow || (themeNow = readTheme()))
  useEffect(() => {
    const fn = () => setTheme(themeNow)
    themeSubs.add(fn)
    return () => { themeSubs.delete(fn) }
  }, [])
  const choose = useCallback(next => {
    if (!THEMES.includes(next)) return
    themeNow = next
    try {
      ctxRef?.storage?.set?.(THEME_KEY, next)
    } catch (err) {
      console.warn(`[${ID}] could not keep the look`, err)
    }
    themeSubs.forEach(fn => fn())
  }, [])
  return [theme, choose]
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
    const poll = async () => {
      if (!alive || fails.current >= MAX_POLL_FAILS) return
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
        fails.current += 1
        console.warn(`[${ID}] subagent.list failed (${fails.current}/${MAX_POLL_FAILS})`, err)
        if (fails.current >= MAX_POLL_FAILS) setError(String(err?.message || err))
      }
    }
    pollRef.current = poll
    void poll()
    const stop = ctxRef.setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      pollRef.current = null
      stop()
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

  // Refresh after polling gave up: reset the failure count so the interval polls again, and poll now.
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

function Unit({ t, theme, u, selected, onSelect, flash, waitingOn }) {
  const icon = unitIcon(u)
  const word = statusWord(t, u, waitingOn)
  const tag = t(`sw.tag.${u.status === 'running' ? u.act || 'think' : u.status}`)
  const term = theme === 'terminal'
  const goal = String(u.rec?.goal || '').trim()
  const button = jsxs('button', {
    type: 'button', className: `sw-unit${selected ? ' is-sel' : ''}${flash ? ` is-${flash}` : ''}`,
    'data-st': u.status, 'data-icon': icon, 'data-main': u.main ? 'true' : undefined, 'data-batch': u.batch,
    'aria-pressed': selected, 'aria-label': `${u.name}: ${word}`, onClick: () => onSelect(u.key),
    children: [
      term
        ? jsx('pre', { className: 'sw-spr', 'aria-hidden': 'true', children: sprite(icon) }, 'v')
        : jsxs('span', {
          className: 'sw-hex', 'aria-hidden': 'true',
          children: [
            jsx('span', { className: 'sw-ring' }, 'r'),
            jsx('span', { className: 'sw-body' }, 'b'),
            jsx('span', { className: 'sw-ic', children: ICON[icon]() }, 'i'),
            u.main ? jsx('span', { className: 'sw-maintag', children: t('sw.main.tag') }, 'm') : null
          ]
        }, 'v'),
      jsx('span', { className: 'sw-un', children: term ? `${u.main ? '★ ' : ''}${slugName(u.name)}` : u.name }, 'n'),
      // Keyed by its text: a new status mounts anew, so the Terminal look types it again.
      jsx('span', { className: 'sw-us', children: term ? tag : word }, `s-${term ? tag : word}`)
    ]
  })
  return jsx(Tip, { label: [goal || u.name, unitLine(t, u)].filter(Boolean).join('\n'), children: button })
}

/** A swarm cell: a small unit, named by its tooltip and its accessible name. */
function Cell({ t, theme, u, selected, onSelect }) {
  const icon = unitIcon(u)
  const label = t('sw.swarm.cell', u.name, unitLine(t, u))
  return jsx(Tip, {
    label,
    children: jsx('button', {
      type: 'button', className: `sw-cell${selected ? ' is-sel' : ''}`, 'data-st': u.status, 'data-icon': icon,
      'aria-pressed': selected, 'aria-label': label, onClick: () => onSelect(u.key),
      children: theme === 'terminal' ? jsx('span', { className: 'sw-glyph', 'aria-hidden': 'true', children: GLYPH[icon] }) : ICON[icon]()
    })
  })
}

function Units({ t, theme, units, selected, onSelect, flash, waitingOn }) {
  return jsx('div', {
    className: 'sw-units', role: 'group', 'aria-label': t('sw.agents'),
    children: units.map(u => jsx(Unit, { t, theme, u, selected: selected === u.key, onSelect, flash: flash.get(u.key), waitingOn }, u.key))
  })
}

/** More than SWARM_AT subagents: the main agent, then groups — failed by name, working, waiting, done. */
function Swarm({ t, theme, main, subs, selected, onSelect, flash, waitingOn }) {
  const [shown, setShown] = useState(() => new Set())
  const groups = swarmGroups(subs)
  const fold = key => setShown(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const head = (key, n, folds) => jsxs('div', {
    className: 'sw-gh',
    children: [
      jsx('h3', { className: 'sw-k', children: [t(`sw.swarm.${key}`), ' ', jsx('em', { children: n }, 'n')] }, 'h'),
      folds ? jsx('button', {
        type: 'button', className: 'sw-fold sw-acc', 'aria-expanded': shown.has(key), onClick: () => fold(key),
        children: t(shown.has(key) ? 'sw.swarm.hide' : 'sw.swarm.show')
      }, 'f') : null
    ]
  })
  const cells = list => jsx('div', {
    className: 'sw-cellgrid',
    children: list.map(u => jsx(Cell, { t, theme, u, selected: selected === u.key, onSelect }, u.key))
  })
  return jsxs('div', {
    className: 'sw-swarm',
    children: [
      jsx('div', { className: 'sw-grp sw-gmain', children: jsx(Unit, { t, theme, u: main, selected: selected === main.key, onSelect, flash: null, waitingOn }) }, 'main'),
      groups.failed.length ? jsxs('section', {
        className: 'sw-grp', 'data-grp': 'failed',
        children: [
          head('failed', groups.failed.length, false),
          ...groups.failed.map(u => jsxs('button', {
            type: 'button', className: `sw-frow${selected === u.key ? ' is-sel' : ''}${flash.get(u.key) ? ` is-${flash.get(u.key)}` : ''}`,
            'data-st': u.status, 'aria-pressed': selected === u.key, onClick: () => onSelect(u.key),
            children: [
              jsx('span', { className: 'sw-frn', children: theme === 'terminal' ? `${GLYPH.bad} ${slugName(u.name)}` : u.name }, 'n'),
              jsx('span', { className: 'sw-frx', children: u.status === 'stopped' ? t('sw.st.stopped') : fmtDuration(u.duration, t) }, 'x')
            ]
          }, u.key))
        ]
      }, 'failed') : null,
      groups.running.length ? jsxs('section', { className: 'sw-grp', 'data-grp': 'running', children: [head('running', groups.running.length, false), cells(groups.running)] }, 'running') : null,
      ...['queued', 'completed'].map(key => (groups[key].length ? jsxs('section', {
        className: 'sw-grp', 'data-grp': key,
        children: [head(key, groups[key].length, true), shown.has(key) ? cells(groups[key]) : null]
      }, key) : null))
    ]
  })
}

/** The big score: subagents done / all, one cell per subagent, what the subagents spent. */
function Score({ t, subs }) {
  const done = subs.filter(u => u.status === 'completed').length
  const sum = sumCost(subs.map(u => u.rec))
  const cost = fmtCost(sum.usd, sum.status, t)
  return jsxs('div', {
    className: 'sw-score', role: 'group', 'aria-label': subs.length ? t('sw.score.label', done, subs.length) : t('sw.score.none'),
    children: [
      jsxs('div', {
        className: 'sw-sbig',
        children: [
          jsx('div', { className: 'sw-k', children: t('sw.score.status') }, 'k'),
          // Keyed by the count: a new count mounts anew and rolls up into place.
          jsxs('div', { className: 'sw-big', children: [jsx('span', { className: 'sw-bign', children: done }, `n-${done}`), jsx('small', { children: `/${subs.length}` }, 't')] }, 'b')
        ]
      }, 'b'),
      jsxs('div', {
        className: 'sw-sseg',
        children: [
          jsx('div', { className: 'sw-k', children: subs.length ? t('sw.score.done') : t('sw.score.none') }, 'k'),
          jsx(Cells, { statuses: subs.map(u => u.status), className: 'sw-seg' }, 'c')
        ]
      }, 's'),
      subs.length ? jsxs('div', {
        className: 'sw-spent',
        children: [
          jsx('div', { className: 'sw-k', children: t('sw.score.spent') }, 'k'),
          jsx(Tip, {
            label: t('sw.cost.tip', sum.priced, sum.included, sum.unknown),
            children: jsx('b', { className: 'sw-money', tabIndex: 0, children: cost || '—' })
          }, 'v')
        ]
      }, '$') : null
    ]
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
  const read = []
  for (const f of files || []) {
    const by = f.who || []
    const editors = f.editors || []
    if (!by.includes(who) && !editors.includes(who)) continue
    const edit = editors.includes(who) || (f.last_failed && !editors.length && f.last_op !== 'read')
    const row = { ...f, key: f.key || pathKey(f.path) }
    if (edit) changed.push({ ...row, state: fileState(f, false) })
    else read.push({ ...row, state: 'read' })
  }
  return { changed, read }
}

/** How many times a row's bar counts: its changes, or its reads. */
function fileCount(f) {
  return f.state === 'read' ? f.reads || 1 : (f.writes || 0) + (f.deletes || 0) + (f.failed || 0) || 1
}

function FileRow({ t, f, cwd, max, label, onToast }) {
  const { dir, name } = splitPath(f.path)
  const pct = Math.max(8, Math.round((fileCount(f) / Math.max(1, max)) * 100))
  const text = label || t(`sw.file.op.${f.state}`, fileCount(f))
  const copy = () => writeClip(f.path, t, onToast, t('sw.file.copied'))
  return jsx(Tip, {
    label: t('sw.file.tip', f.path),
    children: jsxs('button', {
      type: 'button', className: `sw-fr${f.state === 'active' ? ' is-now' : ''}`, 'data-op': f.state, onClick: copy,
      'aria-label': t('sw.file.name', name, dir ? dirLabel(dir, cwd, t) : t('sw.file.here'), text),
      children: [
        jsx('span', { className: 'sw-tick', 'aria-hidden': 'true' }, 'k'),
        jsxs('span', {
          className: 'sw-fnw',
          children: [
            // Keyed by the file: when the file worked on changes, its name slides in anew.
            jsx('span', { className: 'sw-fn', children: name }, `n-${f.key}`),
            dir ? jsx('span', { className: 'sw-fd', children: dirLabel(dir, cwd, t) }, 'd') : null
          ]
        }, 'w'),
        jsx('span', { className: 'sw-fbar', 'aria-hidden': 'true', children: jsx('i', { style: { width: `${pct}%` } }) }, 'b'),
        jsx('span', { className: 'sw-fl', children: text }, 'l')
      ]
    })
  })
}

function FileList({ t, sec, title, rows, limit, cwd, onToast, label }) {
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const max = Math.max(...rows.map(fileCount))
  const shown = all ? rows : rows.slice(0, limit)
  return jsxs('div', {
    className: 'sw-fsec', 'data-sec': sec,
    children: [
      jsx('h4', { className: 'sw-k', children: title }, 'h'),
      ...shown.map(f => jsx(FileRow, { t, f, cwd, max, label, onToast }, f.key)),
      rows.length > shown.length
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setAll(true), children: t('sw.focus.more', rows.length - shown.length) }, 'more')
        : null
    ]
  })
}

function Files({ t, mine, files, onToast, empty }) {
  const cwd = files.data?.cwd
  if (files.loading && !files.data) return jsx('p', { className: 'sw-empty', children: t('sw.loading') })
  if (!mine.changed.length && !mine.read.length) {
    return jsxs('div', { className: 'sw-fsec', 'data-sec': 'none', children: [jsx('h4', { className: 'sw-k', children: t('sw.focus.files') }, 'h'), jsx('p', { className: 'sw-empty', children: empty }, 'e')] })
  }
  return [
    jsx(FileList, { t, sec: 'changed', title: t('sw.focus.changed', mine.changed.length), rows: mine.changed, limit: CHANGED_ROWS, cwd, onToast }, 'c'),
    jsx(FileList, { t, sec: 'read', title: t('sw.focus.read', mine.read.length), rows: mine.read, limit: READ_ROWS, cwd, onToast }, 'r')
  ]
}

// ── focus panel ──────────────────────────────────────────────────────────────

function MainPanel({ t, main, files, touching, tool, waitingOn, onToast }) {
  const all = files.data?.files || []
  const mine = agentFiles(all, '')
  const now = fileGroups(all, touching).filter(f => f.state === 'active')
  const verbOf = f => t((touching.get(f.key)?.op || f.last_op) === 'read' ? 'sw.verb.read' : 'sw.verb.edit')
  let head
  // The newest file it touches; keyed by it, so a new file name slides in.
  const newest = now[now.length - 1]
  if (newest) head = [t('sw.focus.main.working', verbOf(newest)), ' ', jsx('code', { className: 'sw-nowf', children: splitPath(newest.path).name }, `c-${newest.key}`)]
  else if (main.status === 'running' && main.act === 'wait') head = t('sw.focus.main.waiting', waitingOn)
  else if (tool) head = [t('sw.focus.main.working', toolVerb(t, tool.name)), tool.target ? ' ' : '', tool.target ? jsx('code', { children: tool.target }, 'c') : null]
  else head = main.status === 'running' ? t('sw.focus.main.busy') : t('sw.focus.main.idle')
  const unreadable = files.data?.unreadable || 0
  const more = files.data?.more || 0
  return jsxs('section', {
    className: 'sw-focus', 'data-kind': 'main', 'data-st': main.status, 'aria-label': t('sw.focus.mainLabel'),
    children: [
      jsx('div', { className: 'sw-ph sw-k', children: t('sw.focus.mainLabel') }, 'l'),
      jsxs('div', { className: 'sw-head', children: [jsx('span', { children: head }, 'h'), main.status === 'running' ? jsx('span', { className: 'sw-cur', 'aria-hidden': 'true' }, 'c') : null] }, 'h'),
      jsx('div', { className: 'sw-meta', children: t('sw.focus.main.touched', mine.changed.length + mine.read.length) }, 'm'),
      now.length ? jsxs('div', {
        className: 'sw-fsec', 'data-sec': 'now',
        children: [
          jsx('h4', { className: 'sw-k', children: t('sw.focus.now') }, 'h'),
          ...now.map(f => jsx(FileRow, { t, f, cwd: files.data?.cwd, max: 1, label: verbOf(f), onToast }, f.key))
        ]
      }, 'now') : null,
      jsx(Files, { t, mine, files, onToast, empty: t('sw.focus.noFiles') }, 'f'),
      more ? jsx('p', { className: 'sw-fnote', children: t('sw.file.notListed', more) }, 'more') : null,
      unreadable ? jsx('p', { className: 'sw-fnote is-bad', children: t('sw.file.unreadable', unreadable) }, 'u') : null,
      jsx('p', { className: 'sw-note', children: t('sw.focus.note') }, 'n')
    ]
  })
}

function SubPanel({ t, u, parentName, files, onToast }) {
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState(false)
  // The backend serves a worker's output only to the chat that delegated it.
  const storedId = useContext(WatchedChat)
  const rec = u.rec || {}
  const sid = u.sid
  const goal = String(rec.goal || '').trim()
  const title = goal.split('\n', 1)[0] || u.name
  const mine = sid ? agentFiles(files.data?.files, sid) : { changed: [], read: [] }
  const time = fmtDuration(u.duration, t)
  const doing = u.status === 'running' && rec.last_tool ? [toolVerb(t, rec.last_tool), shortTarget(rec.tool_preview)].filter(Boolean).join(' ') : ''
  const line = u.status === 'running' ? t('sw.focus.line.running', time, doing)
    : u.status === 'queued' ? t('sw.focus.line.queued')
      : u.status === 'stopped' ? t('sw.focus.line.stopped')
        : t(u.status === 'failed' ? 'sw.focus.line.failed' : 'sw.focus.line.completed', time)
  const ended = TERMINAL.has(u.status)
  const meta = [line, ended ? t('sw.focus.did', mine.changed.length, mine.read.length) : '', parentName ? t('sw.focus.startedBy', parentName) : ''].filter(Boolean).join(' · ')
  const chip = modelChip(rec.model, rec.effort)
  const longTask = goal.length > TASK_CHARS
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
  return jsxs('section', {
    className: 'sw-focus', 'data-kind': 'sub', 'data-st': u.status, 'aria-label': t('sw.focus.subLabel'),
    children: [
      jsx('div', { className: 'sw-ph sw-k', children: t('sw.focus.subLabel') }, 'l'),
      jsx('div', { className: 'sw-head', children: title }, 'h'),
      jsx('div', { className: 'sw-meta', children: meta }, 'm'),
      chip ? jsx(Tip, { label: t('sw.modelTip', rec.model, rec.effort), children: jsx('span', { className: 'sw-model', tabIndex: 0, children: chip }) }, 'chip') : null,
      goal ? jsxs('p', {
        className: 'sw-task',
        children: [
          jsx('b', { children: t('sw.focus.task') }, 'k'), ' — ',
          longTask && !full ? `${goal.slice(0, TASK_CHARS).trimEnd()}…` : goal,
          longTask ? jsx('button', { type: 'button', className: 'sw-more sw-inl', onClick: () => setFull(v => !v), children: t(full ? 'sw.focus.showLess' : 'sw.focus.showAll') }, 'x') : null
        ]
      }, 'task') : null,
      doing && rec.tool_preview && /[\\/]/.test(String(rec.tool_preview)) && !/\s/.test(String(rec.tool_preview).trim())
        ? jsxs('div', {
          className: 'sw-fsec', 'data-sec': 'now',
          children: [
            jsx('h4', { className: 'sw-k', children: t('sw.focus.now') }, 'h'),
            jsx(FileRow, {
              t, f: { key: pathKey(rec.tool_preview), path: String(rec.tool_preview).trim(), state: 'active' }, cwd: files.data?.cwd, max: 1,
              label: toolVerb(t, rec.last_tool), onToast
            }, 'r')
          ]
        }, 'now')
        : null,
      ended ? jsxs('div', {
        className: 'sw-ans',
        children: [
          jsx('div', { className: 'sw-k', children: t('sw.focus.answer') }, 'k'),
          jsx('div', { className: 'sw-anst', children: answer || t('sw.focus.noAnswer') }, 't'),
          rec.summary_truncated ? jsx('div', { className: 'sw-fnote', children: t('sw.focus.answerCut') }, 'c') : null
        ]
      }, 'ans') : null,
      jsx(Files, { t, mine, files, onToast, empty: t('sw.focus.noFilesSub') }, 'f'),
      jsxs('div', {
        className: 'sw-btns',
        children: [
          jsx(IconButton, { label: t(busy ? 'sw.copying' : 'sw.focus.copy'), icon: ICON.copy, onClick: copy, disabled: !sid, busy, text: true, primary: true }, 'c'),
          jsx(IconButton, { label: t('sw.focus.open'), icon: ICON.open, onClick: open, disabled: !sid, text: true }, 'o'),
          jsx('span', { className: 'sw-stats', children: t('sw.focus.meta', rec.tool_calls ?? rec.tool_count ?? 0, fmtTokens(rec.tokens, t), fmtCost(rec.cost_usd, rec.cost_status, t)) }, 'm')
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
        children: [jsx('span', { children: view.name }, 'n'), jsx('span', { className: 'sw-pickv', 'aria-hidden': 'true', children: ICON.chev(true) }, 'v')]
      }, 'p'),
      view.kind === 'live' ? jsx('span', { className: 'sw-ld', 'aria-hidden': 'true' }, 'ld') : null,
      jsx('span', { className: 'sw-runm', children: view.meta }, 'm'),
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

function ProcDetail({ t, p, storedId, onToast }) {
  // Only a finished command's receipt has output; a checkpoint-only row (the app closed under it)
  // has none, and asking for it was a guaranteed 404 shown as a read failure.
  const fetches = p.status !== 'running' && p.has_output !== false
  const [out, setOut] = useState({ loading: fetches, data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!fetches) return undefined
    let alive = true
    setOut({ loading: true, data: null, error: null })
    ctxRef.rest(`/process_output?session_id=${encodeURIComponent(storedId)}&process_id=${encodeURIComponent(p.id)}`).then(
      data => alive && setOut({ loading: false, data, error: null }),
      err => alive && setOut({ loading: false, data: null, error: String(err?.message || err) })
    )
    return () => { alive = false }
  }, [p.id, p.status, storedId, fetches, attempt])
  // The receipt holds the whole command; the list row carries at most COMMAND_CHARS of it.
  const command = out.data?.command || p.command || ''
  const cut = !out.data?.command && p.command_truncated
  const meta = [
    p.status === 'stopped' ? t('sw.proc.killed') : p.exit_code !== null && p.exit_code !== undefined ? t('sw.proc.exit', p.exit_code) : '',
    p.cwd ? t('sw.proc.cwd', p.cwd) : '',
    cut ? t('sw.proc.commandCut', command.length) : ''
  ].filter(Boolean).join(' · ')
  // The row already reads a short one-line command in full; the block is for what it cannot show.
  const showCommand = command !== commandLine(p.command) || command.length > ROW_COMMAND_CHARS || cut
  let body
  if (p.status === 'running') body = jsx('p', { className: 'sw-cmnote', children: t('sw.proc.whileRunning') })
  else if (!fetches) body = jsx('p', { className: 'sw-cmnote', children: t('sw.proc.noOutput') })
  else if (out.loading) body = jsxs('p', { className: 'sw-cmnote sw-cmwait', children: [jsx('span', { className: 'sw-spin', 'aria-hidden': 'true' }, 's'), t('sw.proc.reading')] })
  else if (out.error) {
    body = jsxs('div', {
      className: 'sw-cmerr', role: 'alert',
      children: [
        jsx('p', { children: t('sw.err.withDetail', t('sw.err.procOutput'), out.error) }, 'm'),
        jsx(IconButton, { label: t('sw.retry'), icon: ICON.refresh, onClick: () => setAttempt(n => n + 1), text: true }, 'r')
      ]
    })
  } else if (!out.data?.output) body = jsx('p', { className: 'sw-cmnote', children: t('sw.proc.printedNothing') })
  else {
    body = [
      jsxs('div', {
        className: 'sw-k sw-outl',
        children: [t('sw.proc.output'), out.data.output_truncated ? ` · ${t('sw.proc.outputCut', out.data.output.length)}` : '']
      }, 'l'),
      jsx('pre', { className: 'sw-out', children: out.data.output }, 'o')
    ]
  }
  return jsxs('div', {
    className: 'sw-cmo', 'data-st': p.status,
    children: [
      meta ? jsx('div', { className: 'sw-cmeta', children: meta }, 'm') : null,
      showCommand ? jsx('pre', { className: 'sw-pc', children: command }, 'c') : null,
      body,
      jsxs('div', {
        className: 'sw-btns',
        children: [
          out.data?.output ? jsx(IconButton, { label: t('sw.proc.copyOutput'), icon: ICON.copy, onClick: () => writeClip(out.data.output, t, onToast), text: true, primary: true }, 'o') : null,
          jsx(IconButton, { label: t('sw.proc.copyCommand'), icon: ICON.copy, onClick: () => writeClip(command, t, onToast), text: true }, 'c')
        ]
      }, 'b')
    ]
  })
}

function ProcRow({ t, theme, p, now, open, onToggle, storedId, onToast }) {
  const time = p.status === 'running'
    ? fmtDuration(p.started_at ? now - p.started_at : null, t)
    : p.status === 'stopped' ? '—' : fmtDuration(p.duration_s, t)
  const exit = p.status === 'failed' && p.exit_code !== null && p.exit_code !== undefined ? t('sw.proc.exit', p.exit_code) : ''
  const state = t(`sw.proc.short.${p.status}`)
  return jsxs('div', {
    className: 'sw-cm', 'data-st': p.status,
    children: [
      jsxs('button', {
        type: 'button', className: 'sw-cmr sw-acc', 'data-st': p.status, 'aria-expanded': open, onClick: onToggle,
        'aria-label': `${commandLine(p.command)}: ${t(`sw.proc.status.${p.status}`)}`,
        children: [
          theme === 'terminal'
            ? jsx('span', { className: 'sw-cmt', 'aria-hidden': 'true', children: t(`sw.tag.${p.status === 'running' ? 'run' : p.status}`) }, 't')
            : jsx('span', { className: p.status === 'running' ? 'sw-spin' : 'sw-cmd', 'aria-hidden': 'true' }, 't'),
          jsx(Tip, { label: p.command, children: jsx('code', { className: 'sw-cmc', children: commandLine(p.command) }) }, 'c'),
          jsx('span', { className: 'sw-cmx', children: [state, exit, time].filter(Boolean).join(' · ') }, 'x'),
          jsx('span', { className: 'sw-chev', 'aria-hidden': 'true', children: ICON.chev(open) }, 'v')
        ]
      }, 'h'),
      open ? jsx(ProcDetail, { t, p, storedId, onToast }, `d-${p.status}`) : null
    ]
  })
}

function Commands({ t, theme, procs, now, storedId, openProc, toggleProc, onToast }) {
  const unreadable = procs.data?.unreadable || 0
  const rows = [...(procs.data?.processes || [])].reverse()
  return jsxs('div', {
    className: 'sw-cmds', role: 'tabpanel', id: 'sw-tab-commands', 'aria-labelledby': 'sw-tabb-commands',
    children: [
      jsx('p', { className: 'sw-why', children: t('sw.proc.why') }, 'why'),
      procs.loading
        ? jsxs('p', { className: 'sw-cmnote sw-cmwait', children: [jsx('span', { className: 'sw-spin', 'aria-hidden': 'true' }, 's'), t('sw.loading')] }, 'w')
        : rows.length
          ? jsx('div', {
            className: 'sw-plist',
            children: rows.map(p => jsx(ProcRow, { t, theme, p, now, storedId, onToast, open: openProc.has(p.id), onToggle: () => toggleProc(p.id) }, p.id))
          }, 'l')
          : procs.error ? null : jsx('p', { className: 'sw-empty', children: t('sw.proc.none') }, 'none'),
      unreadable ? jsx('p', { className: 'sw-pu', children: t('sw.proc.unreadable', unreadable) }, 'u') : null
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
export function dirLabel(dir, cwd, t = enT) {
  const d = pathKey(dir)
  const c = cwd ? pathKey(cwd) : ''
  if (c && d === c) return t('sw.file.here')
  if (c && d.startsWith(`${c}/`)) return `./${dir.replace(/\\/g, '/').slice(cwd.replace(/[/\\]+$/, '').length + 1)}`
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
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

/** A set of open card keys: toggle(key) flips one card, clear() folds them all (on chat change), add(keys) opens some. */
function useOpenSet() {
  const [open, setOpen] = useState(() => new Set())
  const toggle = key => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const add = keys => setOpen(prev => new Set([...prev, ...keys]))
  return [open, toggle, () => setOpen(new Set()), add]
}

// Zones whose click makes the app name its MAIN chat as focused although no chat was picked: this
// page's own route tile, other plugin pages and previews. A click in them keeps the watched chat.
const HOLD_PANES = ['route-tile:', 'preview-tile:']

function heldBy(target, pageEl) {
  if (typeof target?.closest !== 'function') return false
  if (pageEl && pageEl.contains(target)) return true
  const zone = target.closest('[data-tree-group]')
  const pane = target.closest('[data-tree-tab]')?.getAttribute('data-tree-tab')
    || zone?.querySelector('[data-tree-tab][aria-selected="true"]')?.getAttribute('data-tree-tab')
    || ''
  return HOLD_PANES.some(p => pane.startsWith(p))
}

/**
 * The chat this page watches. It follows the app's focused chat, except while the last click (or
 * focus move) landed in this page or in another page's tile: there the app falls back to the main
 * chat, and following it made a click on a worker row show another chat's (empty) history.
 */
function useWatchedChat(pageRef) {
  const appRuntime = useValue(host.state.focusedSessionId)
  const appStored = useValue(host.state.focusedStoredSessionId)
  const [watched, setWatched] = useState({ runtimeId: appRuntime, storedId: appStored })
  const held = useRef(false)

  useEffect(() => {
    const onInteract = event => {
      held.current = heldBy(event.target, pageRef.current)
      if (!held.current) {
        setWatched({ runtimeId: host.state.focusedSessionId.get(), storedId: host.state.focusedStoredSessionId.get() })
      }
    }
    window.addEventListener('pointerdown', onInteract, true)
    window.addEventListener('focusin', onInteract, true)
    return () => {
      window.removeEventListener('pointerdown', onInteract, true)
      window.removeEventListener('focusin', onInteract, true)
    }
  }, [])

  useEffect(() => {
    // Decided after the click has run every listener: the app moves its focused chat in its own
    // pointerdown listener, and React can render that before this page's listener has seen the click.
    return ctxRef.setTimeout(() => {
      if (!held.current) setWatched({ runtimeId: host.state.focusedSessionId.get(), storedId: host.state.focusedStoredSessionId.get() })
    }, 0)
  }, [appRuntime, appStored])

  // Held: the page shows another chat than the one the app has focused (see above) — said in the header.
  return { ...watched, held: Boolean(watched.storedId) && watched.storedId !== appStored }
}

const NO_ATOM = { get: () => null, listen: () => () => {} }

export function Page() {
  const t = usePluginI18n(ID)
  const pageRef = useRef(null)
  const [theme, setTheme] = useTheme()
  const watched = useWatchedChat(pageRef)
  const { runtimeId, storedId } = watched
  const busyBy = useValue(host.state.busyBySession || NO_ATOM)
  const history = useHistory(storedId)
  const [tab, setTab] = useState('agents')
  const [selected, setSelected] = useState(MAIN)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [runKey, setRunKey] = useState(null)
  const [refocus, setRefocus] = useState(false)
  const [openProc, toggleProc, clearProcs] = useOpenSet()
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
  const { touching, tool } = useMainTools(runtimeId, files.data?.cwd, files.reload)
  const [toast, setToast] = useState(null)
  const procRows = procs.data?.processes || []
  const procsRunning = procRows.filter(p => p.status === 'running').length
  const now = useNow(live.batches.length > 0 || procsRunning > 0)

  useEffect(() => {
    clearProcs()
    setSelected(MAIN)
    setRunKey(null)
    setRefocus(false)
  }, [storedId])
  // Runs after every render until the moved run is drawn, then hands the focus once to its selected unit.
  useEffect(() => {
    if (!refocus) return
    const el = pageRef.current?.querySelector('button.sw-unit[aria-pressed=true], button.sw-cell[aria-pressed=true], button.sw-frow[aria-pressed=true]')
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
    files.error ? t('sw.err.item', t('sw.err.files'), files.error) : null
  ].filter(Boolean)
  const refreshAll = () => { history.reload(); procs.reload(); files.reload(); live.retry() }
  const chatName = storedId ? history.data?.title || t('sw.chat.untitled', String(storedId).slice(-6)) : ''
  const noChat = !storedId && !runtimeId
  const loading = !noChat && history.loading && !history.data && !live.batches.length
  const nothing = !isLive && !past.length && history.error && procs.error && (files.error || !files.data?.files?.length)
  const swarm = subs.length > SWARM_AT

  let body
  if (noChat) {
    body = jsxs('div', { className: 'sw-hint', children: [jsx('b', { children: t('sw.noChat.title') }, 't'), jsx('span', { children: t('sw.noChat.body') }, 'b'), jsx('span', { className: 'sw-cur', 'aria-hidden': 'true' }, 'c')] })
  } else if (loading) {
    body = jsxs('div', {
      className: 'sw-skel', role: 'status', 'aria-label': t('sw.loading'),
      children: [jsxs('div', { className: 'sw-sks', 'aria-hidden': 'true', children: [0, 1, 2].map(i => jsx('span', { className: 'sw-sk' }, i)) }, 's'), jsx('div', { className: 'sw-k', children: t('sw.loading') }, 'k')]
    })
  } else if (tab === 'commands') {
    body = jsx(Commands, { t, theme, procs, now, storedId, openProc, toggleProc, onToast })
  } else if (nothing) {
    body = jsx('p', { className: 'sw-empty', children: t('sw.allFailed') })
  } else {
    const parentName = sel.parent ? byKey.get(sel.parent)?.name : ''
    body = jsxs('div', {
      className: 'sw-agents', role: 'tabpanel', id: 'sw-tab-agents', 'aria-labelledby': 'sw-tabb-agents',
      children: [
        view ? jsx(RunBar, { t, view, runs, onPick: pickRun, onBack: () => pickRun('now') }, 'run') : null,
        jsx(Score, { t, subs }, 'score'),
        swarm
          ? jsx(Swarm, { t, theme, main, subs, selected: sel.key, onSelect: setSelected, flash, waitingOn: active }, `swarm-${view?.key || 'now'}`)
          : subs.length
            ? jsx(Units, { t, theme, units, selected: sel.key, onSelect: setSelected, flash, waitingOn: active }, 'units')
            : jsxs('div', {
              className: 'sw-solo',
              children: [
                jsx(Units, { t, theme, units: [main], selected: sel.key, onSelect: setSelected, flash, waitingOn: 0 }, 'u'),
                jsx('p', { className: 'sw-nosub', children: t('sw.noSubagents') }, 'p')
              ]
            }, 'solo'),
        sel.main
          ? jsx(MainPanel, { t, main, files, touching: calm ? new Map() : touching, tool: calm ? null : tool, waitingOn: active, onToast }, 'focus-main')
          : jsx(SubPanel, { t, u: sel, parentName, files, onToast }, `focus-${sel.key}`)
      ]
    })
  }

  const tabs = noChat || loading ? null : jsxs('div', {
    className: 'sw-tabs', role: 'tablist', 'aria-label': t('sw.tabs.label'),
    children: ['agents', 'commands'].map(id => jsxs('button', {
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
              // Which chat this is: the page can hold a chat the app no longer has focused.
              chatName ? jsx('span', { className: 'sw-chatn', children: theme === 'terminal' ? `// ${chatName}` : chatName }, 'c') : null,
              watched.held ? jsx(Tip, { label: t('sw.chat.heldTip'), children: jsx('span', { className: 'sw-held', tabIndex: 0, children: theme === 'terminal' ? `[${t('sw.chat.held')}]` : t('sw.chat.held') }) }, 'held') : null,
              // The look toggle is always there: no chat or a pending read is no reason to hide it.
              jsx('div', {
                className: 'sw-tg', role: 'group', 'aria-label': t('sw.theme.label'),
                children: THEMES.map(id => jsx('button', {
                  type: 'button', className: 'sw-tgb', 'data-theme': id, 'aria-pressed': theme === id, onClick: () => setTheme(id), children: t(`sw.theme.${id}`)
                }, id))
              }, 'tg'),
              noChat ? null : jsx(IconButton, { label: t('sw.refresh'), icon: ICON.refresh, onClick: refreshAll, disabled: !storedId }, 'r')
            ]
          }, 'h'),
          tabs,
          errors.length
            ? jsxs('div', {
              className: 'sw-err', role: 'alert',
              children: [
                jsx('b', { className: 'sw-errt', children: t('sw.err.title') }, 't'),
                jsx('ul', { children: errors.map(e => jsx('li', { children: e }, e)) }, 'l'),
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
  // then every POLL_MS while its batch runs. Three failures in a row stop the poll and say so.
  useEffect(() => {
    setStalled(null)
    if (!runtimeId) return undefined
    let alive = true
    let fails = 0
    const poll = async () => {
      if (!alive || fails >= MAX_POLL_FAILS) return
      try {
        const snap = await host.request('subagent.list', { session_id: runtimeId })
        if (!alive) return
        fails = 0
        setStalled(null)
        trackSnapshot(runtimeId, snap?.subagents)
      } catch (err) {
        if (!alive) return
        fails += 1
        console.warn(`[${ID}] progress: subagent.list failed (${fails}/${MAX_POLL_FAILS})`, err)
        if (fails >= MAX_POLL_FAILS) setStalled(String(err?.message || err))
      }
    }
    void poll()
    const stop = live ? ctxRef.setInterval(() => void poll(), POLL_MS) : () => {}
    return () => {
      alive = false
      stop()
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

// The Terminal look's fixed phosphor palette. TERMINAL PALETTE START/END bound the ONLY colour
// literals in this file: audit_static.py allows hex there and nowhere else, and only as custom
// properties. Everything else reads these variables (Terminal) or the app's tokens (Cockpit).
const TM_PALETTE = `
/* TERMINAL PALETTE START */
.sw-page[data-theme=terminal],.sw-sbw[data-theme=terminal]{--tm-bg:#060a06;--tm-raised:#0b140b;--tm-ink:#b8f5b0;--tm-hi:#eaffe6;--tm-name:#d6ffd0;
 --tm-dim:#6f9f69;--tm-line:#1e3a1e;--tm-badline:#5a2020;--tm-run:#ffd166;--tm-bad:#ff6b6b;--tm-ok:#7dff7d;--tm-glow:#4cff4c;--tm-shade:#000000}
/* TERMINAL PALETTE END */
`

// The chip sits in the app's status bar, outside the page: Cockpit takes the app's tokens, Terminal
// its own palette (TM_PALETTE, the one block that may hold colour literals).
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
.sw-sbw[data-theme=terminal] .sw-sb{background:var(--tm-bg);color:var(--tm-ink);font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;box-shadow:inset 0 0 0 1px var(--tm-line);--sw-tint:var(--tm-run)}
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
.sw-page{height:100%;min-height:0;overflow:auto;padding:16px 20px;font-size:12.5px;--mono:ui-monospace,"Cascadia Mono",Consolas,var(--dt-font-mono,monospace)}
.sw-page[data-theme=cockpit]{--a:var(--ui-accent);--ink:var(--ui-text-primary);--dim:var(--ui-text-secondary);--bg:var(--dt-background);
 --run:var(--ui-yellow);--ok:var(--ui-green);--bad:var(--ui-red);--idle:var(--ui-text-tertiary);--line:color-mix(in srgb,var(--a) 42%,transparent);--raised:color-mix(in srgb,var(--a) 8%,var(--bg))}
.sw-page[data-theme=terminal]{--a:var(--tm-ok);--ink:var(--tm-ink);--dim:var(--tm-dim);--bg:var(--tm-bg);
 --run:var(--tm-run);--ok:var(--tm-ok);--bad:var(--tm-bad);--idle:var(--tm-dim);--line:var(--tm-line);--raised:var(--tm-raised)}
.sw-page [data-st=running]{--c:var(--run)}
.sw-page [data-st=completed]{--c:var(--ok)}
.sw-page [data-st=failed]{--c:var(--bad)}
.sw-page [data-st=stopped],.sw-page [data-st=queued],.sw-page [data-st=idle]{--c:var(--idle)}
.sw-panel{position:relative;container-type:inline-size;max-width:860px;margin:0 auto;padding:16px 18px 18px;color:var(--ink);background:var(--bg)}
.sw-page[data-theme=cockpit] .sw-panel{background:radial-gradient(90% 60% at 50% 0%,color-mix(in srgb,var(--a) 12%,transparent),transparent 70%),var(--bg);
 clip-path:polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px)}
.sw-page[data-theme=cockpit] .sw-panel::before{content:"";position:absolute;inset:0;pointer-events:none;clip-path:inherit;box-shadow:inset 0 0 0 1px var(--line)}
.sw-page[data-theme=terminal] .sw-panel{border-radius:8px;font:12.5px/1.6 var(--mono);overflow:hidden;box-shadow:inset 0 0 0 1px var(--line),inset 0 0 60px color-mix(in srgb,var(--tm-shade) 80%,transparent)}
.sw-page[data-theme=terminal] .sw-panel::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:9;
 background:repeating-linear-gradient(0deg,color-mix(in srgb,var(--tm-shade) 25%,transparent) 0 1px,transparent 1px 3px)}
.sw-page :where(button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.sw-page button:focus-visible,.sw-page [tabindex]:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.sw-page button:disabled{opacity:.5;cursor:default}
.sw-k{margin:0;font:600 11.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.sw-page[data-theme=cockpit] .sw-k{color:color-mix(in srgb,var(--a) 55%,var(--ink))}
.sw-page[data-theme=terminal] .sw-k{letter-spacing:0;text-transform:lowercase;font-weight:400}
.sw-cur{display:none}
.sw-page[data-theme=terminal] .sw-cur{display:inline-block;width:8px;height:14px;margin-left:4px;vertical-align:-2px;background:var(--ok);box-shadow:0 0 8px var(--ok);animation:sw-blink 1.06s steps(1) infinite}
/* header */
.sw-hd{display:flex;align-items:center;gap:10px;min-width:0}
.sw-ht{flex:none;margin:0;font:700 13px var(--mono);letter-spacing:.2em;text-transform:uppercase;white-space:nowrap}
.sw-page[data-theme=terminal] .sw-ht{letter-spacing:0;color:var(--tm-hi);text-shadow:0 0 8px var(--tm-glow)}
.sw-chatn{min-width:0;flex:0 1 auto;font-size:12.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page[data-theme=terminal] .sw-chatn{text-transform:lowercase}
.sw-held{flex:none;font:600 11.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:0 6px;color:var(--ink);background:color-mix(in srgb,var(--a) 22%,var(--bg));box-shadow:inset 0 0 0 1px var(--a)}
.sw-page[data-theme=terminal] .sw-held{background:none;color:var(--run);letter-spacing:0}
.sw-tg{margin-left:auto;display:flex;flex:none;font:11.5px var(--mono);letter-spacing:.08em}
.sw-tgb{padding:3px 8px;text-transform:uppercase;color:var(--dim);box-shadow:inset 0 0 0 1px var(--line)}
.sw-tgb[aria-pressed=true]{color:var(--ink);background:color-mix(in srgb,var(--a) 22%,transparent)}
.sw-page[data-theme=terminal] .sw-tgb{box-shadow:none;padding:0 6px}
.sw-page[data-theme=terminal] .sw-tgb[aria-pressed=true]{color:var(--bg);background:var(--ink)}
.sw-ib{display:inline-grid;place-items:center;width:26px;height:26px;color:var(--dim);box-shadow:inset 0 0 0 1px var(--line)}
.sw-hd>.sw-ib{flex:none;margin-left:auto}
.sw-hd>.sw-tg+.sw-ib{margin-left:0}
.sw-ib svg{width:14px;height:14px}
.sw-ib:hover{color:var(--ink);background:color-mix(in srgb,var(--a) 12%,transparent)}
.sw-ib.is-text{display:inline-flex;gap:6px;width:auto;height:auto;padding:5px 10px;font:12px var(--mono);letter-spacing:.04em;color:var(--ink)}
.sw-ib.is-pri{background:color-mix(in srgb,var(--a) 20%,transparent)}
.sw-ib.is-busy{opacity:.7}
.sw-ibi{display:inline-flex;width:13px;height:13px}
.sw-ibi svg{width:100%;height:100%}
.sw-page[data-theme=terminal] .sw-ib{box-shadow:none;color:var(--ok)}
.sw-page[data-theme=terminal] .sw-ib.is-text::before{content:"["}
.sw-page[data-theme=terminal] .sw-ib.is-text::after{content:"]"}
.sw-page[data-theme=terminal] .sw-ib.is-text{padding:0;gap:4px;text-transform:lowercase;letter-spacing:0;color:var(--ok)}
.sw-page[data-theme=terminal] .sw-ib.is-text .sw-ibi{display:none}
.sw-page[data-theme=terminal] .sw-ib.is-pri{background:none}
/* tabs */
.sw-tabs{display:flex;gap:18px;margin:12px 0;border-bottom:1px solid color-mix(in srgb,var(--a) 25%,transparent)}
.sw-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 0;margin-bottom:-1px;font:12px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid transparent!important}
.sw-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--a)!important}
.sw-tabn{padding:0 5px;font-size:11.5px;letter-spacing:0;background:var(--run);color:var(--bg)}
.sw-page[data-theme=terminal] .sw-tabs{border-bottom-color:var(--line)}
.sw-page[data-theme=terminal] .sw-tab{letter-spacing:0;text-transform:lowercase;border-bottom:0!important}
.sw-page[data-theme=terminal] .sw-tab[aria-selected=true]{color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-tab[aria-selected=true]::before{content:"▸"}
.sw-page[data-theme=terminal] .sw-tabn{background:none;color:var(--run)}
.sw-page[data-theme=terminal] .sw-tabn::before{content:"("}
.sw-page[data-theme=terminal] .sw-tabn::after{content:")"}
/* alert, empty states */
.sw-err{margin:0 0 12px;padding:10px 12px;font-size:12.5px;line-height:1.45;background:color-mix(in srgb,var(--bad) 10%,var(--bg));border-left:3px solid var(--bad)}
.sw-err ul{margin:2px 0 8px;padding-left:16px;color:var(--ink)}
.sw-page[data-theme=terminal] .sw-err{background:var(--bg);border:1px solid var(--tm-badline)}
.sw-errt{font-weight:600}
.sw-hint{display:flex;flex-direction:column;align-items:center;gap:4px;padding:26px 8px;text-align:center;color:var(--dim)}
.sw-hint b{font:600 13px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink)}
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
.sw-pick{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;color:var(--ink)!important;font:12px var(--mono)!important;letter-spacing:.06em;text-transform:uppercase;box-shadow:inset 0 0 0 1px var(--line)}
.sw-pickv{display:inline-flex;width:12px;height:12px}.sw-pickv svg{width:100%;height:100%}
.sw-page[data-theme=terminal] .sw-pick{padding:0;box-shadow:none;text-transform:lowercase;letter-spacing:0}
.sw-page[data-theme=terminal] .sw-pick::before{content:"run:";color:var(--tm-hi)}
.sw-ld{width:7px;height:7px;flex:none;background:var(--run);box-shadow:0 0 8px var(--run);transform:rotate(45deg);animation:sw-pulse 1.6s ease-in-out infinite}
.sw-runm{min-width:0}
.sw-back{margin-left:auto;font:12px var(--mono)!important;letter-spacing:.08em;text-transform:uppercase;color:var(--ink)!important;padding:3px 8px!important;box-shadow:inset 0 0 0 1px var(--a)}
.sw-page[data-theme=terminal] .sw-back{box-shadow:none;text-transform:lowercase;letter-spacing:0;color:var(--ok)!important;padding:0!important}
.sw-page[data-theme=terminal] .sw-back::before{content:"[← "}.sw-page[data-theme=terminal] .sw-back::after{content:"]"}
.sw-menu{position:absolute;z-index:8;left:0;top:calc(100% + 6px);width:min(380px,100%);padding:6px;background:var(--raised);color:var(--ink);
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
.sw-more{display:block;margin:4px 0 0 14px;font:12px var(--mono)!important;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)!important;text-decoration:underline;text-decoration-color:var(--a);text-underline-offset:3px}
.sw-more.sw-inl{display:inline;margin:0 0 0 6px}
.sw-page[data-theme=terminal] .sw-more{text-transform:lowercase;letter-spacing:0;text-decoration:none;color:var(--ok)!important}
.sw-page[data-theme=terminal] .sw-more::before{content:"[+] "}
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
.sw-page[data-theme=terminal] .sw-big{font-size:24px;text-shadow:0 0 8px var(--tm-glow);color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-seg{gap:0;height:12px}
.sw-page[data-theme=terminal] .sw-seg i{transform:none}
.sw-page[data-theme=terminal] .sw-money{font-size:14px;color:var(--tm-hi)}
/* units: Cockpit hexes */
.sw-units{display:flex;justify-content:space-around;flex-wrap:wrap;row-gap:12px;margin:20px 0 4px}
.sw-unit{width:96px;display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center!important;padding:4px 0!important}
.sw-hex{position:relative;width:60px;height:66px;display:grid;place-items:center;margin:8px 0 2px}
.sw-ring{position:absolute;inset:-6px -3px;border-radius:50%;background:repeating-conic-gradient(var(--c) 0 8deg,transparent 8deg 15deg);
 -webkit-mask:radial-gradient(circle,transparent 35px,var(--a) 36px 38px,transparent 39px);mask:radial-gradient(circle,transparent 35px,var(--a) 36px 38px,transparent 39px)}
.sw-unit[data-st=running] .sw-ring{animation:sw-rot 9s linear infinite}
.sw-unit[data-st=completed] .sw-ring,.sw-unit[data-st=failed] .sw-ring{background:var(--c)}
.sw-unit[data-st=queued] .sw-ring,.sw-unit[data-st=idle] .sw-ring{opacity:.4}
.sw-body{position:absolute;inset:3px 5px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 45%,var(--bg)),var(--bg) 78%)}
.sw-body::after{content:"";position:absolute;inset:2px;clip-path:inherit;background:color-mix(in srgb,var(--c) 6%,var(--bg))}
.sw-ic{position:relative;z-index:1;width:22px;height:22px;color:var(--ink);filter:drop-shadow(0 0 6px var(--c))}
.sw-ic svg{width:100%;height:100%;display:block}
.sw-maintag{position:absolute;top:-6px;right:-14px;z-index:2;font:700 11.5px var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:0 4px;color:var(--ink);background:color-mix(in srgb,var(--a) 22%,var(--bg));box-shadow:inset 0 0 0 1px var(--a)}
.sw-page[data-theme=terminal] .sw-maintag{background:var(--a);color:var(--bg);box-shadow:none}
.sw-unit.is-sel .sw-hex::before{content:"";position:absolute;inset:-12px -18px -7px;border:1.5px solid var(--a);
 -webkit-mask:conic-gradient(var(--a) 0 0) 0 0/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 100% 0/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 0 100%/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 100% 100%/14px 14px no-repeat;
 mask:conic-gradient(var(--a) 0 0) 0 0/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 100% 0/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 0 100%/14px 14px no-repeat,conic-gradient(var(--a) 0 0) 100% 100%/14px 14px no-repeat}
.sw-un{max-width:100%;font-size:12.5px;font-weight:600;line-height:15px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.sw-us{font:11.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:color-mix(in srgb,var(--c) 55%,var(--ink));white-space:nowrap}
.sw-unit[data-main][data-st=running] .sw-hex{animation:sw-breathe 2.8s ease-in-out infinite}
.sw-unit.is-done .sw-ring{animation:sw-close .9s ease-out}
.sw-unit.is-done .sw-hex{filter:drop-shadow(0 0 14px var(--ok))}
.sw-unit.is-fail,.sw-frow.is-fail{animation:sw-shake .5s ease-in-out 2}
.sw-unit.is-fail .sw-hex{filter:drop-shadow(0 0 14px var(--bad))}
.sw-unit:hover .sw-un{color:var(--ink)}
/* units: Terminal sprites */
.sw-page[data-theme=terminal] .sw-units{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:12px 0}
.sw-page[data-theme=terminal] .sw-unit{width:auto;min-width:0;padding:8px 4px 6px!important;gap:2px;border:1px solid var(--line)}
.sw-page[data-theme=terminal] .sw-unit.is-sel{border-color:var(--ok);box-shadow:0 0 12px color-mix(in srgb,var(--ok) 25%,transparent),inset 0 0 12px color-mix(in srgb,var(--ok) 12%,transparent)}
.sw-spr{margin:0;font:12px/1.05 var(--mono);white-space:pre;color:var(--c)}
.sw-page[data-theme=terminal] .sw-un{margin-top:4px;font:11.5px/1.3 var(--mono);color:var(--tm-name)}
.sw-page[data-theme=terminal] .sw-us{letter-spacing:0;color:var(--c);animation:sw-type .6s steps(6,end)}
.sw-page[data-theme=terminal] .sw-unit[data-main][data-st=running] .sw-spr{animation:sw-breathe 2.8s ease-in-out infinite}
.sw-solo{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sw-solo .sw-units{flex:none;margin:12px 0 4px}
.sw-nosub{flex:1;min-width:160px;margin:0;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-solo .sw-units{grid-template-columns:120px}
/* swarm */
.sw-grp{margin-top:14px}
.sw-gmain .sw-units,.sw-gmain{display:flex;justify-content:flex-start}
.sw-gh{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.sw-gh em{font-style:normal;color:var(--ink);letter-spacing:0}
.sw-fold{margin-left:auto;font:11.5px var(--mono)!important;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)!important;text-decoration:underline;text-decoration-color:var(--a);text-underline-offset:3px}
.sw-cellgrid{display:flex;flex-wrap:wrap;gap:6px}
.sw-cell{width:30px;height:33px;display:grid!important;place-items:center;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:color-mix(in srgb,var(--c) 70%,var(--bg))!important}
.sw-cell::after{content:"";width:26px;height:29px;clip-path:inherit;background:color-mix(in srgb,var(--c) 14%,var(--bg));grid-area:1/1}
.sw-cell svg,.sw-cell .sw-glyph{grid-area:1/1;width:14px;height:14px;z-index:1;color:var(--ink)}
.sw-cell.is-sel{background:var(--ink)!important}
.sw-page[data-theme=terminal] .sw-cell{clip-path:none;width:22px;height:22px;background:none!important;border:1px solid var(--line)}
.sw-page[data-theme=terminal] .sw-cell::after{display:none}
.sw-page[data-theme=terminal] .sw-cell .sw-glyph{width:auto;height:auto;font:12px/1 var(--mono);color:var(--c)}
.sw-page[data-theme=terminal] .sw-cell.is-sel{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)!important}
.sw-frow{display:flex;align-items:center;gap:10px;width:100%;padding:5px 10px!important;margin-bottom:4px;font-size:12.5px;border-left:3px solid var(--c)!important;background:color-mix(in srgb,var(--c) 8%,transparent)!important}
.sw-frow.is-sel{box-shadow:inset 0 0 0 1px var(--a)}
.sw-frn{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-frx{flex:none;font:11.5px var(--mono);color:var(--dim)}
.sw-page[data-theme=terminal] .sw-frow{border-left:0!important;background:none!important;padding:0 0 0 12px!important;margin:0}
/* focus panel */
.sw-focus{position:relative;margin-top:18px;padding:14px 16px;background:color-mix(in srgb,var(--a) 5%,var(--bg))}
.sw-page[data-theme=cockpit] .sw-focus{clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px))}
.sw-page[data-theme=cockpit] .sw-focus::before{content:"";position:absolute;inset:0;clip-path:inherit;box-shadow:inset 0 0 0 1px var(--line);pointer-events:none}
.sw-page[data-theme=terminal] .sw-focus{background:var(--bg);border:1px solid var(--line);padding:8px 12px}
.sw-page[data-theme=terminal] .sw-focus[data-st=failed]{border-color:var(--tm-badline)}
.sw-ph{display:flex;align-items:center;gap:10px}
.sw-ph::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--a) 50%,transparent),transparent)}
.sw-head{margin:8px 0 2px;font-size:16px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.sw-head code{font-family:var(--mono);text-shadow:0 0 10px var(--c,var(--run))}
.sw-nowf{display:inline-block;animation:sw-slide .45s ease-out}
.sw-page[data-theme=terminal] .sw-head{font-size:12.5px;color:var(--tm-hi)}
.sw-page[data-theme=terminal] .sw-head::before{content:"> ";color:var(--dim)}
.sw-meta{font-size:12.5px;color:var(--dim);overflow-wrap:anywhere}
.sw-model{display:inline-block;max-width:100%;margin-top:4px;font:11.5px var(--mono);padding:1px 6px;box-shadow:inset 0 0 0 1px var(--line);color:var(--dim);white-space:nowrap}
.sw-task{margin:10px 0 0;font-size:13px;line-height:1.45;color:var(--dim);overflow-wrap:anywhere;white-space:pre-line}
.sw-task b{color:var(--ink)}
.sw-ans{margin-top:12px;padding:10px 12px;background:color-mix(in srgb,var(--c) 8%,var(--bg));border-left:3px solid var(--c);font-size:13px;line-height:1.5}
.sw-anst{white-space:pre-line;overflow-wrap:anywhere}
.sw-page[data-theme=terminal] .sw-ans{background:none;border-left:0;padding:4px 0;font-size:12.5px}
.sw-fsec{margin-top:14px}
.sw-fsec>.sw-k{margin-bottom:4px}
.sw-fr{display:grid!important;grid-template-columns:4px minmax(0,1fr) 100px 76px;gap:10px;align-items:center;width:100%;min-height:28px;font:12.5px var(--mono)!important;--c:var(--a)}
.sw-fr[data-op=active]{--c:var(--run)}
.sw-fr[data-op=failed]{--c:var(--bad)}
.sw-fr[data-op=delete]{--c:var(--idle)}
.sw-fr[data-op=read]{--c:color-mix(in srgb,var(--a) 45%,var(--idle))}
.sw-fr:hover{background:color-mix(in srgb,var(--a) 10%,transparent)!important}
.sw-fr.is-now{background:linear-gradient(90deg,color-mix(in srgb,var(--run) 18%,transparent),transparent)!important}
.sw-fr.is-now .sw-fn{animation:sw-slide .45s ease-out}
.sw-tick{height:16px;background:var(--c)}
.sw-fnw{display:flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden;white-space:nowrap}
.sw-fn{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sw-fr[data-op=delete] .sw-fn{text-decoration:line-through}
.sw-fd{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dim)}
.sw-fbar{height:5px;background:color-mix(in srgb,var(--a) 14%,transparent)}
.sw-fbar i{display:block;height:100%;background:var(--c);box-shadow:0 0 8px var(--c)}
.sw-fl{text-align:right;color:var(--dim);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-page[data-theme=terminal] .sw-fr{grid-template-columns:minmax(0,1fr) 72px;gap:8px;min-height:20px;padding-left:12px!important}
.sw-page[data-theme=terminal] .sw-tick,.sw-page[data-theme=terminal] .sw-fbar{display:none}
.sw-page[data-theme=terminal] .sw-fl{text-transform:lowercase;letter-spacing:0}
.sw-page[data-theme=terminal] .sw-fr[data-op=failed] .sw-fl{color:var(--bad)}
.sw-page[data-theme=terminal] .sw-fr.is-now{color:var(--run);background:none!important}
.sw-fnote{margin:6px 0 0;font-size:12px;color:var(--dim)}
.sw-note{margin:12px 0 0;font-size:12px;line-height:1.45;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-note::before{content:"# "}
.sw-btns{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.sw-stats{margin-left:auto;font:11.5px var(--mono);color:var(--dim)}
/* commands */
.sw-why{margin:0 0 12px;color:var(--dim)}
.sw-page[data-theme=terminal] .sw-why::before{content:"# "}
.sw-cm{margin-bottom:6px}
.sw-cmr{display:flex!important;align-items:center;gap:10px;width:100%;padding:9px 12px!important;font:12.5px var(--mono)!important;background:color-mix(in srgb,var(--c) 5%,transparent)!important;border-left:3px solid var(--c)!important}
.sw-cmc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit}
.sw-cmx{flex:none;font-size:11.5px;letter-spacing:.06em;color:var(--dim);white-space:nowrap}
.sw-cmd{width:8px;height:8px;flex:none;background:var(--c);transform:rotate(45deg)}
.sw-cmt{flex:none;color:var(--c)}
.sw-chev{display:inline-flex;width:12px;height:12px;flex:none;color:var(--dim)}
.sw-chev svg{width:100%;height:100%}
.sw-page .sw-spin{display:inline-block;width:11px;height:11px;flex:none;border-radius:50%;border:2px solid var(--run);border-right-color:transparent;animation:sw-rot 1s linear infinite;vertical-align:-1px;margin-right:6px}
.sw-cmo{padding:10px 12px 12px 15px;border-left:3px solid var(--c);background:color-mix(in srgb,var(--c) 3%,var(--bg))}
.sw-cmeta{font:11.5px var(--mono);letter-spacing:.06em;color:var(--dim);overflow-wrap:anywhere}
.sw-cmnote{margin:6px 0 0;color:var(--dim)}
.sw-cmerr{margin-top:6px;padding:8px 10px;background:color-mix(in srgb,var(--bad) 10%,var(--bg));border-left:3px solid var(--bad)}
.sw-cmerr p{margin:0 0 6px}
.sw-outl{margin-top:8px}
.sw-out,.sw-pc{margin:6px 0 0;padding:8px 10px;max-height:240px;overflow:auto;background:var(--bg);font:12px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:inset 0 0 0 1px var(--line)}
.sw-pu{margin:8px 0 0;color:var(--dim)}
.sw-pu::before{content:"⚠ ";color:var(--run)}
.sw-page[data-theme=terminal] .sw-cmr{background:none!important;border-left:0!important;padding:2px 0!important}
.sw-page[data-theme=terminal] .sw-cmx{letter-spacing:0;text-transform:lowercase}
.sw-page[data-theme=terminal] .sw-cmo{border:1px solid var(--line);background:none;margin:4px 0 6px}
.sw-page[data-theme=terminal] .sw-cmo[data-st=failed]{border-color:var(--tm-badline)}
/* toast */
.sw-live{position:absolute;right:20px;top:92px;z-index:10;pointer-events:none}
.sw-toast{padding:8px 10px;font-size:12.5px;background:var(--raised);color:var(--ink);box-shadow:0 8px 24px color-mix(in srgb,var(--bg) 60%,transparent),inset 0 0 0 1px var(--a)}
.sw-toast.is-bad{box-shadow:0 8px 24px color-mix(in srgb,var(--bg) 60%,transparent),inset 0 0 0 1px var(--bad)}
/* narrow: docked beside the chat */
@container (max-width:460px){
 .sw-panel .sw-units{justify-content:flex-start;column-gap:2px}
 .sw-panel .sw-unit{width:84px}
 .sw-panel .sw-fr{grid-template-columns:4px minmax(0,1fr) 48px 64px;gap:8px}
 .sw-panel .sw-fd{display:none}
 .sw-panel .sw-big{font-size:30px}
 .sw-panel .sw-tabs{gap:14px}
 .sw-panel .sw-hd{flex-wrap:wrap;row-gap:6px}
}
@container (max-width:460px){.sw-page[data-theme=terminal] .sw-panel .sw-fr{grid-template-columns:minmax(0,1fr) 64px}}
/* calm: an earlier run is history, not live — no glow, nothing moves */
.sw-panel[data-calm] *,.sw-panel[data-calm] *::before,.sw-panel[data-calm] *::after{animation:none!important}
.sw-panel[data-calm] .sw-ic{filter:none}
.sw-panel[data-calm] .sw-big{text-shadow:none}
/* motion */
@keyframes sw-rot{to{transform:rotate(360deg)}}
@keyframes sw-breathe{50%{transform:scale(1.05);opacity:.86}}
@keyframes sw-close{from{transform:scale(1.18);opacity:.4}}
@keyframes sw-shake{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@keyframes sw-up{from{transform:translateY(60%);opacity:0}}
@keyframes sw-slide{from{transform:translateX(-10px);opacity:0}}
@keyframes sw-type{from{clip-path:inset(0 100% 0 0)}}
@keyframes sw-blink{50%{opacity:0}}
@keyframes sw-pulse{50%{opacity:.45}}
@keyframes sw-skp{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.sw-page *,.sw-page *::before,.sw-page *::after{animation:none!important;transition:none!important}}
`

function navLabel() {
  const viaApp = ctxRef?.i18n?.t?.('sw.title')
  return viaApp && viaApp !== 'sw.title' ? viaApp : BUNDLES.en.sw.title
}

export default {
  id: ID,
  name: 'Subagent Watch',
  register(ctx) {
    ctxRef = ctx
    // The kept look is read again from this ctx's storage.
    themeNow = null
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
