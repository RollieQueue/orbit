// Actual Electron + renderer + preload + IPC + HTTP adapter integration.
// All profiles and workspaces are temporary; no vendor model is called.
const { app, BrowserWindow, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { StateStore } = require('../electron/run-store.cjs')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-desktop-test-'))
const profile = path.join(temporary, 'profile')
const workspaces = [path.join(temporary, 'alpha'), path.join(temporary, 'beta')]
workspaces.forEach(folder => fs.mkdirSync(folder))
process.env.ORBIT_USER_DATA = profile
process.env.ORBIT_DEV = '0'
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
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, projects: 2, runs: 5, agents: 6, communications: 4, agentGraph: true, alphaCalls, betaCalls, childCalls, reload: true, parallelChats: true, fixedInspectorTabs: true, scopeIsolation: true, skillVersions: 3, screenshotPath }))
}

const timeout = setTimeout(() => { console.error('Desktop verification exceeded 60 seconds'); app.exit(1) }, 60000)
let started = false
app.on('browser-window-created', (_event, win) => {
  if (started) return
  started = true
  win.webContents.once('did-finish-load', async () => {
    let code = 0
    try { await exercise(win) } catch (error) { console.error(error.stack); code = 1 }
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
  require('../electron/main.cjs')
})
