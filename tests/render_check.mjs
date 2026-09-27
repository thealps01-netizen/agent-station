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
 *  10. Refresh after live polls gave up resets the failure count and polling resumes.
 *  11. A clipboard rejection on either copy button is a "Copy failed" toast, never an unhandled rejection.
 *  12. Status marks and header counts carry an aria-label (the Tip's text); counts whose source
 *      failed read "—", not 0; count labels are singular for one.
 *  13. Round 2: a crashed running batch stays under Earlier; a chat switch drops the old chat's
 *      errors; a finished batch still listed is not re-added; commands show a loader; a batch of
 *      several workers says "+N more"; copy has a busy state; headings, focus rings, focusable
 *      tooltip triggers, reading tokens, a mounted live region; shared-prefix names stay distinct.
 *  14. Round 4: a worker's model chip shows the model and its reasoning effort, never shrinks to a
 *      stub (the name ellipsizes), and its tooltip names the full model id and effort.
 *   9. Background commands: read for the STORED chat id, newest first, one mark per status, exit
 *      code on a failed row, "—" for a stopped one; a row opens the full command + output tail read
 *      for that chat; a running command asks for no output; unreadable records and a failed read
 *      are shown; a chat with no commands draws no section.
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
  'st-2': []
}
const deepFreeze = o => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
const HISTORY = {
  session_id: 'st-1',
  batches: [
    {
      started_at: 1000,
      workers: [
        { session_id: 'c-a', goal: "Polish 'alpha-panel' visuals", model: 'anthropic/claude-opus-5-5', effort: 'medium', status: 'completed', duration_s: 312, tool_calls: 40, tokens: 120000, summary: 'Alpha answer paragraph.' },
        { session_id: 'c-b', goal: "Polish 'beta-panel' visuals", model: 'claude-opus-5-5', effort: null, status: 'stopped', duration_s: null, tool_calls: 12, tokens: 9000, summary: '' }
      ]
    },
    {
      started_at: 2000,
      workers: [{ session_id: 'c-c', goal: 'Act as a strict design judge\nmore', status: 'completed', duration_s: 45, tool_calls: 3, tokens: 800, summary: 'Judge verdict.' }]
    }
  ]
}
// Shared fixtures are frozen: a scenario that needs other data sets `extraBatches` instead.
deepFreeze(HISTORY)
deepFreeze(PROCS)
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
      if (holds.children) await holds.children
      if (historyFails) throw new Error('backend 503')
      return { ...HISTORY, batches: [...HISTORY.batches, ...extraBatches] }
    }
    if (path.startsWith('/output')) {
      if (holds.output) await holds.output
      const q = new URLSearchParams(path.split('?')[1])
      return { text: `FULL OUTPUT of ${q.get('worker_id')} for ${q.get('session_id')}` }
    }
    if (path.startsWith('/processes')) {
      if (holds.processes) await holds.processes
      if (procFails) throw new Error('procs 503')
      const sid = new URLSearchParams(path.split('?')[1]).get('session_id')
      return { session_id: sid, processes: PROCS[sid] || [], unreadable: sid === 'st-1' ? procUnreadable : 0 }
    }
    if (path.startsWith('/process_output')) {
      if (procOutputFails) throw new Error('output 503')
      const q = new URLSearchParams(path.split('?')[1])
      return { id: q.get('process_id'), command: `FULL ${q.get('process_id')}`, output: `tail of ${q.get('process_id')} in ${q.get('session_id')}`, output_truncated: true }
    }
    throw new Error(`unexpected ${path}`)
  },
  os: { writeClipboard: async text => { if (clipRejects) throw new Error('denied'); clip.push(text); return true } }
}
// async act: an event can start a history reload whose promise settles after the handler returns;
// a sync act would let that state update land outside act and React would warn.
const emit = (type, session_id, payload) => act(async () => { for (const fn of listeners.get(type) || []) fn({ type, session_id, payload }) })

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
check(tr('sw.nBatches', 1) === '1 batch' && tr('sw.nBatches', 2) === '2 batches', `batch count is singular for one (${tr('sw.nBatches', 1)})`)
check(tr('sw.nProcs', 1) === '1 background command' && tr('sw.nProcs', 3) === '3 background commands', `command count is singular for one (${tr('sw.nProcs', 1)})`)
check(tr('sw.nWorkers', 1) === '1 worker' && tr('sw.nWorkers', 2) === '2 workers', `worker count is singular for one (${tr('sw.nWorkers', 1)})`)

