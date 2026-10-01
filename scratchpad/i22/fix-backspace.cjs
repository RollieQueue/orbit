// An older CHANGELOG entry lost its backslashes through a shell: `\d` became `d` and `\b` a raw backspace (U+0008).
const fs = require('fs')
const file = 'docs/CHANGELOG.md'
const text = fs.readFileSync(file, 'utf8')
const from = 'вместо `d` и `\\b` — обычная `d` и символ backspace'
const count = text.split(from).length - 1
if (count !== 1) throw new Error(`${count} matches`)
fs.writeFileSync(file, text.replace(from, () => 'вместо `\\d` и `\\b` — обычная `d` и символ backspace'))
console.log('ok')
