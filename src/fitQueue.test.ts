import { describe, it, expect } from 'vitest'
import { AUTO_REVIVE_MAX as RENDERER_AUTO_REVIVE_MAX } from './types'
import { AUTO_REVIVE_MAX as MAIN_AUTO_REVIVE_MAX } from '../electron/types'
import { queueItemStatusText } from './fitQueue'
import type { AIQueueItem } from './types'

/**
 * The renderer keeps its own copy of the main process's revive budget.
 *
 * It is a duplicate rather than an import because the renderer must not
 * depend on a main-process module: electron/types.ts is a type surface
 * today, but the day someone puts an `electron` import in it the whole
 * renderer bundle breaks, and nothing at the call site would say why. The
 * cost of the copy is that it can drift, so it is pinned here — if either
 * side moves, this fails instead of the Queue panel quietly lying about
 * whether a task is coming back.
 */
describe('AUTO_REVIVE_MAX drift guard', () => {
  it('matches the main process', () => {
    expect(RENDERER_AUTO_REVIVE_MAX).toBe(MAIN_AUTO_REVIVE_MAX)
  })

  it('is a positive budget', () => {
    // Zero would make every failed task read as "needs attention"; a
    // negative one would do the same with no way to spend it down.
    expect(RENDERER_AUTO_REVIVE_MAX).toBeGreaterThan(0)
  })
})

/**
 * Why the equality above matters: the renderer uses the number to decide
 * whether a failed task still has automatic recovery left, and the main
 * process uses it to decide whether to grant a revival. When the two
 * disagree, the panel either promises a retry that will never come (the
 * main process has already spent the budget) or refuses to mention a
 * retry that is coming (the main process still has budget and the user
 * is left thinking the task is dead).
 */
describe('the rendered status agrees with the main process on the budget', () => {
  const failed = (autoRevives: number): AIQueueItem => ({
    id: 1,
    type: 'score_fit',
    jobId: 1,
    status: 'failed',
    attempts: 5,
    autoRevives,
    createdAt: 0,
    nextRetryAt: 0
  })

  it('offers a retry on the last revive the main process would still grant', () => {
    const text = queueItemStatusText(failed(MAIN_AUTO_REVIVE_MAX - 1))
    expect(text).toMatch(/auto-retry/i)
  })

  it('stops offering a retry exactly where the main process stops granting one', () => {
    const text = queueItemStatusText(failed(MAIN_AUTO_REVIVE_MAX))
    expect(text).toMatch(/needs attention/i)
  })
})

/**
 * A row a crash left `processing`, with nothing running on it.
 *
 * The status line is the only thing telling the user this row is stuck,
 * because the app has decided not to resume it (the Auto-queue switch for
 * its type is off) and will offer a Retry button instead. "Processing…"
 * there is the app claiming to be working on a task it is not working on
 * — which is exactly why the state went unnoticed — so this one case has
 * to be worded separately from every other `processing` row.
 */
describe('a row a crash left processing', () => {
  const stranded: AIQueueItem & { stranded: boolean } = {
    id: 1,
    type: 'generate_cv',
    jobId: 1,
    status: 'processing',
    attempts: 1,
    createdAt: 0,
    nextRetryAt: 0,
    stranded: true
  }

  it('does not claim to be processing', () => {
    expect(queueItemStatusText(stranded)).not.toMatch(/processing/i)
  })

  it('says what happened, in plain terms', () => {
    // It names the interruption, which is the useful half: it is why the
    // task stopped, and it pairs with a button that starts it again.
    //
    // What it must not do is put words in the user's mouth. The flag is
    // reachable whenever the previous app process ended with the row
    // mid-task — a crash, a force-kill, a segfault, a lost power — and none
    // of those is the app "closing while this was running" in the sense a
    // user would read it. The store cannot tell a quit from a kill, so the
    // copy has to be true for both: the app is gone, and this did not
    // finish.
    const text = queueItemStatusText(stranded)
    expect(text).toMatch(/stopped/i)
    expect(text).toMatch(/app closed/i)
    expect(text).toMatch(/before this finished/i)
    expect(text).not.toMatch(/closed while/i)
  })

  it('leaks no internal state into the row', () => {
    // The panel shows the user's work, not the queue's mechanics: no field
    // name, no gate, no status key, no budget. None of it is actionable
    // for the user — they press Retry.
    expect(queueItemStatusText(stranded).toLowerCase()).not.toMatch(
      /stranded|processing|auto_queue|manualqueued|mayrevive|auto_revive|attempt|gated|switch/
    )
  })

  it('leaves a row that is genuinely being worked on reading as one', () => {
    // The control: `stranded` is per row, so it cannot colour every
    // `processing` row in the panel.
    expect(queueItemStatusText({ ...stranded, stranded: false })).toBe('Processing…')
    expect(queueItemStatusText({ ...stranded, stranded: undefined })).toBe('Processing…')
  })
})
