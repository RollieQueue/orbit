// Actual Electron + renderer + preload + IPC + runtime child process + HTTP adapter integration.
// All profiles and workspaces are temporary; no vendor model is called.
const { app, BrowserWindow, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { StateStore } = require('../electron/run-store.mts')

// The runtime runs as main runs it from the repository: its own process (ORBIT_RUNTIME_MODE=inprocess runs this smoke
// with the runtime inside main instead; the runtime restart below is then skipped).
const runtimeMode = process.env.ORBIT_RUNTIME_MODE === 'inprocess' ? 'inprocess' : 'child'
process.env.ORBIT_RUNTIME_MODE = runtimeMode

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-desktop-test-'))
const profile = path.join(temporary, 'profile')
const workspaces = [path.join(temporary, 'alpha'), path.join(temporary, 'beta')]
workspaces.forEach(folder => fs.mkdirSync(folder))

// Hermetic subscriptions: quota readings, provider health and two vendor CLIs are served by scripts/smoke-fixtures.cjs,
// which the runtime loads through ORBIT_RUNTIME_FIXTURES before it exists, so nothing here touches a real account. The
// runtime is another process, so the smoke steers the fixtures (control.json) and reads what they did (counters.json)
// through files in the temporary folder.
process.env.ORBIT_RUNTIME_FIXTURES = path.join(__dirname, 'smoke-fixtures.cjs')
process.env.ORBIT_SMOKE_FIXTURE_DIR = temporary
// The runtime refuses to start without all three fixtures (runtime-host.mts), so a broken fixtures path fails loudly.
process.env.ORBIT_SMOKE = '1'
const setFixtures = (control) => fs.writeFileSync(path.join(temporary, 'control.json'), JSON.stringify(control))
function fixtureCounters() {
  const empty = { quotaReads: 0, codexRuns: 0, claudeRuns: 0 }
  // The runtime rewrites the file after every count; a read that meets a half-written file simply reads again.
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return { ...empty, ...JSON.parse(fs.readFileSync(path.join(temporary, 'counters.json'), 'utf8')) } } catch (error) {
      if (error.code === 'ENOENT') return empty
    }
  }
  throw new Error('counters.json of the smoke fixtures stays unreadable')
}
setFixtures({ codexUsed: 97 })

process.env.ORBIT_USER_DATA = profile
process.env.ORBIT_DEV = '0'
// The self-upgrade health report belongs to the real app; the smoke must not overwrite it or trip its crash hook.
process.env.ORBIT_HEALTH_FILE = '0'
process.env.ORBIT_OPENAI_MODEL = 'fixture-model'
delete process.env.ORBIT_OPENAI_API_KEY
const initial = {
  version: 3,
  activeProjectId: 'alpha',
  projects: ['alpha', 'beta'].map((id, index) => ({
    id, workspace: { path: workspaces[index], name: id === 'alpha' ? 'Альфа' : 'Бета', connected: false, branch: '', changedFiles: 0 },
    activeChatId: `${id}-chat`, chats: [{ id: `${id}-chat`, title: 'Новый чат', messages: [], updated: new Date().toISOString() }],
  })),
  settings: { providerId: 'custom', models: { custom: 'fixture-model' }, memoryEnabled: true, accessMode: 'workspace-write', approvalPolicy: 'never', agentInstructions: '', limits: { maxAgents: 8, maxDepth: 3, maxConcurrent: 2, maxTurns: 8, maxTotalTurns: 20 } },
}
new StateStore(profile).save(initial)

