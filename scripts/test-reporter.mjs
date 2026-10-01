/**
 * Compact node:test reporter for `npm test` (node 22). A passing run prints ONE summary line instead of a TAP line and a
 * YAML block per test (~800 tests, tens of thousands of lines): every character of a command's output stays in an agent's
 * context and is re-read on every later step. Nothing a reader needs is dropped: every failing test is printed in full
 * (file:line, name path, failure type, error message with the assertion diff and the stack without node:internal frames),
 * so are file-level failures (a file that does not load, crashes, exits non-zero, a test that times out or is cancelled)
 * together with what the failing file wrote to stderr and node's own notes on it (an unhandled rejection after a test
 * ended arrives only as such a note). Each failure is printed the moment it arrives, so a file that hangs later cannot
 * swallow it; stderr, notes and the summary come at the end. Todo tests are not failures. The exit code is node's own and
 * is not touched here.
 *
 * The full output of a person's choice: ORBIT_TEST_REPORTER=spec npm test (also tap, dot, junit: reporters of
 * node:test/reporters). In PowerShell: $env:ORBIT_TEST_REPORTER = 'spec'; npm test.
 *
 * scripts/self-upgrade.cjs does not use this file: it runs node --test itself and parses the TAP `not ok` entries.
 */
import * as builtin from 'node:test/reporters'
import nodePath from 'node:path'
import { Readable } from 'node:stream'
import { inspect } from 'node:util'

const STDERR_LIMIT = 6000
const ERROR_LIMIT = 8000
const DIAGNOSTICS_LIMIT = 3000
const NESTED_DEPTH = 3
const NESTED_ERRORS = 10
const NO_TEST_FILE = '(no file)'

/** Stack frames inside node itself say nothing about the test: dropped. */
function withoutInternalFrames(text) {
  return text.split('\n').filter((line) => !/^\s+at .*node:internal\//.test(line)).join('\n').replace(/\s+$/, '')
}

function indent(text, pad) {
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n')
}

/** One thrown value as text: an error's stack (it carries the assertion diff), anything else through util.inspect. */
function valueText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error || (value && typeof value.stack === 'string' && value.stack)) return value.stack || String(value.message)
  if (value && typeof value.message === 'string') return value.message
  return inspect(value, { depth: 3, breakLength: 120, maxArrayLength: 20, maxStringLength: 2000 })
}

