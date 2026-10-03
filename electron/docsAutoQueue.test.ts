import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIQueueItem, Document, Job, Settings } from './types'

vi.mock('./database', () => ({
  getSettings: vi.fn(),
  getAIQueue: vi.fn(),
  addAIQueueItem: vi.fn(),
  updateAIQueueItem: vi.fn(),
  listJobs: vi.fn(),
  listDocuments: vi.fn(),
  isScoreFitSuppressed: vi.fn(() => false),
  // Per-provider spend ledger + the cap constants that ai.ts imports at
  // module scope. A partial ./database mock that omits them makes the
  // import fail outright, which surfaces as every assertion in the file
  // failing for a reason that has nothing to do with this file.
  DEFAULT_PROVIDER_CALL_CAP: 50,
  MIN_PROVIDER_CALL_CAP: 1,
  MAX_PROVIDER_CALL_CAP: 100000,
  PROVIDER_SPEND_WINDOW_MS: 86400000,
  recordProviderCall: vi.fn(),
  getProviderSpend: vi.fn(() => ({})),
  clearProviderSpend: vi.fn(),

}))

// enqueueDocsBacklog (the startup / post-scan path) goes through the
// shared dedupe-aware enqueue(); the real aiQueue is not under test here,
// so it is stubbed like ./database is.
vi.mock('./aiQueue', () => ({
  enqueue: vi.fn(() => ({ id: 1 }))
}))

vi.mock('./utils', () => ({
  timerDeadlineMs: vi.fn((startedAt: number, delayMs: number) => startedAt + delayMs)
}))

vi.mock('./logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

import {
  scheduleNextDocsAutoQueue,
  restartDocsAutoQueueTimer,
  cancelDocsAutoQueue,
  getDocsAutoQueueState,
  runDocsAutoQueueBacklog,
  enqueueDocsBacklog,
  autoQueueFlags
} from './docsAutoQueue'
import {
  getSettings,
  getAIQueue,
  addAIQueueItem,
  updateAIQueueItem,
  listJobs,
  listDocuments,
  isScoreFitSuppressed
} from './database'
import { enqueue } from './aiQueue'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'

const mockedGetSettings = vi.mocked(getSettings)
const mockedGetAIQueue = vi.mocked(getAIQueue)
const mockedAddAIQueueItem = vi.mocked(addAIQueueItem)
const mockedUpdateAIQueueItem = vi.mocked(updateAIQueueItem)
const mockedListJobs = vi.mocked(listJobs)
const mockedListDocuments = vi.mocked(listDocuments)
const mockedIsSuppressed = vi.mocked(isScoreFitSuppressed)
const mockedEnqueue = vi.mocked(enqueue)

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    openai_api_key: '', openai_base_url: '', openai_model: '', user_name: '',
    // A base CV is configured: the sweep now shares maybeAutoEnqueueDocs's
    // eligibility gate, and "no base CV" is one of the states it refuses.
    // Tests about that state belong to docsAutoQueue.store.test.ts, which
    // drives the real store.
    user_email: '', user_phone: '', user_country: '', base_cv: 'MASTER CV',
    job_search_keywords: '', job_search_location: '', job_search_locations: '',
    deleted_jobs_cap: 50000, auto_scan_enabled: true, auto_scan_interval_minutes: 120,
    scan_min_match: 0.25,
    fit_autoscore_interval_minutes: 60, locations_normalized: '',
    locations_normalized_v2: '', locations_normalized_v3: '', locations_normalized_v4: '',
    locations_normalized_v5: '', locations_normalized_v6: '', employment_type_normalized: '',
    work_mode_normalized: '', backup_path: '', backup_last_success_at: '',
    backup_last_error: '', passphrase: '', adzuna_app_id: '', adzuna_app_key: '',
    aggregator_remotive_enabled: false, aggregator_arbeitnow_enabled: false,
    aggregator_jobicy_enabled: false, aggregator_himalayas_enabled: false,
    ats_boards: [], disabled_boards: [], auto_tailor_on_scan: false,
    auto_tailor_min_fit: 90, auto_doc_min_fit: 40, quick_apply_shortcut: null,
    statuses_recomputed: '', statuses_manual_v2: '', queue_dedup_v1: '', queue_dedup_v2: '',
    queue_cleared_at: 0, queue_cleared_max_job_id: 0, ...overrides
  } as Settings
}

