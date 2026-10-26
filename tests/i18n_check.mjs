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
assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort(), 'Chinese must cover exactly the English keys')
for (const [key, value] of zh) {
  assert.equal(typeof value, typeof en.get(key), `${key}: message type`)
  if (typeof value === 'string') assert.ok(value.trim(), `${key}: not empty`)
  else {
    assert.equal(value.length, en.get(key).length, `${key}: interpolation arity`)
    for (const sample of ['0', '1', '2', 'VALUE']) {
      const out = value(...Array(value.length).fill(sample))
      assert.equal(typeof out, 'string', key)
      assert.ok(!/undefined|NaN|\[object Object\]/.test(out), key)
    }
  }
}
console.log(`I18N: GREEN — ${zh.size} Chinese messages, key/type/argument parity`)
