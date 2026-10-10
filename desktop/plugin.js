/**
 * Subagent Watch — read-only page for delegate_task workers of the focused chat.
 *
 *   Now      the running batch as a tree: batch root -> workers (nested by parent_id) -> merge node.
 *            Fed by gateway `subagent.*` events for the focused runtime session, reconciled by a
 *            `subagent.list` poll (the RPC is session-scoped, so other chats never leak in).
 *   Earlier  finished batches as a collapsed list, from this plugin's backend
 *            (dashboard/plugin_api.py, state.db opened read-only). A worker row opens a detail with
 *            its answer, "copy full output" and "open session".
 *   Background commands
 *            shell commands the agent started with terminal(background=true), running and finished,
 *            from the backend's /processes (Hermes' own processes.json + process-results receipts).
 *            A row opens the full command, its exit code and the end of its output.
 *
 * Nothing here writes: no interrupt, no steer (the composer status stack already owns those).
 * Every failed read is shown in the page; nothing is swallowed.
 */
import { ErrorState, host, Loader, PanelEmpty, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
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
      now: 'Now',
      earlier: 'Earlier',
      older: n => `${n} older`,
      waiting: 'waiting',
      merge: { waiting: 'waiting for workers', done: 'results returned', partial: 'partial results' },
      status: {
        completed: 'Done', failed: 'Failed', running: 'Running', queued: 'Queued',
        stopped: 'Stopped — closed before it finished'
      },
      batch: n => `${n} worker${n === 1 ? '' : 's'}`,
      modelTip: (model, effort) => (effort ? `${model} · reasoning effort ${effort}` : model),
      more: n => `+${n} more`,
      meta: (tools, tokens) => [`${tools} tool${tools === 1 ? '' : 's'}`, tokens ? `${tokens} tokens` : ''].filter(Boolean).join(' · '),
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
      noChat: { title: 'No chat selected', body: 'Open a chat to see its subagents.' },
      empty: { title: 'No subagents yet', body: 'Workers started with delegate_task in this chat appear here.' },
      err: {
        history: 'Could not read earlier batches',
        live: 'Live updates stopped',
        output: 'Could not read the full output',
        procs: 'Could not read background commands',
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
          tokens: (p.input_tokens || 0) + (p.output_tokens || 0), ended_at: Date.now() / 1000
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
async function writeClip(text, t, onToast) {
  // An empty clipboard is not a copy: saying "Copied" would hide that there was nothing to paste.
  if (!text) return onToast(t('sw.nothingToCopy'), true)
  let ok = false
  try {
    ok = await ctxRef.os.writeClipboard(text)
  } catch (err) {
    console.warn(`[${ID}] clipboard write failed`, err)
  }
  onToast(ok ? t('sw.copied') : t('sw.copyFailed'), !ok)
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
            children: t('sw.meta', worker.tool_calls ?? worker.tool_count ?? 0, fmtTokens(worker.tokens, t))
          }, 'm')
        ]
      }, 'a')
    ]
  })
}

function WorkerRow({ t, w, name, open, onToggle }) {
  const time = w.status === 'stopped' ? '—' : fmtDuration(w.duration_s, t)
  return jsxs('button', {
    type: 'button', className: `sw-wr sw-nd sw-acc${open ? ' is-open' : ''}`, 'data-st': w.status, 'aria-expanded': open, onClick: onToggle,
    children: [
      jsx(Mark, { t, status: w.status }, 'm'),
      jsx(NameBlock, { t, goal: w.goal, model: w.model, effort: w.effort, name }, 'n'),
      jsx('span', { className: 'sw-wt', children: time }, 't')
    ]
  })
}

