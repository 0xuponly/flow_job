import { describe, it, expect } from 'vitest'
import { matchGradeFor, passesMatchFilters } from './matchGrade'
import type { Job, MatchFilters } from './types'

describe('matchGradeFor', () => {
  it('returns null for null score', () => {
    expect(matchGradeFor(null)).toBeNull()
  })
  it('returns A for 0.7+', () => {
    expect(matchGradeFor(0.7)).toBe('A')
    expect(matchGradeFor(1.0)).toBe('A')
  })
  it('returns B for 0.45 to 0.6999', () => {
    expect(matchGradeFor(0.45)).toBe('B')
    expect(matchGradeFor(0.69)).toBe('B')
  })
  it('returns C for below 0.45', () => {
    expect(matchGradeFor(0.44)).toBe('C')
    expect(matchGradeFor(0.0)).toBe('C')
  })
})

describe('passesMatchFilters', () => {
  const filters: MatchFilters = { min_salary: 100000, min_years: 3 }
  const baseJob: Job = {
    id: 1, title: '', company: '', status: 'sourced', score: null, fit_breakdown: null,
    fit_score_version: null, fit_last_error: null, fit_error_toasted: null, notes: null,
    date_posted: null, application_deadline: null, last_updated: null, created_at: '',
    updated_at: '', match_grade: null, tailor_ms_cv: null, tailor_ms_cl: null,
    tailor_generated_at: null, tailor_last_error: null, tailor_error_toasted: null,
    submitted_at: null, response_at: null,
    // optional fields with safe defaults for the test
    location: null, url: null, description: null, salary_range: null, requirements: null,
    application_requirements: null, hiring_manager: null, employment_type: null,
    work_mode: null, source: null, fit_rationale: null,
  }

  it('admits a job with no parsed signals (missing = admit)', () => {
    expect(passesMatchFilters(baseJob, filters)).toBe(true)
  })

  it('admits a job whose salary is below min when the salary field is missing', () => {
    const j = { ...baseJob, description: 'Great role' }
    expect(passesMatchFilters(j, { min_salary: 200000, min_years: null })).toBe(true)
  })

  it('rejects a job whose parsed salary low is below the minimum', () => {
    const j = { ...baseJob, salary_range: '$50,000' }
    expect(passesMatchFilters(j, { min_salary: 100000, min_years: null })).toBe(false)
  })

  it('admits a job whose parsed salary meets the minimum', () => {
    const j = { ...baseJob, salary_range: '$120,000 - $140,000' }
    expect(passesMatchFilters(j, { min_salary: 100000, min_years: null })).toBe(true)
  })

  it('rejects a job whose parsed years is below the minimum', () => {
    const j = { ...baseJob, requirements: '2 years of experience required' }
    expect(passesMatchFilters(j, { min_salary: null, min_years: 5 })).toBe(false)
  })

  it('admits a job whose parsed years meets the minimum', () => {
    const j = { ...baseJob, requirements: '7+ years of experience required' }
    expect(passesMatchFilters(j, { min_salary: null, min_years: 5 })).toBe(true)
  })

  it('admits a job when no filters are set (null both)', () => {
    const j = { ...baseJob, salary_range: '$10', requirements: '0 years' }
    expect(passesMatchFilters(j, { min_salary: null, min_years: null })).toBe(true)
  })
})