// mount
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => { root.render(React.createElement(route.render)) })
await tick(10)
const q = s => host.querySelector(s)
const qa = s => [...host.querySelectorAll(s)]

// 5. history
const bls = qa('.sw-hb')
check(bls.length === 2, `two history batches drawn (${bls.length})`)
check(qa('.sw-hd .sw-stat').map(e => e.textContent).join(',') === '2,3,4', `header counts batches, workers and commands (${qa('.sw-hd .sw-stat').map(e => e.textContent)})`)
check(bls[0].textContent.includes('design judge') || bls[0].textContent.includes('Act as a strict'), 'newest batch first')
check(bls[1].querySelector('.sw-bn')?.textContent === 'alpha-panel' && bls[1].querySelector('.sw-bmore')?.textContent === '+1 more',
  `a batch of several workers is not labelled as its first worker alone (${bls[1].querySelector('.sw-bn')?.textContent} ${bls[1].querySelector('.sw-bmore')?.textContent})`)
check(!bls[0].querySelector('.sw-bmore'), 'a one-worker batch carries no "+N more"')
check(q('h2.sw-ht')?.textContent === 'Subagents' && qa('h3.sw-lab').map(e => e.textContent).join('|').includes('Earlier'),
  `the title and section labels are headings (${qa('h2, h3').map(e => e.tagName + ':' + e.textContent).join('|')})`)
const css = q('style')?.textContent || ''
for (const cls of ['sw-ib', 'sw-bl', 'sw-nd', 'sw-more']) {
  check(new RegExp(`\\.${cls}:focus-visible[^{]*\\{[^}]*outline:\\s*2px`).test(css) || new RegExp(`\\.${cls}:focus-visible[\\s\\S]*?\\{[^}]*outline:\\s*2px`).test(css),
    `.${cls} draws a visible focus ring (the app removes every ring)`)
}
check(qa('[data-tip]').filter(e => !e.closest('button')).every(e => e.tabIndex === 0),
  `every tooltip trigger outside a button is focusable (${qa('[data-tip]').filter(e => !e.closest('button') && e.tabIndex !== 0).map(e => e.className)})`)
check(!/var\(--ui-text-tertiary\)/.test(css.match(/\.sw-bc,\.sw-bt,\.sw-wt\{[^}]*\}/)?.[0] || 'var(--ui-text-tertiary)')
  && !/--ui-text-tertiary/.test(css.match(/\.sw-now\{[^}]*\}/)?.[0] || '--ui-text-tertiary') && !/--ui-text-tertiary/.test(css.match(/\.sw-model\{[^}]*\}/)?.[0] || '--ui-text-tertiary'),
  'times, counts, tool and model chips use a reading token (tertiary measured 4.0-4.2:1 < 4.5)')
check(!/font(-size)?:\s*(10(\.\d+)?|11)px/.test(css), `no text below 11.5px (${(css.match(/font(-size)?:\s*(10(\.\d+)?|11)px/g) || []).join(' ')})`)
check(/\.sw-fw \.sw-acc::after\{display:none\}/.test(css) && /\.sw-fw \.sw-acc\{box-shadow:none\}/.test(css),
  'rows inside a frame drop their own rail and lift: one accent per frame')
check(!qa('.sw-mk[data-st=completed] path, .sw-mk[data-st=failed] path').some(e => /destructive/.test(e.getAttribute('stroke') || '')),
  'the check and cross marks are not inked with the destructive token')
