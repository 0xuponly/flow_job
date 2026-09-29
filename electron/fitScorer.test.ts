import { describe, it, expect, vi, beforeEach } from 'vitest'

// fitScorer.ts only depends on ./database, ./ai, and electron's
// BrowserWindow. Stub them out so the test runs without booting a
// real Electron app or hitting the network.
vi.mock('./database', () => ({
  getJob: vi.fn(),
  getSettings: vi.fn(),
  updateJob: vi.fn(),
  listDocuments: vi.fn(() => []),
  getAIQueue: vi.fn(() => [])
}))

vi.mock('./aiQueue', () => ({
  enqueue: vi.fn()
}))

vi.mock('./ai', () => ({
  scoreJobFit: vi.fn()
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

import { getJob, getSettings, updateJob, listDocuments, getAIQueue } from './database'
import { scoreJobFit } from './ai'
import { enqueue } from './aiQueue'
import { scoreOneJobInBackground, maybeAutoEnqueueDocs } from './fitScorer'

const mockedGetJob = vi.mocked(getJob)
const mockedGetSettings = vi.mocked(getSettings)
const mockedUpdate = vi.mocked(updateJob)
const mockedScore = vi.mocked(scoreJobFit)
const mockedEnqueue = vi.mocked(enqueue)
const mockedListDocuments = vi.mocked(listDocuments)
const mockedGetQueue = vi.mocked(getAIQueue)

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

// P1.7 §1 — auto-queue trigger. When a job's fit lands at or above
// the new `auto_doc_min_fit` setting (default 40), generation is
// auto-enqueued for that job. Skipped when docs already exist with a
// passing review (>= 80) and skipped below the threshold.
describe('P1.7 maybeAutoEnqueueDocs (fit >= auto_doc_min_fit -> enqueue generation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListDocuments.mockReturnValue([])
    mockedGetQueue.mockReturnValue([])
  })

  it('enqueues generation when the fit score clears the threshold', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.85 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'tailor_job_docs', jobId: 7 })
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

  it('still enqueues when an existing doc review is below the passing bar', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedListDocuments.mockReturnValue([
      { id: 1, job_id: 7, type: 'cv', verification_score: 55 }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(true)
    expect(mockedEnqueue).toHaveBeenCalled()
  })

  it('does not stack duplicates when a generation item is already pending', () => {
    mockedGetJob.mockReturnValue({ ...fakeJob, score: 0.9 } as any)
    mockedGetSettings.mockReturnValue({ auto_doc_min_fit: 40 } as any)
    mockedGetQueue.mockReturnValue([
      { id: 'q1', type: 'tailor_job_docs', jobId: 7, status: 'pending' }
    ] as any)
    expect(maybeAutoEnqueueDocs(7)).toBe(false)
    expect(mockedEnqueue).not.toHaveBeenCalled()
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
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'tailor_job_docs', jobId: 7 })
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