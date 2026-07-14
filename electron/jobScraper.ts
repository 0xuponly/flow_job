import type { CreateJobInput } from './types'
import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'
import { normalizeEmploymentType, normalizeWorkMode } from './employmentType'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Hosts that are reliably Cloudflare-blocked for our headless browser.
// For these, the browser fallback (which spins up a hidden BrowserWindow
// and waits up to 90s for the challenge to clear) is wasted effort — the
// challenge never clears for an automated UA. Skip the fallback and
// surface the "blocked" error in the same <5s window the plain fetch
// already used, instead of burning another ~70s before failing.
const CF_BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'indeed.com',
  'www.indeed.com'
])

interface ScrapedJob {
  title?: string
  company?: string
  location?: string
  description?: string
  salary_range?: string
  source?: string
  requirements?: string
  application_requirements?: string
  hiring_manager?: string
  employment_type?: string
  work_mode?: string
  date_posted?: string
}

export async function scrapeJobFromUrl(rawUrl: string, signal?: AbortSignal): Promise<CreateJobInput> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const url = normalizeUrl(rawUrl)
  const hostname = new URL(url).hostname.replace(/^www\./, '')
  const source = detectSource(hostname)

  // WorkBC's public site is an Angular 12 SPA whose <app-root> only
  // hydrates client-side, and the per-job URL is a hash fragment on
  // the search page (`/find-job/search-jobs#/job-details/{id}`). The
  // actual job data lives in a JSON API we can hit directly — much
  // faster and more reliable than driving the SPA router.
  if (hostname === 'www.workbc.ca' || hostname === 'workbc.ca') {
    const detailMatch = new URL(url).hash.match(/^#?\/?job-details\/(\d+)/)
    if (detailMatch) {
      const job = await tryWorkBcApi(detailMatch[1], signal)
      if (job) return job
      // Fall through to the HTML path if the API call fails (e.g. the
      // job was removed or the endpoint is down).
    }
  }

  // Workday (e.g. `ubc.wd10.myworkdayjobs.com/.../Job_Title_JR12345`) ships
  // the full job data in the static HTML as a `JobPosting` JSON-LD block.
  // The page is a React SPA shell that hydrates client-side, but we don't
  // need the rendered DOM — the server-side JSON-LD has title, company,
  // location, datePosted, employmentType, and the full description. The
  // generic `isChallengePage` heuristic false-positives on Workday's
  // `/cdn-cgi/challenge-platform/...` script-src boilerplate, so for these
  // hosts we skip the challenge-detection fallback and trust the static
  // HTML directly. The hostname match is intentionally broad to cover the
  // whole `*.myworkdayjobs.com` / `*.workday.com` family (UBC, Amazon,
  // Atlassian, etc. all use the same platform).
  if (hostname.endsWith('.myworkdayjobs.com') || hostname === 'myworkdayjobs.com' || hostname.endsWith('.workday.com') || hostname === 'workday.com') {
    const html = await fetchPageHtml(url, hostname, signal, { skipChallengeCheck: true })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const scraped = await extractFromHtml(html, hostname, url, source)
    return finalizeScrapedJob(scraped, url)
  }

  const html = await fetchPageHtml(url, hostname, signal)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const scraped = await extractFromHtml(html, hostname, url, source)

  return finalizeScrapedJob(scraped, url)
}

/**
 * Validate the extraction result and shape it into a CreateJobInput. Throws
 * the user-facing "Could not source X from this page" error if any required
 * field is missing. Shared between the standard path and the per-board
 * early-return paths (WorkBC, Workday) so they all surface the same error
 * shape and produce the same output record.
 */
function finalizeScrapedJob(scraped: ScrapedJob, url: string): CreateJobInput {
  const missing: string[] = []
  if (!scraped.title) missing.push('job title')
  if (!scraped.company) missing.push('company')
  if (!scraped.description) missing.push('description')

  if (missing.length > 0) {
    throw new Error(
      `Could not source ${formatList(missing)} from this page. No job was added. The site may require login, block automated access, or use a format we don't support yet.`
    )
  }

  return {
    title: scraped.title!,
    company: scraped.company!,
    location: scraped.location,
    url,
    description: cleanDescription(scraped.description!),
    salary_range: scraped.salary_range,
    source: scraped.source,
    requirements: scraped.requirements,
    application_requirements: scraped.application_requirements,
    hiring_manager: scraped.hiring_manager,
    employment_type: normalizeEmploymentType(scraped.employment_type) ?? undefined,
    work_mode: scraped.work_mode,
    date_posted: scraped.date_posted
  }
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Please enter a URL.')
  // Common paste artifacts: smart quotes, angle brackets, trailing
  // punctuation. URL parse these would reject them outright.
  const cleaned = trimmed
    .replace(/[\u2018\u2019\u201c\u201d]/g, '') // smart quotes
    .replace(/[<>]/g, '')                       // <...> wrappers
    .replace(/[)\]\s]+$/, '')                    // trailing )/]/whitespace
  const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error('Invalid URL. Paste a full link like https://linkedin.com/jobs/...')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https links are supported.')
  }
  return parsed.href
}

function detectSource(hostname: string): string | undefined {
  if (hostname.includes('linkedin.com')) return 'LinkedIn'
  if (hostname.includes('indeed.com')) return 'Indeed'
  if (hostname.includes('glassdoor.com')) return 'Glassdoor'
  if (hostname.includes('greenhouse.io')) return 'Greenhouse'
  if (hostname.includes('lever.co')) return 'Lever'
  if (hostname.includes('ashbyhq.com')) return 'Ashby'
  if (hostname.includes('workday.com') || hostname.includes('myworkdayjobs.com')) return 'Workday'
  if (hostname.includes('smartrecruiters.com')) return 'SmartRecruiters'
  if (hostname.includes('jobs.apple.com')) return 'Apple'
  if (hostname.includes('careers.google.com')) return 'Google Careers'
  if (hostname.includes('amazon.jobs')) return 'Amazon Jobs'
  if (hostname.includes('monster.com')) return 'Monster'
  if (hostname.includes('ziprecruiter.com')) return 'ZipRecruiter'
  if (hostname.includes('simplyhired.com')) return 'SimplyHired'
  if (hostname.includes('adzuna.com')) return 'Adzuna'
  if (hostname.includes('talent.com')) return 'Talent.com'
  if (hostname.includes('jora.com')) return 'Jora'
  if (hostname.includes('remoteok.com')) return 'Remote OK'
  if (hostname.includes('weworkremotely.com')) return 'We Work Remotely'
  if (hostname.includes('remotive.com')) return 'Remotive'
  if (hostname === 'remote.co') return 'Remote.co'
  if (hostname.includes('workingnomads.com')) return 'Working Nomads'
  if (hostname.includes('justremote.co')) return 'JustRemote'
  if (hostname.includes('wellfound.com') || hostname.includes('angel.co')) return 'Wellfound'
  if (hostname.includes('otta.com')) return 'Otta'
  if (hostname.includes('hired.com')) return 'Hired'
  if (hostname.includes('cryptocurrencyjobs.co')) return 'Cryptocurrency Jobs'
  if (hostname.includes('ambergroup.io')) return 'Amber Group'
  if (hostname.includes('cryptojobslist.com')) return 'CryptoJobsList'
  if (hostname.includes('cryptojobs.com')) return 'cryptojobs.com'
  if (hostname === 'crypto.jobs') return 'Crypto.jobs'
  if (hostname.includes('web3.career')) return 'Web3.career'
  if (hostname.includes('jobs.vancouver.ca')) return 'Vancouver Jobs'
  if (hostname.includes('jobbank.gc.ca')) return 'Job Bank (GC)'
  if (hostname.includes('eluta.ca')) return 'Eluta.ca'
  if (hostname.includes('workopolis.com')) return 'Workopolis'
  if (hostname.includes('jobboom.com')) return 'Jobboom'
  if (hostname.includes('workbc.ca')) return 'WorkBC'
  if (hostname.includes('careerbeacon.com')) return 'CareerBeacon'
  if (hostname.includes('charityvillage.com')) return 'CharityVillage'
  if (hostname.includes('crypto-careers.com')) return 'Crypto Careers'
  if (hostname.includes('cryptorecruit.com')) return 'Cryptorecruit'
  if (hostname === 'remote3.co') return 'Remote3'
  if (hostname.includes('startup.jobs')) return 'Startup.jobs'
  if (hostname.includes('selbyjennings.com')) return 'Selby Jennings'
  if (hostname.includes('idealist.org')) return 'Idealist'
  if (hostname.includes('builtin.com')) return 'Built In'
  if (hostname.includes('careerhound.io')) return 'CareerHound'
  if (hostname.includes('ultipro.com') || hostname.includes('ultipro.ca')) return 'UltiPro'
  if (hostname.includes('brainhunter.com')) return 'Brainhunter'
  if (hostname.includes('catsone.com')) return 'CATS One'
  return undefined
}

