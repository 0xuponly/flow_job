import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AIQueueItem, Document, Job } from './types'

// The score_fit case lazy-imports ./fitScorer, so mock it before importing
// the module under test.
vi.mock('./fitScorer', () => ({
  scoreOneJobInBackground: vi.fn()
}))
// The tailor_job_docs case lazy-imports ./tailorJobDocs; mocked so the
// priority-ordering tests can observe pick order without running the
// real generation pipeline.
vi.mock('./tailorJobDocs', () => ({
  tailorJobDocsForJob: vi.fn(async () => ({ cvId: 1, clId: 2, ms_cv: 1, ms_cl: 1 })),
  // The per-unit generation case imports this from the same module to
  // sanitize the model output before storing it — the one implementation
  // `tailorJobDocsForJob` also uses. It is the real function rather than a
  // stub, because its RETURN VALUE is what the processor stores, and a
  // stub here would make the mock the thing under test.
  sanitizeDocument: (content: string, docType: 'cv' | 'cover_letter') => ({
    content: `${docType}:${content}`,
    rules: []
  })
}))
// aiQueue pulls ./database for queue persistence; stub the surface the
// processor touches so tests run without a store. P0.3-era surface
// plus the P1.7 additions: getJob (fit score read at pick time for
// priority ordering), listJobDocuments + getDocumentAutoRegenAttempts /
// bumpDocumentAutoRegenAttempts (review < 80 -> regeneration loop).
// `listJobDocuments`, not `listDocuments`: the review fan-out must not
// union in the base CV, and the mock has to name the same function the
// processor calls or the test proves nothing about which one is used.
// aiQueue pulls ./ai for the generation / verify cases. Stub the two
// entry points the P1.7 review-loop tests need to control, and keep
// the real RateLimitError class so the existing retry tests still
// exercise the genuine error-type branch.
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  return {
    ...actual,
    verifyDocumentContent: vi.fn(async () => ({ kind: 'review', score: 50, passed: false, feedback: 'x', rules: [] })),
    tailorDocument: vi.fn(async () => ({ content: 'x', document_id: 1 })),
    regenerateSection: vi.fn(async () => 'x')
  }
})

vi.mock('./database', () => ({
  getAIQueue: vi.fn(() => []),
  // The processor asks the provider-health query before it claims any
  // row (`providerAvailability` → `eligibleModels` → this). An empty pool
  // answers "not blocked", which is the no-models-configured case and
  // leaves the pass free to claim work exactly as before. The blocked
  // half of that query is covered against a real pool and a real store
  // in queueCooldown.test.ts.
  listApiModels: vi.fn(() => []),
  // The auto-queue gate in enqueue() reads these. Every switch on here
  // means "auto-queueing allowed", which is what the store's own default
  // is; the switches' own behaviour is covered against the real store
  // in aiQueue.autoQueue.test.ts.
  getSettings: vi.fn(() => ({
    auto_queue_fit: true,
    auto_queue_cv: true,
    auto_queue_cover_letter: true,
    auto_queue_verify_cv: true,
    auto_queue_verify_cover_letter: true
  })),
  updateAIQueueItem: vi.fn(() => true),
  removeAIQueueItem: vi.fn(),
  addAIQueueItem: vi.fn(),
  clearAIQueue: vi.fn(() => 0),
  getDocument: vi.fn(),
  getJob: vi.fn(),
  listJobDocuments: vi.fn(() => []),
  getDocumentAutoRegenAttempts: vi.fn(() => 0),
  bumpDocumentAutoRegenAttempts: vi.fn(() => 1),
  // The tailor_job_docs case dynamic-imports this from ./database after
  // generation. It was missing from the mock, so the import yielded
  // undefined, the call threw, and the review fan-out below it never
  // ran — which the then-tautological assertions happily reported as
  // "nothing to assert".
  recomputeJobStatusFromDocs: vi.fn(),
  // The per-unit generation case uses the other two for the same reason
  // and with the same consequence if they are absent: it stores the
  // SANITIZED content onto the row `tailorDocument` created, and records
  // the tailor_* timing/error fields. Both calls sit between the
  // tailoring call and the review chaining, so a missing mock entry threw
  // into the catch and every assertion below the throw read as "the chain
  // never fired".
  setDocumentContent: vi.fn((id: number) => ({ id })),
  writeTailorTimingFields: vi.fn(),
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

import { AUTO_REGEN_MAX, AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import { withAiOperation } from './ai'
import { processQueue, enqueue, listQueueInPickOrder, retryQueueItem, removeQueueItem, clearQueue, reclaimInterruptedItems, startQueueProcessor, stopQueueProcessor } from './aiQueue'
import { scoreOneJobInBackground } from './fitScorer'
import { tailorJobDocsForJob } from './tailorJobDocs'
import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, clearAIQueue, getJob, getDocument, listJobDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts } from './database'
import { RateLimitError, tailorDocument, verifyDocumentContent } from './ai'

const mockedScore = vi.mocked(scoreOneJobInBackground)
const mockedGetQueue = vi.mocked(getAIQueue)
const mockedUpdate = vi.mocked(updateAIQueueItem)
const mockedRemove = vi.mocked(removeAIQueueItem)
const mockedAdd = vi.mocked(addAIQueueItem)
const mockedClear = vi.mocked(clearAIQueue)
const mockedGetJob = vi.mocked(getJob)
const mockedTailor = vi.mocked(tailorJobDocsForJob)
const mockedGetDocument = vi.mocked(getDocument)
const mockedVerify = vi.mocked(verifyDocumentContent)
const mockedTailorDoc = vi.mocked(tailorDocument)
const mockedListDocuments = vi.mocked(listJobDocuments)
const mockedGetRegen = vi.mocked(getDocumentAutoRegenAttempts)
const mockedBumpRegen = vi.mocked(bumpDocumentAutoRegenAttempts)

function queueItem(overrides: Partial<AIQueueItem>): AIQueueItem {
  return {
    id: 'q1',
    type: 'score_fit',
    jobId: 42,
    documentId: null,
    sectionName: null,
    extraContext: null,
    createdAt: Date.now(),
    nextRetryAt: 0,
    attempts: 0,
    status: 'pending',
    lastError: null,
    ...overrides
  }
}

/** A document row for the job-scoped list mock. */
function docRow(id: number, jobId: number, type: 'cv' | 'cover_letter'): Document {
  return {
    id, job_id: jobId, type, title: '', content: '', is_base: 0, model_used: null,
    verification_score: null, verification_feedback: null,
    created_at: '', updated_at: ''
  }
}

function scoredJob(overrides: Partial<Job>): Job {
  return {
    id: 42, title: 'Engineer', company: 'Acme', status: 'sourced', score: null,
    fit_breakdown: null, fit_score_version: null, fit_source: null,
    fit_last_error: null, fit_error_toasted: null, notes: null, date_posted: null,
    application_deadline: null, last_updated: null, created_at: '',
    updated_at: '', match_grade: null, tailor_ms_cv: null, tailor_ms_cl: null,
    tailor_generated_at: null, tailor_last_error: null, tailor_error_toasted: null,
    submitted_at: null, response_at: null, location: null, url: null,
    description: null, salary_range: null, requirements: null,
    application_requirements: null, hiring_manager: null, employment_type: null,
    work_mode: null, source: null, fit_rationale: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('score_fit queue processing', () => {
  it('removes the item when scoring succeeds with a real score', async () => {
    mockedGetQueue.mockReturnValue([queueItem({})])
    mockedScore.mockResolvedValue(scoredJob({ score: 0.82, fit_score_version: 3 }))
    await processQueue()
    expect(mockedScore).toHaveBeenCalledWith(42, expect.any(Function), { manual: false })
    expect(mockedRemove).toHaveBeenCalledWith('q1')
  })

  it('removes the item silently when the job was deleted mid-run (null result)', async () => {
    mockedGetQueue.mockReturnValue([queueItem({})])
    mockedScore.mockResolvedValue(null)
    await processQueue()
    expect(mockedRemove).toHaveBeenCalledWith('q1')
    // No retry was scheduled either.
    expect(mockedUpdate).not.toHaveBeenCalledWith('q1', expect.objectContaining({ status: 'pending' }))
  })

  it('schedules a bounded retry when the scorer fell back to heuristic (score stays null)', async () => {
    mockedGetQueue.mockReturnValue([queueItem({})])
    mockedScore.mockResolvedValue(
      scoredJob({ score: null, fit_last_error: 'provider timeout' })
    )
    await processQueue()
    expect(mockedRemove).not.toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ status: 'pending', attempts: 1, lastError: 'provider timeout' })
    )
    const retryCall = mockedUpdate.mock.calls.find(
      (c) => c[1].status === 'pending'
    )
    expect(retryCall).toBeDefined()
    expect(retryCall![1].nextRetryAt).toBeGreaterThanOrEqual(Date.now())
  })

  it('retries non-rate-limit score_fit failures up to 5 attempts', async () => {
    mockedGetQueue.mockReturnValue([queueItem({ attempts: 3, lastError: 'x' })])
    mockedScore.mockRejectedValue(new Error('LLM call failed'))
    await processQueue()
    // attempts becomes 4 → still pending, nextRetry scheduled.
    expect(mockedUpdate).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ status: 'pending', attempts: 4 })
    )
  })

  it('stops short of a terminal failure at 5 attempts and schedules a revival instead', async () => {
    // Was "fails score_fit permanently after 5 non-rate-limit
    // attempts". A capped item is no longer terminal — it parks itself
    // on a cooldown and comes back on its own, so the user never has to
    // notice a quota outage and click Retry. It stops after 5 rapid
    // attempts either way; only the aftermath changed.
    mockedGetQueue.mockReturnValue([queueItem({ attempts: 5, lastError: 'x' })])
    mockedScore.mockRejectedValue(new Error('LLM call failed'))
    await processQueue()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ status: 'pending', attempts: 0, autoRevives: 1 })
    )
  })

  it('keeps rate-limit retries on the original 10-attempt path', async () => {
    mockedGetQueue.mockReturnValue([queueItem({ attempts: 7 })])
    mockedScore.mockRejectedValue(new RateLimitError('429 slow down'))
    await processQueue()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ status: 'pending', attempts: 8 })
    )
  })
})

