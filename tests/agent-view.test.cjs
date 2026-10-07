const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/skill-groups.test.cjs: vite's oxc transform, then an ES module from a data URL (agent-view.ts has type imports only).
let view
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'agent-view.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  view = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
})

const cap = (id, over = {}) => ({ id, name: id, description: '', instructions: '', scope: 'project', ...over })
const agentOf = (rounds = [], over = {}) => ({ role: 'r', status: 'trained', rounds, gallery: [], ...over })
const round = (n, score, over = {}) => ({ at: '2026-10-02T10:00:00.000Z', round: n, concepts: [], score, ...over })

test('splitCapabilities: agents are told apart by the agent field, skills keep the order, agents go pinned, used, newest', () => {
  const list = [
    cap('s1'), cap('a-old', { agent: agentOf(), uses: 1, updatedAt: '2026-01-01T00:00:00Z' }), cap('s2'),
    cap('a-new', { agent: agentOf(), uses: 1, updatedAt: '2026-05-01T00:00:00Z' }), cap('a-used', { agent: agentOf(), uses: 9 }),
    cap('a-pinned', { agent: agentOf(), pinned: true }), cap('s3', { agent: null }),
  ]
  const { skills, agents } = view.splitCapabilities(list)
  assert.deepEqual(skills.map(item => item.id), ['s1', 's2', 's3'])
  assert.deepEqual(agents.map(item => item.id), ['a-pinned', 'a-used', 'a-new', 'a-old'])
  assert.deepEqual(list.map(item => item.id), ['s1', 'a-old', 's2', 'a-new', 'a-used', 'a-pinned', 's3'], 'the input is not reordered')
  assert.deepEqual(view.splitCapabilities([]), { skills: [], agents: [] })
})

test('parseTab: only the known tabs, a stale value is the skills tab', () => {
  assert.equal(view.parseTab('agents'), 'agents')
  assert.equal(view.parseTab('skills'), 'skills')
  for (const stale of [null, undefined, '', 'connectors', 'Agents', 3, {}]) assert.equal(view.parseTab(stale), 'skills')
  assert.deepEqual(view.PANEL_TABS.map(tab => tab.id), ['skills', 'agents'])
})

test('scoreChart: fixed 0..10 scale, points spread evenly, rounded to a tenth', () => {
  const pad = { left: 10, right: 10, top: 10, bottom: 10 }
  const chart = view.scoreChart([round(1, 0), round(2, 5), round(3, 10)], 120, 120, pad)
  assert.deepEqual(chart.points, [{ x: 10, y: 110, round: 1, score: 0 }, { x: 60, y: 60, round: 2, score: 5 }, { x: 110, y: 10, round: 3, score: 10 }])
  assert.equal(chart.path, 'M10 110 L60 60 L110 10')
  assert.deepEqual(chart.ticks, [{ y: 110, label: '0' }, { y: 60, label: '5' }, { y: 10, label: '10' }])
  assert.deepEqual(chart.xTicks, [{ x: 10, label: '1' }, { x: 60, label: '2' }, { x: 110, label: '3' }])
  const odd = view.scoreChart([round(1, 3.3), round(2, 7.5), round(3, 6), round(4, 1)], 100, 70, pad)
  assert.deepEqual(odd.points.map(point => point.x), [10, 36.7, 63.3, 90], 'x: 80 / 3 per step, rounded to a tenth')
  assert.equal(odd.points[0].y, 43.5)
  assert.equal(odd.points[1].y, 22.5)
})

test('scoreChart: clamps scores, skips NaN, sorts by round, a single round is centred, empty is empty', () => {
  const pad = { left: 10, right: 10, top: 10, bottom: 10 }
  const clamped = view.scoreChart([round(1, -4), round(2, 99)], 120, 120, pad)
  assert.deepEqual(clamped.points.map(point => point.y), [110, 10])
  assert.deepEqual(clamped.points.map(point => point.score), [-4, 99], 'the real score stays for the tooltip')
  const skipped = view.scoreChart([round(1, 2), round(2, NaN), round(3, 8), round(4, undefined)], 120, 120, pad)
  assert.deepEqual(skipped.points.map(point => point.round), [1, 3])
  assert.deepEqual(skipped.points.map(point => point.x), [10, 110])
  const unsorted = view.scoreChart([round(3, 9), round(1, 1), round(2, 5)], 120, 120, pad)
  assert.deepEqual(unsorted.points.map(point => point.round), [1, 2, 3])
  assert.deepEqual(unsorted.points.map(point => point.score), [1, 5, 9])
  const single = view.scoreChart([round(1, 6)], 120, 120, pad)
  assert.deepEqual(single.points, [{ x: 60, y: 50, round: 1, score: 6 }])
  assert.equal(single.path, 'M60 50')
  assert.deepEqual(view.scoreChart([], 120, 120), { points: [], path: '', ticks: view.scoreChart([], 120, 120).ticks, xTicks: [] })
  assert.equal(view.scoreChart([], 120, 120).ticks.length, 3, 'the axis is drawn even without rounds')
  assert.doesNotThrow(() => view.scoreChart([round(1, 5)], 5, 5), 'a box smaller than the padding does not break')
})

