// Fixtures for livemap_check.mjs: realistic runs (a working main agent, editing / reading / running
// subagents, done and failed ones), a 40-agent swarm, 120 files and a 400-character path.
function mapFixtures() {
  const R = 'D:\\dev\\Nox\\'
  const at = 1760000000
  const file = (rel, o = {}) => ({
    key: (R + rel).replace(/\\/g, '/').toLowerCase(), path: R + rel, reads: 1, writes: 0, deletes: 0, failed: 0,
    who: [''], editors: [], last_op: 'read', last_failed: false, first_at: at, last_at: at + (o.ago != null ? 1000 - o.ago : 0), ...o
  })
  const longCmd = 'python - <<EOF ' + 'p = map.html; s = open(p, encoding=utf-8).read(); s = s.replace(a, b); '.repeat(5) + 'timeout 100 electron.exe shoot-map.cjs | grep -v -i gpu && node build.mjs --release --verbose'
  const cmd400 = (longCmd + ' --flag'.repeat(60)).slice(0, 400)

  const files = [
    file('src\\Themes\\Styles.xaml', { writes: 7, editors: [''], last_op: 'write', ago: 1 }),
    file('src\\Themes\\Dark.xaml', { ago: 30 }),
    file('src\\Themes\\Theme.cs', { ago: 40 }),
    file('src\\Themes\\old-theme.xaml', { deletes: 1, last_op: 'delete', editors: [''], ago: 50 }),
    file('src\\Views\\SettingsView.xaml', { writes: 3, editors: ['s-xaml'], who: ['s-xaml'], last_op: 'write', ago: 60 }),
    file('src\\Views\\MainWindow.xaml', { reads: 3, ago: 70 }),
    file('src\\Views\\Home.xaml', { ago: 80 }),
    file('tests\\test_flaky.py', { who: ['s-flaky'], ago: 5 }),
    file('tests\\conftest.py', { ago: 90 }),
    file('tests\\smoke.py', { writes: 2, editors: [''], last_op: 'write', ago: 20 }),
    file('tests\\pact.py', { ago: 100 }),
    file('src\\App.xaml', { writes: 1, failed: 1, last_failed: true, last_op: 'write', ago: 25 }),
    file('src\\PactMarker.cs', { writes: 4, editors: ['s-pact'], who: ['s-pact'], last_op: 'write', ago: 3 }),
    file('src\\App.xaml.cs', { ago: 110 })
  ]
  const units = [
    { key: 'main', main: true, name: 'Main agent', status: 'running', act: 'edit', who: '', nowPath: R + 'src\\Themes\\Styles.xaml', line: 'editing src/Themes/Styles.xaml', icon: 'edit' },
    { key: 'sub-pact', main: false, name: 'Pact weapon marker', status: 'running', act: 'edit', who: 's-pact', nowPath: R + 'src\\PactMarker.cs', line: 'editing src/PactMarker.cs · 9m 13s', icon: 'edit' },
    { key: 'sub-flaky', main: false, name: 'Flaky test cause', status: 'running', act: 'read', who: 's-flaky', nowPath: R + 'tests\\test_flaky.py', line: 'reading tests/test_flaky.py · 3m 05s', icon: 'read' },
    { key: 'sub-build', main: false, name: 'Release build check', status: 'running', act: 'run', who: 's-build', nowPath: '', line: 'running a command ' + cmd400 + ' · 1m 35s', icon: 'run' },
    { key: 'sub-checks', main: false, name: 'Two desktop checks', status: 'completed', act: null, who: 's-checks', nowPath: '', line: 'done · 5m 12s', icon: 'ok' },
    { key: 'sub-xaml', main: false, name: 'Repeated XAML', status: 'failed', act: null, who: 's-xaml', nowPath: '', line: 'failed · 1h 20m', icon: 'bad' }
  ]

  // 40 subagents, 120 files in 10 folders
  const folders = ['src\\Inventory', 'src\\Combat', 'src\\UI', 'src\\Save', 'tests\\Unit', 'tests\\Play', 'tools', 'docs', 'src\\Net', 'assets\\Data']
  const many = []
  for (let i = 0; i < 120; i++) {
    const f = folders[i % folders.length]
    const kind = i % 7 === 0 ? { writes: 2, editors: ['w' + i], last_op: 'write' } : i % 23 === 0 ? { last_failed: true, writes: 1, last_op: 'write' } : {}
    many.push(file(`${f}\\File${String(i).padStart(3, '0')}.cs`, { ...kind, ago: i * 3 }))
  }
  const swarm = [{ key: 'main', main: true, name: 'Main agent', status: 'running', act: 'wait', who: '', nowPath: '', line: 'waiting on 28 subagents', icon: 'wait' }]
  const names = ['Inventory unit tests', 'Fix the inventory sort order', 'Combat damage rounding', 'Save-slot migration', 'HUD ammo counter', 'Unit tests for loot tables', 'Play test: boss arena', 'Tooltip spacing', 'Docs: modding guide', 'Combo input buffer', 'Autosave timer', 'Localise item names']
  for (let i = 0; i < 12; i++) {
    const p = many[i * 2].path
    swarm.push({ key: 'run' + i, main: false, name: names[i], status: 'running', act: i % 2 ? 'read' : 'edit', who: 'r' + i, nowPath: i === 11 ? '' : p, line: (i % 2 ? 'reading ' : 'editing ') + p.split('\\').pop() + ' · 3m 10s', icon: i % 2 ? 'read' : 'edit' })
  }
  for (let i = 0; i < 16; i++) swarm.push({ key: 'q' + i, main: false, name: 'Queued task number ' + i, status: 'queued', act: null, who: 'q' + i, nowPath: '', line: 'waiting to start', icon: 'wait' })
  for (let i = 0; i < 9; i++) swarm.push({ key: 'd' + i, main: false, name: 'Finished task ' + i, status: 'completed', act: null, who: 'd' + i, nowPath: '', line: 'done · 4m', icon: 'ok' })
  for (let i = 0; i < 3; i++) swarm.push({ key: 'f' + i, main: false, name: 'Failed task ' + i, status: i === 2 ? 'stopped' : 'failed', act: null, who: 'f' + i, nowPath: '', line: 'failed · 12m 40s', icon: i === 2 ? 'stop' : 'bad' })

  // a 400-character path being edited
  const deep = 'D:\\dev\\' + Array.from({ length: 16 }, (_, i) => 'segment' + String(i).padStart(2, '0')).join('\\')
  const longPath = (deep + '\\' + 'a_very_long_file_name_'.repeat(20)).slice(0, 396) + '.cs'
  const longFiles = [file('src\\Themes\\Styles.xaml', { ago: 5 }), { ...file('x', {}), key: longPath.replace(/\\/g, '/').toLowerCase(), path: longPath, writes: 1, editors: [''], last_op: 'write' }]
  const longUnits = [
    { key: 'main', main: true, name: 'Main agent', status: 'running', act: 'edit', who: '', nowPath: longPath, line: 'editing ' + longPath, icon: 'edit' },
    { key: 'sub-new', main: false, name: 'A subagent with an extremely long name that never ends in this panel at all', status: 'running', act: 'read', who: 's-new', nowPath: R + 'src\\NotInFiles.cs', line: 'reading src/NotInFiles.cs', icon: 'read' }
  ]

  return {
    real: { units, files, selected: 'main', cmd400 },
    swarm: { units: swarm, files: many, selected: 'run0' },
    long: { units: longUnits, files: longFiles, selected: 'main', longPath },
    calm: {
      units: [
        { key: 'main', main: true, name: 'Main agent', status: 'idle', act: null, who: '', nowPath: '', line: 'waited for 3 subagents', icon: 'idle' },
        { key: 'c1', main: false, name: 'Audit fleet-routing', status: 'completed', act: null, who: 'c1', nowPath: '', line: 'done · 5m 12s', icon: 'ok' },
        { key: 'c2', main: false, name: 'Audit fleet-status', status: 'completed', act: null, who: 'c2', nowPath: '', line: 'done · 4m 40s', icon: 'ok' },
        { key: 'c3', main: false, name: 'Audit fleet-kit', status: 'stopped', act: null, who: 'c3', nowPath: '', line: 'stopped', icon: 'stop' }
      ],
      files: files.slice(0, 11).map(f => ({ ...f })),
      selected: 'c1'
    }
  }
}
if (typeof module !== 'undefined') module.exports = mapFixtures