// P1.7 — priority queue. Management spec (BRIEF5 §3):
//   1. ALL score_fit items FIRST (fit scoring has absolute priority).
//   2. Then generation/review items ordered by fit score DESC.
//   3. Live re-sorting: a fit score that lands or changes after enqueue
//      reorders the queue immediately (fit 95 arriving later jumps
//      ahead of a queued fit-60 job).
// Implementation: pick-time sort by (tier, -fitScore) where tier is 0
// for score_fit and 1 for everything else, with the fit score re-read
// from the job row at pick time (never from a frozen enqueue snapshot).
describe('P1.7 priority ordering (score_fit first, then fit DESC)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetQueue.mockReturnValue([])
    mockedGetJob.mockReturnValue(undefined)
  })

  it('processes every score_fit item before any generation item, regardless of fit score', async () => {
    const order: string[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      order.push(`gen:${jobId}`)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    mockedScore.mockImplementation(async (jobId: number) => {
      order.push(`fit:${jobId}`)
      return scoredJob({ id: jobId, score: 0.95 })
    })
    // Interleave by fit score: the generation jobs have HIGHER fit
    // than the score_fit jobs' targets, but score_fit still wins.
    mockedGetJob.mockImplementation((id: number) => scoredJob({ id, score: id === 1 ? 0.95 : 0.10 }))
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 'f1', type: 'score_fit', jobId: 2 }),
      queueItem({ id: 'g2', type: 'tailor_job_docs', jobId: 3 }),
      queueItem({ id: 'f2', type: 'score_fit', jobId: 4 })
    ])
    await processQueue()
    // Both score_fit items ran first (tier 0), then generation.
    expect(order).toEqual(['fit:2', 'fit:4', 'gen:1', 'gen:3'])
  })

  it('orders generation items by fit score DESC (95-job before 60-job)', async () => {
    const order: number[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      order.push(jobId)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    // Enqueued low-first so insertion order is the OPPOSITE of the
    // expected pick order — the sort must be driven by fit score, not
    // by queue insertion order.
    mockedGetJob.mockImplementation((id: number) =>
      scoredJob({ id, score: id === 1 ? 0.60 : id === 2 ? 0.95 : 0.75 })
    )
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g60', type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 'g75', type: 'tailor_job_docs', jobId: 3 }),
      queueItem({ id: 'g95', type: 'tailor_job_docs', jobId: 2 })
    ])
    await processQueue()
    expect(order).toEqual([2, 3, 1])
  })

  it('live re-sorts when a job fit score changes after enqueue (95 arriving later jumps ahead of a queued 60)', async () => {
    // First pass: both jobs at 60 / 50, queued in that order.
    const firstOrder: number[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      firstOrder.push(jobId)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    mockedGetJob.mockImplementation((id: number) => scoredJob({ id, score: id === 1 ? 0.60 : 0.50 }))
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g60', type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 'g50', type: 'tailor_job_docs', jobId: 2 })
    ])
    await processQueue()
    expect(firstOrder).toEqual([1, 2])

    // Second pass: job 2's fit has since risen to 95. The SAME queue
    // entries (no re-enqueue, no priority field mutation) must now be
    // picked job-2-first because the fit score is re-read at pick time.
    const secondOrder: number[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      secondOrder.push(jobId)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    mockedGetJob.mockImplementation((id: number) => scoredJob({ id, score: id === 1 ? 0.60 : 0.95 }))
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g60', type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 'g50', type: 'tailor_job_docs', jobId: 2 })
    ])
    await processQueue()
    expect(secondOrder).toEqual([2, 1])
  })

  it('breaks fit-score ties deterministically by ascending queue id (stable pick order)', async () => {
    const order: number[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      order.push(jobId)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    // All three jobs at the same fit score; the (numeric) queue id is
    // the tiebreaker so repeat runs pick in the same order. Real queue
    // ids come from the store's `nextId++`, so they are numbers.
    mockedGetJob.mockImplementation((id: number) => scoredJob({ id, score: 0.5 }))
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 30 as any, type: 'tailor_job_docs', jobId: 3 }),
      queueItem({ id: 10 as any, type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 20 as any, type: 'tailor_job_docs', jobId: 2 })
    ])
    await processQueue()
    expect(order).toEqual([1, 2, 3])
  })

  it('treats a job with a null fit score as lowest priority within the non-score_fit tier', async () => {
    const order: string[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      order.push(`j${jobId}`)
      return { cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0 }
    })
    mockedGetJob.mockImplementation((id: number) =>
      id === 2 ? scoredJob({ id, score: null }) : scoredJob({ id, score: 0.4 })
    )
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'null', type: 'tailor_job_docs', jobId: 2 }),
      queueItem({ id: 'low', type: 'tailor_job_docs', jobId: 1 })
    ])
    await processQueue()
    expect(order).toEqual(['j1', 'j2'])
  })
})

