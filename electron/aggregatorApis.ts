// Public JSON APIs for the most common remote-first job boards.
// No auth, IP rate-limited. Each returns a flat array of jobs with
// `pub_date` we use as a freshness filter — only ingest items newer
// than the last call. The four sources overlap heavily (Remotive /
// Remote OK / We Work Remotely cover many of the same listings), so
// the atomic `createJob` race-guard in database.ts handles the
// dedup across sources. We don't try to dedup here.

import { getSettings } from './database'
import type { CreateJobInput } from './types'

interface FetchOpts {
  keywords: string
  location: string
  signal?: AbortSignal
}

function normalizeKeywords(k: string): string {
  // Most APIs use space-joined words; Remotive/Arbeitnow/Jobicy
  // treat it as a phrase search. Lowercase + collapse whitespace.
  return k.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Remotive: GET https://remotive.com/api/remote-jobs?search=…&limit=…
// Free, no auth, returns up to 100 jobs per call. `publication_date`
// is an ISO 8601 string.
export async function fetchRemotiveJobs({ keywords, signal }: FetchOpts): Promise<CreateJobInput[]> {
  const settings = getSettings()
  if (!settings.aggregator_remotive_enabled) return []
  const params = new URLSearchParams({ search: normalizeKeywords(keywords), limit: '50' })
  const url = `https://remotive.com/api/remote-jobs?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> }
  if (!payload.jobs) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobs) {
    const title = String(j.title || '').replace(/&nbsp;/g, ' ').trim()
    const company = String(j.company_name || '').trim()
    const desc = String(j.description || '').replace(/&nbsp;/g, ' ').trim()
    if (!title || !company || !desc) continue
    out.push({
      title,
      company,
      location: j.job_type ? String(j.job_type) : 'Remote',
      url: typeof j.url === 'string' ? j.url : null,
      description: desc,
      salary_range: typeof j.salary_range === 'string' ? j.salary_range : null,
      source: 'remotive',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: 'REMOTE',
      notes: null
    })
  }
  return out
}

// Arbeitnow: GET https://arbeitnow.com/api/job-board-api?page=1&search=…
// Returns `{ data: [...], meta: { total } }`. Each job has
// `company_name`, `title`, `description` (HTML), `url`, `created_at`.
export async function fetchArbeitnowJobs({ keywords, signal }: FetchOpts): Promise<CreateJobInput[]> {
  const settings = getSettings()
  if (!settings.aggregator_arbeitnow_enabled) return []
  const out: CreateJobInput[] = []
  // Walk a couple of pages; cap at 3 to stay polite.
  for (let page = 1; page <= 3; page++) {
    if (signal?.aborted) break
    const params = new URLSearchParams({ page: String(page), search: normalizeKeywords(keywords) })
    const url = `https://arbeitnow.com/api/job-board-api?${params.toString()}`
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) break
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> }
    if (!payload.data || payload.data.length === 0) break
    for (const j of payload.data) {
      const title = String(j.title || '').replace(/&nbsp;/g, ' ').trim()
      const company = String(j.company_name || '').trim()
      const desc = String(j.description || '').replace(/&nbsp;/g, ' ').trim()
      if (!title || !company || !desc) continue
      out.push({
        title,
        company,
        location: 'Remote',
        url: typeof j.url === 'string' ? j.url : null,
        description: desc,
        salary_range: null,
        source: 'arbeitnow',
        requirements: null,
        application_requirements: null,
        hiring_manager: null,
        employment_type: null,
        work_mode: 'REMOTE',
        notes: null
      })
    }
    if (payload.data.length < 50) break
  }
  return out
}

