// Builds the improvement_plan arguments after I14: I14 done, I29 (found by I14's live check) next, older done tasks dropped.
const fs = require('fs')
const path = require('path')
const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-before.json'), 'utf8'))
const dropped = new Set(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'])
const shorten = (text, max) => text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`

const i14 = 'skills/task-completed-celebration: celebration.js — при prefers-reduced-motion holdText (надпись посередине, пересчёт на resize, без rAF) и lay (конфетти неподвижно по краям: полоса 14% короткой стороны, 40–200 штук, перерисовка на resize, без rAF), прежние замедляющие множители убраны; celebration.css — #spin,#words,#backdrop animation:none; skill.json — фраза инструкции. Установлено в профиль пользователя через capability_install {id b65d8072…, fromDir}: версия 2, файлы совпадают с репозиторием, значения параметров пользователя (p3l7fgvrEKM, 13–73 с) сохранены. Проверено: tests/skill-*.test.cjs 31/31 (новый тест: страница в node:vm с заглушкой DOM — reduced и обычный режим, resize, Esc снимает обработчики); мутации 13/13 (scratchpad/i14/mutate.cjs на копии в %TMP%). Живьём в настоящем окне (scratchpad/i14/stage-live.cjs: настоящий main.cjs во временном профиле): страница в sandbox-кадре с параметрами и orbit_run, полноэкранный режим и флаг; закрытие само (27 с, видео не загрузилось), по Esc, ×, клику — каждый раз выход из полноэкранного; перезагрузка при открытой сцене снимает его и не повторяет праздник; выключенный навык ничего не показывает; --force-prefers-reduced-motion: за 1,2 с надпись и canvas неизменны, без него меняются. Ревью codex/gpt-6-astra: high/medium нет; low о слабом тесте исправлен (+5 мутаций), «настройка читается при открытии» и «подсказка гаснет» оговорены. Код Orbit не менялся: restart_orbit применять нечего. Найдено: YouTube в окне не грузится → I29.'

const i29 = {
  id: 'I29',
  title: 'Видео праздника в настоящем окне не играет на этом компьютере: окно Orbit ходит в сеть по системному прокси Windows (сейчас выключен, ProxyEnable=0), а YouTube доступен только через прокси из HTTP(S)_PROXY (http://127.0.0.1:12334 в переменных среды пользователя, им пользуются CLI агентов); в живой проверке I14 кадр YouTube дал ERR_NAME_NOT_RESOLVED, праздник шёл без видео 27 с. Давать сессии окна прокси из окружения, когда системный — DIRECT (например PAC «PROXY …; DIRECT», NO_PROXY → обход); заодно main.cjs did-fail-load: сбой подкадра (плеер навыка) не пишет «Orbit renderer failed to load» и не зовёт win.show(). Правка main.cjs — полный перезапуск',
  status: 'pending',
  evidence: '',
}

const tasks = []
for (const task of before.tasks) {
  if (dropped.has(task.id)) continue
  if (task.id === 'I14') { tasks.push({ ...task, status: 'done', evidence: i14 }, i29); continue }
  tasks.push({ id: task.id, title: task.title, status: task.status, evidence: task.status === 'done' ? shorten(task.evidence, 400) : task.evidence })
}

const handoff = 'Цель: бесконечное улучшение Orbit ночью. УСЛОВИЕ: никогда не брать Claude Fable 5.1 ни помощникам, ни для ревью. spawn_agent с kind (code/review/lookup/text) без model — Orbit выбирает по electron/model-routing.json и квотам (review → codex/gpt-6-astra, дельно). Мелкую задачу делать самому + одно ревью; high/medium исправлять, дешёвые low сразу, остальное в план. Каждое изменение — запись в docs/CHANGELOG.md «## Не выпущено (после 0.5.0)» (новые сверху); README — для заметного пользователю. Не коммитить. Проверка: оба tsc, целевые тесты, мутации (образец scratchpad/i14/mutate.cjs) на КОПИИ в %TMP% (node_modules — Junction, снимать [IO.Directory]::Delete ДО Remove-Item -Recurse). restart_orbit проверяет и перезапускает только по отпечаткам electron/ и src/ (tests, skills, docs не в счёт). Следующая — I29 (main.cjs → полный перезапуск). Живая проверка окна: node scripts/run-electron.cjs scratchpad/i14/stage-live.cjs (I14_REDUCED=1 — без движения): настоящий main.cjs во временном профиле с фикстурами, окно видно, звук заглушен. improvement_plan заменяет весь план: названия брать из последней записи run-history с непустым improvements. loops.mts на пределе 400 строк. CRLF: util, agents, lifecycle, ledger, run-store (.mts), failover.mts, QuotaPanel.tsx, tests/runtime, providers, storage, failover (.test.cjs); main.cjs, skills, providers.mts, handover.mts — LF.'

const args = { status: 'implementing', handoff, tasks }
fs.writeFileSync(path.join(__dirname, 'plan-after.json'), JSON.stringify(args))
console.log(JSON.stringify(args))
console.error(`tasks ${tasks.length}, handoff ${handoff.length} chars, I14 evidence ${i14.length} chars`)
