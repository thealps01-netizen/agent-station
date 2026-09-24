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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'subagent-watch'
const ROUTE = '/subagent-watch'
const POLL_MS = 3000
const MAX_POLL_FAILS = 3
const HISTORY_PAGE = 8
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

const BUNDLES = {
  en: {
    sw: {
      title: 'Subagents',
      running: n => `${n} running`,
      nBatches: n => `${n} batches`,
      nWorkers: n => `${n} workers`,
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
      meta: (d, tools, tokens) => [d, `${tools} tools`, tokens ? `${tokens} tokens` : ''].filter(Boolean).join(' · '),
      copy: 'Copy full output',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      open: 'Open session',
      refresh: 'Refresh',
      procs: 'Background commands',
      nProcs: n => `${n} background commands`,
      proc: {
        status: {
          running: 'Running', completed: 'Finished (exit 0)', failed: 'Failed', stopped: 'Stopped before it finished'
        },
        exit: c => `exit ${c}`,
        killed: 'killed',
        cwd: d => `in ${d}`,
        copyCommand: 'Copy command',
        output: 'Output (end)',
        outputCut: n => `last ${n} characters`,
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
        procOutput: 'Could not read the command output'
      }
    }
  }
}

// ── pure helpers (exported for the render check) ─────────────────────────────