async function fetchPageHtml(
  url: string,
  hostname: string,
  signal?: AbortSignal,
  opts: { skipChallengeCheck?: boolean } = {}
): Promise<string> {
  // Plain `fetch` has no built-in timeout, and Indeed (and other
  // Cloudflare-fronted sites) sometimes establishes a connection
  // that never completes a response. Without this race, the user's
  // add-by-link modal sits on "Fetching..." indefinitely. 30s is
  // generous — a healthy Indeed page returns in 1-3s. If the
  // request hasn't completed by then, fall through to the browser
  // scraper, which has its own 90s timeout and proper challenge
  // detection.
  const fetchTimeoutMs = 30_000
  const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    redirect: 'follow',
    signal: combinedSignal
  })

  if (response.ok) {
    const html = await response.text()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (timeoutSignal.aborted) {
      // The request body was slow even though the headers arrived.
      // Treat the same as a timeout — fall through to the browser path.
      return fetchHtmlViaBrowser(url)
    }
    if (!opts.skipChallengeCheck && isChallengePage(html)) {
      if (CF_BLOCKED_HOSTS.has(hostname)) {
        throw new Error('This site blocked automated access (Cloudflare). Open the job in your browser and try again later.')
      }
      return fetchHtmlViaBrowser(url)
    }
    return html
  }

  // Cloudflare (and other WAFs) sometimes return 403 with a challenge-page
  // body instead of letting `isChallengePage` see the HTML. Read the body
  // and, if it looks like a challenge, retry through the browser. If it's
  // a genuine 403 (no challenge body), surface the original error.
  if (!opts.skipChallengeCheck) {
    const body = await response.text().catch(() => '')
    if (isChallengePage(body)) {
      if (CF_BLOCKED_HOSTS.has(hostname)) {
        throw new Error('This site blocked automated access (Cloudflare). Open the job in your browser and try again later.')
      }
      return fetchHtmlViaBrowser(url)
    }
  }

  throw new Error(`Could not fetch page (HTTP ${response.status}). The site may be blocking automated access.`)
}

function extractFromHtml(html: string, hostname: string, pageUrl: string, source?: string): Promise<ScrapedJob> {
  return extractFromHtmlImpl(html, hostname, pageUrl, source)
}

/**
 * WorkBC's job-board data lives behind a public JSON API that the
 * Angular SPA calls to render each detail panel. Hitting the API
 * directly avoids the hash-router dance and is both faster and more
 * reliable than parsing the search-results page.
 *
 * Endpoint: GET https://workbc-jb.a55eb5-prod.stratus.cloud.gov.bc.ca/
 *               api/Search/GetJobDetail?jobId={id}&language=en&isToggle=false
 *
 * Returns a fully-populated `CreateJobInput` (description synthesised
 * from the structured fields the API exposes) or `null` if the API
 * call fails — caller can then fall through to the HTML path.
 */
async function tryWorkBcApi(jobId: string, signal?: AbortSignal): Promise<CreateJobInput | null> {
  try {
    const apiUrl =
      `https://workbc-jb.a55eb5-prod.stratus.cloud.gov.bc.ca/api/Search/GetJobDetail` +
      `?jobId=${encodeURIComponent(jobId)}&language=en&isToggle=false`
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      result?: Array<Record<string, unknown>>
      count?: number
    }
    const job = payload.result?.[0]
    if (!job) return null

    const pickDescription = (v: string[] | undefined) => (Array.isArray(v) ? v.join('; ') : undefined)
    const hoursOfWork = pickDescription((job.HoursOfWork as { Description?: string[] } | undefined)?.Description)
    const periodOfEmployment = pickDescription((job.PeriodOfEmployment as { Description?: string[] } | undefined)?.Description)
    const employmentTerms = pickDescription((job.EmploymentTerms as { Description?: string[] } | undefined)?.Description)
    const workplaceType = pickDescription((job.WorkplaceType as { Description?: string[] } | undefined)?.Description)
    const workLangCd = pickDescription((job.WorkLangCd as { Description?: string[] } | undefined)?.Description)
    const salaryBenefits = pickDescription((job.SalaryConditions as { Description?: string[] } | undefined)?.Description)
    const region = Array.isArray(job.Region) ? (job.Region as string[]).join(', ') : undefined

    // Build a structured description from the SkillCategories array —
    // each category has a Name and a Skills list. This is the closest
    // thing the API gives us to a job description body.
    const skillCategories = Array.isArray(job.SkillCategories)
      ? (job.SkillCategories as Array<{ Category: { Name: string }; Skills: string[] }>)
      : []
    const descriptionParts: string[] = []
    if (typeof job.SalaryDescription === 'string' && job.SalaryDescription) {
      descriptionParts.push(`Salary: ${job.SalaryDescription}`)
    }
    if (typeof job.NocGroup === 'string' && job.NocGroup) {
      descriptionParts.push(`NOC: ${job.NocGroup}`)
    }
    for (const cat of skillCategories) {
      const name = cat.Category?.Name
      if (!name || !Array.isArray(cat.Skills) || cat.Skills.length === 0) continue
      descriptionParts.push(`${name}:\n- ${cat.Skills.join('\n- ')}`)
    }
    if (salaryBenefits) {
      descriptionParts.push(`Benefits: ${salaryBenefits}`)
    }
    if (typeof job.ApplyEmailAddress === 'string' && job.ApplyEmailAddress) {
      descriptionParts.push(`Apply by email: ${job.ApplyEmailAddress}`)
    }
    const description = descriptionParts.join('\n\n').trim()

    // Location: "City, Province, Region"
    const city = typeof job.City === 'string' ? job.City : ''
    const province = typeof job.Province === 'string' ? job.Province : ''
    const location = [city, province, region].filter(Boolean).join(', ')

    return {
      title: typeof job.Title === 'string' ? job.Title : '',
      company: typeof job.EmployerName === 'string' ? job.EmployerName : '',
      location: location || undefined,
      url: `https://www.workbc.ca/find-job/search-jobs#/job-details/${jobId}`,
      description,
      salary_range: typeof job.SalarySummary === 'string' ? job.SalarySummary : undefined,
      source: 'WorkBC',
      requirements: skillCategories
        .filter((c) => /Education|Credentials|Experience|Skills|Specific/i.test(c.Category?.Name || ''))
        .map((c) => `${c.Category.Name}:\n- ${c.Skills.join('\n- ')}`)
        .join('\n\n') || undefined,
      application_requirements: job.ApplyEmailAddress
        ? `Apply by email: ${job.ApplyEmailAddress}`
        : undefined,
      employment_type: normalizeEmploymentType([hoursOfWork, periodOfEmployment, employmentTerms].filter(Boolean).join(', ')) ?? undefined,
      work_mode: normalizeWorkMode(workplaceType) ?? undefined,
      date_posted: typeof job.DatePosted === 'string' ? job.DatePosted : undefined
    }
  } catch {
    return null
  }
}

async function extractFromHtmlImpl(html: string, hostname: string, pageUrl: string, source?: string): Promise<ScrapedJob> {
  const result: ScrapedJob = { source }

  const jobPosting = selectJobPosting(collectJobPostings(extractJsonLd(html)), html, pageUrl)
  if (jobPosting) {
    applyJobPosting(result, jobPosting)
  }


  if (hostname.includes('linkedin.com')) {
    applyLinkedIn(result, html)
    result.source = 'LinkedIn'
  } else if (hostname.includes('indeed.com')) {
    applyIndeed(result, html)
    result.source = 'Indeed'
  } else if (hostname.includes('greenhouse.io')) {
    applyGreenhouse(result, html)
    result.source = 'Greenhouse'
  } else if (hostname.includes('lever.co')) {
    applyLever(result, html)
    result.source = 'Lever'
  } else if (hostname.includes('glassdoor.com')) {
    applyGlassdoor(result, html)
    result.source = 'Glassdoor'
  } else if (hostname.includes('cryptocurrencyjobs.co')) {
    applyCryptocurrencyJobs(result, html)
    result.source = 'Cryptocurrency Jobs'
  } else if (hostname.includes('ambergroup.io')) {
    applyAmberGroup(result, html)
    result.source = 'Amber Group Careers'
  } else if (hostname.includes('cryptojobslist.com')) {
    applyCryptoJobsList(result, html)
    result.source = 'CryptoJobsList'
  } else if (hostname.includes('cryptojobs.com')) {
    applyCryptoJobsCom(result, html)
    result.source = 'cryptojobs.com'
  } else if (hostname === 'crypto.jobs') {
    applyCryptoJobs(result, html)
    result.source = 'Crypto.jobs'
  } else if (hostname.includes('web3.career')) {
    applyWeb3Career(result, html)
    result.source = 'Web3.career'
  } else if (hostname.includes('jobs.vancouver.ca')) {
    applyVancouverJobs(result, html)
    result.source = 'Vancouver Jobs'
  } else if (hostname.includes('monster.com')) {
    applyMonster(result, html)
    result.source = 'Monster'
  } else if (hostname.includes('ziprecruiter.com')) {
    applyZipRecruiter(result, html)
    result.source = 'ZipRecruiter'
  } else if (hostname.includes('remoteok.com')) {
    applyRemoteOk(result, html)
    result.source = 'Remote OK'
  } else if (hostname.includes('weworkremotely.com')) {
    applyWeWorkRemotely(result, html)
    result.source = 'We Work Remotely'
  } else if (hostname.includes('remotive.com')) {
    applyRemotive(result, html)
    result.source = 'Remotive'
  } else if (hostname.includes('simplyhired.com')) {
    applySimplyHired(result, html)
    result.source = 'SimplyHired'
  } else if (hostname.includes('adzuna.com')) {
    applyAdzuna(result, html)
    result.source = 'Adzuna'
  } else if (hostname.includes('talent.com')) {
    applyTalentCom(result, html)
    result.source = 'Talent.com'
  } else if (hostname.includes('jora.com')) {
    applyJora(result, html)
    result.source = 'Jora'
  } else if (hostname.includes('startup.jobs')) {
    applyStartupJobs(result, html)
    result.source = 'Startup.jobs'
  } else if (hostname.includes('builtin.com')) {
    applyBuiltIn(result, html)
    result.source = 'Built In'
  } else if (hostname.includes('idealist.org')) {
    applyIdealist(result, html)
    result.source = 'Idealist'
  } else if (hostname.includes('ultipro.com') || hostname.includes('ultipro.ca')) {
    applyUltiPro(result, html)
    result.source = 'UltiPro'
  } else if (hostname.includes('brainhunter.com')) {
    applyBrainhunter(result, html)
    result.source = 'Brainhunter'
  } else if (hostname.includes('catsone.com')) {
    applyCATSOne(result, html)
    result.source = 'CATS One'
  } else if (source) {
    result.source = source
  }

  // Generic fallback for unrecognized job sites — tries common patterns
  if (!result.title || !result.company || !result.description) {
    applyGeneric(result, html, pageUrl)
  }

  // Always run post-processing to extract salary + metadata from raw HTML
  extractSalaryAndMetadata(result, html)
  extractPostingDateFromHtml(result, html)

  // Vancouver Jobs: BC public-sector pay grades (Pay Grade RNG-, EXM-,
  // etc.) quote an hourly rate but suffix it with "per annum" —
  // government HR phrasing for "the annualized equivalent of the hourly
  // rate." If we left the literal "per annum" in the saved string,
  // normalizeSalary would detectPeriod='year' and store the hourly
  // rate as if it were annual ($60.26 - $75.32 instead of ~$120k).
  // Rewrite the period marker to "per hour" so annualization kicks in.
  // MUST run after extractSalaryAndMetadata (which sets salary_range)
  // and the description must be populated for the Pay Grade label
  // check. Other sources that say "per annum" without the Pay Grade
  // prefix are left alone.
  if (
    result.source === 'Vancouver Jobs' &&
    result.salary_range &&
    result.description &&
    /pay\s*grade\s+[A-Z]{2,4}-/i.test(result.description)
  ) {
    result.salary_range = result.salary_range
      .replace(/\s*per\s*annum\b/gi, ' per hour')
      .replace(/\s*annually\b/gi, ' per hour')
  }

  if (result.title) {
    result.title = cleanTitle(result.title, result.company, result.source)
  }

  return result
}