let alphaCalls = 0, betaCalls = 0, childCalls = 0
const parallelResponses = []
const approvalDialogs = []
// Main shows the approval dialogs the runtime process asks for.
dialog.showMessageBox = async (_window, options) => { approvalDialogs.push(options); return { response: 1 } }
const errors = []
const server = http.createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    assert.equal(payload.model, 'fixture-selected', 'selected model reaches the provider and child agents')
    assert.equal(payload.reasoning_effort, 'high', 'selected effort reaches root and child requests')
    const input = payload.messages[0].content
    if (input.includes('ORBIT_PARALLEL_')) {
      parallelResponses.push(response)
      if (parallelResponses.length === 2) setTimeout(() => {
        for (const pending of parallelResponses) {
          pending.writeHead(200, { 'content-type': 'application/json' })
          pending.end(JSON.stringify({ choices: [{ message: { content: 'Параллельный чат завершён.' } }] }))
        }
      }, 300)
      return
    }
    const beta = input.includes('ORBIT_BETA')
    const child = /parent=agent-|parent=root/.test(input)
    let content
    if (child) {
      childCalls++
      content = childCalls === 1 ? JSON.stringify({ tool_calls: [
        { id: 'write', name: 'write_file', arguments: { path: 'approved.txt', content: 'Approved child action' } },
        { id: 'reply', name: 'send_message', arguments: { agentId: 'root', message: 'Подтверждаю: сообщение получено, проверяю независимую часть.' } },
      ] }) : 'Подагент проверил отдельную часть задачи.'
    }
    else if (beta) { betaCalls++; content = 'Ответ только для проекта Бета.' }
    else if (++alphaCalls <= 2) {
      if (alphaCalls === 2) assert.match(input, /No Orbit tools from that response were executed/)
      content = JSON.stringify({ content: 'Сохраняю полезный контекст и подключаю помощника.', tool_calls: [
      { id: 'memory', name: 'memory_save', arguments: { title: 'Desktop fact', content: 'Project Alpha uses this fixture', scope: 'project' } },
      { id: 'skill', name: 'capability_install', arguments: { name: 'Desktop check', description: 'Reusable check', instructions: 'Use the existing project checks', scope: 'project' } },
      { id: 'delegate', name: 'spawn_agent', arguments: { name: 'Проверка', task: 'ORBIT_CHILD: inspect a separate concern', reason: 'Independent verification can run in parallel' } },
      { id: 'send', name: 'send_message', arguments: { agentId: 'Проверка', message: 'Проверь память отдельно и пришли короткий итог.' } },
      { id: 'wait', name: 'wait_message', arguments: { timeout_ms: 2000 } },
      ] })
      if (alphaCalls === 1) content = content.replace(/\]\}$/, '}]}')
    }
    else content = 'Готово: контекст проекта Альфа сохранён, результат помощника получен.'
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content }, finish_reason: 'stop' }] }))
    }, 180)
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end('{}') }
})

// Keep the verification process invisible. The production window is unchanged.
BrowserWindow.prototype.show = function () {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}

