/**
 * Subagent Watch — rendered in jsdom with the real React, driven like a user.
 *
 * Run: cd tests && npm install && node render_check.mjs      (exit 0 = passed)
 *
 * Locks:
 *   1. Registration: a `routes` page + a `sidebar.nav` entry with a resolved label; never a pane.
 *   2. Session scoping: only `subagent.*` / `tool.*` events whose session_id is the FOCUSED runtime id
 *      land; `subagent.list` is called with that id; switching chats clears the live run, folds open
 *      command rows and selects the main agent.
 *   3. Statuses never mislabel: queued / running / completed / failed / stopped each draw their own
 *      icon; a queued or failed unit never draws the done check.
 *   4. Live run: the main agent first, nested workers right after their parent, a unit's icon is what
 *      it does now (edit / read / run / waiting), the main agent waits on its subagents.
 *   6. Copy answer reads /output for THAT worker's session id; Open its chat calls host.openSession
 *      with the child session id; copy has a busy state; empty output is "Nothing to copy".
 *   7. Failures are visible: one alert lists each failing source (history, live polls, commands,
 *      files) with Try again; a count whose source failed reads "—", never 0.
 *   8. A finished live run reloads history and stays as the last run (no empty flash), keeping the
 *      selected subagent and the keyboard focus; a run still listed by subagent.list is not re-added.
 *   9. Commands tab: read for the STORED chat id, newest first, a status per row, exit code on a failed
 *      row, "—" for a stopped one; an opened row shows exit code, cwd, the full command, the output
 *      tail and Copy output; running (no read yet), loading, unreadable (alert + Try again), printed
 *      nothing, no receipt; unreadable records counted; polled.
 *  10. Refresh after live polls gave up resets the failure count and polling resumes.
 *  11. A clipboard rejection on any copy button is a "Copy failed" toast, never an unhandled rejection.
 *  15. The watched chat: a click inside the page (or on another page's route tile) keeps the chat the
 *      page shows and marks it held; a click on a chat, in the Sessions sidebar, or elsewhere follows.
 *  16. Live races: a queued worker not yet listed stays queued; a stale snapshot never revives a
 *      finished worker; a dead chat's failed poll does not count against the new chat.
 *  17. Cost: the score shows what the subagents spent (~ estimate, billed, subscription apart, never
 *      $0 for unpriced); a live complete frame's cost joins the run.
 *  18. Progress chip in the status bar (1.6.0 behaviour) + the pet line; the chip takes the look.
 *  19. Files: pathKey agrees with the backend on every path_vectors.json case; files are read for the
 *      STORED chat id; the main agent's panel lists Changed (EDIT ×n / FAILED / DELETED, a bar per
 *      count) and Only read (first rows + Show N more); a row copies its full path; the panel says
 *      what it cannot see; a subagent's files come from /files who/editors; the main agent's live
 *      file calls are the 'Working on now' rows (the 1.6.0 shimmer), scoped to the focused chat,
 *      lingering, reloading the list; unreadable calls and files past the list are said.
 *  20. Looks: Cockpit by default; the toggle switches to Terminal (ASCII sprites, [OK ] tags) and back,
 *      and keeps the choice in ctx.storage; a kept look is read back; a storage that throws, a value
 *      that is not a look, or no storage at all falls back to Cockpit and the toggle still works.
 *  21. Units: the main agent is the first unit, tagged MAIN and selected by default; no letter badges.
 *  22. Run picker: this run plus earlier runs (mini cells, time ago, done/total, cost, paged with
 *      "Show N older runs"); an earlier run is shown calmly with Back to now; Escape closes it.
 *  23. A selected subagent: task (Show all), model chip (tooltip = full id + effort), its answer,
 *      tools · tokens · cost.
 *  24. Edge states: no chat selected, a loading skeleton, a chat with no subagents (main agent unit +
 *      what subagents are + its files or none yet).
 *  25. More than 8 subagents: the swarm (40-subagent fixture) — main agent on top, Failed by name,
 *      Working cells (tooltip, click selects), Waiting and Done collapsed behind Show; units wrap.
 *  26. Reduced motion stops every page animation; the motion moments exist (ring close, shake, count
 *      up, slide, breathe, retyped tag, cursor blink); text never below 11.5px; focus rings; focusable
 *      tooltip triggers; reading tokens; a mounted live region.
 *
 * Removed in 1.7.0 with the features they locked: agent letters (agentLetters / baseLetters, the
 * letter badges on tiles and in the log), the live log section, the Earlier list (now the run picker,
 * lock 22), the separate FILES section with its folder groups and tiles (now the focus panel, lock
 * 19), the header pill/count chips and tint, the batch tree / framed cards and their CSS rules, and
 * "an opened failed command does not repeat its exit code" (the approved design shows it).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE_URL = new URL('.', import.meta.url)
const HERE = fileURLToPath(HERE_URL).replace(/\\/g, '/')
const SRC = process.argv[2] || `${HERE}../desktop/plugin.js`
// SW_RENDER_OUT names a sub-folder so parallel runs (the canary) never share their build files.
const OUT_REL = `.out/${process.env.SW_RENDER_OUT ? `${process.env.SW_RENDER_OUT}/` : ''}`
const OUT = `${HERE}${OUT_REL}`
mkdirSync(OUT, { recursive: true })

writeFileSync(`${OUT}sdk-stub.mjs`, `
import { cloneElement, isValidElement, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

export const calls = { request: [], opened: [], navigated: [] }
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const state = { listFails: false, list: {}, listHold: null }

function atom(v) {
  const subs = new Set()
  return { get: () => v, set: n => { v = n; subs.forEach(f => f()) }, listen: f => { subs.add(f); return () => subs.delete(f) } }
}
export const atoms = { focusedSessionId: atom('rt-1'), focusedStoredSessionId: atom('st-1'), busyBySession: atom({}) }
export const pet = { visible: atom(false), said: [], cleared: [] }
export function useValue(a) { return useSyncExternalStore(a.listen, a.get) }

const bundles = new Map()
export function registerBundles(id, b) { bundles.set(id, b) }
export function usePluginI18n(id) {
  return (key, ...args) => {
    let node = bundles.get(id)?.en
    for (const p of key.split('.')) node = node?.[p]
    return typeof node === 'function' ? node(...args) : (node ?? key)
  }
}
export function Tip({ label, children }) {
  return isValidElement(children) ? cloneElement(children, { 'data-tip': label }) : children
}
export function Loader({ label }) { return jsx('div', { 'data-slot': 'loader', 'aria-label': label }) }
export function ErrorState({ title }) { return jsx('div', { 'data-slot': 'error-state', children: title }) }
export function PanelEmpty({ title, description }) {
  return jsx('div', { 'data-slot': 'panel-empty', children: [title, ' ', description] })
}
export const host = {
  state: atoms,
  request: async (method, params) => {
    calls.request.push([method, params])
    if (state.listHold) await state.listHold
    if (state.listFails) throw new Error('gateway down')
    return { subagents: state.list[params.session_id] || [] }
  },
  openSession: async sid => { calls.opened.push(sid) },
  navigate: path => { calls.navigated.push(path) }
}
export default { host }
`)

const src = readFileSync(SRC, 'utf8').replace("'@hermes/plugin-sdk'", `'${HERE_URL.href}${OUT_REL}sdk-stub.mjs'`)
writeFileSync(`${OUT}plugin-under-test.mjs`, src)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.IS_REACT_ACT_ENVIRONMENT = true

const stub = await import(`${HERE_URL.href}${OUT_REL}sdk-stub.mjs`)
const mod = await import(`${HERE_URL.href}${OUT_REL}plugin-under-test.mjs`)
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}
const tick = (ms = 0) => act(() => new Promise(r => setTimeout(r, ms)))

// ── fake ctx ────────────────────────────────────────────────────────────────
const listeners = new Map()
const registered = []
const rest = []
const clip = []
let historyFails = false
let procFails = false
let procUnreadable = 1
let procOutputFails = false
let clipRejects = false
let filesFails = false
// ctx.storage as the app gives it (sync get/set over localStorage); `storageFails` makes both throw.
const kept = new Map()
let storageFails = false
const storage = {
  get: (key, fallback) => { if (storageFails) throw new Error('storage gone'); return kept.has(key) ? kept.get(key) : fallback },
  set: (key, value) => { if (storageFails) throw new Error('storage gone'); kept.set(key, value) },
  remove: key => { kept.delete(key) }
}
// 40 subagents in one stored run: 3 failed, 1 stopped, 6 working, 10 waiting, 20 done.
const SWARM_ST = [...Array(3).fill('failed'), 'stopped', ...Array(6).fill('running'), ...Array(10).fill('queued'), ...Array(20).fill('completed')]
const SWARM = {
  session_id: 'st-swarm', title: 'Big sweep',
  batches: [{ started_at: Date.now() / 1000 - 600, workers: SWARM_ST.map((status, i) => ({
    session_id: `sw-${i}`, goal: `Sweep 'unit-${String(i).padStart(2, '0')}'`, status, duration_s: status === 'running' || status === 'queued' || status === 'stopped' ? null : 30 + i,
    tool_calls: 2, tokens: 1000, cost_usd: 0.01, cost_status: 'estimated', summary: status === 'completed' ? 'ok' : ''
  })) }]
}
const FILES = {
  'st-f': {
    cwd: 'D:\\Proj',
    unreadable: 1,
    more: 2,
    files: [
      { key: 'd:/proj/src/a.py', path: 'D:\\Proj\\src\\a.py', reads: 2, writes: 3, deletes: 0, failed: 0, who: ['c-d', ''], editors: ['c-d', ''], last_op: 'write', last_failed: false, last_at: 30 },
      { key: 'd:/proj/readme.md', path: 'D:\\Proj\\README.md', reads: 0, writes: 0, deletes: 0, failed: 1, who: [''], editors: [], last_op: 'write', last_failed: true, last_at: 20 },
      { key: 'd:/proj/src/b.py', path: 'D:\\Proj\\src\\b.py', reads: 1, writes: 0, deletes: 0, failed: 0, who: [''], editors: [], last_op: 'read', last_failed: false, last_at: 15 },
      { key: 'd:/proj/old.txt', path: 'D:\\Proj\\old.txt', reads: 0, writes: 1, deletes: 1, failed: 0, who: [''], editors: [''], last_op: 'delete', last_failed: false, last_at: 10 },
      { key: 'c:/elsewhere/very/long/folder/name/that/goes/on/and/on/x.md', path: 'C:/elsewhere/very/long/folder/name/that/goes/on/and/on/x.md', reads: 1, writes: 0, deletes: 0, failed: 0, who: [''], editors: [], last_op: 'read', last_failed: false, first_at: 2, last_at: 5 }
    ]
  },
  'st-many': {
    cwd: '/w', unreadable: 0, more: 0,
    files: [
      // Twelve edits: more than the card's 8 blocks.
      { key: '/w/big.js', path: '/w/big.js', reads: 0, writes: 12, deletes: 0, failed: 0, who: [''], editors: [''], last_op: 'write', last_failed: false, last_at: 200 },
      ...Array.from({ length: 45 }, (_, i) => ({ key: `/w/f${i}.txt`, path: `/w/f${i}.txt`, reads: 1, writes: 0, deletes: 0, failed: 0, who: [''], editors: [], last_op: 'read', last_failed: false, last_at: 100 - i }))
    ]
  }
}
// Scenario state: extra stored batches and held (pending) reads. The fixtures below are never mutated.
let extraBatches = []
const holds = {}
const hold = name => { let release; holds[name] = new Promise(r => { release = r }); return () => { delete holds[name]; release() } }
const PROCS = {
  'st-1': [
    { id: 'proc_ok', command: 'npm test\n--watch=false', cwd: '/w', status: 'completed', started_at: 900, duration_s: 42, exit_code: 0 },
    { id: 'proc_bad', command: 'python build.py', cwd: '/w', status: 'failed', started_at: 950, duration_s: 5, exit_code: 1 },
    { id: 'proc_kill', command: 'sleep 999', cwd: '/w', status: 'stopped', started_at: 960, duration_s: 100, exit_code: -15 },
    { id: 'proc_run', command: 'npm run dev', cwd: '/w', status: 'running', started_at: Date.now() / 1000 - 65, duration_s: null, exit_code: null }
  ],
  'st-2': [],
  // The app closed under this one: checkpointed, no receipt, so there is no output to ask for.
  'st-4': [
    { id: 'proc_gone', command: 'x'.repeat(4000), command_truncated: true, cwd: '/w', status: 'stopped', started_at: 10, duration_s: null, exit_code: null, has_output: false },
    { id: 'proc_quiet', command: 'true', cwd: '/w', status: 'completed', started_at: 20, duration_s: 1, exit_code: 0 }
  ]
}
const deepFreeze = o => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
const HISTORY = {
  session_id: 'st-1',
  title: 'Refactor fleet routing',
  batches: [
    {
      started_at: 1000,
      workers: [
        { session_id: 'c-a', goal: "Polish 'alpha-panel' visuals", model: 'anthropic/claude-opus-5-5', effort: 'medium', status: 'completed', duration_s: 312, tool_calls: 40, tokens: 120000, cost_usd: 1.5, cost_status: 'estimated', summary: 'Alpha answer paragraph.' },
        { session_id: 'c-b', goal: "Polish 'beta-panel' visuals", model: 'claude-opus-5-5', effort: null, status: 'stopped', duration_s: null, tool_calls: 12, tokens: 9000, cost_usd: 0, cost_status: 'included', summary: '' }
      ]
    },
    {
      started_at: 2000,
      workers: [{ session_id: 'c-c', goal: 'Act as a strict design judge\nmore', status: 'completed', duration_s: 45, tool_calls: 3, tokens: 800, summary: 'Judge verdict.' }]
    },
    // The newest stored batch: with nothing running it is drawn as the command deck, not under Earlier.
    {
      started_at: 2500,
      workers: [
        { session_id: 'c-d', goal: "Write the 'docs-writer' notes", model: 'anthropic/claude-opus-5-5', effort: 'high', status: 'completed', duration_s: 48, tool_calls: 5, tokens: 2000, cost_usd: 0.08, cost_status: 'estimated', summary: 'Docs.' },
        { session_id: 'c-e', goal: "Watch the 'wiki-watchdog' panel", model: 'claude-opus-5-5', status: 'failed', duration_s: 12, tool_calls: 2, tokens: 500, summary: 'Cannot find module.' }
      ]
    }
  ]
}
// Shared fixtures are frozen: a scenario that needs other data sets `extraBatches` instead.
deepFreeze(HISTORY)
deepFreeze(PROCS)
deepFreeze(FILES)
deepFreeze(SWARM)
const ctx = {
  storage,
  pet: {
    visible: stub.pet.visible,
    say: (text, opts) => { stub.pet.said.push([text, opts]); return () => {} },
    clear: id => { stub.pet.cleared.push(id) }
  },
  register: c => { registered.push(c); return () => {} },
  i18n: { register: b => stub.registerBundles('subagent-watch', b), t: k => k },
  onEvent: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type).delete(fn)
  },
  setInterval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h) },
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  rest: async path => {
    rest.push(path)
    if (path.startsWith('/children')) {
      if (holds.children) await holds.children
      if (historyFails) throw new Error('backend 503')
      const sid = new URLSearchParams(path.split('?')[1]).get('session_id')
      if (sid === 'st-swarm') return SWARM
      if (sid === 'st-empty') return { session_id: sid, title: 'Quiet chat', batches: [] }
      return { ...HISTORY, batches: [...HISTORY.batches, ...extraBatches] }
    }
    if (path.startsWith('/output')) {
      if (holds.output) await holds.output
      const q = new URLSearchParams(path.split('?')[1])
      return { text: q.get('worker_id') === 'kq-empty' ? '' : `FULL OUTPUT of ${q.get('worker_id')} for ${q.get('session_id')}` }
    }
    if (path.startsWith('/processes')) {
      if (holds.processes) await holds.processes
      if (procFails) throw new Error('procs 503')
      const sid = new URLSearchParams(path.split('?')[1]).get('session_id')
      return { session_id: sid, processes: PROCS[sid] || [], unreadable: sid === 'st-1' ? procUnreadable : 0 }
    }
    if (path.startsWith('/files')) {
      if (filesFails) throw new Error('files 503')
      const sid = new URLSearchParams(path.split('?')[1]).get('session_id')
      return { session_id: sid, cwd: null, unreadable: 0, more: 0, files: [], ...(FILES[sid] || {}) }
    }
    if (path.startsWith('/process_output')) {
      if (procOutputFails) throw new Error('output 503')
      const q = new URLSearchParams(path.split('?')[1])
      if (holds.procout) await holds.procout
      if (q.get('process_id') === 'proc_quiet') return { id: 'proc_quiet', command: 'true', output: '', output_truncated: false }
      if (q.get('process_id') === 'proc_kill') return { id: 'proc_kill', command: 'sleep 999', output: 'step 1 ok\nTraceback (most recent call last):\n  at work()\nsleep: FAILED\n', output_truncated: false }
      return { id: q.get('process_id'), command: `FULL ${q.get('process_id')}`, output: `tail of ${q.get('process_id')} in ${q.get('session_id')}`, output_truncated: true }
    }
    throw new Error(`unexpected ${path}`)
  },
  os: { writeClipboard: async text => { if (clipRejects) throw new Error('denied'); clip.push(text); return true } }
}
// async act: an event can start a history reload whose promise settles after the handler returns;
// a sync act would let that state update land outside act and React would warn.
const emit = (type, session_id, payload) => act(async () => { for (const fn of listeners.get(type) || []) fn({ type, session_id, payload }) })
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn() } finally { console.warn = w } }

// 1. registration
mod.default.register(ctx)
const route = registered.find(c => c.area === 'routes')
const nav = registered.find(c => c.area === 'sidebar.nav')
check(route && route.data.path === '/subagent-watch', 'routes page at /subagent-watch')
check(nav && nav.data.path === '/subagent-watch' && nav.data.label === 'Subagents', 'sidebar entry with a resolved label')
check(!registered.some(c => String(c.area).startsWith('pane')), 'never registers a pane')

// pure helpers
check(mod.fmtDuration(312) === '5m 12s' && mod.fmtDuration(null) === '' && mod.fmtDuration(4000) === '1h 6m', 'duration format')
check(mod.workerName("Round 3 on 'fleet-status' panel") === 'fleet-status', 'worker name takes the quoted slug')
const six = [1, 2, 3].map(i => `Blind-review desktop panel ${i}: score CODE and UI`)
const shortNames = mod.distinctNames(six)
check(new Set(shortNames.map(n => n.slice(0, 12))).size === 3 && shortNames.every(n => n.length < 30),
  `sibling names sharing a long prefix are shortened to what tells them apart (${shortNames[0]})`)
check(mod.distinctNames(['alpha', 'beta']).join() === 'alpha,beta' && mod.distinctNames(['only one']).join() === 'only one',
  'distinct or single names are left alone')
check(mod.fmtDuration(4000, (k, ...a) => `${k}:${a.join('/')}`) === 'sw.units.hm:1/6' && mod.fmtTokens(120000, (k, ...a) => `${k}:${a}`) === 'sw.units.k:120',
  'duration and token units come from the bundle, not hard-coded strings')
check(mod.modelLabel('anthropic/claude-opus-5-5') === 'claude-opus-5-5', 'model label drops the provider')
check(mod.batchState(['completed', 'queued']) === 'queued' && mod.batchState(['completed', 'failed']) === 'failed', 'batch state never reads done while one is not')
const tr = stub.usePluginI18n('subagent-watch')
check(tr('sw.tabs.running', 1) === '1 command running' && tr('sw.tabs.running', 2) === '2 commands running', `command count is singular for one (${tr('sw.tabs.running', 1)})`)
check(tr('sw.proc.unreadable', 1) === '1 record could not be read and is not listed' && tr('sw.proc.unreadable', 2).startsWith('2 records'),
  `unreadable count is singular for one (${tr('sw.proc.unreadable', 1)})`)
check(tr('sw.run.older', 1) === 'Show 1 older run' && tr('sw.run.older', 3) === 'Show 3 older runs', `older-run count is singular for one (${tr('sw.run.older', 1)})`)
check(mod.fmtCost(1.25, 'estimated') === '~$1.25' && mod.fmtCost(0.38, 'actual') === '$0.38' && mod.fmtCost(0, 'included') === 'subscription'
  && mod.fmtCost(0, 'unknown') === '' && mod.fmtCost(null, 'estimated') === '' && mod.fmtCost(0.001, 'estimated') === '<$0.01',
  'cost format: ~ estimate, billed as is, subscription named, unpriced empty, sub-cent marked')
{
  const s = mod.sumCost([{ cost_usd: 1, cost_status: 'actual' }, { cost_usd: 0.5, cost_status: 'estimated' }, { cost_usd: 0, cost_status: 'included' }, { cost_status: 'unknown' }, {}])
  check(s.usd === 1.5 && s.status === 'estimated' && s.priced === 2 && s.included === 1 && s.unknown === 2,
    `a sum counts subscription and unpriced workers apart, one estimate makes it an estimate (${JSON.stringify(s)})`)
  check(mod.sumCost([{ cost_usd: 0, cost_status: 'included' }]).status === 'included' && mod.sumCost([{}]).usd === null,
    'all-subscription reads subscription; nothing priced is null, not 0')
}
check(mod.fmtAgo(30) === 'just now' && mod.fmtAgo(300) === '5m ago' && mod.fmtAgo(7200) === '2h ago' && mod.fmtAgo(90000) === 'yesterday' && mod.fmtAgo(3 * 86400) === '3d ago',
  'time ago reads just now, minutes, hours, yesterday, days')
check(['edit', 'read', 'run', 'think'].every(act => mod.unitIcon({ status: 'running', act }) === act)
  && mod.unitIcon({ status: 'completed' }) === 'ok' && mod.unitIcon({ status: 'failed' }) === 'bad' && mod.unitIcon({ status: 'stopped' }) === 'stop'
  && mod.unitIcon({ status: 'queued' }) === 'wait' && mod.unitIcon({ status: 'idle' }) === 'idle',
  'a unit icon is its activity while it runs, else its end: queued is never done, failed never done')
check(mod.toolAct('patch') === 'edit' && mod.toolAct('write_file') === 'edit' && mod.toolAct('read_file') === 'read' && mod.toolAct('terminal') === 'run'
  && mod.toolAct('delegate_task') === 'wait' && mod.toolAct('mcp_x') === 'think',
  'a tool reads as edit pencil, read eye, run prompt, waiting on subagents, or plain working')
{
  const g = mod.swarmGroups(['failed', 'stopped', 'running', 'queued', 'completed', 'completed'].map((status, i) => ({ key: i, status })))
  check(g.failed.length === 2 && g.running.length === 1 && g.queued.length === 1 && g.completed.length === 2, 'swarm groups: failed (with stopped), working, waiting, done')
}
{
  const files = [
    { key: 'a', who: ['', 'w1'], editors: ['w1'], writes: 1 },
    { key: 'b', who: ['w1'], editors: [], reads: 1, last_op: 'read' },
    { key: 'c', who: [''], editors: [], writes: 0, failed: 1, last_op: 'write', last_failed: true }
  ]
  const w1 = mod.agentFiles(files, 'w1'), me = mod.agentFiles(files, '')
  check(w1.changed.map(f => f.key).join() === 'a' && w1.read.map(f => f.key).join() === 'b' && me.changed.map(f => f.key).join() === 'c' && me.read.map(f => f.key).join() === 'a',
    `an agent's files come from who/editors: changed by it, only read by it, a failed change nobody made is its own (${JSON.stringify([w1, me].map(x => [x.changed.length, x.read.length]))})`)
}
check(['edit', 'read', 'run', 'think', 'wait', 'ok', 'bad', 'stop', 'idle'].every(i => mod.sprite(i).split('\n').length === 3 && !/[A-Za-z]/.test(mod.sprite(i))),
  'Terminal sprites are a three-line box with a glyph, never a letter')
check(mod.slugName('Pact weapon marker') === 'pact-weapon-marker' && mod.commandLine('\n  npm test\nmore') === 'npm test',
  'Terminal names are slugs; a command row shows its first non-empty line')
check(mod.shortTarget('D:\\Proj\\src\\a.py') === 'src/a.py' && mod.shortTarget('npm test\nmore') === 'npm test' && mod.shortTarget('a b/c') === 'a b/c',
  'a tool target: a path keeps its last two parts, a command its first line')

// mount
// The app's own focus tracker (store.ts trackActiveTreeGroup) is a window capture listener registered
// at boot, before any page mounts: it moves the focused chat INSIDE the click, before the page's own
// listener runs. `appFocusNext` is what that click makes the app report. A real click runs a microtask
// checkpoint after each listener, so React renders that change (sync lane, passive effects flushed)
// before the page's listener sees the event: flushSync reproduces that order under jsdom.
const { flushSync } = await import('react-dom')
let appFocusNext = null
window.addEventListener('pointerdown', () => {
  if (!appFocusNext) return
  const [rt, st] = appFocusNext
  appFocusNext = null
  flushSync(() => { stub.atoms.focusedSessionId.set(rt); stub.atoms.focusedStoredSessionId.set(st) })
}, true)
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => { root.render(React.createElement(route.render)) })
await tick(10)
const q = s => host.querySelector(s)
const qa = s => [...host.querySelectorAll(s)]
const units = () => qa('.sw-agents button.sw-unit')
const unitNamed = name => units().find(u => u.querySelector('.sw-un')?.textContent === name)
const tab = id => q(`[role=tab][data-tab=${id}]`)
const toTab = id => act(async () => { tab(id).click() })
const refresh = async () => { await act(async () => { q('.sw-hd .sw-ib').click() }); await tick(10) }

// 16 + 20. header, look, tabs
check(q('.sw-page')?.dataset.theme === 'cockpit' && q('.sw-tgb[data-theme=cockpit]')?.getAttribute('aria-pressed') === 'true'
  && q('.sw-tgb[data-theme=terminal]')?.getAttribute('aria-pressed') === 'false', 'the page opens in the Cockpit look, its toggle pressed')
check(q('h2.sw-ht')?.textContent === 'Subagents' && q('.sw-chatn')?.textContent === 'Refactor fleet routing' && !q('.sw-held'),
  `the header has the title and names the watched chat (${q('.sw-chatn')?.textContent})`)
check(tab('agents')?.getAttribute('aria-selected') === 'true' && tab('commands')?.getAttribute('aria-selected') === 'false',
  'two tabs, Agents first and selected')
check(q('.sw-tabn')?.textContent === '1' && q('.sw-tabn')?.getAttribute('aria-label') === '1 command running' && q('.sw-tabn')?.dataset.tip === '1 command running',
  `the Commands tab badge counts running commands, named by its tooltip (${q('.sw-tabn')?.textContent})`)

// 21. units: the main agent first and selected, icons not letters, statuses never mislabelled
{
  const u = units()
  check(u.length === 3 && u[0].dataset.main === 'true' && u[0].getAttribute('aria-pressed') === 'true' && u[0].querySelector('.sw-maintag')?.textContent === 'main',
    `the main agent is the first unit, tagged MAIN and selected (${u.map(x => x.getAttribute('aria-label'))})`)
  check(u.slice(1).map(x => x.querySelector('.sw-un').textContent).join() === 'docs-writer,wiki-watchdog', 'then one unit per subagent of the last run')
  check(u[1].dataset.st === 'completed' && u[1].dataset.icon === 'ok' && u[2].dataset.st === 'failed' && u[2].dataset.icon === 'bad',
    'a done unit draws the check, a failed one the cross')
  check(q('.sw-focus')?.dataset.kind === 'main', 'the focus panel shows the main agent by default')
  check(u.every(x => x.querySelector('.sw-ic svg')) && !q('.sw-sig, .sw-orbl, .sw-letter')
    && !qa('.sw-page *').some(e => !e.children.length && /^[A-Z]\d?$/.test(e.textContent.trim())),
  'no letter badges anywhere: every unit icon is a drawing')
}
check(q('.sw-bign')?.textContent === '1' && q('.sw-big small')?.textContent === '/2'
  && qa('.sw-score .sw-seg i').map(i => i.dataset.st).join() === 'completed,failed',
  `the score counts finished subagents of all, one cell per subagent (${q('.sw-big')?.textContent})`)
check(q('.sw-money')?.textContent === '~$0.08' && q('.sw-money')?.tabIndex === 0 && /1 priced/.test(q('.sw-money')?.dataset.tip || '') && /1 not priced/.test(q('.sw-money')?.dataset.tip || ''),
  `the score shows what the subagents spent, a focusable chip with the breakdown (${q('.sw-money')?.dataset.tip})`)
const css = q('style')?.textContent || ''
check(/\.sw-page button:focus-visible[^{]*\{[^}]*outline:2px/.test(css), 'buttons draw a visible focus ring (the app removes every ring)')
check(qa('[data-tip]').filter(e => !e.closest('button')).every(e => e.tabIndex === 0),
  `every tooltip trigger outside a button is focusable (${qa('[data-tip]').filter(e => !e.closest('button') && e.tabIndex !== 0).map(e => e.className)})`)
{
  const small = []
  for (const decl of css.match(/font(-size)?:[^;}]*/g) || []) {
    for (const n of decl.match(/(?<![\d./])\d+(\.\d+)?px/g) || []) if (parseFloat(n) < 11.5) small.push(decl)
  }
  check(!small.length, `no text below 11.5px (${small.join(' | ')})`)
}
check(/--dim:var\(--ui-text-secondary\)/.test(css) && !/tertiary/.test(css.match(/\.sw-model\{[^}]*\}/)?.[0] || 'tertiary')
  && !/tertiary/.test(css.match(/\.sw-meta\{[^}]*\}/)?.[0] || 'tertiary'),
  'times, counts and model chips use a reading token (tertiary measured 4.0-4.2:1 < 4.5)')
