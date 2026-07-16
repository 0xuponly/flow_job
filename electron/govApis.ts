// First-party APIs for government and public-sector job boards.
// Job Bank GC exposes a JSON search endpoint; WorkBC's search-side
// is the same endpoint the SPA hits (different from the per-job
// detail endpoint at tryWorkBcApi in jobScraper.ts).
//
// Vancouver Jobs (jobs.vancouver.ca) runs Neogov; we try the
// detail-page RSS first and fall back to the existing scraper in
// the boards list. Northern Health (NH) and Interior Health (IH)
// keep their existing scraper — no public API.

import type { CreateJobInput } from './types'

interface CommonOpts {
  signal?: AbortSignal
}

function clean(s: string | null | undefined): string {
  return (s || '').replace(/&nbsp;/g, ' ').trim()
}

function stripHtml(html: string): string {
  return clean(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// Job Bank GC: GET https://www.jobbank.gc.ca/jobsearch/search?querystring=…&locationstring=…
// Returns HTML today but also serves JSON via /jobsearch/_jsearchresults when
// the `ajax=1` query param is set. The HTML path is more reliable; we parse
// the embedded JSON-LD `JobPosting` blocks (already battle-tested in
// jobScraper.ts via collectJobPostings) by hitting the same page and walking
// the JSON-LD. Implemented as a simple HTML fetch + JSON-LD extraction.
export async function fetchJobBankJobs(keywords: string, location: string, opts: CommonOpts = {}): Promise<CreateJobInput[]> {
  const params = new URLSearchParams({ querystring: keywords })
  if (location) params.set('locationstring', location)
  const url = `https://www.jobbank.gc.ca/jobsearch/search?${params.toString()}`
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 flow_job/1.0' },
    signal: opts.signal
  })
  if (!response.ok) return []
  const html = await response.text()
  // Walk the page for `application/ld+json` blocks. Job Bank embeds one
  // `ItemList` per result page that contains `JobPosting` items.
  const blockRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  const out: CreateJobInput[] = []
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as Record<string, unknown>
      const graph = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]
      for (const node of graph) {
        if (!node || typeof node !== 'object') continue
        if ((node as Record<string, unknown>)['@type'] !== 'ItemList') continue
        const elements = (node as Record<string, unknown>).itemListElement
        if (!Array.isArray(elements)) continue
        for (const el of elements) {
          const item = (el as Record<string, unknown>).item as Record<string, unknown> | undefined
          if (!item || item['@type'] !== 'JobPosting') continue
          const title = clean(typeof item.title === 'string' ? item.title : null)
          const company = clean(typeof item.hiringOrganization?.name === 'string' ? item.hiringOrganization.name : null)
          const desc = stripHtml(typeof item.description === 'string' ? item.description : '')
          if (!title || !company || !desc) continue
          out.push({
            title,
            company,
            location: clean(typeof item.jobLocation?.address?.addressLocality === 'string' ? item.jobLocation.address.addressLocality : null) || null,
            url: typeof item.url === 'string' ? item.url : null,
            description: desc,
            salary_range: clean(typeof item.baseSalary?.value?.value === 'string' ? item.baseSalary.value.value : null) || null,
            source: 'jobbank',
            requirements: null,
            application_requirements: null,
            hiring_manager: null,
            employment_type: null,
            work_mode: null,
            notes: null
          })
        }
      }
    } catch {
      // Skip malformed JSON-LD
    }
  }
  return out
}

// WorkBC search-side: POST to the same API the Angular SPA calls
// from the listing page. Returns a JSON list of job summaries;
// for each, the per-job detail is fetched via the existing
// tryWorkBcApi in jobScraper.ts. We don't fan out detail fetches
// here (that would re-introduce the listing-scrape pattern); the
// scraper path picks up each `jobId` after this returns.
export async function fetchWorkBcSearchJobs(keywords: string, location: string, opts: CommonOpts = {}): Promise<{ jobId: string; title: string; company: string; url: string; location: string }[]> {
  const body = {
    SearchKeywords: keywords,
    PageNumber: 1,
    PageSize: 50,
    Location: location || '',
    SortOrder: 0
  }
  const url = `https://workbc-jb.a55eb5-prod.stratus.cloud.gov.bc.ca/api/Search/SearchJobs`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { result?: Array<Record<string, unknown>> }
  if (!Array.isArray(payload.result)) return []
  return payload.result.map((j) => ({
    jobId: String(j.JobId ?? ''),
    title: clean(typeof j.JobTitle === 'string' ? j.JobTitle : null),
    company: clean(typeof j.EmployerName === 'string' ? j.EmployerName : null),
    url: typeof j.JobId === 'string' || typeof j.JobId === 'number'
      ? `https://workbc-jb.a55eb5-prod.stratus.cloud.gov.bc.ca/api/Search/GetJobDetail?jobId=${encodeURIComponent(String(j.JobId))}`
      : '',
    location: clean(typeof j.CityName === 'string' ? j.CityName : null)
  })).filter((j) => j.jobId && j.title && j.company)
}
