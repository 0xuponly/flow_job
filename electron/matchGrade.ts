import type { Job, MatchFilters, MatchGrade } from './types'
import { normalizeSalary } from './utils'

export function matchGradeFor(fitScore: number | null): MatchGrade {
  if (fitScore == null) return null
  if (fitScore >= 0.7) return 'A'
  if (fitScore >= 0.45) return 'B'
  return 'C'
}

export function passesMatchFilters(job: Job, filters: MatchFilters): boolean {
  // min_salary: admit if missing signal
  if (filters.min_salary != null) {
    const low = parseSalaryLow(job.salary_range, job.description)
    if (low != null && low < filters.min_salary) return false
  }
  // min_years: admit if missing signal
  if (filters.min_years != null) {
    const years = parseYearsMin(job)
    if (years != null && years < filters.min_years) return false
  }
  return true
}

// Extract the annual LOW of a salary string by running it through the
// project-wide normalizer (electron/utils.ts) and pulling the first
// numeric token out of the result. The normalizer returns:
//   - "Up to $120,000"       -> "$120,000"  (single value = that's the low)
//   - "$80,000 - $100,000"   -> "$80,000 - $100,000"  (low, then high)
//   - null                   -> null (unparseable / missing)
//
// We then strip "$" and "," and parse as a number. Returning null lets
// the caller treat the job as "missing signal" and admit it.
function parseSalaryLow(salary: string | null, description: string | null): number | null {
  if (!salary) return null
  const normalized = normalizeSalary(salary, description)
  if (!normalized) return null
  const m = normalized.match(/-?\d[\d,]*(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseYearsMin(job: Job): number | null {
  const text = job.requirements ?? job.description ?? ''
  const m = text.match(/(\d+)\+?\s*years?/i)
  return m ? Number(m[1]) : null
}
