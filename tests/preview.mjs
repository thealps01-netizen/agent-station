/**
 * Static preview of Agent Station — look at the page without restarting the app.
 *
 * Run: cd tests && node render_check.mjs && node preview.mjs      (writes preview.html, exit 0 = ok)
 *
 * It draws the ELEVEN SCREENS of the approved design in the Terminal look, in jsdom with the real React — the page's REAL output, never a hand-drawn mock — through
 * the same SDK stub the render check writes (`.out/sdk-stub.mjs`):
 *    1. Live, the main agent selected: what it works on now, its changed and read files.
 *    2. A failed subagent selected: task, answer, files, buttons; a copy shows its toast.
 *    3. The run picker open: this run and the earlier ones.
 *    4. An earlier run open: calm, with Back to now.
 *    5. The Commands tab with a failed command picked: its CONSOLE (output, FINISHED gauge, FIRST ERROR
 *       callout on its line), the COMMANDS list and the PROCESS card.
 *    6. The console's other states: still running, unreadable and printed nothing (narrow).
 *    7. A chat with no subagents yet: the main agent and its files.
 *    8. No chat selected · loading · several sources failing (three frames).
 *    9. Narrow (380 px): units wrap into rows, nothing scrolls sideways.
 *   10. The status-bar chip.
 *   11. 40 subagents: the grouped swarm (failed by name, working, waiting, done).
 *   12. The Replay tab: a request's edits, one open as removed / added lines; a failed edit; narrow.
 *
 * Every frame carries `data-screen` and `data-look`; this script exits 1 when a screen is missing in
 * either look, and shot.cjs re-checks the same in the real engine (a missing screen is RED).
 *
 * STYLES: the application's OWN COMPILED stylesheet (`apps/desktop/dist/assets/index-*.css`, newest
 * build) carries the theme — light and dark blocks both — so nothing is copied from another repo.
 * The page runs in `html.dark` with the seeds `applyTheme()` hands in inline. A missing build is
 * reported as "app stylesheet NOT FOUND" and does NOT fail the run; the picture is then unstyled.
 *
 * Exit 1: a raw `sw.*` key on screen, a native `title=` in any frame, a missing screen or look.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { DESKTOP_APP } from './env.mjs'

const HERE_URL = new URL('.', import.meta.url)
const HERE = fileURLToPath(HERE_URL).replace(/\\/g, '/')
const STUB = `${HERE_URL.href}.out/sdk-stub.mjs`
const SRC = `${HERE}../desktop/plugin.js`
export const SCREENS = 12
export const LOOKS = ['terminal']

try {
  readFileSync(`${HERE}.out/sdk-stub.mjs`, 'utf8')
} catch (e) {
  console.error('.out/sdk-stub.mjs is missing — run `node render_check.mjs` once (it writes the stub)')
  process.exit(1)
}
writeFileSync(`${HERE}.out/plugin-preview.mjs`, readFileSync(SRC, 'utf8').replace("'@hermes/plugin-sdk'", `'${STUB}'`))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = React
const { createRoot } = await import('react-dom/client')
const stub = await import(STUB)
const mod = await import(`${HERE_URL.href}.out/plugin-preview.mjs`)

const NOW = Date.now() / 1000
const HISTORY = {
  session_id: 'st-1',
  title: 'Panel polish pass',
  batches: [
    {
      started_at: NOW - 5400,
      workers: [
        { session_id: 'c-a', goal: "Audit 'fleet-routing' against the kit", model: 'anthropic/claude-opus-5-5', effort: 'medium', status: 'completed', duration_s: 312, tool_calls: 40, tokens: 120000, cost_usd: 1.62, cost_status: 'estimated', summary: 'Routing matches the kit; two spacing fixes applied.' },
        { session_id: 'c-b', goal: "Audit 'fleet-status' against the kit", model: 'anthropic/claude-opus-5-5', status: 'stopped', duration_s: null, tool_calls: 12, tokens: 9000, cost_usd: 0.31, cost_status: 'estimated', summary: '' }
      ]
    },
    {
      started_at: NOW - 1800,
      workers: [
        { session_id: 'c-c', goal: "Write the 'wiki-watchdog' changelog", model: 'openai/gpt-5.2', status: 'completed', duration_s: 45, tool_calls: 3, tokens: 800, cost_usd: 0, cost_status: 'included', summary: 'Changelog written.' }
      ]
    },
    // The last run: with nothing running it is the run shown.
    {
      started_at: NOW - 600,
      workers: [
        { session_id: 'c-d', goal: "Review 'desktop-panel' layout", model: 'anthropic/claude-opus-5-5', effort: 'high', status: 'completed', duration_s: 184, tool_calls: 22, tokens: 60000, cost_usd: 0.74, cost_status: 'estimated', summary: 'Layout reviewed; the header wraps at 380 px.' },
        { session_id: 'c-e', goal: "Measure 'contrast' of every label", model: 'anthropic/claude-sonnet-5', status: 'completed', duration_s: 97, tool_calls: 9, tokens: 21000, cost_usd: 0.12, cost_status: 'estimated', summary: 'Every label is at or above 4.5:1.' },
        { session_id: 'c-f', goal: "Fix 'render-check' fixtures", model: 'openai/gpt-5.2', status: 'failed', duration_s: 41, tool_calls: 6, tokens: 9000, cost_usd: 0, cost_status: 'included', summary: "Cannot find module './sdk-stub.mjs'." }
      ]
    }
  ]
}
// 40 subagents in one run, for the swarm.
const SWARM_NAMES = ['atlas', 'beacon', 'cinder', 'delta', 'ember', 'fable', 'garnet', 'harbor', 'ivory', 'jasper', 'kestrel', 'lumen', 'meridian', 'nimbus', 'onyx', 'pylon',
  'quarry', 'raven', 'sable', 'tundra', 'umber', 'vertex', 'willow', 'xenon', 'yarrow', 'zephyr', 'aster', 'birch', 'cobalt', 'dune', 'elm', 'flint', 'gale', 'heron', 'iris', 'juniper',
  'kelp', 'larch', 'moss', 'nova']
// The backend lists commands oldest first; the page shows the newest first.
const PROCS = [
  { id: 'proc_kill', command: 'sleep 999', cwd: 'C:/work/panel', status: 'stopped', started_at: NOW - 3000, duration_s: 100, exit_code: -15 },
  { id: 'proc_bad', command: 'node build.mjs --release', cwd: 'C:/work/panel', status: 'failed', started_at: NOW - 1200, duration_s: 5, exit_code: 1 },
  { id: 'proc_ok', command: 'python -m pytest tests/ -q --maxfail=1 --durations=10 --basetemp=C:/Users/someone/AppData/Local/hermes/cache/scratch/pytest', cwd: 'C:/Users/someone/AppData/Local/hermes/plugins/agent-station/tests', status: 'completed', started_at: NOW - 900, duration_s: 42, exit_code: 0 },
  { id: 'proc_run', command: 'npm run dev -- --port 5174', cwd: 'C:/work/panel', status: 'running', started_at: NOW - 95, duration_s: null, exit_code: null }
]
// Screen 6: one command per open state.
const PROCS6 = [
  { id: 'proc_quiet', command: 'git fetch --quiet', cwd: 'C:/work/panel', status: 'completed', started_at: NOW - 500, duration_s: 2, exit_code: 0 },
  { id: 'proc_lost', command: 'node migrate.mjs', cwd: 'C:/work/panel', status: 'failed', started_at: NOW - 400, duration_s: 3, exit_code: 2 },
  { id: 'proc_slow', command: 'npm run lint', cwd: 'C:/work/panel', status: 'completed', started_at: NOW - 300, duration_s: 18, exit_code: 0 },
  { id: 'proc_run', command: 'npm run dev -- --port 5174', cwd: 'C:/work/panel', status: 'running', started_at: NOW - 95, duration_s: null, exit_code: null }
]
// Who touched each file, as the backend names them: '' the chat, else a worker's session id. The
// live run's agents are k1-k3, the stored last run's c-d..c-f.
const filesFor = live => {
  const w = live ? { a: 'k1', b: 'k2', c: 'k1a' } : { a: 'c-d', b: 'c-e', c: 'c-f' }
  const who = (...ks) => ks.map(k => (k ? w[k] : ''))
  const sets = [[who('a', ''), who('a', '')], [who('c', 'b'), []], [who('b', 'a', ''), []], [who(''), who('')], [who(''), who('')], [who('b', ''), []]]
  return { ...FILES, files: FILES.files.map((f, i) => ({ ...f, who: sets[i][0], editors: sets[i][1] })) }
}
const FILES = {
  session_id: 'st-1', cwd: 'C:/work/panel', unreadable: 0, more: 0,
  files: [
    { key: 'c:/work/panel/desktop/plugin.js', path: 'C:/work/panel/desktop/plugin.js', reads: 6, writes: 4, deletes: 0, failed: 0, last_op: 'write', last_failed: false, first_at: NOW - 1500, last_at: NOW - 30 },
    { key: 'c:/work/panel/tests/render_check.mjs', path: 'C:/work/panel/tests/render_check.mjs', reads: 2, writes: 1, deletes: 0, failed: 1, last_op: 'write', last_failed: true, last_at: NOW - 60 },
    { key: 'c:/work/panel/dashboard/plugin_api.py', path: 'C:/work/panel/dashboard/plugin_api.py', reads: 3, writes: 0, deletes: 0, failed: 0, last_op: 'read', last_failed: false, last_at: NOW - 120 },
    { key: 'c:/work/panel/changelog.md', path: 'C:/work/panel/CHANGELOG.md', reads: 1, writes: 2, deletes: 0, failed: 0, last_op: 'write', last_failed: false, last_at: NOW - 400 },
    { key: 'c:/work/panel/old-notes.md', path: 'C:/work/panel/old-notes.md', reads: 0, writes: 0, deletes: 1, failed: 0, last_op: 'delete', last_failed: false, last_at: NOW - 600 },
    { key: 'c:/users/someone/appdata/local/hermes/hermes-agent/apps/desktop/src/sdk/index.ts', path: 'C:/Users/someone/AppData/Local/hermes/hermes-agent/apps/desktop/src/sdk/index.ts', reads: 2, writes: 0, deletes: 0, failed: 0, last_op: 'read', last_failed: false, last_at: NOW - 700 }
  ]
}
// Screen 12: the chat's edits under the user's requests, newest first, as GET /replay answers.
const step = (id, path, kind, added, removed, at, extra = {}) => ({ id, path, kind, added, removed, at, who: '', tool: kind === 'whole' ? 'write_file' : 'patch', cut: 0, failed: false, error: '', ...extra })
const REPLAY = {
  session_id: 'st-1', cwd: 'C:/work/panel', more_turns: 0, calls: 9, unreadable: 0,
  turns: [
    {
      id: 't2', at: NOW - 900, files: 3, more_steps: 0,
      ask: 'the header wraps at 380 px and the long command pushes the panel wider, fix both and keep the copy button where it is',
      steps: [
        step('c1#0', 'C:/work/panel/desktop/plugin.js', 'diff', 3, 2, NOW - 880),
        step('c2#0', 'C:/work/panel/tests/render_check.mjs', 'diff', 1, 1, NOW - 860, { failed: true, error: "Could not find a match for old_string in 'tests/render_check.mjs'" }),
        step('c3#0', 'C:/work/panel/tests/render_check.mjs', 'diff', 6, 0, NOW - 840, { who: 'c-f' }),
        step('c4#0', 'C:/work/panel/CHANGELOG.md', 'whole', 7, 0, NOW - 820, { total: 7 })
      ]
    },
    { id: 't1', at: NOW - 5000, files: 1, more_steps: 0, ask: 'add a copy button', steps: [step('c0#0', 'C:/work/panel/desktop/plugin.js', 'diff', 4, 1, NOW - 4980)] },
    { id: 't-', at: null, files: 1, more_steps: 0, ask: '', steps: [step('cz#0', 'C:/work/panel/notes.md', 'whole', 2, 0, NOW - 90000, { total: 2 })] }
  ]
}
const REPLAY_LINES = {
  'c1#0': [['@', '412'], [' ', 'function Header({ t, chatName }) {'], [' ', "  return jsxs('header', {"], ['-', "    className: 'sw-hd',"], ['-', "    children: [jsx('h2', { children: t('title') }), chatName]"],
    ['+', "    className: 'sw-hd sw-wrap',"], ['+', "    children: [jsx('h2', { className: 'sw-ht', children: t('title') }), jsx(OneLine, { text: chatName })],"], ['+', "    'data-narrow': narrow ? 'true' : undefined"], [' ', '  })'], [' ', '}']],
  'c2#0': [['@', ''], ['-', "  expect(q('.sw-hd').className).toBe('sw-hd')"], ['+', "  expect(q('.sw-hd').className).toBe('sw-hd sw-wrap')"]],
  'c3#0': [['@', '88'], [' ', "test('header', () => {"], ['+', "  render({ width: 380 })"], ['+', "  expect(q('.sw-hd').scrollWidth).toBeLessThanOrEqual(380)"], ['+', "  const cmd = q('.sw-cmd')"], ['+', '  expect(cmd.scrollWidth).toBeGreaterThan(cmd.clientWidth)'], ['+', "  expect(getComputedStyle(cmd).whiteSpace).toBe('nowrap')"], ['+', "  expect(q('.sw-copy')).toBeTruthy()"], [' ', '})']],
  'c4#0': ['## 1.7.1', '', '- The header no longer wraps at 380 px.', '- A long command stays on one line and scrolls inside its box.', '- The copy button keeps its place.', '', '## 1.7.0'].map(l => ['+', l]),
  'c0#0': [['@', '600'], ['-', "  jsx('pre', { children: command })"], ['+', "  jsxs('div', { children: ["], ['+', "    jsx('pre', { children: command }),"], ['+', "    jsx(IconButton, { label: t('copyCommand') })"], ['+', '  ] })']],
  'cz#0': [['+', '# notes'], ['+', 'header: check 380 px']]
}
const OUTPUT = 'building 14 entries…\nerror: Cannot find module \'./sdk-stub.mjs\'\n    at build.mjs:41:9\nexit 1'
const NEVER = new Promise(() => {})

function makeCtx(look, { fail = false, live = false, empty = false, loading = false, procs = PROCS } = {}) {
  const listeners = new Map()
  const registered = []
  const ctx = {
    storage: { get: (key, fallback) => (key === 'theme' ? look : fallback), set: () => {}, remove: () => {} },
    register: c => { registered.push(c); return () => {} },
    i18n: { register: b => stub.registerBundles('agent-station', b), t: k => k },
    onEvent: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      return () => listeners.get(type).delete(fn)
    },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h) },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
    rest: async path => {
      if (path.startsWith('/children') && loading) return NEVER
      if (fail) {
        if (path.startsWith('/files')) return { ...FILES, files: [] }
        throw new Error(path.startsWith('/children') ? 'backend 503: state.db not found' : 'backend 503: processes.json unreadable')
      }
      if (path.startsWith('/children')) return empty ? { session_id: 'st-1', title: 'Quick question', batches: [] } : HISTORY
      if (path.startsWith('/processes')) return { session_id: 'st-1', processes: procs, unreadable: 1 }
      if (path.startsWith('/files')) return filesFor(live)
      if (path.startsWith('/process_output')) {
        const id = new URLSearchParams(path.split('?')[1]).get('process_id')
        if (id === 'proc_slow') return NEVER
        if (id === 'proc_lost') throw new Error('receipt unreadable: Expecting value: line 1 column 1')
        const p = procs.find(x => x.id === id)
        return { id, command: p.command, output: id === 'proc_bad' ? OUTPUT : id === 'proc_quiet' ? '' : '12 passed in 41.8s', output_truncated: false }
      }
      if (path.startsWith('/output')) return { text: 'answer' }
      if (path.startsWith('/replay_step')) {
        const id = new URLSearchParams(path.split('?')[1]).get('step_id')
        return { id, lines: REPLAY_LINES[id] || [], cut: 0 }
      }
      if (path.startsWith('/replay')) return REPLAY
      throw new Error(`unexpected ${path}`)
    },
    os: { writeClipboard: async () => true }
  }
  const emit = (type, payload) => act(async () => { for (const fn of listeners.get(type) || []) fn({ type, session_id: 'rt-1', payload }) })
  return { ctx, registered, emit }
}

const tick = ms => act(() => new Promise(r => setTimeout(r, ms)))
const problems = []
const frames = []
const warn = console.warn
console.warn = () => {} // the failing-sources frame logs each failed poll on purpose
const click = el => act(async () => { el.click() })

async function liveRun(emit) {
  const ev = (id, goal, extra = {}) => emit('subagent.start', { subagent_id: id, delegation_id: 'd1', goal, started_at: NOW - 140, ...extra })
  await emit('subagent.spawn_requested', { subagent_id: 's1', delegation_id: 'd1', goal: "Polish 'fleet-status' visuals", task_index: 0 })
  await emit('subagent.spawn_requested', { subagent_id: 's2', delegation_id: 'd1', goal: "Check 'wiki-watchdog' tests", task_index: 1 })
  await emit('subagent.spawn_requested', { subagent_id: 's3', delegation_id: 'd1', goal: "Run 'agent-station' gates", task_index: 2 })
  await emit('subagent.spawn_requested', { subagent_id: 's4', delegation_id: 'd1', goal: "Write 'release-notes' draft", task_index: 3 })
  await ev('s1', "Polish 'fleet-status' visuals", { child_session_id: 'k1', model: 'anthropic/claude-opus-5-5' })
  await ev('s2', "Check 'wiki-watchdog' tests", { child_session_id: 'k2', model: 'anthropic/claude-sonnet-5' })
  await emit('subagent.tool', { subagent_id: 's2', tool_name: 'read_file', tool_preview: 'C:/work/panel/tests/render_check.mjs' })
  await ev('s1a', "Judge 'status-contrast' ratios", { parent_id: 's1', child_session_id: 'k1a', depth: 1, model: 'openai/gpt-5.2', started_at: NOW - 60 })
  await emit('subagent.tool', { subagent_id: 's1a', tool_name: 'read_file', tool_preview: 'C:/work/panel/desktop/plugin.js' })
  await ev('s3', "Run 'agent-station' gates", { child_session_id: 'k3', model: 'anthropic/claude-sonnet-5' })
  await emit('subagent.tool', { subagent_id: 's3', tool_name: 'terminal', tool_preview: 'node render_check.mjs' })
  await emit('subagent.complete', { subagent_id: 's2', status: 'error', summary: "The wiki-watchdog suite fails before it starts: Cannot find module './fixtures/state.db'. Nothing was changed.", duration_seconds: 74, cost_usd: 0.42 })
  await emit('subagent.tool', { subagent_id: 's1', tool_name: 'patch', tool_preview: 'C:/work/panel/desktop/plugin.js' })
  await emit('tool.start', { tool_id: 'f1', name: 'read_file', args: { path: 'dashboard/plugin_api.py' } })
}

async function frame(screen, look, label, opts = {}, steps = async () => {}) {
  const { ctx, registered, emit } = makeCtx(look, opts)
  stub.state.listFails = Boolean(opts.fail)
  stub.state.list['rt-1'] = []
  stub.atoms.focusedSessionId.set(opts.noChat ? null : 'rt-1')
  stub.atoms.focusedStoredSessionId.set(opts.noChat ? null : 'st-1')
  mod.default.register(ctx)
  const route = registered.find(c => c.area === 'routes')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(route.render)) })
  await tick(20)
  if (opts.live) await liveRun(emit)
  await steps({ host, emit, q: s => host.querySelector(s), qa: s => [...host.querySelectorAll(s)] })
  await tick(20)
  const html = host.innerHTML
  const text = host.textContent || ''
  const raw = [...new Set(text.match(/\bsw\.[a-z][A-Za-z0-9_.]*/g) || [])]
  if (raw.length) problems.push(`${screen}/${look}: raw i18n key(s) on screen: ${raw.join(', ')}`)
  const titled = host.querySelectorAll('[title]').length
  if (titled) problems.push(`${screen}/${look}: ${titled} native title= attribute(s) — the themed Tip owns hover text`)
  if (host.querySelector('.sw-page')?.dataset.theme !== look && !opts.bar) problems.push(`${screen}/${look}: the page drew ${host.querySelector('.sw-page')?.dataset.theme}`)
  frames.push({ screen, look, label, html, narrow: Boolean(opts.narrow), bar: Boolean(opts.bar) })
  await act(async () => root.unmount())
  host.remove()
}

