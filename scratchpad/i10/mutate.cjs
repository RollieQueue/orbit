// I10 (the secret mark of steering mail): each mutation must make at least one named test fail. Files are restored.
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/user-messages.test.cjs', 'tests/steer-messages.test.cjs', 'tests/restart-orbit.test.cjs', 'tests/attachments.test.cjs']
const mutations = [
  ['heading without the mark', 'electron/runtime/mailbox.mts', 'mailBlock(`${mailTag(agent)} ${USER_MAIL_HEADER}`', 'mailBlock(`[orbit] ${USER_MAIL_HEADER}`'],
  ['one mark for everyone', 'electron/runtime/util.mts', "randomBytes(5).toString('hex')", "'0123456789'"],
  ['mark in the public record', 'electron/runtime/util.mts', ", 'pausedSession', 'mailMark']", ", 'pausedSession']"],
  ['restart does not save the mark', 'electron/runtime/lifecycle.mts', ', ...(root ? { mailMark: root.mailMark } : {})', ''],
  ['mark kept without a resumed session', 'electron/runtime/restart.mts', 'if (resumable && isMailMark(session.mailMark))', 'if (session && isMailMark(session.mailMark))'],
  ['resume drops the saved mark', 'electron/resume.mts', 'return { id: root.sessionId, providerId: root.providerId, ...mark }', 'return { id: root.sessionId, providerId: root.providerId }'],
  ['session guide without the rule', 'electron/runtime/prompts.mts', '("${mailTag(agent)} MESSAGE FROM YOUR SUPERVISOR"). ${markRule(agent)} When', '("${mailTag(agent)} MESSAGE FROM YOUR SUPERVISOR"). When'],
  ['envelope guide without the mark', 'electron/runtime/prompts.mts', 'The user or an agent above you in the team can write to you while you work: such a message comes in your prompt under the heading "${mailTag(agent)} MESSAGE FROM THE USER" or "${mailTag(agent)} MESSAGE FROM YOUR SUPERVISOR"; follow it over your earlier plan. ${markRule(agent)}\n', ''],
]
for (const [name, file, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    console.log(`== ${name}: ${failed.length ? failed.join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
