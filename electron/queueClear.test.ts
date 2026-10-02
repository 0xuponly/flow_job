import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

// Own userData directory, distinct from database.test.ts's. Vitest runs
// test FILES in parallel and both suites drive the real store, so sharing
// one path would have them wiping each other's data mid-run. hoisted
// because the electron mock factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: `/tmp/flow_job-test-queue-clear-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}` }))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

import {
  addAIQueueItem,
  bumpCvVersion,
  clearAIQueue,
  createJob,
  getAIQueue,
  getQueueClearedAt,
  isScoreFitSuppressed,
  reloadStore,
  updateAIQueueItem
} from './database'
import { enqueueScoreFitBacklog, runFitAutoScoreBacklog } from './fitAutoScore'
import type { CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

let nextUrl = 0

/** A stored, never-scored job — the shape both re-seeders look for. */
function addUnscoredJob(): number {
  const input: CreateJobInput = {
    // Distinct every call: createJob rejects a duplicate on
    // company+title+location as well as on URL, and these tests add the
    // same kind of job more than once.
    title: `Senior Engineer ${nextUrl + 1}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/job/${++nextUrl}`
  }
  return createJob(input).job.id
}

function scoreFitJobIds(): number[] {
  return getAIQueue().filter((q) => q.type === 'score_fit').map((q) => q.jobId)
}

/**
 * Force the next read to come off disk, the way a fresh process would.
 *
 * persistStore chains its write onto a promise, so a reload in the same
 * tick would read the file as it stood BEFORE the clear. Yielding to a
 * macrotask first is what a real process restart gives us for free.
 */
async function simulateRestart(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  reloadStore()
}

beforeEach(() => {
  nextUrl = 0
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
})

// "Clear queue" promises the user that pending fit scores and document
// generation are cancelled. Deleting the rows cannot deliver that on its
// own: BOTH re-seeders read the jobs table rather than the queue, so they
// rebuilt the very rows the clear removed — within 4h on the timer, and on
// the next launch or the next scan completion. These drive the real store
// and the real re-seeders, because a mock-based test cannot tell a
// persisted tombstone from a module-scoped `let` that dies with the
// process.
describe('Clear queue survives the session (real store)', () => {
  it('does not re-enqueue a cleared score_fit item on the 4h backlog', () => {
    const jobId = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId })
    expect(clearAIQueue()).toBe(1)
    expect(getAIQueue()).toEqual([])

    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(scoreFitJobIds()).toEqual([])
  })

  it('does not re-seed a cleared item at session start or after a scan', () => {
    const jobId = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId })
    clearAIQueue()

    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(scoreFitJobIds()).toEqual([])
  })

  it('leaves a cleared FAILED item failed instead of resurrecting it', () => {
    const jobId = addUnscoredJob()
    const row = addAIQueueItem({ type: 'score_fit', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, lastError: 'rate limited' })
    clearAIQueue()

    // The backlog used to find that job with no queue row at all and
    // queue a fresh one; the startup path did the same.
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(getAIQueue()).toEqual([])
  })

  it('keeps the suppression after a restart', async () => {
    const jobId = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId })
    clearAIQueue()

    // Both re-seeders run again in a fresh process, reading the store off
    // disk rather than from the object the clear mutated. A tombstone
    // held in a module-scoped `let` would be 0 by now.
    await simulateRestart()

    expect(getQueueClearedAt()).toBeGreaterThan(0)
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(getAIQueue()).toEqual([])
  })

  it('still scores a job added after the clear on the 4h backlog', () => {
    const cancelled = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId: cancelled })
    clearAIQueue()

    const fresh = addUnscoredJob()
    expect(isScoreFitSuppressed(fresh)).toBe(false)
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(scoreFitJobIds()).toEqual([fresh])
  })

  it('still scores a job added after the clear on the startup / post-scan path', () => {
    addUnscoredJob()
    clearAIQueue()
    const fresh = addUnscoredJob()

    expect(enqueueScoreFitBacklog()).toBe(1)
    expect(scoreFitJobIds()).toEqual([fresh])
  })

  it('retires the tombstone when the CV changes', () => {
    const jobId = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId })
    clearAIQueue()
    expect(runFitAutoScoreBacklog()).toBe(0)

    // Editing the CV is a fresh request to score everything against it,
    // so the backlog must come back rather than staying dead forever —
    // otherwise one Clear press disables automatic scoring for good.
    bumpCvVersion()

    expect(getQueueClearedAt()).toBe(0)
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(scoreFitJobIds()).toEqual([jobId])
  })

  it('scores a job whose id is above the watermark even at the same millisecond', () => {
    // The watermark is an id, not a clock reading, so a job created in the
    // very millisecond the clear happened is still new work. There is no
    // boundary here to draw and therefore none to get wrong.
    addUnscoredJob()
    clearAIQueue()
    const fresh = addUnscoredJob()

    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(scoreFitJobIds()).toEqual([fresh])
  })
})

describe('isScoreFitSuppressed (real store)', () => {
  it('suppresses nothing before the user has ever cleared', () => {
    const jobId = addUnscoredJob()
    expect(getQueueClearedAt()).toBe(0)
    expect(isScoreFitSuppressed(jobId)).toBe(false)
  })

  it('suppresses every job that was in the store at the clear', () => {
    const first = addUnscoredJob()
    const second = addUnscoredJob()
    clearAIQueue()

    expect(isScoreFitSuppressed(first)).toBe(true)
    expect(isScoreFitSuppressed(second)).toBe(true)
  })

  it('does not suppress a job that arrived afterwards', () => {
    addUnscoredJob()
    clearAIQueue()
    expect(isScoreFitSuppressed(addUnscoredJob())).toBe(false)
  })

  it('suppresses nothing for a clear made against an empty store', () => {
    clearAIQueue()
    expect(isScoreFitSuppressed(addUnscoredJob())).toBe(false)
  })

  it('resumes suppressing the whole store after a second clear', () => {
    addUnscoredJob()
    clearAIQueue()
    const fresh = addUnscoredJob()
    addAIQueueItem({ type: 'score_fit', jobId: fresh })
    clearAIQueue()

    // The second clear widens the watermark: `fresh` is now part of the
    // cancelled set too, and the earlier job is still covered.
    expect(isScoreFitSuppressed(fresh)).toBe(true)
    expect(runFitAutoScoreBacklog()).toBe(0)
  })

  it('re-reads the watermark from disk after a restart', async () => {
    const jobId = addUnscoredJob()
    clearAIQueue()
    await simulateRestart()
    expect(isScoreFitSuppressed(jobId)).toBe(true)
  })
})
