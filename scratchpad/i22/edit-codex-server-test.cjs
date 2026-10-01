// I22 review fix, test side: the envelope App Server fixture refuses a lone surrogate as Codex does. Keeps CRLF endings.
const fs = require('fs')
const file = 'tests/codex-server.test.cjs'
let text = fs.readFileSync(file, 'utf8')
const crlf = text.includes('\r\n')
text = text.replace(/\r\n/g, '\n')
const replaceOnce = (from, to) => {
  const found = text.split(from).length - 1
  if (found !== 1) throw new Error(`${found} matches of ${from.slice(0, 60)}`)
  text = text.replace(from, () => to)
}
replaceOnce("    if(m.params.effort !== 'high') throw Error('Missing effort');\n",
  "    if(m.params.effort !== 'high') throw Error('Missing effort');\n" +
  "    // Codex drops a line with an escaped lone surrogate and never answers; the fixture fails loudly instead.\n" +
  "    if(m.params.input[0].text !== m.params.input[0].text.toWellFormed()) throw Error('Lone surrogate');\n")
replaceOnce("test('App Server cancellation interrupts an unanswered approval', async () => {\n",
  String.raw`test('App Server sends a string bounded inside an emoji well-formed', async () => {
  const result = await runCodexServer({ workspace: process.cwd(), accessMode: 'workspace-write', responseSchema: ORBIT_RESPONSE_SCHEMA, reasoningEffort: 'high', timeoutMs: 3000, prompt: 'Cut \ud83d', onApproval: async () => true }, helpers(fixture))
  assert.equal(result.text, 'Decision: accept')
})
` + "\ntest('App Server cancellation interrupts an unanswered approval', async () => {\n")
if (crlf) text = text.replace(/\n/g, '\r\n')
fs.writeFileSync(file, text)
console.log('ok')