check(q('.sw-live[role=status]') !== null && !q('.sw-live').textContent, 'the toast live region is mounted before any toast (so it is announced)')
check(stub.calls.request.some(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-1'), 'subagent.list asked with the focused runtime id')

// 20. the look toggle switches and keeps the choice in ctx.storage
await act(async () => { q('.sw-tgb[data-theme=terminal]').click() })
check(q('.sw-page')?.dataset.theme === 'terminal' && q('.sw-tgb[data-theme=terminal]')?.getAttribute('aria-pressed') === 'true' && kept.get('theme') === 'terminal',
  `the toggle switches to Terminal and keeps it in ctx.storage (${kept.get('theme')})`)
check(units().length === 3 && units().every(u => u.querySelector('pre.sw-spr')) && !q('.sw-hex')
  && units().map(u => u.querySelector('.sw-us').textContent).join() === '[IDLE],[OK ],[ERR]',
  `Terminal draws ASCII sprite boxes with status tags (${units().map(u => u.querySelector('.sw-us')?.textContent)})`)
check(!/TERMINAL PALETTE/.test(css) && /\.sw-page\[data-theme=terminal\]\{--a:var\(--tm-acc\)/.test(css) && /--tm-acc:color-mix\(in srgb,var\(--ui-accent\)/.test(css)
  && /--tm-ok:color-mix\(in srgb,var\(--ui-green\)/.test(css) && /--tm-bad:color-mix\(in srgb,var\(--ui-red\)/.test(css) && /--tm-run:color-mix\(in srgb,var\(--ui-yellow\)/.test(css)
  && /--tm-bg:color-mix\(in srgb,var\(--ui-accent\) \d+%,var\(--dt-background\)\)/.test(css) && !/#[0-9a-f]{3,8}\b/i.test(css),
  'Terminal takes the theme: the accent is its ink, the theme tones its statuses, its ground the theme background; no literal colour')
await act(async () => { q('.sw-tgb[data-theme=cockpit]').click() })
check(q('.sw-page')?.dataset.theme === 'cockpit' && kept.get('theme') === 'cockpit' && units().every(u => u.querySelector('.sw-hex')),
  'and back to Cockpit hex units')

// 22. the run picker: the last run now, earlier runs on demand, Back to now
await act(async () => { q('.sw-pick').click() })
{
  const items = qa('.sw-menu [role=menuitem]')
  check(q('.sw-pick')?.getAttribute('aria-expanded') === 'true' && items.length === 3 && items[0].dataset.run === 'now' && items[0].classList.contains('is-on'),
    `the picker lists this run then the earlier ones (${items.map(i => i.textContent).join(' | ')})`)
  check(items[1].querySelector('.sw-mrn')?.textContent === 'Act as a strict design judge' && items[2].querySelector('.sw-mrn')?.textContent === 'alpha-panel +1',
    'earlier runs newest first, named by their first subagent and how many more')
  check([...items[2].querySelectorAll('.sw-mini i')].map(i => i.dataset.st).join() === 'completed,stopped'
    && /1\/2/.test(items[2].querySelector('.sw-mrx')?.textContent || '') && /~\$1\.50/.test(items[2].querySelector('.sw-mrx')?.textContent || '')
    && /ago/.test(items[2].querySelector('.sw-mrx')?.textContent || ''),
  `each earlier run: mini status cells, time ago, done/total, cost (${items[2].querySelector('.sw-mrx')?.textContent})`)
  await act(async () => { items[2].click() })
}
check(!q('.sw-menu') && q('.sw-panel')?.dataset.calm === 'true' && q('.sw-back')?.textContent === 'Back to now' && q('.sw-pick')?.textContent === 'alpha-panel +1' && !q('.sw-ld'),
  'an earlier run is shown calmly (no live glow) with Back to now')
check(units().map(u => u.querySelector('.sw-un').textContent).join() === 'Main agent,alpha-panel,beta-panel' && unitNamed('beta-panel')?.dataset.icon === 'stop'
  && !/\d+[smh]/.test(unitNamed('beta-panel')?.dataset.tip || ''),
  `its units: the main agent, then its subagents; a stopped one shows no duration (${unitNamed('beta-panel')?.dataset.tip})`)
check(q('.sw-money')?.textContent === '~$1.50' && /1 in a subscription/.test(q('.sw-money')?.dataset.tip || ''), 'its score shows its own cost, a subscription worker counted apart')
// 23. a selected subagent: task, model, answer, files, copy, open
await act(async () => { unitNamed('alpha-panel').click() })
{
  const f = q('.sw-focus')
  check(f?.dataset.kind === 'sub' && unitNamed('alpha-panel').getAttribute('aria-pressed') === 'true' && f.querySelector('.sw-head')?.textContent === "Polish 'alpha-panel' visuals"
    && /Done in 5m 12s/.test(f.querySelector('.sw-meta')?.textContent || ''),
  `selecting a subagent shows it in the one focus panel (${f?.querySelector('.sw-meta')?.textContent})`)
  check(f.querySelector('.sw-model')?.textContent === 'claude-opus-5-5 · medium' && /anthropic\/claude-opus-5-5/.test(f.querySelector('.sw-model')?.dataset.tip || '')
    && /medium/.test(f.querySelector('.sw-model')?.dataset.tip || '') && f.querySelector('.sw-model')?.tabIndex === 0,
  `the model chip shows model · effort, its tooltip the full id (${f.querySelector('.sw-model')?.dataset.tip})`)
  check(f.querySelector('.sw-task')?.textContent.includes("Polish 'alpha-panel' visuals") && f.querySelector('.sw-anst')?.textContent === 'Alpha answer paragraph.',
    'it shows its task and its answer')
  const tiles = [...f.querySelectorAll('.sw-tile')].map(x => `${x.querySelector('.sw-tl')?.textContent}=${x.querySelector('.sw-tn')?.textContent}`).join('|')
  check(tiles === 'run time=5m 12s|tool calls=40|tokens=120k|cost=~$1.50', `a subagent's stat tiles: run time, tool calls, tokens, cost — every number labelled (${tiles})`)
  const tools = f.querySelector('.sw-tile[data-k=tools] .sw-tn')
  check(tools?.dataset.count === '40' && tools?.style.getPropertyValue('--sw-n') === '40' && !f.querySelector('.sw-tile[data-k=cost] .sw-tn')?.dataset.count,
    'a whole number counts up from 0 (a CSS counter, so the reduced-motion lock stops it); any other value rolls in')
  check(f.querySelector('.sw-hero .sw-verb')?.textContent === '✓ DONE' && f.querySelector('.sw-hero .sw-por')?.dataset.st === 'completed' && f.querySelector('.sw-hero .sw-ptag')?.textContent === 'done'
    && f.querySelector('.sw-hero .sw-por .sw-pring') && f.querySelector('.sw-hero .sw-meta .sw-model'),
  `the hero: a portrait in its status ring with its tag, the verb line, the task as headline, where + model chip (${f.querySelector('.sw-verb')?.textContent})`)
  check(f.querySelector('.sw-ans')?.dataset.st === 'completed' && f.querySelector('.sw-ans .sw-sig')?.children.length === 4 && f.querySelector('.sw-ans .sw-ansh')?.textContent === 'Its answer',
    'its answer is a transmission card: its status colour, a signal mark, a heading')
  check(qa('.sw-focus .sw-btns .sw-ib.is-text').map(b => b.textContent).join('|') === 'Copy answer|Open its chat', 'labelled actions, not bare icons')
}
const [copyBtn, openBtn] = qa('.sw-focus .sw-btns .sw-ib')
const releaseOut = hold('output')
await act(async () => { copyBtn.click() })
await tick(5)
check(copyBtn.getAttribute('aria-busy') === 'true' && copyBtn.getAttribute('aria-label') === 'Copying…' && copyBtn.disabled,
  `copy shows a busy state while it reads (${copyBtn.getAttribute('aria-label')})`)
await act(async () => { releaseOut() })
await tick(5)
check(copyBtn.getAttribute('aria-label') === 'Copy answer' && copyBtn.getAttribute('aria-busy') !== 'true', 'copy leaves its busy state when done')
check(rest.includes('/output?session_id=st-1&worker_id=c-a') && clip.at(-1) === 'FULL OUTPUT of c-a for st-1', "copy reads that worker's full output, for THIS chat, into the clipboard")
let unhandled = 0
const onUnhandled = () => { unhandled++ }
process.on('unhandledRejection', onUnhandled)
clipRejects = true
await act(async () => { copyBtn.click() })
await tick(5)
check(q('.sw-toast.is-bad')?.textContent === 'Copy failed' && !unhandled, `a rejected clipboard on Copy answer toasts "Copy failed" (${q('.sw-toast')?.textContent})`)
clipRejects = false
await act(async () => { openBtn.click() })
check(stub.calls.opened[0] === 'c-a', 'Open its chat goes to the child session')
await act(async () => { unitNamed('beta-panel').click() })
check(q('.sw-focus .sw-model')?.textContent === 'claude-opus-5-5' && /Stopped/.test(q('.sw-focus .sw-meta')?.textContent || ''),
  'a worker without an effort shows the model alone; a stopped one says so')
await act(async () => { q('.sw-back').click() })
check(!q('.sw-panel')?.dataset.calm && q('.sw-pick')?.textContent === 'Last run' && !q('.sw-back') && q('.sw-focus')?.dataset.kind === 'main',
  'Back to now returns to the current run, the main agent selected')
// many runs: the picker pages them
extraBatches = Array.from({ length: 10 }, (_, i) => ({ started_at: 100 + i, workers: [{ session_id: `old-${i}`, goal: `Old 'run-${i}'`, status: 'completed', duration_s: 5, tool_calls: 1, tokens: 0, summary: '' }] }))
await refresh()
await act(async () => { q('.sw-pick').click() })
{
  const n = qa('.sw-menu [role=menuitem]').length
  check(n === 9 && q('.sw-menu .sw-more')?.textContent === 'Show 4 older runs', `the picker lists 8 earlier runs and offers the rest (${n} | ${q('.sw-menu .sw-more')?.textContent})`)
  await act(async () => { q('.sw-menu .sw-more').click() })
  check(qa('.sw-menu [role=menuitem]').length === 13, 'Show older runs lists them all')
}
await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
check(!q('.sw-menu'), 'Escape closes the picker')
// a long task is cut, Show all opens it
extraBatches = [{ started_at: 2600, workers: [{ session_id: 'c-long', goal: `Write the 'long-task' ${'detail '.repeat(40)}`, status: 'completed', duration_s: 9, tool_calls: 1, tokens: 0, summary: Array.from({ length: 9 }, (_, i) => `answer line ${i}`).join('\n') }] }]
await refresh()
await act(async () => { unitNamed('long-task').click() })
{
  const short = q('.sw-focus .sw-task')?.textContent || ''
  await act(async () => { q('.sw-focus .sw-task .sw-more').click() })
  check(short.endsWith('…Show all') && (q('.sw-focus .sw-task')?.textContent || '').length > short.length,
    `a long task is cut with Show all (${short.slice(-20)})`)
  const head = q('.sw-focus .sw-head')
  check(head?.querySelector('.sw-headt') && head.dataset.tip?.startsWith("Write the 'long-task' detail") && head.tabIndex === 0
    && /\.sw-headt\{[^}]*white-space:nowrap[^}]*\}/.test(css) && /\.sw-headt\{[^}]*text-overflow:ellipsis/.test(css),
    `the headline is one line with an ellipsis; the whole task is its tooltip (${head?.dataset.tip?.slice(0, 30)})`)
  const ans = q('.sw-focus .sw-anst')
  const fold = q('.sw-focus .sw-ansm')
  check(ans?.classList.contains('is-folded') && ans.style.getPropertyValue('--sw-lines') === '6' && fold?.textContent === 'Show all' && fold.getAttribute('aria-expanded') === 'false'
    && /\.sw-anst\.is-folded\{[^}]*-webkit-line-clamp:var\(--sw-lines\)/.test(css),
    `a long answer opens folded to 6 lines with Show all (${fold?.textContent})`)
  await act(async () => { fold.click() })
  check(!q('.sw-focus .sw-anst')?.classList.contains('is-folded') && q('.sw-focus .sw-ansm')?.textContent === 'Show less'
    && q('.sw-focus .sw-anst')?.textContent.includes('answer line 8'), 'Show all unfolds the whole answer')
  await act(async () => { q('.sw-focus .sw-ansm').click() })
  check(q('.sw-focus .sw-anst')?.classList.contains('is-folded') && q('.sw-focus .sw-ansm')?.textContent === 'Show all', 'Show less folds the answer again')
}
extraBatches = []
await refresh()

// 9. Commands tab
await toTab('commands')
check(tab('commands')?.getAttribute('aria-selected') === 'true' && q('.sw-why')?.textContent.includes('not subagents'), 'the Commands tab says these are not subagents')
check(rest.includes('/processes?session_id=st-1'), 'background commands read for the stored chat id')
const prs = () => qa('.sw-cmr')
check(prs().length === 4 && prs().map(p => p.dataset.st).join() === 'running,stopped,failed,completed', `newest command first, each with its status (${prs().map(p => p.dataset.st)})`)
check(prs()[3].querySelector('.sw-cmc')?.textContent === 'npm test' && prs()[3].querySelector('.sw-cmc')?.dataset.tip === 'npm test\n--watch=false',
  'row shows the first line, tooltip the whole command')
check(/exit 1/.test(prs()[2].querySelector('.sw-cmx')?.textContent || '') && !/exit/.test(prs()[3].querySelector('.sw-cmx')?.textContent || ''),
  'a failed command shows its exit code; a successful one no exit badge')
check(prs()[1].querySelector('.sw-cmx')?.textContent.endsWith('—') && !/\d+s$/.test(prs()[1].querySelector('.sw-cmx')?.textContent || ''), 'a stopped command shows — and no duration')
check(/1m 0[5-9]s$/.test(prs()[0].querySelector('.sw-cmx')?.textContent || ''), `running command counts its elapsed time (${prs()[0].querySelector('.sw-cmx')?.textContent})`)
check(prs()[3].querySelector('.sw-cmx')?.textContent.endsWith('42s'), 'finished command shows its duration')
check(q('.sw-pu')?.textContent === '1 record could not be read and is not listed', 'unreadable records are reported, not hidden')
{
  const bad = prs()[2]
  bad.focus()
  await act(async () => { bad.click() })
  await tick(5)
  check(bad.isConnected && document.activeElement === bad && bad.getAttribute('aria-expanded') === 'true', 'opening a command keeps focus on its row')
  await act(async () => { document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })) }) // focus inside the page holds its chat; let it go
}
check(rest.includes('/process_output?session_id=st-1&process_id=proc_bad'), 'opening a command reads its output for THIS chat')
check(q('.sw-cmo .sw-out')?.textContent === 'tail of proc_bad in st-1' && q('.sw-cmo .sw-pc')?.textContent === 'FULL proc_bad'
  && q('.sw-cmo .sw-exit')?.dataset.st === 'failed' && q('.sw-cmo .sw-exit b')?.textContent === '1' && q('.sw-cmo .sw-exit')?.getAttribute('aria-label') === 'exit 1'
  && qa('.sw-cmo .sw-cchip').map(c => c.textContent).join('|') === 'dir/w|ran5s',
  `an opened row: its exit code on a big status hex, dir and ran chips, the full command, the output tail (${qa('.sw-cmo .sw-cchip').map(c => c.textContent)})`)
check(q('.sw-cmo .sw-crt[data-state=output] .sw-ol')?.dataset.n === '1' && /1 line$/.test(q('.sw-cmo .sw-crth')?.textContent || ''), 'the output sits in a CRT box with numbered lines')
check(/last/.test(q('.sw-cmo .sw-outl')?.textContent || ''), 'a cut output says it is the end only')
{
  const btn = label => qa('.sw-cmo .sw-btns .sw-ib').find(b => b.textContent === label)
  await act(async () => { btn('Copy output').click() })
  await tick(5)
  check(clip.at(-1) === 'tail of proc_bad in st-1', 'Copy output copies the output')
  await act(async () => { btn('Copy command').click() })
  await tick(5)
  check(clip.at(-1) === 'FULL proc_bad', 'Copy command copies the full command')
  clipRejects = true
  await act(async () => { btn('Copy command').click() })
  await tick(5)
  check(q('.sw-toast.is-bad')?.textContent === 'Copy failed' && !unhandled, `a rejected clipboard on copy command toasts "Copy failed" (unhandled ${unhandled})`)
  clipRejects = false
}
process.off('unhandledRejection', onUnhandled)
await act(async () => { prs()[2].click() })
procOutputFails = true
await quiet(async () => { await act(async () => { prs()[2].click() }); await tick(5) })
check(/Could not read its output: output 503/.test(q('.sw-cmerr[role=alert]')?.textContent || '') && q('.sw-cmerr .sw-ib')?.textContent === 'Try again'
  && q('.sw-cmerr .sw-crt[data-state=lost] .sw-nosig')?.textContent === 'NO SIGNAL',
  'an unreadable output is an alert: NO SIGNAL, the message, Try again')
procOutputFails = false
await act(async () => { q('.sw-cmerr .sw-ib').click() })
await tick(5)
check(q('.sw-cmo .sw-out')?.textContent === 'tail of proc_bad in st-1' && !q('.sw-cmerr'), 'Try again reads the output again')
{
  const outReads = rest.filter(p => p.startsWith('/process_output')).length
  await act(async () => { prs()[0].click() })
  await tick(5)
  check(q('.sw-cmo[data-st=running] .sw-cmnote')?.textContent === 'Still running — its output appears here when it finishes.' && rest.filter(p => p.startsWith('/process_output')).length === outReads
    && q('.sw-cmo[data-st=running] .sw-radar') && !q('.sw-cmo[data-st=running] .sw-exit'),
    'a running command: a radar, no output asked for yet, and when it is shown')
  check(qa('.sw-cmo').length === 2, `opening one command keeps the others open (${qa('.sw-cmo').length} open)`)
}
{
  const release = hold('procout')
  await act(async () => { prs()[1].click() })
  await tick(5)
  const killed = () => qa('.sw-cmo').find(c => c.dataset.st === 'stopped')
  check(killed()?.querySelector('.sw-crt[data-state=reading][role=status] .sw-scan') && killed()?.querySelector('.sw-crth')?.textContent === 'Reading its output…',
    'while its output is read: a scan bar and what is happening')
  await act(async () => { release() })
  await tick(5)
  const lines = [...(killed()?.querySelectorAll('.sw-ol') || [])]
  check(lines.map(l => l.dataset.n).join() === '1,2,3,4' && lines.map(l => l.classList.contains('is-bad')).join() === 'false,true,false,true' && /4 lines$/.test(killed()?.querySelector('.sw-crth')?.textContent || ''),
    `output lines are numbered and the error lines are highlighted (${lines.map(l => l.className).join()})`)
  check(killed()?.querySelector('.sw-exit b')?.textContent === '-15' && killed()?.querySelector('.sw-exit span')?.textContent === 'killed' && killed()?.querySelector('.sw-exit')?.getAttribute('aria-label') === 'killed',
    'a killed command says so on its exit mark')
  await act(async () => { prs()[1].click() })
}
check(mod.outputLines('ok\nError: x\nall FAILED\n  Traceback\nException!\nfine\n').map(l => l.bad).join() === 'false,true,true,true,true,false',
  'error / failed / exception / traceback lines are errors, in any case; a final newline adds no line')
{
  const procPolls = rest.filter(p => p.startsWith('/processes')).length
  await tick(3100)
  check(rest.filter(p => p.startsWith('/processes')).length > procPolls, 'background commands are polled')
}
await toTab('agents')

// 2 + 3 + 4. live run, scoped to the focused chat
await emit('subagent.spawn_requested', 'rt-OTHER', { subagent_id: 'x1', delegation_id: 'd9', goal: "Do 'foreign'", task_index: 0 })
await emit('subagent.tool', 'rt-OTHER', { subagent_id: 'x1', tool_name: 'read_file', tool_preview: 'foreign.txt' })
check(!unitNamed('foreign') && q('.sw-pick')?.textContent === 'Last run', 'events from another chat are ignored')
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's1', delegation_id: 'd1', goal: "Build 'one'", task_index: 0 })
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's2', delegation_id: 'd1', goal: "Build 'two'", task_index: 1 })
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's3', delegation_id: 'd1', goal: "Build 'three'", task_index: 2 })
await emit('subagent.start', 'rt-1', { subagent_id: 's1', delegation_id: 'd1', goal: "Build 'one'", child_session_id: 'k1', model: 'anthropic/claude-opus-5-5' })
await emit('subagent.start', 'rt-1', { subagent_id: 's1a', parent_id: 's1', delegation_id: 'd1', goal: "Nested 'one-a'", depth: 1 })
await emit('subagent.start', 'rt-1', { subagent_id: 's2', delegation_id: 'd1', goal: "Build 'two'" })
await emit('subagent.tool', 'rt-1', { subagent_id: 's1', tool_name: 'terminal', tool_preview: 'npm test' })
stub.state.list['rt-1'] = [
  { subagent_id: 's1', delegation_id: 'd1', status: 'running', goal: "Build 'one'" },
  { subagent_id: 's1a', parent_id: 's1', delegation_id: 'd1', status: 'running', goal: "Nested 'one-a'" },
  { subagent_id: 's2', delegation_id: 'd1', status: 'running', goal: "Build 'two'" },
  { subagent_id: 's3', delegation_id: 'd1', status: 'queued', goal: "Build 'three'" }
]
await tick(3100) // let one subagent.list poll reconcile the run (wire status -> status mapping)
await emit('subagent.complete', 'rt-1', { subagent_id: 's2', status: 'error', summary: 'boom', duration_seconds: 12, cost_usd: 0.42 })
check(unitNamed('two')?.classList.contains('is-fail'), 'a unit that fails plays the failure moment (it shakes red)')
const liveNames = () => units().map(u => `${u.querySelector('.sw-un').textContent}=${u.dataset.st}`).join(',')
check(liveNames() === 'Main agent=running,one=running,one-a=running,two=failed,three=queued',
  `the live run: main agent first, a nested worker right after its parent, each in its own status (${liveNames()})`)