check(q('.sw-live[role=status]') !== null && !q('.sw-live').textContent, 'the toast live region is mounted before any toast (so it is announced)')
check(stub.calls.request.some(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-1'), 'subagent.list asked with the focused runtime id')
check(qa('.sw-hd .sw-stat').every(e => e.getAttribute('aria-label') && e.getAttribute('aria-label') === e.dataset.tip),
  `header counts carry an aria-label equal to their tooltip (${qa('.sw-hd .sw-stat').map(e => e.getAttribute('aria-label'))})`)
await act(async () => { bls[1].click() })
const rows = qa('.sw-wr')
check(rows.length === 2, 'batch opens to its two workers')
check(rows[1].textContent.includes('—') && !/\d+[smh]/.test(rows[1].querySelector('.sw-wt').textContent), 'stopped worker shows — and no duration')
check(rows[1].querySelector('.sw-mk').dataset.st === 'stopped', 'stopped worker draws the stopped mark')
// M3: the chip shows the model with its reasoning effort, never a stub, and names both in its tooltip.
const chip0 = rows[0].querySelector('.sw-model'), chip1 = rows[1].querySelector('.sw-model')
check(chip0?.textContent === 'claude-opus-5-5 · medium', `an Earlier worker's chip shows model and effort (${chip0?.textContent})`)
check(chip1?.textContent === 'claude-opus-5-5', `a worker without an effort shows the model alone (${chip1?.textContent})`)
check(/anthropic\/claude-opus-5-5/.test(chip0?.dataset.tip || '') && /medium/.test(chip0?.dataset.tip || ''),
  `the chip's tooltip names the full model id and the effort (${chip0?.dataset.tip})`)
const modelRule = css.match(/\.sw-model\{[^}]*\}/)?.[0] || ''
const nameRule = css.match(/\.sw-wn\{[^}]*\}/)?.[0] || ''
check(/flex:0 0 auto/.test(modelRule) && !/text-overflow:ellipsis/.test(modelRule)
  && /text-overflow:ellipsis/.test(nameRule) && /min-width:0/.test(nameRule),
  `the model chip never shrinks to a stub; the worker name takes the ellipsis (${modelRule})`)
check(/@container \(max-width:420px\)\{[^}]*\.sw-model/.test(css), 'the chip is still hidden below 420 px')
await act(async () => { rows[0].click() })
check(q('.sw-dt') && !q('.sw-dt p') && /tokens/.test(q('.sw-dtm')?.textContent || ''), 'worker detail is actions + stats only, no answer text')
check(q('.sw-dtg')?.textContent === "Polish 'alpha-panel' visuals" && q('.sw-dt').firstElementChild?.querySelector('.sw-dtg') !== null, 'worker detail shows its goal above the actions')
check([...q('.sw-dt').children].every(c => c.classList.contains('sw-br')), 'every piece of an opened detail hangs on its own tree branch, no outer frame')
check(!rows[0].querySelector('.sw-goal'), 'history row has no goal line')

// 9. background commands: listed for the stored chat, marked by status, detail reads the output
check(rest.includes('/processes?session_id=st-1'), 'background commands read for the stored chat id')
const prs = qa('.sw-pr')
check(prs.length === 4, `four background commands drawn (${prs.length})`)
check(prs[0].dataset.st === 'running' && prs.map(p => p.dataset.st).join(',') === 'running,stopped,failed,completed', `newest command first (${prs.map(p => p.dataset.st)})`)
check(prs.map(p => p.querySelector('.sw-mk').dataset.st).join(',') === 'running,stopped,failed,completed', 'each command draws its own status mark')
check(qa('.sw-mk').length > 0 && qa('.sw-mk').every(m => m.getAttribute('role') === 'img' && m.getAttribute('aria-label') && m.getAttribute('aria-label') === m.dataset.tip),
  'every status mark has an accessible name equal to its tooltip')
