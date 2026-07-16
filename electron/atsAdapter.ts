// First-party ATS (Applicant Tracking System) APIs. Each ATS exposes
// a public job-board endpoint that returns structured records
// without auth — the user just adds `{name, platform, token}` rows
// in Settings and we fan out to each one during a scan. Token is
// usually the company's slug on the ATS (e.g. "stripe" for
// boards.greenhouse.io/v1/boards/stripe/jobs).
//
// Each adapter takes the user's keywords/location and applies them
// to the platform's search semantics where possible:
//   - Greenhouse: ?query= for keyword
//   - Lever: ?q= for keyword
//   - Ashby: built-in filter via embedded query
//   - Workday: text= for keyword filter (workday's job list endpoint)
//   - SmartRecruiters: ?q= for keyword
//
// All return CreateJobInput[]; the work-type/location/score funnel
// in jobSearch.ts still applies.

import { getSettings } from './database'
import type { CreateJobInput } from './types'

interface CommonOpts {
  signal?: AbortSignal
}

function clean(s: string | null | undefined): string {
  return (s || '').replace(/&nbsp;/g, ' ').trim()
}

// Read a string field from a record-of-unknown. Returns undefined
// when the value is missing, null, or not a string. Avoids the
// `Property 'x' does not exist on type 'unknown'` errors we'd get
// from `j.x` directly.
function str(j: Record<string, unknown>, key: string): string | undefined {
  const v = j[key]
  return typeof v === 'string' ? v : undefined
}

// Same, but for a nested path. `nested(j, 'location', 'name')` reads
// `j.location.name` when both levels are objects.
function nested(j: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = j
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'string' ? cur : undefined
}

async function fetchGreenhouse(tenant: string, keywords: string, opts: CommonOpts): Promise<CreateJobInput[]> {
  const params = new URLSearchParams({ content: 'true' })
  if (keywords) params.set('query', keywords)
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}/jobs?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> }
  if (!payload.jobs) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobs) {
    const title = clean(str(j, 'title'))
    const company = clean(str(j, 'company_name')) || tenant
    // Greenhouse returns the body as HTML in `content`; strip tags
    // lightly so createJob's required `description` check passes.
    const raw = clean(str(j, 'content')).replace(/<[^>]+>/g, ' ')
    if (!title || !raw) continue
    out.push({
      title,
      company,
      location: clean(nested(j, 'location', 'name')),
      url: str(j, 'absolute_url') ?? null,
      description: raw,
      salary_range: null,
      source: 'greenhouse',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: null,
      notes: null
    })
  }
  return out
}

async function fetchLever(site: string, keywords: string, opts: CommonOpts): Promise<CreateJobInput[]> {
  const params = new URLSearchParams({ mode: 'json' })
  if (keywords) params.set('q', keywords)
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal })
  if (!response.ok) return []
  const payload = (await response.json()) as Array<Record<string, unknown>> | null
  if (!Array.isArray(payload)) return []
  const out: CreateJobInput[] = []
  for (const j of payload) {
    const title = clean(str(j, 'text'))
    const company = clean(nested(j, 'categories', 'team')) || site
    // Lever's `description` and `lists` are HTML; flatten to text.
    const listText = (() => {
      const lists = j.lists as { text?: unknown } | undefined
      if (!lists || !Array.isArray(lists.text)) return ''
      return (lists.text as unknown[]).filter((t): t is string => typeof t === 'string').join('\n')
    })()
    const html = [str(j, 'description') || '', listText, str(j, 'additional') || ''].join('\n')
    const raw = clean(html).replace(/<[^>]+>/g, ' ')
    if (!title || !raw) continue
    out.push({
      title,
      company,
      location: clean(nested(j, 'categories', 'location')),
      url: str(j, 'hostedUrl') ?? null,
      description: raw,
      salary_range: null,
      source: 'lever',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: null,
      notes: null
    })
  }
  return out
}

