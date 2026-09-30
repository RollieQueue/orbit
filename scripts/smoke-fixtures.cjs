'use strict'

// Hermetic subscriptions for scripts/smoke-desktop.cjs. The runtime loads this file through ORBIT_RUNTIME_FIXTURES
// before it exists (electron/runtime-child.cjs in its own process; the runtime client in `inprocess` mode): quota
// readings, provider health and two vendor CLIs are served from here, so the smoke never touches a real account or CLI.
// The smoke runs in another process than the runtime, so it steers these fixtures and reads what they did through two
// files in ORBIT_SMOKE_FIXTURE_DIR: control.json, written by the smoke ({ codexUsed }), and counters.json, written here
// ({ quotaReads, codexRuns, claudeRuns }). Without that variable the defaults apply and the counts stay in memory.
const fs = require('node:fs')
const path = require('node:path')
const providers = require('../electron/providers.mts')

const directory = process.env.ORBIT_SMOKE_FIXTURE_DIR || ''
const controlFile = directory ? path.join(directory, 'control.json') : ''
const countersFile = directory ? path.join(directory, 'counters.json') : ''
const soon = (hours) => Date.now() + hours * 3600000

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// A runtime the smoke restarts keeps counting where the previous process stopped.
const counters = { quotaReads: 0, codexRuns: 0, claudeRuns: 0, ...(countersFile ? readJson(countersFile) : null) }
function count(name) {
  counters[name]++
  if (countersFile) fs.writeFileSync(countersFile, JSON.stringify(counters))
}
function control() {
  return { codexUsed: 97, ...(controlFile ? readJson(controlFile) : null) }
}

// quota.mts's reader table is a plain object: the runtime hands it here before its monitor reads anything.
function patchQuotaReaders(readers) {
  readers.codex = async () => {
    count('quotaReads')
    return { windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: control().codexUsed, resetsAt: soon(2) }, { kind: 'week', scope: 'all', models: [], usedPercent: 46, resetsAt: soon(100) }], plan: 'plus' }
  }
  readers.claude = async () => ({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: 12, resetsAt: soon(3) }, { kind: 'week', scope: 'all', models: [], usedPercent: 30, resetsAt: soon(90) }], plan: 'max' })
  readers.antigravity = async () => ({ windows: [], state: 'unavailable', detail: 'fixture: CLI not installed' })
  readers.cursor = async () => ({ windows: [], state: 'unknown', plan: 'Free', detail: 'fixture: no numbers' })
}

async function inspectProviders() {
  return [
    { id: 'codex', supported: true, installed: true, available: true, authenticated: true, models: ['gpt-6-sol', 'gpt-6-luna'], reasoningLevels: {}, detail: 'fixture' },
    { id: 'claude', supported: true, installed: true, available: true, authenticated: true, models: ['sonnet', 'opus', 'haiku'], detail: 'fixture' },
    { id: 'custom', supported: true, available: true, authenticated: null, detail: 'fixture endpoint', model: 'fixture-model' },
  ]
}

// Codex and Claude answer from here; the custom provider is the real HTTP adapter, pointed at the smoke's own server.
async function runProvider(options) {
  if (options.providerId === 'codex') {
    count('codexRuns')
    if (options.prompt.includes('ORBIT_QUOTA_REFUSED')) throw new Error("You've hit your usage limit. Try again in 3 hours 22 minutes.")
    return { text: 'Ответ Codex.', model: 'gpt-6-sol' }
  }
  if (options.providerId === 'claude') {
    count('claudeRuns')
    return { text: 'Ответ Claude после замены подписки.', model: 'claude-opus-fixture' }
  }
  return providers.runProvider(options)
}

module.exports = { runProvider, inspectProviders, patchQuotaReaders, counters }