// P1.7 §1 — generation then review, sequentially per job. The review
// item must not exist until the generation item completes, so the
// queue itself enforces the ordering (no parallel doc-N review while
// doc-N is still generating).
describe('P1.7 sequential generation -> review per job', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetQueue.mockReturnValue([])
    mockedGetJob.mockReturnValue(undefined)
  })

  it('enqueues verify items for both docs only after generation completes', async () => {
    const seen: string[] = []
    mockedTailor.mockImplementation(async (jobId: number) => {
      seen.push(`gen:${jobId}`)
      return { cvId: 11, clId: 12, ms_cv: 0, ms_cl: 0 }
    })
    // Only a generation item is queued. After it completes, the queue
    // processor must enqueue one verify per generated doc.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    mockedListDocuments.mockReturnValue([
      { id: 11, job_id: 7, type: 'cv' },
      { id: 12, job_id: 7, type: 'cover_letter' }
    ] as any)
    await processQueue()
    expect(seen).toEqual(['gen:7'])
    // One review per generated document, for THIS job. (This asserted
    // `mockedUpdate.mock.calls.length >= 0` — true of every number, so
    // it could not tell "the review chain exists" from "nobody queues a
    // review at all".)
    expect(mockedAdd).toHaveBeenCalledTimes(2)
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verify', jobId: 7, documentId: 11 })
    )
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verify', jobId: 7, documentId: 12 })
    )
  })

  it('enqueues the reviews only after the generation item is done', async () => {
    // The ordering is the feature: the review item must not exist
    // while the document is still being written.
    const pendingDuringGeneration: unknown[] = []
    mockedTailor.mockImplementation(async () => {
      // What the queue holds while tailorJobDocsForJob is mid-flight.
      pendingDuringGeneration.push(...mockedAdd.mock.calls)
      return { cvId: 11, clId: 12, ms_cv: 0, ms_cl: 0 }
    })
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    mockedListDocuments.mockReturnValue([docRow(11, 7, 'cv'), docRow(12, 7, 'cover_letter')])

    await processQueue()

    expect(pendingDuringGeneration).toEqual([])
    expect(mockedAdd).toHaveBeenCalledWith(expect.objectContaining({ type: 'verify' }))
  })

  it('does not enqueue a review when generation produced no documents', async () => {
    mockedTailor.mockResolvedValue({ cvId: 0, clId: 0, ms_cv: 0, ms_cl: 0 })
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    mockedListDocuments.mockReturnValue([])
    await processQueue()
    // No verify items enqueued (addAIQueueItem never called with a
    // verify type). Previously asserted on getAIQueue's call count.
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('reads the job-scoped document list, never the one that unions in the base CV', async () => {
    // The base CV is shown next to every job in the UI, which is why
    // `listDocuments(jobId)` includes it — and why the review fan-out
    // has to use the job-scoped variant. Getting this wrong uploaded
    // the user's master CV to the reviewer on every job's generation
    // pass.
    mockedTailor.mockResolvedValue({ cvId: 11, clId: 12, ms_cv: 0, ms_cl: 0 })
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    mockedListDocuments.mockReturnValue([docRow(11, 7, 'cv'), docRow(12, 7, 'cover_letter')])

    await processQueue()

    expect(mockedListDocuments).toHaveBeenCalledWith(7)
  })
})

// P1.7 §2 — review < 80 triggers regeneration, capped at 5 attempts.
// After the cap the doc is flagged for manual attention: the
// verification_score stays < 80 and no further regeneration is queued.
describe('P1.7 review < 80 -> auto-regenerate (cap 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetQueue.mockReturnValue([])
    mockedGetJob.mockReturnValue(undefined)
    mockedGetRegen.mockReturnValue(0)
    mockedBumpRegen.mockReturnValue(1)
  })

  it('enqueues a regeneration when the review scores below 80', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 55, passed: false, feedback: 'Weak.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    mockedGetRegen.mockReturnValue(0)
    mockedBumpRegen.mockReturnValue(1)
    await processQueue()
    // The loop consulted the counter, bumped it, and queued a rebuild
    // of the SAME doc type.
    expect(mockedGetRegen).toHaveBeenCalledWith(11)
    expect(mockedBumpRegen).toHaveBeenCalledWith(11)
    // A regeneration was actually QUEUED — and queued for THIS
    // document, not just for its job. This used to read
    // `getAIQueue().mock.results` and assert
    // `toBeGreaterThanOrEqual(0)`, which is true of every number: with
    // the entire regeneration enqueue deleted the whole suite stayed
    // green, which is how a loop that could only ever run once shipped.
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generate_cv', jobId: 7, documentId: 11 })
    )
  })

  it('does not enqueue a regeneration when the review already passes (>= 80)', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 88, passed: true, feedback: 'Good.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    await processQueue()
    // A passing doc never enters the regeneration loop.
    expect(mockedGetRegen).not.toHaveBeenCalled()
    expect(mockedBumpRegen).not.toHaveBeenCalled()
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('does not enqueue a regeneration when the review skipped (no review happened)', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'skip', reason: 'parse_failed', feedback: 'no review'
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    await processQueue()
    // A skip is NOT a failing review — it must not feed the loop.
    expect(mockedBumpRegen).not.toHaveBeenCalled()
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('stops regenerating once the 5-attempt cap is reached (flags for manual attention)', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 40, passed: false, feedback: 'Still weak.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    // Cap already exhausted.
    mockedGetRegen.mockReturnValue(5)
    await processQueue()
    // No further bump / regeneration once the cap is hit. The doc keeps
    // its sub-80 verification_score, which is the manual-attention flag.
    expect(mockedBumpRegen).not.toHaveBeenCalled()
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('bumps the counter on each failing pass so the loop advances toward the cap', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 45, passed: false, feedback: 'Weak.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cover_letter' } as any)
    // 4 attempts so far: this is the 5th and last permitted one.
    mockedGetRegen.mockReturnValue(4)
    mockedBumpRegen.mockReturnValue(5)
    await processQueue()
    // The 5th attempt is allowed through (5 > AUTO_REGEN_MAX is false).
    expect(mockedBumpRegen).toHaveBeenCalledWith(11)
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generate_cover_letter', jobId: 7, documentId: 11 })
    )
  })

  it('blocks the 6th pass: a bump that overshoots the cap queues nothing', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 45, passed: false, feedback: 'Weak.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    mockedGetRegen.mockReturnValue(5)
    mockedBumpRegen.mockReturnValue(6)
    await processQueue()
    // Defensive: even if a caller bumps past the cap, no regeneration
    // is queued.
    expect(mockedGetRegen).toHaveBeenCalledWith(11)
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  // The document vanished between the review and the counter bump (a
  // delete landing while the LLM call was in flight). `null` means
  // "unknown document", and the loop has to treat that as a dead end.
  // It used to arrive as 0 — indistinguishable from "budget fresh" —
  // and `0 > AUTO_REGEN_MAX` is false, so the loop queued a rebuild of
  // a row that no longer exists and then re-reviewed it.
  it('queues nothing when the bump reports the document is gone', async () => {
    vi.mocked(verifyDocumentContent).mockResolvedValue({
      kind: 'review', score: 45, passed: false, feedback: 'Weak.', rules: []
    } as any)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    mockedGetDocument.mockReturnValue({ id: 11, job_id: 7, type: 'cv' } as any)
    mockedGetRegen.mockReturnValue(0)
    mockedBumpRegen.mockReturnValue(null)
    await processQueue()
    // The counter was still consulted — the document was believed to
    // exist a moment ago — but a missing row ends the loop rather than
    // restarting its budget.
    expect(mockedBumpRegen).toHaveBeenCalledWith(11)
    expect(mockedAdd).not.toHaveBeenCalled()
  })
})

// P1.7 §2 — the other half of the loop. A regeneration item names the
// document to rebuild, and the rebuild hands the document straight
// back to the reviewer. Without either half the cycle is
// verify -> fail -> regenerate -> STOP: the replacement is a new row
// (fresh counter, so AUTO_REGEN_MAX is unreachable) and nothing ever
// reviews it, so the user is left looking at an unreviewed document
// presented as the job's regenerated CV.
//
// These pin the queue-item contract in isolation; aiQueue.regen.test.ts
// drives the same thing end to end against the real store.
describe('P1.7 regeneration rebuilds the failed document and re-queues its review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetQueue.mockReturnValue([])
    mockedGetJob.mockReturnValue(undefined)
    mockedUpdate.mockReset().mockReturnValue(true)
    // The default from the module mock, re-asserted because mockClear
    // does not remove implementations set by an earlier test.
    mockedTailorDoc.mockImplementation(async () => ({ content: 'x', document_id: 1 }))
  })

  it('rebuilds the document the failing review named, not a new one', async () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'r1', type: 'generate_cv', jobId: 7, documentId: 11 })
    ])

    await processQueue()

    expect(mockedTailorDoc).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 7, document_type: 'cv', document_id: 11 }),
      { manual: false }
    )
  })

  it('rebuilds a cover letter as a cover letter', async () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'r1', type: 'generate_cover_letter', jobId: 7, documentId: 12 })
    ])

    await processQueue()

    expect(mockedTailorDoc).toHaveBeenCalledWith(
      expect.objectContaining({ document_type: 'cover_letter', document_id: 12 }),
      { manual: false }
    )
  })

  it('asks for no document on a first generation, so a new one is created', async () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'generate_cv', jobId: 7 })
    ])

    await processQueue()

    const [request] = mockedTailorDoc.mock.calls[0]
    expect(request.document_id ?? null).toBeNull()
  })

  it('re-queues a review of the document it just rebuilt', async () => {
    // The document the rebuild actually wrote, which is what has to go
    // back to the reviewer: chaining the review is the only thing that
    // lets the loop advance past one round.
    mockedTailorDoc.mockImplementation(async () => ({ content: 'x', document_id: 42 }))
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'r1', type: 'generate_cv', jobId: 7, documentId: 11 })
    ])

    await processQueue()

    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verify', jobId: 7, documentId: 42 })
    )
  })

  it('consumes the rebuild item rather than leaving it to run again', async () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'r1', type: 'generate_cv', jobId: 7, documentId: 11 })
    ])

    await processQueue()

    expect(mockedRemove).toHaveBeenCalledWith('r1')
  })
})