const TITLES = {
  1: '1 · Live, main agent selected (default view)',
  2: '2 · A failed subagent selected — task, answer, files, buttons; a copy shows a toast',
  3: '3 · Run picker open — earlier runs live here',
  4: '4 · An earlier run open — calm, one click back to now',
  5: '5 · Commands tab — a failed command picked: console with its first error, the list, the process card',
  6: "6 · The console's other states: running, unreadable, printed nothing (narrow)",
  7: '7 · A chat with no subagents yet — the main agent and its files',
  8: '8 · No chat selected · loading · several sources failing',
  9: '9 · Narrow (380 px): the station stays, its callouts drop under it as a list; nothing scrolls sideways',
  10: '10 · The status-bar chip',
  11: '11 · 40 subagents: five wings for those that need eyes, the sixth holds the rest',
  12: "12 · Replay tab — a request's edits one at a time: removed and added lines, a failed edit, narrow"
}

for (const look of LOOKS) {
  await frame(1, look, TITLES[1], { live: true })
  await frame(2, look, TITLES[2], { live: true }, async ({ qa, q }) => {
    const failed = qa('.sw-agents .sw-orbit button[data-node]').find(u => u.dataset.st === 'failed')
    await click(failed)
    await click(q('.sw-focus .sw-btns .sw-ib'))
    await tick(10)
  })
  await frame(3, look, TITLES[3], {}, async ({ q }) => { await click(q('.sw-pick')) })
  await frame(4, look, TITLES[4], {}, async ({ q, qa }) => {
    await click(q('.sw-pick'))
    await click(qa('.sw-menu [role=menuitem]').at(-1))
    await click(qa('.sw-agents .sw-orbit button[data-node]')[1])
  })
  await frame(5, look, TITLES[5], {}, async ({ q, qa }) => {
    await click(q('[role=tab][data-tab=commands]'))
    await tick(10)
    await click(qa('.sw-cmrow').find(p => p.dataset.st === 'failed'))
    await tick(20)
    if (!q('.sw-cmfirst')) problems.push(`5/${look}: the failed command has no FIRST ERROR callout`)
  })
  for (const [id, what, narrow] of [['proc_run', 'still running', false], ['proc_lost', 'an unreadable output', true], ['proc_quiet', 'it printed nothing', true]]) {
    await frame(6, look, `${TITLES[6]} — ${what}${narrow ? ' (380 px)' : ''}`, { procs: PROCS6, narrow }, async ({ q, qa }) => {
      await click(q('[role=tab][data-tab=commands]'))
      await tick(10)
      await click(qa('.sw-cmrow')[PROCS6.length - 1 - PROCS6.findIndex(x => x.id === id)])
      await tick(30)
    })
  }
  await frame(7, look, TITLES[7], { empty: true })
  await frame(8, look, `${TITLES[8]} — no chat`, { noChat: true })
  await frame(8, look, `${TITLES[8]} — loading`, { loading: true })
  await frame(8, look, `${TITLES[8]} — failing`, { fail: true }, async () => { for (let i = 0; i < 3; i++) await tick(3100) })
  await frame(9, look, TITLES[9], { live: true, narrow: true }, async ({ emit }) => {
    for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) {
      await emit('subagent.start', { subagent_id: `n${i}`, delegation_id: 'd1', goal: `Blind-review '${name}-panel' score`, model: 'anthropic/claude-opus-5-5', started_at: NOW - 28 })
      await emit('subagent.tool', { subagent_id: `n${i}`, tool_name: 'read_file', tool_preview: 'plugin.js' })
    }
  })
  // 10: the status-bar chip, in a strip the height of the app's status bar.
  {
    const { ctx, registered } = makeCtx(look)
    const sid = `rt-chip-${look}` // each look its own batch: a finished batch never restarts
    stub.state.list[sid] = []
    mod.default.register(ctx)
    stub.atoms.focusedSessionId.set(sid)
    const chipReg = registered.find(c => c.area === 'statusBar.right')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(React.createElement(chipReg.render)) })
    const send = (type, payload) => act(async () => { mod.trackEvent(type, { session_id: sid, payload }) })
    for (const id of ['k1', 'k2', 'k3', 'k4', 'k5']) await send('subagent.spawn_requested', { subagent_id: id })
    for (const id of ['k1', 'k2', 'k3', 'k4']) await send('subagent.start', { subagent_id: id })
    await send('subagent.complete', { subagent_id: 'k1', status: 'completed', cost_usd: 1.62 })
    await send('subagent.complete', { subagent_id: 'k2', status: 'completed', cost_usd: 2.58 })
    await send('subagent.complete', { subagent_id: 'k3', status: 'error', cost_usd: 0 })
    await tick(20)
    if (!host.querySelector('.sw-sb')) problems.push(`10/${look}: the progress chip did not render`)
    if (host.querySelector('.sw-sbw')?.dataset.theme !== look) problems.push(`10/${look}: the chip drew another look`)
    if (host.querySelectorAll('[title]').length) problems.push(`10/${look}: a native title= on the chip`)
    frames.push({ screen: 10, look, label: `${TITLES[10]} — chip: 3 of 5 finished, one failed, cost so far`, html: host.innerHTML, bar: true })
    await act(async () => root.unmount())
    host.remove()
  }
  const openReplay = async ({ q }) => {
    await click(q('[role=tab][data-tab=replay]'))
    await tick(20)
    if (!q('.sw-rturn')) problems.push(`12/${look}: the replay list did not render`)
  }
  await frame(12, look, `${TITLES[12]} — edit 1 of 4`, {}, async h => {
    await openReplay(h)
    if (!h.qa('.sw-rl[data-tag="-"]').length || !h.qa('.sw-rl[data-tag="+"]').length) problems.push(`12/${look}: the open edit shows no removed / added lines`)
  })
  await frame(12, look, `${TITLES[12]} — the failed edit`, {}, async h => {
    await openReplay(h)
    await click(h.qa('.sw-rmark')[1])
    await tick(20)
    if (!h.q('.sw-rfail')) problems.push(`12/${look}: the failed edit does not say it failed`)
  })
  await frame(12, look, `${TITLES[12]} — narrow (380 px), a whole-file write`, { narrow: true }, async h => {
    await openReplay(h)
    await click(h.qa('.sw-rmark')[3])
    await tick(20)
  })
  await frame(11, look, TITLES[11], {}, async ({ emit, q }) => {
    for (const [i, name] of SWARM_NAMES.entries()) await emit('subagent.spawn_requested', { subagent_id: `w${i}`, delegation_id: 'dw', goal: `Sweep '${name}' module`, task_index: i })
    for (let i = 0; i < 30; i++) await emit('subagent.start', { subagent_id: `w${i}`, delegation_id: 'dw', goal: `Sweep '${SWARM_NAMES[i]}' module`, child_session_id: `kw${i}`, started_at: NOW - 200 })
    for (let i = 0; i < 20; i++) await emit('subagent.complete', { subagent_id: `w${i}`, status: 'completed', duration_seconds: 60 + i, cost_usd: 0.05 })
    for (let i = 20; i < 23; i++) await emit('subagent.complete', { subagent_id: `w${i}`, status: 'error', summary: 'boom', duration_seconds: 30, cost_usd: 0.02 })
    for (let i = 23; i < 30; i++) await emit('subagent.tool', { subagent_id: `w${i}`, tool_name: ['patch', 'read_file', 'terminal'][i % 3], tool_preview: `src/${SWARM_NAMES[i]}.ts` })
    const n = q('.sw-orbit').querySelectorAll('.sw-orl:not(.is-grp)').length + [...q('.sw-orl.is-grp')?.querySelectorAll('.sw-orm') || []].reduce((s, e) => s + Number(e.textContent), 0)
    if (n !== 40) problems.push(`11/${look}: the orbit's wings and group hold ${n} subagents, not 40`)
  })
}
stub.state.listFails = false

