// I22 review fix: App Server JSON-RPC lines go out well-formed. Keeps the file's CRLF endings.
const fs = require('fs')
const file = 'electron/codex-server.mts'
let text = fs.readFileSync(file, 'utf8')
const crlf = text.includes('\r\n')
text = text.replace(/\r\n/g, '\n')
const replaceOnce = (from, to, count = 1) => {
  const found = text.split(from).length - 1
  if (found !== count) throw new Error(`${found} matches of ${from.slice(0, 60)}`)
  text = text.split(from).join(to)
}
replaceOnce("import { codexMcpArgs, loopbackNoProxy } from './providers.mts'\n", "import { codexMcpArgs, loopbackNoProxy, wellFormed } from './providers.mts'\n")
replaceOnce('// Codex exec cannot answer native approval requests; Ask uses the stdio App Server.\n',
  "// One JSON-RPC line. Codex drops a line whose JSON has an escaped lone surrogate and never answers it, so every string\n" +
  "// goes out well-formed (a chat message or an agent's name bounded inside an emoji).\n" +
  "const rpcLine = (message: CodexClientMessage): string => JSON.stringify(message, (_key, value: unknown) => typeof value === 'string' ? wellFormed(value) : value) + '\\n'\n\n" +
  '// Codex exec cannot answer native approval requests; Ask uses the stdio App Server.\n')
replaceOnce("child.stdin.write(JSON.stringify(message) + '\\n')", 'child.stdin.write(rpcLine(message))', 2)
if (crlf) text = text.replace(/\n/g, '\r\n')
fs.writeFileSync(file, text)
console.log('ok')