check(prs[3].querySelector('.sw-pn').textContent === 'npm test' && prs[3].querySelector('.sw-pn').dataset.tip === 'npm test\n--watch=false', 'row shows the first line, tooltip the whole command')
check(prs[2].querySelector('.sw-px')?.textContent === 'exit 1', 'failed command shows its exit code')
check(!prs[3].querySelector('.sw-px'), 'a successful command shows no exit badge')
check(prs[1].querySelector('.sw-wt').textContent === '—', 'a stopped command shows — and no duration')
check(/^1m 0[5-9]s$/.test(prs[0].querySelector('.sw-wt').textContent), `running command counts its elapsed time (${prs[0].querySelector('.sw-wt').textContent})`)
check(prs[3].querySelector('.sw-wt').textContent === '42s', 'finished command shows its duration')
check(qa('.sw-hd .sw-stat')[2]?.textContent === '4', 'header counts background commands')
check(q('.sw-pu')?.textContent === '1 record could not be read', 'unreadable records are reported, not hidden')
check(q('.sw-plt')?.dataset.tip?.includes('not subagents'), 'section says these are not subagents')
// An opened command is re-drawn as a framed box, so each click finds the row afresh.
const pr = i => qa('.sw-pr')[i]
await act(async () => { pr(2).click() })
await tick(5)
check(rest.includes('/process_output?session_id=st-1&process_id=proc_bad'), 'opening a command reads its output for THIS chat')
check(q('.sw-po')?.textContent === 'tail of proc_bad in st-1' && q('.sw-pc')?.textContent === 'FULL proc_bad', 'detail shows the full command and the output tail')
check(q('.sw-pol')?.textContent.includes('last'), 'a cut output says it is the end only')
await act(async () => { q('.sw-plist .sw-box .sw-ib').click() })
await tick(5)
check(clip.at(-1) === 'FULL proc_bad', 'copy command copies the full command')
clipRejects = true
let unhandled = 0
const onUnhandled = () => { unhandled++ }
process.on('unhandledRejection', onUnhandled)
await act(async () => { q('.sw-plist .sw-box .sw-ib').click() })
await tick(5)
check(q('.sw-toast.is-bad')?.textContent === 'Copy failed' && !unhandled, `a rejected clipboard on copy command toasts "Copy failed" (${q('.sw-toast')?.textContent}, unhandled ${unhandled})`)
clipRejects = false
// A failed output read is shown inside the opened row, never swallowed into an empty box.
await act(async () => { pr(2).click() })
procOutputFails = true
await act(async () => { pr(2).click() })
await tick(5)
check(q('.sw-plist')?.textContent.includes('Could not read the command output: output 503'), 'a failed command-output read is shown')
procOutputFails = false
await act(async () => { pr(2).click() })
await act(async () => { pr(2).click() })
await tick(5)
const outReads = rest.filter(p => p.startsWith('/process_output')).length
check(q('.sw-plist > .sw-box.sw-frame > .sw-bh.sw-pr') && [...q('.sw-plist > .sw-box > .sw-fw').children].every(c => c.firstElementChild?.classList.contains('sw-leaf')),
  'an opened command is laid out like an opened batch: framed box, header as root, pieces on the rail')
await act(async () => { qa('.sw-pr')[0].click() })
await tick(5)
check(q('.sw-po-note')?.textContent.includes('when the command finishes') && rest.filter(p => p.startsWith('/process_output')).length === outReads, 'a running command asks for no output yet')
const procPolls = rest.filter(p => p.startsWith('/processes')).length
await tick(3100)
check(rest.filter(p => p.startsWith('/processes')).length > procPolls, 'background commands are polled')

// 6. copy + open
const [copyBtn, openBtn] = qa('.sw-bb .sw-dt .sw-ib')
const releaseOut = hold('output')
await act(async () => { copyBtn.click() })
await tick(5)
check(copyBtn.getAttribute('aria-busy') === 'true' && copyBtn.getAttribute('aria-label') === 'Copying…' && copyBtn.disabled,
  `copy shows a busy state while it reads (${copyBtn.getAttribute('aria-label')}, busy ${copyBtn.getAttribute('aria-busy')})`)