// Jobicy: GET https://jobicy.com/api/v2/remote-jobs?count=50&tag=…
// Returns `{ jobList: [...], jobCount }`. Each job has `companyName`,
// `jobTitle`, `jobExcerpt` (text), `url`, `pubDate`.
export async function fetchJobicyJobs({ keywords, signal }: FetchOpts): Promise<CreateJobInput[]> {
  const settings = getSettings()
  if (!settings.aggregator_jobicy_enabled) return []
  const params = new URLSearchParams({ count: '50', tag: normalizeKeywords(keywords) })
  const url = `https://jobicy.com/api/v2/remote-jobs?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobList?: Array<Record<string, unknown>> }
  if (!payload.jobList) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobList) {
    const title = String(j.jobTitle || '').replace(/&nbsp;/g, ' ').trim()
    const company = String(j.companyName || '').trim()
    // Jobicy only returns excerpts; the full description requires
    // following `url` and scraping the detail page. We skip in that
    // case — the createJob path requires a non-empty description.
    const desc = String(j.jobExcerpt || '').replace(/&nbsp;/g, ' ').trim()
    if (!title || !company || !desc) continue
    out.push({
      title,
      company,
      location: 'Remote',
      url: typeof j.url === 'string' ? j.url : null,
      description: desc,
      salary_range: null,
      source: 'jobicy',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: 'REMOTE',
      notes: null
    })
  }
  return out
}

// Himalayas: GET https://himalayas.app/jobs/api?limit=…&q=…
// Returns `{ jobs: [...] }`. Each job has `title`, `companyName`,
// `description` (text), `applicationLink`, `pubDate`.
export async function fetchHimalayasJobs({ keywords, signal }: FetchOpts): Promise<CreateJobInput[]> {
  const settings = getSettings()
  if (!settings.aggregator_himalayas_enabled) return []
  const params = new URLSearchParams({ limit: '50', q: normalizeKeywords(keywords) })
  const url = `https://himalayas.app/jobs/api?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> }
  if (!payload.jobs) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobs) {
    const title = String(j.title || '').replace(/&nbsp;/g, ' ').trim()
    const company = String(j.companyName || '').trim()
    const desc = String(j.description || '').replace(/&nbsp;/g, ' ').trim()
    if (!title || !company || !desc) continue
    out.push({
      title,
      company,
      location: 'Remote',
      url: typeof j.applicationLink === 'string' ? j.applicationLink : null,
      description: desc,
      salary_range: null,
      source: 'himalayas',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: 'REMOTE',
      notes: null
    })
  }
  return out
}

// RareRoles: GET https://api.rareroles.com/api/jobs?search=…&limit=…
// Public, no auth. Returns `{ jobs: [...] }` from an aggregated feed of
// ATS postings (Ashby, Greenhouse, etc.). Each job has `title`, `company`,
// `location`, `salary_min`, `salary_max`, `apply_url`, `posted_date`.
// No description is returned — we synthesise one from tags, department,
// industry, and experience_level for the fit scorer.
export async function fetchRareRolesJobs({ keywords, location, signal }: FetchOpts): Promise<CreateJobInput[]> {
  const params = new URLSearchParams({ search: normalizeKeywords(keywords), limit: '100' })
  const url = `https://api.rareroles.com/api/jobs?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> }
  if (!payload.jobs) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobs) {
    const title = String(j.title || '').trim()
    const company = String(j.company || '').trim()
    if (!title || !company) continue
    // Synthesise a description from available metadata so the fit
    // scorer has something to work with.
    const descParts: string[] = []
    const dept = String(j.department || '').trim()
    const industry = String(j.industry || '').trim()
    const exp = String(j.experience_level || '').trim()
    const tags = Array.isArray(j.tags) ? (j.tags as string[]).map(String) : []
    if (dept) descParts.push(`Department: ${dept}`)
    if (industry) descParts.push(`Industry: ${industry}`)
    if (exp) descParts.push(`Experience: ${exp}`)
    if (tags.length > 0) descParts.push(`Skills: ${tags.join(', ')}`)
    const description = descParts.join('\n')
    if (!description) continue

    // Normalise work_type to our enum
    const wt = String(j.work_type || '').trim().toLowerCase()
    let workMode: string | null = null
    if (wt === 'remote') workMode = 'REMOTE'
    else if (wt === 'hybrid') workMode = 'HYBRID'
    else if (wt === 'on-site') workMode = 'ON_SITE'

    // Normalise job_type to our employment type
    const jt = String(j.job_type || '').trim().toLowerCase()
    let empType: string | null = null
    if (jt.includes('full')) empType = 'FULL_TIME'
    else if (jt.includes('part')) empType = 'PART_TIME'
    else if (jt.includes('contract')) empType = 'CONTRACT'

    // Parse location: "Remote (City, State, Country)" or "City, State"
    const rawLocation = String(j.location || '').trim()
    const locationClean = rawLocation.replace(/^(Remote|On-site|Hybrid)\s*\(([^)]+)\)$/, '$2').trim() || rawLocation

    // Salary range: build from min/max numbers
    const sMin = typeof j.salary_min === 'number' ? j.salary_min : 0
    const sMax = typeof j.salary_max === 'number' ? j.salary_max : 0
    const salaryRange = sMin > 0 && sMax > 0
      ? `$${sMin.toLocaleString()}–$${sMax.toLocaleString()}`
      : null

    out.push({
      title,
      company,
      location: locationClean || null,
      url: typeof j.apply_url === 'string' ? j.apply_url : null,
      description,
      salary_range: salaryRange,
      source: 'RareRoles',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: empType,
      work_mode: workMode,
      notes: null
    })
  }
  return out
}
