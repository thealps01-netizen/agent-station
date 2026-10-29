/**
 * The in-page measuring code of the real-engine gates, kept once: `shot.cjs` (the jsdom preview in
 * Electron) and `live.cjs` (the real panel in Electron) both inject `PAGE` and call `window.__swMeasure`.
 *
 * Why: jsdom proves structure, never layout or colour. These rules read what the engine really drew;
 * each returns rows that name the selector and the text, so a violation says where to look.
 *
 *   contrast(root)   WCAG 2.x ratio of every text node, ink composited over the ground it sits on.
 *                    `reading` ink (alpha >= 0.7) and `tone-as-text` (a --ui-green/yellow/red/blue used
 *                    as the ink of text not on its own tone) are gated at 4.5:1 (3:1 large); `chip`
 *                    and `quiet` are reported only. (M6)
 *   clipped()        M1 a visible text cut by its own box or a clipping ancestor. Exempt: an ellipsis
 *                    cut, rows scrolled out of a scroll box (that is M4), `.sw-sr` screen-reader text
 *                    and a line-clamped block (its own ellipsis).
 *   overlap()        M2 text boxes of two different elements in one HUD panel (`.sw-hp`) intersect by
 *                    more than 1 px.
 *   sideways()       M3 anything ends past the page's right edge (content a sideways scroll box holds
 *                    is that box's, not the page's).
 *   halfRows()       M4 at scroll position 0, a scroll box with more content than it shows cuts a row,
 *                    or a line of a wrapped row, with its bottom edge.
 *   numerals()       M5 a text whose whole text is a value (count, ratio, cost, percentage, tokens,
 *                    duration, clock time) is not in the `--code` family with tabular-nums; and two
 *                    values of one font size carry different text-shadows.
 *
 * Vertical text extents use the em box (the line's centre ± half the font size), not the font's
 * ascent/descent box: a 28 px number at line-height 1 has a 33 px content box that no clip ever cuts.
 */
'use strict'

