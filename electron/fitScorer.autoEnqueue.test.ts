import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real ./database and the real ./aiQueue.
//
// maybeAutoEnqueueDocs used to answer "is generation already scheduled?"
// with its own scan of the queue, then call enqueue() — which asks the
// same question with a second full scan. The pre-check is gone (its
// stated reason, "`enqueue` only dedupes against `pending`", stopped
// being true when the guard was widened to cover `processing`), so the
// duplicate rule now lives in exactly one place: enqueue's guard.
//
// That makes THIS file the test for it. With the database mocked, the
// enqueue unit tests already pass while this function could stack
// duplicate work again, so nothing else would notice.

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => `/tmp/flow_job-test-autoenqueue-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
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

import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  addAIQueueItem,
  createDocument,
  createJob,
  getAIQueue,
  getJob,
  reloadStore,
  updateAIQueueItem,
  updateSettings,
  updateDocumentVerification,
  updateJob
} from './database'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { runDocsAutoQueueBacklog } from './docsAutoQueue'

const storeDir = `/tmp/flow_job-test-autoenqueue-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
const storeFiles = [
  join(storeDir, 'apply-assistant-data.json'),
  join(storeDir, 'apply-assistant-key')
]

beforeEach(() => {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
  for (const f of storeFiles) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  // The sweep's base-CV precondition, and the trigger's switches, both read
  // settings, so the tests below are only about the queue interaction when
  // the defaults are the defaults.
  updateSettings({ base_cv: 'MASTER CV', auto_doc_min_fit: 40 })
})

function seedScoredJob() {
  const { job } = createJob({
    title: 'Senior Engineer',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/job/auto-enq-1',
    description: 'Senior Python engineer wanted.'
  })
  updateJob(job.id, { score: 0.85, fit_score_version: 0 })
  return getJob(job.id)!
}

// The generation items for the seeded job, whatever id it got.
let seededJobId = 0
const generationRows = () =>
  getAIQueue().filter((q) => q.type === 'tailor_job_docs' && q.jobId === seededJobId)

describe('maybeAutoEnqueueDocs against the real store', () => {
  function seed() {
    seededJobId = seedScoredJob().id
  }

  it('queues one generation item for a job that has none', () => {
    seed()
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(generationRows()).toHaveLength(1)
  })

  it('does not stack a second item when one is already pending', () => {
    seed()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(generationRows()).toHaveLength(1)
  })

  it('does not stack a second item while generation is in flight', () => {
    // The `processing` case the deleted pre-check used to cover on its
    // own. It now has to be covered by enqueue's guard — this test is
    // what says that it still is.
    seed()
    const row = addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    row.status = 'processing'
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(generationRows()).toHaveLength(1)
  })

  it('does not stack duplicates across repeated fit-landings', () => {
    seed()
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(generationRows()).toHaveLength(1)
  })

  it('revives a failed generation item in place rather than stacking a second row', () => {
    // `failed` used to be outside enqueue's duplicate guard, on the
    // reasoning that re-queueing it "is the recovery path" — so this
    // case produced a second `tailor_job_docs` row for a job that
    // already had one, which is the duplicate the panel was showing.
    // The recovery is now a revive of the existing row.
    seed()
    const row = addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    row.status = 'failed'
    // Null means "not newly added", which is exactly what happened: no
    // second row was created. The row is now runnable again.
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(generationRows()).toHaveLength(1)
    expect(generationRows()[0].status).toBe('pending')
  })

  it('does not confuse another job\'s generation item for this one', () => {
    seed()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId + 1 })
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(generationRows()).toHaveLength(1)
  })

  it('leaves the queue alone for a job below the fit threshold', () => {
    const { job } = createJob({
      title: 'Intern',
      company: 'Acme',
      location: 'Remote',
      url: 'https://example.com/job/auto-enq-2',
      description: 'x'
    })
    updateJob(job.id, { score: 0.2, fit_score_version: 0 })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toEqual([])
  })

  it('leaves the queue alone when every document already passed review', () => {
    seed()
    const cv = createDocument('cv', 'CV', 'CONTENT', seededJobId)
    const doc = createDocument('cover_letter', 'CL', 'CONTENT', seededJobId)
    updateDocumentVerification(cv.id, 88, 'Good.')
    updateDocumentVerification(doc.id, 92, 'Good.')
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(getAIQueue()).toEqual([])
  })
})

// The other producer. The backlog sweep queues `generate_cv` and
// `generate_cover_letter` as two units; `enqueue`'s duplicate guard cannot
// match either against a `tailor_job_docs` row, so before the shared
// coverage predicate this trigger queued its own row on top of the sweep's
// two and the job reached three CVs and three cover letters. The full
// cross-producer matrix (both directions, per-document granularity, the
// toggle edge cases) lives in docsAutoQueue.crossProducer.store.test.ts;
// what belongs here is the trigger's own half, against the real store.
describe('maybeAutoEnqueueDocs against the sweep\'s rows', () => {
  it('declines when the sweep has already queued this job, and adds no third row', () => {
    const job = seedScoredJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(getAIQueue()).toHaveLength(2)

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toHaveLength(2)
  })

  it('declines while the sweep\'s generate_cv row is processing', () => {
    const job = seedScoredJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'processing' })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toHaveLength(1)
  })

  it('declines when only the sweep\'s cover-letter row is live', () => {
    // It generates both documents, so this is a live second cover letter
    // too, not an unrelated job of work.
    const job = seedScoredJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toHaveLength(1)
  })

  it('queues when the sweep\'s row has failed: that work has not happened', () => {
    const job = seedScoredJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, nextRetryAt: 0 })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(getAIQueue().map((q) => q.type).sort()).toEqual(['generate_cv', 'tailor_job_docs'])
  })

  it('queues when the live row is a regeneration of a document, not a first generation', () => {
    const job = seedScoredJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 99 })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(getAIQueue().map((q) => q.type).sort()).toEqual(['generate_cv', 'tailor_job_docs'])
  })

  it('still refuses when cover-letter auto-queueing is off, queue empty or not', () => {
    // `tailor_job_docs` produces both documents, so the toggle applies to
    // it whatever the queue holds; a decline here is a refusal, not a
    // deferral, so nothing is left owed.
    const job = seedScoredJob()
    updateSettings({ base_cv: 'MASTER CV', auto_doc_min_fit: 40, auto_queue_cover_letter: false })
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue().map((q) => q.type)).toEqual(['generate_cv'])
  })
})
