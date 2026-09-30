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