function collectJobPostings(nodes: unknown[]): Record<string, unknown>[] {
  const postings: Record<string, unknown>[] = []

  for (const node of nodes) {
    collectJobPostingsFromNode(node, postings)
  }

  return postings
}

function collectJobPostingsFromNode(node: unknown, postings: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>

  const type = obj['@type']
  const types = Array.isArray(type) ? type : type ? [type] : []
  if (types.some((t) => t === 'JobPosting' || (typeof t === 'string' && t.endsWith('JobPosting')))) {
    postings.push(obj)
  }

  if (Array.isArray(obj['@graph'])) {
    for (const child of obj['@graph'] as unknown[]) {
      collectJobPostingsFromNode(child, postings)
    }
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        collectJobPostingsFromNode(child, postings)
      }
    }
  }
}

function selectJobPosting(
  postings: Record<string, unknown>[],
  html: string,
  pageUrl: string
): Record<string, unknown> | null {
  if (postings.length === 0) return null
  if (postings.length === 1) return postings[0]

  const canonical = extractLinkRel(html, 'canonical')
  const targetUrl = canonical || pageUrl

  for (const posting of postings) {
    if (posting.url && urlsMatch(String(posting.url), targetUrl)) {
      return posting
    }
  }

  const ogTitle = extractMeta(html, 'og:title')
  if (ogTitle) {
    const parsed = parseAtCompanyTitle(ogTitle.replace(/^Web3\s+/i, ''))
    if (parsed.company) {
      const match = postings.find((posting) => {
        const org = posting.hiringOrganization as { name?: string } | string | undefined
        const name = typeof org === 'string' ? org : org?.name
        return name && String(name).toLowerCase() === parsed.company!.toLowerCase()
      })
      if (match) return match
    }
  }

  const complete = postings.filter(
    (posting) => posting.title && posting.description && posting.hiringOrganization
  )
  return complete[0] ?? postings[0]
}

function urlsMatch(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
  } catch {
    return a === b
  }
}

function extractLinkRel(html: string, rel: string): string | undefined {
  const match = html.match(
    new RegExp(`<link[^>]+rel=["']${escapeRegex(rel)}["'][^>]+href=["']([^"']+)["']`, 'i')
  )
  return match?.[1]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyJobPosting(result: ScrapedJob, jp: any): void {
  if (jp.title && !result.title) result.title = String(jp.title).trim()
  if (jp.description && !result.description) {
    const desc = typeof jp.description === 'string' ? stripHtml(jp.description) : String(jp.description)
    if (desc.trim()) result.description = desc.trim()
  }

  if (jp.hiringOrganization && !result.company) {
    const org = jp.hiringOrganization
    const name = typeof org === 'string' ? org : org.name || org.legalName
    if (name) result.company = String(name).trim()
  }

  if (jp.jobLocation && !result.location) {
    result.location = formatJobLocation(jp.jobLocation)
  }

  if (jp.baseSalary && !result.salary_range) {
    result.salary_range = formatSalary(jp.baseSalary)
  }

  if (jp.applicantLocationRequirements && !result.location) {
    const loc = jp.applicantLocationRequirements
    const name = typeof loc === 'string' ? loc : loc.name
    if (name) result.location = String(name).trim()
  }

  if (jp.employmentType && !result.employment_type) {
    const et = jp.employmentType
    const normalized = normalizeEmploymentType(Array.isArray(et) ? et[0] : et)
    if (normalized) result.employment_type = normalized
  }

  if (jp.jobLocationType && !result.work_mode) {
    const jlt = jp.jobLocationType
    const str = Array.isArray(jlt) ? jlt[0] : jlt
    if (typeof str === 'string') {
      const wm = normalizeWorkMode(str)
      if (wm) result.work_mode = wm
      else result.work_mode = str
    }
  }

  if (jp.qualifications && !result.requirements) {
    const q = jp.qualifications
    result.requirements = typeof q === 'string' ? stripHtml(q).trim() : undefined
  }

  if (jp.hiringManager?.name && !result.hiring_manager) {
    result.hiring_manager = jp.hiringManager.name
  }

  if (jp.datePosted && !result.date_posted) {
    result.date_posted = parsePostingDate(jp.datePosted) ?? undefined
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatJobLocation(loc: any): string | undefined {
  if (typeof loc === 'string') return loc.trim() || undefined
  if (Array.isArray(loc)) {
    const parts = loc.map(formatJobLocation).filter(Boolean)
    return parts.length ? parts.join('; ') : undefined
  }
  if (loc?.address) {
    const addr = loc.address
    if (typeof addr === 'string') return addr.trim() || undefined
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean)
    if (parts.length) return parts.join(', ')
  }
  if (loc?.name) return String(loc.name).trim() || undefined
  return undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSalary(salary: any): string | undefined {
  if (typeof salary === 'string') return salary.trim() || undefined
  const value = salary.value || salary
  if (!value) return undefined

  const currency = salary.currency || value.currency || ''
  const unit = value.unitText || ''
  const min = value.minValue ?? value.value
  const max = value.maxValue

  if (min != null && max != null) return `${currency} ${min}–${max}${unit ? ` / ${unit}` : ''}`.trim()
  if (min != null) return `${currency} ${min}${unit ? ` / ${unit}` : ''}`.trim()
  return undefined
}

function applyLinkedIn(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/"jobPostingTitle"\s*:\s*"([^"]+)"/)
  const companyMatch = html.match(/"companyName"\s*:\s*"([^"]+)"/)
  const locationMatch = html.match(/"jobLocation(?:Name)?"\s*:\s*"([^"]+)"/)
  const descMatch = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/)

  if (titleMatch) result.title = unescapeJson(titleMatch[1]).trim()
  if (companyMatch) result.company = unescapeJson(companyMatch[1]).trim()
  if (locationMatch) result.location = unescapeJson(locationMatch[1]).trim()
  if (descMatch) {
    const desc = stripHtml(unescapeJson(descMatch[1])).trim()
    if (desc) result.description = desc
  }

  const salaryMatch = html.match(/"salary"[\s\S]*?"text"\s*:\s*"([^"]+)"/i) || html.match(/compensation[\s\S]*?"text"\s*:\s*"([^"]+)"/i)
  if (salaryMatch && !result.salary_range) result.salary_range = unescapeJson(salaryMatch[1]).trim()

  const workModeMatch = html.match(/"workplaceTypes"\s*:\s*\["([^"]+)"/i)
  if (workModeMatch && !result.work_mode) {
    const wm = normalizeWorkMode(workModeMatch[1])
    if (wm) result.work_mode = wm
  }

  const datePostedMatch = html.match(/"datePosted"\s*:\s*"([^"]+)"/i)
    || html.match(/"listDate"\s*:\s*"([^"]+)"/i)
  if (datePostedMatch && !result.date_posted) {
    result.date_posted = parsePostingDate(unescapeJson(datePostedMatch[1])) ?? undefined
  }

  const ogTitle = extractMeta(html, 'og:title')
  if (ogTitle) {
    const parsed = parseLinkedInOgTitle(ogTitle)
    if (parsed.title) result.title = parsed.title
    if (parsed.company) result.company = parsed.company
    if (parsed.location) result.location = parsed.location
  }
}

