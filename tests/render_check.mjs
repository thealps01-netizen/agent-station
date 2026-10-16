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
 *  20. Look: Terminal is the only look (ASCII sprites, [OK ] tags, the theme's tokens); no toggle, no
 *      Settings page; any kept look (Cockpit, Dot matrix, Live map, nonsense), a storage that throws
 *      or no storage at all reads as Terminal.
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
 *      up, slide, breathe, retyped tag, cursor blink); text never below 11.5px (11px once the HUD's scale applies); focus rings; focusable
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
        { session_id: 'c-d', goal: "Write the 'docs-writer' notes", model: 'anthropic/claude-opus-5-5', effort: 'high', status: 'completed', duration_s: 48, tool_calls: 5, tokens: 2000, cost_usd: 0.08, cost_status: 'estimated', summary: '{"files":1}\nDocs.' },
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
  registerSettingsPage: page => { registered.push({ ...page, area: 'settings.plugins' }); return () => {} },
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
  const st = ['completed', 'failed', 'running', 'queued', 'completed', 'stopped', 'running', 'completed']
  const w = mod.orbitWings(st.map((status, i) => ({ key: i, status })))
  check(mod.orbitWings(st.slice(0, 6).map((status, i) => ({ key: i, status }))).map(x => x.slot).join() === '0,1,2,3,4,5' && w.length === mod.ORBIT_WINGS
    && w.slice(0, 5).map(x => x.u.status).join() === 'failed,running,running,queued,completed' && w[5].rest.length === 3 && w.map(x => x.slot).join() === '0,1,2,4,5,3',
    `the orbit: one wing a subagent while six fit; past that five for those that need eyes (failed, working, waiting) and an outer one holding the rest (${w.map(x => x.u?.status || `+${x.rest.length}`)})`)
}
{
  const files = [
    { key: 'a', who: ['', 'w1'], editors: ['w1'], writes: 1 },
    { key: 'b', who: ['w1'], editors: [], reads: 1, last_op: 'read' },
    { key: 'c', who: [''], editors: [], writes: 0, failed: 1, last_op: 'write', last_failed: true }
  ]
  const w1 = mod.agentFiles(files, 'w1'), me = mod.agentFiles(files, '')
  check(w1.changed.map(f => f.key).join() === 'a' && w1.read.map(f => f.key).join() === 'b' && !w1.failed.length
    && !me.changed.length && me.failed.map(f => f.key).join() === 'c' && me.read.map(f => f.key).join() === 'a',
    `an agent's files come from who/editors: changed by it, only read by it; a failed change nobody made is its own and counts as failed, never changed (${JSON.stringify([w1, me].map(x => [x.changed.length, x.failed.length, x.read.length]))})`)
}
check(mod.logSaid('{"findings":[]}\nThree issues found.') === 'Three issues found.' && mod.logSaid('```json\n{"a":1}\n```') === '' && mod.logSaid('  Done.\nmore') === 'Done.',
  "a log row shows an answer's first line of prose; an answer of data alone leaves the row to what the agent did")
check(mod.distinctNames(['Blind-review desktop panel 1: colours', 'Blind-review desktop panel 2: layout']).every(n => !n.startsWith('…')),
  'a shortened sibling name has no leading ellipsis (the label is already cut at its end where it does not fit)')
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
// the orbit's agents: the main agent's box, then a callout per subagent (its name in .sw-orn)
const NODE = '.sw-agents .sw-orbit button[data-node]'
const units = () => qa(NODE)
const uname = u => (u.dataset.main ? 'main' : u.querySelector('.sw-orn')?.textContent)
const unitNamed = name => units().find(u => !u.dataset.main && uname(u) === name)
const tab = id => q(`[role=tab][data-tab=${id}]`)
const toTab = id => act(async () => { tab(id).click() })
const refresh = async () => { await act(async () => { q('.sw-hd .sw-ib').click() }); await tick(10) }

// 16 + 20. header, look, tabs
check(q('.sw-page')?.dataset.theme === 'terminal' && !q('.sw-tg, .sw-tgb') && !registered.some(c => c.area === 'settings.plugins')
  && !/data-theme=cockpit|\.sw-tg|\.sw-dm|\.sw-utop|\.sw-map/.test(q('style')?.textContent || ''),
  'the page opens in Terminal, the only look: no look toggle, no Settings page, no rule of a removed look')
check(q('h2.sw-ht')?.textContent === 'subagent-watch' && q('.sw-chatn')?.textContent === '// Refactor fleet routing' && !q('.sw-held'),
  `the header has the title and names the watched chat (${q('.sw-chatn')?.textContent})`)
check(tab('agents')?.getAttribute('aria-selected') === 'true' && tab('commands')?.getAttribute('aria-selected') === 'false',
  'two tabs, Agents first and selected')
check(q('.sw-tabn')?.textContent === '1' && q('.sw-tabn')?.getAttribute('aria-label') === '1 command running' && q('.sw-tabn')?.dataset.tip === '1 command running',
  `the Commands tab badge counts running commands, named by its tooltip (${q('.sw-tabn')?.textContent})`)

check(!/Ø/.test(document.body.textContent), 'no letter is swapped for Ø anywhere on the page (O reads as O; one word, one spelling)')
// 21. the orbit: the main agent's box first and selected, a wing and a callout per subagent, statuses never mislabelled
{
  const u = units()
  check(u.length === 3 && u[0].dataset.main === 'true' && u[0].getAttribute('aria-pressed') === 'true' && u[0].querySelector('.sw-orn')?.textContent === '★ MAIN · IDLE',
    `the main agent is the station's box, first and selected, saying what it does (${u.map(x => x.getAttribute('aria-label'))})`)
  check(u.slice(1).map(uname).join() === 'docs-writer,wiki-watchdog', 'then one callout per subagent of the last run')
  check(u[1].dataset.st === 'completed' && u[1].dataset.icon === 'ok' && /^DONE · \d/.test(u[1].querySelector('.sw-orv')?.textContent || '')
    && u[2].dataset.st === 'failed' && /^FAILED/.test(u[2].querySelector('.sw-orv')?.textContent || ''),
    `a done callout reads done with its time, a failed one failed (${u.slice(1).map(x => x.querySelector('.sw-orv')?.textContent)})`)
  const wings = qa('.sw-orbit .sw-orw')
  check(wings.map(w => w.dataset.st).join() === 'completed,failed' && wings[0].querySelectorAll('.sw-orc[data-k=completed]').length === 16
    && wings[1].querySelectorAll('.sw-orc[data-k=failed]').length === 6 && q('.sw-orbit .sw-ors')?.getAttribute('aria-hidden') === 'true',
    'a wing per subagent: a done wing filled, a failed wing with red cells; the drawing is hidden from screen readers')
  check(q('.sw-focus')?.dataset.kind === 'main', 'the focus panel shows the main agent by default')
  check(!q('.sw-sig, .sw-orbl, .sw-letter') && !qa('.sw-page *').some(e => !e.children.length && /^[A-Z]\d?$/.test(e.textContent.trim())),
  'no letter badges anywhere')
  // the live station canvas: first in the orbit, hidden from screen readers; jsdom has no 2D context, so the
  // scene must stand down and leave the SVG schematic visible (the fallback)
  const cv = q('.sw-orbit > canvas.sw-orcv')
  check(cv && cv === q('.sw-orbit').firstElementChild && cv.getAttribute('aria-hidden') === 'true' && !q('.sw-orbit').classList.contains('has-scene'),
    'the station canvas leads the orbit, hidden from screen readers; without a 2D context the SVG schematic stays')
}
// 21c. the station scene with a 2D context: it takes over from the SVG, draws in the page's token colours
// (no colour literal), puts one module per callout on the rim in its status colour, and lets the SVG back
// when it stops
{
  const calls = [], fills = []
  const fake = () => new Proxy({}, {
    get: (o, k) => k === 'getImageData' ? () => ({ data: [51, 102, 204, 255] })
      : k === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : k in o ? o[k] : (...a) => { calls.push(k); if (k === 'fill') fills.push(o.fillStyle) },
    set: (o, k, v) => { o[k] = v; return true }
  })
  const proto = window.HTMLCanvasElement.prototype, real = proto.getContext
  proto.getContext = fake
  const box = document.createElement('div')
  box.className = 'sw-orbit'
  box.dataset.calm = 'true'
  box.innerHTML = `<canvas></canvas><svg class="sw-ors"></svg>
    <button class="sw-ormain" data-st="running" style="top:11%;left:34%;width:32%"></button>
    <button class="sw-orl" data-side="l" data-st="running" style="top:30%"></button>
    <button class="sw-orl" data-side="r" data-st="failed" style="top:60%"></button>
    <div class="sw-orl is-grp" data-side="l" style="top:80%"><span class="sw-orm" data-st="completed">3</span></div>`
  document.body.appendChild(box)
  const canvas = box.querySelector('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 666 })
  Object.defineProperty(canvas, 'clientHeight', { value: 360 })
  const stop = mod.startStationScene(canvas)
  canvas.swStationFrame()
  const styles = fills.filter(f => typeof f === 'string')
  check(box.classList.contains('has-scene') && calls.filter(c => c === 'lineTo').length > 1000 && styles.length
    && styles.every(f => /^color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ [\d.]+\)$/.test(f)),
    `the scene takes over from the SVG and paints in token colours read through the canvas, never a literal (${calls.filter(c => c === 'lineTo').length} line segments, ${styles[0]})`)
  check(fills.length >= 5, `the running and failed modules, the group's slivers and the MAIN box are filled (${fills.length} fills)`)
  stop()
  check(!box.classList.contains('has-scene') && !box.querySelector('.sw-orprobe, span[style*="visibility"]'),
    'stopped, the scene hands the station back to the SVG and leaves no probe behind')
  box.remove()
  proto.getContext = real
}
// 21d. the Commands ORBIT scene with a 2D context: it takes the panel, paints in token colours only, draws
// the planet and an orbit per callout, a failed orbit in the failed colour, and hands the panel back when it stops
{
  const calls = [], fills = [], strokes = []
  const fake = () => new Proxy({}, {
    get: (o, k) => k === 'getImageData' ? () => ({ data: [51, 102, 204, 255] })
      : k === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : k in o ? o[k] : (...a) => { calls.push(k); if (k === 'fill') fills.push(o.fillStyle); if (k === 'stroke') strokes.push(o.strokeStyle) },
    set: (o, k, v) => { o[k] = v; return true }
  })
  const proto = window.HTMLCanvasElement.prototype, real = proto.getContext
  proto.getContext = fake
  const box = document.createElement('div')
  box.className = 'sw-orbit'
  box.dataset.calm = 'true'
  box.innerHTML = `<canvas></canvas><div class="sw-ormain" data-st="running" style="top:11%;left:34%;width:32%"></div>
    <button class="sw-orl is-sel" data-side="l" data-st="running" style="top:30%"></button>
    <button class="sw-orl" data-side="r" data-st="failed" style="top:30%"></button>
    <button class="sw-orl" data-side="l" data-st="completed" style="top:75%"></button>`
  document.body.appendChild(box)
  const canvas = box.querySelector('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 666 })
  Object.defineProperty(canvas, 'clientHeight', { value: 360 })
  const stop = mod.startCmdOrbitScene(canvas)
  canvas.swOrbitFrame()
  const styles = [...fills, ...strokes].filter(f => typeof f === 'string')
  check(box.classList.contains('has-scene') && calls.filter(c => c === 'lineTo').length > 1000 && styles.length
    && styles.every(f => /^color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ [\d.]+\)$/.test(f)),
    `the orbit scene takes its panel and paints in token colours read through the canvas, never a literal (${calls.filter(c => c === 'lineTo').length} line segments)`)
  check(fills.length >= 3 && strokes.length > 100, `the running, failed and finished satellites are filled, the planet and orbits stroked (${fills.length} fills, ${strokes.length} strokes)`)
  stop()
  check(!box.classList.contains('has-scene') && !box.querySelector('span[style*="visibility"]'), 'stopped, the orbit scene hands the panel back and leaves no probe behind')
  box.remove()
  proto.getContext = real
}
// 21e. the Replay WORMHOLE scene with a 2D context: it takes the panel, paints in token colours only, draws
// the sheets, the rings and the scan plane, and hands the panel back when it stops
{
  const calls = [], strokes = []
  const fake = () => new Proxy({}, {
    get: (o, k) => k === 'getImageData' ? () => ({ data: [51, 102, 204, 255] })
      : k === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : k in o ? o[k] : (...a) => { calls.push(k); if (k === 'stroke') strokes.push(o.strokeStyle) },
    set: (o, k, v) => { o[k] = v; return true }
  })
  const proto = window.HTMLCanvasElement.prototype, real = proto.getContext
  proto.getContext = fake
  const box = document.createElement('div')
  box.className = 'sw-orbit'
  box.dataset.calm = 'true'
  Object.assign(box.dataset, { steps: '3', kinds: 'edit,failed,write', sizes: '5,0,7', cur: '1' })
  box.innerHTML = `<canvas></canvas><button class="sw-orl" data-k="0" data-side="l" style="top:70%;left:2%;width:22%"></button>
    <button class="sw-orl is-sel" data-k="1" data-side="r" style="top:50%;left:75%;width:22%"></button>`
  document.body.appendChild(box)
  const canvas = box.querySelector('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 666 })
  Object.defineProperty(canvas, 'clientHeight', { value: 360 })
  const stop = mod.startReplayWormScene(canvas)
  canvas.swOrbitFrame()
  const styles = strokes.filter(f => typeof f === 'string')
  check(box.classList.contains('has-scene') && calls.filter(c => c === 'lineTo').length > 5000 && styles.length > 100
    && styles.every(f => /^color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ [\d.]+\)$/.test(f)),
    `the wormhole scene takes its panel and paints in token colours read through the canvas, never a literal (${calls.filter(c => c === 'lineTo').length} line segments)`)
  check(calls.includes('setLineDash') && calls.filter(c => c === 'setLineDash').length >= 4, 'the wormhole dashes the failed ring and the current edit\'s halo')
  stop()
  check(!box.classList.contains('has-scene') && !box.querySelector('span[style*="visibility"]'), 'stopped, the wormhole scene hands the panel back and leaves no probe behind')
  box.remove()
  proto.getContext = real
}
check(q('.sw-bign')?.textContent === '1' && q('.sw-big small')?.textContent === '/2'
  && qa('.sw-score .sw-seg i').map(i => i.dataset.st).join() === 'completed,failed',
  `the score counts finished subagents of all, one cell per subagent (${q('.sw-big')?.textContent})`)
