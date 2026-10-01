// Shared by tests/turn-progress*.test.cjs: waiting for what the window is sent instead of for a fixed time.

// Resolves true as soon as `check()` holds and false once `timeoutMs` has passed (the test's own assertion then says what is
// missing). The window gets a progress change once the runtime's throttle (a second) has passed, however long the machine takes.
async function eventually(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return true
}

module.exports = { eventually }