function makeJob(overrides: Partial<Job> = {}): Job {
  // Scored above auto_doc_min_fit, so the shared eligibility gate admits
  // this job by default. Gate behaviour itself is tested against the real
  // store in docsAutoQueue.store.test.ts.
  return { id: 1, title: 'Engineer', company: 'Acme', status: 'sourced', score: 0.8, ...overrides } as Job
}

/** A generated (non-base) document row for a job. */
function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 10,
    job_id: 1,
    type: 'cv',
    title: 'Tailored CV',
    content: 'x',
    is_base: 0,
    model_used: null,
    verification_score: null,
    verification_feedback: null,
    created_at: '',
    updated_at: '',
    ...overrides
  } as Document
}

/** The user's master CV: the row `listDocuments` unions into every job. */
function makeBaseDoc(overrides: Partial<Document> = {}): Document {
  return makeDoc({ id: 999, job_id: null, is_base: 1, title: 'Base CV', ...overrides })
}

function makeQueueItem(overrides: Partial<AIQueueItem> = {}): AIQueueItem {
  return {
    id: 1,
    type: 'generate_cv',
    jobId: 1,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextRetryAt: Date.now(),
    ...overrides
  } as AIQueueItem
}

/** One job, with the given documents, and nothing in the queue. */
function seed(jobId: number, docs: Document[]) {
  mockedListJobs.mockReturnValue([makeJob({ id: jobId })])
  mockedListDocuments.mockImplementation((id?: number) =>
    docs.filter((d) => d.job_id === id || d.is_base === 1)
  )
  mockedGetAIQueue.mockReturnValue([])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mockedGetSettings.mockReturnValue(makeSettings())
  mockedGetAIQueue.mockReturnValue([])
  mockedListJobs.mockReturnValue([])
  mockedListDocuments.mockReturnValue([])
  mockedIsSuppressed.mockReturnValue(false)
  mockedEnqueue.mockReturnValue({ id: 1 } as AIQueueItem)
})

afterEach(() => {
  cancelDocsAutoQueue()
  vi.useRealTimers()
})

// The eligibility gate the sweep shares with the fit-landing trigger.
// These are unit-level: the real-store proofs of the cost they prevent
// live in docsAutoQueue.store.test.ts.
describe('the shared eligibility gate', () => {
  it('queues nothing for a job with no fit score', () => {
    seed(1, [])
    mockedListJobs.mockReturnValue([makeJob({ score: null })])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('queues nothing for a job below auto_doc_min_fit', () => {
    seed(1, [])
    mockedListJobs.mockReturnValue([makeJob({ score: 0.05 })])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('queues nothing when no base CV is configured', () => {
    // The sweep-only half of the gate. Generation is tailoring FROM the
    // user's master CV, so with none configured the call cannot succeed.
    mockedGetSettings.mockReturnValue(makeSettings({ base_cv: '' }))
    seed(1, [])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('gates on a shippable job (every document reviewed at or above the bar)', () => {
    seed(1, [
      makeDoc({ id: 1, type: 'cv', is_base: 0, verification_score: 88 }),
      makeDoc({ id: 2, type: 'cover_letter', is_base: 0, verification_score: 92 })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
  })

  it('queues the missing unit for a job whose documents have not passed review', () => {
    // The gate must not refuse a job for merely being incomplete, or the
    // sweep could never do its job. This CV exists and scored 40, so the
    // job is not shippable and the absent cover letter is still wanted.
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0, verification_score: 40 })])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('reads the threshold from settings rather than a copy of it', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ auto_doc_min_fit: 95 }))
    seed(1, [])
    mockedListJobs.mockReturnValue([makeJob({ score: 0.8 })])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    mockedGetSettings.mockReturnValue(makeSettings({ auto_doc_min_fit: 40 }))
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })
})

describe('a live tailor_job_docs row means both units are in flight', () => {
  it('the periodic sweep adds nothing beside a pending tailor row', () => {
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ type: 'tailor_job_docs', jobId: 1, status: 'pending' })])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('a processing tailor row counts too', () => {
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ type: 'tailor_job_docs', jobId: 1, status: 'processing' })])
    expect(runDocsAutoQueueBacklog()).toBe(0)
  })

  it('the startup path honours it as well', () => {
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ type: 'tailor_job_docs', jobId: 1, status: 'pending' })])
    expect(enqueueDocsBacklog()).toBe(0)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('a FAILED tailor row does not, so the sweep can still recover the work', () => {
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ type: 'tailor_job_docs', jobId: 1, status: 'failed', attempts: 5 })])
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })

  it("another job's tailor row does not cover this one", () => {
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ type: 'tailor_job_docs', jobId: 99, status: 'pending' })])
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })
})

