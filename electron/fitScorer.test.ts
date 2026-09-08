import { describe, it, expect, vi, beforeEach } from 'vitest'

// fitScorer.ts only depends on ./database, ./ai, and electron's
// BrowserWindow. Stub them out so the test runs without booting a
// real Electron app or hitting the network.
vi.mock('./database', () => ({
  getJob: vi.fn(),
  getSettings: vi.fn(),
  updateJob: vi.fn()
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

import { getJob, getSettings, updateJob } from './database'
import { scoreJobFit } from './ai'
import { scoreOneJobInBackground } from './fitScorer'

const mockedGetJob = vi.mocked(getJob)
const mockedGetSettings = vi.mocked(getSettings)
const mockedUpdate = vi.mocked(updateJob)
const mockedScore = vi.mocked(scoreJobFit)

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