await act(async () => { releaseOut() })
await tick(5)
check(copyBtn.getAttribute('aria-label') === 'Copy full output' && copyBtn.getAttribute('aria-busy') !== 'true', 'copy leaves its busy state when done')
check(rest.includes('/output?session_id=st-1&worker_id=c-a') && clip.at(-1) === 'FULL OUTPUT of c-a for st-1', 'copy reads that worker\'s full output, for THIS chat, into the clipboard')
clipRejects = true
await act(async () => { copyBtn.click() })
await tick(5)
check(q('.sw-toast.is-bad')?.textContent === 'Copy failed' && !unhandled, `a rejected clipboard on copy output toasts "Copy failed" (${q('.sw-toast')?.textContent})`)
clipRejects = false
process.off('unhandledRejection', onUnhandled)
await act(async () => { openBtn.click() })
check(stub.calls.opened[0] === 'c-a', 'open goes to the child session')

// 6b. cards open independently: opening another batch and worker folds nothing
await act(async () => { qa('.sw-wr')[1].click() })
check(qa('.sw-bb .sw-dt').length === 2, 'opening a second worker keeps the first one open')
await act(async () => { qa('.sw-hb')[0].click() })
check(qa('.sw-box:not(:has(.sw-pr)) > .sw-bb').length === 2 && qa('.sw-bb .sw-dt').length === 2, 'opening another batch keeps the first batch and its workers open')

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
const liveStart = Date.now() / 1000
extraBatches = [{ started_at: liveStart - 1, workers: [{ session_id: 'k9', goal: "Build 'one'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' }] }]
await act(async () => q('.sw-hd .sw-ib').click())
await tick(10)
check(qa('.sw-hb').length === 2, 'a stored batch still running is not repeated under Earlier while live')
// Its finished workers are gone from subagent.list, so the live tree must take them from state.db.
extraBatches = [{ started_at: liveStart - 1, workers: [
  { session_id: 'k9', goal: "Build 'one'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' },
  { session_id: 'k10', goal: "Build 'done-early'", status: 'completed', duration_s: 40, tool_calls: 3, tokens: 0, summary: 'ok' }
] }]
await act(async () => q('.sw-hd .sw-ib').click())
await tick(10)
check(qa('.sw-fl .sw-nd').some(n => n.textContent.includes('done-early') && n.querySelector('.sw-mk').dataset.st === 'completed'),
  'a worker that finished before the rest stays in the live tree, done')
check(!qa('.sw-hb').some(b => b.textContent.includes('done-early')), 'that finished worker is not also under Earlier')
check(!qa('.sw-fl .sw-nd').some(n => n.textContent.includes("Build 'one'") && n.dataset.st === 'completed'), 'a live worker is not duplicated from state.db')
// A stored batch that still reads running but started long before the live tree is not the live
// tree (a crashed run, or another generation): it stays under Earlier.
extraBatches = [{ started_at: 3000, workers: [{ session_id: 'k8', goal: "Old 'crashed-run'", status: 'running', duration_s: null, tool_calls: 0, tokens: 0, summary: '' }] }]
await act(async () => q('.sw-hd .sw-ib').click())
await tick(10)
check(qa('.sw-hb').length === 3 && qa('.sw-hb').some(b => b.textContent.includes('crashed-run')),
  `a running stored batch that is not the live one stays under Earlier (${qa('.sw-hb').length})`)
extraBatches = []
await act(async () => q('.sw-hd .sw-ib').click())
await tick(10)
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
// The backend can still list a finished batch's workers for a while: they must not come back.
stub.state.list['rt-1'] = ['s1', 's1a', 's3'].map(id => ({ subagent_id: id, delegation_id: 'd1', status: 'completed', goal: id }))
const settled = rest.filter(p => p.startsWith('/children')).length
await tick(3100)
await tick(3100)
check(!q('.sw-fl') && rest.filter(p => p.startsWith('/children')).length === settled,
  `a finished batch still listed by subagent.list is not re-added nor reloaded again (${settled} -> ${rest.filter(p => p.startsWith('/children')).length})`)
stub.state.list['rt-1'] = []

// 2. switching chats clears live state
await emit('subagent.start', 'rt-1', { subagent_id: 'z1', delegation_id: 'dz', goal: 'z' })
check(!!q('.sw-fl'), 'live again before the switch')
if (!q('.sw-pr.is-open')) await act(async () => { qa('.sw-pr')[1].click() })
check(qa('.sw-pr.is-open').length > 0, 'a card is open before the switch')
await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
check(!q('.sw-fl'), 'switching chats clears the live tree')
// Back to the first chat: the cards opened there must come back folded, not as the old chat left them.
await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
await tick(10)
check(qa('.sw-pr').length > 0 && !qa('.sw-acc.is-open, .sw-pr.is-open, .sw-box').length, 'switching chats folds every open card')
await act(async () => { stub.atoms.focusedSessionId.set('rt-2'); stub.atoms.focusedStoredSessionId.set('st-2') })
await tick(10)
check(rest.includes('/children?session_id=st-2'), 'history re-read for the new chat')
check(rest.includes('/processes?session_id=st-2') && !qa('.sw-pr').length && !q('.sw-procs'), 'commands re-read for the new chat; none -> no section')

// 7. failures are visible
historyFails = true
stub.state.listFails = true
procFails = true
await act(async () => { stub.atoms.focusedSessionId.set('rt-3'); stub.atoms.focusedStoredSessionId.set('st-3') })
await tick(20)
check(q('[role=alert]')?.textContent.includes('Could not read earlier batches: backend 503'), 'history failure is shown')
check(q('[role=alert]')?.textContent.includes('Could not read background commands: procs 503'), 'background command failure is shown')
const origWarn = console.warn
console.warn = () => {}
for (let i = 0; i < 3; i++) await tick(3100)
console.warn = origWarn
check(q('[role=alert]')?.textContent.includes('Live updates stopped'), 'three failed polls are shown')
const stats = qa('.sw-hd .sw-stat')
check(stats.map(e => e.textContent).join(',') === '—,—,—' && stats.every(e => /could not be read/.test(e.getAttribute('aria-label') || '')),
  `counts whose source failed read — , not 0 (${stats.map(e => e.textContent)})`)
check(/Refresh/.test(q('.sw-bd')?.textContent || ''), `the all-failed view says what to do, not a blank body (${q('.sw-bd')?.textContent})`)

// 10. Refresh restarts live polling that gave up
stub.state.listFails = false
const listCalls = () => stub.calls.request.filter(([m, p]) => m === 'subagent.list' && p.session_id === 'rt-3').length
const gaveUp = listCalls()
await tick(3100)
check(listCalls() === gaveUp, 'polling has stopped after three failures')
await act(async () => q('.sw-hd .sw-ib').click())
await tick(3100)
check(listCalls() > gaveUp && !q('[role=alert]')?.textContent.includes('Live updates stopped'), `Refresh resumes live polling (${gaveUp} -> ${listCalls()})`)

// Switching from a failing chat to a healthy one: the old chat's error must not ride along while
// the new chat's reads are still in flight; the commands section shows it is loading.
historyFails = false
procFails = false
const releaseChildren = hold('children')
const releaseProcs = hold('processes')
await act(async () => { stub.atoms.focusedSessionId.set('rt-1'); stub.atoms.focusedStoredSessionId.set('st-1') })
await tick(10)
check(!(q('[role=alert]')?.textContent || '').includes('earlier batches'), `a chat switch drops the previous chat's history error (${q('[role=alert]')?.textContent})`)
check(!(q('[role=alert]')?.textContent || '').includes('background commands'), 'a chat switch drops the previous chat\'s command error')
await act(async () => { releaseChildren() })
await tick(10)
check(q('.sw-procs [data-slot=loader]') !== null, 'background commands show a loading state while their first read is pending')
await act(async () => { releaseProcs() })
await tick(10)
check(!q('.sw-procs [data-slot=loader]') && qa('.sw-pr').length === 4, 'the loading state gives way to the commands')

// empty chat
historyFails = false
stub.state.listFails = false
procFails = false
await act(async () => { stub.atoms.focusedSessionId.set(null); stub.atoms.focusedStoredSessionId.set(null) })
await tick(10)
check(q('[data-slot=panel-empty]')?.textContent.includes('No chat selected'), 'no chat -> empty state')

await act(async () => root.unmount())
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
