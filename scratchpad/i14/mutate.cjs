// I14 (the celebration honours prefers-reduced-motion: nothing moves but the video): each mutation must make the package
// test fail. Files are restored. Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/skill-celebration-package.test.cjs']
const PAGE = 'skills/task-completed-celebration/celebration.js'
const mutations = [
  [PAGE, 'reduced never detected', "var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches", 'var reduced = false'],
  [PAGE, 'text keeps flying', 'if (reduced) { holdText(flyer); return }', ''],
  [PAGE, 'text held and flying', 'if (reduced) { holdText(flyer); return }', 'if (reduced) { holdText(flyer) }'],
  [PAGE, 'text off centre', 'var x = Math.max(0, (window.innerWidth - flyer.offsetWidth) / 2)', 'var x = Math.max(0, (window.innerWidth - flyer.offsetWidth) / 3)'],
  [PAGE, 'centre ignores resize', "window.addEventListener('resize', centre)\n", ''],
  [PAGE, 'confetti keeps falling', '    if (reduced) {\n      var lay = function () {', '    if (false) {\n      var lay = function () {'],
  [PAGE, 'confetti laid and falling', "window.removeEventListener('resize', lay) })\n      return\n", "window.removeEventListener('resize', lay) })\n"],
  [PAGE, 'confetti not drawn', '          draw(makePiece(px, py, 0, 0))\n', ''],
  // From the review: what the first version of the test let through.
  [PAGE, 'confetti not laid again on resize', "      window.addEventListener('resize', lay)\n", ''],
  [PAGE, 'reduced cleanup leaves resize handlers', "stops.push(function () { window.removeEventListener('resize', resize); window.removeEventListener('resize', lay) })", 'stops.push(function () {})'],
  [PAGE, 'text frame does not move', '      step(Math.min(48, time - last))\n', ''],
  [PAGE, 'confetti frame draws nothing', '        draw(piece)\n', ''],
  [PAGE, 'text cleanup leaves fit', "stops.push(function () { window.removeEventListener('resize', fit) })", 'stops.push(function () {})'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, name]) => only.split('|').some(part => name.includes(part))))
let caught = 0
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 120000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    if (failed.length) caught++
    console.log(`== ${name}: ${failed.length ? failed.map(line => line.slice(0, 90)).join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
