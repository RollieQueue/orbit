// I22 review fixes in the docs: the user's own developer_instructions, DEL wording, the mark on the command line,
// the App Server's well-formed JSON-RPC lines.
const fs = require('fs')
const edit = (file, pairs) => {
  let text = fs.readFileSync(file, 'utf8')
  for (const [from, to] of pairs) {
    const found = text.split(from).length - 1
    if (found !== 1) throw new Error(`${file}: ${found} matches of ${from.slice(0, 70)}`)
    text = text.replace(from, () => to)
  }
  fs.writeFileSync(file, text)
}

edit('docs/CHANGELOG.md', [
  ['Файла для такого текста Codex не принимает, поэтому блок (до 6000 символов) идёт строкой TOML в командной строке. Одиночный суррогат и символ DEL, которых TOML не допускает, заменяются, иначе Codex взял бы всё значение вместе с кавычками как сырой текст.',
   'Файла для такого текста Codex не принимает, поэтому блок (до 6000 символов) идёт строкой TOML в командной строке. Одиночный суррогат (строка, обрезанная посреди эмодзи, например длинное имя агента) заменяется на U+FFFD, а символ DEL экранируется: значение, которого TOML не допускает, Codex взял бы сырым текстом вместе с экранированием. Свои `developer_instructions` из `config.toml` Codex, если они там заданы, в сессиях Orbit заменяются блоком Orbit; `AGENTS.md` по-прежнему действует. Заодно App Server (оба режима «Ask») больше не зависает на таком суррогате: строку JSON-RPC с ним Codex отбрасывает и не отвечает вовсе, так что обрезанное посреди эмодзи сообщение чата или имя агента подвешивало открытие сессии или ход до сторожа тишины. Теперь каждая строка в сообщениях App Server уходит без одиночных суррогатов.'],
  ['Код: `electron/providers.mts` (`buildCodexSessionArgs`, `tomlString`), `electron/codex-server.mts` (`openCodexSession`). Тесты: `tests/providers-session.test.cjs` (+1: блок в `thread/start` и `thread/resume`, без блока его нет, на командной строке App Server его нет; аргументы `exec` для нового треда и возобновления, кодирование строки TOML, сквозной прогон через `runProvider`).',
   'Код: `electron/providers.mts` (`buildCodexSessionArgs`, `tomlString`, `wellFormed`), `electron/codex-server.mts` (`openCodexSession`, `rpcLine`). Тесты: `tests/providers-session.test.cjs` (+1: блок в `thread/start` и `thread/resume`, без блока его нет, на командной строке App Server его нет, суррогат в блоке и в запросе хода уходит как U+FFFD; аргументы `exec` для нового треда и возобновления, кодирование строки TOML, сквозной прогон через `runProvider`), `tests/codex-server.test.cjs` (+1: запрос с обрезанным эмодзи в режиме конверта).'],
])

edit('docs/providers.md', [
  ['0.155 with a stub Responses server); a resume passes it all the same.\n',
   '0.155 with a stub Responses server); a resume passes it all the same. The override\nreplaces a `developer_instructions` the user set in `CODEX_HOME/config.toml` for Orbit\'s\nsessions (`AGENTS.md` still applies). A lone surrogate (a string bounded inside an emoji)\ngoes out as U+FFFD: on the command line TOML refuses its escape, and the App Server drops\na JSON-RPC line that carries one without answering, so every string of every App Server\nmessage is made well-formed (`rpcLine`).\n'],
])

edit('docs/SESSION-MODE.md', [
  ['changed or missing block on resume is ignored.\n',
   'changed or missing block on resume is ignored. The override replaces a `developer_instructions`\nof the user\'s own `config.toml` in Orbit\'s sessions (`AGENTS.md` still applies).\n'],
])

edit('docs/TECH-DEBT.md', [
  ['    (`developer_instructions` у `codex exec`, `developerInstructions` у App Server). Тред, начатый раньше, блока не получит.\n',
   '    (`developer_instructions` у `codex exec`, `developerInstructions` у App Server). Тред, начатый раньше, блока не получит.\n    С этим секрет стоит и в командной строке каждого `codex exec` (её видит любой процесс того же пользователя), как уже\n    в журнале сессии Codex и во временном файле блока Claude.\n'],
])
console.log('ok')