describe('runDocsAutoQueueBacklog', () => {
  it('queues BOTH generate_cv and generate_cover_letter for a job with neither document', () => {
    seed(1, [])
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('queues ONLY the cover letter for a job that already has a generated CV', () => {
    seed(1, [makeDoc({ type: 'cv', is_base: 0 })])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('queues ONLY the CV for a job that already has a generated cover letter', () => {
    seed(1, [makeDoc({ type: 'cover_letter', is_base: 0 })])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
  })

  it('queues nothing for a job that already has both documents', () => {
    seed(1, [
      makeDoc({ id: 1, type: 'cv', is_base: 0 }),
      makeDoc({ id: 2, type: 'cover_letter', is_base: 0 })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('returns the number of queue rows it enqueued', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 }), makeJob({ id: 2 }), makeJob({ id: 3 })])
    mockedListDocuments.mockImplementation((id?: number) =>
      id === 2 ? [makeDoc({ type: 'cv', is_base: 0 })] : []
    )
    expect(runDocsAutoQueueBacklog()).toBe(5)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(5)
  })

  // The user's explicit requirement, in a named case of its own.
  it('treats a job whose ONLY cv document has is_base set as having NO CV, and re-queues it', () => {
    seed(1, [makeBaseDoc({ type: 'cv' })])
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('treats a job whose only cover_letter document has is_base set as having NO cover letter', () => {
    seed(1, [
      makeDoc({ id: 1, type: 'cv', is_base: 0 }),
      makeBaseDoc({ id: 2, type: 'cover_letter' })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('is not satisfied by the base CV that listDocuments unions into every job', () => {
    // The exact shape of the bug: listDocuments(jobId) returns the
    // master's CV for every job, so a bare type check would report every
    // job as having a CV and this sweep would enqueue nothing at all.
    seed(1, [makeBaseDoc({ type: 'cv' }), makeBaseDoc({ id: 2, type: 'cover_letter' })])
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })

  it('skips a job whose generate_cv item is pending', () => {
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0 })])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({ type: 'generate_cover_letter', jobId: 1, status: 'pending' })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('skips a job whose generate_cover_letter item is processing', () => {
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0 })])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({ type: 'generate_cover_letter', jobId: 1, status: 'processing', attempts: 1 })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('does not treat one job\'s in-flight item as covering another job', () => {
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0 })])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({ type: 'generate_cover_letter', jobId: 99, status: 'pending' })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(1)
  })

  it('treats ANY in-flight duplicate as in flight, not just the first', () => {
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0 })])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({ id: 1, type: 'generate_cover_letter', jobId: 1, status: 'failed', attempts: 5 }),
      makeQueueItem({ id: 2, type: 'generate_cover_letter', jobId: 1, status: 'processing', attempts: 1 })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('does not mistake an auto-regeneration row (which carries a documentId) for the missing first generation', () => {
    // A generate_cv row with a documentId is the review->regenerate
    // loop rebuilding an existing CV. It is different work: reviving it
    // would aim this re-seed at the wrong document, and counting it as
    // in-flight would suppress the first generation the job still needs.
    seed(1, [])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({
        type: 'generate_cv',
        jobId: 1,
        status: 'processing',
        documentId: 77
      })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
  })
})