// P1.7 §4 — enqueue() must not stack duplicate spam. Two auto-enqueue
// triggers firing for the same job (fit lands, then a re-scan) must
// collapse to a single pending item.
describe('P1.7 enqueue() duplicate suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when an identical pending item already exists', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    const result = enqueue({ type: 'tailor_job_docs', jobId: 7 })
    expect(result).toBeNull()
  })

  it('creates the item when no identical pending entry exists', () => {
    mockedGetQueue.mockReturnValue([])
    const result = enqueue({ type: 'tailor_job_docs', jobId: 7 })
    expect(result).not.toBeNull()
    expect(mockedAdd).toHaveBeenCalledWith(expect.objectContaining({ type: 'tailor_job_docs', jobId: 7 }))
  })

  it('does not collapse a regeneration onto an unrelated generate item for the same job', () => {
    // A `verify` item and a `tailor_job_docs` item for the same job
    // are different work and must both be allowed to coexist.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'v1', type: 'verify', jobId: 7, documentId: 11 })
    ])
    const result = enqueue({ type: 'tailor_job_docs', jobId: 7 })
    expect(result).not.toBeNull()
  })
})

// The renderer's Queue panel lists tasks in the order the processor
// will actually pick them, so the ordering rule has to be reachable
// without running the processor (which would mutate status). This
// reuses pickOrder() rather than re-deriving the sort in the renderer,
// so the displayed order cannot drift from the executed order.
describe('listQueueInPickOrder (Queue panel ordering)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns an empty array when the queue is empty', () => {
    mockedGetQueue.mockReturnValue([])
    expect(listQueueInPickOrder()).toEqual([])
  })

  it('puts every score_fit item ahead of higher-fit generation items', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'tailor_job_docs', jobId: 1 }),
      queueItem({ id: 2, type: 'score_fit', jobId: 2 })
    ])
    mockedGetJob.mockImplementation((id) => ({ id, score: 0.9 }) as Job)
    expect(listQueueInPickOrder().map((i) => i.id)).toEqual([2, 1])
  })

  it('orders generation items by fit score descending', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'verify', jobId: 1 }),
      queueItem({ id: 2, type: 'verify', jobId: 2 }),
      queueItem({ id: 3, type: 'verify', jobId: 3 })
    ])
    const scores: Record<number, number> = { 1: 0.6, 2: 0.95, 3: 0.75 }
    mockedGetJob.mockImplementation((id) => ({ id, score: scores[id] }) as Job)
    expect(listQueueInPickOrder().map((i) => i.jobId)).toEqual([2, 3, 1])
  })

  it('sorts a null fit score last within its tier', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'verify', jobId: 1 }),
      queueItem({ id: 2, type: 'verify', jobId: 2 })
    ])
    mockedGetJob.mockImplementation((id) => (id === 1 ? ({ id, score: 0.4 } as Job) : null))
    expect(listQueueInPickOrder().map((i) => i.jobId)).toEqual([1, 2])
  })

  it('ties equal fit scores by ascending queue id', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 30, type: 'verify', jobId: 1 }),
      queueItem({ id: 10, type: 'verify', jobId: 2 }),
      queueItem({ id: 20, type: 'verify', jobId: 3 })
    ])
    mockedGetJob.mockImplementation((id) => ({ id, score: 0.5 }) as Job)
    expect(listQueueInPickOrder().map((i) => i.id)).toEqual([10, 20, 30])
  })

  it('reflects a fit score that changed after the item was enqueued', () => {
    // The panel must not show a stale order: same rows, no re-enqueue,
    // but job 2's fit has since risen above job 1's.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'verify', jobId: 1 }),
      queueItem({ id: 2, type: 'verify', jobId: 2 })
    ])
    const scores: Record<number, number> = { 1: 0.6, 2: 0.5 }
    mockedGetJob.mockImplementation((id) => ({ id, score: scores[id] }) as Job)
    expect(listQueueInPickOrder().map((i) => i.jobId)).toEqual([1, 2])
    scores[2] = 0.95
    expect(listQueueInPickOrder().map((i) => i.jobId)).toEqual([2, 1])
  })

  it('does not mutate the array returned by the store', () => {
    const rows = [
      queueItem({ id: 2, type: 'verify', jobId: 2 }),
      queueItem({ id: 1, type: 'verify', jobId: 1 })
    ]
    mockedGetQueue.mockReturnValue(rows)
    mockedGetJob.mockImplementation((id) => ({ id, score: 0.1 }) as Job)
    listQueueInPickOrder()
    expect(rows.map((i) => i.id)).toEqual([2, 1])
  })
})

// A `failed` queue item used to be terminal. These cover the automatic
// recovery loop: capped items park themselves on a long cooldown and
// rejoin the queue on their own, bounded so a genuinely broken task
// eventually stays failed.
describe('automatic revival of capped items', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a revived item to the queue when it exhausts its budget', async () => {
    // A failed item is otherwise terminal: the processor only picks
    // `status === 'pending'`, so a rate-limited task that burned its
    // budget would sit dead until the user clicked Retry. It has to
    // schedule its own return with a fresh attempt count.
    mockedScore.mockResolvedValue({ score: null, fit_last_error: 'LLM down' } as never)
    const capped = queueItem({ id: 1, type: 'score_fit', jobId: 42, attempts: 4 })
    mockedGetQueue.mockReturnValue([capped])

    await processQueue()

    const patch = mockedUpdate.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(patch.status).toBe('pending')
    expect(patch.attempts).toBe(0)
    expect(patch.autoRevives).toBe(1)
  })

  it('schedules the revival far enough out not to hammer a downed provider', async () => {
    mockedScore.mockResolvedValue({ score: null, fit_last_error: 'LLM down' } as never)
    const before = Date.now()
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, type: 'score_fit', jobId: 42, attempts: 4 })])

    await processQueue()

    const patch = mockedUpdate.mock.calls.at(-1)?.[1] as { nextRetryAt: number }
    expect(patch.nextRetryAt).toBeGreaterThanOrEqual(before + AUTO_REVIVE_COOLDOWN_MS)
  })

  it('gives an auto-revived item a full attempt budget again', async () => {
    // The whole point: after reviving, a score_fit failure at attempt 5
    // must be retried rather than instantly re-failing on the cap.
    mockedScore.mockResolvedValue({ score: null, fit_last_error: 'LLM down' } as never)
    const revived = queueItem({
      id: 1, type: 'score_fit', jobId: 42, status: 'pending',
      attempts: 0, autoRevives: 1, nextRetryAt: 0
    })
    mockedGetQueue.mockReturnValue([revived])

    await processQueue()

    const patch = mockedUpdate.mock.calls.at(-1)?.[1] as { attempts: number; status: string }
    expect(patch.attempts).toBe(1)
    expect(patch.status).toBe('pending')
  })

  it('stops auto-reviving once the revive budget is spent', async () => {
    // Bounded, or a permanently broken task would loop forever burning
    // LLM calls. Past the cap it stays failed for the user to act on.
    mockedScore.mockResolvedValue({ score: null, fit_last_error: 'LLM down' } as never)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'score_fit', jobId: 42, attempts: 4, autoRevives: AUTO_REVIVE_MAX })
    ])

    await processQueue()

    const patch = mockedUpdate.mock.calls.at(-1)?.[1] as { status: string }
    expect(patch.status).toBe('failed')
  })

  it('leaves a failed item alone until its revival time has passed', async () => {
    // Failed items must not be picked on every 30s poll, or the whole
    // failed set would churn through LLM calls continuously.
    const failed = queueItem({
      id: 1, type: 'score_fit', jobId: 42, status: 'failed',
      attempts: 5, autoRevives: 1, nextRetryAt: Date.now() + 60_000
    })
    mockedGetQueue.mockReturnValue([failed])

    await processQueue()

    expect(mockedScore).not.toHaveBeenCalled()
  })

  it('revives a failed item whose revival time has passed', async () => {
    const failed = queueItem({
      id: 1, type: 'score_fit', jobId: 42, status: 'failed',
      attempts: 5, autoRevives: 1, nextRetryAt: Date.now() - 1
    })
    mockedGetQueue.mockReturnValue([failed])
    mockedScore.mockResolvedValue({ score: 0.8 } as never)

    await processQueue()

    expect(mockedScore).toHaveBeenCalledWith(42, expect.any(Function), { manual: false })
  })

  it('treats a legacy failed row with no revive bookkeeping as revivable', async () => {
    // Rows written before autoRevives existed have no counter at all.
    // They must revive rather than being treated as permanently spent.
    const legacy = queueItem({ id: 1, type: 'score_fit', jobId: 42, status: 'failed', attempts: 5 })
    mockedGetQueue.mockReturnValue([legacy])
    mockedScore.mockResolvedValue({ score: 0.8 } as never)

    await processQueue()

    expect(mockedScore).toHaveBeenCalledWith(42, expect.any(Function), { manual: false })
  })
})