check(q('.sw-money')?.textContent === '~$0.08' && q('.sw-money')?.tabIndex === 0 && /1 priced/.test(q('.sw-money')?.dataset.tip || '') && /1 not priced/.test(q('.sw-money')?.dataset.tip || ''),
  `the score shows what the subagents spent, a focusable chip with the breakdown (${q('.sw-money')?.dataset.tip})`)
// 21b. the fleet HUD: the schematic, its callouts and lines, time per agent, the agent card, the log
{
  const fleet = q('.sw-agents .sw-hfleet')
  check(fleet?.querySelector('.sw-hpt .sw-sr')?.textContent === 'Fleet · Last run' && fleet.querySelector('.sw-hchip')?.textContent === '1/2 done'
    && fleet.querySelector('.sw-hchip')?.dataset.st === 'failed',
    `the fleet hero is titled with the run and chips how many are done, in the run's state (${fleet?.querySelector('.sw-hchip')?.textContent})`)
  check(qa('.sw-orbit .sw-orlead').length === 3 && qa('.sw-orbit .sw-orpin').length === 3 && q('.sw-ormain .sw-orp b')?.textContent === '1/2'
    && qa('.sw-ormain .sw-orbars i.on').length === 7 && qa('.sw-ormain .sw-orbars i').length === 14 && q('.sw-ormain .sw-orp')?.getAttribute('aria-hidden') === 'true',
    'a leader line and pin from each callout to its wing and from the main box to the core; the main box counts the done subagents')
  check(qa('.sw-orl[data-side=l]').length + qa('.sw-orl[data-side=r]').length === 2 && qa('.sw-orl').every(l => /^\d+(\.\d+)?%$/.test(l.style.top) && /%$/.test(l.style.left)),
    'callouts sit in the drawing\'s own box (percentages), a column each side')
  {
    // every leader line ends on a pin of its own (a wing's corner, the core), never short of it
    const pins = qa('.sw-orbit .sw-orpin').map(c => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)
    const ends = qa('.sw-orbit .sw-orlead').map(p => /L([\d.]+,[\d.]+)$/.exec(p.getAttribute('d'))?.[1])
    check(ends.length === 3 && ends.every((e, i) => e === pins[i]) && new Set(ends).size === ends.length,
      `each leader line ends on its own pin (${ends.join(' ')} · pins ${pins.join(' ')})`)
  }
  check(qa('.sw-htime .sw-tk').map(e => e.dataset.st).join() === 'completed,failed' && qa('.sw-htime .sw-tkn').map(e => e.textContent).join() === 'docs-writer,wiki-watchdog',
    'time per agent: one track per subagent, in its status colour')
  check(qa('.sw-htime .sw-tks').length === 1 && q('.sw-htime .sw-tks')?.classList.contains('sw-tkax') && !q('.sw-htime .sw-tk .sw-tks'),
    'time per agent: the tracks share one scale, drawn once under them')
  check(q('.sw-hdetail')?.tagName === 'DETAILS' && !q('.sw-hdetail').open && q('.sw-hdetail > summary.sw-hph .sw-hpt') && q('.sw-hdetail .sw-focus'),
    'the detail panel starts folded under its title row and keeps its content in the page')
  check(!qa('.sw-hspent .sw-kv dt').some(d => /agents/i.test(d.textContent)) && !qa('.sw-hagent .sw-kv dt').some(d => /subagents/i.test(d.textContent)),
    'the done count is not repeated in SPENT or the main agent card (the fleet chip and the DONE cells carry it)')
  check(qa('.sw-alog .sw-hlm')[0]?.textContent === 'Docs.', `a log row skips an answer's opening data for its first line of prose (${qa('.sw-alog .sw-hlm')[0]?.textContent})`)
  check(qa('.sw-alog > button').length === 2 && q('.sw-hagent .sw-rname')?.textContent === '★ main-agent' && q('.sw-hdetail .sw-focus')?.dataset.kind === 'main',
    'the log has a row per subagent; the agent card and the detail panel show the selected agent')
  check(q('.sw-hdetail .sw-hpn')?.textContent === q('.sw-hagent .sw-rname')?.textContent, `DETAIL names the agent as the AGENT card does (${q('.sw-hdetail .sw-hpn')?.textContent})`)
  await act(async () => { units()[2].click() })
  check(q('.sw-focus')?.dataset.kind === 'sub' && units()[2].getAttribute('aria-pressed') === 'true' && qa('.sw-orw')[1].classList.contains('is-sel') && q('.sw-hagent .sw-rname')?.textContent === 'wiki-watchdog'
    && q('.sw-hagent .sw-hchip')?.dataset.st === 'failed' && qa('.sw-alog > button').map(b => b.getAttribute('aria-pressed')).join() === 'false,true',
    `a callout click selects it: the detail panel, the agent card and its log row follow (${q('.sw-hagent .sw-rname')?.textContent})`)
  await act(async () => { qa('.sw-alog > button')[0].click() })
  check(q('.sw-hagent .sw-rname')?.textContent === 'docs-writer' && units()[1].getAttribute('aria-pressed') === 'true', 'a log row click selects its subagent')
  await act(async () => { q('.sw-ormain').click() })
  check(q('.sw-focus')?.dataset.kind === 'main' && q('.sw-orbox')?.classList.contains('is-sel'), 'the main box selects the main agent again')
}
const css = q('style')?.textContent || ''
check(/:is\(\.sw-ht,\.sw-rname\)\{font-size:14px/.test(css) && /\.sw-score \.sw-money\{display:inline;font:250 28px/.test(css) && /\.sw-page\[data-theme=terminal\] \.sw-why\{margin:0;padding:7px 12px;background:var\(--raised\)/.test(css),
  'HUD type: 11.5 px text, 14 px names, 28 px numbers; the line under the title is a strip like the run bar on every tab')
check(/\.sw-page button:focus-visible[^{]*\{[^}]*outline:2px/.test(css), 'buttons draw a visible focus ring (the app removes every ring)')
check(/\.sw-toast\{width:max-content;max-width:min\(360px,calc\(100cqw - 40px\)\)/.test(css),
  'a toast is as wide as its text up to 360px (its region is shrink-wrapped: a % width wraps one word a line)')
check(qa('[data-tip]').filter(e => !e.closest('button')).every(e => e.tabIndex === 0),
  `every tooltip trigger outside a button is focusable (${qa('[data-tip]').filter(e => !e.closest('button') && e.tabIndex !== 0).map(e => e.className)})`)
{
  const small = []
  for (const decl of css.match(/font(-size)?:[^;}]*/g) || []) {
    for (const n of decl.match(/(?<![\d./])\d+(\.\d+)?px/g) || []) if (parseFloat(n) < 11.5) small.push(decl)
  }
  check(!small.length, `no text below 11.5px (${small.join(' | ')})`)
  // the HUD page is scaled so its smallest text lands at the 11px the user picked, never under
  const zoom = parseFloat(css.match(/\.sw-page\[data-theme=terminal\]\{zoom:([\d.]+);/)?.[1] || '1')
  check(zoom < 1 && 11.5 * zoom >= 11 - 0.01, `the HUD is drawn at its picked scale and no text lands under 11px (zoom ${zoom} → ${(11.5 * zoom).toFixed(1)}px)`)
  check(/\.sw-page\[data-theme=terminal\]\{--mono:var\(--dt-font-sans[^}]*--code:var\(--dt-font-mono/.test(css) && /\.sw-rlines,[^{]*\)\{font-family:var\(--code\)/.test(css) && !/Cascadia/.test(css),
    'the HUD takes its fonts from Hermes: text in the app font, code and numbers in the app code font, no font name of its own')
}
check(/--dim:var\(--ui-text-secondary\)/.test(css) && !/tertiary/.test(css.match(/\.sw-model\{[^}]*\}/)?.[0] || 'tertiary')
  && !/tertiary/.test(css.match(/\.sw-meta\{[^}]*\}/)?.[0] || 'tertiary'),
  'times, counts and model chips use a reading token (tertiary measured 4.0-4.2:1 < 4.5)')
check(q('.sw-live[role=status]') !== null && !q('.sw-live').textContent, 'the toast live region is mounted before any toast (so it is announced)')
check(stub.calls.request.some(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-1'), 'subagent.list asked with the focused runtime id')

// 20. Terminal: the theme's tokens
{
  // Both palettes come from the app theme, so the panel follows the skin the user picked: the page mixes
  // the theme's foreground into its background for every neutral and takes the theme accent (held light
  // enough to read); the status-bar chip tints toward the accent. No colour literal anywhere.
  const hud = css.match(/\.sw-page\[data-theme=terminal\]\{--tm-acc:light-dark[^}]*\}/)?.[0] || ''
  const chip = css.match(/\.sw-sbw\[data-theme=terminal\]\{[^}]*\}/)?.[0] || ''
  check(/\.sw-page\[data-theme=terminal\]\{--a:var\(--tm-acc\)/.test(css) && /--tm-bg:transparent;--tm-raised:var\(--ui-bg-card\)/.test(hud) && /--tm-line:var\(--ui-stroke-tertiary\)/.test(hud) && /--hud-add:var\(--ui-diff-add-background\)/.test(hud)
    && /--tm-acc:light-dark\(oklch\(from var\(--ui-accent\)/.test(hud) && /--tm-bad:light-dark\(oklch\(from color-mix\(in srgb,var\(--ui-red\) 82%,var\(--ui-base\)\) min\(l,\.5\) c h\),color-mix\(in srgb,var\(--ui-red\)/.test(hud)
    && /--tm-run:light-dark\(oklch\(from color-mix\(in srgb,var\(--ui-yellow\) 82%,var\(--ui-base\)\) min\(l,\.5\) c h\),color-mix\(in srgb,var\(--ui-yellow\)/.test(hud)
    && /--tm-acc:color-mix\(in srgb,var\(--ui-accent\)/.test(chip) && /--tm-ok:color-mix\(in srgb,var\(--ui-green\)/.test(chip) && /--tm-bad:color-mix\(in srgb,var\(--ui-red\)/.test(chip)
    && !/#[0-9a-f]{3,8}\b/i.test(css),
    'Terminal: the page uses the app tokens as they are (see-through ground for the glass, translucent card, strokes, diff colours) and the chip tints from them — no literal anywhere')
}

check(/\.sw-page\[data-theme=terminal\]\{[^}]*--solid:var\(--dt-background\);[^}]*--pop:color-mix\(in srgb,var\(--ui-text-primary\) 7%,var\(--dt-background\)\)/.test(css)
  && /\.sw-menu\{[^}]*background:var\(--pop\)/.test(css) && (src.match(/bg: tok\('--solid'\)/g) || []).length === 2 && !/bg: tok\('--bg'\)/.test(src),
  'Terminal: a menu over the page and every canvas ground are opaque (the page ground is see-through, and a canvas reads it as black)')
check(/\.sw-page\{font-variant-emoji:text\}/.test(css), 'symbols draw as text, never as colour emoji')
check(!/(['"`])[▶⚠](?!\\uFE0E|\\\\FE0E)/.test(src), 'every ▶ and ⚠ the panel writes carries U+FE0E, so Windows never draws it as a colour emoji')
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
check(units().map(uname).join() === 'main,alpha-panel,beta-panel' && unitNamed('beta-panel')?.dataset.icon === 'stop'
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
  check(f.querySelector('.sw-hero .sw-verb')?.textContent === '✓ DONE' && f.querySelector('.sw-hero .sw-por')?.dataset.st === 'completed' && f.querySelector('.sw-hero .sw-ptag')?.textContent === '[OK ]'
    && f.querySelector('.sw-hero .sw-por .sw-pg')?.textContent === '✓' && f.querySelector('.sw-hero .sw-meta .sw-model'),
  `the hero: a portrait (its status glyph and tag), the verb line, the task as headline, where + model chip (${f.querySelector('.sw-verb')?.textContent})`)
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

// 9. Commands tab: a HUD — the picked command's CONSOLE, the COMMANDS list, the PROCESS card
await toTab('commands')
check(tab('commands')?.getAttribute('aria-selected') === 'true' && q('.sw-why')?.textContent.includes('not subagents'), 'the Commands tab says these are not subagents')
check(rest.includes('/processes?session_id=st-1'), 'background commands read for the stored chat id')
const prs = () => qa('.sw-cmrow')
const pressed = () => prs().filter(r => r.getAttribute('aria-pressed') === 'true')
const conTitle = () => q('.sw-cmcon .sw-hpt .sw-sr')?.textContent
check(prs().length === 4 && prs().map(p => p.dataset.st).join() === 'running,stopped,failed,completed', `newest command first, each with its status (${prs().map(p => p.dataset.st)})`)
check(prs().map(p => p.querySelector('.sw-cmls')?.textContent).join() === 'Running,Stopped,Failed,Finished' && prs().every(p => /\d\d:\d\d$/.test(p.querySelector('.sw-cmlt')?.textContent || '')),
  `every row: its start time and its status word (${prs().map(p => p.querySelector('.sw-cmls')?.textContent)})`)
check(prs()[3].querySelector('.sw-cmc')?.textContent === 'npm test' && prs()[3].querySelector('.sw-cmc')?.dataset.tip === 'npm test\n--watch=false',
  'row shows the first line, tooltip the whole command')
check(/exit 1/.test(prs()[2].querySelector('.sw-cmx')?.textContent || '') && !/exit/.test(prs()[3].querySelector('.sw-cmx')?.textContent || ''),
  'a failed command shows its exit code; a successful one no exit badge')
check(prs()[1].querySelector('.sw-cmx')?.textContent.endsWith('—') && !/\d+s$/.test(prs()[1].querySelector('.sw-cmx')?.textContent || ''), 'a stopped command shows — and no duration')
check(/1m 0[5-9]s$/.test(prs()[0].querySelector('.sw-cmx')?.textContent || ''), `running command counts its elapsed time (${prs()[0].querySelector('.sw-cmx')?.textContent})`)
check(prs()[3].querySelector('.sw-cmx')?.textContent.endsWith('42s'), 'finished command shows its duration')
check(q('.sw-pu')?.textContent === '1 record could not be read and is not listed', 'unreadable records are reported, not hidden')
check(q('.sw-cmcon')?.dataset.span === '6' && q('.sw-cmlp')?.dataset.span === '4' && q('.sw-cmcard')?.dataset.span === '2'
  && /\.sw-hp\[data-span="4"\]\{grid-column:span 4\}/.test([...document.querySelectorAll('style')].map(s => s.textContent).join(''))
  && q('.sw-cmlp .sw-hpt .sw-sr')?.textContent === 'Commands · 4' && q('.sw-cmcard .sw-hpt .sw-sr')?.textContent === 'Process',
  'the tab is a HUD: CONSOLE across the grid, COMMANDS (4 of 6 columns, counted) and PROCESS (2) below')
{
  const orb = q('.sw-cmorb'), calls = qa('.sw-cmorb .sw-orl')
  check(q('.sw-cmgrid')?.firstElementChild === orb && orb?.dataset.span === '6' && q('.sw-cmorb .sw-hpt .sw-sr')?.textContent === 'Orbit'
    && q('.sw-cmorb .sw-orbit > canvas.sw-orcv')?.getAttribute('aria-hidden') === 'true' && !q('.sw-cmorb .sw-orbit').classList.contains('has-scene')
    && /\.sw-cmorb:has\(\.sw-orbit:not\(\.has-scene\)\)[,{]/.test([...document.querySelectorAll('style')].map(s => s.textContent).join('')),
    'an ORBIT panel leads the tab across the grid, its canvas hidden from screen readers; without a 2D context it stays hidden')
  check(calls.length === 4 && calls.map(c => `${c.dataset.side}:${c.dataset.st}`).join() === 'l:running,l:failed,r:stopped,r:completed'
    && calls[0].getAttribute('aria-pressed') === 'true' && calls.filter(c => c.getAttribute('aria-pressed') === 'true').length === 1
    && calls[0].querySelector('.sw-orv')?.textContent.startsWith('RUNNING · 1m')
    && calls[2].querySelector('.sw-orv')?.textContent === 'STOPPED' && calls[3].querySelector('.sw-orv')?.textContent === 'FINISHED · 42s',
    `a callout per command, alternating sides, the picked one marked, its status and time (${calls.map(c => c.querySelector('.sw-orv')?.textContent)})`)
  check(q('.sw-cmorb .sw-ormain .sw-orn')?.textContent === '★ ORBIT · 1 IN FLIGHT' && q('.sw-cmorb .sw-orp b')?.textContent === '2/4'
    && qa('.sw-cmorb .sw-ortele[data-side=r] .sw-otl b').map(b => b.textContent).join() === '01,01,01',
    `the box counts the commands in flight and the ended ones; the readouts count running, failed, stopped (${q('.sw-cmorb .sw-ormain')?.textContent})`)
}
check(pressed().length === 1 && pressed()[0] === prs()[0] && conTitle() === 'Console · npm run dev',
  `with none picked, the console shows the newest command (${conTitle()})`)
check(q('.sw-cmcon .sw-cmnote')?.textContent === 'Still running — its output appears here when it finishes.' && !rest.some(p => p.startsWith('/process_output'))
  && q('.sw-cmcard .sw-radar') && !q('.sw-cmcard .sw-exit') && q('.sw-cmcon .sw-hchip')?.textContent === 'Running'
  && q('.sw-cmgauge .sw-col')?.textContent === 'RUNNING' && /^1m 0[5-9]s$/.test(q('.sw-cmgauge .sw-copn')?.textContent || '') && q('.sw-cmgauge .sw-cop.is-run'),
  `a running command: a radar, no output asked for yet and when it is shown, a RUNNING gauge with its time (${q('.sw-cmgauge')?.textContent})`)
{
  const bad = prs()[2]
  bad.focus()
  await act(async () => { bad.click() })
  await tick(5)
  check(bad.isConnected && document.activeElement === bad && pressed().length === 1 && pressed()[0] === bad, 'picking a command keeps focus on its row and marks only that row')
  await act(async () => { document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })) }) // focus inside the page holds its chat; let it go
}
check(rest.includes('/process_output?session_id=st-1&process_id=proc_bad'), 'picking a command reads its output for THIS chat')
check(qa('.sw-cmorb .sw-orl.is-sel').length === 1 && q('.sw-cmorb .sw-orl.is-sel')?.dataset.st === 'failed', 'the ORBIT marks the command picked in the list')
check(q('.sw-cmcon .sw-out')?.textContent === 'tail of proc_bad in st-1' && conTitle() === 'Console · python build.py'
  && q('.sw-cmcon .sw-hchip')?.dataset.st === 'failed' && q('.sw-cmcon .sw-hchip')?.textContent === 'exit 1',
  `the console shows the picked command: its output, its command in the title, its exit code on a status chip (${conTitle()})`)
check(q('.sw-cmcon .sw-hpn')?.textContent === 'python build.py' && q('.sw-cmcon .sw-hptv')?.textContent === 'CONSOLE · python build.py'
  && q('.sw-cmgauge .sw-col')?.textContent === 'FAILED',
  `run text in a HUD title keeps its case (a command is not capitalised); a failed command's gauge says FAILED (${q('.sw-cmcon .sw-hptv')?.textContent} / ${q('.sw-cmgauge .sw-col')?.textContent})`)
{
  const dd = qa('.sw-cmcard .sw-kv dd')
  check(qa('.sw-cmcard .sw-kv dt').map(d => d.textContent).join('|') === 'COMMAND|DIR|RAN|EXIT|LINES'
    && dd[0]?.querySelector('.sw-1l')?.textContent === 'FULL proc_bad' && dd[0]?.querySelector('.sw-1l')?.dataset.tip === 'FULL proc_bad'
    && dd[1]?.querySelector('.sw-1l')?.textContent === '/w' && dd[1]?.querySelector('.sw-1l')?.dataset.tip === '/w'
    && dd[2]?.textContent === '5s' && dd[4]?.textContent === '1'
    && q('.sw-cmcard .sw-exit')?.dataset.st === 'failed' && q('.sw-cmcard .sw-exit b')?.textContent === '1' && q('.sw-cmcard .sw-exit')?.getAttribute('aria-label') === 'exit 1',
    `the PROCESS card: the whole command and its folder on one line (full text in the tooltip), ran, the exit code on a status mark, lines (${dd.map(d => d.textContent).join(' | ')})`)
}
check(q('.sw-cmcon .sw-crt[data-state=output] .sw-ol')?.dataset.n === '1' && /1 line$/.test(q('.sw-cmcon .sw-crth')?.textContent || ''), 'the output: numbered lines under a header that counts them')
check(/last/.test(q('.sw-cmcon .sw-outl')?.textContent || ''), 'a cut output says it is the end only')
check(q('.sw-cmgauge .sw-col')?.textContent === 'FAILED' && q('.sw-cmgauge .sw-copn')?.textContent === '100%' && qa('.sw-cmgauge .sw-copb i.on').length === 10 && !q('.sw-cmfirst'),
  'a failed command that has ended: the FAILED gauge at 100%, no FIRST ERROR callout without an error line')
{
  const btn = label => qa('.sw-cmcard .sw-cmfoot .sw-ib').find(b => b.textContent === label)
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
await act(async () => { prs()[3].click() })
await tick(5)
procOutputFails = true
await quiet(async () => { await act(async () => { prs()[2].click() }); await tick(5) })
check(/Could not read its output: output 503/.test(q('.sw-cmcon .sw-cmerr[role=alert]')?.textContent || '') && q('.sw-cmerr .sw-ib')?.textContent === 'Try again'
  && q('.sw-cmerr .sw-crt[data-state=lost] .sw-nosig')?.textContent === 'NO SIGNAL' && !q('.sw-cmcard .sw-cmfoot .sw-ib[aria-label="Copy output"]'),
  'an unreadable output is an alert in the console: NO SIGNAL, the message, Try again; nothing to copy')
procOutputFails = false
await act(async () => { q('.sw-cmerr .sw-ib').click() })
await tick(5)
check(q('.sw-cmcon .sw-out')?.textContent === 'tail of proc_bad in st-1' && !q('.sw-cmerr'), 'Try again reads the output again')
{
  const outReads = rest.filter(p => p.startsWith('/process_output')).length
  await act(async () => { prs()[0].click() })
  await tick(5)
  check(q('.sw-cmcon .sw-hgrid[data-st=running] .sw-cmnote') && rest.filter(p => p.startsWith('/process_output')).length === outReads && qa('.sw-cmcon').length === 1 && pressed()[0] === prs()[0],
    'picking the running command again: one console, no output asked for')
}
{
  const release = hold('procout')
  await act(async () => { prs()[1].click() })
  await tick(5)
  check(q('.sw-cmcon .sw-hgrid[data-st=stopped] .sw-crt[data-state=reading][role=status] .sw-scan') && q('.sw-cmcon .sw-crth')?.textContent === 'Reading its output…' && !q('.sw-cmcon .sw-out'),
    'while its output is read: a scan bar and what is happening, never the last command\'s output')
  await act(async () => { release() })
  await tick(5)
  const lines = qa('.sw-cmcon .sw-ol')
  check(lines.map(l => l.dataset.n).join() === '1,2,3,4' && lines.map(l => l.classList.contains('is-bad')).join() === 'false,true,false,true' && /4 lines$/.test(q('.sw-cmcon .sw-crth')?.textContent || ''),
    `output lines are numbered and the error lines are highlighted (${lines.map(l => l.className).join()})`)
  const first = q('.sw-cmcon .sw-cmfirst')
  const target = first && q(`.sw-cmcon .sw-out [data-o="${first.dataset.to}"]`)
  check(first?.querySelector('.sw-col')?.textContent === 'FIRST ERROR' && first?.querySelector('.sw-cov')?.textContent === 'LINE 2' && target === q('.sw-cmcon .sw-ol.is-bad'),
    `the FIRST ERROR callout names the first failing line and its leader line has that row to point at (${first?.textContent} -> ${target?.textContent})`)
  check(q('.sw-cmcard .sw-exit b')?.textContent === '-15' && q('.sw-cmcard .sw-exit span')?.textContent === 'killed' && q('.sw-cmcard .sw-exit')?.getAttribute('aria-label') === 'killed'
    && q('.sw-cmcon .sw-hchip')?.textContent === 'killed' && q('.sw-cmgauge .sw-col')?.textContent === 'STOPPED' && !qa('.sw-cmgauge .sw-copb i.on').length,
    'a killed command says so on its exit mark, its chip and its gauge')
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
const liveNames = () => units().map(u => `${uname(u)}=${u.dataset.st}`).join(',')
check(liveNames() === 'main=running,one=running,one-a=running,two=failed,three=queued',
  `the live run: main agent first, a nested worker right after its parent, each in its own status (${liveNames()})`)
check(q('.sw-pick')?.textContent === 'Current run' && q('.sw-ld') && !q('.sw-panel')?.dataset.calm, 'a live run is the current run, with its live mark')
check(unitNamed('one')?.dataset.icon === 'run' && /running a command npm test/.test(unitNamed('one')?.dataset.tip || '') && unitNamed('three')?.dataset.icon === 'wait',
  `a running unit's icon is what it does now, its tooltip on what (${unitNamed('one')?.dataset.tip})`)
// run text is never laid out in full: a long command is one line with an ellipsis and a capped tooltip
{
  const longCmd = `python - <<'EOF' ${'s=s.replace(x, y) '.repeat(60)}EOF`
  await emit('subagent.tool', 'rt-1', { subagent_id: 's1', tool_name: 'terminal', tool_preview: longCmd })
  check((unitNamed('one')?.dataset.tip || '').length <= 2 * 300 + 1, `a unit's tooltip holds at most 300 characters of each run text (${(unitNamed('one')?.dataset.tip || '').length})`)
  await act(async () => { unitNamed('one').click() })
  const meta = q('.sw-focus .sw-meta .sw-metat')
  check(meta?.classList.contains('sw-1l') && meta.textContent.includes('running a command python') && (meta.dataset.tip || '').length === 300 && meta.dataset.tip.endsWith('…')
    && /\.sw-1l\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/.test(css) && !/\.sw-meta\{[^}]*overflow-wrap:anywhere/.test(css),
    `a focused subagent's status line is one line cut with an ellipsis; its tooltip holds the first 300 characters (${(meta?.dataset.tip || '').length})`)
  await act(async () => { units()[0].click() })
  await emit('subagent.tool', 'rt-1', { subagent_id: 's1', tool_name: 'terminal', tool_preview: 'npm test' })
}
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
  check(units().filter(u => uname(u) === 'one').length === 1, 'a live worker is not duplicated from state.db')
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
check(!q('.sw-orl.is-done, .sw-orl.is-fail, .sw-orw.is-done, .sw-orw.is-fail'), 'the moments end')

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

// 2. switching chats clears live state, shows the newest command again, selects the main agent
await emit('subagent.start', 'rt-1', { subagent_id: 'z1', delegation_id: 'dz', goal: "Do 'zed'" })
check(q('.sw-pick')?.textContent === 'Current run', 'live again before the switch')
await act(async () => { unitNamed('zed').click() })
await toTab('commands')
await act(async () => { prs()[1].click() })
check(pressed()[0] === prs()[1], 'another command is picked before the switch')
await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
check(rest.includes('/children?session_id=st-2') && rest.includes('/processes?session_id=st-2') && !prs().length && q('.sw-cmds .sw-empty')?.textContent === 'No background commands in this chat.',
  'history and commands re-read for the new chat; none -> it says so')
await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
await tick(10)
check(prs().length === 4 && pressed().length === 1 && pressed()[0] === prs()[0], 'switching chats shows the newest command again')
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
check(qa('.sw-err li').length && qa('.sw-err li').every(li => li.querySelector('.sw-1l')), 'each failed source is one line; a long error is cut, its text in the tooltip')
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
  pointer(q('.sw-cmrow'))
})
await tick(10)
check(!rest.slice(mark).some(p => p.includes('session_id=st-2')) && prs().length === 4, `a click inside the page keeps the watched chat (${rest.slice(mark).join(' ')})`)
check(q('.sw-held')?.textContent === '[held]' && /Click a chat/.test(q('.sw-held')?.dataset.tip || '') && q('.sw-held')?.tabIndex === 0, 'a held chat is marked as held in the header')
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
check(!rest.slice(mark).some(p => p.startsWith('/process_output')) && q('.sw-cmcon .sw-cmnote')?.textContent === 'No output was recorded.',
  'a command with no receipt asks for no output and says none was recorded')
check(/first 4000 characters/.test(q('.sw-cmcard .sw-cmcut')?.textContent || ''), `a cut command says it is cut (${q('.sw-cmcard .sw-cmcut')?.textContent})`)
{
  const cmd = q('.sw-cmcard .sw-kv dd .sw-1l')
  const row = prs()[1].querySelector('.sw-cmc')
  check(cmd?.textContent.length === 4000 && cmd?.dataset.tip.length === 300 && row?.dataset.tip.length === 300 && !q('.sw-cmds pre:not(.sw-out)'),
    `a long command stays on one line in the row and the card, its tooltip capped (${cmd?.dataset.tip.length} / ${row?.dataset.tip.length})`)
}
await act(async () => { prs()[0].click() })
await tick(5)
check(q('.sw-cmcon .sw-crt[data-state=quiet] .sw-quiet')?.textContent === '— IT PRINTED NOTHING —', 'a command that printed nothing says so')
await toTab('agents')

// 16c. live races: a queued worker before Hermes lists it, a stale snapshot after a complete, and
// the hand-off of a finished run to its stored copy.
const pollNow = async () => { await act(async () => { q('.sw-hd .sw-ib').click() }); await tick(5) }
stub.state.list['rt-4'] = []
await emit('subagent.spawn_requested', 'rt-4', { subagent_id: 'q1', goal: "Queue 'qa-one'", task_index: 0 })
await emit('subagent.spawn_requested', 'rt-4', { subagent_id: 'q2', goal: "Queue 'qa-two'", task_index: 1 })
await pollNow()
const subMarks = () => units().filter(u => !u.dataset.main).map(u => `${uname(u)}=${u.dataset.st}`).sort().join(',')
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
  const sel = q(`${NODE}[aria-pressed=true]`)
  check(q('.sw-pick')?.textContent === 'Last run' && subMarks() === 'qa-one=completed,qa-two=completed', 'the finished run stays as the last run, from its stored copy')
  check(sel && uname(sel) === 'qa-two' && q('.sw-focus')?.dataset.kind === 'sub', 'the subagent that was selected stays selected')
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
check(q('.sw-orbit') && !q('.sw-orw') && units().length === 1 && units()[0].dataset.main === 'true' && q('.sw-orbit .sw-nosub')?.textContent === 'Subagents appear here when the main agent hands work off to a helper.',
  'a chat with no subagents shows the main agent and says when subagents appear')
check(q('.sw-focus')?.dataset.kind === 'main' && q('.sw-focus [data-sec=none] .sw-empty')?.textContent === 'No files read or changed in this chat yet.' && !q('.sw-runb'),
  'its focus panel says no files yet; there is no run to pick')
check(q('.sw-score')?.getAttribute('aria-label') === 'No subagents yet', 'the score says there are none yet')
// 25. more live subagents than wings: five wings and a group, the main agent waiting on them
for (let i = 0; i < 12; i++) await emit('subagent.spawn_requested', 'rt-e', { subagent_id: `e${i}`, goal: `Spawn 'eq-${i}'`, task_index: i })
check(qa('.sw-orw').length === 6 && qa('.sw-orl:not(.is-grp)').length === 5 && q('.sw-orl.is-grp')?.getAttribute('aria-label') === '7 more subagents: 7 waiting'
  && q('.sw-orl.is-grp .sw-orn')?.textContent === '+7 MORE' && q('.sw-ormain')?.getAttribute('aria-label') === 'Main agent: waiting on 12',
  `past six subagents five wings and one holding the rest, the main agent waiting on them (${q('.sw-orl.is-grp')?.getAttribute('aria-label')} · ${q('.sw-ormain')?.getAttribute('aria-label')})`)
check(qa('.sw-htime .sw-tk').length === 6 && q('.sw-htime .sw-tmore')?.textContent === '+6 MORE · 0 DONE', `time per agent: as many tracks as wings, the rest counted (${q('.sw-htime .sw-tmore')?.textContent})`)

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
check(chipHost.querySelector('.sw-sbw')?.dataset.theme === 'terminal', 'the chip takes the look')
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
// replay: an edit and its time in words
{
  const at = new Date(2026, 9, 12, 15, 23).getTime() / 1000
  check(mod.fmtWhen(at, at + 60) === '15:23' && mod.fmtWhen(at - 86400, at) === 'Sun 15:23' && mod.fmtWhen(at - 6 * 86400, at) === 'Tue 15:23' && /^Oct 4 15:23$/.test(mod.fmtWhen(at - 8 * 86400, at)) && mod.fmtWhen(undefined, at) === '',
    `a time is the clock today, the weekday within a week, else the date — short enough for a list column (${mod.fmtWhen(at - 86400, at)} / ${mod.fmtWhen(at - 8 * 86400, at)})`)
  check(mod.stepSummary({ kind: 'diff', added: 1, removed: 2 }) === '+1 line added · −2 lines removed' && mod.stepSummary({ kind: 'whole', total: 7, added: 7 }) === 'Wrote the whole file · 7 lines'
    && mod.stepSummary({ kind: 'delete' }) === 'Deleted the file' && mod.stepSummary({ kind: 'diff', added: 0, removed: 0 }) === 'No lines changed',
    'replay: each edit says what it did in words: lines added and removed, a whole file, a delete')
}
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
  check(tiles === 'first to last file=28s|changed=2|edit failed=1|only read=2', `the main agent's stat tiles: first to last file, changed, edit failed, only read — no sum tile (${tiles})`)
  check(!fq('.sw-focus .sw-tile[style]') && fq('.sw-focus .sw-tile[data-k=failed]')?.dataset.tone === 'bad', 'the tiles carry no unlabelled share bar; a failed edit tile is red')
  check(fq('.sw-focus .sw-verb')?.textContent === '○ IDLE' && fq('.sw-focus .sw-ptag')?.textContent === 'main' && fq('.sw-focus .sw-por')?.dataset.st === 'idle',
    `an idle main agent's hero says so, tagged MAIN (${fq('.sw-focus .sw-verb')?.textContent})`)
}
{
  const kinds = fqa('.sw-hfiles .sw-fcells > i').map(i => i.dataset.k)
  const row = fqa('.sw-hfiles .sw-hrow b').map(b => b.textContent).join(' ')
  check(kinds.join() === 'changed,changed,failed,read,read' && row === 'CHANGED 2 READ 2'
    && fq('.sw-hfiles .sw-fcells')?.getAttribute('aria-label') === '2 changed, 1 failed, 2 only read',
    `FILES: one cell per file, grouped changed / failed / only read, counted and named for a screen reader (${kinds.join()} · ${row})`)
}
const note = fq('.sw-focus .sw-note')?.textContent || ''
check(/terminal commands or code runs are not listed/.test(note) && /Review › Last turn/.test(note), `the panel says what it cannot see and where every change is (${note})`)
check(sec('changed').map(r => r.querySelector('.sw-fn').textContent).join() === 'a.py,old.txt' && sec('failed').map(r => r.querySelector('.sw-fn').textContent).join() === 'README.md'
  && sec('read').map(r => r.querySelector('.sw-fn').textContent).join() === 'b.py,x.md'
  && fqa('.sw-focus .sw-fsec h4').map(h => h.textContent).join() === 'Changed,Edit failed,Only read',
  `the main agent's files: Changed (its edits, a delete), Edit failed, Only read — headings without counts, the tiles hold them (${sec('changed').length}/${sec('failed').length}/${sec('read').length})`)
check(rowOf('a.py')?.dataset.op === 'write' && rowOf('README.md')?.dataset.op === 'failed' && rowOf('old.txt')?.dataset.op === 'delete' && rowOf('b.py')?.dataset.op === 'read',
  'each file state is its own row kind: edited, failed, deleted, read only')
check(rowOf('a.py')?.querySelector('.sw-fl')?.textContent === '3 edits' && rowOf('README.md')?.querySelector('.sw-fl')?.textContent === '1 failed' && rowOf('old.txt')?.querySelector('.sw-fl')?.textContent === 'deleted',
  `a changed row says n edits / n failed / deleted (${rowOf('a.py')?.querySelector('.sw-fl')?.textContent})`)
check(rowOf('a.py')?.querySelector('.sw-pips')?.dataset.lit === '3' && rowOf('a.py')?.querySelectorAll('.sw-pips i').length === 8 && rowOf('a.py')?.querySelectorAll('.sw-pips i.on').length === 3
  && rowOf('README.md')?.querySelectorAll('.sw-pips i.on').length === 1 && !rowOf('old.txt')?.querySelector('.sw-pips') && rowOf('a.py')?.classList.contains('sw-ft'),
  'a changed file is a card: one lit block per edit out of 8, none for a delete')
check(!fq('.sw-focus .sw-leg'), 'no blocks legend: every row says its own count in words')
check(mod.pips(3) === 3 && mod.pips(8) === 8 && mod.pips(12) === 8 && mod.pips(0) === 0 && mod.pips(null) === 0, 'the blocks stop at 8')
check(rowOf('a.py')?.querySelector('.sw-fd')?.textContent === './src' && rowOf('README.md')?.querySelector('.sw-fd')?.textContent === 'chat folder'
  && /in …/.test(rowOf('x.md')?.getAttribute('aria-label') || '') && rowOf('x.md')?.dataset.tip.startsWith('C:/elsewhere')
  && rowOf('x.md')?.classList.contains('sw-ft') && rowOf('x.md')?.dataset.op === 'read' && rowOf('x.md')?.querySelector('.sw-fl')?.textContent === 'read ×1'
  && rowOf('x.md')?.querySelectorAll('.sw-pips i.on').length === 1 && rowOf('x.md')?.closest('.sw-fgrid')?.closest('[data-sec=read]'),
  'a card names its folder relative to the chat; an only-read file is a row like a changed one (one block per read); the full path is the tooltip')
check(/\.sw-page\[data-theme=terminal\] \.sw-ft\{display:grid;width:100%;/.test(css),
  'a Terminal file row fills the line (a button sizes to its content, so rows would not line up)')
{
  const fl = fq('.sw-focus .sw-flist')
  check(fl && fl.querySelectorAll(':scope > .sw-fsec').length >= 1 && !fq('.sw-focus .sw-fsec[data-sec=changed]:not(.sw-flist > *)')
    && /\.sw-page\[data-theme=terminal\] \.sw-flist\{display:grid;grid-template-columns:14px fit-content\(32ch\) minmax\(8ch,1fr\) 64px max-content max-content;/.test(css)
    && /\.sw-page \.sw-fd\{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;direction:rtl;/.test(css)
    && rowOf('a.py')?.querySelector('.sw-fd > bdi')?.textContent === './src'
    && /\.sw-page\[data-theme=terminal\] \.sw-flist>\.sw-fsec\{grid-column:1\/-1;display:grid;grid-template-columns:subgrid;/.test(css)
    && /\.sw-page\[data-theme=terminal\] \.sw-flist \.sw-fgrid\{display:grid;grid-template-columns:subgrid;/.test(css)
    && /\.sw-page\[data-theme=terminal\] \.sw-ft\{[^}]*grid-template-columns:subgrid/.test(css),
    `all Terminal file lists share one set of columns; the folder takes the spare width and is cut at its start, so its own name stays (${fl?.children.length} lists)`)
  check(/\.sw-page\[data-theme=terminal\] \.sw-fl\{margin-left:0;text-align:left\}/.test(css)
    && !/\.sw-page\[data-theme=terminal\] \.sw-fh \.sw-k::after/.test(css) && /\.sw-page\[data-theme=terminal\] \.sw-leg::before\{content:"·"/.test(css),
    'Terminal labels start in one column; the heading dot belongs to the legend, so Only read ends clean')
}
check(rowOf('a.py')?.getAttribute('aria-label') === 'a.py in ./src: 3 edits', `a row is named for a screen reader (${rowOf('a.py')?.getAttribute('aria-label')})`)
check(fqa('.sw-focus .sw-fnote').map(e => e.textContent).join('|') === '2 older files not listed|1 tool call could not be read',
  'unreadable calls and files past the list are said, never silently dropped')
await act(async () => { rowOf('b.py').click() })
await tick(2)
check(clip.at(-1) === 'D:\\Proj\\src\\b.py' && fq('.sw-toast')?.textContent === 'Path copied', `a row copies its full path (${fq('.sw-toast')?.textContent})`)
{
  const docs = [...fhost.querySelectorAll(NODE)].find(u => u.textContent.includes('docs-writer'))
  await act(async () => { docs.click() })
  check(fq('.sw-focus')?.dataset.kind === 'sub' && sec('changed').map(r => r.querySelector('.sw-fn').textContent).join() === 'a.py' && !sec('read').length
    && /changed 1 file/.test(fq('.sw-focus .sw-meta')?.textContent || ''),
  `a subagent's panel lists the files it changed, from /files who/editors (${fq('.sw-focus .sw-meta')?.textContent})`)
  const watchdog = [...fhost.querySelectorAll(NODE)].find(u => u.textContent.includes('wiki-watchdog'))
  await act(async () => { watchdog.click() })
  check(fq('.sw-focus .sw-verb')?.textContent === '✕ STOPPED WITH AN ERROR' && fq('.sw-focus .sw-ans')?.dataset.st === 'failed' && fq('.sw-focus .sw-tile[data-k=time]')?.dataset.tone === 'bad'
    && fq('.sw-focus .sw-head')?.textContent === "Watch the 'wiki-watchdog' panel",
  `a failed subagent: the verb says it stopped with an error, its answer and run time in red (${fq('.sw-focus .sw-verb')?.textContent})`)
  await act(async () => { fhost.querySelector(NODE).click() })
}
// working on now (1.6.0's shimmer): the main agent's live file calls
const filesReads = () => rest.filter(p => p === '/files?session_id=st-f').length
const nowRows = () => fqa('.sw-focus .sw-fr.is-now')
const nowNames = () => nowRows().map(r => r.querySelector('.sw-fn').textContent).join()
const mainUnit = () => fhost.querySelector(NODE)
await emit('tool.start', 'rt-other', { tool_id: 'x1', name: 'read_file', args: { path: 'D:\\Proj\\src\\b.py' } })
check(!nowRows().length, "another chat's tool call is not this chat's work")
await emit('tool.start', 'rt-f', { tool_id: 'm1', name: 'read_file', args: {}, preview: 'worker row' })
await emit('tool.start', 'rt-f', { tool_id: 'v1', name: 'patch', args: { mode: 'patch', path: 'src/b.py', patch: '*** Update File: D:/Proj/src/b.py' } })
check(!nowRows().length, 'a mirrored worker row and a V4A patch name no file')
await emit('tool.complete', 'rt-f', { tool_id: 'm1' })
await emit('tool.complete', 'rt-f', { tool_id: 'v1' })
await emit('tool.start', 'rt-f', { tool_id: 't1', name: 'read_file', args: { path: 'src/b.py' } })
check(nowNames() === 'b.py' && fq('.sw-focus .sw-head')?.textContent === 'b.py' && fq('.sw-focus .sw-verb')?.textContent === '▶\uFE0E READING NOW' && mainUnit()?.dataset.icon === 'read' && mainUnit()?.dataset.st === 'running',
  `a file call of the focused chat is the NOW card and the headline, the verb line reads (${fq('.sw-focus .sw-verb')?.textContent} ${fq('.sw-focus .sw-head')?.textContent})`)
check(sec('now')[0]?.classList.contains('is-now') && fq('.sw-focus [data-sec=now] h4')?.textContent === 'Working on now'
  && fq('.sw-focus [data-sec=now]')?.nextElementSibling?.dataset.sec !== 'now'
  && nowRows()[0]?.querySelector('.sw-nowb')?.textContent === 'NOW' && /worked on now/.test(nowRows()[0]?.getAttribute('aria-label') || ''),
  'the NOW card is its own block above the lists, badged NOW, and says so to a screen reader')
check(!sec('changed').some(r => r.querySelector('.sw-fn')?.textContent === 'b.py') && !sec('read').some(r => r.querySelector('.sw-fn')?.textContent === 'b.py'),
  'the file worked on now is in neither list below it')
{
  // rows shown + the "Show N more" rest, for each list: the file worked on now is in none of them
  const counts = ['changed', 'failed', 'read'].map(k => {
    const box = fq(`.sw-focus [data-sec=${k}]`)
    const more = Number(/(\d+)/.exec(box?.querySelector(':scope > .sw-more')?.textContent || '')?.[1] || 0)
    return box ? box.querySelectorAll('.sw-fr').length + more : 0
  })
  check(counts.join() === '2,1,1', `each list holds exactly its own rows while a file is worked on (${counts})`)
}
await emit('tool.start', 'rt-f', { tool_id: 't2', name: 'write_file', args: { path: 'D:/Proj/src/new.ts', content: 'x' } })
check(nowNames() === 'b.py,new.ts' && fq('.sw-focus .sw-head')?.textContent === 'new.ts' && fq('.sw-focus .sw-verb')?.textContent === '▶\uFE0E EDITING NOW' && rowOf('new.ts')?.dataset.op === 'active' && mainUnit()?.dataset.icon === 'edit',
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
  check(nowNames() === 'a.py' && !sec('changed').some(r => r.querySelector('.sw-fn')?.textContent === 'a.py') && sec('changed').map(r => r.querySelector('.sw-fn').textContent).join() === 'old.txt',
    `a changed file worked on now is shown once; Changed holds only the rest (${sec('changed').length})`)
}
await emit('tool.complete', 'rt-f', { tool_id: 't3', name: 'write_file' })
await tick(4100)
// 26. reduced motion turns every animation off; every moment exists
{
  const pageCss = mod.default && (fq('style')?.textContent || '')
  const animated = [...pageCss.matchAll(/([^{}]+)\{[^{}]*animation:(?!none)[^{}]*\}/g)].map(m => m[1].trim()).filter(s => !s.startsWith('@') && !/^\d|^from|^to/.test(s))
  check(/@media \(prefers-reduced-motion:reduce\)\{\.sw-page \*,\.sw-page \*::before,\.sw-page \*::after\{animation:none!important;transition:none!important\}\}/.test(pageCss)
    && animated.length > 5 && animated.every(s => s.split(',').every(one => /^\.sw-(page|panel|sk|ld|bign|nowf|fr|or)/.test(one.trim()) || /^\.sw-page /.test(one.trim()))),
  `reduced motion stops every page animation (${animated.length} animated rules, all inside the page)`)
  check(['sw-shake', 'sw-up', 'sw-slide', 'sw-orrun', 'sw-orfill', 'sw-orscan', 'sw-type', 'sw-blink', 'sw-count', 'sw-in', 'sw-sweep', 'sw-reveal', 'sw-scan'].every(k => new RegExp(`@keyframes ${k}\\{`).test(pageCss)),
    'the moments exist: shake, count up, slide, a wing\'s running cells, its fill when done, the station scan, retyped tag, cursor blink, tile count-up, cards in turn, NOW sweep, answer reveal, scan')
  check(['.sw-page .sw-tn[data-count]', '.sw-page .sw-ft', '.sw-page .sw-ft.is-now::after', '.sw-page .sw-ans', '.sw-page .sw-scan', '.sw-page .sw-radar'].every(sel => animated.includes(sel))
    && /@property --sw-n\{syntax:"<integer>"/.test(pageCss),
    'a panel opening moves: numbers count up, cards appear in turn, a light sweeps the NOW card, the answer reveals — all inside the reduced-motion lock')
}
{
  const st = fq('style')?.textContent || ''
  check(/\.sw-orbit\{position:relative;aspect-ratio:666\/360/.test(st) && /\.sw-ors\{position:absolute;inset:0;width:100%;height:100%/.test(st)
    && /@container \(max-width:540px\)\{[^@]*\.sw-orlead,\.sw-orpin,\.sw-orbox,\.sw-orkey\{display:none\}/.test(st)
    && /@container \(max-width:540px\)\{[^@]*\.sw-orl,\.sw-ormain,\.sw-orbit \.sw-nosub\{position:static/.test(st),
    'the orbit keeps the drawing\'s proportions; narrow, the callouts drop under it as a list without lines: nothing scrolls sideways')
  const orbit = fhost.querySelector('.sw-agents .sw-orbit')
  const wings = orbit ? [...orbit.querySelectorAll('.sw-orw')] : []
  const calls = orbit ? [...orbit.querySelectorAll('.sw-orl')] : []
  check(wings.length > 0 && calls.length === wings.length && orbit.querySelectorAll('.sw-orlead').length === wings.length + 1
    && orbit.querySelector('.sw-ormain')?.dataset.main === 'true',
    `the orbit: the main agent's box, a callout and a line tied to each subagent's wing (${wings.length} wings, ${calls.length} callouts)`)
  check(/@container \(max-width:460px\)\{\.sw-page\[data-theme=terminal\] \.sw-panel \.sw-flist\{grid-template-columns:14px fit-content\(22ch\) 0 39px max-content 0 1fr;/.test(st)
    && !/@container \(max-width:460px\)\{\.sw-page\[data-theme=terminal\][^@]*\.sw-pips(?! i)[^{]*\{display:none/.test(st) && !/\.sw-panel \.sw-ft\{grid-template-columns/.test(st),
    'a narrow Terminal file row keeps its name, thinner blocks and label on the shared columns; the folder and NOW badge give way')
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

// 25. the 40-subagent orbit: five wings for those that need eyes, the sixth holds the rest
await act(async () => { stub.atoms.focusedSessionId.set('rt-s'); stub.atoms.focusedStoredSessionId.set('st-swarm') })
await tick(10)
{
  const shown = fqa('.sw-orl:not(.is-grp)')
  check(fqa('.sw-orw').length === 6 && shown.length === 5 && shown.map(b => b.dataset.st).join() === 'failed,failed,failed,running,running'
    && fq('.sw-ormain')?.dataset.main === 'true',
    `40 subagents: six wings, the failed first, then working; a stopped one waits in the group (${shown.map(b => `${b.querySelector('.sw-orn')?.textContent}=${b.dataset.st}`)})`)
  const g = fq('.sw-orl.is-grp')
  const marks = g ? [...g.querySelectorAll('.sw-orm')].map(m => `${m.dataset.st}=${m.textContent}`).join() : ''
  check(g?.querySelector('.sw-orn')?.textContent === '+35 MORE' && marks === 'completed=20,running=4,queued=10,stopped=1' && g.getAttribute('aria-label') === '35 more subagents: 20 done, 4 working, 10 waiting, 1 stopped'
    && fqa('.sw-orw[data-st=group] .sw-orc').filter(c => c.dataset.k && c.dataset.k !== 'none').length === 16,
    `the group says how many it holds and a coloured mark with a count per state, never a word (${marks} · ${g?.getAttribute('aria-label')})`)
  for (const side of ['l', 'r']) {
    const tops = fqa(`.sw-orl[data-side=${side}]`).map(l => l.style.top)
    check(tops.length === 3 && new Set(tops).size === 3, `the three callouts of the ${side === 'l' ? 'left' : 'right'} column each have their own row (${tops.join(' ')})`)
  }
  check(fq('.sw-orw[data-st=group]') === fqa('.sw-orw')[5] && fq('.sw-orl.is-grp')?.dataset.side === 'l', `the group takes the outer wing, its callout on the left (${fq('.sw-orl.is-grp')?.dataset.side})`)
  check(fq('.sw-bign')?.textContent === '20' && fq('.sw-big small')?.textContent === '/40', 'the score: 20 of 40')
  await act(async () => { shown[3].click() })
  check(fq('.sw-focus')?.dataset.kind === 'sub' && fq('.sw-focus .sw-head')?.textContent === "Sweep 'unit-04'", 'a callout click selects it into the focus panel')
  check(fqa('.sw-alog > button').length === 40, 'every subagent stays in the log, which the station does not replace')
}
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
  } catch (err) { threw = err }
  check(!threw && el?.querySelector('.sw-page')?.dataset.theme === 'terminal' && el.querySelector('.sw-agents, .sw-hint, .sw-skel'),
    `a storage that throws reads as Terminal and the page still draws (${threw})`)
  if (r) await act(async () => r.unmount())
})
storageFails = false
for (const kept0 of ['nonsense', 'cockpit', 'dots', 'map']) {
  kept.set('theme', kept0)
  mod.default.register(quietCtx({}))
  const { el, r } = await mountFresh()
  check(el.querySelector('.sw-page')?.dataset.theme === 'terminal', `a kept '${kept0}' (not a look, or an earlier version's) reads as Terminal`)
  await act(async () => r.unmount())
}
mod.default.register(quietCtx({ storage: undefined }))
{
  const { el, r } = await mountFresh()
  check(el.querySelector('.sw-page')?.dataset.theme === 'terminal', 'no ctx.storage at all: Terminal')
  await act(async () => r.unmount())
}
// 27. the Replay tab: requests newest first, one edit at a time, lines read per edit for this chat only
{
  const NOWS = Date.now() / 1000
  const asked = []
  const st = (id, path, extra = {}) => ({ id, path, kind: 'diff', added: 1, removed: 1, at: NOWS - 60, who: '', tool: 'patch', cut: 0, failed: false, error: '', ...extra })
  const LIST = {
    session_id: 'st-1', cwd: 'D:/Proj', more_turns: 2, calls: 4, unreadable: 1,
    turns: [
      { id: 't1', at: NOWS - 100, files: 2, more_steps: 0, ask: 'fix the header', steps: [st('a#0', 'D:/Proj/src/a.py'), st('b#0', 'D:/Proj/src/b.py', { failed: true, error: 'no match', who: 'c-d' }), st('c#0', 'D:/Proj/notes.md', { kind: 'whole', added: 3, removed: 0, total: 3 })] },
      { id: 't0', at: NOWS - 5000, files: 1, more_steps: 0, ask: 'x'.repeat(500), steps: [st('z#0', 'D:/Proj/z.py')] }
    ]
  }
  const LINES = { 'a#0': [['@', '12'], [' ', 'keep'], ['-', 'old line'], ['+', 'new line typed out one key at a time']], 'b#0': [['-', 'p'], ['+', 'q']], 'c#0': Array.from({ length: 45 }, (_, i) => ['+', `line ${i}`]), 'z#0': [['+', 'z']] }
  const replayCtx = quietCtx({
    rest: async path => {
      if (path.startsWith('/replay_step')) {
        const q = new URLSearchParams(path.split('?')[1])
        asked.push([q.get('session_id'), q.get('step_id')])
        return { id: q.get('step_id'), lines: LINES[q.get('step_id')], cut: q.get('step_id') === 'c#0' ? 7 : 0 }
      }
      if (path.startsWith('/replay')) { asked.push([new URLSearchParams(path.split('?')[1]).get('session_id'), 'list']); return LIST }
      return ctx.rest(path)
    }
  })
  mod.default.register(replayCtx)
  await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
  const { el, r } = await mountFresh()
  const q = sel => el.querySelector(sel)
  const qa = sel => [...el.querySelectorAll(sel)]
  check(!asked.length, 'replay: nothing is read while the Replay tab is closed')
  await act(async () => { q('[role=tab][data-tab=replay]').click() })
  await tick(20)
  const rows = qa('.sw-rturn')
  check(rows.length === 2 && rows[0].getAttribute('aria-pressed') === 'true' && /3 edits · 2 files · 1 failed/.test(rows[0].textContent),
    `replay: requests newest first, the newest open, its edits and files counted in words (${rows[0]?.textContent})`)
  check(rows[1].querySelector('.sw-rask')?.classList.contains('sw-1l'), 'replay: a long request is one line with an ellipsis')
  check(q('.sw-rof')?.textContent === 'Edit 1 of 3' && qa('.sw-rl[data-tag="-"]').length === 1 && qa('.sw-rl[data-tag="+"]').length === 1
    && /from line 12/.test(q('.sw-rlines')?.textContent || ''),
    `replay: the first edit shows its removed and added lines and where they start (${q('.sw-rof')?.textContent})`)
  check(/\+1 line added · −1 line removed · by the main agent/.test(q('.sw-rwhat')?.textContent || ''), 'replay: an edit says in words what it did and who did it')
  check(asked.every(([sid]) => sid === 'st-1') && asked.some(([, id]) => id === 'a#0'), 'replay: the list and the edit are read for this chat')
  // the HUD: requests + six panels; titles drawn in caps (letters as written), read out as plain words
  check(qa('.sw-hp').length === 8 && qa('.sw-hpt').some(h => h.querySelector('[aria-hidden=true]')?.textContent === 'LINES SO FAR' && h.querySelector('.sw-sr')?.textContent === 'Lines so far'),
    `replay HUD: requests and seven panels (the wormhole first), each title in caps on screen and in plain words for a screen reader (${qa('.sw-hp').length})`)
  {
    const head = q('.sw-rlines .sw-rl[data-tag="@"]'), minus = q('.sw-rlines .sw-rl[data-tag="-"]')
    check(qa('.sw-rpart').length === 1 && head?.querySelector('.sw-rpart>span')?.textContent === '1 line replaced' && qa('.sw-rpart .sw-cov').map(e => e.textContent).join() === '−1,+1'
      && !q('.sw-replay .sw-cos') && !q('.sw-replay .sw-wires') && minus?.querySelector('.sw-rln')?.textContent === '13'
      && mod.diffNumbers([['@', '12'], [' ', 'k'], ['-', 'o'], ['+', 'n'], [' ', 'z']]).join() === ',12,13,13,14',
      `replay HUD: each part's header row says what it did (lines replaced) with its −/+ counts, no callout column beside the code; the gutter numbers each row (${head?.textContent})`)
    check(/\.sw-rlines\{[^}]*white-space:pre-wrap/.test(css) && /\.sw-rl\{display:flex;min-width:0;/.test(css) && /\.sw-rhero\.sw-hgrid>\.sw-rdiff\{margin-right:0\}/.test(css),
      'replay: the code takes the full width of the panel and wraps, so every line shows whole')
  }
  check(q('.sw-hbig')?.textContent === '2/ 5', `replay HUD: lines so far counts applied edits only, a failed edit adds nothing (${q('.sw-hbig')?.textContent})`)
  check(qa('.sw-hlog>button').length === 3 && qa('.sw-hlog>button')[1].dataset.st === 'failed' && qa('.sw-hlog .sw-hle').map(e => e.textContent).join() === 'EDIT,FAILED,WRITE'
    && qa('.sw-hlog>button')[0].getAttribute('aria-current') === 'step',
    `replay HUD: the log lists every edit with what it was, the current one marked (${qa('.sw-hlog .sw-hle').map(e => e.textContent)})`)
  {
    const order = qa('.sw-replay .sw-hp').map(p => p.classList.contains('sw-rworm') ? 'worm' : p.classList.contains('sw-rpb') ? 'play' : p.classList.contains('sw-rstep') ? 'file' : p.querySelector('.sw-hlog') ? 'log' : p.classList.contains('sw-hpx') ? 'diff' : p.classList.contains('sw-rturns') ? 'turns' : 'x')
    check(/worm,diff,play,x,x,file,log$/.test(order.join()) && q('.sw-rpb')?.dataset.span === '6' && q('.sw-hlog')?.closest('.sw-hp')?.dataset.span === '6' && !q('.sw-rstep .sw-rname'),
      `replay: the wormhole leads, the playback is a full-width strip under the diff, then lines / so far / file, then the log; the file panel does not repeat the diff's name (${order})`)
  }
  {
    const worm = q('.sw-rworm'), orb = worm?.querySelector('.sw-orbit'), calls = qa('.sw-rworm .sw-orl')
    check(worm?.dataset.span === '6' && worm.querySelector('.sw-hpt .sw-sr')?.textContent === 'Wormhole'
      && orb?.querySelector(':scope > canvas.sw-orcv')?.getAttribute('aria-hidden') === 'true' && !orb.classList.contains('has-scene')
      && /\.sw-cmorb:has\(\.sw-orbit:not\(\.has-scene\)\),\.sw-rworm:has\(\.sw-orbit:not\(\.has-scene\)\)\{display:none\}/.test(css),
      'replay: a WORMHOLE panel leads the edits, its canvas hidden from screen readers; without a 2D context it stays hidden')
    check(orb?.dataset.steps === '3' && orb.dataset.kinds === 'edit,failed,write' && orb.dataset.cur === '0' && orb.dataset.sizes.split(',')[1] === '0'
      && calls.length === 3 && calls.filter(c => c.getAttribute('aria-pressed') === 'true').length === 1 && calls.find(c => c.dataset.k === '0')?.classList.contains('is-sel')
      && calls.find(c => c.dataset.k === '1')?.querySelector('.sw-orv')?.textContent === 'FAILED' && /^EDIT · \+\d+ −\d+$/.test(calls.find(c => c.dataset.k === '0')?.querySelector('.sw-orv')?.textContent || ''),
      `replay: a ring per edit (what it did, how big; a failed one sized 0) and a callout each, the current one marked (${calls.map(c => c.querySelector('.sw-orv')?.textContent)})`)
    check(q('.sw-rworm .sw-ormain .sw-orn')?.textContent === '★ REPLAY · EDIT 1 OF 3' && q('.sw-rworm .sw-orp b')?.textContent === '1/3'
      && qa('.sw-rworm .sw-ortele[data-side=l] .sw-otl b').map(b => b.textContent).join() === '01,01,01',
      `replay: the box says which edit of how many; the readouts count edits, writes and failed ones (${q('.sw-rworm .sw-ormain')?.textContent})`)
    await act(async () => { calls.find(c => c.dataset.k === '2').click() })
    await tick(20)
    check(q('.sw-rof')?.textContent === 'Edit 3 of 3' && q('.sw-rworm .sw-orbit')?.dataset.cur === '2' && q('.sw-rworm .sw-orl.is-sel')?.dataset.k === '2',
      `replay: a wormhole callout opens its edit like a log row (${q('.sw-rof')?.textContent})`)
    await act(async () => { qa('.sw-hlog>button')[0].click() })
    await tick(20)
  }
  await act(async () => { qa('.sw-rbar .sw-ib').find(b => b.textContent === 'Next edit').click() })
  await tick(20)
  check(q('.sw-rof')?.textContent === 'Edit 2 of 3' && /This edit failed: no match/.test(q('.sw-rfail')?.textContent || '') && /by helper: docs-writer/.test(q('.sw-rwhat')?.textContent || ''),
    `replay: Next shows the failed edit, why it failed, and the helper by name (${q('.sw-rwhat')?.textContent})`)
  await act(async () => { qa('.sw-rmark')[2].click() })
  await tick(20)
  check(qa('.sw-rl[data-k]').length === 40 && q('.sw-rl[data-tag="@"] .sw-rpart>span')?.textContent === '40 lines added' && /Show the rest \(5 more lines\)/.test(q('.sw-rmore')?.textContent || '') && /7 more lines of this edit not loaded/.test(q('.sw-rdiff')?.textContent || ''),
    'replay: a long edit shows 40 lines and Show the rest; lines the backend cut are counted; a whole-file write still gets a header saying what it added')
  await act(async () => { q('.sw-rmore .sw-ib').click() })
  check(qa('.sw-rl[data-k]').length === 45, 'replay: Show the rest shows every line')
  await act(async () => { rows[1].click() })
  await tick(20)
  check(q('.sw-rof')?.textContent === 'Edit 1 of 1' && rows[1].getAttribute('aria-pressed') === 'true', 'replay: another request opens at its first edit')
  await act(async () => { rows[0].click() })
  await tick(20)
  const fullPlus = q('.sw-rl[data-tag="+"] .sw-rtext')?.textContent || ''
  await act(async () => { qa('.sw-rbar .sw-ib').find(b => b.textContent === 'Play').click() })
  await tick(20)
  {
    const plus = q('.sw-rlines[data-play=true] .sw-rl[data-tag="+"]'), minus = q('.sw-rlines[data-play=true] .sw-rl[data-tag="-"]')
    check(plus?.querySelector('.sw-rtext')?.textContent === '' && fullPlus.length > 4 && /ms$/.test(plus?.style.getPropertyValue('--d') || '') && /ms$/.test(minus?.style.getPropertyValue('--t') || '')
      && parseFloat(minus.style.getPropertyValue('--d')) < parseFloat(plus.style.getPropertyValue('--d'))
      && /\.sw-rlines\[data-play\] \.sw-rl\[data-cur\] \.sw-rtext::after\{content:"";[^}]*background:var\(--a\)/.test(css) && /\.sw-rlines\[data-play\] \.sw-rl\[data-tag="-"\] \.sw-rtext\{text-decoration:line-through;animation:sw-strike/.test(css),
      `replay: while Play runs the removed line is struck out first, then the added line is typed in behind a cursor (${qa('.sw-rlines .sw-rl').map(e => e.dataset.tag + (e.style.getPropertyValue('--d') || '·')).join(' ')})`)
    check(mod.wireScale(70, 100) === 0.7 && mod.wireScale(50, 0) === 1, 'leader lines convert screen pixels back to the scaled page (70 on screen / 100 laid out = 0.7)')
    const long = mod.typingPlan(Array.from({ length: 30 }, () => ['+', 'x'.repeat(60)]))
    check(mod.playHold([['+', 'b']]) === 1950 && mod.typingPlan([['+', 'a'], ['+', 'bb']]).plan[1].d === 1150 && long.plan[1].d - long.plan[0].d === 300 && mod.playHold(long.plan.map(() => ['+', 'x'])) <= 13000,
      'replay: Play types an added line every 0.9 s as in the draft (faster on a long edit so it ends near 9 s) and stays until the typing is done')
  }
  await tick(700)
  {
    const typed = q('.sw-rlines[data-play=true] .sw-rl[data-tag="+"] .sw-rtext')?.textContent || ''
    check(typed.length > 0 && typed.length < fullPlus.length && fullPlus.startsWith(typed),
      `replay: Play types an added line in letter by letter (${typed.length} of ${fullPlus.length} letters at 0.7 s)`)
    const row = q('.sw-rl[data-cur]')
    check(row?.dataset.tag === '+' && qa('.sw-rl[data-cur]').length === 1, 'replay: the row being typed carries the cursor, and only that row')
  }
  await tick(900)
  check(q('.sw-rof')?.textContent === 'Edit 1 of 3' && q('.sw-rl[data-tag="+"] .sw-rtext')?.textContent === fullPlus,
    `replay: Play stays on an edit until its line is typed whole (${q('.sw-rof')?.textContent})`)
  await tick(600)
  check(q('.sw-rof')?.textContent === 'Edit 2 of 3', `replay: Play steps on by itself once the edit is typed (${q('.sw-rof')?.textContent})`)
  check(q('.sw-rlines') && !q('.sw-rlines[data-play]'), 'replay: Play does not type in a failed edit — it was never applied')
  await act(async () => { qa('.sw-rbar .sw-ib').find(b => b.textContent === 'Pause').click() })
  await tick(1600)
  check(q('.sw-rof')?.textContent === 'Edit 2 of 3', 'replay: Pause stops it')
  check(!q('.sw-rlines[data-play]'), 'replay: paused, the edit stands still and whole')
  await act(async () => { qa('.sw-hlog>button')[2].click() })
  await act(async () => { await new Promise(res => setTimeout(res, 20)) })
  check(q('.sw-rof')?.textContent === 'Edit 3 of 3' && qa('.sw-hlog>button')[2].getAttribute('aria-current') === 'step', `replay HUD: a log row opens its edit (${q('.sw-rof')?.textContent})`)
  await act(async () => { rows[1].click() })
  await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
  await tick(20)
  check(qa('.sw-rturn')[0]?.getAttribute('aria-pressed') === 'true' && q('.sw-rof')?.textContent === 'Edit 1 of 3',
    'replay: another chat opens on its newest request, not the one picked in the last chat')
  check(/2 older requests with edits not listed/.test(el.textContent) && /1 edit could not be read/.test(el.textContent), 'replay: requests and edits left out are counted, never silently dropped')
  check(!el.querySelectorAll('[title]').length, 'replay: no native title= (the themed Tip owns hover text)')
  await act(async () => r.unmount())
  mod.default.register(quietCtx({}))
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
