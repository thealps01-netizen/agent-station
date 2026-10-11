/**
 * Subagent Watch — read-only page for delegate_task workers of the focused chat.
 *
 *   Deck     the running batch (with none running, the last one) as a command deck: one big score
 *            (agents finished / all), a status cell per agent, the cost so far, and one unit per
 *            agent — its letter in an orb whose ring is its status, and what it does right now.
 *            Each agent keeps that letter and colour on its files and in the live log. Fed by gateway
 *            `subagent.*` events for the focused runtime session, reconciled by a `subagent.list`
 *            poll (the RPC is session-scoped, so other chats never leak in).
 *   Live log what the agents did while the page was open, newest first (events only, never stored).
 *   Earlier  the other finished batches as a collapsed list, from this plugin's backend
 *            (dashboard/plugin_api.py, state.db opened read-only). A worker row opens a detail with
 *            its answer, "copy full output" and "open session".
 *   Background commands
 *            shell commands the agent started with terminal(background=true), running and finished,
 *            from the backend's /processes (Hermes' own processes.json + process-results receipts).
 *            A row opens the full command, its exit code and the end of its output.
 *
 *   Progress the focused chat's running batch as a status-bar chip (finished/total, a bar, the cost
 *            so far) and, when a pet is on screen, as a line in the pet's speech bubble. Fed by the
 *            same events through a small tracker of its own, so it shows while the page is closed.
 *   Cost     each worker's spend as Hermes recorded it in state.db (estimated / billed / in a
 *            subscription / not priced) — shown, never computed or guessed here.
 *   Files    the files the chat and its workers read or wrote with the file tools, grouped by
 *            folder, from the backend's /files (the tool calls state.db recorded). A file the agent is
 *            touching right now shimmers, fed by the focused chat's tool.start / tool.complete events.
 *            Edits made through terminal commands or code runs carry no path and are not listed: the
 *            section says so and points to Review › Last turn, which lists every change.
 *
 * Nothing here writes: no interrupt, no steer (the composer status stack already owns those).
 * Every failed read is shown in the page; nothing is swallowed.
 */