// A row left `processing` by a killed or crashed app is invisible to
// the processor: it only ever picked `pending`, so the task was
// stranded forever no matter how long the app stayed running. Over a
// long queue an interrupted item is near-certain, so this is the
// normal path to "some jobs never finished".
describe('reclaiming interrupted items', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reclaims a row left processing by a previous run', () => {
    const stuck = queueItem({ id: 7, type: 'score_fit', jobId: 42, status: 'processing', attempts: 2 })
    mockedGetQueue.mockReturnValue([stuck])
    reclaimInterruptedItems()
    expect(mockedUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'pending' }))
  })

  it('makes a reclaimed item due immediately rather than waiting out a backoff', () => {
    // The interruption already cost the user the wait; re-running now
    // is the whole point of reclaiming.
    //
    // The upper bound has to be read *after* the call, not before.
    // `reclaimInterruptedItems` stamps `nextRetryAt: Date.now()` from inside
    // its loop, so a `Date.now()` captured beforehand is by construction
    // earlier than the stamp and the two only agree when the whole call
    // happens to land inside one millisecond. Reproduced deterministically by
    // burning ~3ms of wall clock between the two reads: with the old
    // assertion the test fails every time, with this one it passes.
    //
    // Reading the clock afterwards states the contract the queue actually
    // implements -- `runPass` treats an item as due when
    // `nextRetryAt <= Date.now()` (aiQueue.ts:515) -- instead of a relation
    // between two `Date.now()` calls 3ms apart. The lower bound is kept so a
    // stamp from before this test started would still fail.
    const before = Date.now()
    mockedGetQueue.mockReturnValue([queueItem({ id: 7, status: 'processing' })])
    reclaimInterruptedItems()
    const patch = mockedUpdate.mock.calls[0][1] as { nextRetryAt: number }
    expect(patch.nextRetryAt).toBeLessThanOrEqual(Date.now())
    expect(patch.nextRetryAt).toBeGreaterThanOrEqual(before)
  })

  it('leaves pending and failed items alone', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, status: 'pending' }),
      queueItem({ id: 2, status: 'failed' })
    ])
    reclaimInterruptedItems()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('does not disturb a healthy empty queue', () => {
    mockedGetQueue.mockReturnValue([])
    reclaimInterruptedItems()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('is safe to run when nothing was interrupted', () => {
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, status: 'pending' })])
    expect(() => reclaimInterruptedItems()).not.toThrow()
  })

  it('recovers a stuck item through a real pass', async () => {
    mockedGetQueue.mockReturnValue([queueItem({ id: 7, type: 'score_fit', jobId: 42, status: 'processing' })])
    mockedScore.mockResolvedValue(scoredJob({ score: 0.9 }))
    reclaimInterruptedItems()
    vi.mocked(updateAIQueueItem).mockClear()
    mockedGetQueue.mockReturnValue([queueItem({ id: 7, type: 'score_fit', jobId: 42, status: 'pending' })])
    await processQueue()
    expect(mockedScore).toHaveBeenCalledWith(42, expect.any(Function), { manual: false })
    expect(mockedRemove).toHaveBeenCalledWith(7)
  })

  it('is actually invoked at startup, not merely available', () => {
    // The bug was never a missing reclaim function — it was a missing
    // call site. Asserting the function in isolation would keep passing
    // if the call were dropped from startQueueProcessor, which is
    // exactly the regression worth guarding.
    mockedGetQueue.mockReturnValue([queueItem({ id: 7, status: 'processing' })])
    startQueueProcessor(60_000)
    try {
      expect(mockedUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'pending' }))
    } finally {
      stopQueueProcessor()
    }
  })

  it('preserves the spent attempt count of an interrupted item', () => {
    // The attempt was still consumed. Resetting it would hand a task
    // that reliably crashes an unlimited budget.
    mockedGetQueue.mockReturnValue([queueItem({ id: 7, status: 'processing', attempts: 3 })])
    reclaimInterruptedItems()
    const patch = mockedUpdate.mock.calls[0][1] as { attempts?: number }
    expect(patch.attempts).toBeUndefined()
  })
})

// Each processor pass is a long serial await loop. If one runs longer
// than the poll interval, setInterval starts a second pass over the
// same store and two LLM calls end up in flight at once — the opposite
// of the serialization the queue depends on, and a direct cause of the
// rate limiting the backoff exists to handle.
describe('overlapping passes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function liveStore(size: number) {
    const rows = Array.from({ length: size }, (_, i) =>
      queueItem({ id: i + 1, type: 'score_fit', jobId: i + 1, status: 'pending' })
    )
    let store = rows
    vi.mocked(getAIQueue).mockImplementation(() => store)
    // Must return true: the processor now treats a falsy result as
    // "this row is gone" and skips the work.
    vi.mocked(updateAIQueueItem).mockImplementation((id: unknown, p: Partial<AIQueueItem>) => {
      store = store.map((r) => (r.id === id ? { ...r, ...p } : r))
      return true
    })
    vi.mocked(removeAIQueueItem).mockImplementation((id: unknown) => {
      store = store.filter((r) => r.id !== id)
    })
    return () => store
  }

  it('does not run two LLM calls at once when a second pass is triggered', async () => {
    const read = liveStore(4)
    let inFlight = 0
    let maxConcurrent = 0
    mockedScore.mockImplementation(async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return scoredJob({ score: 0.8 })
    })

    const first = processQueue()
    await new Promise((r) => setTimeout(r, 5))
    const second = processQueue()
    await Promise.all([first, second])

    expect(maxConcurrent).toBe(1)
    // The second pass is a no-op, not a skipped item: everything is
    // still processed exactly once.
    expect(read()).toHaveLength(0)
  })

  it('processes every item even though one pass was suppressed', async () => {
    liveStore(3)
    mockedScore.mockResolvedValue(scoredJob({ score: 0.8 }))
    await processQueue()
    expect(mockedScore).toHaveBeenCalledTimes(3)
  })

  it('releases the guard so a later pass still runs', async () => {
    liveStore(1)
    mockedScore.mockResolvedValue(scoredJob({ score: 0.8 }))
    await processQueue()
    expect(mockedScore).toHaveBeenCalledTimes(1)
    await processQueue()
    expect(mockedScore).toHaveBeenCalledTimes(1)
  })
})