function parseLinkedInOgTitle(ogTitle: string): { title?: string; company?: string; location?: string } {
  const hiring = ogTitle.match(/^(.+?)\s+hiring\s+(.+?)\s+in\s+(.+?)(?:\s*\||$)/i)
  if (hiring) {
    return { company: hiring[1].trim(), title: hiring[2].trim(), location: hiring[3].trim() }
  }
  const atMatch = ogTitle.match(/^(.+?)\s+at\s+(.+?)(?:\s*\||$)/i)
  if (atMatch) {
    return { title: atMatch[1].trim(), company: atMatch[2].trim() }
  }
  return {}
}

function applyIndeed(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/class="jobsearch-JobInfoHeader-title"[^>]*>[\s\S]*?<span[^>]*>([^<]+)/i)
  const companyMatch = html.match(/data-company-name="([^"]+)"/i)
  const descMatch = html.match(/id="jobDescriptionText"[^>]*>([\s\S]*?)<\/div>/i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }

  const salaryMatch = html.match(/salarySnippet[^>]*>[\s\S]*?>([^<]+)/i)
  if (salaryMatch) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())

  const dateMatch = html.match(/dateRecency[^>]*>([^<]+)/i)
    || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)
    || html.match(/"datePosted"\s*:\s*"([^"]+)"/i)
  if (dateMatch && !result.date_posted) {
    result.date_posted = parsePostingDate(dateMatch[1]) ?? undefined
  }
}