check(q('.sw-pick')?.textContent === 'Current run' && q('.sw-ld') && !q('.sw-panel')?.dataset.calm, 'a live run is the current run, with its live mark')
check(unitNamed('one')?.dataset.icon === 'run' && /running a command npm test/.test(unitNamed('one')?.dataset.tip || '') && unitNamed('three')?.dataset.icon === 'wait',
  `a running unit's icon is what it does now, its tooltip on what (${unitNamed('one')?.dataset.tip})`)
check(units()[0].getAttribute('aria-label') === 'Main agent: waiting on 3' && units()[0].dataset.icon === 'wait',
  `the main agent waits on its working and waiting subagents (${units()[0].getAttribute('aria-label')})`)
check(q('.sw-bign')?.textContent === '0' && q('.sw-big small')?.textContent === '/4' && qa('.sw-score .sw-seg i').map(i => i.dataset.st).join() === 'running,running,failed,queued',
  `the score: none finished of four, one cell per subagent in its status (${q('.sw-big')?.textContent})`)
check(q('.sw-money')?.textContent === '~$0.42', `a live run shows the cost its finished workers reported (${q('.sw-money')?.textContent})`)
await act(async () => { unitNamed('one').click() })
check(q('.sw-focus .sw-model')?.textContent === 'claude-opus-5-5' && /running a command npm test/.test(q('.sw-focus .sw-meta')?.textContent || ''),
  `a live subagent's panel says what it does now (${q('.sw-focus .sw-meta')?.textContent})`)
