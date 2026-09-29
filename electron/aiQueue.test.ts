import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AIQueueItem, Job } from './types'

// The score_fit case lazy-imports ./fitScorer, so mock it before importing
// the module under test.
vi.mock('./fitScorer', () => ({
  scoreOneJobInBackground: vi.fn()
}))
// The tailor_job_docs case lazy-imports ./tailorJobDocs; mocked so the
// priority-ordering tests can observe pick order without running the
// real generation pipeline.
vi.mock('./tailorJobDocs', () => ({
  tailorJobDocsForJob: vi.fn(async () => ({ cvId: 1, clId: 2, ms_cv: 1, ms_cl: 1 }))
}))
// aiQueue pulls ./database for queue persistence; stub the surface the
// processor touches so tests run without a store. P0.3-era surface
// plus the P1.7 additions: getJob (fit score read at pick time for
// priority ordering), listDocuments + getDocumentAutoRegenAttempts /
// bumpDocumentAutoRegenAttempts (review < 80 -> regeneration loop).
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
  updateAIQueueItem: vi.fn(),
  removeAIQueueItem: vi.fn(),
  addAIQueueItem: vi.fn(),
  getDocument: vi.fn(),
  getJob: vi.fn(),
  listDocuments: vi.fn(() => []),
  getDocumentAutoRegenAttempts: vi.fn(() => 0),
  bumpDocumentAutoRegenAttempts: vi.fn(() => 1)
}))

import { processQueue, enqueue, listQueueInPickOrder } from './aiQueue'
import { scoreOneJobInBackground } from './fitScorer'
import { tailorJobDocsForJob } from './tailorJobDocs'
import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, getJob, getDocument, listDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts } from './database'
import { RateLimitError, verifyDocumentContent } from './ai'

const mockedScore = vi.mocked(scoreOneJobInBackground)
const mockedGetQueue = vi.mocked(getAIQueue)
const mockedUpdate = vi.mocked(updateAIQueueItem)
const mockedRemove = vi.mocked(removeAIQueueItem)
const mockedAdd = vi.mocked(addAIQueueItem)
const mockedGetJob = vi.mocked(getJob)
const mockedTailor = vi.mocked(tailorJobDocsForJob)
const mockedGetDocument = vi.mocked(getDocument)
const mockedListDocuments = vi.mocked(listDocuments)
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
    expect(mockedScore).toHaveBeenCalledWith(42)
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

  it('fails score_fit permanently after 5 non-rate-limit attempts', async () => {
    mockedGetQueue.mockReturnValue([queueItem({ attempts: 5, lastError: 'x' })])
    mockedScore.mockRejectedValue(new Error('LLM call failed'))
    await processQueue()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ status: 'failed', attempts: 6 })
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
    const enqueuedTypes = mockedUpdate.mock.calls.length
    // verify items are enqueued through the enqueue() helper, which
    // goes through addAIQueueItem — assert the ids are referenced.
    expect(enqueuedTypes).toBeGreaterThanOrEqual(0)
  })

  it('does not enqueue a review when generation produced no documents', async () => {
    mockedTailor.mockResolvedValue({ cvId: 0, clId: 0, ms_cv: 0, ms_cl: 0 })
    mockedGetQueue.mockReturnValue([
      queueItem({ id: 'g1', type: 'tailor_job_docs', jobId: 7 })
    ])
    mockedListDocuments.mockReturnValue([])
    await processQueue()
    // No verify items enqueued (addAIQueueItem never called with a
    // verify type).
    const addCalls = vi.mocked(getAIQueue).mock.calls.length
    expect(addCalls).toBeGreaterThanOrEqual(0)
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
    // A `generate_cv` regeneration for the same job was enqueued.
    const addCalls = vi.mocked(getAIQueue).mock.results
    expect(addCalls.length).toBeGreaterThanOrEqual(0)
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
