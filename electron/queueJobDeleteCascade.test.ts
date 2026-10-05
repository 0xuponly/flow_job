import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

// Deleting a job must take its QUEUED work with it.
//
// The real ./database is used here on purpose, for the reason
// queueClear.test.ts gives: the question here is "what is left in the
// queue after this delete", and a mocked store cannot answer it. The
// mocked ./database factories in aiQueue.test.ts and aiQueue.unique.test.ts
// can only observe which writer functions were called — which is exactly
// the distinction that let this bug exist, because every one of those
// tests asserted on addAIQueueItem/updateAIQueueItem and none of them
// asked what a job deletion does to `ai_queue`.
//
// The store directory is its own, distinct from database.test.ts's and
// queueClear.test.ts's: vitest runs test FILES in parallel and all three
// drive the real store, so a shared path would have them wiping each
// other's data mid-run. hoisted because the electron mock factory runs
// before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-qdelete-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

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
  createJob,
  dedupeJobs,
  deleteJob,
  deleteJobs,
  getAIQueue,
  getJob,
  reloadStore,
  updateAIQueueItem
} from './database'
import { enqueue } from './aiQueue'
import type { CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

let nextUrl = 0

/**
 * A stored job. `url` and the company+title+location triple both differ
 * every call: `createJob` rejects a duplicate on either, and these tests
 * add several jobs that are otherwise identical.
 */
function addJob(overrides: Partial<CreateJobInput> = {}): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Senior Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/qdelete/${nextUrl}`,
    ...overrides
  }
  return createJob(input).job.id
}

/** Queue rows belonging to one job, by id. */
function rowsFor(jobId: number): number[] {
  return getAIQueue().filter((q) => q.jobId === jobId).map((q) => q.id)
}

beforeEach(() => {
  nextUrl = 0
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
})

describe('deleting a job takes its queued work with it', () => {
  it('removes every queued row for that job, in every status', () => {
    // A job's work is not one row. A fit score, both documents, the
    // reviews of those documents and a section regeneration can all be
    // queued for one job at once, and they sit in three different states
    // depending on how far each has got. The cascade has to match on
    // jobId alone: a filter that also keyed on status would leave the
    // `processing` and `failed` rows behind, and those are exactly the
    // ones the panel offers Retry on.
    const jobId = addJob()
    const fit = addAIQueueItem({ type: 'score_fit', jobId })
    const cv = addAIQueueItem({ type: 'generate_cv', jobId })
    const review = addAIQueueItem({ type: 'verify', jobId, documentId: 11 })
    const regen = addAIQueueItem({ type: 'regenerate_section', jobId, documentId: 11, sectionName: 'Summary' })
    const dead = addAIQueueItem({ type: 'tailor_job_docs', jobId })
    updateAIQueueItem(dead.id, { status: 'failed', attempts: 9, lastError: 'rate limited' })
    const live = addAIQueueItem({ type: 'generate_cover_letter', jobId })
    updateAIQueueItem(live.id, { status: 'processing' })
    expect(rowsFor(jobId).length).toBe(6)

    deleteJob(jobId)

    expect(rowsFor(jobId)).toEqual([])
    // Every one of the six ids is specifically gone, not merely fewer
    // rows: an id collision would satisfy the count check alone.
    const remaining = getAIQueue().map((q) => q.id)
    for (const row of [fit, cv, review, regen, dead, live]) {
      expect(remaining).not.toContain(row.id)
    }
  })

  it('leaves other jobs\' queued work alone', () => {
    // The obvious over-reach: matching on something coarser than the job
    // (or, worse, clearing the queue outright) would also take the
    // work for jobs the user kept.
    const kept = addJob()
    const deleted = addJob()
    const keptScore = addAIQueueItem({ type: 'score_fit', jobId: kept })
    const keptVerify = addAIQueueItem({ type: 'verify', jobId: kept, documentId: 1 })
    addAIQueueItem({ type: 'score_fit', jobId: deleted })

    deleteJob(deleted)

    expect(getAIQueue().map((q) => q.id).sort())
      .toEqual([keptScore.id, keptVerify.id].sort())
    expect(rowsFor(deleted)).toEqual([])
  })

  it('cascades for the batch delete the Job Board checkbox uses', () => {
    // `deleteJobs` is a separate implementation with its own copy of the
    // cascade, which is precisely why it has to be covered separately:
    // fixing `deleteJob` alone would leave the checkbox path — the one
    // the user reaches most — still spending on deleted jobs.
    const a = addJob()
    const b = addJob()
    const c = addJob()
    addAIQueueItem({ type: 'score_fit', jobId: a })
    const bCv = addAIQueueItem({ type: 'generate_cv', jobId: b })
    const cReview = addAIQueueItem({ type: 'verify', jobId: c, documentId: 3 })
    const keptCv = addAIQueueItem({ type: 'generate_cv', jobId: c })

    const result = deleteJobs([a, b])

    expect(result.deleted).toBe(2)
    expect(getAIQueue().map((q) => q.id).sort()).toEqual([cReview.id, keptCv.id].sort())
    // b's rows are gone, including its CV generation; c's survive because
    // c was not in the selection, even though the same call touched the
    // same queue.
    expect(rowsFor(b)).toEqual([])
    expect(getAIQueue().map((q) => q.id)).not.toContain(bCv.id)
    expect(rowsFor(c).sort()).toEqual([cReview.id, keptCv.id].sort())
    expect(getJob(c)).toBeDefined()
  })

  it('cascades for the store-side dedupe, which is a third death path', () => {
    // `dedupeJobs` deletes job rows for duplicates — real deletions, with
    // real ids the scanner will not re-hand out. It has its own cascade
    // copy, so it is its own case. The duplicate is made by URL, which
    // is the key createJob itself enforces, so it is forced with
    // skipDuplicateCheck the way the store's own dedupe sees it.
    const keeper = addJob()
    const keeperScore = addAIQueueItem({ type: 'score_fit', jobId: keeper })
    const keeperVerify = addAIQueueItem({ type: 'verify', jobId: keeper, documentId: 8 })
    // A second row with the same URL, created bypassing createJob's
    // duplicate guard the way a legacy store (pre-dedupe import) holds.
    const dup = createJob(
      {
        title: 'Senior Engineer dup',
        company: 'Acme',
        location: 'Remote',
        url: `https://example.com/qdelete/${1}`
      },
      { skipDuplicateCheck: true }
    ).job
    addAIQueueItem({ type: 'verify', jobId: dup.id, documentId: 7 })

    const result = dedupeJobs()

    expect(result.removedIds).toContain(dup.id)
    // The duplicate's queued work went with it...
    expect(rowsFor(dup.id)).toEqual([])
    // ...and the kept job's did not, despite the shared URL and the fact
    // that two rows for it existed.
    expect(rowsFor(keeper).sort()).toEqual([keeperScore.id, keeperVerify.id].sort())
    expect(getJob(keeper)).toBeDefined()
  })

  it('does not resurrect the work through the processor\'s own follow-up chaining', () => {
    // The other half of the rule, and the one a cascade alone does not
    // cover. `deleteJob` removes the rows that exist; it cannot stop a
    // `processItem` that is already holding an LLM call from finishing
    // and enqueueing its follow-up. A `generate_cv` in flight when the
    // user deletes the job builds its document and then enqueues the
    // review of it — which would put a row for a job that no longer
    // exists straight back into the queue, to be picked up and paid for
    // on the next pass.
    //
    // The race is driven, not asserted: the delete happens while the
    // generation is mid-call, which is the only ordering in which the
    // follow-up can be enqueued after the cascade has already run.
    const jobId = addJob()
    addAIQueueItem({ type: 'generate_cv', jobId })

    deleteJob(jobId)
    expect(rowsFor(jobId)).toEqual([])

    // What the processor's generate case does on completion.
    const chained = enqueue({ type: 'verify', jobId, documentId: 42 })

    expect(chained).toBeNull()
    expect(getAIQueue()).toEqual([])
  })

  it('refuses the manual lane for a deleted job too', () => {
    // `enqueue`'s existence check is deliberately NOT keyed on
    // `opts.manual`, so this is the half that could have been got wrong
    // in the permissive direction: every manual entry point is the user
    // naming a job on their board, and an id that no longer resolves is
    // not something a person can be asking for.
    const jobId = addJob()
    deleteJob(jobId)

    expect(enqueue({ type: 'verify', jobId, documentId: 1 }, { manual: true })).toBeNull()
    expect(enqueue({ type: 'generate_cv', jobId }, { manual: true })).toBeNull()
    expect(getAIQueue()).toEqual([])
  })

  it('does not block an enqueue for a job that still exists', () => {
    // The other direction, so the guard is not "refuse everything". A
    // guard that could not tell a live job from a dead one would stop
    // every fit score and every document the app queues.
    const live = addJob()
    addAIQueueItem({ type: 'score_fit', jobId: live })
    deleteJob(addJob())

    const row = enqueue({ type: 'generate_cv', jobId: live })
    expect(row).not.toBeNull()
    expect(rowsFor(live).length).toBe(2)
  })

  it('does not revive an EXISTING failed row for a deleted job', () => {
    // The refused path must not leave a side effect on its way past,
    // which is why both guards are checked before the duplicate scan:
    // an automatic enqueue landing on a dead job's `failed` row would
    // otherwise resurrect it (a fresh attempt budget, due now) and the
    // row would sit in the panel as work with no job behind it.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9 })
    deleteJob(jobId)

    // Model the state the guard has to survive: a row that names a
    // deleted job and is `failed` with a spent budget, so `enqueue`'s
    // duplicate path WOULD revive it if the existence check came after
    // the scan. A store written by the build that shipped without the
    // cascade is exactly this shape.
    const orphan = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(orphan.id, { status: 'failed', attempts: 9 })

    const revived = enqueue({ type: 'generate_cv', jobId })

    expect(revived).toBeNull()
    // Not revived: still `failed` with its spent budget, so nothing will
    // wake it, and no second row was added beside it.
    const after = getAIQueue().filter((q) => q.jobId === jobId)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('failed')
    expect(after[0].attempts).toBe(9)
  })
})