// Retry has to clear `attempts`, not just the status. The catch block
// gates retries on `attempts < N`, so an item that already burned its
// budget would otherwise get exactly one more attempt and fail again —
// a Retry button that looks live but changes nothing.
describe('retryQueueItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resets the attempt counter', () => {
    mockedGetQueue.mockReturnValue([])
    retryQueueItem(1)
    expect(mockedUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ attempts: 0 }))
  })

  it('makes the item immediately eligible again', () => {
    const before = Date.now()
    mockedGetQueue.mockReturnValue([])
    retryQueueItem(1)
    const patch = mockedUpdate.mock.calls[0][1] as { status: string; nextRetryAt: number }
    expect(patch.status).toBe('pending')
    expect(patch.nextRetryAt).toBeGreaterThanOrEqual(before)
  })

  it('clears the stale error so the panel stops showing a resolved failure', () => {
    mockedGetQueue.mockReturnValue([])
    retryQueueItem(1)
    expect(mockedUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ lastError: undefined }))
  })

  it('returns the queue in pick order', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'verify', jobId: 1 }),
      queueItem({ id: 2, type: 'score_fit', jobId: 2 })
    ])
    mockedGetJob.mockImplementation((id) => ({ id, score: 0.5 }) as Job)
    expect(retryQueueItem(1).map((i) => i.id)).toEqual([2, 1])
  })

  it('grants a capped score_fit item a full retry budget instead of one attempt', async () => {
    // Regression: this is the user-visible bug. The item is at the
    // 5-attempt cap and failed; the user clicks Retry. With `attempts`
    // left untouched the first pass takes it to 6, the `attempts < 5`
    // gate is false, and it lands straight back in `failed`.
    mockedScore.mockResolvedValue({ score: null, fit_last_error: 'LLM unavailable' } as never)
    const capped = queueItem({ id: 1, type: 'score_fit', jobId: 42, attempts: 5, status: 'failed' })

    retryQueueItem(1)
    // The retry wrote the row back as pending with a fresh budget.
    const patch = mockedUpdate.mock.calls[0][1] as { attempts: number; status: string }
    expect(patch).toMatchObject({ attempts: 0, status: 'pending' })

    // Now run the pass the processor would run on that retried row.
    vi.mocked(updateAIQueueItem).mockClear()
    mockedGetQueue.mockReturnValue([{ ...capped, ...patch, nextRetryAt: 0 }])
    await processQueue()

    const after = vi.mocked(updateAIQueueItem).mock.calls.at(-1)?.[1] as { attempts: number; status: string }
    // It retried (attempt 1 of a fresh budget) and is waiting again,
    // rather than being marked failed on its first attempt.
    expect(after.attempts).toBe(1)
    expect(after.status).toBe('pending')
  })
})

describe('lifecycle: quota outage then recovery, unattended', () => {
  it('carries an item from repeated failure to success with no manual retry', async () => {
    let row: any = { id: 1, type: 'score_fit', jobId: 42, status: 'pending', attempts: 0,
      autoRevives: 0, createdAt: 1, nextRetryAt: 0, lastError: null }
    vi.mocked(getAIQueue).mockImplementation(() => [row])
    // Persist writes back into the simulated store, like the real
    // updateAIQueueItem merge does.
    vi.mocked(updateAIQueueItem).mockImplementation((id: any, p: any) => {
      row = { ...row, ...p }
      return true
    })
    vi.mocked(removeAIQueueItem).mockImplementation(() => { row = null })
    // Provider is down: every attempt returns a null score.
    vi.mocked(scoreOneJobInBackground).mockResolvedValue({ score: null, fit_last_error: '429' } as never)

    const timeline: string[] = []
    // Derive the simulated span from the constants instead of hardcoding
    // a pass count. A fixed count silently under-waits whenever the
    // cooldown grows, and the test would then only pass because the
    // recovery loop force-zeroed nextRetryAt — hiding the very timing
    // this is meant to cover.
    const POLL_MS = 30_000
    const advance = () => { if (row && row.nextRetryAt > 0) row.nextRetryAt -= POLL_MS }

    // Outage long enough to exhaust a full attempt budget and go round
    // the revival loop twice. Deliberately shorter than
    // AUTO_REVIVE_MAX cooldowns: an item that keeps failing for that
    // long is meant to reach its final failed state, so an outage
    // spanning the entire budget would (correctly) never recover.
    const outagePasses = Math.ceil((AUTO_REVIVE_COOLDOWN_MS * 2) / POLL_MS)
    for (let i = 0; i < outagePasses; i++) {
      const before = row ? `${row.status}/${row.attempts}/r${row.autoRevives}` : 'gone'
      await processQueue()
      const after = row ? `${row.status}/${row.attempts}/r${row.autoRevives}` : 'gone'
      if (before !== after) timeline.push(after)
      advance()
    }

    // Quota resets. Keep the app running and the clock moving — no
    // force-reset — so the item can only finish via a scheduled
    // revival actually coming due.
    vi.mocked(scoreOneJobInBackground).mockResolvedValue({ score: 0.8 } as never)
    const recoveryPasses = Math.ceil(AUTO_REVIVE_COOLDOWN_MS / POLL_MS) + 100
    for (let i = 0; i < recoveryPasses && row; i++) { await processQueue(); advance() }

    expect(row, 'item should have completed and been removed').toBeNull()
    expect(vi.mocked(removeAIQueueItem)).toHaveBeenCalledWith(1)
    expect(timeline.some((t) => t.startsWith('pending/0/r1')), 'should have auto-revived').toBe(true)
    expect(timeline.filter((t) => t.startsWith('failed')).length, 'should never sit terminally failed').toBe(0)
  })
})

// A separate guard on the interaction between the two constants. At 3
// revivals 4h apart, a task failing for real reasons takes up to 12h to
// reach its final failed state — that is the intended trade, but it
// should be a deliberate one, so it is asserted rather than discovered
// later when a queue looks stuck for half a day.
describe('cooldown and revive budget together', () => {
  it('gives up after roughly MAX cooldowns of continuous failure', () => {
    const spanMs = AUTO_REVIVE_MAX * AUTO_REVIVE_COOLDOWN_MS
    expect(spanMs).toBe(12 * 60 * 60 * 1000)
  })

  it('keeps the cooldown well past the per-attempt backoff cap', () => {
    // A revival shorter than the backoff cap would be pointless: the
    // item would wake before the backoff it already served.
    expect(AUTO_REVIVE_COOLDOWN_MS).toBeGreaterThan(30 * 60 * 1000)
  })
})

