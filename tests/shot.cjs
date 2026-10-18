/**
 * Renders the Agent Station preview in the REAL engine (the app's own Electron = Chromium), writes a
 * PNG and runs the WCAG contrast gate on real pixels.
 *
 * Why: jsdom (render_check, preview.mjs) proves structure, never colour or layout. This is the only
 * gate with a real engine: every text node is measured — computed ink alpha-composited over the ground
 * it really sits on — and the WCAG 2.x ratio decides. Normal text needs 4.5:1, large text 3:1.
 *   gated     `reading` ink (alpha >= 0.7) and `tone-as-text` (a --ui-green/yellow/red/blue used as the
 *             ink of text that does not sit on its own tone) — exit 1 below the threshold.
 *   reported  `chip` (ink on its own tone) and `quiet` (the host's faint ladder, owned by the theme).
 * It also fails on any ERROR the page logs in the engine, and on a clipped status label.
 *
 * COVERAGE: the preview must hold all eleven screens of the approved design in every look (now only
 * Terminal) — a screen missing in any look is RED, so a dropped frame cannot pass quietly. Every
 * frame of every look is measured; the narrow (380 px) frames must not scroll sideways either.
 *
 * The in-page contrast rule lives in measure.cjs (shared with live.cjs, the real-panel harness).
 *
 * Usage (from tests/):  node preview.mjs && <electron> shot.cjs preview.html preview.png
 *   <electron> = $HERMES_ELECTRON, or <core>/apps/desktop/node_modules/electron/dist/electron(.exe)
 * Output: one PNG per look — <out> (Terminal, the one the README shows; any further look <out>-<look>.png) — plus
 * <out>.measure.json and <out>.contrast.json beside them (both git-ignored).
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { PAGE } = require('./measure.cjs')

const [htmlArg, outArg] = process.argv.slice(2)
const htmlPath = htmlArg || path.join(__dirname, 'preview.html')
const outPath = outArg || path.join(__dirname, 'preview.png')
const WIDTH = 1340 // room for two 640 px look columns side by side
const SHOT_WIDTH = 690 // one look per PNG
const SCREENS = 12
const LOOKS = ['terminal']

app.disableHardwareAcceleration()

const PREPARE = `(() => {
  // WCAG contrast: measure.cjs, shared with live.cjs
  const ct = window.__swMeasure.contrast(document.body)
  // A status label or a duration that clips its own text is a layout bug, not a style choice.
  const clipped = [...document.querySelectorAll('.sw-meta, .sw-us, .sw-cmx, .sw-mrx, .sw-fl, .sw-sbn')]
    .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')
    .map(el => (el.className + ' [' + (el.textContent || '').slice(0, 24) + ']'))
  // LAYOUT: nothing inside a frame may be wider than the frame (a horizontal scrollbar on the page),
  // and the header's pieces must not paint over each other or wrap a pill onto two lines.
  // Content inside a box that scrolls sideways (its own scrollbar) and itself fits (a diff's long line, a row of
  // step marks) moves that box's scrollbar, not the page's; the box is measured instead. A box that
  // only hides its overflow (the panel) is no excuse: hidden content is clipped content.
  const insideClip = (el, f, edge) => {
    for (let p = el.parentElement; p && p !== f && !p.classList.contains('sw-page') && !p.classList.contains('sw-bd'); p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll') return p.getBoundingClientRect().right <= edge
    }
    return false
  }
  const overflow = [...document.querySelectorAll('.swp-frame')].flatMap((f, i) => {
    const edge = f.getBoundingClientRect().right + 0.5
    return [...f.querySelectorAll('*')]
      .filter(el => el.getBoundingClientRect().right > edge && getComputedStyle(el).display !== 'none' && !insideClip(el, f, edge))
      .filter(el => !el.parentElement || el.parentElement.getBoundingClientRect().right <= edge)
      .map(el => 'frame ' + (i + 1) + ' .' + String(el.className).split(' ')[0] + ' ends '
        + Math.round(el.getBoundingClientRect().right - edge + 0.5) + 'px past the frame')
  })
  const overlaps = []
  for (const hd of document.querySelectorAll('.sw-hd')) {
    const kids = [...hd.children].map(el => ({ el, r: el.getBoundingClientRect() })).filter(k => k.r.width > 0)
    for (let a = 0; a < kids.length; a++) {
      for (let b = a + 1; b < kids.length; b++) {
        const x = kids[a].r, y = kids[b].r
        if (x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1) {
          overlaps.push('.' + String(kids[a].el.className).split(' ')[0] + ' overlaps .' + String(kids[b].el.className).split(' ')[0])
        }
      }
    }
    // A box can keep its size while its text spills out of it: measure the TEXT, not the box.
    for (const pill of hd.querySelectorAll('.sw-tg')) {
      // Text nodes only: the icon sits on its own baseline and is not a second line.
      const lines = new Set()
      const walk = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const r of range.getClientRects()) if (r.width > 0) lines.add(Math.round(r.top))
      }
      if (lines.size > 1) overlaps.push('header tag wraps onto ' + lines.size + ' lines: [' + pill.textContent + ']')
    }
    for (const el of hd.querySelectorAll('.sw-ht')) {
      const cs = getComputedStyle(el)
      if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') {
        overlaps.push('the title spills ' + (el.scrollWidth - el.clientWidth) + 'px under its neighbours')
      }
    }
  }
  // A model chip is never cut: its whole text (model and reasoning effort) fits in its box.
  const chips = [...document.querySelectorAll('.swp-frame .sw-model')]
    .filter(el => getComputedStyle(el).display !== 'none')
    .map(el => ({ text: el.textContent, narrow: !!el.closest('.is-narrow'), cut: el.scrollWidth > el.clientWidth }))
  // Which screen is drawn in which look (preview.mjs tags every frame).
  const coverage = [...document.querySelectorAll('.swp-wrap[data-screen][data-look]')]
    .map(el => el.dataset.look + ':' + el.dataset.screen)
  return {
    coverage,
    chips,
    frames: document.querySelectorAll('.swp-frame').length,
    overflow,
    overlaps,
    rawKeyOnScreen: (document.body.textContent || '').match(/\\\\bsw\\\\.[a-z][a-zA-Z.]*/g),
    clipped,
    contrast: ct
  }
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: WIDTH, height: 900, show: false, backgroundColor: '#0b0b0d' })
  const problems = []
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) problems.push(`${level === 3 ? 'ERROR' : 'WARN'} ${message} (${source}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`render-process-gone: ${JSON.stringify(d)}`))
  await win.loadFile(htmlPath)
  await new Promise(r => setTimeout(r, 1500))
  await win.webContents.executeJavaScript(PAGE)
  const measured = await win.webContents.executeJavaScript(PREPARE)
  measured.console = problems
  fs.writeFileSync(outPath.replace(/\.png$/i, '.measure.json'), JSON.stringify(measured, null, 1))
  // One PNG per look: the other column is hidden, the window narrowed to one column.
  const shots = []
  for (const look of LOOKS) {
    const file = look === 'terminal' ? outPath : outPath.replace(/\.png$/i, `-${look}.png`)
    await win.webContents.executeJavaScript(`(() => { let s = document.getElementById('swp-only'); if (!s) { s = document.createElement('style'); s.id = 'swp-only'; document.head.appendChild(s) }
      s.textContent = '.swp-col:not([data-col=${look}]){display:none}'; return 0 })()`)
    win.setContentSize(SHOT_WIDTH, 900)
    await new Promise(r => setTimeout(r, 300))
    const height = await win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight) + 20')
    win.setContentSize(SHOT_WIDTH, Math.min(16000, height))
    await new Promise(r => setTimeout(r, 900))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(file, image.toPNG())
    shots.push(file)
    console.log('PNG:', file, fs.statSync(file).size, 'bytes · content height', height, height > 16000 ? '(cut at 16000)' : '')
  }
  console.log('frames', measured.frames)

  const ct = measured.contrast
  fs.writeFileSync(outPath.replace(/\.png$/i, '.contrast.json'), JSON.stringify(ct, null, 1))
  const lowest = ct.lowestGated
  console.log(`CONTRAST: ${ct.count} text nodes · gated ${ct.classes.gated} · chip ${ct.classes.chip} (reported)`
    + ` · quiet ${ct.classes.quiet} (reported) · tone-as-text ${ct.classes.toneAsText}`)
  console.log(`  lowest gated ${lowest ? `${lowest.ratio}:1 need ${lowest.need} .${lowest.sel} [${lowest.text}]` : '—'}`)

  const red = []
  for (const row of ct.violations) {
    red.push(`contrast ${row.ratio}:1 < ${row.need}:1 for .${row.sel} [${row.text}] ${row.px}px/${row.weight}`
      + ` (${row.klass}) ink ${row.ink} a${row.inkAlpha} on ${row.fill}`)
  }
  if (!ct.rows.length) red.push('no text node was measured')
  for (const look of LOOKS) {
    for (let s = 1; s <= SCREENS; s++) {
      if (!measured.coverage.includes(`${look}:${s}`)) red.push(`screen ${s} is missing in the ${look} look`)
    }
  }
  if (measured.frames < SCREENS * LOOKS.length) red.push(`expected at least ${SCREENS * LOOKS.length} preview frames, found ${measured.frames}`)
  for (const c of measured.chips.filter(c => c.cut)) red.push(`model chip cut: [${c.text}]`)
  if (!measured.chips.some(c => / · medium$/.test(c.text))) {
    red.push(`no uncut model chip with its effort (${measured.chips.map(c => c.text).join(' | ') || 'none'})`)
  }
  for (const o of measured.overflow) red.push(`horizontal overflow: ${o}`)
  for (const o of measured.overlaps) red.push(`header: ${o}`)
  if (measured.rawKeyOnScreen) red.push(`raw i18n key on screen: ${measured.rawKeyOnScreen.join(', ')}`)
  for (const c of measured.clipped) red.push(`clipped text: ${c}`)
  const engineErrors = measured.console.filter(line => !line.startsWith('WARN'))
  if (engineErrors.length) red.push(`engine errors: ${engineErrors.join(' | ')}`)
  for (const line of red) console.error(`SHOT GATE RED: ${line}`)
  if (red.length) {
    console.error(`SHOT GATE: RED (${red.length} violation(s))`)
    app.exit(1)
    return
  }
  console.log(`SHOT GATE: GREEN — ${SCREENS} screens × ${LOOKS.length} looks (${measured.frames} frames), ${ct.classes.gated} gated text node(s) at or above WCAG AA, nothing clipped, engine errors 0`)
  app.quit()
}).catch(e => { console.error('ERROR:', e); app.exit(1) })
