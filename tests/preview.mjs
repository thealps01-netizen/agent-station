/**
 * Static preview of Subagent Watch — look at the page without restarting the app.
 *
 * Run: cd tests && node render_check.mjs && node preview.mjs      (writes preview.html, exit 0 = ok)
 *
 * It draws THREE FRAMES in jsdom with the real React — the page's REAL output, never a hand-drawn
 * mock — through the same SDK stub the render check writes (`.out/sdk-stub.mjs`):
 *   1. Now — a running batch as a live tree (a nested worker, a failed one, a queued one, the merge
 *      node) above two earlier batches and the background commands, one of each status.
 *   2. Earlier — a batch opened to its workers, one worker's detail open, and a failed background
 *      command opened to its exit code and output tail.
 *   3. Failures — every read failing at once: the alert box with each message, nothing swallowed.
 *
 * STYLES: the application's OWN COMPILED stylesheet (`apps/desktop/dist/assets/index-*.css`, newest
 * build) carries the theme — light and dark blocks both — so nothing is copied from another repo.
 * The page runs in `html.dark` with the seeds `applyTheme()` hands in inline. A missing build is
 * reported as "app stylesheet NOT FOUND" and does NOT fail the run; the picture is then unstyled.
 *
 * Exit 1: a raw `sw.*` key on screen, or a native `title=` in any frame.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { DESKTOP_APP } from './env.mjs'

const HERE_URL = new URL('.', import.meta.url)
const HERE = fileURLToPath(HERE_URL).replace(/\\/g, '/')
const previewWidthArg = process.argv.find(arg => arg.startsWith('--width='))
const previewWidth = previewWidthArg ? Number(previewWidthArg.slice(8)) : null
if (previewWidth !== null && (!Number.isFinite(previewWidth) || previewWidth < 320 || previewWidth > 1800)) throw new Error('Invalid preview width')
const previewLight = process.argv.includes('--light')

const STUB = `${HERE_URL.href}.out/sdk-stub.mjs`
const SRC = `${HERE}../desktop/plugin.js`

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
  batches: [
    {
      started_at: NOW - 5400,
      workers: [
        { session_id: 'c-a', goal: "Audit 'fleet-routing' against the kit", model: 'anthropic/claude-opus-5-5', effort: 'medium', status: 'completed', duration_s: 312, tool_calls: 40, tokens: 120000, summary: '' },
        { session_id: 'c-b', goal: "Audit 'fleet-status' against the kit", model: 'anthropic/claude-opus-5-5', status: 'stopped', duration_s: null, tool_calls: 12, tokens: 9000, summary: '' }
      ]
    },
    {
      started_at: NOW - 1800,
      workers: [
        { session_id: 'c-c', goal: "Write the 'wiki-watchdog' changelog", model: 'openai/gpt-5.2', status: 'completed', duration_s: 45, tool_calls: 3, tokens: 800, summary: '' }
      ]
    }
  ]
}
const PROCS = [
  { id: 'proc_run', command: 'npm run dev -- --port 5174', cwd: 'C:/work/panel', status: 'running', started_at: NOW - 95, duration_s: null, exit_code: null },
  { id: 'proc_ok', command: `python -m pytest tests/ -q --maxfail=1 --durations=10 --basetemp="${HERE}fixture-pytest"`, cwd: HERE, status: 'completed', started_at: NOW - 900, duration_s: 42, exit_code: 0 },
  { id: 'proc_bad', command: 'node build.mjs --release', cwd: 'C:/work/panel', status: 'failed', started_at: NOW - 1200, duration_s: 5, exit_code: 1 },
  { id: 'proc_kill', command: 'sleep 999', cwd: 'C:/work/panel', status: 'stopped', started_at: NOW - 3000, duration_s: 100, exit_code: -15 }
]
const OUTPUT = 'building 14 entries…\nerror: Cannot find module \'./sdk-stub.mjs\'\n    at build.mjs:41:9\nexit 1'

function makeCtx(fail) {
  const listeners = new Map()
  const registered = []
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
      if (fail) throw new Error(path.startsWith('/children') ? 'backend 503: state.db not found' : 'backend 503: processes.json unreadable')
      if (path.startsWith('/children')) return HISTORY
      if (path.startsWith('/processes')) return { session_id: 'st-1', processes: PROCS, unreadable: 1 }
      if (path.startsWith('/process_output')) {
        const id = new URLSearchParams(path.split('?')[1]).get('process_id')
        const p = PROCS.find(x => x.id === id)
        return { id, command: p.command, output: id === 'proc_bad' ? OUTPUT : '12 passed in 41.8s', output_truncated: false }
      }
      if (path.startsWith('/output')) return { text: 'answer' }
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

async function frame(label, { fail = false, live = false, open = null, narrow = false, docked = false } = {}) {
  const { ctx, registered, emit } = makeCtx(fail)
  stub.state.listFails = fail
  stub.state.list['rt-1'] = []
  stub.atoms.focusedSessionId.set('rt-1')
  stub.atoms.focusedStoredSessionId.set('st-1')
  mod.default.register(ctx)
  const route = registered.find(c => c.area === 'routes')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(route.render)) })
  await tick(20)
  if (live) {
    await emit('subagent.spawn_requested', { subagent_id: 's1', delegation_id: 'd1', goal: "Polish 'fleet-status' visuals", task_index: 0 })
    await emit('subagent.spawn_requested', { subagent_id: 's2', delegation_id: 'd1', goal: "Polish 'wiki-watchdog' visuals", task_index: 1 })
    await emit('subagent.spawn_requested', { subagent_id: 's3', delegation_id: 'd1', goal: "Polish 'subagent-watch' visuals", task_index: 2 })
    await emit('subagent.start', { subagent_id: 's1', delegation_id: 'd1', goal: "Polish 'fleet-status' visuals", model: 'anthropic/claude-opus-5-5', started_at: NOW - 140 })
    await emit('subagent.start', { subagent_id: 's1a', parent_id: 's1', delegation_id: 'd1', goal: "Judge 'fleet-status' contrast", depth: 1, model: 'openai/gpt-5.2', started_at: NOW - 60 })
    await emit('subagent.tool', { subagent_id: 's1', tool_name: 'terminal', tool_preview: 'node preview.mjs' })
    await emit('subagent.complete', { subagent_id: 's2', status: 'error', summary: 'boom', duration_seconds: 12 })
  }
  if (narrow) {
    // The page docked beside the chat: six running workers and a finished command with a long path.
    for (let i = 1; i <= 6; i++) {
      await emit('subagent.start', { subagent_id: `n${i}`, delegation_id: 'dn', goal: `Blind-review desktop panel ${i}: score CODE and UI`, model: 'anthropic/claude-opus-5-5', started_at: NOW - 28 })
      await emit('subagent.tool', { subagent_id: `n${i}`, tool_name: 'read_file', tool_preview: 'plugin.js' })
    }
    const ok = [...host.querySelectorAll('.sw-pr')].find(p => p.dataset.st === 'completed')
    await act(async () => { ok.click() })
    // A still-running command opened too: no exit code yet, so its meta line is the path alone.
    const run = [...host.querySelectorAll('.sw-pr')].find(p => p.dataset.st === 'running')
    await act(async () => { run.click() })
    await tick(20)
  }
  if (fail) {
    for (let i = 0; i < 3; i++) await tick(3100)
  }
  if (open === 'earlier') {
    await act(async () => { host.querySelectorAll('.sw-hb')[0].click() })
    await act(async () => { host.querySelectorAll('.sw-wr')[0].click() })
    const bad = [...host.querySelectorAll('.sw-pr')].find(p => p.dataset.st === 'failed')
    await act(async () => { bad.click() })
    await tick(20)
  }
  if (docked) {
    // The older batch holds the Opus workers (one with a reasoning effort): open it too.
    await act(async () => { host.querySelectorAll('.sw-hb')[1].click() })
    await tick(20)
  }
  if (live || open || docked) host.querySelector('.sw-context')?.setAttribute('open', '')
  const html = host.innerHTML
  const text = host.textContent || ''
  const raw = [...new Set(text.match(/\bsw\.[a-z][A-Za-z0-9_.]*/g) || [])]
  if (raw.length) problems.push(`${label}: raw i18n key(s) on screen: ${raw.join(', ')}`)
  const titled = host.querySelectorAll('[title]').length
  if (titled) problems.push(`${label}: ${titled} native title= attribute(s) — the themed Tip owns hover text`)
  frames.push({ label, html, narrow, docked })
  await act(async () => root.unmount())
  host.remove()
}