test('scoreChart: many rounds label only some round numbers on the x axis', () => {
  const rounds = Array.from({ length: 50 }, (_, index) => round(index + 1, (index % 10) + 0.5))
  const chart = view.scoreChart(rounds, 400, 130)
  assert.equal(chart.points.length, 50)
  assert.ok(chart.xTicks.length <= 9 && chart.xTicks.length >= 2, `labels: ${chart.xTicks.length}`)
  assert.equal(chart.xTicks[0].label, '1')
})

test('trainingSummary and summaryText: first -> last, best, delta, minutes', () => {
  const summary = view.trainingSummary(agentOf([round(3, 8.4), round(1, 5.1), round(2, 9)], { trainingMinutes: 95 }))
  assert.deepEqual(summary, { rounds: 3, minutes: 95, first: 5.1, last: 8.4, best: 9, delta: 3.3 })
  assert.equal(view.summaryText(summary), 'Раундов: 3 · Обучение: 1 ч 35 мин · Оценка: 5.1 → 8.4 (+3.3) · лучшая 9.0')
  assert.deepEqual(view.trainingSummary(agentOf()), { rounds: 0 })
  assert.deepEqual(view.trainingSummary(agentOf([round(1, 6)], { trainingMinutes: 0 })), { rounds: 1, first: 6, last: 6, best: 6 })
  assert.equal(view.summaryText(view.trainingSummary(agentOf([round(1, 6)]))), 'Раундов: 1 · Оценка: 6.0')
  const drop = view.trainingSummary(agentOf([round(1, 8), round(2, 6.5)]))
  assert.equal(drop.delta, -1.5)
  assert.equal(view.summaryText(drop), 'Раундов: 2 · Оценка: 8.0 → 6.5 (−1.5) · лучшая 8.0')
  assert.equal(view.summaryText(view.trainingSummary(agentOf([round(1, NaN)]))), 'Раундов: 1', 'a round without a number has no score line')
})

test('formatMinutes', () => {
  assert.equal(view.formatMinutes(45), '45 мин')
  assert.equal(view.formatMinutes(95), '1 ч 35 мин')
  assert.equal(view.formatMinutes(120), '2 ч')
  assert.equal(view.formatMinutes(59.6), '1 ч')
  assert.equal(view.formatMinutes(0), '0 мин')
  assert.equal(view.formatMinutes(-3), '')
  assert.equal(view.formatMinutes(NaN), '')
})

test('galleryUrl: each segment is encoded on its own and cannot leave the package', () => {
  assert.equal(view.galleryUrl('pkg1', 'shots/fox 1.png'), 'orbit-skill://pkg1/shots/fox%201.png')
  assert.equal(view.galleryUrl('pkg1', 'ёлка/лиса.png'), `orbit-skill://pkg1/${encodeURIComponent('ёлка')}/${encodeURIComponent('лиса.png')}`)
  assert.equal(view.galleryUrl('pkg1', 'a#b?c%d.png'), 'orbit-skill://pkg1/a%23b%3Fc%25d.png', 'no query, no fragment, no double decoding')
  for (const hostile of ['../x.png', 'a/../../x.png', '..\\..\\x.png', '/abs/x.png', './x.png', 'a//b.png', 'a/./b.png']) {
    const url = view.galleryUrl('pkg1', hostile)
    assert.match(url, /^orbit-skill:\/\/pkg1\/[^/]/, hostile)
    assert.ok(!url.slice('orbit-skill://pkg1/'.length).split('/').some(part => part === '..' || part === '.' || part === ''), `${hostile} -> ${url}`)
    assert.equal(new URL(url).host, 'pkg1', hostile)
  }
  assert.equal(view.galleryUrl('pkg1', '../x.png'), 'orbit-skill://pkg1/x.png')
  assert.equal(view.galleryUrl('p k/..', 'x.png'), 'orbit-skill://p%20k%2F../x.png', 'the host is one encoded piece too')
})

test('labels: kind and status in Russian', () => {
  assert.deepEqual(['code', 'review', 'lookup', 'text'].map(kind => view.kindLabel(kind)), ['код', 'ревью', 'поиск', 'текст'])
  assert.equal(view.kindLabel(undefined), '')
  assert.equal(view.statusLabel('trained'), 'Обучен')
  assert.equal(view.statusLabel('training'), 'Обучается')
})