// Clearing is irreversible, so the shape matters as much as the action:
// the caller needs a count to confirm/announce with, and the refreshed
// queue to avoid a second round trip that could race a re-enqueue.
describe('clearQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedClear.mockReturnValue(3)
    // Own store: mock implementations survive vi.clearAllMocks(), so
    // without this these cases inherit whatever the previous test left
    // behind and assert on rows they did not set up.
    mockedGetQueue.mockReturnValue([])
  })

  it('delegates the delete to the store exactly once', () => {
    // toHaveBeenCalledTimes, not toHaveBeenCalled: a double delete would
    // report a count that no longer matches anything.
    clearQueue()
    expect(mockedClear).toHaveBeenCalledTimes(1)
  })

  it('reports how many tasks were removed', () => {
    expect(clearQueue().removed).toBe(3)
  })

  it('returns the refreshed queue in pick order, not raw store order', () => {
    // Store order is deliberately wrong (verify before score_fit).
    // Sorting an empty array would pass either way, so the rows matter.
    mockedClear.mockReturnValue(0)
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 2, type: 'verify', jobId: 2 }),
      queueItem({ id: 1, type: 'score_fit', jobId: 1 })
    ])
    mockedGetJob.mockImplementation((id) => ({ id, score: 0.5 }) as Job)
    expect(clearQueue().queue.map((i) => i.id)).toEqual([1, 2])
  })

  it('reports zero rather than failing on an already-empty queue', () => {
    mockedClear.mockReturnValue(0)
    expect(clearQueue().removed).toBe(0)
  })

  it('returns the ENRICHED view, so Clear cannot blank the labels', () => {
    // The Clear button is the same trap one control over: the renderer
    // replaces its whole list from `result.queue`, so raw rows here
    // would strip jobTitle / jobCompany from every row exactly as a
    // remove did. The old annotation said `AIQueueItem[]` and so
    // advertised the raw shape while the body returned the view — these
    // assertions are what make the annotation and the body agree.
    mockedClear.mockReturnValue(0)
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, jobId: 7 })])
    mockedGetJob.mockImplementation(
      (id: number) => ({ id, score: 0.5, title: `Engineer ${id}`, company: `Acme ${id}` }) as Job
    )
    const [row] = clearQueue().queue
    expect(row.jobTitle).toBe('Engineer 7')
    expect(row.jobCompany).toBe('Acme 7')
  })

  it('returns null display fields for a job deleted before the clear', () => {
    mockedClear.mockReturnValue(0)
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, jobId: 7 })])
    mockedGetJob.mockReturnValue(undefined)
    const [row] = clearQueue().queue
    expect(row.jobTitle).toBeNull()
    expect(row.jobCompany).toBeNull()
  })
})

// `aiQueue:remove` is where the bug actually lived: it answered with
// `db.getAIQueue()` (raw rows, no jobTitle / jobCompany) while list and
// retry answered with the enriched view. The renderer swaps its entire
// list for whatever a call returns, and `jobLine()` falls back to
// `Job <id>` for a row missing the display fields — so removing ONE task
// renamed EVERY other row. `removeQueueItem` exists so that path cannot
// answer with a different shape than its siblings.
describe('removeQueueItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetQueue.mockReturnValue([])
    mockedGetJob.mockImplementation(
      (id: number) => ({ id, score: 0.5, title: `Engineer ${id}`, company: `Acme ${id}` }) as Job
    )
  })

  it('delegates the single-row delete to the store', () => {
    mockedGetQueue.mockReturnValue([queueItem({ id: 1 }), queueItem({ id: 2 })])
    removeQueueItem(1)
    expect(mockedRemove).toHaveBeenCalledTimes(1)
    expect(mockedRemove).toHaveBeenCalledWith(1)
  })

  /**
   * The store model the real one has: `removeAIQueueItem` filters the
   * row out, and the next `getAIQueue()` no longer sees it. Without
   * this the returned list still contains the deleted row and these
   * cases would be asserting on a queue that was never actually pruned.
   */
  function storeWith(rows: AIQueueItem[]): void {
    mockedGetQueue.mockImplementation(() => rows.filter((q) => !mockedRemove.mock.calls.some(([id]) => id === q.id)))
  }

  it('returns the remaining rows with their job fields attached', () => {
    // The rows the user did NOT touch are the ones that lost their
    // labels, so they are the ones worth asserting on.
    storeWith([queueItem({ id: 1, jobId: 7 }), queueItem({ id: 2, jobId: 8 })])
    const rows = removeQueueItem(1)
    expect(rows.map((r) => r.id)).toEqual([2])
    expect(rows.map((r) => r.jobTitle)).toEqual(['Engineer 8'])
    expect(rows.map((r) => r.jobCompany)).toEqual(['Acme 8'])
  })

  it('returns the queue in pick order, like list and retry do', () => {
    storeWith([
      queueItem({ id: 2, type: 'verify', jobId: 2 }),
      queueItem({ id: 1, type: 'score_fit', jobId: 1 })
    ])
    expect(removeQueueItem(99).map((r) => r.id)).toEqual([1, 2])
  })

  it('leaves the display fields null for a deleted job', () => {
    storeWith([queueItem({ id: 1, jobId: 7 })])
    mockedGetJob.mockReturnValue(undefined)
    const [row] = removeQueueItem(99)
    expect(row.jobTitle).toBeNull()
    expect(row.jobCompany).toBeNull()
  })

  it('answers with the same keys listQueueInPickOrder does', () => {
    storeWith([queueItem({ id: 1, jobId: 7 }), queueItem({ id: 2, jobId: 8 })])
    const fromList = listQueueInPickOrder()[0]
    const fromRemove = removeQueueItem(2)[0]
    expect(Object.keys(fromRemove).sort()).toEqual(Object.keys(fromList).sort())
  })
})

// A pass snapshots the queue and then works through it item by item, so
// a clear landing mid-pass used to be invisible to it: every remaining
// item was still processed (spending a real LLM call on work the user
// had just cancelled), and the in-flight item would enqueue its
// follow-up straight back into the emptied queue, rebuilding the
// score_fit -> tailor_job_docs -> verify -> generate chain.
//
// The store model here matches the real one: clearAIQueue REASSIGNS the
// array rather than mutating it, so the pass keeps holding the old rows.
describe('clearing while a pass is mid-flight', () => {
  function racingStore(rows: Partial<AIQueueItem>[]) {
    let aiQueue: AIQueueItem[] = rows.map((r, i) =>
      queueItem({ id: i + 1, documentId: 50 + i, status: 'pending', ...r })
    )
    vi.mocked(getAIQueue).mockImplementation(() => aiQueue)
    vi.mocked(updateAIQueueItem).mockImplementation((id: number, p: Partial<AIQueueItem>) => {
      const before = aiQueue
      aiQueue = aiQueue.map((r) => (r.id === id ? { ...r, ...p } : r))
      return before.some((r) => r.id === id)
    })
    vi.mocked(removeAIQueueItem).mockImplementation((id: number) => {
      aiQueue = aiQueue.filter((r) => r.id !== id)
    })
    vi.mocked(clearAIQueue).mockImplementation(() => {
      const n = aiQueue.length
      aiQueue = []
      return n
    })
    vi.mocked(addAIQueueItem).mockImplementation((item: never) => {
      const row = { ...(item as object), id: 900 + aiQueue.length } as AIQueueItem
      aiQueue = [...aiQueue, row]
      return row
    })
    return () => aiQueue
  }

  it('abandons the rest of the snapshot instead of starting cleared work', async () => {
    // The clear fires from inside item 1's LLM call — the exact moment
    // a real clear races the pass.
    racingStore([{ type: 'verify', jobId: 1 }, { type: 'verify', jobId: 2 }, { type: 'verify', jobId: 3 }])
    mockedGetDocument.mockReturnValue({ id: 50, job_id: 1, type: 'cv' } as never)
    let fired = false
    mockedVerify.mockImplementation(async () => {
      if (!fired) { fired = true; clearQueue() }
      return { kind: 'review', score: 90, passed: true, feedback: '', rules: [] } as never
    })

    await processQueue()

    // Only the in-flight item ran. Items 2 and 3 were never touched.
    expect(mockedVerify).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect follow-up work enqueued after the clear', async () => {
    // A failing review normally drives the regen loop, which enqueues a
    // fresh generate_cv. After a clear it must enqueue nothing.
    const read = racingStore([{ type: 'verify', jobId: 1 }])
    mockedGetDocument.mockReturnValue({ id: 50, job_id: 1, type: 'cv' } as never)
    let fired = false
    mockedVerify.mockImplementation(async () => {
      if (!fired) { fired = true; clearQueue() }
      return { kind: 'review', score: 10, passed: false, feedback: 'bad', rules: [] } as never
    })

    await processQueue()

    expect(read()).toHaveLength(0)
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('does not queue document generation for a fit scored after the clear', async () => {
    // The auto-enqueue for score_fit runs *inside*
    // scoreOneJobInBackground, so the staleness probe is what stops it.
    const read = racingStore([{ type: 'score_fit', jobId: 1 }])
    let fired = false
    mockedScore.mockImplementation(async (_jobId: number, isStale?: () => boolean) => {
      clearQueue()
      expect(isStale?.()).toBe(true)
      fired = true
      return { score: 0.9 } as never
    })

    await processQueue()

    expect(fired).toBe(true)
    expect(mockedAdd).not.toHaveBeenCalled()
    expect(read()).toHaveLength(0)
  })
})

// The Queue panel shows "{title} - {company}" so a task is traceable
// without hunting for a job id. A deleted job has no title, so the
// enrichment has to tolerate getJob returning null rather than render
// "null - null".
describe('listQueueInPickOrder job enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetJob.mockImplementation((id: number) =>
      ({ id, score: 0.5, title: `Engineer ${id}`, company: `Acme ${id}` }) as Job
    )
  })

  it('attaches the job title and company to each item', () => {
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, jobId: 42 })])
    const [row] = listQueueInPickOrder()
    expect(row.jobTitle).toBe('Engineer 42')
    expect(row.jobCompany).toBe('Acme 42')
  })

  it('leaves the fields null for a deleted job', () => {
    mockedGetJob.mockImplementation((id: number) =>
      (id === 42 ? null : ({ id, score: 0.5, title: 'x', company: 'y' }) as Job)
    )
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, jobId: 42 })])
    const [row] = listQueueInPickOrder()
    expect(row.jobTitle).toBeNull()
    expect(row.jobCompany).toBeNull()
  })

  it('enriches every item, not just the first', () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, jobId: 1 }),
      queueItem({ id: 2, jobId: 2 })
    ])
    expect(listQueueInPickOrder().map((r) => r.jobTitle)).toEqual(['Engineer 1', 'Engineer 2'])
  })

  it('still orders by the same rules after enrichment', () => {
    mockedGetJob.mockImplementation((id: number) =>
      ({ id, score: id === 1 ? 0.9 : 0.2, title: `T${id}`, company: `C${id}` }) as Job
    )
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, jobId: 1, type: 'verify' }),
      queueItem({ id: 2, jobId: 2, type: 'verify' })
    ])
    expect(listQueueInPickOrder().map((r) => r.id)).toEqual([1, 2])
  })

  it('does not persist the display fields into the store', () => {
    mockedGetQueue.mockReturnValue([queueItem({ id: 1, jobId: 42 })])
    listQueueInPickOrder()
    // Enrichment is a read-time view. Writing title/company onto the row
    // would stale them the moment a job is renamed.
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})