for (let s = 1; s <= SCREENS; s++) {
  for (const look of LOOKS) if (!frames.some(f => f.screen === s && f.look === look)) problems.push(`screen ${s} is missing in the ${look} look`)
}

const DIST_ASSETS = DESKTOP_APP ? `${DESKTOP_APP.replace(/\\/g, '/')}/dist/assets` : null
function newestCss(pattern) {
  try {
    return readdirSync(DIST_ASSETS)
      .filter(name => pattern.test(name))
      .map(name => ({ name, at: statSync(`${DIST_ASSETS}/${name}`).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.name
  } catch (e) {
    return undefined
  }
}
const CSS_FILES = DIST_ASSETS ? [newestCss(/^index-.*\.css$/), newestCss(/^tooltip-.*\.css$/)].filter(Boolean) : []
const appCss = CSS_FILES.map(name => readFileSync(`${DIST_ASSETS}/${name}`, 'utf8')).join('\n')
const styles = appCss
  ? `app stylesheet ${CSS_FILES.join(' + ')} (${appCss.length} bytes, theme included)`
  : `app stylesheet NOT FOUND in ${DIST_ASSETS || '(no core found — set HERMES_AGENT_DIR)'} (the picture is unstyled)`
if (!appCss) console.log(`warning: ${styles}`)

// The seeds `applyTheme()` sets inline on <html> for the default dark skin, and the colour scheme it sets
// with them (light-dark() in the palette reads it); the compiled sheet derives every --ui-* token from them.
const DARK_SEEDS = ':root.dark { color-scheme: dark; --theme-background-seed: #0d0d0e; --theme-sidebar-seed: #0a0a0b;'
  + ' --theme-card-seed: #161618; --theme-neutral-card: #161618; --theme-foreground: #f4f4f6; }'

// One row per screen, one column per look, each frame in the order it was drawn.
const cell = f => `<section class="swp-wrap${f.narrow ? ' is-narrow' : ''}${f.bar ? ' is-bar' : ''}" data-screen="${f.screen}" data-look="${f.look}">
  <p class="swp-label">${f.label}</p>
  <div class="swp-frame">${f.bar ? `<div class="swp-bar">${f.html}</div>` : f.html}</div>
</section>`
const body = Array.from({ length: SCREENS }, (_, i) => i + 1).map(s => `<div class="swp-row" data-row="${s}">
${LOOKS.map(look => `<div class="swp-col" data-col="${look}"><p class="swp-look">${({ terminal: 'Terminal' })[look]}</p>
${frames.filter(f => f.screen === s && f.look === look).map(cell).join('\n')}</div>`).join('\n')}
</div>`).join('\n')

const page = `<!doctype html>
<html class="dark" lang="en">
<head><meta charset="utf-8"><title>Agent Station — preview</title>
<style>${appCss}</style>
<style>${DARK_SEEDS}</style>
<style>
html,body{margin:0;background:var(--ui-bg-sidebar);color:var(--ui-text-primary);font-family:system-ui,'Segoe UI',sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{padding:16px 18px 28px}
.swp-row{display:flex;gap:24px;align-items:flex-start;margin:0 0 26px}
.swp-col{width:640px;flex:none}
.swp-look{font-size:12px;font-weight:600;color:var(--ui-text-secondary);margin:0 0 6px}
.swp-wrap{margin:0 0 14px;width:640px}
.swp-wrap.is-narrow{width:380px}
.swp-wrap.is-bar{width:auto}
.swp-bar{height:24px;display:flex;align-items:center;justify-content:flex-end;padding:0 8px;background:var(--ui-bg-sidebar);font-size:11.5px}
.swp-label{font-size:12px;color:var(--ui-text-secondary);margin:0 0 6px}
/* a frame stands in for the pane, which sits on the app shell's --ui-bg-chrome (controller.tsx data-contrib-shell) */
.swp-frame{border:1px solid var(--ui-stroke-primary);border-radius:10px;overflow:hidden;background:var(--ui-bg-chrome)}
.swp-frame .sw-page{height:auto}
</style>
</head>
<body>
${body}
</body>
</html>
`
writeFileSync(`${HERE}preview.html`, page)

if (problems.length) {
  console.error('PREVIEW: problems found')
  for (const p of problems) console.error('  -', p)
  process.exit(1)
}
console.log(`preview.html written (${page.length} bytes) · ${frames.length} frames · ${SCREENS} screens × ${LOOKS.length} looks · style: ${styles}`)
process.exit(0)