await act(async () => { unitNamed('one-a').click() })
check(/started by one/.test(q('.sw-focus .sw-meta')?.textContent || ''), 'a nested worker names the worker that started it')
await act(async () => { units()[0].click() })
check(/Waiting on 3 subagents/.test(q('.sw-focus .sw-head')?.textContent || ''), `the main agent's panel says it waits on them (${q('.sw-focus .sw-head')?.textContent})`)
{
  const liveStart = Date.now() / 1000
  extraBatches = [{ started_at: liveStart - 1, workers: [{ session_id: 'k9', goal: "Build 'one'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' }] }]
  await refresh()
  await act(async () => { q('.sw-pick').click() })
  check(qa('.sw-menu [role=menuitem]').length === 4, `a stored run still running is the live one, not repeated among earlier runs (${qa('.sw-menu [role=menuitem]').length})`)
  await act(async () => { q('.sw-pick').click() })
  extraBatches = [{ started_at: liveStart - 1, workers: [
    { session_id: 'k9', goal: "Build 'one'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' },
    { session_id: 'k10', goal: "Build 'done-early'", status: 'completed', duration_s: 40, tool_calls: 3, tokens: 0, summary: 'ok' }
  ] }]
  await refresh()
  check(unitNamed('done-early')?.dataset.st === 'completed', 'a worker that finished before the rest stays in the live run, done')
  check(units().filter(u => u.querySelector('.sw-un').textContent === 'one').length === 1, 'a live worker is not duplicated from state.db')
  await act(async () => { q('.sw-pick').click() })
  check(!qa('.sw-menu [role=menuitem]').some(i => i.textContent.includes('done-early')), 'that finished worker is not also an earlier run')
  await act(async () => { q('.sw-pick').click() })
  // A stored batch that still reads running but started long before the live run is not the live run.
  extraBatches = [{ started_at: 3000, workers: [{ session_id: 'k8', goal: "Old 'crashed-run'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' }] }]
  await refresh()
  await act(async () => { q('.sw-pick').click() })
  check(qa('.sw-menu [role=menuitem]').some(i => i.textContent.includes('crashed-run')), 'a running stored run that is not the live one stays among earlier runs')
  await act(async () => { q('.sw-pick').click() })
  extraBatches = []
  await refresh()
}
// a finish plays its moment and the score counts up
await emit('subagent.complete', 'rt-1', { subagent_id: 's3', status: 'completed', duration_seconds: 3 })
check(unitNamed('three')?.classList.contains('is-done') && q('.sw-bign')?.textContent === '1', 'a unit that finishes plays the done moment and the score counts up')
await tick(1500)
check(!q('.sw-unit.is-done, .sw-unit.is-fail'), 'the moments end')

// 8. finishing the run reloads history; it stays as the last run
const before = rest.filter(p => p.startsWith('/children')).length
stub.state.list['rt-1'] = []
for (const id of ['s1', 's1a']) await emit('subagent.complete', 'rt-1', { subagent_id: id, status: 'completed' })
await tick(10)
check(q('.sw-pick')?.textContent === 'Last run' && !q('.sw-ld'), 'a finished run is no longer live')
check(rest.filter(p => p.startsWith('/children')).length > before, 'history reloaded when a run finishes')
stub.state.list['rt-1'] = ['s1', 's1a', 's3'].map(id => ({ subagent_id: id, delegation_id: 'd1', status: 'completed', goal: id }))
{
  const settled = rest.filter(p => p.startsWith('/children')).length
  await tick(3100)
  await tick(3100)
  check(q('.sw-pick')?.textContent === 'Last run' && rest.filter(p => p.startsWith('/children')).length === settled,
    'a finished run still listed by subagent.list is not re-added nor reloaded again')
}
stub.state.list['rt-1'] = []

// 2. switching chats clears live state, folds open rows, selects the main agent
await emit('subagent.start', 'rt-1', { subagent_id: 'z1', delegation_id: 'dz', goal: "Do 'zed'" })
check(q('.sw-pick')?.textContent === 'Current run', 'live again before the switch')
await act(async () => { unitNamed('zed').click() })
await toTab('commands')
await act(async () => { prs()[1].click() })
check(q('.sw-cmo'), 'a command row is open before the switch')
await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
check(rest.includes('/children?session_id=st-2') && rest.includes('/processes?session_id=st-2') && !prs().length && q('.sw-cmds .sw-empty')?.textContent === 'No background commands in this chat.',
  'history and commands re-read for the new chat; none -> it says so')
await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
await tick(10)
check(prs().length === 4 && !q('.sw-cmo'), 'switching chats folds every open row')
await toTab('agents')
check(!unitNamed('zed') && q('.sw-focus')?.dataset.kind === 'main', 'switching chats clears the live run and selects the main agent')

// 7. failures are visible: one alert lists each
historyFails = true
stub.state.listFails = true
procFails = true
await quiet(async () => {
  await act(async () => { stub.atoms.focusedSessionId.set('rt-3'); stub.atoms.focusedStoredSessionId.set('st-3') })
  await tick(20)
  for (let i = 0; i < 3; i++) await tick(3100)
})
{
  const items = qa('.sw-err[role=alert] li').map(li => li.textContent)
  check(items.includes('earlier runs — backend 503') && items.includes('background commands — procs 503') && items.includes('live updates stopped — gateway down'),
    `one alert lists each source that failed (${items.join(' | ')})`)
}
check(q('.sw-err .sw-ib.is-text')?.textContent === 'Try again' && q('.sw-bd .sw-empty')?.textContent === 'Nothing to show while every read fails.'
  && !/Try again/.test(q('.sw-bd')?.textContent || ''),
  `the alert carries Try again; the empty view below does not repeat it (${q('.sw-bd')?.textContent.slice(0, 160)})`)
check(q('.sw-tabn')?.textContent === '—' && /could not be read/.test(q('.sw-tabn')?.getAttribute('aria-label') || ''), 'a count whose source failed reads —, not 0')

// 10. Refresh restarts live polling that gave up
stub.state.listFails = false
const listCalls = () => stub.calls.request.filter(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-3').length
const gaveUp = listCalls()
await tick(3100)
check(listCalls() === gaveUp, 'polling has stopped after three failures')
await quiet(async () => { await refresh(); await tick(3100) })
check(listCalls() > gaveUp && !(q('[role=alert]')?.textContent || '').includes('live updates stopped'), `Refresh resumes live polling (${gaveUp} -> ${listCalls()})`)

// A chat switch drops the old chat's errors; the first read shows a loading skeleton, commands a loader.
historyFails = false
procFails = false
const releaseChildren = hold('children')
const releaseProcs = hold('processes')
await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
await tick(10)
check(!(q('[role=alert]')?.textContent || '').includes('earlier runs') && !(q('[role=alert]')?.textContent || '').includes('background commands'),
  `a chat switch drops the previous chat's errors (${q('[role=alert]')?.textContent})`)
check(q('.sw-skel[role=status]') && !q('[role=tablist]'), 'a chat whose first read is pending shows a loading skeleton')
await act(async () => { releaseChildren() })
await tick(10)
await toTab('commands')
check(q('.sw-cmds .sw-cmwait') !== null, 'background commands show a loading state while their first read is pending')
await act(async () => { releaseProcs() })
await tick(10)
check(!q('.sw-cmds .sw-cmwait') && prs().length === 4, 'the loading state gives way to the commands')

// 15. the watched chat survives clicks that are not a chat switch
const pointer = el => el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
const chatTab = id => { const el = document.createElement('div'); el.setAttribute('data-tree-tab', id); document.body.appendChild(el); return el }
await act(async () => { pointer(document.body) })
await tick(10)
check(prs().length === 4, `watching the first chat before the clicks (${prs().length})`)
let mark = rest.length
await act(async () => {
  appFocusNext = ['rt-2', 'st-2']
  pointer(q('.sw-cmr'))
})
await tick(10)
check(!rest.slice(mark).some(p => p.includes('session_id=st-2')) && prs().length === 4, `a click inside the page keeps the watched chat (${rest.slice(mark).join(' ')})`)
check(q('.sw-held')?.textContent === 'held' && /Click a chat/.test(q('.sw-held')?.dataset.tip || '') && q('.sw-held')?.tabIndex === 0, 'a held chat is marked as held in the header')
mark = rest.length
await act(async () => { pointer(chatTab('session-tile:st-2')) })
await tick(10)
check(rest.slice(mark).includes('/processes?session_id=st-2') && !prs().length, `a click on a chat moves the page to that chat (${rest.slice(mark).join(' ')})`)
mark = rest.length
await act(async () => {
  appFocusNext = ['rt-1', 'st-1']
  pointer(chatTab('route-tile:/approvals'))
})
await tick(10)
check(!rest.slice(mark).some(p => p.includes('session_id=st-1')) && !prs().length, "a click on another page's tab keeps the watched chat")
await act(async () => { pointer(document.body) })
await tick(10)
check(prs().length === 4, 'a click outside the page follows the focused chat again')
check(!q('.sw-held'), 'following the app again drops the held marker')
await act(async () => {
  pointer(chatTab('sessions'))
  stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2')
})
await tick(10)
check(!prs().length, 'a chat picked in the Sessions sidebar is followed')

// 16b. a checkpoint-only command (the app closed under it), a cut command, a command that printed nothing
await act(async () => { stub.atoms.focusedSessionId.set('rt-4'); stub.atoms.focusedStoredSessionId.set('st-4') })
await tick(10)
mark = rest.length
await act(async () => { prs()[1].click() })
await tick(5)
check(!rest.slice(mark).some(p => p.startsWith('/process_output')) && q('.sw-cmo .sw-cmnote')?.textContent === 'No output was recorded.',
  'a command with no receipt asks for no output and says none was recorded')
check(/first 4000 characters/.test(q('.sw-cmo .sw-cmeta')?.textContent || ''), `a cut command says it is cut (${q('.sw-cmo .sw-cmeta')?.textContent})`)
await act(async () => { prs()[1].click() })
await act(async () => { prs()[0].click() })
await tick(5)
check(q('.sw-cmo .sw-crt[data-state=quiet] .sw-quiet')?.textContent === '— IT PRINTED NOTHING —', 'a command that printed nothing says so')
await toTab('agents')

// 16c. live races: a queued worker before Hermes lists it, a stale snapshot after a complete, and
// the hand-off of a finished run to its stored copy.
const pollNow = async () => { await act(async () => { q('.sw-hd .sw-ib').click() }); await tick(5) }
stub.state.list['rt-4'] = []
await emit('subagent.spawn_requested', 'rt-4', { subagent_id: 'q1', goal: "Queue 'qa-one'", task_index: 0 })
await emit('subagent.spawn_requested', 'rt-4', { subagent_id: 'q2', goal: "Queue 'qa-two'", task_index: 1 })
await pollNow()
const subMarks = () => units().filter(u => !u.dataset.main).map(u => `${u.querySelector('.sw-un').textContent}=${u.dataset.st}`).sort().join(',')
check(subMarks() === 'qa-one=queued,qa-two=queued', `a queued worker subagent.list does not show yet stays queued (${subMarks()})`)
await emit('subagent.start', 'rt-4', { subagent_id: 'q1', delegation_id: 'dq', goal: "Queue 'qa-one'", child_session_id: 'kq1' })
await emit('subagent.start', 'rt-4', { subagent_id: 'q2', delegation_id: 'dq', goal: "Queue 'qa-two'", child_session_id: 'kq-empty' })
stub.state.list['rt-4'] = [['q1', "Queue 'qa-one'"], ['q2', "Queue 'qa-two'"]].map(([id, goal]) => ({ subagent_id: id, delegation_id: 'dq', status: 'running', goal }))
await pollNow()
check(subMarks() === 'qa-one=running,qa-two=running', `once started both run (${subMarks()})`)
await emit('subagent.complete', 'rt-4', { subagent_id: 'q1', status: 'completed', duration_seconds: 4 })
await pollNow()
check(subMarks() === 'qa-one=completed,qa-two=running', `a stale snapshot never revives a finished worker (${subMarks()})`)
stub.state.list['rt-4'] = [{ subagent_id: 'q2', delegation_id: 'dq', status: 'running', goal: "Queue 'qa-two'" }]
await pollNow()
check(subMarks() === 'qa-one=completed,qa-two=running', `a finished worker the list drops stays done, not stopped (${subMarks()})`)
await act(async () => { unitNamed('qa-two').click() })
unitNamed('qa-two').focus()
extraBatches = [{ started_at: 5000, workers: [
  { session_id: 'kq1', goal: "Queue 'qa-one'", status: 'completed', duration_s: 4, tool_calls: 1, tokens: 0, summary: 'a' },
  { session_id: 'kq-empty', goal: "Queue 'qa-two'", status: 'completed', duration_s: 6, tool_calls: 1, tokens: 0, summary: '' }
] }]
const releaseHand = hold('children')
stub.state.list['rt-4'] = []
await emit('subagent.complete', 'rt-4', { subagent_id: 'q2', status: 'completed', duration_seconds: 6 })
await tick(10)
check(q('.sw-pick')?.textContent === 'Current run' && unitNamed('qa-two'), 'a finished run stays the current run while history is still loading (no empty flash)')
await act(async () => { releaseHand() })
await tick(20)
{
  const sel = q('.sw-agents button.sw-unit[aria-pressed=true]')
  check(q('.sw-pick')?.textContent === 'Last run' && subMarks() === 'qa-one=completed,qa-two=completed', 'the finished run stays as the last run, from its stored copy')
  check(sel?.querySelector('.sw-un')?.textContent === 'qa-two' && q('.sw-focus')?.dataset.kind === 'sub', 'the subagent that was selected stays selected')
  check(!!sel && document.activeElement === sel, `focus follows the run to its selected unit (${document.activeElement?.className})`)
}
{
  const clipBefore = clip.length
  await act(async () => { q('.sw-focus .sw-btns .sw-ib').click() })
  await tick(5)
  check(clip.length === clipBefore && (q('.sw-toast.is-bad')?.textContent || '').startsWith('Nothing to copy'), `empty output is not "Copied" (${q('.sw-toast')?.textContent})`)
}
extraBatches = []

// 16d. a failed poll of the chat the page has left does not count against the new chat
await act(async () => { document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })) })
stub.state.list['rt-5'] = []
let releaseList
stub.state.listHold = new Promise(r => { releaseList = r })
stub.state.listFails = true
await act(async () => { stub.atoms.focusedSessionId.set('rt-5'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
await act(async () => { stub.atoms.focusedSessionId.set('rt-6'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
stub.state.listHold = null
let afterTwo
await quiet(async () => {
  await act(async () => { releaseList() })
  await tick(10)
  await tick(3100)
  afterTwo = (q('[role=alert]')?.textContent || '').includes('live updates stopped')
  await tick(3100)
})
check(!afterTwo && (q('[role=alert]')?.textContent || '').includes('live updates stopped'), `the new chat gets its own three tries (stopped after two: ${afterTwo})`)
stub.state.listFails = false

// 24. a chat with no subagents: the main agent alone, what subagents are, its files or none yet
await act(async () => { stub.atoms.focusedSessionId.set('rt-e'); stub.atoms.focusedStoredSessionId.set('st-empty') })
await tick(10)
check(q('.sw-solo') && units().length === 1 && units()[0].dataset.main === 'true' && q('.sw-nosub')?.textContent === 'Subagents appear here when the main agent hands work off to a helper.',
  'a chat with no subagents shows the main agent and says when subagents appear')
check(q('.sw-focus')?.dataset.kind === 'main' && q('.sw-focus [data-sec=none] .sw-empty')?.textContent === 'No files read or changed in this chat yet.' && !q('.sw-runb'),
  'its focus panel says no files yet; there is no run to pick')
check(q('.sw-score')?.getAttribute('aria-label') === 'No subagents yet', 'the score says there are none yet')
// 25. more than SWARM_AT live subagents: the swarm, the main agent on top waiting on them
for (let i = 0; i < 12; i++) await emit('subagent.spawn_requested', 'rt-e', { subagent_id: `e${i}`, goal: `Spawn 'eq-${i}'`, task_index: i })
check(q('.sw-swarm') && !q('.sw-swarm ~ .sw-units') && q('.sw-gmain .sw-unit')?.getAttribute('aria-label') === 'Main agent: waiting on 12',
  `past 8 subagents the units become a swarm, the main agent on top waiting on them (${q('.sw-gmain .sw-unit')?.getAttribute('aria-label')})`)

// empty chat
await act(async () => { stub.atoms.focusedSessionId.set(null); stub.atoms.focusedStoredSessionId.set(null) })
await tick(10)
check(q('.sw-hint')?.textContent.includes('No chat selected') && !q('[role=tablist]'), 'no chat -> it says so')

await act(async () => root.unmount())

// 18. the progress chip in the status bar, and the pet line
const chipReg = registered.find(c => c.area === 'statusBar.right')
check(chipReg?.id === 'progress' && typeof chipReg.render === 'function', 'a progress chip is registered in the status bar')
const chipHost = document.createElement('div')
document.body.appendChild(chipHost)
const chipRoot = createRoot(chipHost)
stub.state.listFails = false
stub.state.list['rt-9'] = []
await act(async () => { stub.atoms.focusedSessionId.set('rt-9'); stub.atoms.focusedStoredSessionId.set('st-9') })
await act(async () => { chipRoot.render(React.createElement(chipReg.render)) })
await tick(10)
const chip = () => chipHost.querySelector('.sw-sb')
check(!chip() && stub.calls.request.some(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-9'),
  'no batch -> no chip; the focused chat is asked once for a batch already running')
const said0 = stub.pet.said.length
for (const id of ['p1', 'p2', 'p3']) await emit('subagent.spawn_requested', 'rt-9', { subagent_id: id, goal: id })
await tick(5)
check(chip()?.querySelector('.sw-sbn')?.textContent === '0/3' && chip()?.dataset.st === 'queued', `three queued workers read 0/3 (${chip()?.querySelector('.sw-sbn')?.textContent})`)
check(chipHost.querySelector('.sw-sbw')?.dataset.theme === 'cockpit', 'the chip takes the chosen look')
check(stub.pet.said.length === said0, 'no pet on screen -> nothing is said')
await emit('subagent.spawn_requested', 'rt-OTHER', { subagent_id: 'o1', goal: 'other chat' })
await tick(5)
check(chip()?.querySelector('.sw-sbn')?.textContent === '0/3', "another chat's worker is not counted")
await act(async () => { stub.pet.visible.set(true) })
await emit('subagent.start', 'rt-9', { subagent_id: 'p1' })
await emit('subagent.complete', 'rt-9', { subagent_id: 'p1', status: 'completed', cost_usd: 1.2 })
await emit('subagent.start', 'rt-9', { subagent_id: 'p2' })
await tick(5)
const bar = () => chipHost.querySelector('.sw-sbbar > i')?.style.width
check(chip()?.querySelector('.sw-sbn')?.textContent === '1/3' && bar() === '33%' && chip()?.querySelector('.sw-sbc')?.textContent === '~$1.20',
  `one done of three: 1/3, a third of the bar, the cost so far (${chip()?.querySelector('.sw-sbn')?.textContent} ${bar()} ${chip()?.querySelector('.sw-sbc')?.textContent})`)
check(chip()?.dataset.st === 'running' && chip()?.getAttribute('aria-label') === chip()?.dataset.tip && /1 of 3 finished/.test(chip()?.dataset.tip || ''),
  `the chip is named by its tooltip (${chip()?.dataset.tip})`)
let lastSaid = stub.pet.said.at(-1)
check(lastSaid?.[0] === 'Subagents 1/3 done · ~$1.20' && lastSaid?.[1]?.id === 'progress' && lastSaid?.[1]?.tone === 'wait',
  `with a pet on screen the progress is a line in its bubble (${JSON.stringify(lastSaid)})`)
const saidN = stub.pet.said.length
await emit('subagent.tool', 'rt-9', { subagent_id: 'p2', tool_name: 'terminal' })
stub.state.list['rt-9'] = [{ subagent_id: 'p2', status: 'running', goal: 'p2' }]
await tick(3100)
check(stub.pet.said.length === saidN, `a tool call or a poll that changes nothing says nothing again (${stub.pet.said.length - saidN} extra)`)
await emit('subagent.complete', 'rt-9', { subagent_id: 'p2', status: 'error', cost_usd: 0 })
await tick(5)
check(chip()?.querySelector('.sw-sbn')?.textContent === '2/3' && /1 failed/.test(chip()?.dataset.tip || '') && chip()?.querySelector('.sw-sbc')?.textContent === '~$1.20',
  `a failed worker counts as finished, is named in the tooltip, and its $0 frame adds no price (${chip()?.dataset.tip})`)
await emit('subagent.start', 'rt-9', { subagent_id: 'p3' })
await emit('subagent.complete', 'rt-9', { subagent_id: 'p3', status: 'completed' })
await tick(5)
lastSaid = stub.pet.said.at(-1)
check(chip()?.querySelector('.sw-sbn')?.textContent === '3/3' && chip()?.dataset.st === 'failed' && bar() === '100%', `a finished batch with a failure reads 3/3 in red (${chip()?.dataset.st})`)
check(lastSaid?.[1]?.tone === 'error' && lastSaid?.[1]?.ttlMs === 8000, `the pet's last line for that batch is an error that expires (${JSON.stringify(lastSaid)})`)
await emit('subagent.complete', 'rt-9', { subagent_id: 'p1', status: 'failed' })
check(chip()?.querySelector('.sw-sbn')?.textContent === '3/3' && /1 failed/.test(chip()?.dataset.tip || ''), 'a late frame never changes a worker that already ended')
await act(async () => { chip().click() })
check(stub.calls.navigated.at(-1) === '/subagent-watch', 'the chip opens the Subagents page')
await tick(8200)
check(!chip() && stub.pet.cleared.includes('progress'), 'a finished batch lingers, then the chip and the pet line go')
stub.state.list['rt-8'] = [{ subagent_id: 'r1', status: 'running', goal: 'r1' }, { subagent_id: 'r2', status: 'running', goal: 'r2' }]
await act(async () => { stub.atoms.focusedSessionId.set('rt-8') })
await tick(10)
check(chip()?.querySelector('.sw-sbn')?.textContent === '0/2', `a batch already running is picked up from subagent.list (${chip()?.querySelector('.sw-sbn')?.textContent})`)
stub.state.list['rt-8'] = [{ subagent_id: 'r2', status: 'running', goal: 'r2' }]
await tick(3100)
check(chip()?.querySelector('.sw-sbn')?.textContent === '1/2' && /1 failed or stopped/.test(chip()?.dataset.tip || ''),
  `a worker the list dropped without a complete frame ends as stopped (${chip()?.dataset.tip})`)
stub.state.listFails = true
await quiet(async () => { for (let i = 0; i < 3; i++) await tick(3100) })
check(chip()?.dataset.st === 'failed' && /stopped updating: gateway down/.test(chip()?.dataset.tip || ''), `three failed polls are shown on the chip (${chip()?.dataset.tip})`)
stub.state.listFails = false
await emit('subagent.complete', 'rt-8', { subagent_id: 'r2', status: 'completed', cost_usd: 0 })
await tick(5)
check(chip()?.querySelector('.sw-sbn')?.textContent === '2/2' && !chip()?.querySelector('.sw-sbc'),
  `a batch whose only cost frames read 0 shows no cost, not $0.00 (${chip()?.querySelector('.sw-sbc')?.textContent})`)
await act(async () => { stub.atoms.focusedSessionId.set('rt-9') })
await tick(10)
check(!chip(), 'switching to a chat whose batch is long finished shows no chip')
await act(async () => chipRoot.unmount())

// 19. files: path keys shared with the backend, the main agent's and a subagent's files, working on now
const vectors = JSON.parse(readFileSync(`${HERE}path_vectors.json`, 'utf8')).cases
const badVec = vectors.filter(([input, key]) => mod.pathKey(input) !== key)
check(!badVec.length, `the page's pathKey gives the backend's key for all ${vectors.length} shared vectors (${JSON.stringify(badVec)})`)
check(mod.resolvePath('src/a.py', 'D:\\Proj') === 'D:\\Proj\\src/a.py' && mod.resolvePath('/abs/x', '/w') === '/abs/x' &&
  mod.resolvePath('C:/x', '/w') === 'C:/x' && mod.resolvePath('~/n', '/w') === '~/n' && mod.resolvePath('a', null) === 'a',
'a relative path joins the chat folder with its separator; absolute, drive and ~ paths are kept')
check(JSON.stringify(mod.fileTargets('read_file', { path: 'a' })) === '[{"path":"a","op":"read"}]' &&
  mod.fileTargets('write_file', { path: 'a' })[0]?.op === 'write' && mod.fileTargets('patch', { path: 'a' })[0]?.op === 'write',
'read_file reads, write_file and a replace-mode patch write')
check(!mod.fileTargets('patch', { mode: 'patch', path: 'a', patch: '*** Begin Patch' }).length && !mod.fileTargets('read_file', {}).length &&
  !mod.fileTargets('terminal', { command: 'cat a' }).length && !mod.fileTargets('write_file', null).length,
'a V4A patch, a mirrored worker row (no args), a terminal call and missing args name no file here')
check(mod.fileState({ last_failed: true, writes: 2 }, false) === 'failed' && mod.fileState({ writes: 1, last_failed: true }, true) === 'active' &&
  mod.fileState({ last_op: 'delete', deletes: 1, writes: 1 }) === 'delete' && mod.fileState({ reads: 3 }) === 'read' && mod.fileState({ writes: 1 }) === 'write',
'a file state: now beats all, then a failed last change, deleted, edited, read only')
check(mod.dirLabel('D:\\Proj', 'd:/proj', tr) === 'chat folder' && mod.dirLabel('D:\\Proj\\src\\ui', 'D:\\Proj', tr) === './src/ui' &&
  mod.dirLabel('/x'.repeat(40), '/w', tr).startsWith('…') && mod.dirLabel('/x'.repeat(40), '/w', tr).length === 48,
'a folder label: the chat folder by name, its sub-folders relative, a long one cut from the left')

const fhost = document.createElement('div')
document.body.appendChild(fhost)
const froot = createRoot(fhost)
await act(async () => { stub.atoms.focusedSessionId.set('rt-f'); stub.atoms.focusedStoredSessionId.set('st-f') })
await act(async () => { froot.render(React.createElement(route.render)) })
await tick(10)
const fq = s => fhost.querySelector(s)
const fqa = s => [...fhost.querySelectorAll(s)]
const sec = name => fqa(`.sw-focus [data-sec=${name}] .sw-fr`)
const rowOf = name => fqa('.sw-focus .sw-fr').find(b => b.querySelector('.sw-fn')?.textContent === name)
check(rest.some(p => p === '/files?session_id=st-f'), 'files are read for the stored chat id')
{
  const tiles = fqa('.sw-focus .sw-tile').map(x => `${x.querySelector('.sw-tl')?.textContent}=${x.querySelector('.sw-tn')?.textContent}`).join('|')
  check(tiles === 'on task=28s|files touched=5|changed=3|only read=2', `the main agent's stat tiles: on task, files touched, changed, only read (${tiles})`)
  check(fq('.sw-focus .sw-verb')?.textContent === '○ IDLE' && fq('.sw-focus .sw-ptag')?.textContent === 'main' && fq('.sw-focus .sw-por')?.dataset.st === 'idle',
    `an idle main agent's hero says so, tagged MAIN (${fq('.sw-focus .sw-verb')?.textContent})`)
}
const note = fq('.sw-focus .sw-note')?.textContent || ''
check(/terminal commands or code runs are not listed/.test(note) && /Review › Last turn/.test(note), `the panel says what it cannot see and where every change is (${note})`)
check(sec('changed').map(r => r.querySelector('.sw-fn').textContent).join() === 'a.py,README.md,old.txt' && sec('read').map(r => r.querySelector('.sw-fn').textContent).join() === 'b.py,x.md',
  `the main agent's files: Changed (its edits, a failed change, a delete) and Only read (${sec('changed').length}/${sec('read').length})`)
check(rowOf('a.py')?.dataset.op === 'write' && rowOf('README.md')?.dataset.op === 'failed' && rowOf('old.txt')?.dataset.op === 'delete' && rowOf('b.py')?.dataset.op === 'read',
  'each file state is its own row kind: edited, failed, deleted, read only')
check(rowOf('a.py')?.querySelector('.sw-fl')?.textContent === '3 edits' && rowOf('README.md')?.querySelector('.sw-fl')?.textContent === 'failed' && rowOf('old.txt')?.querySelector('.sw-fl')?.textContent === 'deleted',
  `a changed row says EDIT ×n / FAILED / DELETED (${rowOf('a.py')?.querySelector('.sw-fl')?.textContent})`)
check(rowOf('a.py')?.querySelector('.sw-pips')?.dataset.lit === '3' && rowOf('a.py')?.querySelectorAll('.sw-pips i').length === 8 && rowOf('a.py')?.querySelectorAll('.sw-pips i.on').length === 3
  && rowOf('README.md')?.querySelectorAll('.sw-pips i.on').length === 1 && !rowOf('old.txt')?.querySelector('.sw-pips') && rowOf('a.py')?.classList.contains('sw-ft'),
  'a changed file is a card: one lit block per edit out of 8, none for a delete')
check(fq('.sw-focus [data-sec=changed] .sw-leg')?.textContent === '1 block = 1 edit', 'the blocks are explained: 1 block = 1 edit')
check(mod.pips(3) === 3 && mod.pips(8) === 8 && mod.pips(12) === 8 && mod.pips(0) === 0 && mod.pips(null) === 0, 'the blocks stop at 8')
check(rowOf('a.py')?.querySelector('.sw-fd')?.textContent === './src' && rowOf('README.md')?.querySelector('.sw-fd')?.textContent === 'chat folder'
  && /in …/.test(rowOf('x.md')?.getAttribute('aria-label') || '') && rowOf('x.md')?.dataset.tip.startsWith('C:/elsewhere')
  && rowOf('x.md')?.classList.contains('sw-ft') && rowOf('x.md')?.dataset.op === 'read' && rowOf('x.md')?.querySelector('.sw-fl')?.textContent === 'read ×1'
  && rowOf('x.md')?.querySelectorAll('.sw-pips i.on').length === 1 && rowOf('x.md')?.closest('.sw-fgrid')?.closest('[data-sec=read]'),
  'a card names its folder relative to the chat; an only-read file is a row like a changed one (one block per read); the full path is the tooltip')
check(/\.sw-page\[data-theme=terminal\] \.sw-ft\{display:grid;width:100%;/.test(css),
  'a Terminal file row fills the line (a button sizes to its content, so rows would not line up)')
check(rowOf('a.py')?.getAttribute('aria-label') === 'a.py in ./src: 3 edits', `a row is named for a screen reader (${rowOf('a.py')?.getAttribute('aria-label')})`)
check(fqa('.sw-focus .sw-fnote').map(e => e.textContent).join('|') === '2 older files not listed|1 tool call could not be read',
  'unreadable calls and files past the list are said, never silently dropped')
await act(async () => { rowOf('b.py').click() })
await tick(2)
check(clip.at(-1) === 'D:\\Proj\\src\\b.py' && fq('.sw-toast')?.textContent === 'Path copied', `a row copies its full path (${fq('.sw-toast')?.textContent})`)
{
  const docs = [...fhost.querySelectorAll('.sw-agents button.sw-unit')].find(u => u.textContent.includes('docs-writer'))
  await act(async () => { docs.click() })
  check(fq('.sw-focus')?.dataset.kind === 'sub' && sec('changed').map(r => r.querySelector('.sw-fn').textContent).join() === 'a.py' && !sec('read').length
    && /changed 1 file/.test(fq('.sw-focus .sw-meta')?.textContent || ''),
  `a subagent's panel lists the files it changed, from /files who/editors (${fq('.sw-focus .sw-meta')?.textContent})`)
  const watchdog = [...fhost.querySelectorAll('.sw-agents button.sw-unit')].find(u => u.textContent.includes('wiki-watchdog'))
  await act(async () => { watchdog.click() })
  check(fq('.sw-focus .sw-verb')?.textContent === '✕ STOPPED WITH AN ERROR' && fq('.sw-focus .sw-ans')?.dataset.st === 'failed' && fq('.sw-focus .sw-tile[data-k=time]')?.dataset.tone === 'bad'
    && fq('.sw-focus .sw-head')?.textContent === "Watch the 'wiki-watchdog' panel",
  `a failed subagent: the verb says it stopped with an error, its answer and run time in red (${fq('.sw-focus .sw-verb')?.textContent})`)
  await act(async () => { fhost.querySelector('.sw-agents button.sw-unit').click() })
}
// working on now (1.6.0's shimmer): the main agent's live file calls
const filesReads = () => rest.filter(p => p === '/files?session_id=st-f').length
const nowRows = () => fqa('.sw-focus .sw-fr.is-now')
const nowNames = () => nowRows().map(r => r.querySelector('.sw-fn').textContent).join()
const mainUnit = () => fhost.querySelector('.sw-agents button.sw-unit')
await emit('tool.start', 'rt-other', { tool_id: 'x1', name: 'read_file', args: { path: 'D:\\Proj\\src\\b.py' } })
check(!nowRows().length, "another chat's tool call is not this chat's work")
await emit('tool.start', 'rt-f', { tool_id: 'm1', name: 'read_file', args: {}, preview: 'worker row' })
await emit('tool.start', 'rt-f', { tool_id: 'v1', name: 'patch', args: { mode: 'patch', path: 'src/b.py', patch: '*** Update File: D:/Proj/src/b.py' } })
check(!nowRows().length, 'a mirrored worker row and a V4A patch name no file')
await emit('tool.complete', 'rt-f', { tool_id: 'm1' })
await emit('tool.complete', 'rt-f', { tool_id: 'v1' })
await emit('tool.start', 'rt-f', { tool_id: 't1', name: 'read_file', args: { path: 'src/b.py' } })
check(nowNames() === 'b.py' && fq('.sw-focus .sw-head')?.textContent === 'b.py' && fq('.sw-focus .sw-verb')?.textContent === '▶ READING NOW' && mainUnit()?.dataset.icon === 'read' && mainUnit()?.dataset.st === 'running',
  `a file call of the focused chat is the NOW card and the headline, the verb line reads (${fq('.sw-focus .sw-verb')?.textContent} ${fq('.sw-focus .sw-head')?.textContent})`)
check(sec('now')[0]?.classList.contains('is-now') && fq('.sw-focus [data-sec=now] h4')?.textContent === 'Working on now'
  && fq('.sw-focus [data-sec=now]')?.nextElementSibling?.dataset.sec !== 'now'
  && nowRows()[0]?.querySelector('.sw-nowb')?.textContent === 'NOW' && /worked on now/.test(nowRows()[0]?.getAttribute('aria-label') || ''),
  'the NOW card is its own block above the lists, badged NOW, and says so to a screen reader')
check(!sec('changed').some(r => r.querySelector('.sw-fn')?.textContent === 'b.py') && !sec('read').some(r => r.querySelector('.sw-fn')?.textContent === 'b.py'),
  'the file worked on now is in neither list below it')
{
  // heading count = rows shown + the "Show N more" rest, for each list
  const counts = ['changed', 'read'].map(k => {
    const box = fq(`.sw-focus [data-sec=${k}]`)
    if (!box) return [k, 0, 0]
    const head = Number(/(\d+)/.exec(box.querySelector('h4')?.textContent || '')?.[1])
    const more = Number(/(\d+)/.exec(box.querySelector(':scope > .sw-more')?.textContent || '')?.[1] || 0)
    return [k, head, box.querySelectorAll('.sw-fr').length + more]
  })
  check(counts.every(([, h, r]) => h === r), `each list heading counts exactly its rows while a file is worked on (${counts.map(c => c.join(' ')).join(' · ')})`)
}
await emit('tool.start', 'rt-f', { tool_id: 't2', name: 'write_file', args: { path: 'D:/Proj/src/new.ts', content: 'x' } })
check(nowNames() === 'b.py,new.ts' && fq('.sw-focus .sw-head')?.textContent === 'new.ts' && fq('.sw-focus .sw-verb')?.textContent === '▶ EDITING NOW' && rowOf('new.ts')?.dataset.op === 'active' && mainUnit()?.dataset.icon === 'edit',
  'a file not yet recorded appears at once; the newest file is the head line and the icon edits')
const readsBefore = filesReads()
await emit('tool.complete', 'rt-f', { tool_id: 't1', name: 'read_file' })
await tick(5)
check(filesReads() > readsBefore && nowNames() === 'b.py,new.ts', 'a finished call reloads the list, and its row stays a moment')
await tick(4100)
check(nowNames() === 'new.ts', 'the row ends after the linger; a call still running keeps its own')
await emit('tool.complete', 'rt-f', { tool_id: 't2', name: 'write_file' })
await tick(4100)
check(!nowRows().length && !rowOf('new.ts') && mainUnit()?.dataset.st === 'idle', 'once every call ended nothing is worked on now, and an unrecorded file leaves with it')
// a recorded changed file worked on now leaves Changed for the NOW block, and the heading counts what is left
await emit('tool.start', 'rt-f', { tool_id: 't3', name: 'write_file', args: { path: 'D:/Proj/src/a.py', content: 'x' } })
{
  const h = Number(/(\d+)/.exec(fq('.sw-focus [data-sec=changed] h4')?.textContent || '')?.[1])
  check(nowNames() === 'a.py' && !sec('changed').some(r => r.querySelector('.sw-fn')?.textContent === 'a.py') && h === sec('changed').length && h === 2,
    `a changed file worked on now is shown once; Changed counts only its own rows (${h} / ${sec('changed').length})`)
}
await emit('tool.complete', 'rt-f', { tool_id: 't3', name: 'write_file' })
await tick(4100)
// 26. reduced motion turns every animation off; every moment exists
{
  const pageCss = mod.default && (fq('style')?.textContent || '')
  const animated = [...pageCss.matchAll(/([^{}]+)\{[^{}]*animation:(?!none)[^{}]*\}/g)].map(m => m[1].trim()).filter(s => !s.startsWith('@') && !/^\d|^from|^to/.test(s))
  check(/@media \(prefers-reduced-motion:reduce\)\{\.sw-page \*,\.sw-page \*::before,\.sw-page \*::after\{animation:none!important;transition:none!important\}\}/.test(pageCss)
    && animated.length > 5 && animated.every(s => s.split(',').every(one => /^\.sw-(page|panel|unit|sk|ld|bign|nowf|fr|spr|frow)/.test(one.trim()) || /^\.sw-page /.test(one.trim()))),
  `reduced motion stops every page animation (${animated.length} animated rules, all inside the page)`)
  check(['sw-close', 'sw-shake', 'sw-up', 'sw-slide', 'sw-breathe', 'sw-type', 'sw-blink', 'sw-count', 'sw-in', 'sw-sweep', 'sw-reveal', 'sw-scan'].every(k => new RegExp(`@keyframes ${k}\\{`).test(pageCss)),
    'the moments exist: ring closes, shake, count up, slide, breathe, retyped tag, cursor blink, tile count-up, cards in turn, NOW sweep, answer reveal, scan')
  check(['.sw-page .sw-tn[data-count]', '.sw-page .sw-ft', '.sw-page .sw-ft.is-now::after', '.sw-page .sw-ans', '.sw-page .sw-scan', '.sw-page .sw-radar'].every(sel => animated.includes(sel))
    && /@property --sw-n\{syntax:"<integer>"/.test(pageCss),
    'a panel opening moves: numbers count up, cards appear in turn, a light sweeps the NOW card, the answer reveals — all inside the reduced-motion lock')
}
{
  const st = fq('style')?.textContent || ''
  check(/\.sw-units\{[^}]*display:grid;grid-template-columns:repeat\(var\(--sw-cols\),96px\)/.test(st) && /@container \(max-width:407px\)\{\.sw-units\{--sw-fit:3;--sw-cols:var\(--sw-c3/.test(st)
    && /\.sw-cellgrid\{display:flex;flex-wrap:wrap/.test(st),
    'units take the columns that fit the panel and swarm cells wrap: nothing scrolls sideways')
  check([[6, 5, 3], [7, 5, 4], [6, 6, 6], [5, 4, 3], [9, 8, 5], [3, 5, 3], [1, 2, 1], [8, 3, 3]].every(([n, fit, c]) => mod.unitCols(n, fit) === c),
    'agents split into even rows: 6 at 5 a row are 3 + 3, 7 are 4 + 3, never 5 + 1')
  const u = fhost.querySelector('.sw-agents .sw-units')
  const n = u ? Number(u.style.getPropertyValue('--sw-n')) : 0
  check(u && n > 0 && [2, 3, 4, 5, 6, 7, 8].every(f => Number(u.style.getPropertyValue(`--sw-c${f}`)) === mod.unitCols(n, f)),
    `the page hands the stylesheet one column count per width step (n=${n})`)
  check(/\.sw-page\[data-theme=terminal\] \.sw-panel \.sw-ft\{grid-template-columns:14px minmax\(0,1fr\) auto\}/.test(st)
    && /\.sw-page\[data-theme=terminal\] \.sw-panel \.sw-ft \.sw-pips,\.sw-page\[data-theme=terminal\] \.sw-panel \.sw-nowb\{display:none\}/.test(st),
    'a narrow Terminal file row keeps the name and what happened; the blocks and NOW column give way')
}
filesFails = true
await quiet(async () => {
  await act(async () => { stub.atoms.focusedSessionId.set('rt-g'); stub.atoms.focusedStoredSessionId.set('st-g') })
  await tick(10)
})
check(/the files list — files 503/.test(fq('.sw-err')?.textContent || ''), `a failed files read is in the alert (${fq('.sw-err')?.textContent})`)
filesFails = false
await act(async () => { stub.atoms.focusedSessionId.set('rt-m'); stub.atoms.focusedStoredSessionId.set('st-many') })
await tick(10)
check(sec('read').length === 6 && fq('.sw-focus [data-sec=read] .sw-more')?.textContent === 'Show 39 more', `Only read shows its first rows and how many more (${fq('.sw-focus [data-sec=read] .sw-more')?.textContent})`)
{
  const big = fqa('.sw-focus .sw-fr').find(b => b.querySelector('.sw-fn')?.textContent === 'big.js')
  check(big?.querySelector('.sw-pips')?.dataset.lit === '8' && big?.querySelectorAll('.sw-pips i.on').length === 8 && big?.querySelector('.sw-fl')?.textContent === '12 edits',
    `more than 8 edits fill the row and the label says the real count (${big?.querySelector('.sw-fl')?.textContent})`)
}
await act(async () => { fq('.sw-focus [data-sec=read] .sw-more').click() })
check(sec('read').length === 45 && !fq('.sw-focus [data-sec=read] .sw-more'), 'Show more lists every file')

// 25. the 40-subagent swarm
await act(async () => { stub.atoms.focusedSessionId.set('rt-s'); stub.atoms.focusedStoredSessionId.set('st-swarm') })
await tick(10)
const grp = id => fq(`.sw-swarm [data-grp=${id}]`)
check(fq('.sw-swarm') && fqa('.sw-swarm [data-grp]').map(g => g.dataset.grp).join() === 'failed,running,queued,completed' && fq('.sw-swarm > .sw-gmain .sw-unit')?.dataset.main === 'true',
  `40 subagents: the main agent on top, then Failed, Working, Waiting, Done (${fqa('.sw-swarm [data-grp]').map(g => g.dataset.grp)})`)
check([...grp('failed').querySelectorAll('.sw-frow .sw-frn')].map(e => e.textContent).join() === 'unit-00,unit-01,unit-02,unit-03',
  'failed (and stopped) subagents are listed by name')
check(grp('running').querySelectorAll('.sw-cell').length === 6 && !grp('queued').querySelector('.sw-cell') && !grp('completed').querySelector('.sw-cell')
  && grp('queued').querySelector('.sw-fold')?.getAttribute('aria-expanded') === 'false' && grp('completed').querySelector('.sw-fold')?.textContent === 'Show',
  'working subagents are small cells; Waiting and Done start collapsed behind Show')
check(fq('.sw-bign')?.textContent === '20' && fq('.sw-big small')?.textContent === '/40', 'the swarm score: 20 of 40')
{
  const cell = grp('running').querySelector('.sw-cell')
  check(cell?.dataset.tip === 'unit-04 — working' && cell?.getAttribute('aria-label') === cell?.dataset.tip, `a cell's tooltip names it and its activity (${cell?.dataset.tip})`)
  await act(async () => { cell.click() })
  check(fq('.sw-focus')?.dataset.kind === 'sub' && fq('.sw-focus .sw-head')?.textContent === "Sweep 'unit-04'", 'a cell click selects it into the focus panel')
}
await act(async () => { grp('completed').querySelector('.sw-fold').click() })
check(grp('completed').querySelectorAll('.sw-cell').length === 20 && grp('completed').querySelector('.sw-fold')?.getAttribute('aria-expanded') === 'true', 'Show opens a group')
await act(async () => { fq('.sw-tgb[data-theme=terminal]').click() })
check(fq('.sw-page')?.dataset.theme === 'terminal' && fqa('.sw-swarm .sw-cell .sw-glyph').length === 26 && !fqa('.sw-swarm .sw-cell svg').length,
  'the Terminal swarm draws glyph cells')
await act(async () => { fq('.sw-tgb[data-theme=cockpit]').click() })
await act(async () => froot.unmount())

// 20b. the kept look is read back from ctx.storage; a storage that fails or is missing falls back
const quietCtx = extra => ({ ...ctx, register: () => () => {}, onEvent: () => () => {}, ...extra })
const mountFresh = async () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const r = createRoot(el)
  await act(async () => { r.render(React.createElement(route.render)) })
  await tick(5)
  return { el, r }
}
kept.set('theme', 'terminal')
mod.default.register(quietCtx({}))
{
  const { el, r } = await mountFresh()
  check(el.querySelector('.sw-page')?.dataset.theme === 'terminal', 'a kept Terminal look is read back from ctx.storage')
  await act(async () => r.unmount())
}
storageFails = true
mod.default.register(quietCtx({}))
await quiet(async () => {
  let threw = null
  let el, r
  try {
    ({ el, r } = await mountFresh())
    await act(async () => { el.querySelector('.sw-tgb[data-theme=terminal]').click() })
  } catch (err) { threw = err }
  check(!threw && el?.querySelector('.sw-page')?.dataset.theme === 'terminal' && el.querySelector('.sw-agents, .sw-hint, .sw-skel'),
    `a storage that throws falls back to Cockpit and the toggle still works (${threw})`)
  if (r) await act(async () => r.unmount())
})
storageFails = false
kept.set('theme', 'nonsense')
mod.default.register(quietCtx({}))
{
  const { el, r } = await mountFresh()
  check(el.querySelector('.sw-page')?.dataset.theme === 'cockpit', 'a kept value that is not a look falls back to Cockpit')
  await act(async () => r.unmount())
}
mod.default.register(quietCtx({ storage: undefined }))
{
  const { el, r } = await mountFresh()
  check(el.querySelector('.sw-page')?.dataset.theme === 'cockpit', 'no ctx.storage at all: Cockpit')
  await act(async () => { el.querySelector('.sw-tgb[data-theme=terminal]').click() })
  check(el.querySelector('.sw-page')?.dataset.theme === 'terminal', 'and the toggle still works without storage')
  await act(async () => r.unmount())
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