import { ErrorState, host, Loader, PanelEmpty, STATUSBAR_AREAS, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'subagent-watch'
const ROUTE = '/subagent-watch'
const POLL_MS = 3000
const MAX_POLL_FAILS = 3
const HISTORY_PAGE = 8
// A stored batch still reading "running" is the live tree only when it started around the same time:
// one that started well before the live tree began is a crashed run and stays under Earlier.
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
// Wire statuses (tui_gateway/contracts/common.py SubagentStatus) -> the five marks this page draws.
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
// A file tool call takes milliseconds: the shimmer stays this long after it ends, or nobody sees it.
const TOUCH_LINGER_MS = 4000
// Files listed before "N more"; a folder path longer than this is cut from the left (the end names it).
const FILES_PAGE = 40
const DIR_CHARS = 48

let ctxRef = null
// The stored id of the chat the page watches (see useWatchedChat), for reads deep in the tree.
const WatchedChat = createContext(null)

const BUNDLES = {
  en: {
    sw: {
      title: 'Subagents',
      running: (workers, commands) => [
        workers ? `${workers} worker${workers === 1 ? '' : 's'}` : '',
        commands ? `${commands} command${commands === 1 ? '' : 's'}` : ''
      ].filter(Boolean).join(' · ') + ' running',
      chat: {
        untitled: id => `Chat …${id}`,
        held: 'held',
        heldTip: 'Showing the chat you last used here. Click a chat to follow it.'
      },
      retry: 'Try again',
      nothingToCopy: 'Nothing to copy — the output is empty',
      nBatches: n => `${n} batch${n === 1 ? '' : 'es'}`,
      nWorkers: n => `${n} worker${n === 1 ? '' : 's'}`,
      countFailed: 'Unknown — its source could not be read',
      earlier: 'Earlier',
      older: n => `${n} older`,
      waiting: 'waiting',
      deck: {
        finished: 'agents finished',
        lastRun: 'finished in the last run',
        label: (done, total) => `${done} of ${total} agents finished`,
        spent: 'spent so far',
        legend: { running: 'working', failed: 'failed or stopped', queued: 'waiting' }
      },
      unit: {
        st: { running: 'working', completed: 'done', failed: 'failed', stopped: 'stopped', queued: 'waiting' },
        thinking: 'thinking…',
        queued: 'in the queue',
        completed: 'finished',
        failed: 'ended with an error',
        stopped: 'closed before it finished',
        touched: (edited, opened) => [
          edited ? `edited ${edited} file${edited === 1 ? '' : 's'}` : '',
          opened ? `opened ${opened}` : ''
        ].filter(Boolean).join(' · '),
        from: letter => `from ${letter}`
      },
      verb: {
        read: 'reading', write: 'writing', edit: 'editing', search: 'searching', run: 'running a command',
        code: 'running code', delegate: 'starting agents', web: 'on the web', other: name => `using ${name}`
      },
      id: { chat: 'Chat', chatName: 'this chat (the main agent)', other: 'an agent not on this page', otherLetter: '·' },
      log: {
        title: 'Live log',
        tip: 'What the agents of this chat did while this page was open, newest first.',
        now: 'now', start: 'started', completed: 'finished', failed: 'failed', stopped: 'stopped'
      },
      status: {
        completed: 'Done', failed: 'Failed', running: 'Running', queued: 'Queued',
        stopped: 'Stopped — closed before it finished'
      },
      batch: n => `${n} worker${n === 1 ? '' : 's'}`,
      modelTip: (model, effort) => (effort ? `${model} · reasoning effort ${effort}` : model),
      more: n => `+${n} more`,
      meta: (tools, tokens, cost) => [`${tools} tool${tools === 1 ? '' : 's'}`, tokens ? `${tokens} tokens` : '', cost || ''].filter(Boolean).join(' · '),
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
      copy: 'Copy full output',
      copying: 'Copying…',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      open: 'Open session',
      refresh: 'Refresh',
      procs: 'Background commands',
      nProcs: n => `${n} background command${n === 1 ? '' : 's'}`,
      proc: {
        status: {
          running: 'Running', completed: 'Finished (exit 0)', failed: 'Failed', stopped: 'Stopped before it finished'
        },
        exit: c => `exit ${c}`,
        killed: 'killed',
        cwd: d => `in ${d}`,
        copyCommand: 'Copy command',
        output: 'End of output',
        outputCut: n => `last ${n} characters`,
        commandCut: n => `Only the first ${n} characters of this command are shown and copied.`,
        noOutput: 'No output was recorded.',
        whileRunning: 'The output is shown here when the command finishes.',
        notSubagent: 'Shell commands the agent started in the background (not subagents).',
        unreadable: n => `${n} record${n === 1 ? '' : 's'} could not be read`
      },
      files: {
        title: 'Files',
        tip: 'Files this chat and its agents read or wrote with the file tools. The badge says who; a brighter tile was touched more. Click a file to copy its path.',
        touched: n => `${n} touched`,
        now: 'now',
        by: names => `by ${names}`,
        blind: 'File tools only: edits made by terminal commands or code runs are not listed. Review › Last turn shows every change.',
        op: {
          active: 'Being worked on now', write: 'Edited', delete: 'Deleted', read: 'Read only', failed: 'Last change failed'
        },
        counts: (reads, writes, deletes, failed) => [
          reads ? `read ${reads}×` : '',
          writes ? `edited ${writes}×` : '',
          deletes > 1 ? `deleted ${deletes}×` : deletes ? 'deleted' : '',
          failed ? `${failed} failed` : ''
        ].filter(Boolean).join(' · '),
        here: 'chat folder',
        copied: 'Path copied',
        more: n => `${n} more file${n === 1 ? '' : 's'}`,
        notListed: n => `${n} older file${n === 1 ? '' : 's'} not listed`,
        unreadable: n => `${n} call${n === 1 ? '' : 's'} could not be read`
      },
      noChat: { title: 'No chat selected', body: 'Open a chat to see its subagents.' },
      empty: { title: 'No subagents yet', body: 'Workers started with delegate_task in this chat appear here.' },
      err: {
        history: 'Could not read earlier batches',
        live: 'Live updates stopped',
        output: 'Could not read the full output',
        procs: 'Could not read background commands',
        files: 'Could not read the files list',
        procOutput: 'Could not read the command output',
        withDetail: (what, detail) => `${what}: ${detail}`,
        hint: 'Nothing could be read. Use Try again in the box above.'
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
 * Names for sibling rows: when several share a long opening ('Blind-review desktop panel 1: …',
 * '… panel 2: …') a narrow pane cuts them all to the same text. The shared words are dropped (the
 * last one kept for context) so what tells the rows apart is what stays visible.
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

/** Model slug without a provider prefix: 'anthropic/claude-opus-5-5' -> 'claude-opus-5-5'. */
export function modelLabel(model) {
  return String(model || '').split('/').pop()
}

/** Chip text: the model label, then the reasoning effort when the worker ran with one. */
export function modelChip(model, effort) {
  const m = modelLabel(model)
  return m && effort ? `${m} · ${effort}` : m
}

// Full goal lives in the name's tooltip: the row stays one line, the purpose is one hover away.
// The chip keeps its full width; the name is what ellipsizes.
function NameBlock({ t, goal, model, effort, name }) {
  const chip = modelChip(model, effort)
  return jsxs('span', {
    className: 'sw-nl',
    children: [
      jsx(Tip, { label: String(goal || '').trim(), children: jsx('span', { className: 'sw-wn', children: name || workerName(goal) }) }, 'n'),
      chip ? jsx(Tip, { label: t('sw.modelTip', String(model), effort), children: jsx('span', { className: 'sw-model', children: chip }) }, 'm') : null
    ]
  })
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

// ── marks ────────────────────────────────────────────────────────────────────

const svg = (children, cls) => jsx('svg', { viewBox: '0 0 16 16', className: cls, 'aria-hidden': 'true', children })
// Ink of the check / cross drawn ON a filled tone disc: the page ground itself, a cut-out that is
// neither a success nor a failure token and follows every skin.
const GLYPH_INK = 'var(--dt-background)'
const MARKS = {
  completed: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--ui-green)' }, 'c'),
    jsx('path', {
      d: 'M4.8 8.2l2.1 2.1 4.3-4.4', fill: 'none', stroke: GLYPH_INK, strokeWidth: 2,
      strokeLinecap: 'round', strokeLinejoin: 'round'
    }, 'p')
  ]),
  failed: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--ui-red)' }, 'c'),
    jsx('path', { d: 'M5.5 5.5l5 5M10.5 5.5l-5 5', stroke: GLYPH_INK, strokeWidth: 2, strokeLinecap: 'round' }, 'p')
  ]),
  stopped: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'var(--ui-text-tertiary)', strokeWidth: 1.6 }, 'c'),
    jsx('rect', { x: 5.6, y: 5.6, width: 4.8, height: 4.8, rx: 1, fill: 'var(--ui-text-tertiary)' }, 'r')
  ]),
  running: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'var(--ui-stroke-secondary)', strokeWidth: 1.8 }, 'c'),
    jsx('path', { d: 'M8 1.8a6.2 6.2 0 0 1 6.2 6.2', fill: 'none', stroke: 'var(--ui-yellow)', strokeWidth: 1.8, strokeLinecap: 'round' }, 'a'),
    jsx('circle', { cx: 8, cy: 8, r: 2.2, fill: 'var(--ui-yellow)' }, 'd')
  ], 'sw-spin'),
  queued: () => svg([
    jsx('circle', {
      cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'var(--ui-text-quaternary)', strokeWidth: 1.6, strokeDasharray: '2.4 2.2'
    }, 'c')
  ])
}
const TONE = {
  completed: 'var(--ui-green)', failed: 'var(--ui-red)', stopped: 'var(--ui-text-quaternary)',
  running: 'var(--ui-yellow)', queued: 'var(--ui-stroke-secondary)'
}
const ICON = {
  copy: () => svg([
    jsx('rect', { x: 5, y: 5, width: 8.5, height: 8.5, rx: 1.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'r'),
    jsx('path', { d: 'M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'p')
  ]),
  open: () => svg(jsx('path', {
    d: 'M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
    strokeLinecap: 'round', strokeLinejoin: 'round'
  })),
  refresh: () => svg(jsx('path', {
    d: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round'
  })),
  tree: () => svg([
    jsx('rect', { x: 2, y: 2.5, width: 5, height: 3.5, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'a'),
    jsx('rect', { x: 9, y: 7, width: 5, height: 3.2, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'b'),
    jsx('rect', { x: 9, y: 11.5, width: 5, height: 3.2, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'c'),
    jsx('path', { d: 'M4.5 6v7.1H9M4.5 8.6H9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }, 'p')
  ]),
  stack: () => svg(jsx('path', {
    d: 'M8 2.5l5.5 2.8L8 8.1 2.5 5.3zM2.5 8l5.5 2.8L13.5 8M2.5 10.7l5.5 2.8 5.5-2.8', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.2, strokeLinejoin: 'round'
  })),
  bot: () => svg([
    jsx('rect', { x: 3, y: 5, width: 10, height: 8, rx: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'h'),
    jsx('path', { d: 'M8 2.5V5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }, 'a'),
    jsx('circle', { cx: 6.2, cy: 9, r: 0.9, fill: 'currentColor' }, 'l'),
    jsx('circle', { cx: 9.8, cy: 9, r: 0.9, fill: 'currentColor' }, 'r')
  ]),
  term: () => svg([
    jsx('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, 'r'),
    jsx('path', { d: 'M4.8 6.5l2 1.6-2 1.6M8.5 10.2h2.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }, 'p')
  ]),
  file: () => svg(jsx('path', {
    d: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round'
  })),
  chev: open => svg(jsx('path', {
    d: open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round'
  }))
}

// The svg is aria-hidden, so the mark itself carries the Tip's text as its accessible name. A mark
// outside a button (`focusable`) is a tab stop of its own, so its tooltip is reachable by keyboard.
function Mark({ status, t, label, focusable }) {
  const st = MARKS[status] ? status : 'stopped'
  const name = label || t(`sw.status.${st}`)
  return jsx(Tip, {
    label: name,
    children: jsx('span', { className: 'sw-mk', 'data-st': st, role: 'img', 'aria-label': name, tabIndex: focusable ? 0 : undefined, children: MARKS[st]() })
  })
}

// A header count: the number (or — when its source failed) with the Tip's text as its name.
function Stat({ label, icon, value }) {
  return jsx(Tip, { label, children: jsxs('span', { className: 'sw-stat', role: 'img', 'aria-label': label, tabIndex: 0, children: [icon(), value] }) })
}

/** A batch's spend with its breakdown as the tooltip; nothing when no worker was priced. */
function CostChip({ t, workers }) {
  const sum = sumCost(workers)
  const text = fmtCost(sum.usd, sum.status, t)
  if (!text) return null
  return jsx(Tip, {
    label: t('sw.cost.tip', sum.priced, sum.included, sum.unknown),
    children: jsx('span', { className: 'sw-bcost', children: text })
  })
}

function Strip({ statuses }) {
  return jsx('span', {
    className: 'sw-strip',
    children: statuses.map((s, i) => jsx('i', { 'data-st': s, style: { '--t': TONE[s] || TONE.stopped } }, i))
  })
}

// `text`: the label is also drawn beside the icon — the page's primary verbs are read, not hovered for.
function IconButton({ label, icon, onClick, disabled, busy, text }) {
  const button = jsx('button', {
    type: 'button', className: `sw-ib${text ? ' is-text' : ''}${busy ? ' is-busy' : ''}`, 'aria-label': label, 'aria-busy': busy ? 'true' : undefined,
    disabled: disabled || busy, onClick, children: text ? [jsx('span', { className: 'sw-ibi', children: icon() }, 'i'), jsx('span', { children: label }, 't')] : icon()
  })
  return text ? button : jsx(Tip, { label, children: button })
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
 * The files the focused chat's own file tool calls are touching now: tool.start adds them, tool.complete
 * ends them, and each stays TOUCH_LINGER_MS after its call ends. A finished call reloads the list.
 * Workers' calls reach the page only as a mirrored row without arguments, so they show on reload.
 */
function useTouching(runtimeId, cwd, onDone) {
  const [touching, setTouching] = useState(() => new Map())
  const calls = useRef(new Map())
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    setTouching(new Map())
    calls.current = new Map()
    if (!runtimeId) return undefined
    const timers = new Set()
    const offStart = ctxRef.onEvent('tool.start', event => {
      if (event?.session_id !== runtimeId) return
      const p = event.payload || {}
      const targets = fileTargets(p.name, p.args)
      if (!p.tool_id || !targets.length) return
      const keys = targets.map(({ path, op }) => {
        const full = resolvePath(path, cwdRef.current)
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
      const keys = calls.current.get(event.payload?.tool_id)
      if (!keys) return
      calls.current.delete(event.payload.tool_id)
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
  return touching
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

function Detail({ t, worker, onToast }) {
  const [busy, setBusy] = useState(false)
  // The backend serves a worker's output only to the chat that delegated it.
  const storedId = useContext(WatchedChat)
  const sid = worker.session_id || worker.child_session_id
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
  const goal = String(worker.goal || '').trim()
  return jsx(Branches, {
    children: [
      goal ? jsx(Tip, { label: goal, children: jsx('div', { className: 'sw-dtg', tabIndex: 0, children: jsx('span', { children: goal }) }) }, 'g') : null,
      jsxs('div', {
        className: 'sw-dta',
        children: [
          jsx(IconButton, { label: t(busy ? 'sw.copying' : 'sw.copy'), icon: ICON.copy, onClick: copy, disabled: !sid, busy, text: true }, 'c'),
          jsx(IconButton, { label: t('sw.open'), icon: ICON.open, onClick: open, disabled: !sid, text: true }, 'o'),
          // The duration is already on the worker's row; the detail adds only what the row lacks.
          jsx('span', {
            className: 'sw-dtm',
            children: t('sw.meta', worker.tool_calls ?? worker.tool_count ?? 0, fmtTokens(worker.tokens, t), fmtCost(worker.cost_usd, worker.cost_status, t))
          }, 'm')
        ]
      }, 'a')
    ]
  })
}

function WorkerRow({ t, w, name, id, open, onToggle }) {
  const time = w.status === 'stopped' ? '—' : fmtDuration(w.duration_s, t)
  return jsxs('button', {
    type: 'button', className: `sw-wr sw-nd sw-acc${open ? ' is-open' : ''}`, 'data-st': w.status, 'aria-expanded': open, onClick: onToggle,
    children: [
      jsx(Mark, { t, status: w.status }, 'm'),
      id ? jsx(Sig, { id }, 's') : null,
      jsx(NameBlock, { t, goal: w.goal, model: w.model, effort: w.effort, name }, 'n'),
      jsx('span', { className: 'sw-wt', children: time }, 't')
    ]
  })
}

function HistoryBatch({ t, batch, ids, open, onToggle, openWorker, setOpenWorker, onToast }) {
  const statuses = batch.workers.map(w => w.status)
  const st = batchState(statuses)
  const done = statuses.filter(s => s === 'completed').length
  const times = batch.workers.map(w => w.duration_s).filter(v => v !== null && v !== undefined)
  const names = distinctNames(batch.workers.map(w => w.goal))
  // The first worker names the batch; the others are counted, so a batch is never read as one task.
  const head = [
    jsx(Mark, { t, status: st }, 'm'),
    jsx('span', { className: 'sw-bn', children: workerName(batch.workers[0]?.goal) }, 'n'),
    statuses.length > 1 ? jsx('span', { className: 'sw-bmore', children: t('sw.more', statuses.length - 1) }, 'x') : null,
    jsx(Strip, { statuses }, 's'),
    jsx(CostChip, { t, workers: batch.workers }, '$'),
    jsx('span', { className: 'sw-bc', children: `${done}/${statuses.length}` }, 'c'),
    jsx('span', { className: 'sw-bt', children: times.length ? fmtDuration(Math.max(...times), t) : '' }, 't'),
    jsx('span', { className: 'sw-chev', children: ICON.chev(open) }, 'v')
  ]
  // One wrapper and one header button in both states: swapping a collapsed <button> for an open
  // <section> remounted the header and dropped keyboard focus to <body> on every toggle.
  return jsxs('div', {
    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': st, 'data-batch': batchKey(batch),
    children: [
      jsx('button', {
        type: 'button', className: open ? 'sw-bl sw-hb sw-bh' : 'sw-bl sw-hb sw-card sw-acc', 'data-st': st,
        'aria-expanded': open, onClick: onToggle, children: head
      }, 'h'),
      // Same tree as the live batch: the header is the root, each worker hangs off one rail.
      open ? jsx('div', {
        className: 'sw-bb sw-fw',
        children: batch.workers.map((w, i) => jsxs('div', {
          className: 'sw-nwrap',
          children: [
            jsx(WorkerRow, {
              t, w, name: names[i], id: ids?.get(w.session_id), open: openWorker.has(w.session_id),
              onToggle: () => setOpenWorker(w.session_id)
            }, 'r'),
            openWorker.has(w.session_id) ? jsx(Detail, { t, worker: w, onToast }, 'd') : null
          ]
        }, w.session_id))
      }, 'b') : null
    ]
  })
}

/** A stored batch's identity: its start alone can be shared by two batches; its first worker cannot. */
function batchKey(b) {
  return `${b.started_at}:${b.workers[0]?.session_id || ''}`
}

// ── command deck ─────────────────────────────────────────────────────────────

// Each agent's colour on the deck, on its files and in the log. Status keeps yellow / green / red,
// so the agent colours stay clear of them; past four, the letter tells two agents apart.
const HUES = ['var(--ui-blue)', 'var(--ui-purple)', 'var(--ui-cyan)', 'var(--ui-orange)']
const CHAT_HUE = 'var(--ui-text-tertiary)'
// Live log rows kept, newest first.
const LOG_ROWS = 6
// A log row younger than this reads "now".
const LOG_NOW_S = 3
// What a worker's current tool reads as under its orb (and in the log).
const VERB = {
  read_file: 'read', write_file: 'write', patch: 'edit', search_files: 'search', terminal: 'run', process: 'run',
  execute_code: 'code', delegate_task: 'delegate', web_search: 'web', web_extract: 'web', browser_exec: 'web'
}

/** The letter each name of one batch starts with, past the words every name of the batch opens with
 * ("Review alpha", "Review beta" -> A, B), so a batch of look-alike goals still gets telling letters. */
export function baseLetters(names) {
  const words = names.map(n => String(n || '').split(/\s+/).filter(Boolean))
  let skip = 0
  if (names.length > 1) {
    while (words.every(w => w.length > skip + 1 && w[skip].toLowerCase() === words[0][skip].toLowerCase())) skip++
  }
  return words.map(w => (w.slice(skip).join(' ').match(/[a-z0-9]/i)?.[0] || '?').toUpperCase())
}

/** One letter per agent; a letter already taken on the page gets a number (F, F2), so no two agents
 * share a badge. `groups` are the page's batches in order, each a list of names. */
export function agentLetters(groups) {
  const seen = new Map()
  return groups.map(names => baseLetters(names).map(ch => {
    const k = (seen.get(ch) || 0) + 1
    seen.set(ch, k)
    return k === 1 ? ch : `${ch}${k}`
  }))
}

/** The page's batches, each a list of agents ({ name, keys }) -> a lookup by any of their keys
 * (subagent id, session id): letter, hue, name. Hues run on across batches. */
export function agentIds(groups) {
  const letters = agentLetters(groups.map(g => g.map(a => a.name)))
  const ids = new Map()
  let n = 0
  groups.forEach((g, gi) => g.forEach((a, i) => {
    const id = { letter: letters[gi][i], hue: HUES[n++ % HUES.length], name: a.name }
    for (const k of a.keys) if (k && !ids.has(k)) ids.set(k, id)
  }))
  return ids
}

/** Per agent (worker session id, '' for the chat): how many files it changed and how many it only opened. */
export function touchedBy(files) {
  const by = new Map()
  for (const f of files || []) {
    for (const w of f.who || []) {
      const c = by.get(w) || { edited: 0, opened: 0 }
      if ((f.editors || []).includes(w)) c.edited++
      else c.opened++
      by.set(w, c)
    }
  }
  return by
}

/** A tool's preview as a short target: a path keeps its last two parts, anything else its first line. */
export function shortTarget(text) {
  const line = String(text || '').trim().split('\n', 1)[0]
  if (!/[\\/]/.test(line) || /\s/.test(line)) return line
  return line.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')
}

/** The line under an agent's orb: what it does now while it runs, what it did once it ended. */
export function unitAction(u, touched, t = enT) {
  if (u.status === 'running') {
    const tool = u.rec.last_tool
    if (!tool) return { verb: t('sw.unit.thinking') }
    return { verb: t(`sw.verb.${VERB[tool] || 'other'}`, tool), target: shortTarget(u.rec.tool_preview), full: u.rec.tool_preview }
  }
  if (u.status === 'queued') return { verb: t('sw.unit.queued') }
  const did = touched && (touched.edited || touched.opened) ? t('sw.unit.touched', touched.edited, touched.opened) : ''
  return { verb: t(`sw.unit.${TERMINAL.has(u.status) ? u.status : 'stopped'}`), target: did }
}

/** A live batch as deck units: each root, then the workers it started (marked with its letter). */
export function liveUnits(batch, now) {
  const out = []
  const walk = (rows, parent) => {
    rows.forEach(r => {
      out.push({
        key: r.subagent_id, sid: r.child_session_id || r.session_id || null, rec: r, parent,
        status: r.status, duration: r.duration_s ?? (r.started_at ? now - r.started_at : null)
      })
      walk(batch.kids.get(r.subagent_id) || [], r.subagent_id)
    })
  }
  walk(batch.roots, null)
  // Named across the whole deck: a nested worker sits beside its parent's siblings, not under them.
  const names = distinctNames(out.map(u => u.rec.goal))
  return out.map((u, i) => ({ ...u, name: names[i] }))
}

/** A stored batch as deck units, keyed by session id like the Earlier list. */
export function storedUnits(batch) {
  const names = distinctNames(batch.workers.map(w => w.goal))
  return batch.workers.map((w, i) => ({
    key: w.session_id, sid: w.session_id, rec: w, name: names[i], parent: null, status: w.status, duration: w.duration_s
  }))
}

function Sig({ id }) {
  return jsx('span', { className: 'sw-sig', style: { '--u': id.hue }, 'aria-hidden': 'true', children: id.letter })
}

function Unit({ t, u, id, parentId, open, onToggle, touched }) {
  const time = u.status === 'queued' ? '' : u.status === 'stopped' ? '' : fmtDuration(u.duration, t)
  const act = unitAction(u, touched, t)
  const chip = modelChip(u.rec.model, u.rec.effort)
  const state = t(`sw.unit.st.${MARKS[u.status] ? u.status : 'stopped'}`)
  return jsxs('button', {
    type: 'button', className: `sw-unit sw-nd${open ? ' is-open' : ''}`, 'data-st': u.status, style: { '--u': id.hue },
    'aria-expanded': open, onClick: onToggle,
    children: [
      parentId ? jsx('span', { className: 'sw-from', children: t('sw.unit.from', parentId.letter) }, 'f') : null,
      jsxs('span', {
        className: 'sw-orb', 'data-st': u.status,
        children: [jsx('span', { className: 'sw-orbl', 'aria-hidden': 'true', children: id.letter }, 'l'), jsx(Mark, { t, status: u.status }, 'm')]
      }, 'o'),
      jsx(Tip, { label: String(u.rec.goal || '').trim(), children: jsx('span', { className: 'sw-wn', children: u.name }) }, 'n'),
      jsx('span', { className: 'sw-us', children: [state, time].filter(Boolean).join(' · ') }, 's'),
      chip ? jsx(Tip, { label: t('sw.modelTip', String(u.rec.model), u.rec.effort), children: jsx('span', { className: 'sw-model', children: chip }) }, 'c') : null,
      jsxs('span', {
        className: 'sw-ua',
        children: [
          jsx('span', { className: 'sw-uv', children: act.verb }, 'v'),
          act.target
            ? (act.full
              ? jsx(Tip, { label: String(act.full), children: jsx('span', { className: 'sw-ut sw-now', children: act.target }) }, 't')
              : jsx('span', { className: 'sw-ut', children: act.target }, 't'))
            : null
        ]
      }, 'a')
    ]
  })
}

function Deck({ t, deck, now, ids, touched, openWorker, setOpenWorker, onToast }) {
  const { units, live } = deck
  const statuses = units.map(u => u.status)
  const st = batchState(statuses)
  const done = statuses.filter(s => s === 'completed').length
  const n = s => statuses.filter(x => s.includes(x)).length
  const starts = units.map(u => u.rec.started_at).filter(Number.isFinite)
  const elapsed = live
    ? (starts.length ? now - Math.min(...starts) : null)
    : Math.max(0, ...units.map(u => u.duration ?? 0))
  const sum = sumCost(units.map(u => u.rec))
  const cost = fmtCost(sum.usd, sum.status, t)
  const legend = [['running', n(['running'])], ['failed', n(['failed', 'stopped'])], ['queued', n(['queued'])]].filter(([, c]) => c)
  const byKey = new Map(units.map(u => [u.key, u]))
  const opened = units.filter(u => openWorker.has(u.key))
  const idOf = u => ids.get(u.key) || ids.get(u.sid) || { letter: '?', hue: CHAT_HUE, name: u.name }
  return jsxs('section', {
    className: live ? 'sw-deck sw-fl' : 'sw-deck', 'data-st': st, 'data-batch': deck.id, 'aria-label': t('sw.deck.label', done, units.length),
    children: [
      jsx('span', { className: 'sw-scan', 'aria-hidden': 'true' }, 'scan'),
      jsxs('div', {
        className: 'sw-score',
        children: [
          jsxs('div', {
            className: 'sw-big', role: 'img', 'aria-label': t('sw.deck.label', done, units.length),
            children: [
              jsxs('span', { className: 'sw-bign', children: [String(done), jsx('small', { children: `/${units.length}` }, 's')] }, 'n'),
              jsx('span', { className: 'sw-bigl', children: t(live ? 'sw.deck.finished' : 'sw.deck.lastRun') }, 'l')
            ]
          }, 'b'),
          jsxs('div', {
            className: 'sw-energy',
            children: [
              jsx('span', { className: 'sw-cells', 'aria-hidden': 'true', children: statuses.map((s, i) => jsx('i', { 'data-st': s }, i)) }, 'c'),
              jsxs('span', {
                className: 'sw-legend',
                children: [
                  ...legend.map(([s, c]) => jsxs('span', { children: [jsx('b', { children: c }, 'n'), ` ${t(`sw.deck.legend.${s}`)}`] }, s)),
                  elapsed !== null && elapsed > 0 ? jsx('span', { className: 'sw-el', children: fmtDuration(elapsed, t) }, 'e') : null
                ]
              }, 'l')
            ]
          }, 'e'),
          cost
            ? jsx(Tip, {
              label: t('sw.cost.tip', sum.priced, sum.included, sum.unknown),
              children: jsxs('span', {
                className: 'sw-money', tabIndex: 0,
                children: [jsx('span', { className: 'sw-bcost', children: cost }, 'n'), jsx('span', { className: 'sw-moneyl', children: t('sw.deck.spent') }, 'l')]
              })
            }, '$')
            : null
        ]
      }, 's'),
      jsx('div', {
        className: 'sw-party',
        children: units.map(u => jsx(Unit, {
          t, u, id: idOf(u), parentId: u.parent && byKey.has(u.parent) ? idOf(byKey.get(u.parent)) : null,
          open: openWorker.has(u.key), onToggle: () => setOpenWorker(u.key), touched: touched.get(u.sid)
        }, u.key))
      }, 'p'),
      opened.length
        ? jsx('div', {
          className: 'sw-unitds',
          children: opened.map(u => jsxs('div', {
            className: 'sw-unitd',
            children: [
              jsxs('div', { className: 'sw-unitdh', children: [jsx(Sig, { id: idOf(u) }, 's'), jsx('span', { children: u.name }, 'n')] }, 'h'),
              jsx(Detail, { t, worker: u.rec, onToast }, 'd')
            ]
          }, u.key))
        }, 'd')
        : null
    ]
  })
}

/** What happened in this chat while the page was open: workers starting, their tools, their ends. */
function useLog(runtimeId) {
  const [log, setLog] = useState([])
  useEffect(() => {
    setLog([])
    if (!runtimeId) return undefined
    let seq = 0
    const push = e => setLog(prev => [{ ...e, id: ++seq, at: Date.now() / 1000 }, ...prev].slice(0, LOG_ROWS))
    const on = (type, fn) => ctxRef.onEvent(type, event => {
      if (event?.session_id !== runtimeId) return
      fn(event.payload || {})
    })
    const offs = [
      on('subagent.start', p => { if (p.subagent_id) push({ who: p.subagent_id, kind: 'start' }) }),
      on('subagent.tool', p => { if (p.subagent_id && p.tool_name) push({ who: p.subagent_id, kind: 'tool', tool: p.tool_name, target: p.tool_preview || '' }) }),
      on('subagent.complete', p => {
        const kind = STATUS_OF[p.status] || 'completed'
        if (p.subagent_id) push({ who: p.subagent_id, kind: TERMINAL.has(kind) ? kind : 'stopped' })
      }),
      on('tool.start', p => {
        const targets = fileTargets(p.name, p.args)
        if (targets.length) push({ who: '', kind: 'tool', tool: p.name, target: targets[0].path })
      })
    ]
    return () => offs.forEach(off => off())
  }, [runtimeId])
  return log
}

function LogSection({ t, log, ids, chatId, now }) {
  return jsxs('section', {
    className: 'sw-logs', 'aria-labelledby': 'sw-log-h',
    children: [
      jsx('h3', {
        className: 'sw-lab sw-plab', id: 'sw-log-h',
        children: jsx(Tip, { label: t('sw.log.tip'), children: jsx('span', { className: 'sw-plt', tabIndex: 0, children: t('sw.log.title') }) })
      }, 'h'),
      jsx('ol', {
        className: 'sw-log',
        children: log.map(e => {
          const id = e.who ? ids.get(e.who) || { letter: t('sw.id.otherLetter'), hue: CHAT_HUE, name: t('sw.id.other') } : chatId
          const age = now - e.at
          const verb = e.kind === 'tool' ? t(`sw.verb.${VERB[e.tool] || 'other'}`, e.tool) : t(`sw.log.${e.kind}`)
          const st = e.kind === 'tool' || e.kind === 'start' ? 'running' : e.kind
          return jsxs('li', {
            className: 'sw-ev', 'data-st': st,
            children: [
              jsx('span', { className: 'sw-evt', children: age < LOG_NOW_S ? t('sw.log.now') : fmtDuration(age, t) }, 't'),
              jsx(Tip, { label: id.name, children: jsx('span', { className: 'sw-evw', tabIndex: 0, children: jsx(Sig, { id }) }) }, 'w'),
              jsxs('span', {
                className: 'sw-evx',
                children: [verb, e.target ? jsx(Tip, { label: e.target, children: jsx('code', { children: ` ${shortTarget(e.target)}` }) }, 'c') : null]
              }, 'x')
            ]
          }, e.id)
        })
      }, 'l')
    ]
  })
}

// ── background commands ──────────────────────────────────────────────────────

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
  if (c && d === c) return t('sw.files.here')
  if (c && d.startsWith(`${c}/`)) return `./${dir.replace(/\\/g, '/').slice(cwd.replace(/[/\\]+$/, '').length + 1)}`
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

/**
 * The rows the section draws: the backend's files plus any file touched now that the backend has
 * not recorded yet. Files being touched come first, then the newest; grouped by folder in that order.
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

function groupByDir(rows) {
  const groups = new Map()
  for (const f of rows) {
    const { dir, name } = splitPath(f.path)
    const k = pathKey(dir)
    if (!groups.has(k)) groups.set(k, { dir, rows: [] })
    groups.get(k).rows.push({ ...f, name })
  }
  return [...groups.values()]
}

/** First non-empty line of a command, for the one-line row; the full text is the tooltip. */
export function commandLine(command) {
  return String(command || '').split('\n').map(s => s.trim()).find(Boolean) || ''
}

// An opened row's pieces hang under it as tree branches, the same lines the live batch tree draws.
// Each leaf gets its own wrapper so the connector is drawn outside the leaf (a scrolling <pre> would
// clip a connector drawn on itself). A worker's detail branches off its row (`sw-dt`); a command's
// hangs off the batch rail of its framed box (`onRail`), exactly like an earlier batch's workers.
function Branches({ children, onRail }) {
  return jsx('div', {
    className: onRail ? 'sw-bb sw-fw' : 'sw-dt',
    children: children.filter(Boolean).map((leaf, i) => onRail
      ? jsx('div', { className: 'sw-nwrap', children: jsx('div', { className: 'sw-leaf', children: leaf }) }, i)
      : jsx('div', { className: 'sw-br', children: leaf }, i))
  })
}

function ProcDetail({ t, p, storedId, onToast }) {
  // Only a finished command's receipt has output; a checkpoint-only row (the app closed under it)
  // has none, and asking for it was a guaranteed 404 shown as a read failure.
  const fetches = p.status !== 'running' && p.has_output !== false
  const [out, setOut] = useState({ loading: fetches, data: null, error: null })
  useEffect(() => {
    if (!fetches) return undefined
    let alive = true
    ctxRef.rest(`/process_output?session_id=${encodeURIComponent(storedId)}&process_id=${encodeURIComponent(p.id)}`).then(
      data => alive && setOut({ loading: false, data, error: null }),
      err => alive && setOut({ loading: false, data: null, error: String(err?.message || err) })
    )
    return () => { alive = false }
  }, [p.id, p.status, storedId, fetches])
  // The receipt holds the whole command; the list row carries at most COMMAND_CHARS of it.
  const command = out.data?.command || p.command || ''
  const cut = !out.data?.command && p.command_truncated
  const copy = () => writeClip(command, t, onToast)
  let body
  if (p.status === 'running') body = jsx('div', { className: 'sw-po-note', children: t('sw.proc.whileRunning') })
  else if (out.loading) body = jsx(Loader, { label: t('sw.proc.output') })
  else if (out.error) body = jsx(ErrorState, { title: t('sw.err.withDetail', t('sw.err.procOutput'), out.error) })
  else if (!out.data?.output) body = jsx('div', { className: 'sw-po-note', children: t('sw.proc.noOutput') })
  else body = jsx('pre', { className: 'sw-po', children: out.data.output })
  const meta = [
    p.status === 'stopped' ? t('sw.proc.killed')
      // A failed row already shows its exit code; the detail does not repeat it.
      : p.status !== 'failed' && p.exit_code !== null && p.exit_code !== undefined ? t('sw.proc.exit', p.exit_code) : '',
    p.cwd ? t('sw.proc.cwd', p.cwd) : '',
    cut ? t('sw.proc.commandCut', command.length) : ''
  ].filter(Boolean).join(' · ')
  // The row already reads a short one-line command in full; the block is for what it cannot show.
  const showCommand = command !== commandLine(p.command) || command.length > ROW_COMMAND_CHARS || cut
  return jsx(Branches, {
    onRail: true,
    children: [
      showCommand ? jsx('pre', { className: 'sw-pc', children: command }, 'c') : null,
      jsxs('div', {
        className: 'sw-dta',
        children: [
          jsx(IconButton, { label: t('sw.proc.copyCommand'), icon: ICON.copy, onClick: copy }, 'c'),
          jsx('span', { className: 'sw-dtm', children: meta }, 'm')
        ]
      }, 'a'),
      jsxs('div', {
        className: 'sw-pob',
        children: [
          jsxs('div', {
            className: 'sw-pol',
            children: [
              t('sw.proc.output'),
              out.data?.output_truncated ? jsx('span', { children: ` · ${t('sw.proc.outputCut', out.data.output.length)}` }, 'x') : null
            ]
          }, 'l'),
          body
        ]
      }, 'o')
    ]
  })
}

function ProcItem({ t, p, now, open, onToggle, storedId, onToast }) {
  const time = p.status === 'running'
    ? fmtDuration(p.started_at ? now - p.started_at : null, t)
    : p.status === 'stopped' ? '—' : fmtDuration(p.duration_s, t)
  const head = [
    jsx(Mark, { t, status: p.status, label: t(`sw.proc.status.${p.status}`) }, 'm'),
    jsx(Tip, { label: p.command, children: jsx('code', { className: 'sw-pn', children: commandLine(p.command) }) }, 'n'),
    p.status === 'failed' && p.exit_code !== null && p.exit_code !== undefined
      ? jsx('span', { className: 'sw-px', children: t('sw.proc.exit', p.exit_code) }, 'x')
      : null,
    jsx('span', { className: 'sw-wt', children: time }, 't'),
    jsx('span', { className: 'sw-chev', children: ICON.chev(open) }, 'v')
  ]
  return jsxs('div', {
    className: open ? 'sw-box sw-frame' : 'sw-cw', 'data-st': p.status,
    children: [
      jsx('button', {
        type: 'button', className: open ? 'sw-pr sw-bl sw-bh is-open' : 'sw-pr sw-bl sw-card sw-acc', 'data-st': p.status,
        'aria-expanded': open, onClick: onToggle, children: head
      }, 'h'),
      open ? jsx(ProcDetail, { t, p, storedId, onToast }, `d-${p.status}`) : null
    ]
  })
}

function ProcSection({ t, procs, now, storedId, openProc, toggleProc, onToast }) {
  const unreadable = procs.data?.unreadable || 0
  const rows = [...(procs.data?.processes || [])].reverse()
  if (!rows.length && !unreadable && !procs.loading) return null
  return jsxs('section', {
    className: 'sw-procs', 'aria-labelledby': 'sw-procs-h',
    children: [
      jsxs('h3', {
        className: 'sw-lab sw-plab', id: 'sw-procs-h',
        children: [
          jsx(Tip, { label: t('sw.proc.notSubagent'), children: jsxs('span', { className: 'sw-plt', tabIndex: 0, children: [jsx('span', { className: 'sw-pi', children: ICON.term() }, 'i'), t('sw.procs')] }) }, 'l'),
          // Read failures carry the failed mark (the text keeps its reading colour for contrast).
          unreadable ? jsxs('span', { className: 'sw-pu', children: [jsx('span', { className: 'sw-mk', 'data-st': 'failed', 'aria-hidden': 'true', children: MARKS.failed() }, 'm'), t('sw.proc.unreadable', unreadable)] }, 'u') : null
        ]
      }, 'h'),
      procs.loading
        ? jsx(Loader, { label: t('sw.procs') }, 'w')
        : jsx('div', {
          className: 'sw-plist',
          children: rows.map(p => jsx(ProcItem, {
            t, p, now, storedId, onToast, open: openProc.has(p.id), onToggle: () => toggleProc(p.id)
          }, p.id))
        }, 'l')
    ]
  })
}

const FILE_MARK = {
  active: () => svg(jsx('circle', { cx: 8, cy: 8, r: 4.5, fill: 'currentColor' })),
  write: () => svg(jsx('path', { d: 'M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z', fill: 'currentColor' })),
  delete: () => svg(jsx('path', { d: 'M3.5 8h9', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' })),
  failed: () => svg(jsx('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' })),
  read: () => svg(jsx('circle', { cx: 8, cy: 8, r: 3.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }))
}

function FileTile({ t, f, who, heat, onToast }) {
  const label = t(`sw.files.op.${f.state}`)
  const counts = t('sw.files.counts', f.reads, f.writes, f.deletes, f.failed)
  const copy = () => writeClip(f.path, t, onToast, t('sw.files.copied'))
  const names = who.map(i => i.name).join(', ')
  return jsx(Tip, {
    label: `${f.path}\n${label}${counts ? ` · ${counts}` : ''}${names ? `\n${t('sw.files.by', names)}` : ''}`,
    children: jsxs('button', {
      type: 'button', className: 'sw-fir', 'data-op': f.state, onClick: copy,
      style: { '--u': who[0]?.hue || CHAT_HUE, '--heat': `${heat}%` },
      'aria-label': `${f.name}: ${label}${counts ? `, ${counts}` : ''}${names ? `, ${t('sw.files.by', names)}` : ''}`,
      children: [
        who.length ? jsx('span', { className: 'sw-sigs', children: who.slice(0, 2).map(i => jsx(Sig, { id: i }, i.letter)) }, 's') : null,
        jsx('span', { className: 'sw-fim', 'aria-hidden': 'true', children: FILE_MARK[f.state]() }, 'm'),
        jsx('span', { className: 'sw-fin', children: f.name }, 'n'),
        jsx('span', { className: 'sw-fic', children: f.state === 'active' ? t('sw.files.now') : counts || label }, 'c')
      ]
    })
  })
}

/** Who touched a file, as badges: its agents by the page's letters, the chat itself last. */
export function fileWho(f, ids, chatId, other) {
  const who = f.who && f.who.length ? f.who : f.state === 'active' ? [''] : []
  const out = []
  for (const w of who) {
    const id = w ? ids.get(w) || other : chatId
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function FilesSection({ t, files, touching, ids, chatId, onToast }) {
  const [showAll, setShowAll] = useState(false)
  const data = files.data
  const rows = fileGroups(data?.files, touching)
  const unreadable = data?.unreadable || 0
  if (!rows.length && !unreadable && !files.loading) return null
  const shown = showAll ? rows : rows.slice(0, FILES_PAGE)
  const other = { letter: t('sw.id.otherLetter'), hue: CHAT_HUE, name: t('sw.id.other') }
  const most = Math.max(1, ...rows.map(f => f.reads + f.writes + f.deletes + f.failed))
  return jsxs('section', {
    className: 'sw-files', 'aria-labelledby': 'sw-files-h',
    children: [
      jsxs('h3', {
        className: 'sw-lab sw-plab', id: 'sw-files-h',
        children: [
          jsx(Tip, { label: t('sw.files.tip'), children: jsxs('span', { className: 'sw-plt', tabIndex: 0, children: [jsx('span', { className: 'sw-pi', children: ICON.file() }, 'i'), t('sw.files.title')] }) }, 'l'),
          rows.length ? jsx('span', { className: 'sw-labn', children: t('sw.files.touched', rows.length + (data?.more || 0)) }, 'n') : null,
          unreadable ? jsxs('span', { className: 'sw-pu', children: [jsx('span', { className: 'sw-mk', 'data-st': 'failed', 'aria-hidden': 'true', children: MARKS.failed() }, 'm'), t('sw.files.unreadable', unreadable)] }, 'u') : null
        ]
      }, 'h'),
      files.loading && !rows.length
        ? jsx(Loader, { label: t('sw.files.title') }, 'w')
        : jsx('div', {
          className: 'sw-fil',
          children: groupByDir(shown).map(g => jsxs('div', {
            className: 'sw-fig',
            children: [
              jsx(Tip, { label: g.dir, children: jsx('div', { className: 'sw-fid', tabIndex: 0, children: dirLabel(g.dir, data?.cwd, t) }) }, 'd'),
              jsx('div', {
                className: 'sw-tiles',
                children: g.rows.map(f => jsx(FileTile, {
                  t, f, who: fileWho(f, ids, chatId, other), onToast,
                  heat: Math.round(6 + 26 * ((f.reads + f.writes + f.deletes + f.failed) / most))
                }, f.key))
              }, 't')
            ]
          }, g.dir))
        }, 'l'),
      !showAll && rows.length > FILES_PAGE
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setShowAll(true), children: t('sw.files.more', rows.length - FILES_PAGE) }, 'more')
        : null,
      data?.more ? jsx('p', { className: 'sw-fio', children: t('sw.files.notListed', data.more) }, 'nl') : null,
      jsx('p', { className: 'sw-fio', children: t('sw.files.blind') }, 'b')
    ]
  })
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

export function Page() {
  const t = usePluginI18n(ID)
  const pageRef = useRef(null)
  const watched = useWatchedChat(pageRef)
  const { runtimeId, storedId } = watched
  const history = useHistory(storedId)
  // Each card opens and closes on its own: opening one never folds another.
  const [openBatch, toggleBatch, clearBatches, addBatches] = useOpenSet()
  const [openWorker, setOpenWorker, clearWorkers, addWorkers] = useOpenSet()
  const [openProc, toggleProc, clearProcs] = useOpenSet()
  const [focusBatch, setFocusBatch] = useState(null)
  // A finished batch leaves the live deck for its stored copy (the deck while nothing runs, else
  // Earlier) with what the user had open: each open worker detail stays open (live keys it by
  // subagent id, stored by session id), its Earlier card opens, and focus moves along with it.
  const onBatchEnded = ({ sessions, focused }) => {
    const opened = [...sessions].filter(([sub]) => openWorker.has(sub)).map(([, sid]) => sid)
    return Promise.resolve(history.reload()).then(data => {
      const sids = new Set(sessions.values())
      const moved = (data?.batches || []).find(b => b.workers.some(w => sids.has(w.session_id)))
      if (!moved) return
      if (opened.length) addWorkers(opened)
      if (opened.length || focused) addBatches([batchKey(moved)])
      if (focused) setFocusBatch(batchKey(moved))
    })
  }
  const live = useLive(runtimeId, onBatchEnded)
  const procs = useProcesses(storedId)
  const files = useFiles(storedId)
  const touching = useTouching(runtimeId, files.data?.cwd, files.reload)
  const log = useLog(runtimeId)
  const [showAll, setShowAll] = useState(false)
  const [toast, setToast] = useState(null)
  const procRows = procs.data?.processes || []
  const procsRunning = procRows.filter(p => p.status === 'running').length
  const now = useNow(live.batches.length > 0 || procsRunning > 0)

  useEffect(() => {
    clearBatches()
    clearWorkers()
    clearProcs()
    setShowAll(false)
    setFocusBatch(null)
  }, [storedId])
  // Runs after every render until the moved batch's stored copy is drawn (the live copy is dropped
  // one step after history has it), then hands the focus once to its Earlier header, else to its
  // open agent on the deck, else to its first agent.
  useEffect(() => {
    if (!focusBatch) return
    const el = [...(pageRef.current?.querySelectorAll('[data-batch]') || [])].find(e => e.getAttribute('data-batch') === focusBatch)
    const header = el?.querySelector('button.sw-hb') || el?.querySelector('button.sw-unit.is-open') || el?.querySelector('button.sw-unit')
    if (!header) return
    header.focus()
    setFocusBatch(null)
  })
  useEffect(() => {
    if (!toast) return undefined
    return ctxRef.setTimeout(() => setToast(null), 2400)
  }, [toast])
  const onToast = (text, bad) => setToast({ text, bad })

  const liveSessions = new Set(live.batches.flatMap(b => b.rows.map(r => r.child_session_id).filter(Boolean)))
  // subagent.list carries no child_session_id, so a batch still running on the backend is matched by
  // state and time: while a live tree is drawn, a stored batch with an unfinished worker that started
  // no earlier than the live tree (less LIVE_MATCH_S) IS that tree.
  const liveStarts = live.batches.flatMap(b => b.rows.map(r => r.started_at)).filter(Number.isFinite)
  const liveFrom = (liveStarts.length ? Math.min(...liveStarts) : now) - LIVE_MATCH_S
  const isLiveStored = b => live.batches.length > 0 && b.started_at >= liveFrom && b.workers.some(w => w.status === 'running')
  const stored = history.data?.batches || []
  // The backend drops a worker from subagent.list the moment it finishes, so a half-done batch's
  // finished workers exist only in state.db. They join the live tree; hiding the stored batch
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
  // The deck shows the batch that runs now; with none running, the last one. Earlier lists the rest.
  const decks = nowBatches.length
    ? nowBatches.map(b => ({ id: b.id, live: true, units: liveUnits(b, now) }))
    : past.length ? [{ id: batchKey(past[0]), live: false, units: storedUnits(past[0]) }] : []
  const earlier = nowBatches.length ? past : past.slice(1)
  const shown = showAll ? earlier : earlier.slice(0, HISTORY_PAGE)
  const totals = {
    batches: nowBatches.length + past.length,
    workers: nowBatches.reduce((n, b) => n + b.rows.length, 0) + past.reduce((n, b) => n + b.workers.length, 0)
  }
  // One letter and colour per agent across the page: the deck first, then Earlier, newest first.
  const ids = agentIds([
    ...decks.map(d => d.units.map(u => ({ name: u.name, keys: [u.key, u.sid] }))),
    ...earlier.map(b => b.workers.map(w => ({ name: workerName(w.goal), keys: [w.session_id] })))
  ])
  const chatId = { letter: t('sw.id.chat'), hue: CHAT_HUE, name: t('sw.id.chatName') }
  const touched = touchedBy(files.data?.files)
  const runningN = live.batches.reduce((n, b) => n + b.rows.filter(r => r.status === 'running').length, 0)
  const procSection = storedId
    ? jsx(ProcSection, { t, procs, now, storedId, openProc, toggleProc, onToast }, 'procs')
    : null
  // Keyed by chat: its "show all" folds again when the watched chat changes.
  const filesSection = storedId
    ? jsx(FilesSection, { t, files, touching, ids, chatId, onToast }, `files-${storedId}`)
    : null
  const lower = filesSection || log.length
    ? jsxs('div', {
      className: `sw-lower${log.length ? ' has-log' : ''}`,
      children: [filesSection, log.length ? jsx(LogSection, { t, log, ids, chatId, now }, 'log') : null]
    }, 'lower')
    : null

  let body
  if (!storedId && !runtimeId) {
    body = jsx(PanelEmpty, { icon: 'comment-discussion', title: t('sw.noChat.title'), description: t('sw.noChat.body') })
  } else if (history.loading && !history.data && !live.batches.length) {
    body = jsx(Loader, { label: t('sw.title') })
  } else if (!live.batches.length && !past.length && history.error && procs.error && (files.error || !files.data?.files?.length)) {
    body = jsx('p', { className: 'sw-hint', children: t('sw.err.hint') })
  } else if (!live.batches.length && !past.length && !history.error) {
    body = [
      jsx(PanelEmpty, { icon: 'type-hierarchy-sub', title: t('sw.empty.title'), description: t('sw.empty.body') }, 'empty'),
      lower,
      procSection
    ]
  } else {
    body = [
      ...decks.map(d => jsx(Deck, { t, deck: d, now, ids, touched, openWorker, setOpenWorker, onToast }, d.id)),
      lower,
      earlier.length ? jsx('h3', { className: 'sw-lab', children: t('sw.earlier') }, 'el') : null,
      ...shown.map(b => {
        const key = batchKey(b)
        return jsx(HistoryBatch, {
          t, batch: b, ids, open: openBatch.has(key), onToggle: () => toggleBatch(key),
          openWorker, setOpenWorker, onToast
        }, key)
      }),
      !showAll && earlier.length > HISTORY_PAGE
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setShowAll(true), children: t('sw.older', earlier.length - HISTORY_PAGE) }, 'more')
        : null,
      procSection
    ]
  }

  const errors = [
    history.error ? t('sw.err.withDetail', t('sw.err.history'), history.error) : null,
    live.error ? t('sw.err.withDetail', t('sw.err.live'), live.error) : null,
    procs.error ? t('sw.err.withDetail', t('sw.err.procs'), procs.error) : null,
    files.error ? t('sw.err.withDetail', t('sw.err.files'), files.error) : null
  ].filter(Boolean)
  const refreshAll = () => { history.reload(); procs.reload(); files.reload(); live.retry() }
  // The header's tint tells one thing: a read failed (red), something runs (yellow), or neither.
  // It used to fall back to green, so a page where nothing could be read looked all fine.
  const headState = errors.length ? 'failed' : runningN || procsRunning ? 'running' : 'idle'
  const chatName = storedId ? history.data?.title || t('sw.chat.untitled', String(storedId).slice(-6)) : ''

  return jsx(WatchedChat.Provider, { value: storedId, children: jsxs('div', {
    className: 'sw-page', ref: pageRef,
    children: [
      jsx('style', { children: CSS }, 'css'),
      jsxs('div', {
        className: 'sw-panel',
        children: [
          jsxs('header', {
            className: 'sw-hd sw-frame', 'data-st': headState,
            children: [
              jsx('span', { className: 'sw-hi', children: ICON.tree() }, 'i'),
              // Which chat this is: the page can hold a chat the app no longer has focused.
              jsxs('div', {
                className: 'sw-htw',
                children: [
                  jsx('h2', { className: 'sw-ht', children: t('sw.title') }, 't'),
                  chatName
                    ? jsxs('p', {
                      className: 'sw-chat',
                      children: [
                        jsx('span', { className: 'sw-chatn', children: chatName }, 'n'),
                        watched.held ? jsx(Tip, { label: t('sw.chat.heldTip'), children: jsx('span', { className: 'sw-held', tabIndex: 0, children: t('sw.chat.held') }) }, 'h') : null
                      ]
                    }, 'c')
                    : null
                ]
              }, 'tw'),
              // Counts and refresh are one group: on a narrow pane it drops under the title as a
              // whole instead of squeezing the title or wrapping a pill onto two lines.
              jsxs('div', {
                className: 'sw-hs',
                children: [
                  // A count whose source failed reads —, never a 0 that looks like real data.
                  jsx(Stat, { icon: ICON.stack, value: history.error ? '—' : totals.batches, label: history.error ? t('sw.countFailed') : t('sw.nBatches', totals.batches) }, 'sb'),
                  jsx(Stat, { icon: ICON.bot, value: history.error ? '—' : totals.workers, label: history.error ? t('sw.countFailed') : t('sw.nWorkers', totals.workers) }, 'sw'),
                  jsx(Stat, { icon: ICON.term, value: procs.error ? '—' : procRows.length, label: procs.error ? t('sw.countFailed') : t('sw.nProcs', procRows.length) }, 'sp'),
                  // Everything that runs is counted: a running command tints the header too.
                  runningN || procsRunning
                    ? jsxs('span', { className: 'sw-pill', children: [MARKS.running(), t('sw.running', runningN, procsRunning)] }, 'p')
                    : null,
                  jsx(IconButton, { label: t('sw.refresh'), icon: ICON.refresh, onClick: refreshAll, disabled: !storedId }, 'r')
                ]
              }, 'hs')
            ]
          }, 'h'),
          errors.length
            ? jsxs('div', {
              className: 'sw-err', role: 'alert',
              children: [
                ...errors.map(e => jsx(ErrorState, { title: e }, e)),
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

/** The focused chat's batch: finished/total, a bar, the cost so far. Opens the page on click. */
function ProgressChip() {
  const t = usePluginI18n(ID)
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
    className: 'sw-sbw',
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

const CHIP_CSS = `
.sw-sbw{display:inline-flex;align-items:center}
.sw-sb{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border-radius:5px;border:0;background:transparent;
 color:var(--ui-text-secondary);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;--sw-tint:var(--ui-yellow)}
.sw-sb:hover{background:var(--ui-bg-tertiary);color:var(--ui-text-primary)}
.sw-sb:focus-visible{outline:2px solid var(--ui-stroke-primary);outline-offset:1px}
.sw-sb[data-st=completed]{--sw-tint:var(--ui-green)}
.sw-sb[data-st=failed]{--sw-tint:var(--ui-red)}
.sw-sb[data-st=stopped],.sw-sb[data-st=queued]{--sw-tint:var(--ui-text-quaternary)}
.sw-sbm{width:13px;height:13px;flex:none}
.sw-sbm svg{width:100%;height:100%;display:block}
.sw-sbbar{width:44px;height:5px;border-radius:3px;background:var(--ui-bg-tertiary);overflow:hidden;flex:none}
.sw-sbbar>i{display:block;height:100%;background:var(--sw-tint);transition:width .3s}
.sw-sb .sw-spin{animation:sw-rot 1.1s linear infinite;transform-origin:50% 50%}
@keyframes sw-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sw-sb .sw-spin{animation:none}.sw-sbbar>i{transition:none}}
`

const CSS = `
.sw-page{height:100%;min-height:0;overflow:auto;padding:20px 24px;color:var(--ui-text-primary);font-size:12px}
.sw-panel{position:relative;container-type:inline-size;
 --sw-mono:ui-monospace,"Cascadia Mono",Consolas,var(--dt-font-mono,monospace)}
/* Docked beside the chat the worker name needs every pixel: a model chip cut to 'c…' says nothing. */
@container (max-width:420px){.sw-panel .sw-model,.sw-panel .sw-strip{display:none}.sw-panel .sw-bl{gap:7px;padding:0 8px}.sw-panel .sw-now{max-width:72px}
 /* The hidden strip carried the push to the right; without it counts and times lost their column. */
 .sw-panel .sw-bl .sw-bc{margin-left:auto}
 /* With a cost chip the cost takes the push, and the count sits beside it. */
 .sw-panel .sw-bl .sw-bcost{margin-left:auto}.sw-panel .sw-bl .sw-bcost~.sw-bc{margin-left:0}}
.sw-page svg{width:100%;height:100%;display:block}
.sw-spin{animation:sw-rot 1.1s linear infinite;transform-origin:50% 50%}
@keyframes sw-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sw-spin{animation:none}}
.sw-mk{width:15px;height:15px;flex:none;display:inline-block}
.sw-hd{display:flex;align-items:center;flex-wrap:wrap;row-gap:8px;gap:10px;padding:10px 10px 10px 14px;margin:0 0 14px}
.sw-hi{width:30px;height:30px;padding:6px;border-radius:8px;flex:none;color:var(--sw-tint);
 background:color-mix(in srgb,var(--sw-tint) 14%,transparent);border:1px solid color-mix(in srgb,var(--sw-tint) 30%,transparent)}
.sw-htw{flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:1px}
.sw-ht{margin:0;font-size:14px;font-weight:600;white-space:nowrap}
.sw-chat{margin:0;display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:16px;color:var(--ui-text-secondary)}
.sw-chatn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-held{flex:none;padding:0 5px;border-radius:4px;border:1px solid var(--ui-stroke-tertiary);line-height:14px;cursor:default}
.sw-hs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.sw-stat{display:inline-flex;align-items:center;gap:5px;flex:none;white-space:nowrap;height:22px;padding:0 8px 0 6px;border-radius:99px;font-size:11.5px;
 color:var(--ui-text-secondary);background:var(--ui-bg-tertiary);font-variant-numeric:tabular-nums}
.sw-stat svg{width:13px;height:13px}
.sw-pill{display:inline-flex;align-items:center;gap:6px;flex:none;white-space:nowrap;height:22px;padding:0 9px 0 6px;border-radius:99px;font-size:11.5px;
 color:var(--ui-text-secondary);background:var(--ui-bg-tertiary)}
.sw-pill svg{width:13px;height:13px}
.sw-ib{width:26px;height:26px;padding:5px;border-radius:6px;color:var(--ui-text-secondary);background:transparent;
 border:1px solid var(--ui-stroke-tertiary);cursor:pointer;flex:none}
.sw-ib:hover:not(:disabled){background:var(--ui-bg-tertiary);color:var(--ui-text-primary)}
.sw-ib:disabled{opacity:.45;cursor:default}
.sw-ib.is-text{width:auto;display:inline-flex;align-items:center;gap:6px;padding:0 9px 0 7px;font:inherit;font-size:12px;white-space:nowrap}
.sw-ibi{width:14px;height:14px;flex:none}
.sw-ib.is-busy{opacity:1;cursor:progress;background:var(--ui-bg-tertiary)}
.sw-ib.is-busy svg{animation:sw-pulse 1s ease-in-out infinite}
@keyframes sw-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.sw-ib.is-busy svg{animation:none}}
/* The app removes every focus ring; a keyboard user still has to see where focus is. */
.sw-ib:focus-visible,.sw-bl:focus-visible,.sw-nd:focus-visible,.sw-more:focus-visible,.sw-dtg:focus-visible,.sw-plt:focus-visible,
.sw-stat:focus-visible,.sw-mk:focus-visible,.sw-held:focus-visible,.sw-bcost:focus-visible{
 outline:2px solid var(--ui-stroke-primary);outline-offset:1px}
.sw-hint{margin:12px 6px;font-size:12px;line-height:18px;color:var(--ui-text-secondary)}
.sw-err{margin:8px 0;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--ui-red) 45%,transparent);font-size:12px}
.sw-erra{display:flex;justify-content:flex-end;margin-top:6px}
.sw-bd{padding-bottom:12px}
.sw-lab{margin:0;font-size:11.5px;font-weight:400;color:var(--ui-text-secondary);padding:14px 6px 6px}
.sw-more{font-size:11.5px;color:var(--ui-text-secondary);padding:8px 6px 0;background:none;border:0;cursor:pointer}
.sw-more:hover{color:var(--ui-text-primary)}
.sw-strip{display:flex;gap:2px;margin-left:auto;flex:none}
.sw-strip i{width:14px;height:5px;border-radius:2px;background:var(--t)}
.sw-strip i[data-st=queued]{background:transparent;box-shadow:inset 0 0 0 1px var(--t)}
.sw-bc,.sw-bt,.sw-wt{font-size:11.5px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.sw-bc{min-width:28px;text-align:right}
.sw-bcost{font-size:11.5px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.sw-bt{min-width:52px;text-align:right}
.sw-chev{width:14px;height:14px;color:var(--ui-text-quaternary);flex:none}
.sw-box{margin:2px 0 8px;overflow:hidden}
.sw-bl{width:100%;height:38px;display:flex;align-items:center;gap:9px;padding:0 10px;border-radius:8px;border:0;background:transparent;
 color:inherit;font:inherit;text-align:left;cursor:pointer}
.sw-bl:hover{background:var(--ui-bg-secondary)}
.sw-bh{border-radius:0;box-shadow:none}
.sw-frame{position:relative;border:1px solid var(--ui-stroke-tertiary);border-radius:10px;background:var(--ui-bg-secondary);
 box-shadow:var(--shadow-sm);--sw-tint:var(--ui-text-tertiary)}
/* The rail marks only what needs a look — running or failed. On every card it meant nothing. */
.sw-frame[data-st=running]::after,.sw-frame[data-st=failed]::after{content:"";position:absolute;left:-1px;top:12px;bottom:12px;width:3px;
 border-radius:0 3px 3px 0;background:var(--sw-tint)}
.sw-frame[data-st=completed]{--sw-tint:var(--ui-green)}
.sw-frame[data-st=failed]{--sw-tint:var(--ui-red)}
.sw-frame[data-st=stopped],.sw-frame[data-st=interrupted],.sw-frame[data-st=queued]{--sw-tint:var(--ui-text-quaternary)}
.sw-frame[data-st=running]{--sw-tint:var(--ui-yellow)}
.sw-frame .sw-bh{background:transparent}
.sw-frame .sw-bh:hover{background:color-mix(in srgb,var(--ui-bg-tertiary) 60%,transparent)}
.sw-acc{position:relative;box-shadow:var(--shadow-xs);transition:background .12s,border-color .12s}
.sw-acc[data-st=running]::after,.sw-acc[data-st=failed]::after{content:"";position:absolute;left:-1px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0}
.sw-acc[data-st=failed]::after{background:var(--ui-red)}
.sw-acc[data-st=running]::after{background:var(--ui-yellow)}
/* Inside a framed box the frame already carries the tint: rows keep their mark, lose the rail and
   the lift, so a frame holds one accent instead of one per row. */
.sw-fw .sw-acc{box-shadow:none}
.sw-fw .sw-acc::after{display:none}
.sw-card{margin:0 0 6px;border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-secondary)}
.sw-card:hover,.sw-nd.sw-acc:hover{background:var(--ui-bg-tertiary);border-color:var(--ui-stroke-secondary)}
.sw-bn{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sw-bmore{font-size:11.5px;color:var(--ui-text-secondary);white-space:nowrap;flex:none}
.sw-box .sw-bb{margin:4px 10px 10px 18px}
.sw-box .sw-bb>.sw-nwrap:first-child::before{top:-4px}
.sw-wn{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.sw-nl{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.sw-nl .sw-wn{flex:1 1 auto}
.sw-model{font:11.5px var(--sw-mono);color:var(--ui-text-secondary);border:1px solid var(--ui-stroke-tertiary);
 border-radius:4px;padding:0 5px;line-height:15px;white-space:nowrap;flex:0 0 auto}
.sw-now{font:11.5px var(--sw-mono);color:var(--ui-text-secondary);background:var(--ui-bg-tertiary);
 border-radius:4px;padding:1px 6px;flex:0 1 auto;min-width:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-dt{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px 22px;padding-left:18px}
.sw-br{position:relative;min-width:0}
.sw-br::before{content:"";position:absolute;left:-18px;top:14px;width:17px;border-top:1px solid var(--ui-stroke-secondary)}
.sw-br::after{content:"";position:absolute;left:-18px;top:-6px;bottom:0;border-left:1px solid var(--ui-stroke-secondary)}
.sw-br:last-child::after{bottom:auto;height:20px}
.sw-dtg{padding:8px 10px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary)}
.sw-dtg>span{font-size:12px;line-height:18px;color:var(--ui-text-secondary);display:-webkit-box;-webkit-line-clamp:3;
 -webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sw-dta{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:4px 6px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary)}
.sw-dtm{flex:1 1 120px;min-width:0;margin-left:4px;font-size:11.5px;line-height:16px;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.sw-fw{position:relative;display:flex;flex-direction:column;gap:6px;margin:14px 0 0 22px;padding-left:18px}
.sw-fw>.sw-nwrap::before{content:"";position:absolute;left:-18px;top:-6px;bottom:0;border-left:1px solid var(--ui-stroke-secondary)}
.sw-fw>.sw-nwrap:first-child::before{top:-14px}
.sw-fw>.sw-nwrap:last-child::before{bottom:calc(100% - 18px)}
.sw-sub{margin-top:6px}
.sw-nwrap{position:relative}
.sw-nd{position:relative;width:100%;display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:8px;
 border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-secondary);color:inherit;font:inherit;text-align:left;cursor:pointer}
.sw-nd::before{content:"";position:absolute;left:-19px;top:50%;width:18px;border-top:1px solid var(--ui-stroke-secondary)}
.sw-nd:hover,.sw-nd.is-open{background:var(--ui-bg-tertiary)}
.sw-fw .sw-nd,.sw-fw .sw-card{background:var(--ui-bg-quaternary)}
.sw-fw .sw-nd:hover,.sw-fw .sw-nd.is-open,.sw-fw .sw-card:hover{background:var(--ui-bg-secondary)}
.sw-nd[data-st=running]{border-color:color-mix(in srgb,var(--ui-yellow) 45%,var(--ui-stroke-tertiary))}
.sw-nd[data-st=queued]{border-style:dashed;background:transparent}
.sw-live{position:sticky;bottom:8px}
.sw-toast{margin:8px auto 0;width:max-content;max-width:100%;padding:6px 12px;border-radius:8px;font-size:12px;
 background:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-tertiary)}
.sw-toast.is-bad{border-color:color-mix(in srgb,var(--ui-red) 55%,transparent)}
.sw-procs{margin-top:6px}
.sw-plab{display:flex;align-items:center;gap:8px}
.sw-plt{display:inline-flex;align-items:center;gap:6px;cursor:default}
.sw-pi{width:13px;height:13px;flex:none}
.sw-pu{margin-left:auto;display:inline-flex;align-items:center;gap:5px;color:var(--ui-text-secondary)}
.sw-pu .sw-mk{width:13px;height:13px}
.sw-plist{display:flex;flex-direction:column;gap:6px}
.sw-pr::before{display:none}
.sw-plist>.sw-box{margin:0}
/* A command's piece hangs off the rail like a worker row: connector at the first line. */
.sw-leaf{position:relative;min-width:0}
.sw-leaf::before{content:"";position:absolute;left:-19px;top:18px;width:18px;border-top:1px solid var(--ui-stroke-secondary)}
.sw-pn{font:11.5px var(--sw-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.sw-px{font-size:11.5px;color:var(--ui-text-secondary);white-space:nowrap;flex:none}
.sw-pc,.sw-po{margin:0;padding:8px 10px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary);
 font:11.5px/16px var(--sw-mono);color:var(--ui-text-secondary);white-space:pre-wrap;word-break:break-word;overflow:auto}
.sw-pc{max-height:98px}
/* The output leaf is a card like its siblings; the text inside it needs no second box. */
.sw-pob{display:flex;flex-direction:column;gap:4px;padding:6px 10px 8px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary)}
.sw-pob .sw-po{padding:0;border:0;border-radius:0;background:transparent;max-height:180px}
.sw-pol{font-size:11.5px;color:var(--ui-text-secondary)}
.sw-po-note{font-size:12px;line-height:18px;color:var(--ui-text-secondary)}
.sw-fio{margin:0 6px 8px;font-size:11.5px;line-height:16px;color:var(--ui-text-secondary)}
.sw-fid{font:11.5px/18px var(--sw-mono);color:var(--ui-text-secondary);padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
 border-radius:4px;cursor:default}
/* ── command deck: the batch as a party — one big score, a unit per agent, a live log ── */
.sw-lab{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.sw-labn{font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ui-text-primary)}
.sw-deck{position:relative;overflow:hidden;margin:0 0 18px;padding:18px 20px 20px;border-radius:14px;
 background:radial-gradient(120% 90% at 18% 0%,color-mix(in srgb,var(--ui-blue) 13%,transparent),transparent 62%),
  radial-gradient(90% 80% at 100% 100%,color-mix(in srgb,var(--ui-yellow) 6%,transparent),transparent 60%),var(--ui-bg-secondary);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-blue) 26%,var(--ui-stroke-tertiary)),var(--shadow-sm)}
.sw-deck::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.6;
 background:linear-gradient(color-mix(in srgb,var(--ui-blue) 9%,transparent) 1px,transparent 1px) 0 0/100% 28px,
  linear-gradient(90deg,color-mix(in srgb,var(--ui-blue) 9%,transparent) 1px,transparent 1px) 0 0/28px 100%;
 -webkit-mask-image:radial-gradient(80% 70% at 35% 25%,currentColor,transparent);mask-image:radial-gradient(80% 70% at 35% 25%,currentColor,transparent)}
.sw-scan{position:absolute;left:0;right:0;top:-110px;height:110px;pointer-events:none;
 background:linear-gradient(transparent,color-mix(in srgb,var(--ui-blue) 8%,transparent),transparent)}
.sw-deck[data-st=running] .sw-scan{animation:sw-scan 6s linear infinite}
@keyframes sw-scan{to{top:100%}}
.sw-score{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:12px 22px}
.sw-big{display:flex;align-items:center;gap:10px;flex:none}
.sw-bign{font-size:46px;font-weight:800;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.sw-deck[data-st=running] .sw-bign{text-shadow:0 0 22px color-mix(in srgb,var(--ui-yellow) 35%,transparent)}
.sw-bign small{font-size:26px;font-weight:700;color:var(--ui-text-secondary)}
.sw-bigl{font-size:13px;line-height:1.25;color:var(--ui-text-secondary);max-width:96px}
.sw-energy{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:8px}
.sw-cells{display:flex;gap:5px;height:14px}
.sw-cells i{flex:1;max-width:120px;border-radius:4px;background:var(--t);box-shadow:0 0 12px color-mix(in srgb,var(--t) 50%,transparent);--t:var(--ui-text-quaternary)}
.sw-cells i[data-st=completed]{--t:var(--ui-green)}
.sw-cells i[data-st=failed]{--t:var(--ui-red)}
.sw-cells i[data-st=running]{--t:var(--ui-yellow);background:linear-gradient(90deg,color-mix(in srgb,var(--ui-yellow) 30%,transparent),var(--ui-yellow),color-mix(in srgb,var(--ui-yellow) 30%,transparent));
 background-size:200% 100%;animation:sw-flow 1.3s linear infinite}
.sw-cells i[data-st=queued]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ui-stroke-secondary)}
@keyframes sw-flow{to{background-position:-200% 0}}
.sw-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.sw-legend b{color:var(--ui-text-primary);font-weight:700}
.sw-money{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;flex:none;border-radius:6px}
.sw-money .sw-bcost{font-size:24px;font-weight:800;color:var(--ui-text-primary)}
.sw-moneyl{font-size:12px;color:var(--ui-text-secondary)}
.sw-party{position:relative;display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;margin-top:20px}
.sw-party .sw-unit{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:2px;height:auto;min-height:188px;min-width:0;
 padding:16px 10px 12px;border-radius:12px;text-align:center;border:1px solid color-mix(in srgb,var(--u) 30%,transparent);
 background:linear-gradient(180deg,color-mix(in srgb,var(--u) 15%,transparent),transparent 78%)}
.sw-party .sw-unit::before{display:none}
.sw-party .sw-unit:hover,.sw-party .sw-unit.is-open{border-color:color-mix(in srgb,var(--u) 65%,transparent);
 background:linear-gradient(180deg,color-mix(in srgb,var(--u) 24%,transparent),transparent 82%)}
.sw-party .sw-unit.is-open{box-shadow:0 0 0 1px color-mix(in srgb,var(--u) 60%,transparent),0 0 18px color-mix(in srgb,var(--u) 25%,transparent)}
.sw-party .sw-unit[data-st=queued]{border-style:dashed}
.sw-from{position:absolute;top:7px;left:9px;font-size:11.5px;color:var(--ui-text-secondary)}
.sw-orb{--o:var(--ui-text-quaternary);position:relative;width:62px;height:62px;flex:none;border-radius:50%;display:grid;place-items:center;margin-bottom:10px;
 background:radial-gradient(circle,color-mix(in srgb,var(--u) 36%,transparent),transparent 72%)}
.sw-orb[data-st=running]{--o:var(--ui-yellow)}
.sw-orb[data-st=completed]{--o:var(--ui-green)}
.sw-orb[data-st=failed]{--o:var(--ui-red)}
.sw-orb::before{content:"";position:absolute;inset:0;border-radius:50%;border:3px solid color-mix(in srgb,var(--o) 30%,transparent)}
.sw-orb[data-st=completed]::before,.sw-orb[data-st=failed]::before{border-color:var(--o);box-shadow:0 0 16px color-mix(in srgb,var(--o) 55%,transparent)}
.sw-orb[data-st=queued]::before{border-style:dashed;border-color:var(--ui-stroke-secondary)}
.sw-orb[data-st=running]::after{content:"";position:absolute;inset:0;border-radius:50%;border:3px solid transparent;border-top-color:var(--o);
 border-right-color:var(--o);filter:drop-shadow(0 0 5px var(--o));animation:sw-rot 1.4s linear infinite}
.sw-unit[data-st=failed] .sw-orb{animation:sw-glitch 2.6s steps(1) infinite}
@keyframes sw-glitch{0%,92%{transform:none}94%{transform:translateX(-2px)}96%{transform:translateX(2px)}98%{transform:none}}
.sw-orbl{font-size:21px;font-weight:800;line-height:1;text-shadow:0 0 12px var(--u)}
.sw-orb .sw-mk{position:absolute;right:-3px;bottom:-3px;width:20px;height:20px;padding:2px;border-radius:50%;background:var(--ui-bg-secondary)}
.sw-party .sw-unit .sw-wn{flex:none;max-width:100%;font-size:14px;font-weight:700;line-height:19px;white-space:normal;overflow-wrap:anywhere;
 display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.sw-us{font-size:12px;line-height:16px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-party .sw-unit .sw-model{margin-top:4px;max-width:100%;height:auto;white-space:normal;overflow-wrap:anywhere;text-align:center}
.sw-ua{margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:1px;max-width:100%;min-width:0;font-size:12.5px;line-height:17px}
.sw-uv{color:var(--ui-text-secondary)}
.sw-ut{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text-primary)}
.sw-party .sw-ut.sw-now{font:12px/17px var(--sw-mono);background:none;padding:0;border-radius:0;max-width:100%}
.sw-unit[data-st=running] .sw-ut.sw-now::after{content:"";display:inline-block;width:6px;height:12px;margin-left:2px;vertical-align:-2px;
 background:var(--ui-yellow);animation:sw-blink 1s steps(1) infinite}
@keyframes sw-blink{50%{opacity:0}}
.sw-unitds{position:relative;display:flex;flex-direction:column;gap:10px;margin-top:12px}
.sw-unitd{padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--ui-bg-primary) 55%,transparent);border:1px solid var(--ui-stroke-tertiary)}
.sw-unitdh{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px;font-weight:600}
.sw-unitdh>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-unitd .sw-dt{margin:6px 0 0 4px}
.sw-sig{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 4px;flex:none;border-radius:6px;font-size:11.5px;font-weight:800;line-height:1;
 color:var(--ui-text-primary);background:color-mix(in srgb,var(--u) 26%,var(--ui-surface-background));
 box-shadow:0 0 0 1px color-mix(in srgb,var(--u) 65%,transparent),0 0 10px color-mix(in srgb,var(--u) 30%,transparent)}
.sw-lower{display:grid;grid-template-columns:minmax(0,1fr);gap:4px 24px}
@container (min-width:640px){.sw-panel .sw-lower.has-log{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}}
.sw-log{list-style:none;margin:0;padding:0 6px;display:flex;flex-direction:column;gap:2px}
.sw-ev{display:grid;grid-template-columns:38px auto minmax(0,1fr);align-items:center;gap:8px;min-height:30px;font-size:12.5px}
.sw-ev:first-child{animation:sw-pop .5s ease-out}
@keyframes sw-pop{from{transform:translateY(-6px);opacity:0}}
.sw-evt{font-size:11.5px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-evw{display:inline-flex;border-radius:6px}
.sw-evx{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-evx code{font:12px var(--sw-mono)}
.sw-ev[data-st=completed] .sw-evx::before,.sw-ev[data-st=failed] .sw-evx::before,.sw-ev[data-st=stopped] .sw-evx::before{content:"";display:inline-block;width:8px;height:8px;
 margin-right:7px;border-radius:50%;vertical-align:0;background:var(--ui-green);box-shadow:0 0 8px var(--ui-green)}
.sw-ev[data-st=failed] .sw-evx::before{background:var(--ui-red);box-shadow:0 0 8px var(--ui-red)}
.sw-ev[data-st=stopped] .sw-evx::before{background:var(--ui-text-quaternary);box-shadow:none}
.sw-files{margin-top:0;min-width:0}
.sw-fil{display:flex;flex-direction:column;gap:10px}
.sw-fig{display:flex;flex-direction:column;gap:6px}
.sw-tiles{display:flex;flex-wrap:wrap;gap:8px}
/* A file is a tile in the colour of the agent that touched it first; a brighter tile was touched more. */
.sw-fir{position:relative;display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;height:38px;padding:0 12px 0 8px;border-radius:10px;border:0;
 background:color-mix(in srgb,var(--u) var(--heat),var(--ui-bg-secondary));box-shadow:0 0 0 1px color-mix(in srgb,var(--u) 40%,var(--ui-stroke-tertiary));
 color:inherit;font:inherit;text-align:left;cursor:pointer;overflow:hidden;--sw-ft:var(--ui-text-tertiary)}
.sw-fir:hover{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--u) 75%,transparent)}
.sw-fir[data-op=write]{--sw-ft:var(--ui-orange)}
.sw-fir[data-op=delete],.sw-fir[data-op=failed]{--sw-ft:var(--ui-red)}
.sw-fir[data-op=failed]{box-shadow:0 0 0 1.5px var(--ui-red),0 0 14px color-mix(in srgb,var(--ui-red) 30%,transparent)}
.sw-fir[data-op=delete] .sw-fin{text-decoration:line-through;text-decoration-color:var(--ui-red)}
.sw-fir[data-op=active]{--sw-ft:var(--ui-yellow);box-shadow:0 0 0 1.5px var(--ui-yellow),0 0 22px color-mix(in srgb,var(--ui-yellow) 40%,transparent)}
/* The file being touched now: a band of light sweeps across its tile. */
.sw-fir[data-op=active]::after{content:"";position:absolute;inset:0;pointer-events:none;transform:translateX(-100%);
 background:linear-gradient(100deg,transparent 20%,color-mix(in srgb,var(--ui-yellow) 32%,transparent) 50%,transparent 80%);animation:sw-shim 1.4s ease-in-out infinite}
@keyframes sw-shim{to{transform:translateX(100%)}}
.sw-sigs{display:inline-flex;gap:3px;flex:none}
.sw-fim{width:12px;height:12px;flex:none;color:var(--sw-ft)}
.sw-fin{font:600 12.5px var(--sw-mono);min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-fic{flex:none;font-size:11.5px;color:var(--ui-text-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
@container (max-width:420px){.sw-panel .sw-fic{display:none}.sw-panel .sw-party{grid-template-columns:repeat(2,minmax(0,1fr))}.sw-panel .sw-bign{font-size:38px}}
.sw-fir:focus-visible,.sw-fid:focus-visible,.sw-money:focus-visible,.sw-evw:focus-visible{outline:2px solid var(--ui-stroke-primary);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.sw-scan,.sw-cells i,.sw-orb,.sw-orb::after,.sw-unit .sw-orb,.sw-ut::after,.sw-ev,.sw-fir[data-op=active]::after{animation:none!important}
 .sw-fir[data-op=active]::after{display:none}}
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