function applyGreenhouse(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/class="app-title"[^>]*>([^<]+)/i)
  const companyMatch = html.match(/id="header"\s+class="[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)/i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())

  const contentMatch = html.match(/id="content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
  if (contentMatch) {
    const desc = stripHtml(contentMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyLever(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/class="posting-headline"[^>]*>[\s\S]*?<h2[^>]*>([^<]+)/i)
  const companyMatch = html.match(/class="main-header-text"[^>]*>([^<]+)/i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())

  const contentMatch = html.match(/class="content"[^>]*>([\s\S]*?)<\/div>/i)
  if (contentMatch) {
    const desc = stripHtml(contentMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyGlassdoor(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/data-test="job-title"[^>]*>([^<]+)/i)
  const companyMatch = html.match(/data-test="employer-name"[^>]*>([^<]+)/i)
  const locationMatch = html.match(/data-test="location"[^>]*>([^<]+)/i)
  const descMatch = html.match(/data-test="job-description"[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/class="JobDetails_jobDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  if (locationMatch) result.location = decodeHtmlEntities(locationMatch[1].trim())
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyCryptocurrencyJobs(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  const companyMatch = html.match(/<h1[^>]*>[^<]+<\/h1>[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i)
  const proseMatch = html.match(/<div class=["']?prose["']?>([\s\S]*?)<\/div>/i)
  const locationMatch = html.match(/<h3[^>]*>Location<\/h3>[\s\S]*?<li[^>]*>[\s\S]*?>([^<]+)</i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())

  if (proseMatch) {
    const desc = stripHtml(proseMatch[1]).trim()
    if (desc) result.description = desc
  }

  if (locationMatch) result.location = decodeHtmlEntities(locationMatch[1].trim())
}

function applyCryptoJobsList(result: ScrapedJob, html: string): void {
  const titleMatch =
    html.match(/<h1[^>]*class="[^"]*text-4xl[^"]*"[^>]*>([^<]+)<\/h1>/i) ||
    html.match(/<h2[^>]*class="[^"]*text-[^"]*"[^>]*>\s*([^<]+?)\s*<\/h2>/i)

  const companyMatch =
    html.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/companies\/[^"]*"[^>]*>([^<]+)<\/a>/i) ||
    html.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i)

  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())

  const contentMatch = html.match(
    /<h3[^>]*>[\s\S]*?<\/h3>([\s\S]*?)(?:Listed in:|Discuss on|Top Cities for|<footer)/i
  )
  if (contentMatch) {
    const desc = stripHtml(contentMatch[1]).trim()
    if (desc.length > 80) result.description = desc
  }

  const salaryMatch = html.match(/(\d+k-\d+k\/year|\d+k-\d+k\/month|\d+-\d+\/hour)/i)
  if (salaryMatch) result.salary_range = salaryMatch[1]

  const locationMatch = html.match(/📍\s*([^<\n]+)/i)
  if (locationMatch) result.location = decodeHtmlEntities(locationMatch[1].trim())
}

function applyCryptoJobsCom(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1 class="job-detail-title">\s*([^<]+)/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())

  const companyMatch = html.match(/<div class="fs-7\s*">\s*([^<]+?)\s*<\/div>/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())

  if (!result.company || !result.title) {
    const parsed = parseAtCompanyTitle(extractTitleTag(html))
    if (!result.title && parsed.title) result.title = parsed.title
    if (!result.company && parsed.company) result.company = parsed.company
    if (!result.location && parsed.location) result.location = parsed.location
  }

  const articleMatch = html.match(/<div class="details-area">[\s\S]*?<article>([\s\S]*?)<\/article>/i)
  if (articleMatch) {
    const desc = stripHtml(articleMatch[1]).trim()
    if (desc.length > 80) result.description = desc
  }

  if (!result.description) {
    const fromLd = extractCryptoJobsComFromBrokenJsonLd(html)
    if (fromLd.description) result.description = fromLd.description
    if (!result.company && fromLd.company) result.company = fromLd.company
    if (!result.title && fromLd.title) result.title = fromLd.title
  }
}

function extractCryptoJobsComFromBrokenJsonLd(html: string): Partial<ScrapedJob> {
  const match = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match || !match[1].includes('JobPosting')) return {}

  const raw = match[1]
  const title = raw.match(/"title"\s*:\s*"([^"]+)"/)?.[1]
  const company = raw.match(/"hiringOrganization"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/)?.[1]
  const descMatch = raw.match(/"description"\s*:\s*"([\s\S]*?)"\s*,\s*"employmentType"/)
  const description = descMatch
    ? stripHtml(descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')).trim()
    : undefined

  return { title, company, description }
}

function applyCryptoJobs(result: ScrapedJob, html: string): void {
  if (!result.location) {
    const loc = html.match(/name="twitter:data2"\s+content="([^"]+)"/i)?.[1]
    if (loc) result.location = decodeHtmlEntities(loc)
  }

  if (!result.description) {
    const panelMatch = html.match(/<div class="col-md-8 content-panel">([\s\S]*?)<\/div>\s*<div class="col-md-4/i)
    if (panelMatch) {
      const desc = stripHtml(panelMatch[1]).trim()
      if (desc.length > 80) result.description = desc
    }
  }
}

function applyWeb3Career(result: ScrapedJob, html: string): void {
  if (!result.title || !result.company) {
    const ogTitle = extractMeta(html, 'og:title')
    if (ogTitle) {
      const parsed = parseAtCompanyTitle(ogTitle.replace(/^Web3\s+/i, ''))
      if (!result.title && parsed.title) result.title = parsed.title
      if (!result.company && parsed.company) result.company = parsed.company
    }
  }

  if (!result.description) {
    const metaDesc = extractMeta(html, 'description')
    if (metaDesc && metaDesc.trim().length > 100) {
      result.description = stripHtml(metaDesc).trim()
    }
  }

  if (!result.location) {
    const locMatch = html.match(/class="[^"]*job-location[^"]*"[^>]*>([^<]+)/i)
    if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  }
}

function applyVancouverJobs(result: ScrapedJob, html: string): void {
  if (!result.title) {
    const titleMatch = html.match(/itemprop=["']title["'][^>]*>([^<]+)<\/span>/i)
    if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  }
  if (!result.title) {
    const ogTitle = extractMeta(html, 'og:title')
    if (ogTitle) result.title = ogTitle
  }

  if (!result.company) {
    const companyMatch = html.match(/itemprop=["']hiringOrganization["'][^>]*content=["']([^"']+)["']/i)
    if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  }

  if (!result.description) {
    // The job body is wrapped in <span itemprop="description"><span
    // class="jobdescription">...</span></span>. Anchor on itemprop to
    // get the full body — a naked `class="jobdescription"` match
    // non-greedily stops at the first inner `</span>` (a style span)
    // and captures only "Requisition ID: 46601 ", which trips the
    // 80-char length check and falls through to applyGeneric, which
    // then picks up the "Language English (United States)" header.
    const descMatch = html.match(
      /itemprop=["']description["'][\s\S]*?class=["']jobdescription["'][^>]*>([\s\S]*?)<\/span>\s*<\/span>/i
    )
    if (descMatch) {
      const desc = stripHtml(descMatch[1]).trim()
      if (desc.length > 80) result.description = desc
    }
  }

  if (!result.location) {
    const cityMatch = html.match(/itemprop=["']addressLocality["'][^>]*content=["']([^"']+)["']/i)
    const regionMatch = html.match(/itemprop=["']addressRegion["'][^>]*content=["']([^"']+)["']/i)
    if (cityMatch) result.location = decodeHtmlEntities(cityMatch[1].trim())
    if (regionMatch && result.location) result.location += `, ${  decodeHtmlEntities(regionMatch[1].trim())}`
  }

  // The "per annum" → "per hour" rewrite for BC pay-grade hourly rates
  // lives in the post-processing block (after extractSalaryAndMetadata)
  // — it needs salary_range to already be populated, which doesn't
  // happen until after this function returns.
}

function applyMonster(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/data-test="jobTitle"[^>]*>([^<]+)/i) || html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/data-test="company"[^>]*>([^<]+)/i) || html.match(/itemprop="hiringOrganization"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/data-test="location"[^>]*>([^<]+)/i) || html.match(/itemprop="jobLocation"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/data-test="salary"[^>]*>([^<]+)/i)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  const descMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyZipRecruiter(result: ScrapedJob, html: string): void {
  // ZipRecruiter renders the job page with a mix of `data-testid` markers
  // (React Testing Library) and a small set of stable CSS classes. The
  // title and location are in `data-testid` attributes on plain elements;
  // the company name is the visible text inside a link with
  // `data-testid="companyLink"`. Fall back to the more specific markers
  // if those are absent, then to the older `h1.job_title` /
  // `span.company_name` shape (used by older ZipRecruiter pages).
  const titleMatch = html.match(/data-testid="jobTitle"[^>]*>([^<]+)/i)
    || html.match(/<h1[^>]*class="[^"]*job_title[^"]*"[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())

  // The `companyLink` testid is on an `<a>` whose visible text is the
  // company name. Anchor-text extraction handles the link case.
  const companyMatch = html.match(/<a[^>]*data-testid="companyLink"[^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/<span[^>]*class="[^"]*company_name[^"]*"[^>]*>([^<]+)<\/span>/i)
    || html.match(/<a[^>]*class="[^"]*company_name[^"]*"[^>]*>([^<]+)<\/a>/i)
  if (companyMatch) result.company = decodeHtmlEntities(stripHtml(companyMatch[1]).trim())

  const locMatch = html.match(/data-testid="jobLocation"[^>]*>([^<]+)/i)
    || html.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([^<]+)<\/span>/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())

  // Salary shows up in a span with `class="...salary..."` or in a `meta`
  // tag (`<meta property="og:...">`). The fallback regex catches the
  // bare "$X – $Y" form (without a `k`/`K` suffix) that the older
  // path-only regex would miss.
  const salaryMatch = html.match(/<span[^>]*class="[^"]*salary[^"]*"[^>]*>([^<]+)<\/span>/i)
    || html.match(/<div[^>]*class="[^"]*salary[^"]*"[^>]*>([^<]+)<\/div>/i)
    || html.match(/\$\s*[\d,]+(?:\.\d+)?\s*(?:–|-|to)\s*\$?\s*[\d,]+(?:\.\d+)?\s*(?:k|K)?/i)
  if (salaryMatch && !result.salary_range) {
    result.salary_range = decodeHtmlEntities(
      (salaryMatch[1] || salaryMatch[0]).trim()
    )
  }

  // Description lives in `data-testid="jobDescription"`. Fall back to
  // the legacy `<section class="...description...">` shape, then to any
  // element whose class contains "job-description".
  const descMatch = html.match(/<div[^>]*data-testid="jobDescription"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*data-testid="jobDescription"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyRemoteOk(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*class="[^"]*font-weight-bold[^"]*"[^>]*>([^<]+)<\/h1>/i) || html.match(/<h2[^>]*>([^<]+)<\/h2>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/<p[^>]*class="[^"]*text-detail[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i) || html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const salaryMatch = html.match(/class="[^"]*salary-range[^"]*"[^>]*>([^<]+)/i) || html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  result.location = 'Remote'
  const descMatch = html.match(/<div[^>]*class="[^"]*prose[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyWeWorkRemotely(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="company"[^>]*>([^<]+)/i) || html.match(/<a[^>]*class="[^"]*company[^"]*"[^>]*>([^<]+)<\/a>/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const salaryMatch = html.match(/class="[^"]*range[^"]*"[^>]*>([^<]+)/i) || html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  result.location = 'Remote'
  const descMatch = html.match(/<div[^>]*class="[^"]*listing-card[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyRemotive(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i) || html.match(/<span[^>]*class="[^"]*company_name[^"]*"[^>]*>([^<]+)<\/span>/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const salaryMatch = html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)(?:\s*(?:per|a|an|\/)\s*(year|yr|month|hour|hr))?/i)
  if (salaryMatch && !result.salary_range) result.salary_range = salaryMatch[0].trim()
  result.location = 'Remote'
  const descMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applySimplyHired(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/data-testid="jobTitle"[^>]*>([^<]+)/i) || html.match(/<h2[^>]*class="[^"]*job-title[^"]*"[^>]*>([^<]+)</i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/data-testid="jobCompany"[^>]*>([^<]+)/i) || html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/data-testid="jobLocation"[^>]*>([^<]+)/i) || html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)</i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/class="[^"]*salary[^"]*"[^>]*>([^<]+)/i) || html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  const descMatch = html.match(/<div[^>]*data-testid="jobDescription"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyAdzuna(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*class="[^"]*job-title[^"]*"[^>]*>([^<]+)<\/h1>/i) || html.match(/data-adzuna="title"[^>]*>([^<]+)/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/data-adzuna="company"[^>]*>([^<]+)/i) || html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/data-adzuna="location"[^>]*>([^<]+)/i) || html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/data-adzuna="salary"[^>]*>([^<]+)/i) || html.match(/class="[^"]*salary[^"]*"[^>]*>([^<]+)/i)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  const descMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyTalentCom(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/data-test="job-title"[^>]*>([^<]+)/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/data-test="company-name"[^>]*>([^<]+)/i) || html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/data-test="location"[^>]*>([^<]+)/i) || html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/data-test="salary"[^>]*>([^<]+)/i) || html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = decodeHtmlEntities(salaryMatch[1].trim())
  const descMatch = html.match(/<div[^>]*data-test="description"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyJora(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i) || html.match(/class="[^"]*employer[^"]*"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)(?:\s*(?:per|a|an|\/)\s*(year|yr|month|hour|hr))?/i)
  if (salaryMatch && !result.salary_range) result.salary_range = salaryMatch[0].trim()
  const descMatch = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyStartupJobs(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)/i) || html.match(/<a[^>]*class="[^"]*company_name[^"]*"[^>]*>([^<]+)<\/a>/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)(?:\s*(?:per|a|an|\/)\s*(year|yr|month|hour|hr))?/i)
  if (salaryMatch && !result.salary_range) result.salary_range = salaryMatch[0].trim()
  const descMatch = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyBuiltIn(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/class="[^"]*job-title[^"]*"[^>]*>([^<]+)/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="[^"]*company-name[^"]*"[^>]*>([^<]+)/i) || html.match(/itemprop="name"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = salaryMatch[0].trim()
  const descMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

function applyIdealist(result: ScrapedJob, html: string): void {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  const companyMatch = html.match(/class="[^"]*org-name[^"]*"[^>]*>([^<]+)/i) || html.match(/class="[^"]*organization[^"]*"[^>]*>([^<]+)/i)
  if (companyMatch) result.company = decodeHtmlEntities(companyMatch[1].trim())
  const locMatch = html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)/i)
  if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
  const salaryMatch = html.match(/\$([\d,]+(?:k|K)?)\s*(?:–|-|to)\s*\$?([\d,]+(?:k|K)?)/)
  if (salaryMatch && !result.salary_range) result.salary_range = salaryMatch[0].trim()
  const descMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<div[^>]*id="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (descMatch) {
    const desc = stripHtml(descMatch[1]).trim()
    if (desc) result.description = desc
  }
}

/**
 * UltiPro (UKG) job boards are Knockout.js shells — the page is a
 * `<h1 data-bind="text: formattedTitle">` skeleton that only fills in
 * client-side. The actual opportunity data is server-inlined into a
 * `new US.Opportunity.CandidateOpportunityDetail({...})` viewmodel in
 * the page's script block. Parsing that JSON gives us the full job
 * (Title, Description, Locations, PostedDate, RequisitionNumber, …)
 * without needing a browser.
 */
function applyUltiPro(result: ScrapedJob, html: string): void {
  const idx = html.indexOf('new US.Opportunity.CandidateOpportunityDetail(')
  if (idx === -1) return
  const start = html.indexOf('{', idx)
  if (start === -1) return

  // Walk the braces, respecting string literals and escape sequences.
  let depth = 0
  let inString = false
  let escape = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return

  // The blob is a JS object literal (not JSON), so we use `new Function`
  // to evaluate it. This is safe — we are the only consumer of this
  // string and it comes from a public job-detail page that runs in
  // our renderer's main process.
  const blob = html.slice(start, end + 1)
  let opp: Record<string, unknown> | null = null
  try {
    opp = new Function(`"use strict"; return (${blob});`)() as Record<string, unknown>
  } catch {
    return
  }
  if (!opp) return

  if (typeof opp.Title === 'string' && opp.Title) {
    result.title = decodeHtmlEntities(opp.Title).trim()
  }
  if (typeof opp.Description === 'string' && opp.Description) {
    const desc = stripHtml(opp.Description).trim()
    if (desc) result.description = desc
  }
  if (Array.isArray(opp.Locations) && opp.Locations.length > 0) {
    const locs = opp.Locations
      .map((l) => {
        if (!l || typeof l !== 'object') return null
        const loc = l as Record<string, unknown>
        const addr = loc.Address as Record<string, unknown> | undefined
        if (!addr) return null
        const city = typeof addr.City === 'string' ? addr.City : ''
        const state = addr.State as { Name?: string; Code?: string } | undefined
        const region = state?.Code || state?.Name || ''
        const country = addr.Country as { Name?: string } | undefined
        const parts = [city, region, country?.Name].filter(Boolean)
        return parts.length ? parts.join(', ') : null
      })
      .filter((s): s is string => Boolean(s))
    if (locs.length) result.location = locs.join('; ')
  }
  if (typeof opp.PostedDate === 'string' && opp.PostedDate) {
    result.date_posted = parsePostingDate(opp.PostedDate) ?? undefined
  }
  if (typeof opp.RequisitionNumber === 'string' && opp.RequisitionNumber) {
    result.requirements = `Requisition: ${opp.RequisitionNumber}`
  }
  if (opp.FullTime === true) result.employment_type = 'FULL_TIME'
  else if (opp.FullTime === false) result.employment_type = 'PART_TIME'
  // JobLocationType: 0 = On-site, 1 = Remote, 2 = Hybrid (per UKG docs)
  if (typeof opp.JobLocationType === 'number') {
    if (opp.JobLocationType === 1) result.work_mode = 'REMOTE'
    else if (opp.JobLocationType === 2) result.work_mode = 'HYBRID'
    else if (opp.JobLocationType === 0) result.work_mode = 'ON_SITE'
  }
  if (typeof opp.PayRangeCurrencyCode === 'string' && opp.PayRangeCurrencyCode) {
    const pr = opp.PayRange as { PayRangeMinimum?: number | null; PayRangeMaximum?: number | null } | undefined
    if (pr) {
      const min = typeof pr.PayRangeMinimum === 'number' ? pr.PayRangeMinimum : null
      const max = typeof pr.PayRangeMaximum === 'number' ? pr.PayRangeMaximum : null
      if (min != null && max != null) {
        result.salary_range = `${opp.PayRangeCurrencyCode} ${min.toLocaleString()}\u2013${max.toLocaleString()}`
      }
    }
  }
  // UKG doesn't expose the employer name on the candidate-facing page
  // — the URL's tenant alias (e.g. `MAR5000MAG`) is opaque. The
  // description body, however, almost always starts with "{Company}
  // is a …" boilerplate, so pluck the first sentence's subject.
  if (!result.company && typeof opp.Description === 'string') {
    const plain = opp.Description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const m = plain.match(/^([A-Z][A-Za-z0-9&'.,\- ]{2,80}?)\s+is\s+(?:an?|the)\b/)
    if (m) result.company = m[1].trim()
  }
}

function extractSalaryFromText(text: string): string | undefined {
  const patterns = [
    // Keyword-prefixed (salary/pay/compensation/range) — the bridge
    // between the keyword and the dollar amount tolerates words,
    // numbers, and HTML tags (e.g. "Salary Information: </strong>Pay
    // Grade RNG-091: $60.26 to $75.32 per annum" on Vancouver Jobs),
    // up to 80 chars on a single line. "annum" is added for the
    // British/Commonwealth convention used by BC public-sector postings.
    // Group 1 is the AMOUNT only (not the keyword + bridge) so the
    // caller doesn't store noise like "Pay Grade RNG-091:" as part of
    // the salary — and the amount regex in normalizeSalary doesn't
    // accidentally pick up the "091" pay-grade serial as a third
    // number alongside the actual amounts.
    /(?:salary|pay|compensation|range)\b[^<>\n]{0,80}?([$€£¥][\d,]+(?:\.\d+)?(?:k|K)?(?:\s*(?:–|-|to)\s*[$€£¥]?[\d,]+(?:\.\d+)?(?:k|K)?)?(?:\s*(?:per|a|an|\/)\s*(?:annum|year|yr|month|hour|hr|week|wk|day))?)/i,
    /([$€£¥][\d,]+(?:\.\d+)?(?:k|K)?\s*(?:–|-|to)\s*[$€£¥]?[\d,]+(?:\.\d+)?(?:k|K)?(?:\s*(?:per|a|an|\/)\s*(?:year|yr|month|hour|hr|week|wk|day))?)/,
    /(USD|CAD|EUR|GBP|AUD|NZD)\s*([\d,]+(?:k|K)?(?:\s*(?:–|-|to)\s*[\d,]+(?:k|K)?)(?:\s*(?:per|a|an|\/)\s*(?:year|yr|month|hour|hr|week|wk|day))?)/i
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return decodeHtmlEntities(m[1] || m[0]).trim()
  }
  return undefined
}

function extractEmploymentTypeFromText(text: string): string | undefined {
  const m = text.match(/(?:employment|job)\s*(?:type|status|category)\s*[:\s]+(full[- ]time|part[- ]time|contract|temporary|permanent|internship|freelance)/i)
  if (m) return normalizeEmploymentType(m[1]) ?? undefined
  const m2 = text.match(/(?:type|status|category)\s*[:\s]+(full[- ]time|part[- ]time|contract|temporary|permanent|internship|freelance)/i)
  if (m2) return normalizeEmploymentType(m2[1]) ?? undefined
  return undefined
}

function extractWorkModeFromText(text: string): string | undefined {
  const patterns = [
    /(?:work|job|employment|workplace|position)\s*(?:mode|type|setting|arrangement|status|option)\s*[:\s]+(remote|hybrid|on[- ]site|in[- ]office|on site)/i,
    /(remote|hybrid|on[- ]site|in[- ]office|on site)\s*(?:work|job|position|role|employment|arrangement|setting)/i,
    /workplace\s*[:\s]+(remote|hybrid|on[- ]site|in[- ]office)/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      const val = m[1].toLowerCase().replace(/[- ]/g, '-')
      if (val.startsWith('remote')) return 'Remote'
      if (val.startsWith('hybrid')) return 'Hybrid'
      if (/on.?site|in.?office/.test(val)) return 'On-site'
      return val.charAt(0).toUpperCase() + val.slice(1)
    }
  }
  return undefined
}

function extractSalaryAndMetadata(result: ScrapedJob, html: string): void {
  if (!result.salary_range) {
    // Search the raw HTML first (catches postings where the salary is in
    // meta tags or attribute values), then the cleaned description
    // (catches postings where the salary is inside a rich-text body
    // that needed HTML stripping + entity decoding to become readable —
    // e.g. UKG/UltiPro inlines the body with \u0026nbsp; JSON-escapes
    // between the range tokens, so the regex needs the cleaned text).
    result.salary_range =
      extractSalaryFromText(html) ??
      (result.description ? extractSalaryFromText(result.description) : undefined)
  }
  if (!result.employment_type) {
    result.employment_type =
      extractEmploymentTypeFromText(html) ??
      (result.description ? extractEmploymentTypeFromText(result.description) : undefined)
  }
  if (!result.work_mode) {
    result.work_mode =
      extractWorkModeFromText(html) ??
      (result.description ? extractWorkModeFromText(result.description) : undefined)
  }
}

function extractPostingDateFromHtml(result: ScrapedJob, html: string): void {
  if (result.date_posted) return

  const metaPublished = extractMeta(html, 'article:published_time')
    || extractMeta(html, 'og:published_time')
  if (metaPublished) {
    result.date_posted = parsePostingDate(metaPublished) ?? undefined
    if (result.date_posted) return
  }

  const itempropMatch = html.match(/itemprop=["']datePosted["'][^>]+(?:content=["']([^"']+)["']|datetime=["']([^"']+)["'])/i)
    || html.match(/(?:content=["']([^"']+)["']|datetime=["']([^"']+)["'])[^>]+itemprop=["']datePosted["']/i)
  if (itempropMatch) {
    result.date_posted = parsePostingDate(itempropMatch[1] || itempropMatch[2]) ?? undefined
    if (result.date_posted) return
  }

  const jsonDateMatch = html.match(/"datePosted"\s*:\s*"([^"]+)"/i)
    || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)
    || html.match(/"publishedAt"\s*:\s*"([^"]+)"/i)
  if (jsonDateMatch) {
    result.date_posted = parsePostingDate(unescapeJson(jsonDateMatch[1])) ?? undefined
  }
}

export function parsePostingDate(value: unknown): string | null {
  if (value == null) return null
  const str = String(value).trim()
  if (!str) return null
  const parsed = new Date(str)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

export async function scrapePostingDateFromUrl(rawUrl: string): Promise<string | null> {
  const url = normalizeUrl(rawUrl)
  const hostname = new URL(url).hostname.replace(/^www\./, '')
  const html = await fetchPageHtml(url, hostname)
  const result: ScrapedJob = {}
  const jobPosting = selectJobPosting(collectJobPostings(extractJsonLd(html)), html, url)
  if (jobPosting) {
    applyJobPosting(result, jobPosting)
  }
  extractPostingDateFromHtml(result, html)
  if (hostname.includes('linkedin.com')) {
    applyLinkedIn(result, html)
  } else if (hostname.includes('indeed.com')) {
    applyIndeed(result, html)
  }
  return result.date_posted ?? null
}

/**
 * Brainhunter (https://www.brainhunter.com) is an ATS used by many BC
 * employers (PHSA, BC Hydro, etc.) for their careers pages. The
 * per-job page is a server-rendered Struts-era HTML with no JSON-LD
 * and no og: meta tags. The data the user wants is structured like
 * this:
 *
 *   <title>job details - Business Analyst – Financial Planning & Analysis in Vancouver</title>
 *   <meta name="description" content="Business Analyst – Financial Planning Analysis  The Business Analyst is responsible for...">
 *   <strong>Business Analyst – Financial Planning & Analysis</strong>     <-- the real job title
 *   <p>Job Type:&nbsp; Temporary Casual Salary Range:&nbsp; $43/hour ...</p>
 *   <p>Location:&nbsp; Hybrid – Vancouver BC Hours of Work:&nbsp; 37.5 ...</p>
 *   ...
 *   The Provincial Health Services Authority ( PHSA ) plans, manages and evaluates ...   <-- the company
 *
 * The fallback heuristics in `applyGeneric` would extract "job details"
 * as the title, "Brainhunter" as the company (from the hostname), and
 * a truncated meta description — all wrong. This extractor reads the
 * `<strong>` for the title, mines the body for the company's "The X
 * plans/manages/..." intro paragraph, parses the body labels
 * (Location:, Salary Range:, Job Type:) for those fields, and falls
 * back to the meta description if the body doesn't yield one.
 */
function applyBrainhunter(result: ScrapedJob, html: string): void {
  // 1) Title from the <strong> tag inside the page body. The <title>
  // is "job details - X in City" which is not the title.
  if (!result.title) {
    const strong = html.match(/<strong[^>]*>([^<]{5,200})<\/strong>/i)
    if (strong) {
      // The local decodeHtmlEntities below doesn't cover the
      // &ndash; / &rsquo; / &ldquo; entities the Brainhunter page
      // uses in the <strong> title, so decode the common ones here
      // before passing through. (The shared decodeEntities util in
      // utils.ts would do this, but it's not imported in this file.)
      const cleaned = decodeHtmlEntities(strong[1])
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&rsquo;/g, '\u2019')
        .replace(/&lsquo;/g, '\u2018')
        .replace(/&ldquo;/g, '\u201C')
        .replace(/&rdquo;/g, '\u201D')
        .replace(/&hellip;/g, '\u2026')
        .replace(/\s+in\s+[A-Z][A-Za-z\- ]+$/, '')   // drop trailing "in Vancouver"
        .trim()
      if (cleaned.length > 5 && cleaned.length < 200) result.title = cleaned
    }
  }

  // 2) Description: pull the full job body from the page, not the
  // truncated meta description. The page template puts the actual
  // job posting (What you'll do / What you bring / What we bring
  // sections) between the <strong> title and the "What we do"
  // corporate-boilerplate section. Everything after "What we do" is
  // PHSA corporate copy ("Every PHSA employee enables...", footer
  // privacy text, anti-racism boilerplate) that is not part of the
  // job posting.
  if (!result.description) {
    const strongIdx = html.search(/<strong[^>]*>[^<]{5,200}<\/strong>/i)
    if (strongIdx !== -1) {
      const after = html.slice(strongIdx)
      // Cut at the "What we do" corporate header. Case-insensitive
      // and tolerant of &nbsp; between the words.
      const whatWeDo = after.search(/What\s*we\s*do/i)
      const sliceEnd = whatWeDo !== -1 ? whatWeDo : after.length
      const bodyHtml = after.slice(0, sliceEnd)
      const bodyText = bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&amp;/g, '&')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // Drop the title (already extracted above) and the trailing
      // Job Type / Salary / Location / Hours of Work labels (those
      // are parsed into their own fields). What remains is the
      // description body.
      const titleFromBody = decodeHtmlEntities(html.match(/<strong[^>]*>([^<]{5,200})<\/strong>/i)?.[1] || '')
        .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
        .replace(/&amp;/g, '&').replace(/&[a-z]+;/gi, ' ').replace(/&#\d+;/g, ' ')
        .replace(/\s+in\s+[A-Z][A-Za-z\- ]+$/, '').trim()
      let body = bodyText
      if (titleFromBody) {
        const ti = body.indexOf(titleFromBody)
        if (ti !== -1) body = body.slice(ti + titleFromBody.length)
      }
      // Trim trailing labels (Job Type / Salary Range / Location /
      // Hours of Work) so the description doesn't duplicate fields
      // that are already extracted into structured columns.
      const labelCut = body.search(/\bJob Type:\s/i)
      if (labelCut !== -1) body = body.slice(0, labelCut)
      body = body.trim()
      if (body.length > 100) result.description = body
    }
  }
  // Fallback to the meta description if the body extraction didn't
  // yield enough (some postings may not have a "What we do" header).
  if (!result.description) {
    const metaDesc = extractMeta(html, 'description')
    if (metaDesc && metaDesc.length > 100) result.description = stripHtml(metaDesc).trim()
  }

  // For the rest, we need the body as readable text. The labels
  // appear after the <strong> title, separated by &nbsp; which we
  // normalize to a real space.
  if (!result.location || !result.salary_range || !result.employment_type || !result.company) {
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&ndash;/g, '–')
      .replace(/&amp;/g, '&')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')

    // 3) Location: "Location: Hybrid – Vancouver BC" — read up to the
    // next label (Hours of Work / Job Type / Salary Range / What we do).
    if (!result.location) {
      const m = body.match(/Location:\s*([^]*?)\s*(?:Hours of Work|Job Type|Salary Range|What we do|Position Summary|About|Req|$)/i)
      if (m) {
        const loc = m[1].trim()
        if (loc && loc.length < 100) result.location = loc
      }
    }

    // 4) Salary: "Salary Range: $43/hour - as a casual employee, ..."
    // — capture just the first amount + optional unit, drop the long
    // explanatory text that follows. The post-processor and the
    // boundary normalizer (normalizeSalary) take care of annualizing
    // hourly/monthly values, so the extractor stays unit-agnostic.
    if (!result.salary_range) {
      const m = body.match(/Salary Range:\s*(\$[\d,]+(?:\.\d+)?(?:\s*\/\s*(?:hour|year|month|week|day|hr|yr|wk))?)/i)
      if (m) result.salary_range = m[1].trim()
    }

    // 5) Job type: "Job Type: Temporary Casual"
    if (!result.employment_type) {
      const m = body.match(/Job Type:\s*([^]*?)\s*(?:Salary Range|Hours of Work|Location:|Req|Position Summary|What we do|About|$)/i)
      if (m) {
        const t = m[1].trim()
        if (t && t.length < 60) {
          // Free-form body text like "Temporary Casual" or "Permanent Full Time"
          // rarely maps to a single canonical token, but try the full
          // matched string first; if that doesn't match a token, the
          // persistence boundary will null it so the user can pick in Edit.
          result.employment_type = normalizeEmploymentType(t) ?? undefined
        }
      }
    }

    // 6) Company: "The Provincial Health Services Authority ( PHSA )
    // plans, manages and evaluates ...". The page template always
    // has a "The {Full Name} ( {Acronym} ) <verb>" intro paragraph
    // describing the employer. Capture the full name between "The "
    // and the " ( " acronym. Falls back to the first "X is a/the"
    // sentence if the template pattern isn't found.
    if (!result.company) {
      const tmpl = body.match(/The\s+([A-Z][A-Za-z0-9&'.,\- ]{3,80}?)\s*\(\s*[A-Z]{2,8}\s*\)\s+(?:plans|manages|provides|offers|is|has|operates|serves|works|strives|seeks|believes|is committed|is seeking|values|is dedicated)/)
      if (tmpl) {
        result.company = tmpl[1].trim()
      } else {
        const xIs = body.match(/([A-Z][A-Za-z0-9&'.,\- ]{3,80}?)\s+is\s+(?:an?|the)\b/)
        if (xIs) result.company = xIs[1].trim()
      }
    }
  }
}

/**
 * CATS One (https://*.catsone.com) is a CATS-branded ATS used by many
 * Canadian employers (Harbourfront Wealth, etc.). The per-job page
 * is server-rendered with a `<div class="job-description-container">`
 * wrapper that holds the full posting: title, location, body text,
 * and an equality-statement footer. The CATS One `<meta
 * name="description">` is hard-truncated to ~200 chars by the ATS,
 * so the generic-extractor description fallback lands on a
 * truncated version. This extractor reads the
 * `job-description-container` div directly, which contains the full
 * posting.
 *
 * Note: CATS One pages do NOT expose the company name anywhere in
 * the HTML — it's the tenant of the host (`*.catsone.com` where
 * the subdomain is the company). The applyGeneric fallback
 * handles company from the hostname first segment; we don't
 * override that here.
 */
function applyCATSOne(result: ScrapedJob, html: string): void {
  // 1) Description from the job-description-container div. The
  // outer wrapper, not the inner `job-description` div, because the
  // inner one is just the body text — the outer includes the title
  // and location summary at the top, which we strip. We use a
  // non-greedy match that runs to the FIRST `<section` / `<footer`
  // / `</main>` boundary rather than the first `</div>`, because
  // the inner divs close much earlier than the container.
  if (!result.description) {
    const m = html.match(/<div[^>]+class="[^"]*job-description-container[^"]*"[^>]*>([\s\S]*?)(?=<(?:section|footer|aside)[^>]*>|<\/?main|\s*<div[^>]+class="[^"]*(?:footer|related|similar|sidebar))/i)
    let bodyHtml = m?.[1] ?? ''
    if (!bodyHtml) {
      // Fallback: the inner job-description div
      const inner = html.match(/<div[^>]+class="[^"]*job-description(?:-[a-z]+)?[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      bodyHtml = inner?.[1] ?? ''
    }
    if (bodyHtml) {
      let body = bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&rsquo;/g, '\u2019')
        .replace(/&lsquo;/g, '\u2018')
        .replace(/&ldquo;/g, '\u201C')
        .replace(/&rdquo;/g, '\u201D')
        .replace(/&amp;/g, '&')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // The container prepends "View all jobs {Title} {Location},"
      // which is the title + location summary. Drop everything up to
      // the first paragraph-start marker. We anchor on a curated
      // list of section labels that CATS One postings use, so we
      // don't get tripped up by "{City}, {Province} {Header}:" in
      // the same sentence.
      const paragraphPatterns = [
        /\bWho we are:\s/i,
        /\bAbout (?:the |us |you )?[A-Z][A-Za-z]+:\s/i,
        /\b(?:Job |Position |Role )?(?:Summary|Overview|Description):\s/i,
        /\bResponsibilities:\s/i,
        /\bDuties:\s/i,
        /\bRequirements:\s/i,
        /\bQualifications:\s/i,
        /\bWhat you(?:'ll)? (?:do|bring):\s/i
      ]
      let cutAt = -1
      for (const p of paragraphPatterns) {
        const m = body.match(p)
        if (m && m.index !== undefined && (cutAt === -1 || m.index < cutAt)) {
          cutAt = m.index
        }
      }
      if (cutAt > 0 && cutAt < body.length / 2) {
        body = body.slice(cutAt)
      }
      // Drop trailing "Apply Now" + equality-statement footer.
      const footerCut = body.search(/\bApply Now\b/i)
      if (footerCut !== -1 && footerCut > body.length / 2) body = body.slice(0, footerCut)
      body = body.trim()
      if (body.length > 200) result.description = body
    }
  }
}

function applyGeneric(result: ScrapedJob, html: string, pageUrl: string): void {
  if (!result.title) {
    const ogTitle = extractMeta(html, 'og:title')
    if (ogTitle) {
      const parsed = parseAtCompanyTitle(ogTitle)
      result.title = parsed.title || ogTitle
    }
  }
  if (!result.title) {
    const titleTag = extractTitleTag(html)
    if (titleTag) {
      const cleaned = titleTag
        .replace(/\s*[|–—-]\s*.*$/, '')
        .replace(/^(?:Job|Hiring|Career|Opening|Position)\s*[:\s]+/i, '')
        .trim()
      if (cleaned && cleaned.length > 5 && cleaned.length < 200) result.title = cleaned
    }
  }
  if (!result.title) {
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    if (h1) {
      const cleaned = h1[1].trim()
      if (cleaned.length > 5 && cleaned.length < 200) result.title = decodeHtmlEntities(cleaned)
    }
  }
  if (!result.title) {
    const h2 = html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h2>/i)
    if (h2) result.title = decodeHtmlEntities(h2[1].trim())
  }

  if (!result.company) {
    const ogSite = extractMeta(html, 'og:site_name')
    if (ogSite) result.company = ogSite
  }
  if (!result.company) {
    const author = extractMeta(html, 'author')
    if (author && !/^https?:\/\//i.test(author)) result.company = author
  }
  if (!result.company) {
    try {
      const hostname = new URL(pageUrl).hostname.replace(/^www\./, '')
      const parts = hostname.split('.')
      if (parts.length >= 2 && !['com', 'org', 'net', 'io', 'co', 'career', 'jobs'].includes(parts[parts.length - 2])) {
        result.company = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
      }
    } catch {}
  }
  if (!result.company && result.title) {
    const atMatch = result.title.match(/\s+at\s+(.+?)$/i)
    if (atMatch) {
      result.company = atMatch[1].trim()
      result.title = result.title.replace(/\s+at\s+.+?$/i, '').trim()
    }
  }

  if (!result.description) {
    const ogDesc = extractMeta(html, 'og:description')
    if (ogDesc && ogDesc.length > 100) result.description = stripHtml(ogDesc).trim()
  }
  if (!result.description) {
    const metaDesc = extractMeta(html, 'description')
    if (metaDesc && metaDesc.length > 100) result.description = stripHtml(metaDesc).trim()
  }
  if (!result.description) {
    const contentDiv = html.match(/<div[^>]*class="[^"]*(?:job-description|jobDescription|posting-description|description|content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    if (contentDiv) {
      const desc = stripHtml(contentDiv[1]).trim()
      if (desc.length > 80) result.description = desc
    }
  }
  if (!result.description) {
    const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    if (article) {
      const desc = stripHtml(article[1]).trim()
      if (desc.length > 80) result.description = desc
    }
  }
  if (!result.description) {
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    if (main) {
      const desc = stripHtml(main[1]).trim()
      if (desc.length > 80) result.description = desc
    }
  }

  if (!result.location) {
    const ogLoc = extractMeta(html, 'og:locality') || extractMeta(html, 'location')
    if (ogLoc) result.location = ogLoc
  }
  if (!result.location) {
    const locMatch = html.match(/location[^:]*:\s*([^<\n]+)/i)
    if (locMatch) {
      const loc = locMatch[1].replace(/<[^>]+>/g, '').trim()
      if (loc && loc.length < 100) result.location = decodeHtmlEntities(loc)
    }
  }
}

function parseAtCompanyTitle(title?: string): {
  title?: string
  company?: string
  location?: string
} {
  if (!title) return {}

  const piped = title.match(/^(.+?)\s+at\s+(.+?)\s*\|\s*([^|]+)/i)
  if (piped) {
    return {
      title: piped[1].trim(),
      company: piped[2].trim(),
      location: piped[3].trim()
    }
  }

  const atMatch = title.match(/^(.+?)\s+at\s+(.+?)(?:\s*\||$)/i)
  if (atMatch) {
    return { title: atMatch[1].trim(), company: atMatch[2].trim() }
  }

  return {}
}

function extractTitleTag(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return match ? decodeHtmlEntities(match[1].trim()) : undefined
}

function applyAmberGroup(result: ScrapedJob, html: string): void {
  const nextData = extractNextData(html)
  if (nextData) {
    const pageProps = (nextData.props as Record<string, unknown> | undefined)?.pageProps as
      | Record<string, unknown>
      | undefined
    const attrs = (pageProps?.jd as Record<string, unknown> | undefined)?.attributes as
      | Record<string, unknown>
      | undefined

    if (attrs?.title) result.title = String(attrs.title).trim()

    if (attrs?.description) {
      const desc = stripHtml(String(attrs.description)).trim()
      if (desc) result.description = desc
    }

    const locations = attrs?.gp_ofw_gp_people_locations as
      | { data?: { attributes?: { location?: string } }[] }
      | undefined
    const locs = locations?.data
      ?.map((entry) => entry.attributes?.location?.trim())
      .filter((loc): loc is string => Boolean(loc))
    if (locs?.length) result.location = locs.join('; ')
  }

  const author = extractMeta(html, 'author')
  if (author) result.company = author

  if (!result.title) {
    const titleMatch = html.match(
      /class="[^"]*jobDescription_wrap_content_header_name[^"]*"[^>]*>([^<]+)/i
    )
    if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim())
  }

  if (!result.location) {
    const metaLineMatch = html.match(/class="[^"]*jobDescription_wrap_content_desc[^"]*"[^>]*>([^<]+)/i)
    if (metaLineMatch) {
      const locationPart = decodeHtmlEntities(metaLineMatch[1].trim()).split('•')[0]?.trim()
      if (locationPart) result.location = locationPart
    }
  }

  if (!result.description) {
    const textMatch = html.match(
      /class="[^"]*jobDescription_wrap_content_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
    )
    if (textMatch) {
      const desc = stripHtml(textMatch[1]).trim()
      if (desc) result.description = desc
    }
  }
}

function extractNextData(html: string): Record<string, unknown> | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!match) return null
  try {
    return JSON.parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractJsonLd(html: string): unknown[] {
  const results: unknown[] = []
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]))
    } catch {
      // skip malformed blocks
    }
  }
  return results
}

function extractMeta(html: string, name: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(name)}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapeRegex(name)}["']`, 'i')
  ]
  for (const p of patterns) {
    const m = html.match(p)
    if (m?.[1]) return decodeHtmlEntities(m[1])
  }
  return undefined
}

function cleanTitle(title: string, company?: string, source?: string): string {
  let cleaned = title
  if (source) {
    cleaned = cleaned.replace(new RegExp(`\\s*[\\|–-]\\s*${escapeRegex(source)}\\s*$`, 'i'), '')
  }
  cleaned = cleaned.replace(/\s*\|.*$/, '')
  if (company) {
    const atSuffix = new RegExp(`\\s+at\\s+${escapeRegex(company)}\\s*$`, 'i')
    cleaned = cleaned.replace(atSuffix, '')
  }
  return cleaned.trim()
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

export function cleanDescription(text: string): string {
  return stripHtml(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
}

function unescapeJson(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