export function fmtDuration(s) {
  if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return ''
  const v = Math.round(s)
  if (v >= 3600) return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`
  if (v >= 60) return `${Math.floor(v / 60)}m ${String(v % 60).padStart(2, '0')}s`
  return `${v}s`
}

export function fmtTokens(n) {
  if (!n) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** One line a person can read: the goal's first line, a quoted slug when there is one. */
export function workerName(goal) {
  const line = String(goal || '').trim().split('\n', 1)[0]
  const slug = line.match(/'([a-z0-9][a-z0-9._-]{2,40})'/i)
  return slug ? slug[1] : line
}

/** Model slug without a provider prefix: 'anthropic/claude-opus-5-5' -> 'claude-opus-5-5'. */
export function modelLabel(model) {
  return String(model || '').split('/').pop()
}

// Full goal lives in the name's tooltip: the row stays one line, the purpose is one hover away.
function NameBlock({ goal, model }) {
  const m = modelLabel(model)
  return jsxs('span', {
    className: 'sw-nl',
    children: [
      jsx(Tip, { label: String(goal || '').trim(), children: jsx('span', { className: 'sw-wn', children: workerName(goal) }) }, 'n'),
      m ? jsx('span', { className: 'sw-model', children: m }, 'm') : null
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
const MARKS = {
  completed: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--ui-green)' }, 'c'),
    jsx('path', {
      d: 'M4.8 8.2l2.1 2.1 4.3-4.4', fill: 'none', stroke: '#fff', strokeWidth: 2,
      strokeLinecap: 'round', strokeLinejoin: 'round'
    }, 'p')
  ]),
  failed: () => svg([
    jsx('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--ui-red)' }, 'c'),
    jsx('path', { d: 'M5.5 5.5l5 5M10.5 5.5l-5 5', stroke: '#fff', strokeWidth: 2, strokeLinecap: 'round' }, 'p')
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

function Mark({ status, t }) {
  const st = MARKS[status] ? status : 'stopped'
  return jsx(Tip, { label: t(`sw.status.${st}`), children: jsx('span', { className: 'sw-mk', 'data-st': st, children: MARKS[st]() }) })
}

function Strip({ statuses }) {
  return jsx('span', {
    className: 'sw-strip',
    children: statuses.map((s, i) => jsx('i', { 'data-st': s, style: { '--t': TONE[s] || TONE.stopped } }, i))
  })
}

function IconButton({ label, icon, onClick, disabled }) {
  return jsx(Tip, {
    label,
    children: jsx('button', {
      type: 'button', className: 'sw-ib', 'aria-label': label, disabled, onClick, children: icon()
    })
  })
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
    setState(prev => ({ ...prev, key: storedId, loading: true, data: prev.key === storedId ? prev.data : null }))
    ctxRef.rest(`/children?session_id=${encodeURIComponent(storedId)}`).then(
      data => mine === gen.current && setState({ key: storedId, data, error: null, loading: false }),
      err => mine === gen.current && setState(prev => ({ ...prev, error: String(err?.message || err), loading: false }))
    )
  }, [storedId])
  useEffect(load, [load])
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
  return { ...(state.key === storedId ? state : { data: null, error: null }), reload: load }
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
  const endedRef = useRef(onBatchEnded)
  endedRef.current = onBatchEnded

  useEffect(() => {
    setRecords({})
    setError(null)
    fails.current = 0
    if (!runtimeId) return undefined

    const upsert = patch => setRecords(prev => ({ ...prev, [patch.subagent_id]: mergeRecord(prev[patch.subagent_id] || {}, patch) }))
    const offs = SUBAGENT_EVENTS.map(type => ctxRef.onEvent(type, event => {
      if (event?.session_id !== runtimeId) return
      const p = event.payload || {}
      if (!p.subagent_id) return
      const base = {
        subagent_id: p.subagent_id, parent_id: p.parent_id, delegation_id: p.delegation_id, depth: p.depth,
        goal: p.goal, model: p.model, task_index: p.task_index, child_session_id: p.child_session_id,
        tool_count: p.tool_count
      }
      if (type === 'subagent.spawn_requested') upsert({ ...base, status: 'queued' })
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
        setRecords(prev => {
          const next = { ...prev }
          for (const r of snap?.subagents || []) {
            seen.add(r.subagent_id)
            next[r.subagent_id] = mergeRecord(prev[r.subagent_id] || {}, { ...r, status: STATUS_OF[r.status] || r.status })
          }
          // A worker the backend no longer tracks ended without a complete frame reaching us.
          for (const [id, r] of Object.entries(next)) {
            if (!seen.has(id) && !TERMINAL.has(r.status)) next[id] = { ...r, status: 'stopped', ended_at: Date.now() / 1000 }
          }
          return next
        })
      } catch (err) {
        fails.current += 1
        console.warn(`[${ID}] subagent.list failed (${fails.current}/${MAX_POLL_FAILS})`, err)
        if (alive && fails.current >= MAX_POLL_FAILS) setError(String(err?.message || err))
      }
    }
    void poll()
    const stop = ctxRef.setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      stop()
      offs.forEach(off => off())
    }
  }, [runtimeId])

  // A batch whose workers are all terminal moves to history: reload it, then drop it from "Now".
  const batches = useMemo(() => liveBatches(Object.values(records)), [records])
  const finished = batches.filter(b => b.rows.every(r => TERMINAL.has(r.status))).map(b => b.id).join('|')
  useEffect(() => {
    if (!finished) return
    const ids = new Set(finished.split('|'))
    Promise.resolve(endedRef.current?.()).finally(() => {
      setRecords(prev => {
        const next = { ...prev }
        for (const [k, r] of Object.entries(next)) if (ids.has(r.delegation_id || `solo:${k}`)) delete next[k]
        return next
      })
    })
  }, [finished])

  return { batches: batches.filter(b => !b.rows.every(r => TERMINAL.has(r.status))), error }
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Detail({ t, worker, onToast }) {
  const [busy, setBusy] = useState(false)
  const sid = worker.session_id || worker.child_session_id
  const copy = async () => {
    if (!sid) return
    setBusy(true)
    try {
      const out = await ctxRef.rest(`/output?session_id=${encodeURIComponent(sid)}`)
      const ok = await ctxRef.os.writeClipboard(out?.text || '')
      onToast(ok ? t('sw.copied') : t('sw.copyFailed'), !ok)
    } catch (err) {
      console.warn(`[${ID}] output read failed`, err)
      onToast(`${t('sw.err.output')}: ${String(err?.message || err)}`, true)
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
  return jsxs('div', {
    className: 'sw-dt',
    children: [
      goal ? jsx(Tip, { label: goal, children: jsx('div', { className: 'sw-dtg', children: jsx('span', { children: goal }) }) }, 'g') : null,
      jsxs('div', {
        className: 'sw-dta',
        children: [
          jsx(IconButton, { label: t('sw.copy'), icon: ICON.copy, onClick: copy, disabled: busy || !sid }, 'c'),
          jsx(IconButton, { label: t('sw.open'), icon: ICON.open, onClick: open, disabled: !sid }, 'o'),
          jsx('span', {
            className: 'sw-dtm',
            children: t('sw.meta', fmtDuration(worker.duration_s), worker.tool_calls ?? worker.tool_count ?? 0, fmtTokens(worker.tokens))
          }, 'm')
        ]
      }, 'a')
    ]
  })
}

function WorkerRow({ t, w, open, onToggle }) {
  const time = w.status === 'stopped' ? '—' : fmtDuration(w.duration_s)
  return jsxs('button', {
    type: 'button', className: `sw-wr sw-nd sw-acc${open ? ' is-open' : ''}`, 'data-st': w.status, 'aria-expanded': open, onClick: onToggle,
    children: [
      jsx(Mark, { t, status: w.status }, 'm'),
      jsx(NameBlock, { goal: w.goal, model: w.model }, 'n'),
      jsx('span', { className: 'sw-wt', children: time }, 't')
    ]
  })
}

function HistoryBatch({ t, batch, open, onToggle, openWorker, setOpenWorker, onToast }) {
  const statuses = batch.workers.map(w => w.status)
  const st = batchState(statuses)
  const done = statuses.filter(s => s === 'completed').length
  const times = batch.workers.map(w => w.duration_s).filter(v => v !== null && v !== undefined)
  const head = [
    jsx(Mark, { t, status: st }, 'm'),
    jsx('span', { className: 'sw-bn', children: workerName(batch.workers[0]?.goal) }, 'n'),
    jsx(Strip, { statuses }, 's'),
    jsx('span', { className: 'sw-bc', children: `${done}/${statuses.length}` }, 'c'),
    jsx('span', { className: 'sw-bt', children: times.length ? fmtDuration(Math.max(...times)) : '' }, 't'),
    jsx('span', { className: 'sw-chev', children: ICON.chev(open) }, 'v')
  ]
  if (!open) {
    return jsx('button', { type: 'button', className: 'sw-bl sw-card sw-acc', 'data-st': st, 'aria-expanded': false, onClick: onToggle, children: head })
  }
  return jsxs('section', {
    className: 'sw-box sw-frame', 'data-st': st,
    children: [
      jsx('button', { type: 'button', className: 'sw-bl sw-bh', 'aria-expanded': true, onClick: onToggle, children: head }, 'h'),
      // Same tree as the live batch: the header is the root, each worker hangs off one rail.
      jsx('div', {
        className: 'sw-bb sw-fw',
        children: batch.workers.map(w => jsxs('div', {
          className: 'sw-nwrap',
          children: [
            jsx(WorkerRow, {
              t, w, open: openWorker.has(w.session_id),
              onToggle: () => setOpenWorker(w.session_id)
            }, 'r'),
            openWorker.has(w.session_id) ? jsx(Detail, { t, worker: w, onToast }, 'd') : null
          ]
        }, w.session_id))
      }, 'b')
    ]
  })
}

function Node({ t, r, now, kids, depth, openWorker, setOpenWorker, onToast }) {
  const key = r.subagent_id
  const running = r.status === 'running'
  const time = r.status === 'queued' ? t('sw.waiting')
    : r.status === 'stopped' ? '—'
      : fmtDuration(r.duration_s ?? (r.started_at ? now - r.started_at : null))
  const children = kids.get(key) || []
  return jsxs('div', {
    className: 'sw-nwrap',
    children: [
      jsxs('button', {
        type: 'button', className: `sw-nd sw-acc${openWorker.has(key) ? ' is-open' : ''}`, 'data-st': r.status,
        'aria-expanded': openWorker.has(key), onClick: () => setOpenWorker(key),
        children: [
          jsx(Mark, { t, status: r.status }, 'm'),
          jsx(NameBlock, { goal: r.goal, model: r.model }, 'n'),
          running && r.last_tool ? jsx('span', { className: 'sw-now', children: r.last_tool }, 'l') : null,
          jsx('span', { className: 'sw-wt', children: time }, 't')
        ]
      }, 'n'),
      openWorker.has(key) ? jsx(Detail, { t, worker: r, onToast }, 'd') : null,
      children.length
        ? jsx('div', {
          className: 'sw-fw sw-sub',
          children: children.map(c => jsx(Node, { t, r: c, now, kids, depth: depth + 1, openWorker, setOpenWorker, onToast }, c.subagent_id))
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
  return jsxs('div', {
    className: 'sw-fl sw-frame', 'data-st': st,
    children: [
      jsxs('div', {
        className: 'sw-fn sw-root',
        children: [
          jsx(Mark, { t, status: st }, 'd'),
          jsx('span', { className: 'sw-wn', children: t('sw.batch', batch.rows.length) }, 'n'),
          jsx(Strip, { statuses }, 's'),
          jsx('span', { className: 'sw-wt', children: `${done}/${statuses.length}` }, 'c')
        ]
      }, 'r'),
      jsx('div', {
        className: 'sw-fw',
        children: batch.roots.map(r => jsx(Node, { t, r, now, kids: batch.kids, depth: 0, openWorker, setOpenWorker, onToast }, r.subagent_id))
      }, 'w'),
      jsxs('div', {
        className: 'sw-fn sw-merge', 'data-st': st,
        children: [jsx(Mark, { t, status: st }, 'm'), t(`sw.merge.${merge}`)]
      }, 'm')
    ]
  })
}

// ── background commands ──────────────────────────────────────────────────────

/** First non-empty line of a command, for the one-line row; the full text is the tooltip. */
export function commandLine(command) {
  return String(command || '').split('\n').map(s => s.trim()).find(Boolean) || ''
}

function ProcDetail({ t, p, storedId, onToast }) {
  const [out, setOut] = useState({ loading: p.status !== 'running', data: null, error: null })
  useEffect(() => {
    if (p.status === 'running') return undefined
    let alive = true
    ctxRef.rest(`/process_output?session_id=${encodeURIComponent(storedId)}&process_id=${encodeURIComponent(p.id)}`).then(
      data => alive && setOut({ loading: false, data, error: null }),
      err => alive && setOut({ loading: false, data: null, error: String(err?.message || err) })
    )
    return () => { alive = false }
  }, [p.id, p.status, storedId])
  const copy = async () => {
    const ok = await ctxRef.os.writeClipboard(out.data?.command || p.command || '')
    onToast(ok ? t('sw.copied') : t('sw.copyFailed'), !ok)
  }
  let body
  if (p.status === 'running') body = jsx('div', { className: 'sw-po-note', children: t('sw.proc.whileRunning') })
  else if (out.loading) body = jsx(Loader, { label: t('sw.proc.output') })
  else if (out.error) body = jsx(ErrorState, { title: `${t('sw.err.procOutput')}: ${out.error}` })
  else if (!out.data?.output) body = jsx('div', { className: 'sw-po-note', children: t('sw.proc.noOutput') })
  else body = jsx('pre', { className: 'sw-po', children: out.data.output })
  const meta = [
    p.status === 'stopped' ? t('sw.proc.killed') : p.exit_code !== null && p.exit_code !== undefined ? t('sw.proc.exit', p.exit_code) : '',
    p.cwd ? t('sw.proc.cwd', p.cwd) : ''
  ].filter(Boolean).join(' · ')
  return jsxs('div', {
    className: 'sw-dt',
    children: [
      jsx('pre', { className: 'sw-pc', children: out.data?.command || p.command }, 'c'),
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

function ProcRow({ t, p, now, open, onToggle }) {
  const time = p.status === 'running'
    ? fmtDuration(p.started_at ? now - p.started_at : null)
    : p.status === 'stopped' ? '—' : fmtDuration(p.duration_s)
  return jsxs('button', {
    type: 'button', className: `sw-pr sw-nd sw-acc${open ? ' is-open' : ''}`, 'data-st': p.status, 'aria-expanded': open, onClick: onToggle,
    children: [
      jsx(Tip, { label: t(`sw.proc.status.${p.status}`), children: jsx('span', { className: 'sw-mk', 'data-st': p.status, children: (MARKS[p.status] || MARKS.stopped)() }) }, 'm'),
      jsx(Tip, { label: p.command, children: jsx('code', { className: 'sw-pn', children: commandLine(p.command) }) }, 'n'),
      p.status === 'failed' && p.exit_code !== null && p.exit_code !== undefined
        ? jsx('span', { className: 'sw-px', children: t('sw.proc.exit', p.exit_code) }, 'x')
        : null,
      jsx('span', { className: 'sw-wt', children: time }, 't')
    ]
  })
}

function ProcSection({ t, procs, now, storedId, openProc, toggleProc, onToast }) {
  const unreadable = procs.data?.unreadable || 0
  const rows = [...(procs.data?.processes || [])].reverse()
  if (!rows.length && !unreadable) return null
  return jsxs('section', {
    className: 'sw-procs',
    children: [
      jsxs('div', {
        className: 'sw-lab sw-plab',
        children: [
          jsx(Tip, { label: t('sw.proc.notSubagent'), children: jsxs('span', { className: 'sw-plt', children: [jsx('span', { className: 'sw-pi', children: ICON.term() }, 'i'), t('sw.procs')] }) }, 'l'),
          unreadable ? jsx('span', { className: 'sw-pu', children: t('sw.proc.unreadable', unreadable) }, 'u') : null
        ]
      }, 'h'),
      jsx('div', {
        className: 'sw-plist',
        children: rows.map(p => jsxs('div', {
          className: 'sw-nwrap',
          children: [
            jsx(ProcRow, { t, p, now, open: openProc.has(p.id), onToggle: () => toggleProc(p.id) }, 'r'),
            openProc.has(p.id) ? jsx(ProcDetail, { t, p, storedId, onToast }, `d-${p.status}`) : null
          ]
        }, p.id))
      }, 'l')
    ]
  })
}

// ── page ─────────────────────────────────────────────────────────────────────

/** A set of open card keys: toggle(key) flips one card, clear() folds them all (on chat change). */
function useOpenSet() {
  const [open, setOpen] = useState(() => new Set())
  const toggle = key => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return [open, toggle, () => setOpen(new Set())]
}

export function Page() {
  const t = usePluginI18n(ID)
  const runtimeId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId)
  const history = useHistory(storedId)
  const live = useLive(runtimeId, history.reload)
  const procs = useProcesses(storedId)
  // Each card opens and closes on its own: opening one never folds another.
  const [openBatch, toggleBatch, clearBatches] = useOpenSet()
  const [openWorker, setOpenWorker, clearWorkers] = useOpenSet()
  const [openProc, toggleProc, clearProcs] = useOpenSet()
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
  }, [storedId])
  useEffect(() => {
    if (!toast) return undefined
    return ctxRef.setTimeout(() => setToast(null), 2400)
  }, [toast])
  const onToast = (text, bad) => setToast({ text, bad })

  const liveSessions = new Set(live.batches.flatMap(b => b.rows.map(r => r.child_session_id).filter(Boolean)))
  // subagent.list carries no child_session_id, so a batch still running on the backend is matched by
  // state: while a live tree is drawn, a stored batch with an unfinished worker IS that tree.
  const past = (history.data?.batches || [])
    .filter(b => !(live.batches.length && b.workers.some(w => w.status === 'running')))
    .map(b => ({ ...b, workers: b.workers.filter(w => !liveSessions.has(w.session_id)) }))
    .filter(b => b.workers.length)
    .reverse()
  const shown = showAll ? past : past.slice(0, HISTORY_PAGE)
  const totals = {
    batches: live.batches.length + past.length,
    workers: live.batches.reduce((n, b) => n + b.rows.length, 0) + past.reduce((n, b) => n + b.workers.length, 0)
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
  } else if (!live.batches.length && !past.length && !history.error) {
    body = [
      jsx(PanelEmpty, { icon: 'type-hierarchy-sub', title: t('sw.empty.title'), description: t('sw.empty.body') }, 'empty'),
      procSection
    ]
  } else {
    body = [
      live.batches.length ? jsx('div', { className: 'sw-lab', children: t('sw.now') }, 'nl') : null,
      ...live.batches.map(b => jsx(Flow, { t, batch: b, now, openWorker, setOpenWorker, onToast }, b.id)),
      past.length ? jsx('div', { className: 'sw-lab', children: t('sw.earlier') }, 'el') : null,
      ...shown.map(b => {
        const key = String(b.started_at)
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
    history.error ? `${t('sw.err.history')}: ${history.error}` : null,
    live.error ? `${t('sw.err.live')}: ${live.error}` : null,
    procs.error ? `${t('sw.err.procs')}: ${procs.error}` : null
  ].filter(Boolean)

  return jsxs('div', {
    className: 'sw-page',
    children: [
      jsx('style', { children: CSS }, 'css'),
      jsxs('div', {
        className: 'sw-panel',
        children: [
          jsxs('header', {
            className: 'sw-hd sw-frame', 'data-st': runningN || procsRunning ? 'running' : 'completed',
            children: [
              jsx('span', { className: 'sw-hi', children: ICON.tree() }, 'i'),
              jsx('span', { className: 'sw-ht', children: t('sw.title') }, 't'),
              jsx(Tip, { label: t('sw.nBatches', totals.batches), children: jsxs('span', { className: 'sw-stat', children: [ICON.stack(), totals.batches] }) }, 'sb'),
              jsx(Tip, { label: t('sw.nWorkers', totals.workers), children: jsxs('span', { className: 'sw-stat', children: [ICON.bot(), totals.workers] }) }, 'sw'),
              jsx(Tip, { label: t('sw.nProcs', procRows.length), children: jsxs('span', { className: 'sw-stat', children: [ICON.term(), procRows.length] }) }, 'sp'),
              runningN
                ? jsxs('span', { className: 'sw-pill', children: [MARKS.running(), t('sw.running', runningN)] }, 'p')
                : null,
              jsx(IconButton, { label: t('sw.refresh'), icon: ICON.refresh, onClick: () => { history.reload(); procs.reload() }, disabled: !storedId }, 'r')
            ]
          }, 'h'),
          errors.length
            ? jsx('div', { className: 'sw-err', role: 'alert', children: errors.map(e => jsx(ErrorState, { title: e }, e)) }, 'e')
            : null,
          jsx('div', { className: 'sw-bd', children: body }, 'b'),
          toast ? jsx('div', { className: `sw-toast${toast.bad ? ' is-bad' : ''}`, role: 'status', children: toast.text }, 'toast') : null
        ]
      }, 'panel')
    ]
  })
}

const CSS = `
.sw-page{height:100%;min-height:0;overflow:auto;padding:20px 24px;color:var(--ui-text-primary);font-size:12px}
.sw-panel{max-width:560px;position:relative}
.sw-page svg{width:100%;height:100%;display:block}
.sw-spin{animation:sw-rot 1.1s linear infinite;transform-origin:50% 50%}
@keyframes sw-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sw-spin{animation:none}}
.sw-mk{width:15px;height:15px;flex:none;display:inline-block}
.sw-hd{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;margin:0 0 14px}
.sw-hi{width:30px;height:30px;padding:6px;border-radius:8px;flex:none;color:var(--sw-tint);
 background:color-mix(in srgb,var(--sw-tint) 14%,transparent);border:1px solid color-mix(in srgb,var(--sw-tint) 30%,transparent)}
