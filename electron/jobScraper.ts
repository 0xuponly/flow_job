import type { CreateJobInput } from './types'
import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface ScrapedJob {
  title?: string
  company?: string
  location?: string
  description?: string
  salary_range?: string
  source?: string
}

export async function scrapeJobFromUrl(rawUrl: string): Promise<CreateJobInput> {
  const url = normalizeUrl(rawUrl)
  const hostname = new URL(url).hostname.replace(/^www\./, '')
  const source = detectSource(hostname)

  const html = await fetchPageHtml(url, hostname)
  const scraped = extractFromHtml(html, hostname, url, source)

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
    description: scraped.description!,
    salary_range: scraped.salary_range,
    source: scraped.source
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
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
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
  if (hostname.includes('wellfound.com') || hostname.includes('angel.co')) return 'Wellfound'
  if (hostname.includes('otta.com')) return 'Otta'
  if (hostname.includes('hired.com')) return 'Hired'
  if (hostname.includes('cryptocurrencyjobs.co')) return 'Cryptocurrency Jobs'
  if (hostname.includes('ambergroup.io')) return 'Amber Group'
  if (hostname.includes('cryptojobslist.com')) return 'CryptoJobsList'
  if (hostname.includes('cryptojobs.com')) return 'cryptojobs.com'
  if (hostname === 'crypto.jobs') return 'Crypto.jobs'
  if (hostname.includes('web3.career')) return 'Web3.career'
  return undefined
}

async function fetchPageHtml(url: string, hostname: string): Promise<string> {
  if (hostname.includes('cryptojobslist.com')) {
    return fetchHtmlViaBrowser(url)
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    redirect: 'follow'
  })

  if (!response.ok) {
    throw new Error(`Could not fetch page (HTTP ${response.status}). The site may be blocking automated access.`)
  }

  const html = await response.text()
  if (isChallengePage(html)) {
    return fetchHtmlViaBrowser(url)
  }
  return html
}

function extractFromHtml(html: string, hostname: string, pageUrl: string, source?: string): ScrapedJob {
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
  } else if (source) {
    result.source = source
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
      result.description = metaDesc.trim()
    }
  }

  if (!result.location) {
    const locMatch = html.match(/class="[^"]*job-location[^"]*"[^>]*>([^<]+)/i)
    if (locMatch) result.location = decodeHtmlEntities(locMatch[1].trim())
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