// The Queue panel showed three score_fit rows for the same job. Two
// creation paths (enqueueScoreFitBacklog and the fit-auto-score timer)
// raced the processor, and enqueue()'s duplicate guard only matched
// `pending` — so any enqueue landing while an identical item was
// mid-`processing` created a second row, and a third pass a third.
describe('duplicate suppression covers in-flight work', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses to duplicate an item that is processing', () => {
    // The window the bug lived in: the processor sets `processing`
    // before its LLM call, so a scan or startup backlog pass landing in
    // that window saw no `pending` twin and added another row.
    mockedGetQueue.mockReturnValue([queueItem({ type: 'score_fit', jobId: 42, status: 'processing' })])
    expect(enqueue({ type: 'score_fit', jobId: 42 })).toBeNull()
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('refuses to duplicate an item that is pending', () => {
    mockedGetQueue.mockReturnValue([queueItem({ type: 'score_fit', jobId: 42, status: 'pending' })])
    expect(enqueue({ type: 'score_fit', jobId: 42 })).toBeNull()
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it('still allows a genuinely new item alongside an in-flight one for another job', () => {
    mockedGetQueue.mockReturnValue([queueItem({ type: 'score_fit', jobId: 42, status: 'processing' })])
    expect(enqueue({ type: 'score_fit', jobId: 43 })).not.toBeNull()
  })

  it('revives a failed item in place instead of queueing a second row', () => {
    // This is the duplicate the user reported. `failed` used to be
    // excluded from the guard as "not in flight, so re-queueing it is
    // the recovery path" — which left the failed row AND a new row for
    // the same work, both in the panel, competing for the same poll.
    // The recovery is now the revive, on the row that is already there.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'f1', type: 'score_fit', jobId: 42, status: 'failed', attempts: 5, lastError: 'x' })
    ])
    expect(enqueue({ type: 'score_fit', jobId: 42 })).toBeNull()
    expect(mockedAdd).not.toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'f1',
      expect.objectContaining({ status: 'pending', attempts: 0, lastError: undefined })
    )
  })

  it('does not treat two items for the same job as duplicates across types', () => {
    mockedGetQueue.mockReturnValue([queueItem({ type: 'tailor_job_docs', jobId: 42, status: 'processing' })])
    expect(enqueue({ type: 'verify', jobId: 42, documentId: 9 })).not.toBeNull()
  })

  it('applies the same rule to every queue type', () => {
    const types: AIQueueItem['type'][] = [
      'generate_cv', 'generate_cover_letter', 'verify', 'tailor_job_docs', 'score_fit'
    ]
    for (const type of types) {
      mockedGetQueue.mockReturnValue([queueItem({ type, jobId: 42, status: 'processing' })])
      expect(enqueue({ type, jobId: 42 } as never), type).toBeNull()
    }
  })
})

// A queue item and a direct renderer action (Recompute Fit / Tailor /
// Verify) are separate entry points into the same AI layer. Each must
// hold the AI slot for its WHOLE duration, so an item that makes several
// requests cannot have a competing action interleaved with it.
describe('queue items hold the AI operation slot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // mockReset, not mockReturnValue: earlier blocks install their own
    // updateAIQueueItem implementations (vi.clearAllMocks does not remove
    // those), and a leaked one reports "row not found" for an id it does
    // not know about, which makes processItem bail before doing any work.
    mockedUpdate.mockReset().mockReturnValue(true)
  })

  it('does not interleave a direct operation with a multi-request queue item', async () => {
    const order: string[] = []
    // generate_cv and generate_cover_letter are two items, but a job's
    // tailor_job_docs enqueues both; simulate the item making two
    // sequential calls the way tailorJobDocsForJob does.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'generate_cv', jobId: 1, status: 'pending' })
    ] as never)
    mockedTailor.mockImplementation(async ({ document_type }: { document_type: string }) => {
      order.push(`queue-${document_type}`)
      await new Promise((r) => setTimeout(r, 10))
      return { content: 'x', document_id: 1 } as never
    })

    const competing = withAiOperation(async () => {
      order.push('direct-begin')
      await new Promise((r) => setTimeout(r, 30))
      order.push('direct-end')
    })

    await processQueue()
    await competing

    // The competing operation must be entirely before or entirely after
    // the queue item's work, never inside it.
    const directAt = order.indexOf('direct-begin')
    const queueAt = order.findIndex((o) => o.startsWith('queue-'))
    expect(directAt === -1 || queueAt === -1 || directAt < queueAt || directAt > queueAt).toBe(true)
  })

  it('completes a queue item without deadlocking on the slot', async () => {
    // Regression guard: processItem calls the AI functions that the IPC
    // handlers also call. If both layers were wrapped in the same
    // non-reentrant gate, the queue would wait on a slot it already
    // holds and never return.
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'score_fit', jobId: 42, status: 'pending' })
    ] as never)
    mockedScore.mockResolvedValue({ score: 0.9 } as never)
    await processQueue()
    expect(mockedScore).toHaveBeenCalledWith(42, expect.any(Function), { manual: false })
    // id: 1 in the fixture above, so the row removed is 1.
    expect(mockedRemove).toHaveBeenCalledWith(1)
  })

  it('lets a queued direct operation run after the item releases the slot', async () => {
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 1, type: 'score_fit', jobId: 42, status: 'pending' })
    ] as never)
    let releaseScore!: () => void
    mockedScore.mockImplementation(async () => {
      await new Promise<void>((r) => { releaseScore = r })
      return { score: 0.9 } as never
    })

    const pass = processQueue()
    await new Promise((r) => setTimeout(r, 5))
    let directRan = false
    const direct = withAiOperation(async () => { directRan = true })
    await new Promise((r) => setTimeout(r, 5))
    // Still blocked: the queue item owns the slot.
    expect(directRan).toBe(false)
    releaseScore()
    await pass
    await direct
    expect(directRan).toBe(true)
  })
})
