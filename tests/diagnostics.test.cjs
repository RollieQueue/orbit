const test = require('node:test')
const assert = require('node:assert/strict')
const { report, enabled } = require('../electron/diagnostics.mts')

test('report is silent without ORBIT_DEBUG, prints with it and never throws', t => {
  const warnings = []
  const original = console.warn
  const saved = process.env.ORBIT_DEBUG
  console.warn = (...args) => warnings.push(args.join(' '))
  t.after(() => { console.warn = original; if (saved === undefined) delete process.env.ORBIT_DEBUG; else process.env.ORBIT_DEBUG = saved })

  delete process.env.ORBIT_DEBUG
  assert.equal(enabled(), false)
  assert.equal(report('quiet.place', new Error('quiet')), false)
  assert.deepEqual(warnings, [])
  for (const value of ['0', 'false', 'off', '', ' ']) { process.env.ORBIT_DEBUG = value; assert.equal(enabled(), false, JSON.stringify(value)) }

  process.env.ORBIT_DEBUG = '1'
  assert.equal(enabled(), true)
  assert.equal(report('providers: probe', new Error('loud')), true)
  assert.match(warnings[0], /^\[orbit\] providers: probe: Error: loud\n\s+at /, 'the place and the stack')
  report('plain', 'just text')
  assert.equal(warnings[1], '[orbit] plain: just text')
  report('empty', undefined)
  assert.equal(warnings[2], '[orbit] empty: undefined')
  for (const value of ['true', 'YES', 'on']) { process.env.ORBIT_DEBUG = value; assert.equal(enabled(), true, value) }

  console.warn = () => { throw new Error('console broke') }
  assert.doesNotThrow(() => report('broken console', new Error('x')))
})
