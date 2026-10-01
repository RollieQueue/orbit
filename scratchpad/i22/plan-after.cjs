// The plan after the restart: I22's evidence, shortened to fit 1500 characters with the "applied" note at the end.
const fs = require('fs')
const plan = JSON.parse(fs.readFileSync(__dirname + '/plan.json', 'utf8'))
const evidence = 'electron/providers.mts: buildCodexSessionArgs передаёт постоянный блок Orbit (systemAppend) как -c developer_instructions=<строка TOML> каждому процессу codex exec, новому и resume (tomlString = JSON.stringify(wellFormed(text)), DEL экранируется); electron/codex-server.mts: developerInstructions в thread/start и thread/resume, rpcLine: строки JSON-RPC App Server (оба режима Ask) уходят без одиночных суррогатов — Codex такую строку молча отбрасывал, и сессия висела до сторожа. Проверено: оба tsc 0; providers-session + codex-server 24/24 трижды; 8 связанных файлов 168/168; мутации 14/14 на копии в %TMP% (scratchpad/i22/mutate.cjs, mutate.log); живьём на codex-cli 0.155 с подставным Responses API без квоты (scratchpad/i22/live-*.cjs): блок доходит до модели один раз сообщением developer байт в байт, resume не дублирует, тред хранит блок начала, суррогат → U+FFFD, ответ за 388 мс. Ревью claude-opus-5-5: high/medium нет; low 1 (суррогат подвешивал App Server) исправлен (rpcLine + 2 теста), low 2–5 — документация и тест. Попутно в старой записи CHANGELOG восстановлены `\\d` и `\\b`. Docs: CHANGELOG, SESSION-MODE, providers.md, ARCHITECTURE, TECH-DEBT п.16. С настоящей моделью не проверено (квота Codex исчерпана). Применено restart_orbit (runtime, 05:39 UTC): проверки самообновления ok; отчёт здоровья ok, отпечатки shell/runtime/renderer совпадают с файлами, runtime жив (pid 4956).'
for (const task of plan.tasks) {
  if (task.id === 'I22') task.evidence = evidence
  else if (task.status === 'done') task.evidence = task.evidence.slice(0, 60).replace(/…$/, '') + '…'
}
fs.writeFileSync(__dirname + '/plan-after.json', JSON.stringify(plan, null, 1))
console.log('evidence', evidence.length)
for (const task of plan.tasks) console.log(JSON.stringify(task))
