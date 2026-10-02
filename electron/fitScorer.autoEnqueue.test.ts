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
    getPath: (_key: string) => '/tmp/flow_job-test-autoenqueue',
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

const storeDir = '/tmp/flow_job-test-autoenqueue'
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

// The generation items for the seeded job, whatever id it got. The trigger
// queues PER DOCUMENT UNIT, so this is the two single-document row types;
// `tailor_job_docs` is the both-documents unit and is only ever produced by
// a person (Quick Apply, `manual: true`).
let seededJobId = 0
const generationRows = () =>
  getAIQueue().filter(
    (q) => (q.type === 'generate_cv' || q.type === 'generate_cover_letter') && q.jobId === seededJobId
  )
const typesFor = (jobId: number): string[] =>
  getAIQueue()
    .filter((q) => q.jobId === jobId)
    .map((q) => q.type)
    .sort()

describe('maybeAutoEnqueueDocs against the real store', () => {
  function seed() {
    seededJobId = seedScoredJob().id
  }

  it('queues the MISSING UNITS for a job that has none — two rows, not one', () => {
    seed()
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    // One row per document, exactly as the sweep queues them. It used to
    // be a single `tailor_job_docs` row, which is the both-documents unit:
    // it cannot honour one toggle without doing the other, and it
    // regenerated a CV the sweep had deliberately left alone.
    expect(typesFor(seededJobId)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('does not stack a second item when one is already pending', () => {
    seed()
    // A live both-documents row covers BOTH units, so the trigger has
    // nothing left to say about this job.
    addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(typesFor(seededJobId)).toEqual(['tailor_job_docs'])
  })

  it('does not stack a second item while generation is in flight', () => {
    // The `processing` case the deleted pre-check used to cover on its
    // own. It now has to be covered by the shared predicate plus enqueue's
    // guard — these tests are what says that it still is.
    seed()
    const row = addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    row.status = 'processing'
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(typesFor(seededJobId)).toEqual(['tailor_job_docs'])
  })

  it('does not stack duplicates across repeated fit-landings', () => {
    // A fit landing is user-driven and can repeat without limit, so this is
    // also the case the revive budget bounds. Two rows on the first
    // landing; every later landing finds both units in flight and adds
    // nothing.
    seed()
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(false)
    expect(typesFor(seededJobId)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a FAILED both-documents row is not in flight, so the units are queued fresh', () => {
    // `failed` is not in flight: the work has not happened. A dead
    // `tailor_job_docs` row cannot be turned back into per-unit rows, and
    // reviving it through `enqueue` is exactly the unbounded write the
    // trigger must not make — so the trigger queues two fresh unit rows
    // and leaves the dead row alone for the user to Retry.
    seed()
    const row = addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId })
    row.status = 'failed'
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(typesFor(seededJobId)).toEqual(['generate_cover_letter', 'generate_cv', 'tailor_job_docs'])
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('failed')
  })

  it("does not confuse another job's generation item for this one", () => {
    seed()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: seededJobId + 1 })
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(generationRows()).toHaveLength(2)
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

  it('queues only the cover letter when the job already has its CV', () => {
    // The shape the reviewer's Finding 1 is about, in its simplest form:
    // the CV exists, so asking for it again is the duplicate.
    seed()
    createDocument('cv', 'CV', 'CONTENT', seededJobId)
    expect(maybeAutoEnqueueDocs(seededJobId)).toBe(true)
    expect(typesFor(seededJobId)).toEqual(['generate_cover_letter'])
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
describe("maybeAutoEnqueueDocs against the sweep's rows", () => {
  it('declines when the sweep has already queued this job, and adds no third row', () => {
    const job = seedScoredJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(getAIQueue()).toHaveLength(2)

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toHaveLength(2)
  })

  it('declines the CV unit while the sweep\'s generate_cv row is processing, and queues the cover letter', () => {
    // Per unit, like the sweep. Declining the WHOLE job here is what left
    // it holding a CV row and no cover letter with nothing queued to
    // produce one.
    const job = seedScoredJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'processing' })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('declines the cover-letter unit when only the sweep\'s cover-letter row is live', () => {
    // The mirror. A live cover-letter row is not a live CV.
    const job = seedScoredJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('REVIVES the sweep\'s failed generate_cv row, charged to the budget and parked on the cooldown', () => {
    // Not a second row beside it, and not `enqueue`'s unbounded
    // `revivePatch` (attempts reset, nextRetryAt now, autoRevives
    // untouched). This is the sweep's own bounded revival, so a trigger
    // that lands on every score change cannot buy a generation per
    // landing.
    const job = seedScoredJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })
    const before = Date.now()

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    const revived = getAIQueue().find((q) => q.id === row.id)!
    expect(revived.status).toBe('pending')
    expect(revived.autoRevives).toBe(1)
    expect(revived.attempts).toBe(0)
    expect(revived.nextRetryAt).toBeGreaterThanOrEqual(before + 4 * 60 * 60 * 1000)

    // ...and a second landing inside the cooldown spends nothing.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })

  it('refuses a failed row whose revive budget is spent', () => {
    const job = seedScoredJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, autoRevives: 3, nextRetryAt: 0 })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    // The dead row is untouched: no second row, no budget spent.
    expect(getAIQueue().filter((q) => q.type === 'generate_cv')).toHaveLength(1)
    expect(getAIQueue().find((q) => q.id === row.id)?.autoRevives).toBe(3)
  })

  it('queues when the live row is a regeneration of a document, not a first generation', () => {
    const job = seedScoredJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 99 })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    // The regeneration row plus the two first-generation rows.
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv', 'generate_cv'])
  })

  it('still refuses when cover-letter auto-queueing is off, queue empty or not', () => {
    // The CV has its own live row and the cover letter is switched off, so
    // the trigger owes this job nothing: a decline here is a refusal, not a
    // deferral, so nothing is left stranded.
    const job = seedScoredJob()
    updateSettings({ base_cv: 'MASTER CV', auto_doc_min_fit: 40, auto_queue_cover_letter: false })
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue().map((q) => q.type)).toEqual(['generate_cv'])
  })
})
