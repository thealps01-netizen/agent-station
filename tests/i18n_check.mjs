// Translation completeness and interpolation contract; no dependencies, no user data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const start = src.indexOf('const BUNDLES = {')
const end = src.indexOf('// ── pure helpers', start)
const bundles = vm.runInNewContext(src.slice(start, end) + '\nBUNDLES')
function leaves(node, prefix = '') {
  return Object.entries(node).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' ? leaves(v, key) : [[key, v]]
  })
}
const en = new Map(leaves(bundles.en))
const zh = new Map(leaves(bundles.zh))
function checkMarkers(key, english, translated) {
  const args = Array.from({ length: english.length }, (_, i) => `#${i}#`)
  // Languages may reorder arguments, but must preserve each marker and its count.
  const markers = out => (out.match(/#\d+#/g) || []).sort()
  assert.deepEqual(markers(translated(...args)), markers(english(...args)), `${key}: interpolation markers`)
}
function checkScoreLabel(label) {
  // Both markers survive a semantic swap, so also lock the completed/total meaning.
  assert.equal(label(2, 5), '5 个子智能体中已有 2 个完成', 'sw.score.label: completed/total meaning')
}
assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort(), 'Chinese must cover exactly the English keys')
for (const [key, value] of zh) {
  assert.equal(typeof value, typeof en.get(key), `${key}: message type`)
  if (typeof value === 'string') assert.ok(value.trim(), `${key}: not empty`)
  else {
    assert.equal(value.length, en.get(key).length, `${key}: interpolation arity`)
    checkMarkers(key, en.get(key), value)
    for (const sample of ['0', '1', '2', 'VALUE']) {
      const out = value(...Array(value.length).fill(sample))
      assert.equal(typeof out, 'string', key)
      assert.ok(!/undefined|NaN|\[object Object\]/.test(out), key)
    }
  }
}
checkScoreLabel(zh.get('sw.score.label'))

// Negative controls: the review's dropped argument and semantic swap must fail;
// duplicating a marker must fail too. Only in-memory functions are changed.
assert.throws(() => checkMarkers('sw.tabs.running', en.get('sw.tabs.running'), n => '条命令运行中'), /interpolation markers/)
assert.throws(() => checkMarkers('sw.tabs.running', en.get('sw.tabs.running'), n => `${n} ${n} 条命令运行中`), /interpolation markers/)
const scoreLabel = zh.get('sw.score.label')
assert.throws(() => checkScoreLabel((done, total) => scoreLabel(total, done)), /completed\/total meaning/)
console.log(`I18N: GREEN — ${zh.size} Chinese messages, key/type/argument/marker parity, 3 negative controls`)