describe('runDocsAutoQueueBacklog respects the revive budget and cooldown', () => {
  const failedCl = (overrides: Partial<AIQueueItem> = {}) => [
    makeQueueItem({
      id: 5,
      type: 'generate_cover_letter',
      jobId: 1,
      status: 'failed',
      attempts: 5,
      ...overrides
    })
  ]

  beforeEach(() => {
    seed(1, [makeDoc({ id: 1, type: 'cv', is_base: 0 })])
  })

  it('revives an exhausted row in place on the shared cooldown instead of adding a second row', () => {
    mockedGetAIQueue.mockReturnValue(failedCl({ autoRevives: 1 }))
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(5, {
      status: 'pending',
      attempts: 0,
      autoRevives: 2,
      nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS,
      lastError: undefined
    })
  })

  it('counts a legacy row with no counter as zero revives', () => {
    mockedGetAIQueue.mockReturnValue(failedCl({ autoRevives: undefined }))
    runDocsAutoQueueBacklog()
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ autoRevives: 1 })
    )
  })

  it('leaves a failed row alone once the revive budget is spent', () => {
    mockedGetAIQueue.mockReturnValue(failedCl({ autoRevives: AUTO_REVIVE_MAX }))
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('does not pull a row forward while its cooldown has not elapsed', () => {
    mockedGetAIQueue.mockReturnValue(failedCl({ nextRetryAt: Date.now() + 60 * 60 * 1000 }))
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })

  it('leaves a pending row in flight alone regardless of its budget', () => {
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({
        type: 'generate_cover_letter',
        jobId: 1,
        status: 'pending',
        autoRevives: AUTO_REVIVE_MAX
      })
    ])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })
})

describe('auto_queue_* toggles', () => {
  it('auto_queue_cv: false suppresses only the CV work', () => {
    mockedGetSettings.mockReturnValue(
      makeSettings({ auto_queue_cv: false } as Partial<Settings>)
    )
    seed(1, [])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('auto_queue_cover_letter: false suppresses only the cover-letter work', () => {
    mockedGetSettings.mockReturnValue(
      makeSettings({ auto_queue_cover_letter: false } as Partial<Settings>)
    )
    seed(1, [])
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
  })

  it('auto_queue_cv: false suppresses the CV work on the startup path too', () => {
    mockedGetSettings.mockReturnValue(
      makeSettings({ auto_queue_cv: false } as Partial<Settings>)
    )
    seed(1, [])
    expect(enqueueDocsBacklog()).toBe(1)
    expect(mockedEnqueue).toHaveBeenCalledTimes(1)
    expect(mockedEnqueue).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('auto_queue_cover_letter: false suppresses the CL work on the startup path too', () => {
    mockedGetSettings.mockReturnValue(
      makeSettings({ auto_queue_cover_letter: false } as Partial<Settings>)
    )
    seed(1, [])
    expect(enqueueDocsBacklog()).toBe(1)
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
  })

  it('still queues BOTH when every key is absent (a pre-toggles store)', () => {
    // The keys are read as `!== false`, so a store written before they
    // existed resolves to ON. A missing key must never disable the sweep.
    expect(autoQueueFlags(makeSettings())).toEqual({
      auto_queue_fit: true,
      auto_queue_cv: true,
      auto_queue_cover_letter: true,
      auto_queue_verify_cv: true,
      auto_queue_verify_cover_letter: true
    })
    seed(1, [])
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(enqueueDocsBacklog()).toBe(2)
  })

  it('autoQueueFlags resolves each key independently', () => {
    const flags = autoQueueFlags(
      makeSettings({
        auto_queue_fit: false,
        auto_queue_cv: false,
        auto_queue_cover_letter: false,
        auto_queue_verify_cv: false,
        auto_queue_verify_cover_letter: false
      } as Partial<Settings>)
    )
    expect(flags).toEqual({
      auto_queue_fit: false,
      auto_queue_cv: false,
      auto_queue_cover_letter: false,
      auto_queue_verify_cv: false,
      auto_queue_verify_cover_letter: false
    })
  })
})

// "Clear queue" promises the work will not come back (see the confirm
// dialog in NotificationDrawer.tsx and isScoreFitSuppressed in
// database.ts). This sweep walks the JOBS and DOCUMENTS tables, so
// without the suppression check it would rebuild exactly what the user
// cancelled on the next tick.
describe('both docs re-seeders honour a cleared queue', () => {
  beforeEach(() => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 }), makeJob({ id: 2 })])
    mockedListDocuments.mockReturnValue([])
  })

  it('the periodic sweep skips a suppressed job and still queues a new one', () => {
    mockedIsSuppressed.mockImplementation((id: number) => id === 1)
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 2 })
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 2
    })
    expect(mockedAddAIQueueItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1 })
    )
  })

  it('the startup / post-scan path skips a suppressed job too', () => {
    mockedIsSuppressed.mockImplementation((id: number) => id === 1)
    expect(enqueueDocsBacklog()).toBe(2)
    expect(mockedEnqueue).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: 1 }))
  })

  it('neither re-seeder touches a fully suppressed store', () => {
    mockedIsSuppressed.mockReturnValue(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })
})