async function fetchAshby(board: string, keywords: string, opts: CommonOpts): Promise<CreateJobInput[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> }
  if (!payload.jobs) return []
  const needle = keywords.toLowerCase()
  const out: CreateJobInput[] = []
  for (const j of payload.jobs) {
    const title = clean(str(j, 'title'))
    const company = clean(str(j, 'companyName')) || board
    const raw = clean(str(j, 'descriptionHtml')).replace(/<[^>]+>/g, ' ')
    if (!title || !raw) continue
    // Ashby's endpoint has no query param; filter client-side.
    if (needle && !`${title} ${raw}`.toLowerCase().includes(needle)) continue
    out.push({
      title,
      company,
      location: clean(str(j, 'location')) || clean(str(j, 'locationName')),
      url: str(j, 'applyUrl') ?? null,
      description: raw,
      salary_range: null,
      source: 'ashby',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: null,
      notes: null
    })
  }
  return out
}

async function fetchSmartRecruiters(companyId: string, keywords: string, opts: CommonOpts): Promise<CreateJobInput[]> {
  const params = new URLSearchParams({ limit: '100' })
  if (keywords) params.set('q', keywords)
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings?${params.toString()}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { content?: Array<Record<string, unknown>> }
  if (!payload.content) return []
  const out: CreateJobInput[] = []
  for (const j of payload.content) {
    const title = clean(str(j, 'name'))
    const company = clean(nested(j, 'company', 'name')) || companyId
    const raw = clean(nested(j, 'jobAd', 'sections', 'companyDescription', 'text')).replace(/<[^>]+>/g, ' ')
    if (!title || !raw) continue
    const ref = str(j, 'ref')
    out.push({
      title,
      company,
      location: clean(nested(j, 'location', 'city')),
      url: ref ? `https://jobs.smartrecruiters.com/${companyId}/${ref}` : null,
      description: raw,
      salary_range: null,
      source: 'smartrecruiters',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: null,
      notes: null
    })
  }
  return out
}

// Workday uses a per-tenant URL shape; the token we accept is the
// full path: e.g. "wd10.myworkdayjobs.com/en-US/acme". We POST to
// the cxs jobs endpoint and walk the `jobPostings[]` list.
async function fetchWorkday(tenantPath: string, keywords: string, opts: CommonOpts): Promise<CreateJobInput[]> {
  const url = `https://${tenantPath.replace(/^\/+/, '')}/jobs`
  const body = {
    appliedFacets: {},
    searchText: keywords,
    limit: 20,
    offset: 0
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobPostings?: Array<Record<string, unknown>> }
  if (!payload.jobPostings) return []
  const out: CreateJobInput[] = []
  for (const j of payload.jobPostings) {
    const title = clean(str(j, 'title'))
    if (!title) continue
    const externalPath = str(j, 'externalPath')
    out.push({
      title,
      company: tenantPath.split('/').pop() || tenantPath,
      location: clean(str(j, 'locationsText')),
      url: externalPath ? `https://${tenantPath}${externalPath}` : null,
      // Workday's job list endpoint doesn't return full descriptions;
      // skip these for now and let the per-job endpoint handle the
      // detail page (added to BOARDS scrape path elsewhere).
      description: `${title} (Workday listing — see detail page for full description)`,
      salary_range: null,
      source: 'workday',
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: null,
      notes: null
    })
  }
  return out
}

// Fanned-out fetcher: pulls every enabled ATS board the user has
// configured in Settings. Concurrency is bounded by Promise.all
// (each board makes 1-3 requests in series; the boards run in
// parallel). Keywords/location passed to each platform.
export async function fetchAtsJobs(
  keywords: string,
  _location: string,
  signal?: AbortSignal
): Promise<CreateJobInput[]> {
  const settings = getSettings()
  const boards = (settings.ats_boards || []).filter((b) => b.enabled !== false && b.token)
  if (boards.length === 0) return []
  const results: CreateJobInput[] = []
  const perBoard = await Promise.all(
    boards.map(async (b) => {
      try {
        switch (b.platform) {
          case 'greenhouse': return await fetchGreenhouse(b.token, keywords, { signal })
          case 'lever': return await fetchLever(b.token, keywords, { signal })
          case 'ashby': return await fetchAshby(b.token, keywords, { signal })
          case 'workday': return await fetchWorkday(b.token, keywords, { signal })
          case 'smartrecruiters': return await fetchSmartRecruiters(b.token, keywords, { signal })
          default: return []
        }
      } catch {
        return []
      }
    })
  )
  for (const jobs of perBoard) results.push(...jobs)
  return results
}
