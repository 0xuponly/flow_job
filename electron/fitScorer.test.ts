import { describe, it, expect, vi, beforeEach } from 'vitest'

// fitScorer.ts only depends on ./database, ./ai, and electron's
// BrowserWindow. Stub them out so the test runs without booting a
// real Electron app or hitting the network.
vi.mock('./database', () => ({
  getJob: vi.fn(),
  getSettings: vi.fn(),
  updateJob: vi.fn(),
  listDocuments: vi.fn(() => []),
  getAIQueue: vi.fn(() => []),
  updateAIQueueItem: vi.fn(() => undefined),
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

vi.mock('./aiQueue', () => ({
  enqueue: vi.fn()
}))

vi.mock('./ai', () => ({
  scoreJobFit: vi.fn(),
  // The one error this module lets out rather than absorbing into
  // `fit_last_error`; a full `./ai` mock has to carry the class or the
  // `instanceof` in the catch throws on every failing case.
  ProviderCapError: class ProviderCapError extends Error {}
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./logger', () => {
  const noop = vi.fn()
  const makeLogger = () => ({ info: noop, warn: noop, error: noop })
  return {
    log: {
      fit: makeLogger(),
      ai: makeLogger(),
      scan: makeLogger(),
      startup: makeLogger(),
      backup: makeLogger(),
      scraper: makeLogger()
    },
    createLogger: () => makeLogger()
  }
})

import { getJob, getSettings, updateJob, listDocuments, getAIQueue, updateAIQueueItem } from './database'
import { scoreJobFit } from './ai'
import { enqueue } from './aiQueue'
import { scoreOneJobInBackground, maybeAutoEnqueueDocs, hasCurrentFitVerdict } from './fitScorer'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, Job } from './types'

const mockedGetJob = vi.mocked(getJob)
const mockedGetSettings = vi.mocked(getSettings)
const mockedUpdate = vi.mocked(updateJob)
const mockedScore = vi.mocked(scoreJobFit)
const mockedEnqueue = vi.mocked(enqueue)
const mockedListDocuments = vi.mocked(listDocuments)
const mockedGetQueue = vi.mocked(getAIQueue)
const mockedUpdateAIQueueItem = vi.mocked(updateAIQueueItem)

const fakeJob = {
  id: 7,
  title: 'Senior Engineer',
  company: 'Acme',
  description: 'JD',
  requirements: null,
  location: 'Remote',
  score: null,
  fit_score_version: null,
  fit_source: null,
  fit_rationale: null,
  fit_breakdown: null,
  fit_last_error: null,
  match_grade: null
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scoreOneJobInBackground no-CV path (regression: no 0.31 fallback)', () => {
  it('leaves score null and stamps fit_score_version + explanation', async () => {
    mockedGetJob.mockReturnValue(fakeJob)
    mockedGetSettings.mockReturnValue({ base_cv: '', cv_version: 4 } as any)
    const updated = {
      ...fakeJob,
      fit_score_version: 4,
      fit_source: 'heuristic',
      fit_rationale: 'No base CV configured.',
      fit_last_error: 'No base CV configured.'
    }
    mockedUpdate.mockReturnValue(updated as any)

    const result = await scoreOneJobInBackground(7)

    // scoreJobFit must NOT be called — no CV means no LLM scoring run.
    expect(mockedScore).not.toHaveBeenCalled()
    // updateJob gets called with the no-CV fields and never with a
    // fabricated 0.31 score.
    expect(mockedUpdate).toHaveBeenCalledWith(7, {
      fit_rationale: 'No base CV configured.',
      fit_breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
      fit_score_version: 4,
      fit_source: 'heuristic',
      fit_last_error: 'No base CV configured.'
    })
    const calledWith = mockedUpdate.mock.calls[0][1] as Record<string, unknown>
    expect(calledWith).not.toHaveProperty('score')
    expect(result).toBe(updated)
  })

  it('returns null silently when the job was deleted before scoring started', async () => {
    mockedGetJob.mockReturnValue(undefined)
    const result = await scoreOneJobInBackground(7)
    expect(result).toBeNull()
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedScore).not.toHaveBeenCalled()
  })
})

describe('scoreOneJobInBackground LLM-success path', () => {
  it('persists the LLM score with fit_source=llm when scoreJobFit returns llm', async () => {
    mockedGetJob.mockReturnValue(fakeJob)
    mockedGetSettings.mockReturnValue({ base_cv: 'a CV', cv_version: 4 } as any)
    mockedScore.mockResolvedValue({
      score: 0.8,
      rationale: 'Strong match.',
      breakdown: { matched_skills: ['typescript'], missing_skills: [], experience_years_match: true },
      source: 'llm'
    } as any)
    const updated = { ...fakeJob, score: 0.8, fit_source: 'llm', fit_score_version: 4 }
    mockedUpdate.mockReturnValue(updated as any)

    const result = await scoreOneJobInBackground(7)

    expect(mockedUpdate).toHaveBeenCalledWith(7, {
      score: 0.8,
      fit_rationale: 'Strong match.',
      fit_breakdown: { matched_skills: ['typescript'], missing_skills: [], experience_years_match: true },
      fit_score_version: 4,
      fit_source: 'llm',
      fit_last_error: null
    })
    expect(result).toBe(updated)
  })
})

describe('scoreOneJobInBackground heuristic-fallback path', () => {
  it('keeps score null and stamps fit_last_error + fit_source=heuristic', async () => {
    const initialRow = { ...fakeJob, score: null }
    mockedGetJob.mockReturnValue(initialRow as any)
    mockedGetSettings.mockReturnValue({ base_cv: 'a CV', cv_version: 4 } as any)
    mockedScore.mockResolvedValue({
      score: 0,
      rationale: 'Heuristic fallback',
      breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
      source: 'heuristic',
      error: 'All models rate-limited'
    } as any)
    const updated = {
      ...fakeJob,
      fit_last_error: 'All models rate-limited',
      fit_source: 'heuristic'
    }
    mockedUpdate.mockReturnValue(updated as any)

    const result = await scoreOneJobInBackground(7)

    expect(mockedUpdate).toHaveBeenCalledWith(7, {
      fit_last_error: 'All models rate-limited',
      fit_source: 'heuristic'
    })
    // The heuristic-fallback update deliberately omits score — the
    // caller's intent is "we didn't compute a real Fit", so the row
    // keeps score=null until a real LLM run lands.
    const calledWith = mockedUpdate.mock.calls[0][1] as Record<string, unknown>
    expect(calledWith).not.toHaveProperty('score')
    expect(result).toBe(updated)
  })
})

// The scan used to persist below-floor listings with score=null and this
// exact rationale, and report them as added. Those rows are still in
// users' stores, and the per-job "Recompute Fit" button has to keep
// working on them — the scan now filters such listings out instead of
// storing them, but it must not leave the already-stored ones
// unrecomputable (e.g. by attaching a status or a version stamp that
// blocks a manual re-score).
describe('scoreOneJobInBackground on a legacy pre-filtered row', () => {
  it('recomputes a stored below-floor job (the Recompute Fit path)', async () => {
    const legacyRow = {
      ...fakeJob,
      score: null,
      fit_source: 'heuristic',
      fit_rationale: 'Pre-filtered by heuristic (low keyword overlap)',
      fit_breakdown: null,
      fit_score_version: null,
      fit_last_error: null
    }
    mockedGetJob.mockReturnValue(legacyRow as any)
    mockedGetSettings.mockReturnValue({ base_cv: 'a CV', cv_version: 4 } as any)
    mockedScore.mockResolvedValue({
      score: 0.71,
      rationale: 'Recomputed against the current CV.',
      breakdown: { matched_skills: ['python'], missing_skills: [], experience_years_match: true },
      source: 'llm'
    } as any)
    mockedUpdate.mockReturnValue({ ...legacyRow, score: 0.71, fit_source: 'llm' } as any)

    const result = await scoreOneJobInBackground(7)

    expect(mockedScore).toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(7, {
      score: 0.71,
      fit_rationale: 'Recomputed against the current CV.',
      fit_breakdown: { matched_skills: ['python'], missing_skills: [], experience_years_match: true },
      fit_score_version: 4,
      fit_source: 'llm',
      fit_last_error: null
    })
    expect((result as { score: number | null }).score).toBe(0.71)
  })
})

// P1.7 §1 — auto-queue trigger. When a job's fit lands at or above
// the new `auto_doc_min_fit` setting (default 40), generation is
// auto-enqueued for that job. Skipped when docs already exist with a
// passing review (>= 80) and skipped below the threshold.
describe('P1.7 maybeAutoEnqueueDocs (fit >= auto_doc_min_fit -> enqueue generation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // mockReset, not clearAllMocks: `enqueue`'s return value now decides
    // this function's answer, so a return value set by one test must not
    // answer the next one. Back to the module default (a queued row).
    mockedEnqueue.mockReset()
    mockedListDocuments.mockReturnValue([])
    mockedGetQueue.mockReturnValue([])
  })

  // The trigger queues the MISSING UNITS — `generate_cv` and/or
  // `generate_cover_letter`, one row each — and never the both-documents
  // `tailor_job_docs` row. That unit cannot honour one toggle without doing
  // the other, and on the other producer's ordering it regenerated a CV
  // the sweep had deliberately left alone.
  const queuedTypes = (): string[] => mockedEnqueue.mock.calls.map((c) => (c[0] as { type: string }).type)

  it('enqueues generation when the fit score clears the threshold', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.85 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
      { type: 'generate_cv', jobId: 7 },
      { type: 'generate_cover_letter', jobId: 7 }
    ])
    expect(queuedTypes()).not.toContain('tailor_job_docs')
  })

  it('enqueues at exactly the threshold boundary (fit 40 with auto_doc_min_fit 40)', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.40 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue).toHaveBeenCalled()
  })

  it('does not enqueue below the threshold', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.39 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('does not enqueue when the fit score is null (nothing was computed)', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: null } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('skips when docs already exist with a passing review (>= 80)', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedListDocuments.mockReturnValue([
      { id: 1, job_id: 7, type: 'cv', verification_score: 92 },
      { id: 2, job_id: 7, type: 'cover_letter', verification_score: 85 }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('queues only the MISSING unit when the other document already exists', () => {
    // THE defect this trigger had. It asked "is this job's document work
    // in flight?" and answered it per DOCUMENT TYPE on one side and for
    // the both-documents unit on the other, so the two producers disagreed:
    // the sweep left the existing CV alone and queued only the cover
    // letter, and the trigger queued a row that regenerated the CV.
    // Now it asks `docTypeMissing`, so the CV is not even considered.
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedListDocuments.mockReturnValue([
      { id: 1, job_id: 7, type: 'cv', is_base: 0, verification_score: null }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
      { type: 'generate_cover_letter', jobId: 7 }
    ])
  })

  it('still enqueues when an existing doc review is below the passing bar', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedListDocuments.mockReturnValue([
      { id: 1, job_id: 7, type: 'cv', is_base: 0, verification_score: 55 }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    // The CV exists but scored below the bar, so it is not "missing" —
    // only the cover letter is. Regenerating the CV is the sweep's job
    // (`autoDocQueueEligible`'s "not already shippable" condition), and
    // asking for it here too is how the two producers collided.
    expect(queuedTypes()).toEqual(['generate_cover_letter'])
  })

  it("the user's MASTER CV does not count as this job's generated CV", () => {
    // `listDocuments` unions the base CV in for display. Treating it as
    // this job's CV would make every job in the store look complete.
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedListDocuments.mockReturnValue([
      { id: 1, job_id: null, type: 'cv', is_base: 1, verification_score: null }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(queuedTypes()).toEqual(['generate_cv', 'generate_cover_letter'])
  })

  it('does not stack duplicates when a generation item is already queued', () => {
    // Duplicate suppression for the unit rows is `enqueue`'s guard, not a
    // second copy of the rule here: enqueue returns null when an identical
    // item is already pending OR processing, and the return value has to
    // follow it — otherwise this function reports work it did not do.
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedEnqueue.mockReturnValue(null as unknown as AIQueueItem)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    // It asked enqueue, rather than checking the queue itself first.
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'generate_cv', jobId: 7 })
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'generate_cover_letter', jobId: 7 })
    // ...and the one queue read it does make is the shared
    // cross-producer check (`jobDocWorkInFlight`), not a private scan for
    // row types. Exactly one read: a second would be the second copy of
    // the same rule.
    expect(mockedGetQueue).toHaveBeenCalledTimes(1)
  })

  // The direction the backlog sweep could see and this one could not: the
  // sweep queues `generate_cv` / `generate_cover_letter`, which `enqueue`'s
  // guard cannot match against a `tailor_job_docs` row, so the trigger used
  // to queue its own row on top and the job ended up with three CVs.
  describe('the document backlog sweep already queued this job', () => {
    const liveRow = (over: Partial<AIQueueItem> = {}): AIQueueItem =>
      ({ id: 1, type: 'generate_cv', jobId: 7, status: 'pending', ...over }) as AIQueueItem

    beforeEach(() => {
      mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
      mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
      mockedEnqueue.mockReturnValue({ id: 99 } as unknown as AIQueueItem)
    })

    it('declines the CV unit when a generate_cv row is pending, and still queues the cover letter', () => {
      mockedGetQueue.mockReturnValue([liveRow()])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
        { type: 'generate_cover_letter', jobId: 7 }
      ])
    })

    it('declines the CV unit when a generate_cv row is processing', () => {
      mockedGetQueue.mockReturnValue([liveRow({ status: 'processing' })])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).not.toContain('generate_cv')
    })

    it('declines the cover-letter unit when its row is pending', () => {
      mockedGetQueue.mockReturnValue([liveRow({ type: 'generate_cover_letter' })])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
        { type: 'generate_cv', jobId: 7 }
      ])
    })

    it('declines when a tailor_job_docs row is pending (before enqueue is asked)', () => {
      // It produces both documents, so it covers both units.
      mockedGetQueue.mockReturnValue([liveRow({ type: 'tailor_job_docs' })])
      expect(maybeAutoEnqueueDocs(7)).toBe(false)
      expect(mockedEnqueue).not.toHaveBeenCalled()
    })

    it('ignores another job\'s rows', () => {
      mockedGetQueue.mockReturnValue([liveRow({ jobId: 8 })])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).toEqual(['generate_cv', 'generate_cover_letter'])
    })

    it('does not treat a regeneration row as coverage of a first generation', () => {
      // A `generate_cv` carrying a documentId is the review -> regenerate
      // loop replacing a document that exists; it produces no first
      // generation, so it must not suppress this job's CV.
      mockedGetQueue.mockReturnValue([liveRow({ documentId: 42 })])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).toEqual(['generate_cv', 'generate_cover_letter'])
    })

    it('does not treat a failed row as in flight', () => {
      // It is not in flight, so this unit's work still needs doing — and
      // the dead row is the trigger's to resurrect, charged to the budget.
      mockedGetQueue.mockReturnValue([liveRow({ status: 'failed', nextRetryAt: 0 })])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).toEqual(['generate_cover_letter'])
      expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(1, expect.objectContaining({
        status: 'pending',
        autoRevives: 1
      }))
    })

    it('does not resurrect a failed row whose revive budget is spent', () => {
      // The bound. A trigger that lands on every score change must not be
      // able to buy a generation per landing.
      mockedGetQueue.mockReturnValue([
        liveRow({ status: 'failed', autoRevives: AUTO_REVIVE_MAX, nextRetryAt: 0 })
      ])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).toEqual(['generate_cover_letter'])
      expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
    })

    it('does not pull a failed row forward before its cooldown has elapsed', () => {
      mockedGetQueue.mockReturnValue([
        liveRow({ status: 'failed', autoRevives: 0, nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS })
      ])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(queuedTypes()).toEqual(['generate_cover_letter'])
      expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
    })

    it('still checks the toggles before the queue: cover letters off declines the cover letter', () => {
      mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40, auto_queue_cover_letter: false } as any)
      mockedGetQueue.mockReturnValue([liveRow()])
      // The CV has its own live row, so the trigger declines the CV, and
      // the cover letter is switched off, so the trigger declines that too:
      // a deferral can never be read as "something else will finish this
      // job" when the only other producer has the same toggle.
      expect(maybeAutoEnqueueDocs(7)).toBe(false)
      expect(mockedEnqueue).not.toHaveBeenCalled()
    })

    it('CV auto-queueing off: the cover letter is still queued, the CV is not', () => {
      // The per-unit shape the both-documents row could not express.
      mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40, auto_queue_cv: false } as any)
      mockedGetQueue.mockReturnValue([])
      expect(maybeAutoEnqueueDocs(7)).toBe(true)
      expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
        { type: 'generate_cover_letter', jobId: 7 }
      ])
    })
  })

  it('reports the work as done when the enqueue actually queued a row', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedEnqueue.mockReturnValue({ id: 1 } as unknown as AIQueueItem)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
  })

  it('falls back to the default threshold (40) when the setting is absent', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.55 } as any)
    mockedGetSettings.mockReturnValue({} as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue).toHaveBeenCalled()
  })

  it('does not enqueue for a job that no longer exists', () => {
    mockedGetJob.mockReturnValue(undefined)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('is triggered automatically when a real LLM score lands at or above the threshold', async () => {
    // End-to-end through scoreOneJobInBackground: the trigger fires
    // from the shared scoring entry point, so every fit-landing path
    // (manual recompute, queue score_fit, create, import) gets it.
    // The persisted row is re-read (production updateJob writes
    // through, so the second getJob returns the new score).
    mockedGetJob.mockReturnValue({ ...fakeJob, score: null } as any)
    mockedGetSettings.mockReturnValue({ base_cv: 'a CV', cv_version: 4, auto_doc_min_fit: 40 } as any)
    mockedScore.mockResolvedValue({
      score: 0.92,
      rationale: 'Excellent match.',
      breakdown: { matched_skills: ['python'], missing_skills: [], experience_years_match: true },
      source: 'llm'
    } as any)
    mockedUpdate.mockImplementation((_id: number, fields: any) =>
      ({ ...fakeJob, ...fields }) as any
    )
    // After the update, getJob reflects the persisted score.
    mockedUpdate.mockImplementation((_id: number, fields: any) => {
      mockedGetJob.mockReturnValue({ ...fakeJob, ...fields } as any)
      return { ...fakeJob, ...fields } as any
    })
    await scoreOneJobInBackground(7)
    expect(mockedEnqueue.mock.calls.map((c) => c[0])).toEqual([
      { type: 'generate_cv', jobId: 7 },
      { type: 'generate_cover_letter', jobId: 7 }
    ])
  })

  it('does not trigger when the landed score is below the threshold', async () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: null } as any)
    mockedGetSettings.mockReturnValue({ base_cv: 'a CV', cv_version: 4, auto_doc_min_fit: 40 } as any)
    mockedScore.mockResolvedValue({
      score: 0.2,
      rationale: 'Weak match.',
      breakdown: { matched_skills: [], missing_skills: [], experience_years_match: false },
      source: 'llm'
    } as any)
    mockedUpdate.mockImplementation((_id: number, fields: any) => {
      mockedGetJob.mockReturnValue({ ...fakeJob, ...fields } as any)
      return { ...fakeJob, ...fields } as any
    })
    await scoreOneJobInBackground(7)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// `hasCurrentFitVerdict` — the question the queue's `score_fit` case asks
// before it retires a row.
//
// It is asked of THREE fields rather than of `score`, and every row of this
// table is a state the store can be in. `score` alone is the bug: it is a
// property of the JOB, so a job scored once carries it through every later
// pass, including the ones that produced nothing.
// ---------------------------------------------------------------------------

describe('hasCurrentFitVerdict', () => {
  // Typed rather than `as any`: every row below is a state the store can be in,
  // and the shape of a Job is what makes that claim checkable.
  const job = (over: Partial<Job>): Job => ({ ...fakeJob, ...over }) as Job

  it('is true only for an LLM verdict computed against the CV in force', () => {
    expect(
      hasCurrentFitVerdict(job({ score: 0.82, fit_source: 'llm', fit_score_version: 4 }), 4)
    ).toBe(true)
  })

  it('is false for a heuristic fallback, even when a score is already on the row', () => {
    // THE CASE. `scoreJobFit` answers a genuine 429 with its heuristic
    // fallback on purpose, and `scoreOneJobInBackground` records it as
    // `fit_source: 'heuristic'`; the score left on the row belongs to an
    // EARLIER pass. Reading the number instead of the source is what let
    // the queue delete the row as though this pass had scored the job.
    expect(
      hasCurrentFitVerdict(job({ score: 0.82, fit_source: 'heuristic', fit_score_version: 4 }), 4)
    ).toBe(false)
  })

  it('is false for a verdict earned against a CV the user has since replaced', () => {
    expect(
      hasCurrentFitVerdict(job({ score: 0.82, fit_source: 'llm', fit_score_version: 3 }), 4)
    ).toBe(false)
  })

  it('is false with no score at all, whatever the source says', () => {
    // Neither of the other two fields is trusted on its own: the no-base-CV
    // path stamps a version without a number.
    expect(hasCurrentFitVerdict(job({ score: null, fit_source: 'llm', fit_score_version: 4 }), 4)).toBe(
      false
    )
  })

  it('is false for a never-scored row', () => {
    expect(hasCurrentFitVerdict(job({ score: null, fit_source: null, fit_score_version: null }), 4)).toBe(
      false
    )
  })
})
