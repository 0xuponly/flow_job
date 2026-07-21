import { describe, it, expect } from 'vitest'
import { computeQueueFunnel } from './queueStats'
import type { Job } from './types'

const NOW = 1_700_000_000_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function job(overrides: Partial<Job>): Job {
  return {
    id: 1, title: '', company: '', status: 'sourced', score: null, fit_breakdown: null,
    fit_score_version: null, fit_last_error: null, fit_error_toasted: null, notes: null,
    date_posted: null, application_deadline: null, last_updated: null, created_at: '',
    updated_at: '', match_grade: null, tailor_ms_cv: null, tailor_ms_cl: null,
    tailor_generated_at: null, tailor_last_error: null, tailor_error_toasted: null,
    submitted_at: null, response_at: null,
    location: null, url: null, description: null, salary_range: null, requirements: null,
    application_requirements: null, hiring_manager: null, employment_type: null,
    work_mode: null, source: null, fit_rationale: null,
    ...overrides,
  }
}

describe('computeQueueFunnel', () => {
  it('returns zeros for empty input', () => {
    expect(computeQueueFunnel([], NOW)).toEqual({ added: 0, gradeA: 0, tailored: 0, submitted: 0, responded: 0 })
  })
  it('counts only jobs added within the last 7 days', () => {
    const recent = job({ id: 1, created_at: new Date(NOW - 1000).toISOString(), match_grade: 'A', score: 0.8, tailor_generated_at: NOW - 100 })
    const old = job({ id: 2, created_at: new Date(NOW - WEEK_MS - 1000).toISOString(), match_grade: 'A' })
    const stats = computeQueueFunnel([recent, old], NOW)
    expect(stats.added).toBe(1)
    expect(stats.gradeA).toBe(1)
    expect(stats.tailored).toBe(1)
  })
  it('counts submitted and responded independently', () => {
    // status: 'applied' puts this job outside the sourced cohort, so
    // it should not count toward added/gradeA/tailored — but it
    // still counts toward submitted (status-driven) and responded
    // (response_at-driven).
    const j = job({ id: 1, created_at: new Date(NOW - 1000).toISOString(), match_grade: 'A', tailor_generated_at: NOW - 100, status: 'applied', response_at: NOW - 10 })
    const stats = computeQueueFunnel([j], NOW)
    expect(stats.submitted).toBe(1)
    expect(stats.responded).toBe(1)
    expect(stats.added).toBe(0)
  })
  it('counts both S and A toward the gradeA bar (Grade ≥A semantics)', () => {
    const s = job({ id: 1, created_at: new Date(NOW - 1000).toISOString(), match_grade: 'S' })
    const a = job({ id: 2, created_at: new Date(NOW - 2000).toISOString(), match_grade: 'A' })
    const b = job({ id: 3, created_at: new Date(NOW - 3000).toISOString(), match_grade: 'B' })
    const stats = computeQueueFunnel([s, a, b], NOW)
    expect(stats.added).toBe(3)
    expect(stats.gradeA).toBe(2)
  })
})
