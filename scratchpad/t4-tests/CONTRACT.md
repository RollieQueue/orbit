# T4 contract (postponed 2026-09-30 16:11Z at the user's request: "делай задачу 6")

Tests written to this contract by loop-tests (claude-sonnet-5-5), never run: full copies of the three test files in
this folder (improvement-loop.test.cjs, improvement-loop-runtime.test.cjs, state-store.test.cjs); the *.diff files are
the recorded first edits. The runtime-side unit tests (keptTitles, blocked rule, reminderFor) were not written yet.

Renderer (src/improvement-loop.ts, useOrbitState.ts, types.ts, state-store.ts, ChatPane.tsx):
- BUSY_RETRY_MS = [5000, 10000, 30000]; busyRetryDelay(n) clamps n to 1..3.
- isBusyRefusal(text): the three "wait and retry" refusals of lifecycle.start (export them from
  electron/runtime/lifecycle.mts as START_REFUSALS = { chatBusy, restarting, cleanup }), also inside
  "Error invoking remote method '...': Error: <text>".
- loopStartFailed(started, previousIteration, error, now) -> { loop, note? }:
  busy: iteration back, busyStarts+1, retryAt = now + busyRetryDelay(busyStarts), failures/startFailures unchanged, no note.
  other: startFailures+1, retryAt = now + retryDelay(startFailures), busyStarts removed, failures UNCHANGED, warning note.
- nextLoopStep: handling a NEW latest run drops startFailures and busyStarts from the loop it returns.
  => a refused start after a run that moved the plan no longer yields NO_PROGRESS_TEXT (TECH-DEBT 19.1).
- loopView: retryAt + busyStarts > 0 -> phase 'waiting', text 'ждёт, пока Orbit освободится…'.
- activateLoop also deletes startFailures and busyStarts. useOrbitState: add the warning only when note is set.

Runtime (electron/runtime/improvement.mts, electron/types.mts):
- run.improvementBaseline: Map<id, ImprovementTask> of the tasks closed when the run started (was Set of 'id|title').
- updatePlan: a task whose id is in the baseline keeps the baseline title (result keptTitles: [ids], note mentions it).
- status 'blocked' needs a blocked task that is new in this run: id not in the baseline, or not blocked then, or
  blocked then with different trimmed evidence; else Error 'Blocked plan requires a blocker documented in this run…'.
- missing(): closed in this run = closed task whose id is not in the baseline.
TECH-DEBT 19.4 (reverted edit still asks for restart_orbit) moved to T7.