function HistoryBatch({ t, batch, open, onToggle, openWorker, setOpenWorker, onToast }) {
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
              t, w, name: names[i], open: openWorker.has(w.session_id),
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

function Node({ t, r, name, now, kids, depth, openWorker, setOpenWorker, onToast }) {
  const key = r.subagent_id
  const running = r.status === 'running'
  const time = r.status === 'queued' ? t('sw.waiting')
    : r.status === 'stopped' ? '—'
      : fmtDuration(r.duration_s ?? (r.started_at ? now - r.started_at : null), t)
  const children = kids.get(key) || []
  const childNames = distinctNames(children.map(c => c.goal))
  return jsxs('div', {
    className: 'sw-nwrap',
    children: [
      jsxs('button', {
        type: 'button', className: `sw-nd sw-acc${openWorker.has(key) ? ' is-open' : ''}`, 'data-st': r.status,
        'aria-expanded': openWorker.has(key), onClick: () => setOpenWorker(key),
        children: [
          jsx(Mark, { t, status: r.status }, 'm'),
          jsx(NameBlock, { t, goal: r.goal, model: r.model, effort: r.effort, name }, 'n'),
          running && r.last_tool ? jsx('span', { className: 'sw-now', children: r.last_tool }, 'l') : null,
          jsx('span', { className: 'sw-wt', children: time }, 't')
        ]
      }, 'n'),
      openWorker.has(key) ? jsx(Detail, { t, worker: r, onToast }, 'd') : null,
      children.length
        ? jsx('div', {
          className: 'sw-fw sw-sub',
          children: children.map((c, i) => jsx(Node, { t, r: c, name: childNames[i], now, kids, depth: depth + 1, openWorker, setOpenWorker, onToast }, c.subagent_id))
        }, 'k')
        : null
    ]
  })
}

function Flow({ t, batch, now, openWorker, setOpenWorker, onToast }) {
  const statuses = batch.rows.map(r => r.status)
  const st = batchState(statuses)
  const done = statuses.filter(s => s === 'completed').length
  const merge = st === 'running' || st === 'queued' ? 'waiting' : st === 'completed' ? 'done' : 'partial'
  const rootNames = distinctNames(batch.roots.map(r => r.goal))
  return jsxs('div', {
    className: 'sw-fl sw-frame', 'data-st': st, 'data-batch': batch.id,
    children: [
      jsxs('div', {
        className: 'sw-fn sw-root',
        children: [
          jsx(Mark, { t, status: st, focusable: true }, 'd'),
          jsx('span', { className: 'sw-wn', children: t('sw.batch', batch.rows.length) }, 'n'),
          jsx(Strip, { statuses }, 's'),
          jsx('span', { className: 'sw-wt', children: `${done}/${statuses.length}` }, 'c')
        ]
      }, 'r'),
      jsx('div', {
        className: 'sw-fw',
        children: batch.roots.map((r, i) => jsx(Node, { t, r, name: rootNames[i], now, kids: batch.kids, depth: 0, openWorker, setOpenWorker, onToast }, r.subagent_id))
      }, 'w'),
      jsxs('div', {
        className: 'sw-fn sw-merge', 'data-st': st,
        children: [jsx(Mark, { t, status: st, focusable: true }, 'm'), t(`sw.merge.${merge}`)]
      }, 'm')
    ]
  })
}

// ── background commands ──────────────────────────────────────────────────────

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
  // A finished batch moves from Now to Earlier with what the user had open: the batch stays open
  // under Earlier if a worker detail was open or focus was inside it, each open worker detail stays
  // open (Now keys it by subagent id, Earlier by session id), and focus lands on its new header.
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
  // Runs after every render until the moved batch's header exists under Earlier (the live copy is
  // dropped from Now one step after history has it), then hands it the focus once.
  useEffect(() => {
    if (!focusBatch) return
    const header = [...(pageRef.current?.querySelectorAll('[data-batch]') || [])]
      .find(el => el.getAttribute('data-batch') === focusBatch)?.querySelector('button.sw-hb')
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
  const shown = showAll ? past : past.slice(0, HISTORY_PAGE)
  const totals = {
    batches: nowBatches.length + past.length,
    workers: nowBatches.reduce((n, b) => n + b.rows.length, 0) + past.reduce((n, b) => n + b.workers.length, 0)
  }
  const runningN = live.batches.reduce((n, b) => n + b.rows.filter(r => r.status === 'running').length, 0)
  const procSection = storedId
    ? jsx(ProcSection, { t, procs, now, storedId, openProc, toggleProc, onToast }, 'procs')
    : null

  let body
  if (!storedId && !runtimeId) {
    body = jsx(PanelEmpty, { icon: 'comment-discussion', title: t('sw.noChat.title'), description: t('sw.noChat.body') })
  } else if (history.loading && !history.data && !live.batches.length) {
    body = jsx(Loader, { label: t('sw.title') })
  } else if (!live.batches.length && !past.length && history.error && procs.error) {
    body = jsx('p', { className: 'sw-hint', children: t('sw.err.hint') })
  } else if (!live.batches.length && !past.length && !history.error) {
    body = [
      jsx(PanelEmpty, { icon: 'type-hierarchy-sub', title: t('sw.empty.title'), description: t('sw.empty.body') }, 'empty'),
      procSection
    ]
  } else {
    body = [
      live.batches.length ? jsx('h3', { className: 'sw-lab', children: t('sw.now') }, 'nl') : null,
      ...nowBatches.map(b => jsx(Flow, { t, batch: b, now, openWorker, setOpenWorker, onToast }, b.id)),
      past.length ? jsx('h3', { className: 'sw-lab', children: t('sw.earlier') }, 'el') : null,
      ...shown.map(b => {
        const key = batchKey(b)
        return jsx(HistoryBatch, {
          t, batch: b, open: openBatch.has(key), onToggle: () => toggleBatch(key),
          openWorker, setOpenWorker, onToast
        }, key)
      }),
      !showAll && past.length > HISTORY_PAGE
        ? jsx('button', { type: 'button', className: 'sw-more', onClick: () => setShowAll(true), children: t('sw.older', past.length - HISTORY_PAGE) }, 'more')
        : null,
      procSection
    ]
  }

  const errors = [
    history.error ? t('sw.err.withDetail', t('sw.err.history'), history.error) : null,
    live.error ? t('sw.err.withDetail', t('sw.err.live'), live.error) : null,
    procs.error ? t('sw.err.withDetail', t('sw.err.procs'), procs.error) : null
  ].filter(Boolean)
  const refreshAll = () => { history.reload(); procs.reload(); live.retry() }
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

const CSS = `
.sw-page{height:100%;min-height:0;overflow:auto;padding:20px 24px;color:var(--ui-text-primary);font-size:12px}
.sw-panel{position:relative;container-type:inline-size;
 --sw-mono:ui-monospace,"Cascadia Mono",Consolas,var(--dt-font-mono,monospace)}
/* Docked beside the chat the worker name needs every pixel: a model chip cut to 'c…' says nothing. */
@container (max-width:420px){.sw-panel .sw-model,.sw-panel .sw-strip{display:none}.sw-panel .sw-bl{gap:7px;padding:0 8px}.sw-panel .sw-now{max-width:72px}
 /* The hidden strip carried the push to the right; without it counts and times lost their column. */
 .sw-panel .sw-bl .sw-bc{margin-left:auto}}
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
.sw-stat:focus-visible,.sw-mk:focus-visible,.sw-held:focus-visible{
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
.sw-fl{display:flex;flex-direction:column;align-items:stretch;padding:10px 10px 12px;margin:0 0 4px}
.sw-fn{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--ui-stroke-tertiary);
 background:var(--ui-bg-secondary);font-size:12.5px;white-space:nowrap}
.sw-root{font-weight:600}
.sw-merge{color:var(--ui-text-tertiary);border-style:dashed;background:transparent;align-self:center;height:30px;margin-top:14px;position:relative}
.sw-merge::before{content:"";position:absolute;left:50%;top:-15px;height:14px;border-left:1px solid var(--ui-stroke-secondary)}
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
  }
}