.sw-ht{font-size:14px;font-weight:600;flex:1;min-width:0}
.sw-stat{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px 0 6px;border-radius:99px;font-size:11.5px;
 color:var(--ui-text-secondary);background:var(--ui-bg-tertiary);font-variant-numeric:tabular-nums}
.sw-stat svg{width:13px;height:13px}
.sw-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 6px;border-radius:99px;font-size:11.5px;
 color:var(--ui-text-secondary);background:var(--ui-bg-tertiary)}
.sw-pill svg{width:13px;height:13px}
.sw-ib{width:26px;height:26px;padding:5px;border-radius:6px;color:var(--ui-text-secondary);background:transparent;
 border:1px solid var(--ui-stroke-tertiary);cursor:pointer;flex:none}
.sw-ib:hover:not(:disabled){background:var(--ui-bg-tertiary);color:var(--ui-text-primary)}
.sw-ib:disabled{opacity:.45;cursor:default}
.sw-err{margin:8px 0;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--ui-red) 45%,transparent);font-size:12px}
.sw-bd{padding-bottom:12px}
.sw-lab{font-size:11px;color:var(--ui-text-tertiary);padding:14px 6px 6px}
.sw-more{font-size:11.5px;color:var(--ui-text-tertiary);padding:8px 6px 0;background:none;border:0;cursor:pointer}
.sw-more:hover{color:var(--ui-text-primary)}
.sw-strip{display:flex;gap:2px;margin-left:auto;flex:none}
.sw-strip i{width:14px;height:5px;border-radius:2px;background:var(--t)}
.sw-strip i[data-st=queued]{background:transparent;box-shadow:inset 0 0 0 1px var(--t)}
.sw-bc,.sw-bt,.sw-wt{font-size:11.5px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.sw-bc{min-width:28px;text-align:right}
.sw-bt{min-width:52px;text-align:right}
.sw-chev{width:14px;height:14px;color:var(--ui-text-quaternary);flex:none}
.sw-box{margin:2px 0 8px;overflow:hidden}
.sw-bl{width:100%;height:38px;display:flex;align-items:center;gap:9px;padding:0 10px;border-radius:8px;border:0;background:transparent;
 color:inherit;font:inherit;text-align:left;cursor:pointer}
.sw-bl:hover{background:var(--ui-bg-secondary)}
.sw-bh{border-radius:0;box-shadow:none}
.sw-frame{position:relative;border:1px solid var(--ui-stroke-tertiary);border-radius:10px;
 background:linear-gradient(180deg,color-mix(in srgb,var(--sw-tint) 7%,var(--ui-bg-secondary)),var(--ui-bg-secondary) 70%);
 box-shadow:0 1px 0 rgb(255 255 255 / .03) inset,0 2px 8px rgb(0 0 0 / .22);--sw-tint:var(--ui-green)}
.sw-frame::after{content:"";position:absolute;left:-1px;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--sw-tint)}
.sw-frame[data-st=failed]{--sw-tint:var(--ui-red)}
.sw-frame[data-st=stopped],.sw-frame[data-st=interrupted],.sw-frame[data-st=queued]{--sw-tint:var(--ui-text-quaternary)}
.sw-frame[data-st=running]{--sw-tint:var(--ui-yellow)}
.sw-frame .sw-bh{background:transparent}
.sw-frame .sw-bh:hover{background:color-mix(in srgb,var(--ui-bg-tertiary) 60%,transparent)}
.sw-acc{position:relative;box-shadow:0 1px 2px rgb(0 0 0 / .18);transition:background .12s,border-color .12s}
.sw-acc::after{content:"";position:absolute;left:-1px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--ui-green)}
.sw-acc[data-st=failed]::after{background:var(--ui-red)}
.sw-acc[data-st=stopped]::after,.sw-acc[data-st=interrupted]::after,.sw-acc[data-st=queued]::after{background:var(--ui-text-quaternary)}
.sw-acc[data-st=running]::after{background:var(--ui-yellow)}
.sw-card{margin:0 0 6px;border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-secondary)}
.sw-card:hover,.sw-nd.sw-acc:hover{background:var(--ui-bg-tertiary);border-color:var(--ui-stroke-secondary)}
.sw-bn{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sw-box .sw-bb{margin:4px 10px 10px 18px}
.sw-box .sw-bb>.sw-nwrap:first-child::before{top:-4px}
.sw-wn{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.sw-nl{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.sw-nl .sw-wn{flex:0 0 auto;max-width:70%}
.sw-model{font:10.5px var(--dt-font-mono,ui-monospace,monospace);color:var(--ui-text-tertiary);border:1px solid var(--ui-stroke-tertiary);
 border-radius:4px;padding:0 5px;line-height:15px;white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sw-muted{color:var(--ui-text-tertiary)!important}
.sw-now{font:11px var(--dt-font-mono,ui-monospace,monospace);color:var(--ui-text-tertiary);background:var(--ui-bg-tertiary);
 border-radius:4px;padding:1px 6px;flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-dt{margin:2px 10px 6px 34px;padding:6px;border-radius:6px;border:1px solid var(--ui-stroke-tertiary);display:flex;flex-direction:column;gap:6px}
.sw-fw .sw-dt{margin:-1px 0 0;border-top-left-radius:0;border-top-right-radius:0;border-top-style:dashed;background:var(--ui-bg-quaternary)}
.sw-fw .sw-nd.is-open{border-bottom-left-radius:0;border-bottom-right-radius:0}
.sw-dtg{padding:8px 10px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary)}
.sw-dtg>span{font-size:12px;line-height:18px;color:var(--ui-text-secondary);display:-webkit-box;-webkit-line-clamp:3;
 -webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sw-dta{display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary)}
.sw-dtm{margin-left:auto;font-size:11px;color:var(--ui-text-tertiary);white-space:nowrap}
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
:root:not(.dark) .sw-frame{box-shadow:0 1px 3px rgb(0 0 0 / .08)}
:root:not(.dark) .sw-acc{box-shadow:0 1px 1px rgb(0 0 0 / .05)}
.sw-nd[data-st=running]{border-color:color-mix(in srgb,var(--ui-yellow) 45%,var(--ui-stroke-tertiary))}
.sw-nd[data-st=queued]{border-style:dashed;background:transparent}
.sw-toast{position:sticky;bottom:8px;margin:8px auto 0;width:max-content;max-width:100%;padding:6px 12px;border-radius:8px;font-size:12px;
 background:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-tertiary)}
.sw-toast.is-bad{border-color:color-mix(in srgb,var(--ui-red) 55%,transparent)}
.sw-procs{margin-top:6px}
.sw-plab{display:flex;align-items:center;gap:8px}
.sw-plt{display:inline-flex;align-items:center;gap:6px;cursor:default}
.sw-pi{width:13px;height:13px;flex:none}
.sw-pu{margin-left:auto;color:var(--ui-red)}
.sw-plist{display:flex;flex-direction:column;gap:6px}
.sw-pr::before{display:none}
.sw-pn{font:11.5px var(--dt-font-mono,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.sw-px{font-size:11px;color:var(--ui-red);white-space:nowrap;flex:none}
.sw-plist .sw-dt{margin:-1px 0 0;border-top-left-radius:0;border-top-right-radius:0;border-top-style:dashed;background:var(--ui-bg-quaternary)}
.sw-plist .sw-nd.is-open{border-bottom-left-radius:0;border-bottom-right-radius:0}
.sw-pc,.sw-po{margin:0;padding:8px 10px;border-radius:5px;background:var(--ui-bg-quinary);border:1px solid var(--ui-stroke-tertiary);
 font:11px/16px var(--dt-font-mono,ui-monospace,monospace);color:var(--ui-text-secondary);white-space:pre-wrap;word-break:break-word;overflow:auto}
.sw-pc{max-height:96px}
.sw-po{height:180px}
.sw-pob{display:flex;flex-direction:column;gap:4px}
.sw-pol{font-size:11px;color:var(--ui-text-tertiary);padding:0 2px}
.sw-po-note{font-size:12px;color:var(--ui-text-tertiary);padding:8px 10px}
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
