import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIQueueItem, Job, Settings } from './types'

vi.mock('./database', () => ({
  getSettings: vi.fn(),
  getAIQueue: vi.fn(),
  addAIQueueItem: vi.fn(),
  updateAIQueueItem: vi.fn(),
  listJobs: vi.fn(),
  isScoreFitSuppressed: vi.fn(() => false)
}))

// enqueueScoreFitBacklog (the startup / post-scan re-seeder) goes through
// the shared enqueue(), which is the dedupe-aware one; the real aiQueue is
// not under test here, so it is stubbed like ./database is.
vi.mock('./aiQueue', () => ({
  enqueue: vi.fn(() => ({ id: 1 }))
}))

vi.mock('./utils', () => ({
  timerDeadlineMs: vi.fn((startedAt: number, delayMs: number) => startedAt + delayMs)
}))

import {
  scheduleNextFitAutoScore,
  restartFitAutoScoreTimer,
  cancelFitAutoScore,
  getFitAutoScoreState,
  runFitAutoScoreBacklog,
  enqueueScoreFitBacklog
} from './fitAutoScore'
import { getSettings, getAIQueue, addAIQueueItem, updateAIQueueItem, listJobs, isScoreFitSuppressed } from './database'
import { enqueue } from './aiQueue'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'

const mockedGetSettings = vi.mocked(getSettings)
const mockedGetAIQueue = vi.mocked(getAIQueue)
const mockedAddAIQueueItem = vi.mocked(addAIQueueItem)
const mockedUpdateAIQueueItem = vi.mocked(updateAIQueueItem)
const mockedListJobs = vi.mocked(listJobs)
const mockedIsSuppressed = vi.mocked(isScoreFitSuppressed)
const mockedEnqueue = vi.mocked(enqueue)

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    openai_api_key: '', openai_base_url: '', openai_model: '', user_name: '',
    user_email: '', user_phone: '', user_country: '', base_cv: '',
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
    auto_tailor_min_fit: 90, quick_apply_shortcut: null, statuses_recomputed: '',
    statuses_manual_v2: '', queue_dedup_v1: '', queue_dedup_v2: '', queue_cleared_at: 0,
    queue_cleared_max_job_id: 0, ...overrides
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
  mockedIsSuppressed.mockReturnValue(false)
  mockedEnqueue.mockReturnValue({ id: 1 } as AIQueueItem)
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

  it('defaults to 60 minutes when the setting is missing', () => {
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: undefined }))
    scheduleNextFitAutoScore()
    expect(getFitAutoScoreState().intervalMinutes).toBe(60)
    expect(getFitAutoScoreState().nextRunAt).toBe(Date.now() + 60 * 60 * 1000)
  })

  it('defaults the interval constant to 60 minutes (hourly)', () => {
    // The constant itself, so "hourly" cannot silently regress back to
    // the old 4h default while every other test still passes against an
    // explicitly configured interval.
    mockedGetSettings.mockReturnValue(makeSettings({ fit_autoscore_interval_minutes: undefined }))
    expect(getFitAutoScoreState().intervalMinutes).toBe(60)
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
      autoRevives: 1,
      // Parked on the standard revive cooldown rather than run now, so
      // the backlog cannot hand out a free immediate retry.
      nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS,
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

// The duplicate bug lived at the boundary between this timer and the
// processor's `processing` window. These pin the half that lives here.
describe('runFitAutoScoreBacklog does not stack duplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListJobs.mockReturnValue([] as never)
  })

  it('skips a job whose score_fit item is processing', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })] as never)
    mockedGetAIQueue.mockReturnValue([
      { id: 1, type: 'score_fit', jobId: 1, status: 'processing', attempts: 1, createdAt: 1, nextRetryAt: 0, lastError: null }
    ] as never)
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('skips a job whose score_fit item is pending', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })] as never)
    mockedGetAIQueue.mockReturnValue([
      { id: 1, type: 'score_fit', jobId: 1, status: 'pending', attempts: 0, createdAt: 1, nextRetryAt: 0, lastError: null }
    ] as never)
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('treats ANY in-flight duplicate as in flight, not just the first', () => {
    // Two rows for one job where the first reads as exhausted. Judging
    // only the first resurrects it alongside the live one.
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })] as never)
    mockedGetAIQueue.mockReturnValue([
      { id: 1, type: 'score_fit', jobId: 1, status: 'failed', attempts: 5, createdAt: 1, nextRetryAt: 0, lastError: null },
      { id: 2, type: 'score_fit', jobId: 1, status: 'processing', attempts: 1, createdAt: 1, nextRetryAt: 0, lastError: null }
    ] as never)
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
  })

  it('still resurrects a single exhausted item', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })] as never)
    mockedGetAIQueue.mockReturnValue([
      { id: 1, type: 'score_fit', jobId: 1, status: 'failed', attempts: 5, createdAt: 1, nextRetryAt: 0, lastError: null }
    ] as never)
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'pending' }))
  })

  it('still queues a job with no queue row at all', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })] as never)
    mockedGetAIQueue.mockReturnValue([] as never)
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 1 })
  })
})

