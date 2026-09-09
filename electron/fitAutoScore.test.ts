import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIQueueItem, Job, Settings } from './types'

vi.mock('./database', () => ({
  getSettings: vi.fn(),
  getAIQueue: vi.fn(),
  addAIQueueItem: vi.fn(),
  updateAIQueueItem: vi.fn(),
  listJobs: vi.fn()
}))

vi.mock('./utils', () => ({
  timerDeadlineMs: vi.fn((startedAt: number, delayMs: number) => startedAt + delayMs)
}))

import {
  scheduleNextFitAutoScore,
  restartFitAutoScoreTimer,
  cancelFitAutoScore,
  getFitAutoScoreState,
  runFitAutoScoreBacklog
} from './fitAutoScore'
import { getSettings, getAIQueue, addAIQueueItem, updateAIQueueItem, listJobs } from './database'

const mockedGetSettings = vi.mocked(getSettings)
const mockedGetAIQueue = vi.mocked(getAIQueue)
const mockedAddAIQueueItem = vi.mocked(addAIQueueItem)
const mockedUpdateAIQueueItem = vi.mocked(updateAIQueueItem)
const mockedListJobs = vi.mocked(listJobs)

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    openai_api_key: '', openai_base_url: '', openai_model: '', user_name: '',
    user_email: '', user_phone: '', user_country: '', base_cv: '',
    job_search_keywords: '', job_search_location: '', job_search_locations: '',
    deleted_jobs_cap: 50000, auto_scan_enabled: true, auto_scan_interval_minutes: 120,
    fit_autoscore_interval_minutes: 240, locations_normalized: '',
    locations_normalized_v2: '', locations_normalized_v3: '', locations_normalized_v4: '',
    locations_normalized_v5: '', locations_normalized_v6: '', employment_type_normalized: '',
    work_mode_normalized: '', backup_path: '', backup_last_success_at: '',
    backup_last_error: '', passphrase: '', adzuna_app_id: '', adzuna_app_key: '',
    aggregator_remotive_enabled: false, aggregator_arbeitnow_enabled: false,
    aggregator_jobicy_enabled: false, aggregator_himalayas_enabled: false,
    ats_boards: [], disabled_boards: [], auto_tailor_on_scan: false,
    auto_tailor_min_fit: 90, quick_apply_shortcut: null, statuses_recomputed: '',
    statuses_manual_v2: '', ...overrides
  }
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 1, title: 'Engineer', company: 'Acme', status: 'sourced', score: null,
    fit_breakdown: null, fit_score_version: null, fit_source: null,
    fit_last_error: null, fit_error_toasted: null, notes: null, date_posted: null,
    application_deadline: null, last_updated: null, created_at: '', updated_at: '',
    match_grade: null, tailor_ms_cv: null, tailor_ms_cl: null,
    tailor_generated_at: null, tailor_last_error: null, tailor_error_toasted: null,
    submitted_at: null, response_at: null, location: null, url: null,
    description: null, salary_range: null, requirements: null,
    application_requirements: null, hiring_manager: null, employment_type: null,
    work_mode: null, source: null, fit_rationale: null,
    ...overrides
  } as Job
}

function makeQueueItem(overrides: Partial<AIQueueItem>): AIQueueItem {
  return {
    id: 1, type: 'score_fit', jobId: 1, status: 'pending', attempts: 0,
    createdAt: Date.now(), nextRetryAt: Date.now(), ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mockedGetSettings.mockReturnValue(makeSettings())
  mockedGetAIQueue.mockReturnValue([])
  mockedListJobs.mockReturnValue([])
})

afterEach(() => {
  cancelFitAutoScore()
  vi.useRealTimers()
})

describe('scheduleNextFitAutoScore', () => {
  it('schedules a run using the configured interval', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: 60 }))
    scheduleNextFitAutoScore()
    const state = getFitAutoScoreState()
    expect(state.intervalMinutes).toBe(60)
    expect(state.nextRunAt).toBe(Date.now() + 60 * 60 * 1000)
  })

  it('defaults to 240 minutes when the setting is missing', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: undefined }))
    scheduleNextFitAutoScore()
    expect(getFitAutoScoreState().intervalMinutes).toBe(240)
    expect(getFitAutoScoreState().nextRunAt).toBe(Date.now() + 240 * 60 * 1000)
  })

  it('replaces the previous timer when called again', () => {
    scheduleNextFitAutoScore()
    const firstRunAt = getFitAutoScoreState().nextRunAt
    vi.advanceTimersByTime(1000)
    scheduleNextFitAutoScore()
    const secondRunAt = getFitAutoScoreState().nextRunAt
    expect(secondRunAt).toBeGreaterThan(firstRunAt as number)
  })

  it('restarts with the latest settings value', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: 120 }))
    restartFitAutoScoreTimer()
    expect(getFitAutoScoreState().intervalMinutes).toBe(120)
  })
})

describe('runFitAutoScoreBacklog', () => {
  it('enqueues score_fit for jobs with a null score and no live queue item', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1, score: null, fit_score_version: null })])
    mockedGetAIQueue.mockReturnValue([])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 1 })
  })

  it('skips jobs that already have a score', () => {
    mockedListJobs.mockReturnValue([
      makeJob({ id: 1, score: 0.85, fit_score_version: 3 }),
      makeJob({ id: 2, score: null, fit_score_version: null })
    ])
    mockedGetAIQueue.mockReturnValue([])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 2 })
  })

  it('skips jobs scored against the current CV version', () => {
    mockedListJobs.mockReturnValue([
      makeJob({ id: 1, score: null, fit_score_version: 0 }),
      makeJob({ id: 2, score: null, fit_score_version: null })
    ])
    mockedGetAIQueue.mockReturnValue([])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 2 })
  })

  it('does not duplicate enqueue when a pending score_fit item exists', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1, score: null, fit_score_version: null })])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ jobId: 1, status: 'pending' })])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })

  it('does not duplicate enqueue when a processing score_fit item exists', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1, score: null, fit_score_version: null })])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ jobId: 1, status: 'processing', attempts: 1 })])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })

  it('resets failed score_fit items so they are retried', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1, score: null, fit_score_version: null })])
    mockedGetAIQueue.mockReturnValue([makeQueueItem({ id: 99, jobId: 1, status: 'failed', attempts: 5, lastError: 'timeout' })])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(1)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(99, {
      status: 'pending',
      attempts: 0,
      nextRetryAt: Date.now(),
      lastError: undefined
    })
  })

  it('enqueues one item per eligible job and leaves unrelated queue items alone', () => {
    mockedListJobs.mockReturnValue([
      makeJob({ id: 1, score: null, fit_score_version: null }),
      makeJob({ id: 2, score: null, fit_score_version: null })
    ])
    mockedGetAIQueue.mockReturnValue([
      makeQueueItem({ id: 10, jobId: 1, type: 'generate_cv', status: 'pending' }),
      makeQueueItem({ id: 11, jobId: 2, status: 'failed', attempts: 5 })
    ])
    const count = runFitAutoScoreBacklog()
    expect(count).toBe(2)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 1 })
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'pending' }))
  })
})