/** A thrown value with what hangs off it: `[cause]` and the `[errors]` of an AggregateError, nested and bounded. */
function renderError(value, depth, seen) {
  if (value == null || typeof value !== 'object') return valueText(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  let text = valueText(value)
  if (depth < NESTED_DEPTH) {
    if (value.cause != null) text += `\n[cause]: ${indent(renderError(value.cause, depth + 1, seen), '  ').trimStart()}`
    if (Array.isArray(value.errors)) {
      value.errors.slice(0, NESTED_ERRORS).forEach((item, index) => {
        text += `\n[errors][${index}]: ${indent(renderError(item, depth + 1, seen), '  ').trimStart()}`
      })
      if (value.errors.length > NESTED_ERRORS) text += `\n[errors]: ... ${value.errors.length - NESTED_ERRORS} more`
    }
  }
  return text
}

/**
 * An error as text: the original error behind node's wrapper with its cause chain and AggregateError members, plus the
 * exit code and signal of a file whose process died; stack frames inside node itself are dropped, the whole is bounded.
 */
function errorText(error) {
  if (error == null) return ''
  const original = error.cause ?? error
  let text = renderError(original, 0, new Set())
  if (original !== error && typeof error.message === 'string' && error.message && !text.includes(error.message) &&
    error.message !== 'test failed') text = `${error.message}\n${text}`
  const exit = []
  if (error.exitCode != null) exit.push(`exit code ${error.exitCode}`)
  if (error.signal) exit.push(`signal ${error.signal}`)
  if (exit.length) text += `${text ? '\n' : ''}[the test process ended: ${exit.join(', ')}]`
  text = withoutInternalFrames(text)
  return clip(text, ERROR_LIMIT)
}

/** A text up to the limit whole, else its start and its end. */
function clip(text, limit) {
  if (text.length <= limit) return text
  const half = limit / 2
  return `${text.slice(0, half)}\n[... ${text.length - limit} characters omitted ...]\n${text.slice(-half)}`
}

/** What a failing file wrote to stderr. */
function stderrText(chunks) {
  return clip(withoutInternalFrames(chunks.join('')), STDERR_LIMIT)
}

/** Node names a file relative to the cwd on some events and absolutely on others: one key for both. */
function fileKey(file) {
  return file ? nodePath.resolve(String(file)) : NO_TEST_FILE
}

function relativeFile(file) {
  return file ? nodePath.relative(process.cwd(), fileKey(file)).split(nodePath.sep).join('/') : NO_TEST_FILE
}

async function* compact(source) {
  const started = Date.now()
  const names = new Map() // file -> names of the tests that are running, by nesting
  const stderr = new Map() // file -> what it wrote to stderr
  const files = new Set()
  const diagnostics = new Map() // file -> node's explanations (unhandled rejections after a test ended, ...)
  const failedFiles = new Set()
  let failureCount = 0
  let total = null

  for await (const event of source) {
    const data = event.data
    const key = fileKey(data.file)
    if (data.file) files.add(key)
    switch (event.type) {
      case 'test:start': {
        const trail = names.get(key) ?? []
        trail.length = data.nesting
        trail[data.nesting] = data.name
        names.set(key, trail)
        break
      }
      case 'test:stderr': {
        const list = stderr.get(key) ?? []
        list.push(data.message)
        stderr.set(key, list)
        break
      }
      case 'test:diagnostic': {
        // Run-wide lines (tests 3, pass 2, ...) carry no file; the rest explain what happened in that file.
        if (!data.file) break
        const list = diagnostics.get(key) ?? []
        list.push(data.message)
        diagnostics.set(key, list)
        break
      }
      case 'test:fail': {
        // A todo test is expected to fail: node counts it as todo, not as a failure.
        if (data.todo !== undefined) break
        const error = data.details?.error
        // A parent whose subtests failed is already explained by those subtests.
        if (error?.failureType === 'subtestsFailed') break
        const file = relativeFile(data.file)
        const trail = (names.get(key) ?? []).slice(0, data.nesting)
        trail.push(data.name)
        const fileLevel = data.nesting === 0 && fileKey(data.name) === key
        const where = data.line ? `${file}:${data.line}${data.column ? `:${data.column}` : ''}` : file
        const kind = error?.failureType && error.failureType !== 'testCodeFailure' ? ` [${error.failureType}]` : ''
        const title = fileLevel ? `FAIL ${where} (the file as a whole)${kind}` : `FAIL ${where}${kind}\n  ${trail.join(' > ')}`
        const message = errorText(error)
        failedFiles.add(key)
        failureCount += 1
        // At once, not at the end: a file that hangs later must not swallow what already failed.
        yield `${title}${message ? `\n${indent(message, '    ')}` : ''}\n\n`
        break
      }
      case 'test:summary':
        if (!data.file) total = data
        break
      default:
    }
  }

  const lines = []
  for (const file of failedFiles) {
    const text = stderrText(stderr.get(file) ?? [])
    if (text) lines.push(`stderr of ${relativeFile(file)}:`, indent(text, '    '), '')
    const notes = clip((diagnostics.get(file) ?? []).join('\n'), DIAGNOSTICS_LIMIT)
    if (notes) lines.push(`node's notes on ${relativeFile(file)}:`, indent(notes, '    '), '')
  }
  const counts = total?.counts
  const seconds = ((total?.duration_ms ?? Date.now() - started) / 1000).toFixed(1)
  if (counts) {
    lines.push(`tests ${counts.tests} | pass ${counts.passed} | fail ${counts.failed} | cancelled ${counts.cancelled} | ` +
      `skipped ${counts.skipped} | todo ${counts.todo} | files ${files.size} | ${seconds}s`)
  } else {
    lines.push(`no test summary received (${failureCount} failure(s) above) | files ${files.size} | ${seconds}s`)
  }
  if (total && !total.success && failureCount === 0) {
    lines.push('The run failed but no failing test was reported: rerun with ORBIT_TEST_REPORTER=spec npm test for the full output.')
  }
  yield `${lines.join('\n')}\n`
}

export default async function* testReporter(source) {
  const wanted = process.env.ORBIT_TEST_REPORTER
  if (wanted && wanted !== 'compact') {
    const reporter = ['spec', 'tap', 'dot', 'junit'].includes(wanted) ? builtin[wanted] : null
    if (typeof reporter !== 'function') {
      throw new Error(`ORBIT_TEST_REPORTER=${wanted}: expected compact, spec, tap, dot or junit`)
    }
    // spec is a stream (made with new), tap, dot and junit are generator functions.
    yield* wanted === 'spec' ? Readable.from(source).pipe(new reporter()) : reporter(source)
    return
  }
  yield* compact(source)
}