// The sweep timer used to be a free, unlimited, immediate retry lane for
// score_fit: it reset a burned-out row to `pending` with
// nextRetryAt = now and never touched `autoRevives`, so the 4h cooldown
// and AUTO_REVIVE_MAX budget that every other queue type honours (see
// electron/types.ts) simply did not apply here. A job whose provider
// rejected it forever would burn a full attempt budget every sweep, and the
// budget counter would never move. This is the same test with a real
// store: electron/queueClear.test.ts drives the durable-clear half.
describe('runFitAutoScoreBacklog respects the revive budget and cooldown', () => {
  const failedRow = (overrides: Partial<AIQueueItem>) => [
    makeQueueItem({ id: 1, jobId: 1, status: 'failed', attempts: 5, ...overrides })
  ]

  it('spends one unit of revive budget when it does resurrect', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(failedRow({ autoRevives: 1 }))
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ autoRevives: 2 })
    )
  })

  it('counts a legacy row with no counter as zero revives', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(failedRow({ autoRevives: undefined }))
    runFitAutoScoreBacklog()
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ autoRevives: 1 })
    )
  })

  it('leaves a failed item alone once the revive budget is spent', () => {
    // Same verdict runPass reaches: no more automatic retries, the task
    // is the user's now. Resurrecting it here is what made the budget
    // meaningless for score_fit.
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(failedRow({ autoRevives: AUTO_REVIVE_MAX }))
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })

  it('does not resurrect an item whose cooldown has not elapsed', () => {
    // runPass skips any row with a future nextRetryAt before it looks at
    // the status. The backlog has to apply the same guard, or a row
    // parked on a 4h revive cooldown gets pulled forward by the timer.
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(
      failedRow({ nextRetryAt: Date.now() + 60 * 60 * 1000 })
    )
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })

  it('parks the resurrected item on the full cooldown rather than running it now', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(failedRow({ nextRetryAt: Date.now() - 1 }))
    runFitAutoScoreBacklog()
    expect(mockedUpdateAIQueueItem).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS })
    )
  })

  it('leaves a pending item in flight alone regardless of its budget', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 1 })])
    mockedGetAIQueue.mockReturnValue(
      [makeQueueItem({ id: 1, jobId: 1, status: 'pending', autoRevives: AUTO_REVIVE_MAX })]
    )
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(mockedUpdateAIQueueItem).not.toHaveBeenCalled()
  })
})

// The clear is durable (see database.ts's isScoreFitSuppressed). Both
// re-seeders must honour it, or "Clear queue" rebuilds itself from the
// jobs table. Real-store coverage, including the restart, lives in
// electron/queueClear.test.ts.
describe('both re-seeders honour a cleared queue', () => {
  beforeEach(() => {
    mockedListJobs.mockReturnValue([
      makeJob({ id: 1, score: null, fit_score_version: null }),
      makeJob({ id: 2, score: null, fit_score_version: null })
    ])
  })

  it('the periodic backlog skips a suppressed job and still scores a new one', () => {
    mockedIsSuppressed.mockImplementation((id: number) => id === 1)
    expect(runFitAutoScoreBacklog()).toBe(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledTimes(1)
    expect(mockedAddAIQueueItem).toHaveBeenCalledWith({ type: 'score_fit', jobId: 2 })
  })

  it('the startup / post-scan path skips a suppressed job too', () => {
    mockedIsSuppressed.mockImplementation((id: number) => id === 1)
    expect(enqueueScoreFitBacklog()).toBe(1)
    expect(mockedEnqueue).toHaveBeenCalledTimes(1)
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'score_fit', jobId: 2 })
  })

  it('neither re-seeder touches a fully suppressed store', () => {
    mockedIsSuppressed.mockReturnValue(true)
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(mockedAddAIQueueItem).not.toHaveBeenCalled()
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })
})

describe('enqueueScoreFitBacklog', () => {
  it('queues a fit score for a job that has never been scored', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 7 })])
    expect(enqueueScoreFitBacklog()).toBe(1)
    expect(mockedEnqueue).toHaveBeenCalledWith({ type: 'score_fit', jobId: 7 })
  })

  it('skips a job that already has a real score', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 7, score: 0.5, fit_score_version: 0 })])
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('skips a job scored against the current CV version', () => {
    mockedListJobs.mockReturnValue([makeJob({ id: 7, fit_score_version: 0 })])
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(mockedEnqueue).not.toHaveBeenCalled()
  })

  it('does not count a job the dedupe-aware enqueue refused', () => {
    // enqueue() returns null when an identical item is already pending or
    // processing, so the count has to follow the enqueue and not the
    // predicate or the return value would report work that was not done.
    mockedListJobs.mockReturnValue([makeJob({ id: 7 }), makeJob({ id: 8 })])
    mockedEnqueue.mockReturnValueOnce(null as unknown as AIQueueItem)
    expect(enqueueScoreFitBacklog()).toBe(1)
  })
})
