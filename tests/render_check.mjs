/**
 * Subagent Watch — rendered in jsdom with the real React, driven like a user.
 *
 * Run: cd tests && npm install && node render_check.mjs      (exit 0 = passed)
 *
 * Locks:
 *   1. Registration: a `routes` page + a `sidebar.nav` entry with a resolved label; never a pane.
 *   2. Session scoping: only `subagent.*` events whose session_id is the FOCUSED runtime id land;
 *      `subagent.list` is called with that id; switching chats clears the live tree.
 *   3. Statuses: queued / running / completed / failed / stopped each draw their own mark; a queued
 *      or failed worker never draws the green "done" mark.
 *   4. Live tree: one root per delegation, nested children by parent_id, a merge node.
 *   5. History: batches newest first, collapsed; a batch opens to its workers; a worker opens a
 *      detail with its answer; a stopped worker shows "—" for time, never a duration.
 *   6. Copy reads /output for THAT worker's session id and writes the clipboard; open calls
 *      host.openSession with the child session id.
 *   7. Failures are visible: a failing history read and three failing list polls both render an
 *      alert; nothing is swallowed.
 *   8. A finished live batch leaves "Now" and history is reloaded.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE_URL = new URL('.', import.meta.url)
const HERE = fileURLToPath(HERE_URL).replace(/\\/g, '/')
const SRC = process.argv[2] || `${HERE}../desktop/plugin.js`
const OUT = `${HERE}.out/`
mkdirSync(OUT, { recursive: true })

writeFileSync(`${OUT}sdk-stub.mjs`, `
import { cloneElement, isValidElement, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

export const calls = { request: [], opened: [] }
export const state = { listFails: false, list: {} }

function atom(v) {
  const subs = new Set()
  return { get: () => v, set: n => { v = n; subs.forEach(f => f()) }, listen: f => { subs.add(f); return () => subs.delete(f) } }
}
export const atoms = { focusedSessionId: atom('rt-1'), focusedStoredSessionId: atom('st-1') }
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
    if (state.listFails) throw new Error('gateway down')
    return { subagents: state.list[params.session_id] || [] }
  },
  openSession: async sid => { calls.opened.push(sid) }
}
export default { host }
`)

const src = readFileSync(SRC, 'utf8').replace("'@hermes/plugin-sdk'", `'${HERE_URL.href}.out/sdk-stub.mjs'`)
writeFileSync(`${OUT}plugin-under-test.mjs`, src)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.IS_REACT_ACT_ENVIRONMENT = true

const stub = await import(`${HERE_URL.href}.out/sdk-stub.mjs`)
const mod = await import(`${HERE_URL.href}.out/plugin-under-test.mjs`)
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')

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
const HISTORY = {
  session_id: 'st-1',
  batches: [
    {
      started_at: 1000,
      workers: [
        { session_id: 'c-a', goal: "Polish 'alpha-panel' visuals", status: 'completed', duration_s: 312, tool_calls: 40, tokens: 120000, summary: 'Alpha answer paragraph.' },
        { session_id: 'c-b', goal: "Polish 'beta-panel' visuals", status: 'stopped', duration_s: null, tool_calls: 12, tokens: 9000, summary: '' }
      ]
    },
    {
      started_at: 2000,
      workers: [{ session_id: 'c-c', goal: 'Act as a strict design judge\nmore', status: 'completed', duration_s: 45, tool_calls: 3, tokens: 800, summary: 'Judge verdict.' }]
    }
  ]
}
const ctx = {
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
      if (historyFails) throw new Error('backend 503')
      return HISTORY
    }
    if (path.startsWith('/output')) return { text: `FULL OUTPUT of ${new URLSearchParams(path.split('?')[1]).get('session_id')}` }
    throw new Error(`unexpected ${path}`)
  },
  os: { writeClipboard: async text => { clip.push(text); return true } }
}
const emit = (type, session_id, payload) => act(() => { for (const fn of listeners.get(type) || []) fn({ type, session_id, payload }) })

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
check(mod.modelLabel('anthropic/claude-opus-5-5') === 'claude-opus-5-5', 'model label drops the provider')
check(mod.batchState(['completed', 'queued']) === 'queued' && mod.batchState(['completed', 'failed']) === 'failed', 'batch state never reads done while one is not')

// mount
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => { root.render(React.createElement(route.render)) })
await tick(10)
const q = s => host.querySelector(s)
const qa = s => [...host.querySelectorAll(s)]

// 5. history
const bls = qa('.sw-bl')
check(bls.length === 2, `two history batches drawn (${bls.length})`)
check(qa('.sw-hd .sw-stat').map(e => e.textContent).join(',') === '2,3', `header counts batches and workers (${qa('.sw-hd .sw-stat').map(e => e.textContent)})`)
check(bls[0].textContent.includes('design judge') || bls[0].textContent.includes('Act as a strict'), 'newest batch first')
check(stub.calls.request.some(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-1'), 'subagent.list asked with the focused runtime id')
await act(async () => { bls[1].click() })
const rows = qa('.sw-wr')
check(rows.length === 2, 'batch opens to its two workers')
check(rows[1].textContent.includes('—') && !/\d+[smh]/.test(rows[1].querySelector('.sw-wt').textContent), 'stopped worker shows — and no duration')
check(rows[1].querySelector('.sw-mk').dataset.st === 'stopped', 'stopped worker draws the stopped mark')
await act(async () => { rows[0].click() })
check(q('.sw-dt') && !q('.sw-dt p') && /tokens/.test(q('.sw-dtm')?.textContent || ''), 'worker detail is actions + stats only, no answer text')
check(q('.sw-dtg')?.textContent === "Polish 'alpha-panel' visuals" && q('.sw-dt').firstElementChild?.classList.contains('sw-dtg'), 'worker detail shows its goal above the actions')
check(!rows[0].querySelector('.sw-goal'), 'history row has no goal line')

// 6. copy + open
const [copyBtn, openBtn] = qa('.sw-dt .sw-ib')
await act(async () => { copyBtn.click() })
await tick(5)
check(rest.includes('/output?session_id=c-a') && clip[0] === 'FULL OUTPUT of c-a', 'copy reads that worker\'s full output into the clipboard')
await act(async () => { openBtn.click() })
check(stub.calls.opened[0] === 'c-a', 'open goes to the child session')

// 6b. cards open independently: opening another batch and worker folds nothing
await act(async () => { qa('.sw-wr')[1].click() })
check(qa('.sw-dt').length === 2, 'opening a second worker keeps the first one open')
await act(async () => { qa('.sw-bl')[0].click() })
check(qa('.sw-bb').length === 2 && qa('.sw-dt').length === 2, 'opening another batch keeps the first batch and its workers open')

// 2 + 3 + 4. live tree, scoped
await emit('subagent.spawn_requested', 'rt-OTHER', { subagent_id: 'x1', delegation_id: 'd9', goal: 'foreign', task_index: 0 })
check(!q('.sw-fl'), 'events from another chat are ignored')
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's1', delegation_id: 'd1', goal: "Build 'one'", task_index: 0 })
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's2', delegation_id: 'd1', goal: "Build 'two'", task_index: 1 })
await emit('subagent.spawn_requested', 'rt-1', { subagent_id: 's3', delegation_id: 'd1', goal: "Build 'three'", task_index: 2 })
await emit('subagent.start', 'rt-1', { subagent_id: 's1', delegation_id: 'd1', goal: "Build 'one'", child_session_id: 'k1', model: 'anthropic/claude-opus-5-5' })
await emit('subagent.start', 'rt-1', { subagent_id: 's1a', parent_id: 's1', delegation_id: 'd1', goal: "Nested 'one-a'", depth: 1 })
await emit('subagent.tool', 'rt-1', { subagent_id: 's1', tool_name: 'terminal', tool_preview: 'npm test' })
await emit('subagent.complete', 'rt-1', { subagent_id: 's2', status: 'error', summary: 'boom', duration_seconds: 12 })
stub.state.list['rt-1'] = [
  { subagent_id: 's1', delegation_id: 'd1', status: 'running', goal: "Build 'one'" },
  { subagent_id: 's1a', parent_id: 's1', delegation_id: 'd1', status: 'running', goal: "Nested 'one-a'" },
  { subagent_id: 's3', delegation_id: 'd1', status: 'queued', goal: "Build 'three'" }
]
await tick(3100) // let one subagent.list poll reconcile the tree (wire status -> mark mapping)
check(qa('.sw-fl').length === 1, 'one live root per delegation')
HISTORY.batches.push({ started_at: 3000, workers: [{ session_id: 'k9', goal: "Build 'one'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' }] })
await act(async () => q('.sw-hd .sw-ib').click())
await tick(10)
check(qa('.sw-bl').length === 2, 'a stored batch still running is not repeated under Earlier while live')
HISTORY.batches.pop()
const nodes = qa('.sw-fl .sw-nd')
const byName = n => nodes.find(x => x.querySelector('.sw-wn').textContent === n)
check(nodes.length === 4, `four live nodes incl. the nested one (${nodes.length})`)
check(byName('one-a')?.closest('.sw-sub') !== null, 'nested worker sits under its parent')
check(byName('one')?.querySelector('.sw-mk').dataset.st === 'running', 'running mark')
check(byName('one')?.querySelector('.sw-model')?.textContent === 'claude-opus-5-5', 'live node shows its model')
check(!byName('one')?.querySelector('.sw-goal'), 'live node has no goal line')
check(byName('three')?.querySelector('.sw-mk').dataset.st === 'queued' && byName('three').textContent.includes('waiting'), 'queued is queued, not done')
check(byName('two')?.querySelector('.sw-mk').dataset.st === 'failed', 'failed is red, not done')
check(byName('one')?.querySelector('.sw-now')?.textContent === 'terminal', 'running node shows its current tool')
check(q('.sw-merge')?.textContent.includes('waiting for workers'), 'merge node waits')
check(q('.sw-pill')?.textContent.includes('2 running'), 'header counts running workers')

// 8. finishing the batch moves it out of "Now" and reloads history
const before = rest.filter(p => p.startsWith('/children')).length
stub.state.list['rt-1'] = []
for (const id of ['s1', 's1a', 's3']) await emit('subagent.complete', 'rt-1', { subagent_id: id, status: 'completed' })
await tick(10)
check(!q('.sw-fl'), 'finished batch leaves Now')
check(rest.filter(p => p.startsWith('/children')).length > before, 'history reloaded when a batch finishes')

// 2. switching chats clears live state
await emit('subagent.start', 'rt-1', { subagent_id: 'z1', delegation_id: 'dz', goal: 'z' })
check(!!q('.sw-fl'), 'live again before the switch')
await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
check(!q('.sw-fl'), 'switching chats clears the live tree')
check(rest.includes('/children?session_id=st-2'), 'history re-read for the new chat')

// 7. failures are visible
historyFails = true
stub.state.listFails = true
await act(async () => { stub.atoms.focusedSessionId.set('rt-3'); stub.atoms.focusedStoredSessionId.set('st-3') })
await tick(20)
check(q('[role=alert]')?.textContent.includes('Could not read earlier batches: backend 503'), 'history failure is shown')
const origWarn = console.warn
console.warn = () => {}
for (let i = 0; i < 3; i++) await tick(3100)
console.warn = origWarn
check(q('[role=alert]')?.textContent.includes('Live updates stopped'), 'three failed polls are shown')

// empty chat
historyFails = false
stub.state.listFails = false
await act(async () => { stub.atoms.focusedSessionId.set(null); stub.atoms.focusedStoredSessionId.set(null) })
await tick(10)
check(q('[data-slot=panel-empty]')?.textContent.includes('No chat selected'), 'no chat -> empty state')

await act(async () => root.unmount())
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