const timings = {}
async function exercise(win) {
  win.webContents.setBackgroundThrottling(false)
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  win.webContents.on('console-message', (_event, ...args) => {
    const detail = args.length === 1 ? args[0] : { level: args[0], message: args[1] }
    if (detail.level === 3 || detail.level === 'error') errors.push(String(detail.message))
  })
  win.webContents.on('render-process-gone', (_event, detail) => errors.push(`Renderer exited: ${detail.reason}`))
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'renderer ready')
  assert.equal(await evaluate(`typeof window.orbit.startTask`), 'function')
  const started = await evaluate(`window.orbit.getRuntimeStatus()`)
  assert.deepEqual([started.state, started.mode], ['ready', runtimeMode], JSON.stringify(started))
  if (runtimeMode === 'child') assert.notEqual(started.pid, process.pid, 'the runtime runs in its own process')
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Модель"]'); field.value = '__custom__'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await waitFor(() => evaluate(`!!document.querySelector('input[aria-label="Модель: свой идентификатор"]')`), 'custom model field')
  await evaluate(`(() => { const field = document.querySelector('input[aria-label="Модель: свой идентификатор"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'fixture-selected'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await delay(50)
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Провайдер"]'); field.value = 'codex'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await waitFor(() => evaluate(`document.querySelector('select[aria-label="Модель"]').value === ''`), 'model isolated by provider')
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Провайдер"]'); field.value = 'custom'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await waitFor(() => evaluate(`document.querySelector('select[aria-label="Модель"]').value === 'fixture-selected'`), 'provider model restored')
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Уровень мышления"]'); field.value = 'high'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Уровень доступа"]'); field.value = 'ask'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await waitFor(() => evaluate(`document.querySelector('select[aria-label="Уровень доступа"]').value === 'ask'`), 'Ask mode selected')
  const send = async (text) => {
    await evaluate(`(() => { const field = document.querySelector('textarea[aria-label="Сообщение агенту"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await waitFor(() => evaluate(`!document.querySelector('button[aria-label="Отправить сообщение"]').disabled`), 'send enabled')
    await evaluate(`document.querySelector('form.composer').requestSubmit()`)
  }
  const switchProject = async name => {
    await evaluate(`document.querySelector('.project-button').click()`)
    await delay(30)
    await evaluate(`Array.from(document.querySelectorAll('.project-dropdown button')).find(button => button.querySelector('strong')?.textContent === ${JSON.stringify(name)}).click()`)
    await delay(30)
  }
  await evaluate(`document.querySelector('button[aria-label="Использовать общую память"]').click()`)
  await waitFor(() => evaluate(`document.querySelector('button[aria-label="Использовать общую память"]').getAttribute('aria-pressed') === 'false'`), 'alpha global memory disabled')
  await send('ORBIT_ALPHA: проверь память и независимого помощника')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.some(run => run.projectId === 'alpha'))`), 'alpha run starts')
  await switchProject('Бета')
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Использовать общую память"]').getAttribute('aria-pressed')`), 'true', 'beta has its own memory preference')
  await send('ORBIT_BETA: ответь в этом проекте')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.length >= 2 && runs.every(run => ['completed','failed','cancelled'].includes(run.status)))`), 'both runs finish')
  const runs = await evaluate(`window.orbit.listRuns()`)
  assert.equal(runs.length, 2)
  assert.ok(runs.every(run => run.status === 'completed'), JSON.stringify(runs.map(run => ({ status: run.status, error: run.error }))))
  const alpha = runs.find(run => run.projectId === 'alpha')
  const beta = runs.find(run => run.projectId === 'beta')
  assert.equal(alpha.agents.length, 2)
  assert.equal(alpha.traces.filter(trace => trace.kind === 'protocol_error').length, 1)
  assert.ok(alpha.messages.every(message => !message.text.includes('tool_calls')))
  assert.equal(approvalDialogs.length, 1)
  assert.ok(approvalDialogs[0].message.includes('Проверка'))
  assert.ok(approvalDialogs[0].detail.includes('approved.txt'))
  assert.equal(fs.readFileSync(path.join(workspaces[0], 'approved.txt'), 'utf8'), 'Approved child action')
  assert.equal(beta.agents.length, 1)
  assert.ok(alpha.agents.every(agent => agent.status === 'done'))
  assert.equal(alpha.communications.length, 4)
  assert.equal(alpha.communications.filter(message => message.kind === 'spawn').length, 2)
  assert.ok(alpha.communications.some(message => message.fromAgentId === 'root' && message.toAgentName === 'Проверка'))
  assert.ok(alpha.communications.some(message => message.toAgentId === 'root' && message.fromAgentName === 'Проверка'))
  assert.ok(!await evaluate(`document.querySelector('.conversation').textContent.includes('контекст проекта Альфа сохранён')`))
  assert.ok(await evaluate(`document.querySelector('.conversation').textContent.includes('Ответ только для проекта Бета')`))
  await send('ORBIT_BETA: ответь в этом проекте')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.length === 3 && runs.every(run => run.status === 'completed'))`), 'repeated prompt finishes as another turn')
  assert.equal((await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[0])})`)).length, 1)
  assert.equal((await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[1])})`)).length, 0)
  assert.equal((await evaluate(`window.orbit.listCapabilities(${JSON.stringify(workspaces[0])})`)).length, 1)
  await switchProject('Альфа')
  assert.ok(await evaluate(`document.querySelector('.conversation').textContent.includes('контекст проекта Альфа сохранён')`))
  assert.ok(!await evaluate(`document.querySelector('.conversation').textContent.includes('tool_calls')`), 'broken and repaired envelopes must stay out of chat')
  await evaluate(`document.querySelector('.agents-toggle').click()`)
  assert.equal(await evaluate(`document.querySelectorAll('.agent-tree .agent-row:not(.router-row)').length`), 2)
  assert.equal(await evaluate(`document.querySelectorAll('.agent-tree .router-row').length`), 1, 'the router is listed as a participant')
  assert.ok(await evaluate(`document.querySelector('.team-strip')?.textContent.includes('Команда · 1')`), 'the team of a finished turn stays visible under its answer')
  await waitFor(() => evaluate(`/Индекс: [0-9]+/.test(document.querySelector('.project-index-row')?.textContent || '')`), 'project index status shown')
  await evaluate(`document.querySelector('.agent-row.router-row').click()`)
  assert.ok(await evaluate(`document.querySelector('.agent-inspector').textContent.includes('Все сообщения между агентами проходят здесь')`))
  await evaluate(`document.querySelector('.agent-row:not(.router-row)').click()`)
  const tabsPosition = await evaluate(`(() => {
    document.querySelectorAll('.agent-inspector details').forEach(item => item.open = true);
    const body = document.querySelector('.agent-inspector');
    const before = document.querySelector('.inspector-tabs').getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    return {before, after: document.querySelector('.inspector-tabs').getBoundingClientRect().top, scroll:body.scrollTop};
  })()`)
  assert.ok(tabsPosition.scroll > 0, 'activity pane must actually scroll')
  assert.equal(tabsPosition.before, tabsPosition.after, 'activity/correspondence tabs stay fixed when scrolling')
  await delay(500)
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'renderer ready after reload')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Модель"]').value`), 'fixture-selected', 'model selection survives reload')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Уровень мышления"]').value`), 'high')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Уровень доступа"]').value`), 'ask')
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Использовать общую память"]').getAttribute('aria-pressed')`), 'false', 'project memory preference survives reload')
  await waitFor(() => evaluate(`document.querySelector('.conversation')?.textContent.includes('контекст проекта Альфа сохранён')`), 'chat restored after renderer reload')
  await switchProject('Бета')
  assert.equal(await evaluate(`document.querySelectorAll('.message.user').length`), 2, 'identical user prompts are distinct turns')
  assert.equal(await evaluate(`document.querySelectorAll('.message.orbit').length`), 2)
  await switchProject('Альфа')
  await evaluate(`document.querySelector('.agents-toggle').click()`)
  await delay(500)
  assert.equal(await evaluate(`document.querySelectorAll('.agent-tree .agent-row:not(.router-row)').length`), 2)
  const screenshotPath = path.resolve(__dirname, '../artifacts/desktop-smoke.png')
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  const openMemoryPanel = () => evaluate(`Array.from(document.querySelectorAll('.sidebar-bottom button')).find(button => button.textContent === 'Память').click()`)
  const shot = async file => {
    win.webContents.invalidate()
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await delay(500)
    fs.writeFileSync(path.join(path.dirname(screenshotPath), file), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  }
  fs.writeFileSync(screenshotPath, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  await evaluate(`document.querySelector('button[aria-label="Переписка"]').click()`)
  await waitFor(() => evaluate(`document.querySelectorAll('.agent-communications .communication-item').length === 4`), 'team correspondence restored')
  assert.ok(await evaluate(`document.querySelector('.agent-communications').textContent.includes('Создание агента')`))
  assert.ok(await evaluate(`document.querySelector('.agent-communications').textContent.includes('ORBIT_CHILD')`))
  assert.ok(await evaluate(`document.querySelector('.agent-communications').textContent.includes('Проверь память отдельно')`))
  assert.ok(await evaluate(`document.querySelector('.agent-communications').textContent.includes('Подтверждаю: сообщение получено')`))
  assert.ok(!await evaluate(`document.querySelector('.conversation').textContent.includes('Подтверждаю: сообщение получено')`), 'team messages must not become user chat replies')
  await delay(1100)
  fs.writeFileSync(path.join(path.dirname(screenshotPath), 'agent-correspondence.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  await evaluate(`document.querySelector('button[aria-label="Граф агентов"]').click()`)
  await waitFor(() => evaluate(`document.querySelectorAll('.agent-graph-node').length === 2`), 'spawn graph rendered')
  assert.equal(await evaluate(`document.querySelectorAll('.agent-graph-edge').length`), 1)
  assert.equal(await evaluate(`document.querySelector('.agent-graph-edge').getAttribute('data-parent')`), 'root')
  await evaluate(`document.querySelector('.agent-graph-node[aria-label="Выбрать агента Проверка"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  assert.equal(await evaluate(`document.querySelector('.agent-graph-node[aria-label="Выбрать агента Проверка"]').getAttribute('aria-pressed')`), 'true')
  win.webContents.invalidate()
  await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  await delay(500)
  fs.writeFileSync(path.join(path.dirname(screenshotPath), 'agent-graph.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  await evaluate(`Array.from(document.querySelectorAll('.sidebar-bottom button')).find(button => button.textContent === 'Навыки').click()`)
  await waitFor(() => evaluate(`!!document.querySelector('.library-entry details')`), 'capability library loaded')
  assert.match(await evaluate(`document.querySelector('.tier-stats').textContent`), /Проект[\s\S]*Общие[\s\S]*Применялись/)
  await shot('skills-panel.png')
  await evaluate(`document.querySelector('.library-entry details').open = true`)
  await waitFor(() => evaluate(`document.querySelector('.library-entry')?.textContent.includes('Use the existing project checks')`), 'skill instructions loaded')
  await evaluate(`Array.from(document.querySelectorAll('.library-entry button')).find(button => button.textContent === 'Редактировать').click()`)
  await evaluate(`(() => { const field = document.querySelector('textarea[aria-label="Инструкции навыка"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Run the updated project checks'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await delay(30)
  await evaluate(`Array.from(document.querySelectorAll('.library-entry button')).find(button => button.textContent === 'Сохранить новую версию').click()`)
  await waitFor(() => evaluate(`document.querySelector('.library-entry .scope-label')?.textContent.includes('v2')`), 'new skill version saved')
  await evaluate(`document.querySelector('.library-entry details').open = true`)
  await waitFor(() => evaluate(`!!document.querySelector('select[aria-label="Предыдущая версия навыка"]')`), 'skill history loaded')
  await evaluate(`(() => { const field = document.querySelector('select[aria-label="Предыдущая версия навыка"]'); field.value = '1'; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await delay(30)
  await evaluate(`Array.from(document.querySelectorAll('.library-entry button')).find(button => button.textContent === 'Восстановить').click()`)
  await waitFor(() => evaluate(`document.querySelector('.library-entry .scope-label')?.textContent.includes('v3')`), 'skill revision restored')
  const skills = await evaluate(`window.orbit.listCapabilities(${JSON.stringify(workspaces[0])})`)
  assert.equal((await evaluate(`window.orbit.readCapability(${JSON.stringify(skills[0].id)}, ${JSON.stringify(workspaces[0])})`)).instructions, 'Use the existing project checks')
  // ---- Memory tiers: chat / project / shared, a note of this chat, pinning ----
  await evaluate(`document.querySelector('button[aria-label="Закрыть"]').click()`)
  await openMemoryPanel()
  await waitFor(() => evaluate(`!!document.querySelector('.tier-stats')`), 'memory tiers shown')
  assert.match(await evaluate(`document.querySelector('.tier-stats').textContent`), /Чат[\s\S]*Проект[\s\S]*Общая/)
  await evaluate(`Array.from(document.querySelectorAll('.library-form button')).find(button => button.textContent.includes('Добавить запись')).click()`)
  await waitFor(() => evaluate(`!!document.querySelector('.library-form input')`), 'memory form open')
  await evaluate(`(() => {
    const set = (element, prototype, value) => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(prototype === HTMLSelectElement.prototype ? 'change' : 'input', { bubbles: true })) }
    set(document.querySelector('.library-form input'), HTMLInputElement.prototype, 'Ограничение этого чата')
    set(document.querySelector('.library-form textarea'), HTMLTextAreaElement.prototype, 'Не трогать модуль оплаты в этой задаче')
    set(document.querySelector('.library-form select[aria-label="Область действия"]'), HTMLSelectElement.prototype, 'chat')
  })()`)
  await delay(50)
  await evaluate(`document.querySelector('.library-form form').requestSubmit()`)
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.library-group .section-label')).some(label => label.textContent.startsWith('ЧАТ'))`), 'the note appears in the chat group')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.library-entry')).some(card => card.textContent.includes('Не трогать модуль оплаты'))`))
  assert.equal((await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[0])})`)).length, 1, 'without a chat id the note is invisible: chat notes belong to their chat')
  assert.equal((await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[1])})`)).length, 0)
  await evaluate(`Array.from(document.querySelectorAll('.library-entry')).find(card => card.textContent.includes('Не трогать модуль оплаты')).querySelector('button[aria-label^="Закрепить"]').click()`)
  await waitFor(() => evaluate(`!!document.querySelector('.library-entry.pinned')`), 'the note is pinned')
  await shot('memory-panel.png')
  await evaluate(`document.querySelector('button[aria-label="Закрыть"]').click()`)
  await openMemoryPanel()
  await waitFor(() => evaluate(`!!document.querySelector('.library-entry.pinned')`), 'the pin survives reopening')
  await evaluate(`document.querySelector('button[aria-label="Закрыть"]').click()`)
  win.setSize(900, 700)
  await delay(100)
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`), 'narrow layout should not overflow')
  await evaluate(`document.querySelector('.chat-delete').click()`)
  await waitFor(() => evaluate(`!document.querySelector('.conversation')?.textContent.includes('контекст проекта Альфа сохранён')`), 'deleted active chat replaced')
  await delay(700)
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'ready after deleting chat')
  assert.ok(!await evaluate(`document.querySelector('.conversation').textContent.includes('контекст проекта Альфа сохранён')`), 'run history must not resurrect deleted chats')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-list .chat-item').length`), 1)
  await switchProject('Бета')
  assert.equal(await evaluate(`document.querySelectorAll('.message.user').length`), 2, 'other project chats remain intact')
  await evaluate(`document.querySelector('.new-chat').click()`)
  await send('ORBIT_PARALLEL_1')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.some(run => run.prompt === 'ORBIT_PARALLEL_1' && run.status === 'working'))`), 'first parallel chat active')
  await evaluate(`document.querySelector('.new-chat').click()`)
  await send('ORBIT_PARALLEL_2')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.filter(run => run.prompt.startsWith('ORBIT_PARALLEL_') && run.status === 'working').length === 2)`), 'two write chats active in the same project')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.filter(run => run.prompt.startsWith('ORBIT_PARALLEL_') && run.status === 'completed').length === 2)`), 'parallel chats complete independently')
  assert.equal(await evaluate(`document.querySelectorAll('.message.orbit').length`), 1, 'parallel answers stay in their own chats')

  // ---- Subscription quotas: the window shows what is left, and a running agent moves to another subscription ----
  const setSelect = (label, value) => evaluate(`(() => { const field = document.querySelector('select[aria-label="${label}"]'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  const openSidebar = name => evaluate(`Array.from(document.querySelectorAll('.sidebar-bottom button')).find(button => button.textContent.startsWith(${JSON.stringify(name)})).click()`)
  const card = name => evaluate(`(() => { const card = document.querySelector('.quota-card[aria-label="Квота ${name}"]'); return card && { state: card.querySelector('.quota-state').textContent, meters: Array.from(card.querySelectorAll('[role=meter]')).map(meter => Number(meter.getAttribute('aria-valuenow'))), text: card.textContent } })()`)
  await openSidebar('Квоты')
  await waitFor(() => evaluate(`document.querySelectorAll('.quota-card').length === 6`), 'a quota card for every provider')
  await waitFor(async () => (await card('Codex'))?.meters.length === 2, 'Codex windows shown')
  const codex = await card('Codex'), claude = await card('Claude Code')
  assert.deepEqual(codex.meters, [97, 46]); assert.equal(codex.state, 'Скоро закончится')
  assert.ok(codex.text.includes('осталось 3%') && codex.text.includes('plus') && codex.text.includes('сброс через'), codex.text)
  assert.deepEqual(claude.meters, [12, 30]); assert.equal(claude.state, 'В норме')
  assert.ok((await card('Cursor')).text.includes('fixture: no numbers') && (await card('Cursor')).text.includes('Free'))
  assert.equal((await card('Antigravity')).state, 'Не подключён')
  assert.ok(await evaluate(`!!document.querySelector('.quota-failover input[aria-label="Порог автозамены, процентов"]')`), 'failover threshold control')
  await shot('quota-panel.png')
  await evaluate(`document.querySelector('button[aria-label="Закрыть"]').click()`)
  await setSelect('Провайдер', 'codex')
  await waitFor(() => evaluate(`document.querySelector('.composer-caption .quota-chip')?.textContent.includes('Codex: 5 ч 3% ост.')`), 'quota chip for the chosen provider')

  // Ahead of the limit: Codex is at 97%, so the agent starts on Claude and Codex is never called.
  await evaluate(`document.querySelector('.new-chat').click()`)
  await send('ORBIT_QUOTA_SWITCH: проверь автозамену')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.some(run => run.prompt.startsWith('ORBIT_QUOTA_SWITCH') && run.status === 'completed'))`), 'proactive replacement run completes')
  const proactive = (await evaluate(`window.orbit.listRuns()`)).find(run => run.prompt.startsWith('ORBIT_QUOTA_SWITCH'))
  assert.deepEqual([proactive.agents[0].providerId, proactive.agents[0].handovers.length, proactive.agents[0].handovers[0].reason, proactive.agents[0].handovers[0].fresh], ['claude', 1, 'approaching', true])
  assert.deepEqual([fixtureCounters().codexRuns, fixtureCounters().claudeRuns], [0, 1], 'the nearly empty subscription was not called')
  await waitFor(() => evaluate(`document.querySelector('.conversation').textContent.includes('Замена агента «Orbit»') && document.querySelector('.conversation').textContent.includes('Ответ Claude после замены подписки.')`), 'replacement announced in the chat')

  // After a refusal: Codex looks healthy (20%) but refuses the request; the agent moves on and Codex is marked.
  setFixtures({ codexUsed: 20 })
  await evaluate(`window.orbit.getQuotas({}, true).then(() => true)`)
  await waitFor(() => evaluate(`document.querySelector('.composer-caption .quota-chip')?.textContent.includes('Codex: 5 ч 80% ост.')`), 'chip follows the fresh reading')
  await evaluate(`document.querySelector('.new-chat').click()`)
  await send('ORBIT_QUOTA_REFUSED: проверь замену после отказа')
  await waitFor(() => evaluate(`window.orbit.listRuns().then(runs => runs.some(run => run.prompt.startsWith('ORBIT_QUOTA_REFUSED') && run.status === 'completed'))`), 'reactive replacement run completes')
  const reactive = (await evaluate(`window.orbit.listRuns()`)).find(run => run.prompt.startsWith('ORBIT_QUOTA_REFUSED'))
  assert.deepEqual([reactive.agents[0].providerId, reactive.agents[0].handovers[0].reason, reactive.agents[0].turns, reactive.usage.providerTurns], ['claude', 'exhausted', 1, 1], 'the refused attempt is not a turn')
  assert.deepEqual([fixtureCounters().codexRuns, fixtureCounters().claudeRuns], [1, 2])
  await waitFor(() => evaluate(`document.querySelector('.conversation').textContent.includes('квота исчерпана') && document.querySelector('.conversation').textContent.includes('Ответ Claude после замены подписки.')`), 'refusal replacement announced in the chat')
  await waitFor(() => evaluate(`document.querySelector('.composer-caption .quota-chip.exhausted') !== null`), 'chip shows the refused provider as exhausted')
  await evaluate(`(() => { if (!document.querySelector('.agents-panel')) document.querySelector('.agents-toggle').click() })()`)
  await waitFor(() => evaluate(`document.querySelector('.agent-row .handover-badge')?.textContent.includes('Сменил подписку: 1')`), 'agent row marks the change')
  assert.ok(await evaluate(`document.querySelector('.agent-inspector').textContent.includes('СМЕНА ПОДПИСКИ')`), 'inspector lists the handover')
  await evaluate(`document.querySelector('.agent-inspector details.trace-item')?.setAttribute('open', '')`)
  await evaluate(`document.querySelector('.toast button')?.click()`)
  await shot('failover-agents.png')
  await openSidebar('Квоты')
  await waitFor(async () => (await card('Codex'))?.state === 'Исчерпана', 'refused provider is shown as exhausted')
  assert.ok((await card('Codex')).text.includes('Провайдер отказал в запросе'))
  assert.ok((await card('Claude Code')).text.includes('Orbit'), 'the agent now listed under the subscription it runs on')
  await shot('quota-panel-after-failover.png')
  await evaluate(`(() => { const field = document.querySelector('.quota-failover input[type=range]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '75'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await evaluate(`Array.from(document.querySelectorAll('.quota-failover input[type=checkbox]')).at(-1).click()`)
  await delay(700)
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'ready after reload')
  await openSidebar('Квоты')
  await waitFor(() => evaluate(`document.querySelector('.quota-failover input[type=range]')?.value === '75'`), 'failover threshold survives reload')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.quota-failover input[type=checkbox]')).at(-1).checked`), 'weaker-model permission survives reload')
  assert.ok(fixtureCounters().quotaReads > 0)

  // ---- The runtime process restarts with the window open (Settings → Runtime): a call made meanwhile waits for the new
  // runtime, and everything the old one saved is there ----
  if (runtimeMode === 'child') {
    await evaluate(`document.querySelector('button[aria-label="Закрыть"]').click()`)
    const runsBefore = (await evaluate(`window.orbit.listRuns()`)).length
    const memoryBefore = (await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[0])})`)).length
    const before = await evaluate(`window.orbit.getRuntimeStatus()`)
    await evaluate(`(() => { window.__runtimeStates = []; window.orbit.onRuntimeStatus(status => window.__runtimeStates.push(status.state)) })()`)
    await openSidebar('Настройки')
    const restartButton = `Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Перезапустить runtime'))`
    await waitFor(() => evaluate(`!!${restartButton} && !${restartButton}.disabled`), 'runtime section shown')
    await evaluate(`(() => { ${restartButton}.click(); window.__listedDuring = window.orbit.listRuns().then(runs => runs.length) })()`)
    await waitFor(() => evaluate(`!!document.querySelector('.runtime-result')`), 'runtime restart result shown')
    const result = await evaluate(`({ ok: document.querySelector('.runtime-result').classList.contains('ok'), text: document.querySelector('.runtime-result').textContent })`)
    assert.ok(result.ok, result.text)
    const after = await evaluate(`window.orbit.getRuntimeStatus()`)
    assert.deepEqual([after.state, after.mode, after.restarts], ['ready', 'child', 1])
    assert.notEqual(after.pid, before.pid, 'a new runtime process')
    assert.ok(result.text.includes(`${after.lastRestartMs} мс`) && result.text.includes(`pid ${after.pid}`), result.text)
    assert.equal(await evaluate(`window.__listedDuring`), runsBefore, 'the call made during the restart was answered by the new runtime')
    assert.ok(await evaluate(`window.__runtimeStates.includes('restarting') && window.__runtimeStates.at(-1) === 'ready'`), await evaluate(`JSON.stringify(window.__runtimeStates)`))
    assert.equal((await evaluate(`window.orbit.listRuns()`)).length, runsBefore, 'the run history survives the runtime restart')
    assert.equal((await evaluate(`window.orbit.listMemory(${JSON.stringify(workspaces[0])})`)).length, memoryBefore, 'so does the memory')
    assert.ok(await evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]')`), 'the window was never closed')
    timings.runtimeRestartMs = after.lastRestartMs
    await evaluate(`document.querySelector('.runtime-result').scrollIntoView({ block: 'center' })`)
    await shot('runtime-restart.png')
  }
  assert.deepEqual(errors, [])
  const { codexRuns, claudeRuns } = fixtureCounters()
  console.log(JSON.stringify({ ok: true, runtimeMode, projects: 2, runs: 7, agents: 8, communications: 4, agentGraph: true, alphaCalls, betaCalls, childCalls, reload: true, parallelChats: true, fixedInspectorTabs: true, scopeIsolation: true, skillVersions: 3, quotaPanel: true, failover: { proactive: true, refused: true, codexRuns, claudeRuns }, runtimeRestartMs: timings.runtimeRestartMs ?? null, screenshotPath }))
}

let orbit = null
const timeout = setTimeout(() => { console.error('Desktop verification exceeded 60 seconds'); app.exit(1) }, 60000)
let started = false
app.on('browser-window-created', (_event, win) => {
  if (started) return
  started = true
  win.webContents.once('did-finish-load', async () => {
    let code = 0
    try { await exercise(win) } catch (error) { console.error(error.stack); code = 1 }
    // The runtime shuts down as on quit (its runs stop, its stores are saved) before the process exits.
    const stopping = Date.now()
    try { await orbit?.shutdownRuntime('quit') } catch (error) { console.error(`runtime shutdown failed: ${error.stack}`); code = 1 }
    console.log(JSON.stringify({ runtimeShutdownMs: Date.now() - stopping }))
    clearTimeout(timeout)
    server.closeAllConnections()
    server.close()
    win.destroy()
    app.exit(code)
  })
})
app.on('quit', () => {
  // Electron may still own profile handles on Windows; cleanup is best-effort.
  if (path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    try { fs.rmSync(temporary, { recursive: true, force: true }) } catch { /* OS releases profile handles after exit. */ }
  }
})
server.listen(0, '127.0.0.1', () => {
  process.env.ORBIT_OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  orbit = require('../electron/main.cjs')
})