function pageLib() {
  const css = new Map()
  const style = el => { let s = css.get(el); if (!s) { s = getComputedStyle(el); css.set(el, s) } return s }
  const selOf = el => {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className.split(/\s+/).filter(c => c.startsWith('sw-')).slice(0, 2).join('.') : ''
      parts.unshift(cls ? '.' + cls : n.tagName.toLowerCase())
      if (cls) break
    }
    return parts.join(' > ')
  }
  const textOf = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').replace(/\s+/g, ' ').trim()
  const shown = el => {
    // checkVisibility also sees the content of a closed <details> (hidden by content-visibility)
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = style(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    }
    return true
  }
  // visually hidden screen-reader text: the .sw-sr class, or the same pattern (a 1 px box clipped away)
  const exemptSr = el => {
    if (el.closest('.sw-sr')) return true
    const s = style(el), r = el.getBoundingClientRect()
    return (s.clipPath && s.clipPath !== 'none' && /inset\(50%/.test(s.clipPath)) || (r.width <= 1 && r.height <= 1)
  }
  // the em box of one line rect: its centre ± half the font size
  const em = (r, px) => { const mid = (r.top + r.bottom) / 2; return { left: r.left, right: r.right, top: mid - px / 2, bottom: mid + px / 2 } }
  const lineRects = (node, px) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5).map(r => em(r, px))
  }
  const textNodes = el => [...el.childNodes].filter(n => n.nodeType === 3 && (n.nodeValue || '').trim())
  const clips = s => s.overflowX !== 'visible' || s.overflowY !== 'visible'
  const scrollsY = s => s.overflowY === 'auto' || s.overflowY === 'scroll'
  const scrollsX = s => s.overflowX === 'auto' || s.overflowX === 'scroll'
  // the padding box on screen: client sizes are untransformed, so scale them by the element's own
  // on-screen scale (a scaleX animation or transform would otherwise let text past the clip)
  const box = a => {
    const r = a.getBoundingClientRect()
    const sx = a.offsetWidth ? r.width / a.offsetWidth : 1, sy = a.offsetHeight ? r.height / a.offsetHeight : 1
    const left = r.left + a.clientLeft * sx, top = r.top + a.clientTop * sy
    return { left, top, right: left + a.clientWidth * sx, bottom: top + a.clientHeight * sy }
  }
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
  const empty = r => r.right - r.left <= 0.5 || r.bottom - r.top <= 0.5
  const scope = () => document.querySelector('.sw-page') || document.body
  const texts = root => [root, ...root.querySelectorAll('*')].filter(el => textNodes(el).length && shown(el) && !exemptSr(el))
  // what of a rect is left after every clipping ancestor (scroll boxes included)
  const visible = (el, r) => {
    let v = r
    for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (clips(style(a))) v = meet(v, box(a))
    return v
  }

  // ── M6 contrast (shot.cjs's rule, unchanged) ─────────────────────────────────────────────────
  const parseColor = value => {
    const v = String(value || '').trim()
    let m = v.match(/^rgba?\(([^)]+)\)$/i)
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }
    m = v.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/i)
    if (m) {
      const al = m[4] === undefined ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : Number(m[4]))
      return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a: al }
    }
    return null
  }
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 })
  // What the eye sees UNDER the text: every semi-transparent ancestor ground, composited down to the
  // first opaque one (the page ground is opaque, so this terminates).
  const fillUnder = el => {
    const stack = []
    for (let n = el; n; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 }
    let used = 0
    if (stack.length && stack[stack.length - 1].a >= 0.999) { base = stack[stack.length - 1]; used = 1 }
    for (let i = stack.length - 1 - used; i >= 0; i -= 1) base = over(stack[i], base)
    return base
  }
  // The nearest PAINTED fill (the node's own or the first ancestor that paints one): the surface the
  // ink sits ON. A tone tint keeps the tone's channels and only scales its alpha, so an exact channel
  // comparison tells whether the ink is painted over its own tone or over a neutral ground.
  const paintUnder = el => {
    for (let n = el; n; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) return c
    }
    return null
  }
  const chan = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  const lum = c => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
  const ratio = (f, b) => Math.round(((Math.max(lum(f), lum(b)) + 0.05) / (Math.min(lum(f), lum(b)) + 0.05)) * 100) / 100
  const rgbText = c => 'rgb(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ')'
  const same = (a, b) => Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2
  const token = name => {
    const probeEl = document.createElement('span')
    document.body.appendChild(probeEl)
    probeEl.style.color = 'var(' + name + ')'
    const v = getComputedStyle(probeEl).color
    probeEl.remove()
    return v
  }
  function contrast(root) {
    const TONES = {
      green: parseColor(token('--ui-green')),
      yellow: parseColor(token('--ui-yellow')),
      red: parseColor(token('--ui-red')),
      blue: parseColor(token('--ui-blue'))
    }
    const readingToken = token('--ui-text-primary')
    const toneName = c => {
      for (const [name, t] of Object.entries(TONES)) if (t && same(c, t)) return name
      return null
    }
    const textRows = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const own = [...el.childNodes]
        .filter(n => n.nodeType === 3 && (n.nodeValue || '').trim())
        .map(n => n.nodeValue.trim()).join(' ')
      if (!own) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const ink = parseColor(cs.color)
      if (!ink || ink.a === 0) continue
      const bg = fillUnder(el)
      const paint = paintUnder(el)
      const seen = ink.a >= 0.999 ? ink : over(ink, bg)
      const px = parseFloat(cs.fontSize)
      const bold = parseInt(cs.fontWeight, 10) >= 700
      const large = px >= 18.7 || (px >= 14 && bold)
      const need = large ? 3 : 4.5
      const r = ratio(seen, bg)
      const tone = toneName(ink)
      const onOwnTone = tone ? Boolean(paint) && same(paint, ink) : null
      const klass = !tone ? (ink.a >= 0.7 ? 'reading' : 'quiet') : (onOwnTone ? 'chip' : 'tone-as-text')
      textRows.push({
        sel: (typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '') || el.tagName.toLowerCase(),
        text: own.slice(0, 22),
        ink: rgbText(ink),
        inkAlpha: Math.round(ink.a * 100) / 100,
        fill: rgbText(bg),
        px,
        weight: String(cs.fontWeight),
        large,
        need,
        ratio: r,
        tone,
        klass,
        pass: klass === 'chip' || klass === 'quiet' ? null : r >= need
      })
    }
    textRows.sort((a, b) => a.ratio - b.ratio)
    const gated = textRows.filter(x => x.pass !== null)
    return {
      rows: textRows,
      count: textRows.length,
      classes: {
        gated: gated.length,
        chip: textRows.filter(x => x.klass === 'chip').length,
        quiet: textRows.filter(x => x.klass === 'quiet').length,
        toneAsText: textRows.filter(x => x.klass === 'tone-as-text').length
      },
      violations: textRows.filter(x => x.pass === false),
      lowestGated: gated.length ? gated[0] : null,
      readingToken
    }
  }

  // ── M1 clipped ───────────────────────────────────────────────────────────────────────────────
  function clipped(root = scope()) {
    const out = []
    for (const el of texts(root)) {
      if (el.closest('svg')) continue
      const px = parseFloat(style(el).fontSize)
      const rects = textNodes(el).flatMap(n => lineRects(n, px))
      if (!rects.length) continue
      let ellipsis = false, clamp = false, cut = null
      for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const s = style(a)
        if (s.textOverflow === 'ellipsis') ellipsis = true
        if (s.webkitLineClamp && s.webkitLineClamp !== 'none') clamp = true
        if (!clips(s)) continue
        const b = box(a)
        // a row a scroll box has scrolled out of view is that box's business (M4), not a clip
        if ((scrollsY(s) && rects.every(r => r.bottom <= b.top + 1 || r.top >= b.bottom - 1)) ||
            (scrollsX(s) && rects.every(r => r.right <= b.left + 1 || r.left >= b.right - 1))) break
        for (const r of rects) {
          const sideways = r.left < b.left - 1 || r.right > b.right + 1
          const vertical = r.top < b.top - 1 || r.bottom > b.bottom + 1
          if (sideways && !ellipsis && !scrollsX(s)) cut = cut || { by: a, how: 'sideways' }
          if (vertical && !clamp && !scrollsY(s)) cut = cut || { by: a, how: 'vertically' }
        }
        if (cut) break
      }
      if (cut) out.push({ rule: 'M1', sel: selOf(el), text: textOf(el).slice(0, 40), detail: `cut ${cut.how} by ${cut.by === el ? 'its own box' : selOf(cut.by)}` })
    }
    return out
  }

  // ── M2 overlap ───────────────────────────────────────────────────────────────────────────────
  function overlap(root = scope()) {
    const out = []
    for (const panel of root.querySelectorAll('.sw-hp')) {
      if (!shown(panel)) continue
      const items = []
      for (const el of texts(panel)) {
        const px = parseFloat(style(el).fontSize)
        for (const n of textNodes(el)) for (const r of lineRects(n, px)) {
          const v = visible(el, r)
          if (!empty(v)) items.push({ el, r: v })
        }
      }
      const said = new Set()
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j]
          if (a.el === b.el) continue
          const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
          const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
          if (w > 1 && h > 1) {
            const key = selOf(a.el) + '|' + selOf(b.el) + '|' + textOf(a.el) + '|' + textOf(b.el)
            if (said.has(key)) continue
            said.add(key)
            const box = e => { const q = e.getBoundingClientRect(); return `${Math.round(q.left)}–${Math.round(q.right)}` }
            const span = q => `${Math.round(q.left)}–${Math.round(q.right)}`
            out.push({ rule: 'M2', sel: `${selOf(a.el)} × ${selOf(b.el)}`, text: `${textOf(a.el).slice(0, 24)} × ${textOf(b.el).slice(0, 24)}`, detail: `${Math.round(w)}×${Math.round(h)} px (text x ${span(a.r)} / ${span(b.r)}, boxes x ${box(a.el)} / ${box(b.el)})` })
          }
        }
      }
    }
    return out
  }

  // ── M3 sideways ──────────────────────────────────────────────────────────────────────────────
  function sideways(root = scope()) {
    const edge = document.documentElement.clientWidth + 0.5
    const past = el => {
      if (!shown(el)) return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) return false
      // a sideways scroll box that fits holds its own content
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) if (scrollsX(style(a))) return false
      return visible(el, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }).right > edge
    }
    const out = []
    for (const el of root.querySelectorAll('*')) {
      if (!past(el) || (el.parentElement && el.parentElement !== root && past(el.parentElement))) continue
      out.push({ rule: 'M3', sel: selOf(el), text: (el.textContent || '').trim().slice(0, 30), detail: `ends ${Math.round(el.getBoundingClientRect().right - edge + 0.5)} px past the page` })
    }
    return out
  }

  // ── M4 half row ──────────────────────────────────────────────────────────────────────────────
  function halfRows(root = scope()) {
    const out = []
    for (const sb of root.querySelectorAll('*')) {
      const s = style(sb)
      if (!scrollsY(s) || sb.scrollHeight <= sb.clientHeight + 1 || !shown(sb)) continue
      if (sb.scrollTop) sb.scrollTop = 0
      const edge = box(sb).bottom
      let rows = [...sb.children]
      while (rows.length === 1 && rows[0].children.length) rows = [...rows[0].children]
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        if (!(r.top < edge - 1 && r.bottom > edge + 1)) continue
        const lines = [row, ...row.querySelectorAll('*')].flatMap(el => {
          const px = parseFloat(style(el).fontSize)
          return textNodes(el).flatMap(n => lineRects(n, px))
        })
        const tops = new Set(lines.map(l => Math.round(l.top)))
        const lineCut = lines.some(l => l.top < edge - 1 && l.bottom > edge + 1)
        if (tops.size <= 1 || lineCut) {
          out.push({ rule: 'M4', sel: selOf(sb), text: (row.textContent || '').trim().slice(0, 40), detail: `row ${Math.round(r.top - box(sb).top)}–${Math.round(r.bottom - box(sb).top)} px cut at ${Math.round(edge - box(sb).top)} px` })
          break
        }
      }
    }
    return out
  }

  // ── M5 numerals ──────────────────────────────────────────────────────────────────────────────
  // a value: count, ratio, cost, percentage, token count, duration, clock time, step number
  const VALUE = new RegExp('^(?:' + [
    '[~≈]?[+\\-−]?[$€£]?\\d[\\d,.]*\\s?(?:[kKMB]|%)?',
    '\\/\\s?\\d+',
    '\\d+\\s?\\/\\s?\\d+',
    '#\\d+',
    '\\d{1,2}:\\d{2}(?::\\d{2})?',
    '(?:\\d+(?:\\.\\d+)?\\s?(?:ms|s|m|h|d)\\s*){1,3}'
  ].join('|') + ')$')
  const isValue = text => VALUE.test(text)
  function numerals(root = scope()) {
    const probe = document.createElement('span')
    probe.style.fontFamily = 'var(--code)'
    root.appendChild(probe)
    const code = getComputedStyle(probe).fontFamily
    probe.remove()
    const out = []
    const bySize = new Map()
    for (const el of texts(root)) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!isValue(text)) continue
      const s = style(el)
      if (s.fontFamily !== code || !/tabular-nums/.test(s.fontVariantNumeric)) {
        out.push({ rule: 'M5', sel: selOf(el), text, detail: `font ${s.fontFamily.split(',')[0]} / ${s.fontVariantNumeric}, want ${code.split(',')[0]} / tabular-nums` })
      }
      const px = Math.round(parseFloat(s.fontSize) * 10) / 10
      if (!bySize.has(px)) bySize.set(px, new Map())
      const shadows = bySize.get(px)
      if (!shadows.has(s.textShadow)) shadows.set(s.textShadow, { sel: selOf(el), text })
    }
    for (const [px, shadows] of bySize) {
      if (shadows.size < 2) continue
      const seen = [...shadows.entries()].map(([sh, x]) => `${x.sel} [${x.text}] ${sh === 'none' ? 'no glow' : 'glow'}`)
      out.push({ rule: 'M5', sel: [...shadows.values()].map(x => x.sel).join(' vs '), text: [...shadows.values()].map(x => x.text).join(' vs '), detail: `${px}px values with ${shadows.size} different text-shadows: ${seen.join(' | ')}` })
    }
    return out
  }

  // ── M6 as a violation list (contrast's gated rows below their threshold) ────────────────────────
  function contrastViolations(root = document.body) {
    return contrast(root).violations.map(row => ({
      rule: 'M6', sel: '.' + row.sel, text: row.text,
      detail: `${row.ratio}:1 < ${row.need}:1 (${row.klass}) ink ${row.ink} a${row.inkAlpha} on ${row.fill}`
    }))
  }

  // ── M8 narrow ────────────────────────────────────────────────────────────────────────────────
  // the panel fills the content box of its page: a max-width cap (560 px until 1.1.9, 860 px again in
  // the two-look page) left empty bands beside it on a wide pane, and no shot measured it
  function narrow(root = scope()) {
    const panel = root.querySelector(':scope > .sw-panel')
    if (!panel) return []
    const s = style(root), k = root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1
    const want = (root.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) * k
    const got = panel.getBoundingClientRect().width
    return got < want - 2 ? [{ rule: 'M8', sel: selOf(panel), text: '', detail: `${Math.round(got)} px wide in a ${Math.round(want)} px page` }] : []
  }

  window.__swMeasure = { contrast, clipped, overlap, sideways, halfRows, numerals, contrastViolations, narrow, isValue,
    all: () => [...clipped(), ...overlap(), ...sideways(), ...halfRows(), ...numerals(), ...contrastViolations(), ...narrow()] }
  return true
}

/** The code to run in a page (executeJavaScript) before calling `window.__swMeasure.*`. */
const PAGE = `(${pageLib.toString()})()`

module.exports = { PAGE }
