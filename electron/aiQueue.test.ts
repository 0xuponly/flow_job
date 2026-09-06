import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AIQueueItem, Job } from './types'

// The score_fit case lazy-imports ./main, so mock it before importing
// the module under test.
vi.mock('./main', () => ({
  scoreOneJobInBackground: vi.fn()
}))
// aiQueue pulls ./database for queue persistence; stub the surface the
// processor touches so tests run without a store.
vi.mock('./database', () => ({
  getAIQueue: vi.fn(() => []),
  updateAIQueueItem: vi.fn(),
  removeAIQueueItem: vi.fn(),
  addAIQueueItem: vi.fn(),
  getDocument: vi.fn()
}))

import { processQueue } from './aiQueue'
import { scoreOneJobInBackground } from './main'
import { getAIQueue, updateAIQueueItem, removeAIQueueItem } from './database'
import { RateLimitError } from './ai'

const mockedScore = vi.mocked(scoreOneJobInBackground)
const mockedGetQueue = vi.mocked(getAIQueue)
const mockedUpdate = vi.mocked(updateAIQueueItem)
const mockedRemove = vi.mocked(removeAIQueueItem)

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
    fit_breakdown: null, fit_score_version: null, fit_last_error: null,
    fit_error_toasted: null, notes: null, date_posted: null,
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
