/**
 * The Electron half of the real-render harness (run by live.py, never by hand): the REAL
 * desktop/plugin.js with the real React from tests/node_modules, the real canvas scenes and the app's
 * compiled stylesheet, fed by the panel's own backend route functions that live.py serves on fixture
 * data. One Electron takes the whole shot list; each shot is its own offscreen window.
 *
 * Per shot: load, open the tab and the state, wait for the data and the canvas intro, let the page's
 * scroll box out to its whole height (a page over 16000 px is reported as cut), settle the frame
 * (finite CSS animations finished, infinite ones paused at their delay plus half their duration, so no
 * readout is caught half-typed or faded; the canvas keeps drawing), measure it with measure.cjs
 * (M1–M6) plus the engine checks (M7), and write the PNG and its 560 px bands (40 px overlap).
 *
 * Usage: <electron> live.cjs <config.json>   (live.py writes the config: backend URL, shots, fixture)
 * Writes under the config's `out` folder only: page/, profile/, the PNGs, bands/ and report.json.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { PAGE } = require('./measure.cjs')

const CFG = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'))
const OUT = CFG.out
const WORK = path.join(OUT, 'page')
const BANDS = path.join(OUT, 'bands')
const MAX_H = 16000
const BAND = 560
const OVERLAP = 40
const INTRO_MS = 3000 // the longest canvas intro (wormhole scan) ends at 2.6 s
const JOBS = 4
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(BANDS, { recursive: true })
app.setPath('userData', path.join(OUT, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// ESM shims over the CommonJS React builds, loaded with the renderer's require.
const IDENT = /^[A-Za-z_$][\w$]*$/
for (const [spec, file] of [['react', 'react.mjs'], ['react/jsx-runtime', 'jsx-runtime.mjs'], ['react-dom/client', 'react-dom-client.mjs']]) {
  const abs = require.resolve(spec, { paths: [CFG.nodeModules] })
  const names = Object.keys(require(abs)).filter(n => IDENT.test(n) && n !== 'default')
  fs.writeFileSync(path.join(WORK, file), `const m = window.require(${JSON.stringify(abs)})\nexport default m\nexport const { ${names.join(', ')} } = m\n`)
}

// The SDK the panel imports: the chat it shows, a runtime session whose live workers are the fixture's.
fs.writeFileSync(path.join(WORK, 'sdk.mjs'), `import { cloneElement, isValidElement, useSyncExternalStore } from 'react'
function atom(v) { const subs = new Set(); return { get: () => v, set: n => { v = n; subs.forEach(f => f()) }, listen: f => { subs.add(f); return () => subs.delete(f) } } }
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
const atoms = { focusedSessionId: atom('rt-live'), focusedStoredSessionId: atom(window.__SW.session), busyBySession: atom({}) }
export function useValue(a) { return useSyncExternalStore(a.listen, a.get) }
const bundles = new Map()
export function registerBundles(id, b) { bundles.set(id, b) }
export function usePluginI18n(id) {
  return (key, ...args) => { let node = bundles.get(id)?.en; for (const p of key.split('.')) node = node?.[p]; return typeof node === 'function' ? node(...args) : (node ?? key) }
}
export function Tip({ label, children }) { return isValidElement(children) ? cloneElement(children, { 'data-tip': label }) : children }
export const host = {
  state: atoms,
  request: async (method) => (method === 'subagent.list' ? { subagents: window.__SW.live } : {}),
  openSession: async () => {}, navigate: () => {}
}
export default { host }
`)

fs.writeFileSync(path.join(WORK, 'main.mjs'), `import plugin from ${JSON.stringify(pathToFileURL(CFG.plugin).href)}
import { registerBundles } from '@hermes/plugin-sdk'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
const registered = []
const ctx = {
  storage: { get: (k, f) => (k === 'theme' ? 'terminal' : f), set: () => {}, remove: () => {} },
  register: c => { registered.push(c); return () => {} },
  i18n: { register: b => registerBundles('subagent-watch', b), t: k => k },
  onEvent: () => () => {},
  setInterval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h) },
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  rest: async p => { const r = await fetch(window.__SW.api + p); if (!r.ok) throw new Error('backend ' + r.status); return r.json() },
  os: { writeClipboard: async () => true }
}
plugin.register(ctx)
const route = registered.find(c => c.area === 'routes')
window.__SW.routeFound = !!route
if (route) createRoot(document.getElementById('root')).render(createElement(route.render))
`)

// The app's stylesheet is LINKED from the core's dist folder, so its relative font URLs resolve.
// Dark: the app's dark seeds; light: the app's own light tokens. Both keep the default accent.
const DARK = ':root.dark { color-scheme: dark; --theme-background-seed: #0d0d0e; --theme-sidebar-seed: #0a0a0b; --theme-card-seed: #161618; --theme-neutral-card: #161618; --theme-foreground: #f4f4f6; }'
const imports = { react: './react.mjs', 'react/jsx-runtime': './jsx-runtime.mjs', 'react-dom/client': './react-dom-client.mjs', '@hermes/plugin-sdk': './sdk.mjs' }
fs.writeFileSync(path.join(WORK, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
${CFG.sheets.map(f => `<link rel="stylesheet" href="${pathToFileURL(f).href}">`).join('\n')}
<style>${DARK}</style>
<style>html,body{margin:0;height:100%;background:var(--ui-bg-chrome)}#root{height:100%}</style>
<style id="sw-inject"></style>
<script>
  window.__SW = JSON.parse(decodeURIComponent(location.hash.slice(1)))
  if (window.__SW.mode === 'dark') document.documentElement.classList.add('dark')
  document.getElementById('sw-inject').textContent = window.__SW.inject || ''
</script>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head><body><div id="root"></div><script type="module" src="./main.mjs"></script></body></html>`)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// What each opened state clicks, run in the page; returns what it did (or throws, naming the miss).
const STATE = {
  'agents-detail': `(async () => {
    const d = document.querySelector('details.sw-hdetail'); if (!d) throw new Error('no DETAIL panel')
    if (!d.open) d.querySelector('summary').click()
    for (let k = 0; k < 20; k++) {
      await new Promise(r => setTimeout(r, 250))
      const more = [...d.querySelectorAll('button.sw-more')]; if (!more.length) break
      more.forEach(b => b.click())
    }
    return 'detail open'
  })()`,
  'agents-worker': `(async () => {
    const pick = document.querySelector('.sw-orbit .sw-orl[data-st=failed]'); if (!pick) throw new Error('no failed callout')
    pick.click(); await new Promise(r => setTimeout(r, 300))
    const d = document.querySelector('details.sw-hdetail'); if (!d) throw new Error('no DETAIL panel')
    if (!d.open) d.querySelector('summary').click()
    return 'worker ' + pick.textContent
  })()`,
  'agents-runpick': `(async () => { const b = document.querySelector('.sw-pick'); if (!b) throw new Error('no run picker'); b.click(); return 'picker' })()`,
  'commands-failed': `(async () => { const b = document.querySelector('.sw-cmrow[data-st=failed]'); if (!b) throw new Error('no failed command'); b.click(); return 'failed command' })()`,
  'replay-failed': `(async () => { const b = document.querySelector('.sw-hlog>button[data-st=failed]'); if (!b) throw new Error('no failed edit'); b.click(); return 'failed edit' })()`
}

const settle = `(() => {
  for (const a of document.getAnimations()) {
    const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null
    if (!timing) continue
    if (timing.iterations === Infinity) {
      const d = Number(timing.duration) || 0, delay = Number(timing.delay) || 0
      a.pause(); a.currentTime = Math.max(0, delay) + d / 2
    } else { try { a.finish() } catch (e) { a.cancel() } }
  }
  return document.getAnimations().length
})()`

async function waitFor(win, expr, ms, what) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await win.webContents.executeJavaScript(expr)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}; the page reads: ` + await win.webContents.executeJavaScript(`(document.querySelector('.sw-page') || document.body).innerText.replace(/\\s+/g, ' ').slice(0, 160)`))
}

async function take(shot) {
  const win = new BrowserWindow({ width: shot.width, height: 1200, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } })
  win.webContents.setFrameRate(60)
  const errors = []
  win.webContents.on('console-message', (e, level, message) => {
    const lv = e && e.level !== undefined ? e.level : level
    if (lv === 3 || lv === 'error') errors.push(String(e && e.message !== undefined ? e.message : message))
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone ${JSON.stringify(d)}`))
  const state = { ...shot, session: CFG.sessions[shot.data], api: CFG.api, live: shot.data === 'full' ? CFG.live : [] }
  const violations = []
  const v = (rule, sel, text, detail) => violations.push({ rule, sel, text, detail })
  try {
    await win.loadFile(path.join(WORK, 'index.html'), { hash: encodeURIComponent(JSON.stringify(state)) })
    const font = await win.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready
      const p = document.createElement('span'); p.style.fontFamily = 'var(--dt-font-mono)'; document.body.appendChild(p)
      const fam = getComputedStyle(p).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''); p.remove()
      const spec = '12px "' + fam + '"'
      const faces = await document.fonts.load(spec)
      return { fam, ok: faces.length > 0 && document.fonts.check(spec) }
    })()`)
    if (!font.ok) return { fatal: `the code font's first family "${font.fam}" did not load (document.fonts.check)` }
    await waitFor(win, `!!document.querySelector('.sw-page') || window.__SW.routeFound === false`, 15000, 'the panel')
    // click the tab until it is the selected one (the first render may replace the buttons)
    if (shot.tab !== 'agents') await waitFor(win, `(() => { const b = document.getElementById('sw-tabb-${shot.tab}'); if (b && b.getAttribute('aria-selected') !== 'true') b.click(); return !!b && b.getAttribute('aria-selected') === 'true' })()`, 15000, `the ${shot.tab} tab`)
    await waitFor(win, `!!document.querySelector('#sw-tab-${shot.tab}') && !document.querySelector('.sw-skel, .sw-cmwait')`, 15000, `the ${shot.tab} tab's data`)
    await sleep(600)
    if (shot.state) console.log(`  ${shot.name}: ${await win.webContents.executeJavaScript(STATE[shot.state])}`)
    await sleep(shot.data === 'full' || shot.tab === 'agents' ? INTRO_MS : 600)
    // let the page's own scroll box out, so the shot holds every part of it
    const h = await win.webContents.executeJavaScript(`(() => {
      const st = document.createElement('style')
      st.textContent = 'html,body,#root{height:auto!important;overflow:visible!important} .sw-page{height:auto!important;max-height:none!important;overflow:visible!important}'
      document.head.appendChild(st)
      return Math.ceil(Math.max(document.querySelector('.sw-page')?.scrollHeight || 0, document.documentElement.scrollHeight))
    })()`)
    if (h > MAX_H) v('CUT', '.sw-page', '', `page is ${h} px, captured to ${MAX_H}`)
    win.setContentSize(shot.width, Math.min(h, MAX_H))
    await sleep(500)
    await win.webContents.executeJavaScript(settle)
    await win.webContents.executeJavaScript(PAGE)
    const m = await win.webContents.executeJavaScript(`(() => {
      const M = window.__swMeasure
      const rows = M.all()
      const err = [...document.querySelectorAll('.sw-err')].filter(e => e.getClientRects().length).map(e => e.textContent.trim().slice(0, 80))
      const orbits = [...document.querySelectorAll('.sw-orbit')].map(o => ({ sel: o.closest('.sw-hp')?.className || 'sw-orbit', scene: o.classList.contains('has-scene') }))
      return { rows, err, orbits, route: window.__SW.routeFound, contrast: M.contrast(document.body).classes }
    })()`)
    violations.push(...m.rows)
    if (!m.route) v('M7', 'routes', '', 'the panel registered no route')
    for (const e of m.err) v('M7', '.sw-err', e, 'an alert box shows on fixture data')
    if (shot.data === 'full' && !shot.state && !shot.inject) {
      if (!m.orbits.length) v('M7', shot.tab, '', 'no FLEET / ORBIT / WORMHOLE panel on a full base shot')
      for (const o of m.orbits) if (!o.scene) v('M7', o.sel, '', 'the panel did not switch to its canvas (has-scene missing)')
    }
    await win.webContents.executeJavaScript(settle)
    const img = await win.webContents.capturePage()
    const png = path.join(OUT, `${shot.name}.png`)
    fs.writeFileSync(png, img.toPNG())
    const size = img.getSize()
    for (let y = 0, n = 0; y < size.height; y += BAND - OVERLAP, n++) {
      const band = img.crop({ x: 0, y, width: size.width, height: Math.min(BAND, size.height - y) })
      fs.writeFileSync(path.join(BANDS, `${shot.name}__${String(n).padStart(2, '0')}.png`), band.toPNG())
      if (y + BAND >= size.height) break
    }
    for (const e of errors) v('M7', 'engine', e.slice(0, 120), 'an engine error was logged')
    return { ...shot, inject: undefined, height: h, violations, contrast: m.contrast }
  } catch (e) {
    for (const x of errors) v('M7', 'engine', x.slice(0, 120), 'an engine error was logged')
    v('M7', shot.name, String(e && e.message || e).slice(0, 160), 'the shot could not be taken')
    return { ...shot, inject: undefined, height: 0, violations }
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  const results = new Array(CFG.shots.length)
  let next = 0, fatal = null
  const worker = async () => {
    while (next < CFG.shots.length && !fatal) {
      const k = next++
      const r = await take(CFG.shots[k])
      if (r.fatal) { fatal = r.fatal; break }
      results[k] = r
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker))
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(fatal ? { fatal } : { shots: results.filter(Boolean) }, null, 1))
  app.exit(0)
}).catch(e => {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ fatal: `Electron failed: ${e && e.stack || e}` }))
  app.exit(1)
})
