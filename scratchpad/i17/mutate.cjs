// I17 (a continuation after a restart names the files the user attached in the run it continues; the history entry of a
// message names its files before its text; a deleted chat's folder Windows could not delete yet is marked and swept
// later): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const ATT = 'electron/attachments.mts', LIFE = 'electron/runtime/lifecycle.mts', REST = 'electron/runtime/restart.mts', MAIL = 'electron/runtime/mailbox.mts'
const STORE = 'electron/runtime/store.mts', RES = 'electron/resume.mts', API = 'electron/runtime-api.mts', HOST = 'electron/runtime-host.mts', SS = 'src/state-store.ts'
const A = ['tests/attachments.test.cjs'], R = ['tests/restart-orbit.test.cjs'], S = ['tests/state-store.test.cjs']
const mutations = [
  // Part 1: the files of a run, and the continuation's note.
  [ATT, R, 'run list checked like one message', 'for (const item of value.slice(0, max) as', 'for (const item of value.slice(0, MAX_FILES) as'],
  [LIFE, A, 'start keeps the oldest files', '...attachments].slice(-MAX_RUN_FILES)', '...attachments].slice(0, MAX_RUN_FILES)'],
  [MAIL, A, 'messages keep the oldest files', '...attachments].slice(-MAX_RUN_FILES)', '...attachments].slice(0, MAX_RUN_FILES)'],
  [MAIL, R, 'message files not kept', 'if (attachments.length) run.attachments =', 'if (false) run.attachments ='],
  [LIFE, R, 'continuation without inherited files', 'run.attachments = [...resumeAttachments, ...attachments]', 'run.attachments = [...attachments]'],
  [LIFE, R, 'note without the files', 'payload.resumeSession, resumeAttachments)', 'payload.resumeSession)'],
  [LIFE, R, 'resumeAttachments kept in the start payload', 'resumeSession, resumeAttachments, ...settings', 'resumeSession, ...settings'],
  [REST, R, 'files not appended to the note', '${note}${attached}', '${note}'],
  [STORE, R, 'snapshot without the files', '...(run.attachments?.length ? { attachments: run.attachments } : {})', '...({})'],
  [RES, R, 'continuation gets no files', 'attachments: [], resumeAttachments: files,', 'attachments: [], resumeAttachments: [],'],
  // From the review: a damaged record's start payload brings no files of its own.
  [RES, R, 'start payload files pass (review low)', 'attachments: [], resumeAttachments: files,', '...(files.length ? { resumeAttachments: files } : {}),'],
  [RES, R, 'deleted files named', 'const files = trustedAttachments(userData, Array.isArray(old.attachments) ? old.attachments.slice(-MAX_RUN_FILES) : [], MAX_RUN_FILES)', 'const files = (Array.isArray(old.attachments) ? old.attachments.slice(-MAX_RUN_FILES) : [])'],
  [API, A, 'window files for a continuation unchecked', ' resumeAttachments: trustedAttachments(userData, payload.resumeAttachments, MAX_RUN_FILES),', ''],
  // Part 2: the history entry.
  [SS, S, 'note after the text', '[attachmentNote(m.attachments), m.text]', '[m.text, attachmentNote(m.attachments)]'],
  // Part 3: a deleted chat's folder that could not go at once.
  [HOST, A, 'no sweep at the start', '  void sweepDiscarded(userData)\n', ''],
  [ATT, A, 'no mark before removal', "await fs.promises.writeFile(`${folder}${DISCARD_MARK}`, '').catch(() => undefined)", 'undefined'],
  [ATT, A, 'no sweep on a chat deletion', '    await sweepDiscarded(userData, safeFolder(chatId))\n', ''],
  // From the review: its own folder first (a quit during the others' retries must not leave it unmarked); a chat without
  // files sweeps too; a directory is no mark.
  [ATT, A, 'others swept before its own folder (review medium)', '    if (entries) {\n', '    await sweepDiscarded(userData)\n    if (entries) {\n'],
  [ATT, A, 'no sweep for a chat without files (review low)', '    await sweepDiscarded(userData, safeFolder(chatId))\n', '    if (entries) await sweepDiscarded(userData, safeFolder(chatId))\n'],
  [ATT, A, 'a directory taken for a mark (review low)', 'entry.isFile() && entry.name.endsWith', 'entry.name.endsWith'],
  [ATT, A, 'sweep retries its own folder at once (expected to survive: latency only)', 'chat && chat !== skip && safeFolder', 'chat && safeFolder'],
  [ATT, A, 'mark kept after removal', '    await fs.promises.rm(`${folder}${DISCARD_MARK}`, { force: true })\n', ''],
  [ATT, A, 'any mark name is a folder', 'chat !== skip && safeFolder(chat) === chat && await', 'chat !== skip && await'],
  [ATT, A, 'count ignores what is left', 'if (!await removeFolder(folder)) { try { count -= (await fs.promises.readdir(folder)).length } catch { /* gone after all */ } }', 'await removeFolder(folder)'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, , name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Map()
for (const tests of [A, R, S]) {
  const { failed } = run(tests)
  baseline.set(tests, new Set(failed))
  console.log(`baseline ${tests.join(' ')}: ${failed.length ? failed.join(' | ') : 'all pass'}`)
}
let caught = 0
for (const [file, tests, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, () => to))
    const { out, failed } = run(tests)
    const fresh = failed.filter(line => !baseline.get(tests).has(line))
    if (fresh.length) caught++
    console.log(`== ${name}: ${fresh.length ? fresh.map(line => line.slice(0, 90)).join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