await frame('1 · Attention Desk — failed work selected, live tree opened as context', { live: true })
await frame('2 · Attention Desk — one inspector with earlier worker/process context opened', { open: 'earlier' })
await frame('3 · Failures — every read failing: nothing is swallowed', { fail: true })
await frame('4 · Narrow (380 px) — six running workers and a command with a long working directory', { narrow: true })
await frame('5 · Docked (480 px) — an Earlier worker whose model chip carries its reasoning effort', { open: 'earlier', docked: true })
stub.state.listFails = false

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

// The seeds `applyTheme()` sets inline on <html> for the default dark skin; the compiled sheet
// derives every --ui-* token from them.
const DARK_SEEDS = ':root.dark { --theme-background-seed: #0d0d0e; --theme-sidebar-seed: #0a0a0b;'
  + ' --theme-card-seed: #161618; --theme-neutral-card: #161618; --theme-foreground: #f4f4f6; }'

const body = frames.map(f => `<section class="swp-wrap${f.narrow ? ' is-narrow' : ''}${f.docked ? ' is-docked' : ''}">
  <p class="swp-label">${f.label}</p>
  <div class="swp-frame">${f.html}</div>
</section>`).join('\n')

const page = `<!doctype html>
<html class="${previewLight ? '' : 'dark'}" lang="en">
<head><meta charset="utf-8"><title>Subagent Watch — preview</title>
<style>${appCss}</style>
<style>${DARK_SEEDS}</style>
<style>
html,body{margin:0;background:var(--ui-bg-sidebar);color:var(--ui-text-primary);font-family:system-ui,'Segoe UI',sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{padding:16px 18px 28px}
.swp-wrap{margin:0 0 22px;width:${previewWidth ?? 880}px}
.swp-wrap.is-narrow{width:${previewWidth ?? 380}px}
.swp-wrap.is-docked{width:480px}
.swp-label{font-size:11px;color:var(--ui-text-tertiary);margin:0 0 6px}
.swp-frame{height:720px;border:1px solid var(--ui-stroke-primary);border-radius:10px;overflow:hidden;background:var(--ui-bg-primary)}
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
console.log(`preview.html written (${page.length} bytes) · ${frames.length} frames · style: ${styles}`)
process.exit(0)