describe('enqueueDocsBacklog', () => {
  it('queues both units through the shared enqueue for a job with no documents', () => {
    seed(1, [])
    expect(enqueueDocsBacklog()).toBe(2)
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 1 })
    expect(mockedEnqueue).toHaveBeenCalledWith({
      type: 'generate_cover_letter',
      jobId: 1
    })
  })

  it('returns the number of rows the shared enqueue actually created', () => {
    // enqueue returns null when the work already has a row, so the count
    // has to follow the enqueue rather than the predicate.
    seed(1, [])
    mockedEnqueue.mockReturnValueOnce(null as unknown as AIQueueItem)
    expect(enqueueDocsBacklog()).toBe(1)
  })

  it('queues a base-CV-only job, unlike the status path it is paired with', () => {
    seed(1, [makeBaseDoc({ type: 'cv' })])
    expect(enqueueDocsBacklog()).toBe(2)
  })
})

describe('scheduleNextDocsAutoQueue', () => {
  it('schedules a run using the configured interval', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: 60 }))
    scheduleNextDocsAutoQueue()
    const state = getDocsAutoQueueState()
    expect(state.intervalMinutes).toBe(60)
    expect(state.nextRunAt).toBe(Date.now() + 60 * 60 * 1000)
  })

  it('defaults to 60 minutes (hourly) when the setting is missing', () => {
    mockedGetSettings.mockReturnValue(
      makeSettings({ fit_autoscore_interval_minutes: undefined })
    )
    scheduleNextDocsAutoQueue()
    expect(getDocsAutoQueueState().intervalMinutes).toBe(60)
  })

  it('shares the fit sweep\'s cadence, so the two cannot drift apart', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: 15 }))
    scheduleNextDocsAutoQueue()
    expect(getDocsAutoQueueState().intervalMinutes).toBe(15)
  })

  it('replaces the previous timer when called again', () => {
    scheduleNextDocsAutoQueue()
    const firstRunAt = getDocsAutoQueueState().nextRunAt
    vi.advanceTimersByTime(1000)
    scheduleNextDocsAutoQueue()
    expect(getDocsAutoQueueState().nextRunAt).toBeGreaterThan(firstRunAt as number)
  })

  it('restarts with the latest settings value', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: 30 }))
    restartDocsAutoQueueTimer()
    expect(getDocsAutoQueueState().intervalMinutes).toBe(30)
  })

  it('reports no next run once cancelled', () => {
    scheduleNextDocsAutoQueue()
    cancelDocsAutoQueue()
    expect(getDocsAutoQueueState().nextRunAt).toBeNull()
  })
})
