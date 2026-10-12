/**
 * Live map gate: the layout and drawing of the Live map look, checked on its own.
 * Run: node livemap_check.mjs [path/to/plugin.js]      (exit 0 = every check passed)
 *
 * The map is one section of desktop/plugin.js (from its "live map" banner to the end of MAP_CSS),
 * written without imports. This gate cuts that section out and runs it with the host identifiers it
 * uses (jsx, jsxs, Tip, hooks, pathKey, tipText) and the plugin's own English `sw.map` copy, so the
 * layout invariants are checked on many fixtures and widths without mounting the whole page:
 * determinism, everything inside the drawing, no overlapping agents or labels, names for the main and
 * selected agent, beams only for working agents, the 30-file cap with '+N' counts adding up, one-line
 * labels for 400-character paths, dots for a swarm, clicks selecting. render_check.mjs covers the map
 * inside the page; preview.mjs + shot.cjs draw it in a real browser.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')
const req = createRequire(`${HERE}package.json`)
const { JSDOM } = req('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.IS_REACT_ACT_ENVIRONMENT = true

const React = req('react')
const { jsx, jsxs } = req('react/jsx-runtime')
const { createRoot } = req('react-dom/client')
const { act, cloneElement, isValidElement, useState, useEffect, useMemo, useRef, useCallback } = React
const Tip = ({ label, children }) => (isValidElement(children) ? cloneElement(children, { 'data-tip': label }) : children)
const pathKey = p => String(p).replace(/\\/g, '/').toLowerCase()
const tipText = s => String(s).slice(0, 300)

const PLUGIN = (process.argv[2] || `${HERE}../desktop/plugin.js`).replace(/\\/g, '/')
const FULL = readFileSync(PLUGIN, 'utf8').replace(/\r\n/g, '\n')
const from = FULL.indexOf('// ── live map:')
const cssAt = FULL.indexOf('const MAP_CSS = `', from)
const SRC = from < 0 || cssAt < 0 ? '' : FULL.slice(from, FULL.indexOf('`\n', cssAt + 17) + 2)
if (!SRC) { console.log('FAIL  the live map section is in plugin.js'); process.exit(1) }
// The plugin's English sw.map copy, read from its bundle literal.
const copyAt = FULL.indexOf('\n      map: {\n')
const copyEnd = FULL.indexOf('\n      },\n', copyAt)
const MAP_BUNDLE = new Function(`return {${FULL.slice(copyAt, copyEnd + 8)}}`)().map
const BUNDLES = { en: { sw: { map: MAP_BUNDLE } } }
const body = SRC.replace(/^export\s+/gm, '')
const mod = new Function('jsx', 'jsxs', 'Tip', 'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'pathKey', 'tipText', 'BUNDLES',
  `${body}\nreturn { mapLayout, LiveMap, MAP_CSS, mapT }`)(jsx, jsxs, Tip, useState, useEffect, useMemo, useRef, useCallback, pathKey, tipText, BUNDLES)
const { mapLayout, LiveMap, MAP_CSS, mapT } = mod
const t = mapT
const fx = createRequire(import.meta.url)('./livemap_fixtures.cjs')()

let fails = 0
let passes = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `  -> ${detail}` : ''}`)
  if (ok) passes++
  else fails++
}
const grow = (b, d) => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d })
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const label = l => l.rows.map(r => r.map(p => p.text).join('')).join(' / ')

// ── static rules on the source ──────────────────────────────────────────────
{
  const re = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
  const bad = [...SRC.matchAll(re)].map(m => m[3]).filter(s => s !== '@hermes/plugin-sdk' && !s.startsWith('react'))
  check(bad.length === 0, 'loader specifier scan finds nothing to reject', bad.join(', '))
  check(!/^\s*import\s/m.test(SRC), 'fragment has no import lines')
  check(!/#[0-9a-fA-F]{3,8}\b/.test(SRC), 'no hex colour literals in the fragment')
  const named = MAP_CSS.match(/:\s*(red|green|blue|white|black|gray|grey|orange|yellow|gold)\b/g)
  check(!named, 'no named colours in MAP_CSS', String(named))
  const sizes = [...MAP_CSS.matchAll(/font-size:\s*([\d.]+)px/g)].map(m => Number(m[1]))
  check(sizes.length > 0 && sizes.every(s => s >= 12), `every font-size >= 12px (${[...new Set(sizes)].join(', ')})`)
  check(MAP_CSS.split('\n').filter(l => l.trim() && !l.trim().startsWith('@') && !l.trim().startsWith('}') && !/^\s*\.sw-page \.sw-map|^\s*\.sw-panel\[data-calm\] \.sw-map|^\s*--|^\s*border-top-color|^\s*transition|^\s*border:|^\s*--m-/.test(l) && !/^@keyframes/.test(l.trim())).length === 0, 'every MAP_CSS rule is scoped under .sw-page .sw-map (inside the page: the reduced-motion lock reaches it)')
  check(/@media \(prefers-reduced-motion:reduce\)\{[^]*animation:none!important/.test(MAP_CSS), 'reduced-motion stops all animation')
  check(/\.sw-panel\[data-calm\] \.sw-map \*[^{]*\{animation:none!important/.test(MAP_CSS), 'calm (earlier run) stops all animation')
  const defs = [...SRC.matchAll(/^(?:export\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  const stray = defs.filter(n => !/^(map|Map|MAP_)/.test(n) && n !== 'LiveMap')
  check(stray.length === 0, `top-level names are map/Map/MAP_ prefixed (${defs.length})`, stray.join(', '))
}

// ── layout invariants on every fixture at both widths ──────────────────────
function invariants(name, f, width) {
  const L1 = mapLayout({ units: f.units, files: f.files, width, selected: f.selected, t })
  const L2 = mapLayout({ units: f.units, files: f.files, width, selected: f.selected, t })
  const tag = `${name}@${width}`
  check(JSON.stringify(L1) === JSON.stringify(L2), `${tag}: layout is deterministic`)
  check(L1.width === width && L1.narrow === (width < 460), `${tag}: drawn for its width (narrow=${L1.narrow}, height ${L1.height})`)
  check(L1.agents.length === f.units.length && L1.agents[0].key === 'main' && L1.agents[0].main, `${tag}: main present and first, every unit drawn`)
  const out = L1.agents.filter(a => a.x - a.r - (a.selected ? 7 : 0) < 0 || a.y - a.r - (a.selected ? 7 : 0) < 0 || a.x + a.r + (a.selected ? 7 : 0) > L1.width || a.y + a.r + (a.selected ? 7 : 0) > L1.height)
  check(out.length === 0, `${tag}: every agent (with its selection ring) inside the drawing`, out.map(a => a.key).join(','))
  const must = L1.agents.filter(a => a.main || (a.selected && (a.size === 'ring' || a.parked)))
  check(must.every(a => a.named), `${tag}: main and selected agents carry their names`, must.filter(a => !a.named).map(a => a.key).join(','))
  const lo = L1.leaves.filter(l => l.x - l.r < 0 || l.y - l.r < 0 || l.x + l.r > L1.width || l.y + l.r > L1.height)
  check(lo.length === 0, `${tag}: every leaf inside the drawing`)
  const over = []
  for (let i = 0; i < L1.agents.length; i++) for (let j = i + 1; j < L1.agents.length; j++) {
    const a = L1.agents[i]; const b = L1.agents[j]
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) over.push(`${a.key}/${b.key}`)
  }
  check(over.length === 0, `${tag}: no two agents overlap`, over.slice(0, 5).join(' '))
  const lab = []
  for (let i = 0; i < L1.labels.length; i++) for (let j = i + 1; j < L1.labels.length; j++) if (hit(grow(L1.labels[i].box, 8), L1.labels[j].box)) lab.push(`${label(L1.labels[i])} x ${label(L1.labels[j])}`)
  check(lab.length === 0, `${tag}: labels keep 8px apart, so no two names read as one (${L1.labels.length} labels)`, lab.slice(0, 3).join(' | '))
  const lin = L1.labels.filter(l => l.box.x0 < 0 || l.box.y0 < 0 || l.box.x1 > L1.width || l.box.y1 > L1.height)
  check(lin.length === 0, `${tag}: every label inside the drawing`, lin.map(label).join(' | '))
  const onAgent = []
  for (const l of L1.labels) for (const a of L1.agents) if (hit(l.box, { x0: a.x - a.r, y0: a.y - a.r, x1: a.x + a.r, y1: a.y + a.r })) onAgent.push(`${label(l)} on ${a.key}`)
  check(onAgent.length === 0, `${tag}: no label covers an agent`, onAgent.slice(0, 3).join(' | '))
  const onLeaf = []
  for (const l of L1.labels) for (const f2 of L1.leaves) if (hit(l.box, { x0: f2.x - f2.r, y0: f2.y - f2.r, x1: f2.x + f2.r, y1: f2.y + f2.r })) onLeaf.push(`${label(l)} on ${f2.name}`)
  check(onLeaf.length === 0, `${tag}: no label covers a leaf`, onLeaf.slice(0, 3).join(' | '))
  const byKey = new Map(f.units.map(u => [u.key, u]))
  const wrong = L1.beams.filter(b => { const u = byKey.get(b.from); const leaf = L1.leaves.find(x => x.key === b.to); return !u || u.status !== 'running' || !u.nowPath || !leaf || pathKey(leaf.path) !== pathKey(u.nowPath) })
  check(wrong.length === 0, `${tag}: beams only for running agents with a nowPath, to that file (${L1.beams.length} beams)`)
  const want = []
  if (L1.leaves.some(l => l.isNow)) want.push('now')
  for (const s of ['edit', 'read', 'failed', 'deleted']) if (L1.leaves.some(l => !l.isNow && l.state === s)) want.push(s)
  if (L1.beams.some(b => b.op === 'edit')) want.push('beamEdit')
  if (L1.beams.some(b => b.op === 'read')) want.push('beamRead')
  check(JSON.stringify(L1.legend) === JSON.stringify(want), `${tag}: legend lists only what is drawn (${L1.legend.join(', ')})`)
  const total = new Set(f.files.map(x => pathKey(x.path)).concat(f.units.filter(u => u.status === 'running' && u.nowPath).map(u => pathKey(u.nowPath)))).size
  check(L1.leaves.length <= 30 && L1.hiddenTotal === total - L1.leaves.length && L1.totalFiles === total,
    `${tag}: ${L1.leaves.length} leaves + ${L1.hiddenTotal} hidden = ${total} files`)
  const long = L1.labels.filter(l => l.rows.some(r => r.map(p => p.text).join('').length > 40))
  check(long.length === 0, `${tag}: every label line is capped`, long.map(label).join(' | '))
  return L1
}

for (const width of [680, 380]) {
  for (const [name, f] of Object.entries(fx)) invariants(name, f, width)
}
for (const width of [320, 459, 460, 900]) invariants('real', fx.real, width)

// ── specific promises ───────────────────────────────────────────────────────
{
  const L = mapLayout({ units: fx.real.units, files: fx.real.files, width: 680, selected: 'main', t })
  const leaf = k => L.leaves.find(l => l.name === k)
  check(leaf('old-theme.xaml')?.state === 'deleted' && leaf('App.xaml')?.state === 'failed' && leaf('smoke.py')?.state === 'edit' && leaf('conftest.py')?.state === 'read',
    'leaf states: deleted / failed / edit / read')
  check(leaf('Styles.xaml')?.isNow && leaf('PactMarker.cs')?.isNow && leaf('test_flaky.py')?.isNow && !leaf('smoke.py')?.isNow, 'the leaves being worked on are marked now')
  const pk = L.agents.find(a => a.key === 'sub-checks')
  const fl = L.agents.find(a => a.key === 'sub-xaml')
  check(pk.parked === 'done' && pk.x > L.width * 0.75 && pk.y < L.height * 0.25, 'a finished agent parks at the top-right edge')
  check(fl.parked === 'failed' && fl.x < L.width * 0.25 && fl.y > L.height * 0.75, 'a failed agent parks at the bottom-left')
  check(L.agents.filter(a => !a.parked).every(a => a.size === 'ring') && L.agents.every(a => a.named), 'up to 8 subagents: every agent is a named ring')
  check(L.beams.length === 3 && L.beams.find(b => b.from === 'sub-flaky').op === 'read' && L.beams.find(b => b.from === 'main').op === 'edit', '3 beams: editing solid, reading dotted')
  check(!L.beams.some(b => b.from === 'sub-build'), 'an agent running a command (no file) has no beam')
  const m = L.agents[0]
  check(Math.hypot(m.x - L.root.x, m.y - L.root.y) < L.width, 'main agent drawn on the map')
  const fixNoFail = { units: fx.real.units, files: fx.real.files.filter(x => !x.last_failed && !x.deletes) }
  const L2 = mapLayout({ ...fixNoFail, width: 680, t })
  check(!L2.legend.includes('failed') && !L2.legend.includes('deleted'), 'no failed / deleted files -> legend omits them')
}
{
  const L = mapLayout({ units: fx.swarm.units, files: fx.swarm.files, width: 680, selected: 'run0', t })
  const subs = L.agents.filter(a => !a.main)
  check(subs.filter(a => a.key !== 'run0').every(a => a.size === 'dot'), '40 subagents: every unselected subagent is a dot')
  const names = L.agents.filter(a => a.named)
  check(names.length <= 3 && names.some(a => a.main), `40 subagents: at most 3 names (${names.map(a => a.key).join(', ')})`)
  check(L.leaves.length <= 30, `120 files: ${L.leaves.length} leaves (cap 30)`)
  const sum = L.hidden.reduce((s, h) => s + h.n, 0)
  check(sum === 120 - L.leaves.length, `120 files: '+N older' counts add up (${sum} = 120 - ${L.leaves.length})`)
  const older = L.labels.filter(l => l.kind === 'dir' || l.kind === 'older').map(label).filter(s => /older/.test(s))
  check(older.length >= L.folders.filter(d => d.hidden).length, `every folder hiding files says '+N older' (${older.length})`)
  check(L.legend.includes('now'), 'legend in the swarm keeps what is drawn')
  const L3 = mapLayout({ units: fx.swarm.units, files: fx.swarm.files, width: 380, selected: 'run0', t })
  check(L3.agents.filter(a => a.named).length <= 3, '40 subagents narrow: at most 3 names')
}
{
  const L = mapLayout({ units: fx.long.units, files: fx.long.files, width: 680, selected: 'main', t })
  const lf = L.leaves.find(l => l.path === fx.long.longPath)
  check(!!lf && lf.isNow, '400-character path is drawn as a leaf')
  const lb = L.labels.find(l => l.kind === 'leaf' && l.of === lf.key)
  check(!!lb && lb.rows.length === 1 && label(lb).length <= 25 && label(lb).endsWith('…'), `400-character path label stays one capped line ("${lb && label(lb)}")`)
  const dir = L.labels.find(l => l.kind === 'dir')
  check(!!dir && label(dir).split(' / ')[0].length <= 20, 'its folder label is capped')
  const extra = L.leaves.find(l => /notinfiles\.cs$/i.test(l.path))
  check(!!extra && extra.state === 'read' && extra.isNow, 'an agent working on a path not in files gets its own leaf (state from its act)')
  const nm = L.labels.find(l => l.kind === 'agent' && l.of === 'sub-new')
  check(!nm || label(nm).length <= 22, 'a long agent name is capped')
}

// ── rendering ───────────────────────────────────────────────────────────────
{
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const picked = []
  await act(async () => { root.render(jsx(LiveMap, { t, units: fx.real.units.map(u => ({ ...u, icon: jsx('svg', { 'data-icon': u.icon }) })), files: fx.real.files, selected: 'main', onSelect: k => picked.push(k) })) })
  const map = host.querySelector('div.sw-map')
  check(!!map && map.getAttribute('role') === 'group' && !!map.getAttribute('aria-label'), 'root is div.sw-map role=group with an aria-label')
  const btns = [...host.querySelectorAll('button.sw-magent')]
  check(btns.length === fx.real.units.length && btns[0].dataset.key === 'main', `every agent is a button, main first (${btns.length})`)
  check(btns.every(b => b.dataset.st && b.hasAttribute('aria-pressed') && /: /.test(b.getAttribute('aria-label')) && b.getAttribute('data-tip') !== null),
    'buttons carry data-key, data-st, aria-pressed, aria-label "<name>: <line>" and a Tip')
  check(btns[0].getAttribute('aria-pressed') === 'true' && btns.filter(b => b.getAttribute('aria-pressed') === 'true').length === 1, 'only the selected agent is pressed')
  const build = btns.find(b => b.dataset.key === 'sub-build')
  check(build.getAttribute('data-tip').length <= 300 && !build.getAttribute('data-tip').includes('\n'), 'a 400-char status line tip is capped at 300 chars, one line')
  await act(async () => { btns.find(b => b.dataset.key === 'sub-flaky').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { btns.find(b => b.dataset.key === 'sub-xaml').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  check(JSON.stringify(picked) === '["sub-flaky","sub-xaml"]', `clicking an agent calls onSelect with its key (${picked.join(', ')})`)
  const leaves = [...host.querySelectorAll('g.sw-mleaf')]
  check(leaves.length === 14 && leaves.every(l => l.getAttribute('data-path') && l.getAttribute('data-tip')), `leaves carry data-path and a full-path Tip (${leaves.length})`)
  const beams = [...host.querySelectorAll('path.sw-mbeam')]
  check(beams.length === 3 && beams.filter(b => b.dataset.op === 'edit').length === 2 && beams.filter(b => b.dataset.op === 'read').length === 1, 'beams are SVG path.sw-mbeam with data-op')
  const leg = [...host.querySelectorAll('.sw-mlegend > span')].map(s => s.textContent)
  check(JSON.stringify(leg) === JSON.stringify(['being worked on', 'changed', 'only read', 'edit failed', 'deleted', 'editing', 'reading']), `legend DOM: ${leg.join(' · ')}`)
  const texts = [...host.querySelectorAll('text.sw-mlab')].map(n => n.textContent)
  check(texts.every(s => s.length <= 40), 'every drawn SVG label is one capped line')
  check(!host.innerHTML.includes('sw.map.'), 'no raw copy key reaches the DOM')
  await act(async () => { root.render(jsx(LiveMap, { t, units: fx.swarm.units.map(u => ({ ...u, icon: null })), files: fx.swarm.files, selected: 'run0', onSelect: k => picked.push(k) })) })
  const dots = host.querySelectorAll('button.sw-magent[data-size=dot]')
  check(dots.length === 39, `swarm renders 39 dots + main + selected ring (${dots.length} dots)`)
  check(host.querySelectorAll('g.sw-mleaf').length <= 30, 'swarm renders at most 30 leaves')
  check([...host.querySelectorAll('.sw-mlegend span')].some(s => /most recent of 120 files/.test(s.textContent)), 'the legend says the tree is capped')
  const dot = [...dots].find(b => b.dataset.key === 'run3')
  await act(async () => { dot.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
  check([...host.querySelectorAll('text.sw-mhov')].some(n => n.textContent === 'Save-slot migration'), 'hovering a dot shows its name')
  await act(async () => { root.unmount() })
}

console.log(`\n${passes} PASS · ${fails} FAIL`)
process.exitCode = fails ? 1 : 0
