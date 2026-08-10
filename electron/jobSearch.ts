import { createJob, findDuplicateJob, getSeenUrls, getSettings, listJobs, recordBoardResults, recordBoardScanTime, JobBlacklistedError, JobDuplicateError } from './database'
import { decodeEntities, dedupKey } from './utils'
import { scrapeJobFromUrl } from './jobScraper'
import { createLogger, log as categoryLog } from './logger'
import { enqueue } from './aiQueue'

// File-backed category logger. Writes to <userData>/logs/scanner.log.
const log = createLogger('scanner')
import { closeCamoufox, paginateHtmlViaBrowser } from './browserScraper'
import { fetchPageHtml, fetchSitemapText, extractSitemapUrls } from './netUtils'
import { scoreJobFit } from './ai'
import { scoreCompatibility } from './fitHeuristic'
export { scoreCompatibility } from './fitHeuristic'
import type { CreateJobInput, Job, LocationPick, ScanFilters, WorkType } from './types'
import { BOARDS, type BoardConfig, type ScanBoardResult, type ScanResult } from './boards'
export { BOARDS } from './boards'
export type { BoardConfig, ScanBoardResult, ScanResult } from './boards'
import { BOARD_CONCURRENCY_HTTP, BOARD_CONCURRENCY_BROWSER } from './scanEstimate'

// Heuristic pre-filter floor for the scan pipeline. Listings with a keyword-
// overlap score below this threshold are persisted with score=null and a
// "low keyword overlap" note instead of being LLM-scored. Two sites use it:
// `processJob` (single-listing import) and `scanAllBoards` (bulk scan).
// Raised from 0.15 → 0.25 on 2026-07-22 to drop marginal leads before they
// hit the queue.
const HEURISTIC_FLOOR = 0.25

// Returns a promise that resolves true as soon as the signal aborts. Used to
// race long-running in-flight work so the cancel button feels immediate
// rather than waiting for the current batch (up to 6 listings) to finish.
function abortPromise(signal?: AbortSignal): Promise<true> {
  if (!signal) return new Promise(() => {}) // never resolves
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }
    signal.addEventListener('abort', onAbort)
  })
}

// Concurrency cap for LLM fit scoring during a scan. Listing scrapes
// already run with LISTING_CONCURRENCY=6, but the LLM is the slow
// leg — without a cap, a single scan can fire 6 LLM requests in
// parallel and trip provider rate limits (or just stall on a queue).
// Capping at 2 keeps the LLM provider happy while still running
// scraping (the I/O-bound part) fully in parallel.
const LLM_SCAN_CONCURRENCY = 2

// Per-batch watchdog for the listing loop. Every listing op is
// individually bounded (camoufox page ops, BrowserWindow timers, the
// 20s LLM call), so a healthy batch of 6 settles well under 5 minutes.
// If a batch outlives this, something wedged that the per-op bounds
// missed — the race below turns that into a counted-error bailout
// instead of a scan that hangs forever.
const BATCH_TIMEOUT_MS = 5 * 60_000

// Sitemap-listing boards (DailyRemote, NoDesk, CharityVillage) get
// their listings from an XML sitemap that covers the site's ENTIRE
// history — DailyRemote's is ~225k URLs, NoDesk's ~15k. The sitemap
// lists newest-first, so a scan needs only the head of the list: the
// recent window it hasn't seen yet. Without a cap, the scan grinds
// through the whole archive until the host rate-limits (DailyRemote
// closed connections after ~2k scrapes), and the blocked-bailout then
// counts every untouched listing as an error — 223k phantom errors
// from one board. 1500 is a generous recent window (weeks of
// listings) while bounding wall time and the error tally.
const MAX_SITEMAP_LISTINGS = 1500

// pLimit-style async limiter. Resolves tasks FIFO with at most
// `n` running concurrently. Aborted tasks reject immediately so
// the scan's cancel signal propagates through the queue.
function createLimiter<T>(n: number) {
  const queue: (() => void)[] = []
  let active = 0
  function next() {
    while (active < n && queue.length > 0) {
      active++
      const run = queue.shift()!
      run()
    }
  }
  return (task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'))
        return
      }
      const start = () => {
        if (signal?.aborted) {
          active--
          reject(new Error('aborted'))
          next()
          return
        }
        task().then(
          (v) => { active--; resolve(v); next() },
          (e) => { active--; reject(e); next() }
        )
      }
      queue.push(start)
      next()
    })
  }
}

interface BoardConfig {
  name: string
  searchUrl: (keywords: string, location: string) => string
  useBrowser: boolean
  /**
   * Optional pagination driver. Given a 0-indexed page number (1, 2,
   * 3, ...), returns the URL to fetch for that page. The driver must
   * be able to return a URL for any page — the caller loops 1..N and
   * breaks on empty page, fetch failure, or signal abort. No upper
   * cap is enforced by the loop; boards that want a cap can return
   * `''` (empty string) to signal "no more pages."
   */
  paginate?: (searchUrl: string, page: number) => string
  /**
   * Optional first-party API fetcher. When present, the board's
   * listing/scrape/score flow is bypassed entirely; the fetcher
   * returns ready-to-insert job records straight from a partner API
   * (Adzuna, Greenhouse, Lever, etc.). The fetcher takes the user's
   * keywords, location, and an abort signal; returns an array of
   * `CreateJobInput` ready for `createJob`. Empty array = nothing
   * matched (or the API key isn't configured). The location param
   * is the same string the scrape path uses; the fetcher is
   * responsible for adapting it to whatever the partner API expects.
   */
  apiFetcher?: (keywords: string, location: string, signal?: AbortSignal) => Promise<CreateJobInput[]>
  /**
   * Optional sitemap-based listing source. When present, the
   * board's search-page HTML is skipped and the per-job URLs come
   * straight from the function's return value. The function takes
   * the user's keywords + location + abort signal and returns the
   * per-job URLs. Each URL is then fed through the same per-listing
   * scrape/score/dedup loop as the search-page branch. Use this
   * for boards whose search results are JS-rendered but still
   * publish a `<loc>`-style XML sitemap with the per-job URLs.
   * The location param is the same string the scrape path uses;
   * the function is responsible for adapting it to whatever
   * sitemap shape the board uses.
   */
  sitemapListingUrls?: (keywords: string, location: string, signal?: AbortSignal) => Promise<string[]>
}


export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  errors: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  totalErrors: number
  totalIncompatible: number
  boards: ScanBoardResult[]
  errors: string[]
  addedJobs: { id: number; title: string; company: string }[]
}

function extractJsonLdListings(html: string, baseUrl: string): { url: string; title?: string; company?: string }[] {
  const results: { url: string; title?: string; company?: string }[] = []
  const seen = new Set<string>()
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      const items = parsed['@graph'] || (parsed['@type'] === 'ItemList' ? parsed.itemListElement : [parsed])
      for (const item of Array.isArray(items) ? items : [items]) {
        const data = item['@type'] === 'JobPosting' ? item : null
        if (!data) continue
        const jp = data
        const url = jp.url
        if (!url) continue
        const fullUrl = new URL(url, baseUrl).href
        if (seen.has(fullUrl)) continue
        seen.add(fullUrl)
        results.push({
          url: fullUrl,
          title: jp.title ? String(jp.title).trim() : undefined,
          company: jp.hiringOrganization
            ? typeof jp.hiringOrganization === 'string'
              ? jp.hiringOrganization
              : jp.hiringOrganization.name
            : undefined
        })
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return results
}

function isNonListingPage(html: string, title: string | undefined): boolean {
  const lower = html.toLowerCase()
  const loginIndicators = [
    'sign in to see this job', 'sign in to apply', 'create an account to apply',
    'sign in with google', 'sign in with linkedin', 'sign in with email',
    'forgot your password', 'reset your password',
    'already have an account? sign in', 'dont have an account? sign up',
    'please sign in to continue'
  ]
  const matches = loginIndicators.filter(t => lower.includes(t)).length
  if (title) {
    const t = title.toLowerCase()
    if (t.includes('sign in') || t.includes('log in') || t.includes('log in') || t.includes('sign up')) return true
  }
  return matches >= 3
}

const NAV_PATHS = /^\/(privacy|terms(-of-service)?|cookie(-policy)?|legal\/?$|login|sign(in|up)|register\/?$|forgot(-password)?|logout|auth|help\/?$|contact\/?$|about\/?$|blog\/?$|faq\/?$|pricing\/?$|status\/?$|developers\/?$|security\/?$|trust\/?$|safety\/?$)/i

// Per-board anchor-text denylist. Each entry is a regex matched (case
// insensitive) against the visible link text (`inner`). The link is
// rejected if ANY pattern in the board's list matches. Used to drop
// header / nav / footer / category-index / search-suggestion links
// that the path-based filter alone can't catch — boards tend to point
// their non-job links at the same search path the real listings use.
const BOARD_NAV_TEXT_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  Monster: [
    /^skip to (content|main)/i,
    /load more/i,
    /^career advice$/i,
    /^employers?\b/i,
    /post (a )?job/i,
    /^products?$/i,
    /^browse jobs?$/i,
    /^all jobs?$/i,
    /^salary$/i,
    /^companies?$/i,
    // Career-advice / resource category pages that share a
    // /career-... path with real jobs but aren't listings.
    /^resume guides?$/i,
    /^cover letter guides?$/i,
    /^interview guides?$/i,
    /^job search guides?$/i,
    /^career path guides?$/i,
    /^salary (tools?|guide|calculator)$/i
  ],
  LinkedIn: [
    /^skip to (content|main)/i,
    /^sign in$/i,
    /^join now$/i,
    /^for business$/i,
    // Category sub-index titles: "1,000+ Engineering Jobs in North York",
    // "52,000+ Jobs in North York", "Resume Guides", etc. The path
    // check above already filters out the URLs, but adding these
    // here as a belt-and-suspenders measure in case the page
    // structure changes.
    /^\d[\d,]*\+\s+(jobs?|openings?)\b/i,
    /^[\d,]+\s+jobs? in\s+/i,
    /^resume guides?$/i,
    /^salary tools?$/i,
    /^career advice$/i,
    /^all jobs? in/i
  ],
  'Remote OK': [
    // Emoji-prefixed category badges in the left rail
    /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    /^post (a )?(remote )?job/i,
    /highest paying/i,
    /buy a job bundle/i,
    /^web3 jobs?$/i,
    /^load more/i,
    /^all jobs?$/i
  ],
  SimplyHired: [
    // "Cashier jobs in Hollywood, FL" — popular-search sidebar links, not jobs
    /jobs in [A-Z][a-z]+, [A-Z]{2}$/i,
    /^(all jobs|all salaries|all cities|all companies)$/i,
    /^load more/i,
    /^previous$|^next$/i
  ],
  'Working Nomads': [
    /^job alerts?$/i,
    /^post a job$/i,
    /^job skills$/i,
    /^jobs by /i,
    /^remote jobs (anywhere|north america|latin america|europe|middle east|africa|apac|australia|argentina|belgium|brazil|canada|colombia|france|germany|ireland|india|japan|mexico|netherlands|new zealand|philippines|poland|portugal|singapore|spain|uk|usa)$/i,
    /^api$/i,
    /^load more/i,
    /^all jobs?$/i
  ],
  Remotive: [
    // Filter chips: work-type and region labels
    /^(full[-\s]?time|part[-\s]?time|freelance|contract|lead)$/i,
    /^(americas|europe|israel|canada|usa timezones|central america|south africa|latin america \(latam\)|apac|northern america)$/i,
    // Top-level category labels in the sidebar — they're navigation, not job titles
    /^(sales|customer service|medical|finance|marketing|human resources|information technology|operations|artificial intelligence|teaching|all others|design|legal|account management|office assistant)$/i,
    /^post (a )?remote job/i,
    /^remote jobs index$/i,
    /^rss feeds$/i,
    /^remotive jobs public api$/i,
    /^load more/i,
    /^all jobs?$/i
  ],
  'Google Careers': [
    // Top-level nav on the careers site (Teams, Locations, Search jobs, etc.)
    /^teams?$/i,
    /^locations?$/i,
    /^(search|find) (a )?job(s)?$/i,
    /^life at google$/i,
    /^about (us|the company)$/i,
    /^benefits?$/i,
    /^diversity$/i,
    /^apply now$/i,
    /^learn more$/i,
    /^read more$/i,
    /^sign in$/i,
    /^skip to (content|main)/i,
    /^all jobs?$/i
  ],
  ZipRecruiter: [
    // Top-level chrome (Sign In, Apply Now, etc.) and category nav
    /^sign in$/i,
    /^sign up$/i,
    /^apply now$/i,
    /^learn more$/i,
    /^get (matched|notified)$/i,
    /^post (a )?job/i,
    /^for employers$/i,
    /^browse (all )?jobs?$/i,
    /^all jobs?$/i,
    /^salary/i,
    /^companies?$/i,
    /^career advice$/i,
    /^skip to (content|main)/i
  ]
}

export function extractJobUrls(html: string, baseUrl: string, boardName: string): { url: string; title?: string; company?: string }[] {
  // JSON-LD and HTML anchors are complementary, not exclusive. Some
  // boards embed a single org-level `JobPosting` block on a listing
  // page that has nothing to do with the actual list of openings;
  // earlier this short-circuit silently returned just that one
  // bogus posting and dropped every HTML card. Merge both sources
  // and dedup by URL below.
  const jsonLd = extractJsonLdListings(html, baseUrl)

  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
  if (isNonListingPage(html, pageTitle)) return []

  const results: { url: string; title?: string; company?: string }[] = [...jsonLd]
  const seen = new Set<string>(jsonLd.map((j) => j.url.toLowerCase()))
  const base = new URL(baseUrl)
  const boardLower = boardName.toLowerCase()

  const anchorPattern = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1].trim()
    const inner = match[2].replace(/<[^>]+>/g, '').trim()
    if (!href || href === '#' || href.startsWith('javascript:')) continue

    let fullUrl: string
    try {
      fullUrl = new URL(href, base).href
    } catch {
      continue
    }

    const lowerUrl = fullUrl.toLowerCase()
    if (seen.has(lowerUrl)) continue
    seen.add(lowerUrl)

    const knownBoardDomains = /linkedin\.com|indeed\.com|ca\.indeed\.com|monster\.com|ziprecruiter\.com|simplyhired\.com|adzuna\.com|talent\.com|jora\.com|remoteok\.com|weworkremotely\.com|remotive\.com|remote\.co|workingnomads\.com|justremote\.co|jobbank\.gc\.ca|eluta\.ca|workopolis\.com|jobboom\.com|workbc\.ca|careerbeacon\.com|charityvillage\.com|crypto-careers\.com|cryptorecruit\.com|remote3\.co|cryptocurrencyjobs\.co|cryptojobslist\.com|cryptojobs\.com|crypto\.jobs|web3\.career|startup\.jobs|selbyjennings\.com|idealist\.org|builtin\.com|builtintoronto\.com|builtinvancouver\.org|jobs\.vancouver\.ca|google\.com\/about\/careers|careerhound\.io|usebraintrust\.com|hiring\.cafe|sproutjobs\.com|arc\.dev|contra\.com|skipthedrive\.com|jobspresso\.co|dynamitejobs\.com|dailyremote\.com|nodesk\.co|remote100k\.com|rareroles\.com|flexa\.careers|flexjobs\.com|virtualvocations\.com|pangian\.com|powertofly\.com|dice\.com|theladders\.com|workatastartup\.com|careervault\.io|remoterocketship\.com|dribbble\.com|behance\.net|crossover\.com|aijobs\.ai|toptal\.com|upwork\.com|fiverr\.com|gun\.io|freelancer\.com|peopleperhour\.com|hubstaff\.com/
    if (!knownBoardDomains.test(lowerUrl)) continue

    const pathname = new URL(fullUrl).pathname

    // Only filter URLs whose path is clearly navigation/non-job
    if (NAV_PATHS.test(pathname)) continue

    if (boardLower.includes('linkedin')) {
      // Real LinkedIn job URLs have shape
      // /jobs/view/{slug}-at-{company}-{numericId}. The category
      // sub-index pages (e.g. /jobs/engineering-jobs,
      // /jobs/13,000-finance-jobs-in-north-york) also start with
      // /jobs/ but are not real jobs. Requiring /jobs/view/ is the
      // tightest path-level filter that catches both.
      if (!pathname.includes('/jobs/view/')) continue
    } else if (boardLower.includes('indeed')) {
      if (!pathname.includes('/viewjob') && !pathname.includes('/rc/')) continue
    } else if (boardLower.includes('web3.career')) {
      // Real web3.career job URLs are /{company-slug}/{numericId}
      // (e.g. /binance-accelerator-program-marketing-bd-operations-binance/152415).
      // The homepage's nav links (/crypto-jobs, /web3-salaries/nft,
      // /learn-web3/tutorial, /hire/ai, /web3-jobs-oceania) are
      // category/salary pages, not listings — scraping those shells
      // triggers Cloudflare blocks and produces bogus errors.
      if (!/^\/[^/]+\/\d+\/?$/.test(pathname)) continue
    } else if (boardLower.includes('built in')) {
      // Built In job URLs are /job/{slug}/{numericId} (confirmed on
      // builtin.com, builtintoronto.com, and builtinvancouver.org).
      // The listing page's nav and filter links (/jobs?city=...,
      // /jobs/{category}, /jobs/dev-engineering/search/...) are not
      // listings — scraping them triggers Cloudflare blocks.
      if (!/^\/job\/[^/]+\/\d+\/?$/.test(pathname)) continue
    } else if (boardLower.includes('google')) {
      // Google Careers job URLs are
      // /about/careers/applications/jobs/results/{numericJobId}. The
      // search page's filter chips link to named sub-pages
      // (results/ai, results/cloud, results/how-we-hire,
      // applications/eeo) that carry no job data. Require the numeric
      // id segment.
      if (!/^\/about\/careers\/applications\/jobs\/results\/\d+$/.test(pathname)) continue
    } else if (boardLower.includes('ziprecruiter')) {
      // ZipRecruiter per-listing URLs come in two shapes:
      //   /jobs/view/{numericId}            (legacy direct view)
      //   /c/k/{company-slug}/{jobId}       (company directory)
      // The search results page (`/Jobs/{query}`) and the standard
      // search (`/jobs?q=...`) both render cards linking to one of
      // these shapes, so accept either. The /c/k shape needs a minimum
      // of 3 path segments to avoid matching the company index page
      // itself (`/c/k/{slug}` with no job id).
      const isView = pathname.startsWith('/jobs/view/')
      const isCk = pathname.startsWith('/c/k/') && pathname.split('/').filter(Boolean).length >= 3
      if (!isView && !isCk) continue
    } else if (boardLower.includes('dice')) {
      // Dice per-listing URLs: /job-detail/{uuid}
      if (!pathname.startsWith('/job-detail/')) continue
    } else if (boardLower.includes('powertofly')) {
      // PowerToFly per-job URLs are /jobs/detail/{numericId} (confirmed
      // from the jobs sitemap at /common/sitemap/jobs/1.xml). The search
      // page itself lives at /jobs/, so the generic /^\/jobs?/ path match
      // below would admit every filter/nav link on it
      // (/jobs/?keywords=..., /jobs/?primary_skills=..., /jobs/saved) as
      // a "listing" — scraping those shells produced bogus missing-field
      // errors. Require the /jobs/detail/ prefix.
      if (!pathname.startsWith('/jobs/detail/')) continue
    } else if (boardLower.includes('behance')) {
      // Behance per-listing URLs: /joblist/{id}/{slug}
      if (!pathname.startsWith('/joblist/')) continue
    } else if (boardLower.includes('work at a startup')) {
      // Work At A Startup per-company URLs: /companies/{slug}
      if (!pathname.startsWith('/companies/')) continue
    } else if (boardLower.includes('hiring cafe')) {
      // Hiring Cafe job URLs are /job/{slug} (singular) with full
      // static JobPosting content. The listing page's filter chips
      // link to /jobs/{state} and /jobs/{keyword} (plural) — scraping
      // those shells produced missing-description errors. Require the
      // singular /job/ prefix.
      if (!/^\/job\//.test(pathname)) continue
    } else if (boardLower.includes('crossover')) {
      // Crossover job URLs are /jobs/{numericId}/{slug}/{title}. The
      // listing page also links to /jobs/{single-slug} category pages
      // (e.g. /jobs/ai-engineer, /jobs/finance) that carry no
      // JobPosting data. Require the numeric id segment.
      if (!/^\/jobs\/\d+\//.test(pathname)) continue
    } else if (boardLower.includes('remote rocketship')) {
      // Remote Rocketship job URLs are /job/{slug} or
      // /remote-job/{slug}. The search page's category links
      // (/jobs/recruitment/, /jobs/software-engineer/,
      // /jobs/project-manager/) are index pages, not listings —
      // scraping them triggered Cloudflare blocks and camoufox
      // newPage timeouts. Require the singular /job/ or
      // /remote-job/ prefix.
      if (!/^\/(job|remote-job)\//.test(pathname)) continue
    } else if (boardLower.includes('ladders')) {
      // The Ladders listing cards link to /jobs/{companySlug}/{jobId}.
      // Its nav links include /jobs/search-jobs, which is the search
      // page itself, not a listing.
      if (pathname === '/jobs/search-jobs') continue
    } else if (boardLower.includes('dribbble')) {
      // Dribbble jobs live under /jobs/{slug}. The board's nav links
      // to /careers (a Framer careers index) and /job-board are not
      // listings.
      if (pathname === '/careers' || pathname === '/job-board') continue
    } else if (boardLower.includes('freelancer')) {
      // Freelancer per-project URLs: /projects/{slug}
      if (!pathname.startsWith('/projects/')) continue
    } else if (boardLower.includes('peopleperhour')) {
      // PeoplePerHour per-listing URLs: /hire/{slug}
      if (!pathname.startsWith('/hire/')) continue
    } else {
      // Generic branch: require the URL path itself to look like a job
      // (the previous version also accepted links whose visible text
      // mentioned "job"/"career" — too loose, let in nav and category
      // links like Monster's "Browse Jobs" or Remote OK's "💼 Executive
      // jobs"). Per-board BOARD_NAV_TEXT_PATTERNS (looked up below by
      // the canonical board name) catches the cases the path can't.
      //
      // We also accept hash-routed job fragments (e.g. WorkBC's
      // `#/job-details/49898249` or similar `#/job/...`, `#/posting/...`).
      // Hash-routed SPAs keep the listing-page pathname but carry the
      // job id in the fragment, so the path-only regex would drop every
      // real card and only keep links that happen to be real paths.
      const hash = new URL(fullUrl).hash
      // Generic path match. The list was widened from a strict
      // /jobs?|careers? subset to cover the real-world URL patterns
      // used by niche boards: /posting/ (Built In), /position/
      // (Workday), /vacancy|vacancies/ (EU government boards),
      // /role/ (Ashby-style), /opportunity/ (Idealist), /jobid/
      // (some legacy boards). Tighter "exactly /jobs" matches were
      // silently dropping real listings that the user could see by
      // browsing manually.
      const pathMatch =
        /^\/(jobs?|careers?|positions?|opportunities?|postings?|openings?|vacancies?|vacancy|roles?|jobid|job_id|posting|position|opportunity)/i.test(pathname) ||
        pathname.includes('/job/') ||
        /^#\/?(job[-_]?details?|job[-_]?posting|jobs?|posting|find[-_]?jobs?\/job|postings?)\b/i.test(hash)
      if (!pathMatch) continue
    }

    // Per-board nav-text denylist: drop links whose visible text is
    // known header / nav / footer / category-index / search-suggestion
    // text. Applied AFTER the path check so real listings aren't lost
    // when a board's denylist happens to overlap a legitimate title
    // (e.g. Remotive's "Finance" category vs a job titled "Finance
    // Manager" — the latter is a real listing, the former has a
    // different path and was already dropped by the path check above).
    const navPatterns = BOARD_NAV_TEXT_PATTERNS[boardName]
    if (navPatterns && navPatterns.some((re) => re.test(inner))) continue

    if (inner.length > 2 && inner.length < 300) {
      results.push({ url: fullUrl, title: inner })
    }
  }

  return results
}

function matchesWorkType(text: string, workType: WorkType): boolean {
  if (workType === 'any') return true
  const lower = text.toLowerCase()
  const isRemote = /remote|work from home|wfh|100% remote|fully remote|remote.first|distributed team|anywhere/.test(lower)
  const isHybrid = /hybrid|flexible|mix of remote|remote.office|in.office.and.remote/.test(lower) && !isRemote
  const isInOffice = /on.?site|in.?office|in.person|office.based|at our (headquarters|office|location)/.test(lower)
  if (workType === 'remote') return isRemote
  if (workType === 'hybrid') return isHybrid
  if (workType === 'in_office') return isInOffice || (!isRemote && !isHybrid)
  return true
}

/**
 * Resolve the user-supplied location list for a scan, returning a
 * normalized, deduped array of LocationPick. `fromFilters` wins when
 * present; otherwise `fromSettings`. Returns [] when both are empty,
 * which callers treat as "no location filter".
 *
 * Normalization: trim each display, drop empty entries, dedup picks by
 * id (first occurrence wins) and free-text entries by case-folded
 * display. A single full location like "Vancouver, British Columbia,
 * Canada" is preserved as-is — internal commas are not separators.
 */
export function normalizeLocations(
  fromFilters: LocationPick[] | undefined,
  fromSettings: LocationPick[] | undefined
): LocationPick[] {
  const source = fromFilters ?? fromSettings ?? []
  const seenIds = new Set<string>()
  const seenDisplay = new Set<string>()
  const out: LocationPick[] = []
  for (const raw of source) {
    const display = raw.display.trim()
    if (!display) continue
    if (raw.id) {
      if (seenIds.has(raw.id)) continue
      seenIds.add(raw.id)
      out.push({ id: raw.id, display })
    } else {
      const key = display.toLowerCase()
      if (seenDisplay.has(key)) continue
      seenDisplay.add(key)
      out.push({ display })
    }
  }
  return out
}

/**
 * Parse the JSON-encoded `job_search_locations` setting into a
 * LocationPick[]. Returns [] on any failure (empty string, invalid
 * JSON, wrong shape, missing display) so callers can recover silently
 * and let the user re-pick.
 */
export function parseLocationPicks(raw: string | null | undefined): LocationPick[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is LocationPick =>
        !!p && typeof p === 'object' && typeof (p as LocationPick).display === 'string'
    )
  } catch {
    return []
  }
}

function matchesLocation(jobLocation: string | null, filterLocation: string): boolean {
  if (!filterLocation) return true
  if (!jobLocation) return false
  const jl = jobLocation.toLowerCase()
  const fl = filterLocation.toLowerCase()
  return jl.includes(fl) || fl.includes(jl)
}

const scoreLimiter = createLimiter<unknown>(LLM_SCAN_CONCURRENCY)

async function fetchAndScore(url: string, baseCv: string, seenUrlsSet: Set<string>, scanSeenUrlsSet: Set<string>, workType: WorkType, filterLocation: string | undefined, signal: AbortSignal | undefined): Promise<{ action: 'added' | 'skipped' | 'incompatible' | 'error'; job?: Job; reason?: string }> {
  const dk = dedupKey(url)
  if (seenUrlsSet.has(dk)) return { action: 'skipped', reason: 'Already in database' }

  let input: CreateJobInput
  try {
    input = await scrapeJobFromUrl(url)
  } catch (err) {
    return { action: 'error', reason: `Scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }

  if (!input.title || !input.company || !input.description) {
    return { action: 'error', reason: 'Missing required fields' }
  }

  // Duplicate check by URL (normalized) and company+title
  if (findDuplicateJob({ ...input, url: input.url || url })) {
    seenUrlsSet.add(dk)
    return { action: 'skipped', reason: 'Duplicate (already exists by URL or company+title)' }
  }

  if (!matchesWorkType(`${input.title  } ${  input.description}`, workType)) {
    return { action: 'incompatible', reason: `Work type filter: ${workType}` }
  }

  if (!matchesLocation(input.location || null, filterLocation || '')) {
    return { action: 'incompatible', reason: `Location filter: ${filterLocation}` }
  }

  const desc = input.description || ''
  // LLM scorer handles education/years contextually; we no longer hard-reject here.
  // We still call the LLM scorer for every job that passes the cheap filters above.

  // Heuristic pre-filter: cheap keyword-overlap score before paying for
  // an LLM call. Listings that obviously don't match the user's CV
  // (different domain, junior roles, etc.) skip the LLM and are
  // persisted with score=null + a note. The user can re-score any
  // listing via the per-job "Recompute Fit" button, which uses the
  // same scoreJobFit under the hood.
  const heuristicScore = scoreCompatibility(input.title, desc, baseCv)
  if (baseCv && heuristicScore < HEURISTIC_FLOOR) {
    try {
      const { job } = createJob({
        ...input,
        score: null,
        fit_rationale: 'Pre-filtered by heuristic (low keyword overlap)',
        fit_breakdown: null,
        fit_score_version: null,
        fit_last_error: null
      })
      seenUrlsSet.add(dk)
      scanSeenUrlsSet.add(dk)
      return { action: 'added', job }
    } catch (err) {
      if (err instanceof JobBlacklistedError) return { action: 'skipped', reason: 'Previously deleted with low fit' }
      if (err instanceof JobDuplicateError) return { action: 'skipped', reason: 'Duplicate (race-guard)' }
      throw err
    }
  }

  let fit
  try {
    // Cap LLM concurrency at LLM_SCAN_CONCURRENCY (2) so a single
    // scan doesn't fire 6 LLM requests in parallel and trip
    // provider rate limits. The queue is bounded; new requests
    // queue until a slot frees up. The scan's AbortSignal
    // propagates so cancel feels immediate.
    const tLlm0 = Date.now()
    fit = (await scoreLimiter(() => scoreJobFit({
      title: input.title,
      description: input.description || null,
      requirements: input.requirements || null,
      baseCv
    }, signal), signal)) as Awaited<ReturnType<typeof scoreJobFit>>
    if (process.env.FLOW_JOB_SCAN_TIMING) {
      log.info(`stage=llm-score source=${fit.source} score=${fit.score?.toFixed(3)} ms=${Date.now() - tLlm0}`)
    }
  } catch {
    fit = {
      score: heuristicScore,
      rationale: 'Heuristic fallback after LLM error.',
      breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
      source: 'heuristic' as const
    }
  }

  if (fit.source === 'llm' && fit.score < 0.08) {
    // Only reject on a low score when we actually have one. Heuristic
    // fallbacks are noisy and would cause us to silently drop good jobs
    // whenever the LLM scorer is misconfigured.
    return { action: 'incompatible', reason: `Score ${fit.score.toFixed(2)} < 0.08` }
  }

  if (fit.source === 'llm' && fit.score < 0.3) {
    // Low-Fit per the user's threshold — same cut-off the rest of the app
    // uses (JobsPage fit label, deleted_jobs blacklist). Heuristic
    // fallbacks stay eligible so a misconfigured LLM doesn't silently
    // drop real matches.
    return { action: 'incompatible', reason: `Score ${fit.score.toFixed(2)} < 0.3` }
  }

  try {
    const isHeuristic = fit.source === 'heuristic'
    const { job } = createJob({
      ...input,
      // Heuristic fallbacks must NEVER be persisted as a real fit score.
      // The team policy is: if the LLM is broken, leave score null and set
      // fit_last_error so the user can see why. Otherwise we silently lock
      // in a misleading keyword-overlap number and the job is never
      // re-scored (fit_score_version bumps to current).
      ...(isHeuristic
        ? {
            score: null,
            fit_rationale: null,
            fit_breakdown: null,
            fit_score_version: null
          }
        : {
            score: fit.score,
            fit_rationale: fit.rationale,
            fit_breakdown: fit.breakdown,
            fit_score_version: getSettings().cv_version ?? 0
          }),
      fit_last_error: isHeuristic ? (fit.error || 'LLM scorer fell back to heuristic.') : null
    })
    // Update in-memory dedup sets so concurrent calls see this URL as already-processed
    seenUrlsSet.add(dk)
    scanSeenUrlsSet.add(dk)
    return { action: 'added', job }
  } catch (err) {
    if (err instanceof JobBlacklistedError) {
      return { action: 'skipped', reason: 'Previously deleted with low fit' }
    }
    if (err instanceof JobDuplicateError) {
      // Race: another concurrent scan call won the dedupe race. Not an error.
      return { action: 'skipped', reason: 'Duplicate (race lost)' }
    }
    return { action: 'error', reason: `Create failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }
}

// Consecutive-blocked bailout state machine. A batch counts as fully
// blocked only when EVERY listing in it errored; any healthy listing
// (added / skipped / incompatible) resets the streak. Error actions
// count regardless of their reason — a blocked board fails
// heterogeneously (timeout, abort, empty shell, Cloudflare) — with one
// exception: a `Create failed` reason is a DB write failure, meaning
// the board is fine and our database broke, and would trip the guard
// falsely. Returns the new consecutive-blocked counter for the batch.
export function nextConsecutiveBlocked(
  results: PromiseSettledResult<{ action: 'added' | 'skipped' | 'incompatible' | 'error'; reason?: string }>[],
  consecutiveBlocked: number
): number {
  let batchBlocked = 0
  for (const r of results) {
    if (r.status === 'rejected') continue
    const { action, reason } = r.value
    if (action === 'error' && reason && !/^create failed/i.test(reason)) {
      batchBlocked++
    }
  }
  return batchBlocked === results.length && batchBlocked > 0
    ? consecutiveBlocked + 1
    : 0
}

export async function scanAllBoards(
  filters?: ScanFilters,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  onCounters?: (counters: Pick<ScanResult, 'totalFound' | 'totalAdded' | 'totalSkipped' | 'totalIncompatible' | 'totalErrors'>) => void
): Promise<ScanResult> {
  const settings = getSettings()
  const keywords = (filters?.keywords || settings.job_search_keywords || '').trim()
  // Resolve the location list from filters → settings → empty. Each
  // entry is one full location (e.g. "Vancouver, British Columbia,
  // Canada") — internal commas are not separators. The list is
  // normalized for trim + dedup before iteration.
  const settingsLocations = parseLocationPicks(settings.job_search_locations)
  const locations: LocationPick[] = normalizeLocations(
    filters?.locations,
    settingsLocations
  )
  const workType = filters?.workType || 'any'
  const baseCv = settings.base_cv || ''

  const existingJobs = listJobs()
  const seenUrls = new Set(getSeenUrls().map(dedupKey))
  const scanSeenUrls = new Set<string>()

  // Boards that hit the consecutive-blocked bailout for this run.
  // processBoard early-returns for them so a multi-location scan
  // doesn't re-grind a WAF-blocked board once per location (observed:
  // two identical ~2h CharityVillage grinds at 15:25 and 16:09).
  const blockedBoards = new Set<string>()

  const startedAt = Date.now()
  const result: ScanResult = { totalFound: 0, totalAdded: 0, totalSkipped: 0, totalErrors: 0, totalIncompatible: 0, boards: [], errors: [], startedAt, durationMs: 0, cancelled: false, addedJobs: [] }
  const _seenProgress = new Set<string>()
  const progress = (msg: string) => {
    if (_seenProgress.has(msg)) return
    _seenProgress.add(msg)
    ;(onProgress || ((_: string) => {}))(msg)
  }
  // Emit the live counter snapshot to the renderer so the scan-in-progress
  // card can show "Found / Added / Skipped / Incompatible / Errors" ticking
  // in real time instead of only at completion. The snapshot only carries
  // the 5 totals (not the per-board breakdown) — the renderer-side table
  // re-derives the per-board view from the final result on scan:complete.
  // Cheap to call: it's a reference, and the renderer throttles its own
  // re-renders via setState batching.
  //
  // `bump()` is the only sanctioned way to mutate the totals — every
  // counter site uses it so the live emit can never be skipped. Falls
  // back to a direct mutation when no onCounters callback is wired
  // (e.g. the existing direct callers / unit tests).
  const bump = (field: 'totalAdded' | 'totalSkipped' | 'totalIncompatible' | 'totalErrors', amount = 1) => {
    result[field] += amount
    if (onCounters) {
      onCounters({
        totalFound: result.totalFound,
        totalAdded: result.totalAdded,
        totalSkipped: result.totalSkipped,
        totalIncompatible: result.totalIncompatible,
        totalErrors: result.totalErrors,
      })
    }
  }
  // Same shape as `bump` but for the board-level totalFound, which is
  // set once per board (not per listing). Emits so the live "Found"
  // counter ticks up at the same moment "Scraping …" is shown.
  const bumpFound = (n: number) => {
    result.totalFound += n
    if (onCounters) {
      onCounters({
        totalFound: result.totalFound,
        totalAdded: result.totalAdded,
        totalSkipped: result.totalSkipped,
        totalIncompatible: result.totalIncompatible,
        totalErrors: result.totalErrors
      })
    }
  }

  const LISTING_CONCURRENCY = 6

  // Maximum pages to follow for paginated boards. 50 covers the long
  // tail of a single search query on boards that paginate via a fixed
  // page-number URL (e.g. NH/IH, which list ~1.7k jobs ≈ 170 pages at
  // 10 per page). Boards that define their own `paginate` driver ignore
  // this cap and stop on empty-page detection or signal abort instead.
  const MAX_PAGES = 50

  /**
   * Fetch the search-results HTML for a board, paginating if the board
   * needs it.
   *
   *   - WorkBC: hash-routed SPA, driven by `paginateHtmlViaBrowser` with
   *     `MAX_PAGES` cap (the SPA needs a real browser to re-render on
   *     hash change).
   *   - Boards with a custom `paginate` driver (e.g. NH/IH): each URL
   *     is plain-fetched and concatenated. The driver decides when to
   *     stop; this loop breaks on empty page or signal abort.
   *   - Default: single fetch, same as before.
   */
  async function fetchBoardListingsHtml(searchUrl: string, board: BoardConfig, signal?: AbortSignal, locTag = ''): Promise<string> {
    if (board.name === 'WorkBC') {
      // WorkBC's search-results page is `/find-job/search-jobs#/job-search;...`.
      // The hash carries `q`, `city`, and `page`. Build the hashes for pages
      // 2..MAX_PAGES by string-replacing the `page=N` segment.
      const baseUrl = 'https://www.workbc.ca/find-job/search-jobs'
      const baseHash = new URL(searchUrl).hash.replace(/^#/, '')
      // Strip any existing ;page=N; segment from the base hash so we can
      // append our own page numbers.
      const baseNoPage = baseHash.replace(/;page=\d+/g, '')
      const pageHashes: string[] = []
      for (let p = 2; p <= MAX_PAGES; p++) {
        pageHashes.push(`#${baseNoPage};page=${p}`)
      }
      return paginateHtmlViaBrowser(baseUrl, pageHashes, 3000, { signal })
    }

    if (board.paginate) {
      const firstPage = await fetchPageHtml(searchUrl, board.useBrowser, signal)
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const chunks: string[] = [firstPage]
      // Generic paginate driver (NH, IH, etc.). Walk pages in
      // windows of PARALLEL_PAGINATE in parallel — each page is
      // 1-2s and NH/IH alone can be 170+ pages, so 4-way parallel
      // cuts wall time to ~25%. Order is preserved (we await the
      // window in order, not the individual fetches). Stop the
      // moment any page is short (< 500 bytes = end of listing) or
      // any fetch throws. MAX_PAGES_PER_BOARD caps total iterations
      // for safety; the natural terminator is the short-page check.
      const PARALLEL_PAGINATE = 4
      // Raised from 80 to 200: NH/IH unfiltered has ~170 pages
      // (1700 jobs at 10/page). 200 covers all of them with
      // headroom. The < 500-byte stop is the primary terminator;
      // this cap is a safety belt for runaway boards.
      const MAX_PAGES_PER_BOARD = 200
      let lastReportedPage = 0
      let stopped = false
      for (let p = 1; p < MAX_PAGES_PER_BOARD && !stopped; p += PARALLEL_PAGINATE) {
        if (signal?.aborted) break
        const window: number[] = []
        for (let k = 0; k < PARALLEL_PAGINATE && p + k < MAX_PAGES_PER_BOARD; k++) {
          window.push(p + k)
        }
        const results = await Promise.all(window.map(async (pageNum) => {
          if (signal?.aborted) return { pageNum, html: '' }
          const url = board.paginate!(searchUrl, pageNum)
          if (!url) return { pageNum, html: '' }
          try {
            const html = await fetchPageHtml(url, board.useBrowser, signal)
            return { pageNum, html }
          } catch (err) {
            log.warn(`${board.name} page ${url} failed:`, err)
            return { pageNum, html: '', error: true as const }
          }
        }))
        // Process the window in order so a short page in the middle
        // stops the rest. The short page itself is the natural
        // terminator ("we've reached the end").
        for (const r of results) {
          if (r.error) { stopped = true; break }
          if (r.html === '' && board.paginate(searchUrl, r.pageNum) !== '') { stopped = true; break }
          if (r.html.length < 500) { stopped = true; break }
          chunks.push(r.html)
          if (r.pageNum === 1 || r.pageNum - lastReportedPage >= 5) {
            // Retire the previously reported page line so only the
            // current page shows while the board is being scanned.
            // The locTag keeps page lines on the same board identity
            // as the board's "Scanning X..." line, so the board's
            // end marker cleans up the final page line too.
            if (lastReportedPage > 0) {
              progress(`\u0000end:Scanning ${board.name}${locTag}... page ${lastReportedPage + 1}`)
            }
            progress(`Scanning ${board.name}${locTag}... page ${r.pageNum + 1}`)
            lastReportedPage = r.pageNum
          }
        }
      }
      return chunks.join('\n')
    }

    return fetchPageHtml(searchUrl, board.useBrowser, signal)
  }

  async function processBoard(board: BoardConfig, location: string, signal?: AbortSignal): Promise<ScanBoardResult> {
    if (blockedBoards.has(board.name)) {
      log.warn(`${board.name}: skipping (blocked in an earlier location this run)`)
      return { board: board.name, found: 0, added: 0, skipped: 0, errors: 0, incompatible: 0 }
    }
    const br: ScanBoardResult = { board: board.name, found: 0, added: 0, skipped: 0, errors: 0, incompatible: 0 }
    // Hoisted out of the try so the end marker below can reuse it. The
    // \u0000end: marker pairs with the board's "Scanning X..." start line;
    // the renderer retires that line (and its per-page variants) from the
    // scan-in-progress card the moment the board stops being scanned.
    const locTag = location ? ` (${location})` : ''
    try {
      progress(`Scanning ${board.name}${locTag}...`)

      // First-party API path. When a board exposes a structured
      // API (Adzuna, Greenhouse, etc.), the fetcher returns ready-
      // to-insert jobs that skip the listing/scrape/score funnel
      // entirely. We still apply the same work-type/location/dup
      // guards and the LLM scoreJobFit heuristic pre-filter via
      // createJob's path; the difference is that the listing page
      // and the per-job scrape are gone.
      if (board.apiFetcher) {
        const tApi0 = Date.now()
        const apiJobs = await board.apiFetcher(keywords, location, signal)
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          log.info(`stage=api board=${board.name} jobs=${apiJobs.length} ms=${Date.now() - tApi0}`)
        }
        br.found = apiJobs.length
        // Bump totalFound the moment we know the board's listing count —
        // BEFORE the per-listing loop. The per-listing bumps then
        // accumulate against an already-correct denominator, so the
        // live "Found / Added / Skipped / Incompatible / Errors" line
        // never shows per-listing counters exceeding Found. The
        // end-of-board bumpFound was removed for the same reason
        // (it would double-count and make the lag worse on long
        // boards).
        bumpFound(br.found)
        let added = 0
        for (const input of apiJobs) {
          if (signal?.aborted) break
          const dk = input.url ? dedupKey(input.url) : null
          if (dk) {
            if (seenUrls.has(dk)) { br.skipped++; bump('totalSkipped'); continue }
            if (scanSeenUrls.has(dk)) { br.skipped++; bump('totalSkipped'); continue }
          }
          if (findDuplicateJob(input)) {
            if (dk) seenUrls.add(dk)
            br.skipped++; bump('totalSkipped')
            continue
          }
          if (!matchesWorkType(`${input.title} ${input.description ?? ''}`, workType)) {
            br.incompatible++; bump('totalIncompatible'); continue
          }
          if (!matchesLocation(input.location ?? null, location)) {
            br.incompatible++; bump('totalIncompatible'); continue
          }
          try {
            const heuristicScore = scoreCompatibility(input.title, input.description ?? '', baseCv)
            const { job } = createJob({
              ...input,
              ...(baseCv && heuristicScore < HEURISTIC_FLOOR
                ? { score: null, fit_rationale: 'Pre-filtered by heuristic (low keyword overlap)', fit_breakdown: null, fit_score_version: null, fit_last_error: null }
                : { score: null, fit_rationale: null, fit_breakdown: null, fit_score_version: null, fit_last_error: null })
            })
            if (dk) { seenUrls.add(dk); scanSeenUrls.add(dk) }
            added++
            br.added++
            bump('totalAdded')
            result.addedJobs.push({ id: job.id, title: decodeEntities(job.title), company: decodeEntities(job.company) })
            progress(`✓ Added ${decodeEntities(job.company)} — ${decodeEntities(job.title)}`)
          } catch (err) {
            if (err instanceof JobBlacklistedError) { br.skipped++; bump('totalSkipped') }
            else if (err instanceof JobDuplicateError) { br.skipped++; bump('totalSkipped') }
            else { br.errors++; bump('totalErrors') }
          }
        }
        // No trailing bumpFound here — see the comment above br.found.
        result.boards.push(br)
        // This path returns early, so the board's end marker goes here —
        // otherwise the "Scanning X..." line would stick on the
        // scan-in-progress card for the rest of the scan.
        progress(`\u0000end:Scanning ${board.name}${locTag}...`)
        return br
      }

      // Sitemap-listing boards (e.g. CharityVillage) skip the search-
      // results page entirely — its HTML is discarded and the per-job
      // URLs come straight from the sitemap. Fetching it anyway wastes
      // a request and can trip the board's WAF (Cloudflare blocks the
      // /jobs/ search page, surfacing a bogus board error in the scan).
      const sitemapSource = !!board.sitemapListingUrls
      const searchUrl = sitemapSource ? '' : board.searchUrl(keywords, location)
      const tFetch0 = Date.now()
      const html = sitemapSource ? '' : await fetchBoardListingsHtml(searchUrl, board, signal, locTag)
      if (process.env.FLOW_JOB_SCAN_TIMING) {
        log.info(`stage=board-fetch board=${board.name} bytes=${html.length} ms=${Date.now() - tFetch0}`)
      }

      progress(`Parsing listings from ${board.name}${locTag}...`)
      const tParse0 = Date.now()
      let listings: { url: string; title?: string; company?: string }[] = []
      if (board.sitemapListingUrls) {
        // Sitemap-listing source. The board's search-results page
        // is JS-rendered and useless to the static extractor, but
        // the same site still publishes a `<loc>`-style XML sitemap
        // with the per-job URLs. Skip the search-page extractJobUrls
        // path; build the listings array from the sitemap function
        // and fall into the same dedup/batch/per-listing loop as the
        // search-page branch. The per-listing scraper fills in
        // title + company from each per-job page's JSON-LD / HTML.
        progress(`Fetching sitemap for ${board.name}${locTag}...`)
        const urls = await board.sitemapListingUrls(keywords, location, signal)
        // Cap the head of the sitemap (listed newest-first) so the scan
        // doesn't grind through the site's ENTIRE history — DailyRemote's
        // sitemap is ~225k URLs, NoDesk's ~15k. Un-capped, the host
        // rate-limits after ~2k scrapes and the blocked-bailout counts
        // every untouched listing as an error (223k phantom errors).
        listings = urls.slice(0, MAX_SITEMAP_LISTINGS).map((url) => ({ url }))
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          log.info(`stage=parse board=${board.name} listings=${listings.length} (sitemap) ms=${Date.now() - tParse0}`)
        }
      } else {
        listings = extractJobUrls(html, searchUrl, board.name)
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          log.info(`stage=parse board=${board.name} listings=${listings.length} ms=${Date.now() - tParse0}`)
        }
      }
      br.found = listings.length
      // Bump totalFound the moment we know the board's listing count —
      // BEFORE the listing filter and per-listing loop. Same reasoning
      // as the API path: the per-listing bumps then accumulate against
      // a correct denominator so the live counters never exceed Found.
      bumpFound(br.found)

      // Dedup listings by normalized URL and by company+title combo
      const seenTitleCompany = new Set<string>()
      listings = listings.filter(l => {
        const dk = dedupKey(l.url)
        // Listing-level dedup hits must increment br.skipped + totalSkipped
        // so the card header (Found / Added / Skipped / Incompatible / Errors)
        // sums to br.found. Without this, listings dropped here count toward
        // `Found` but land in no category — leaving a permanent gap in the
        // tally. The API path (above) handles its dedup branches the same
        // way; this path was missed on the original landing.
        if (scanSeenUrls.has(dk)) {
          br.skipped++
          bump('totalSkipped')
          return false
        }
        scanSeenUrls.add(dk)
        if (seenUrls.has(dk)) {
          br.skipped++
          // Mirror the API-path behaviour (line 1203): every per-listing
          // skip must go through bump() so the live counters sum to
          // br.found. This branch was missed when the listing filter
          // was first given a counter increment — the user-visible
          // symptom was "Found grows faster than Skipped" on scans
          // where many URLs are already in the persistent seen-URLs
          // set from previous runs.
          bump('totalSkipped')
          return false
        }
        // Dedup by company+title within the same board
        if (l.title && l.company) {
          const tcKey = (`${l.company  }||${  l.title}`).toLowerCase()
          if (seenTitleCompany.has(tcKey)) {
            br.skipped++
            bump('totalSkipped')
            return false
          }
          seenTitleCompany.add(tcKey)
        }
        return true
      })

      const batches: typeof listings[] = []
      for (let i = 0; i < listings.length; i += LISTING_CONCURRENCY) {
        batches.push(listings.slice(i, i + LISTING_CONCURRENCY))
      }

      // Consecutive-blocked guard. When a board's per-listing pages are
      // systematically blocked (e.g. CharityVillage's Cloudflare WAF now
      // challenges every /job/ URL), each scrape burns time in the
      // browser fallback chain before failing. Grinding through all of a
      // board's listings turns a 5-minute scan into hours of wall time.
      // After MAX_CONSECUTIVE_BLOCKED fully-errored batches (~18 listings
      // at LISTING_CONCURRENCY=6), bail out of the board and count the
      // untouched listings as errors (same accounting as the board-level
      // catch below). Counting ANY errored batch — not just ones whose
      // reasons match a blocked signature — matters because a blocked
      // board fails heterogeneously (timeouts, NS_ERROR_ABORT, empty
      // shells, Cloudflare); the old narrow regex starved the guard for
      // hours. `Create failed` DB errors are excluded so a healthy board
      // with a broken database doesn't look blocked.
      const MAX_CONSECUTIVE_BLOCKED = 3
      let consecutiveBlocked = 0
      let blockedBailout = false
      let processed = 0

      for (const batch of batches) {
        if (signal?.aborted) break
        if (blockedBailout) break
        // Polite-crawl jitter: one short sleep at the start of each
        // batch instead of one per listing. The old per-listing
        // sleep serialized 6 listings × 350ms = 2.1s of dead time
        // per batch. Browser boards still want this to avoid
        // hammering the host; HTTP-only boards can skip it
        // (Node's fetch with `connection: keep-alive` doesn't need
        // the same politeness as a fresh BrowserWindow).
        if (board.useBrowser) {
          await new Promise(r => setTimeout(r, 200 + Math.random() * 300))
        }
        // Race the batch against the abort signal and a watchdog
        // timeout. If the user cancels mid-batch, we don't wait for
        // the in-flight listings to finish; we drop whatever hasn't
        // settled yet and bail out. The settled values for
        // already-completed listings in this batch are discarded
        // (since the per-listing accounting happens after the await).
        // The outer board loop's `signal.aborted` check picks up the
        // cancellation on the next iteration.
        //
        // The watchdog distinguishes itself from a cancel by the
        // signal not being aborted: a batch that outlives
        // BATCH_TIMEOUT_MS is treated as a blocked batch — it's
        // logged, counted as errors via the uncategorized accounting
        // below, and the board is bailed out (and skipped for later
        // locations). This is the backstop that guarantees a wedged
        // listing can't freeze the whole scan even if a per-op
        // timeout is ever missed.
        let batchTimer: ReturnType<typeof setTimeout> | undefined
        const settled = await Promise.race([
          Promise.allSettled(
            batch.map(async (l) => {
              progress(`Scraping ${board.name}${locTag} — ${decodeEntities(l.company || l.title || l.url)}`)
              return fetchAndScore(l.url, baseCv, seenUrls, scanSeenUrls, workType, location, signal)
            })
          ),
          abortPromise(signal).then(() => null),
          new Promise<null>((resolve) => {
            batchTimer = setTimeout(() => resolve(null), BATCH_TIMEOUT_MS)
          })
        ])
        if (batchTimer) clearTimeout(batchTimer)
        if (settled === null) {
          if (!signal?.aborted) {
            blockedBailout = true
            blockedBoards.add(board.name)
            log.warn(`${board.name}: batch timed out after ${BATCH_TIMEOUT_MS / 60000}min; skipping remaining ${listings.length - processed - batch.length} listings`)
          }
          break
        }
        const results = settled
        processed += results.length
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value.action === 'added') {
              br.added++
              bump('totalAdded')
              if (r.value.job) {
                result.addedJobs.push({
                  id: r.value.job.id,
                  title: decodeEntities(r.value.job.title),
                  company: decodeEntities(r.value.job.company)
                })
                progress(`✓ Added ${decodeEntities(r.value.job.company)} — ${decodeEntities(r.value.job.title)}`)
              }
            } else if (r.value.action === 'skipped') {
              br.skipped++
              bump('totalSkipped')
            } else if (r.value.action === 'incompatible') {
              br.incompatible++
              bump('totalIncompatible')
            } else if (r.value.action === 'error') {
              // Per-listing scrape/duplicate error: surfaced separately from
              // skipped so the user can see whether listings are being
              // dropped because of fit/duplicate filters vs. genuine scrape
              // failures. The 4-arg summary line in the UI shows both.
              br.errors++
              bump('totalErrors')
            }
          } else {
            br.errors++
            bump('totalErrors')
          }
        }
        consecutiveBlocked = nextConsecutiveBlocked(results, consecutiveBlocked)
        if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED) {
          blockedBailout = true
          blockedBoards.add(board.name)
          log.warn(`${board.name}: ${consecutiveBlocked} consecutive batches blocked by anti-bot protection; skipping remaining ${listings.length - processed} listings`)
          break
        }
      }
      // If the blocked-bailout skipped over untouched listings, count them
      // as errors so the tally (Found / Added / Skipped / Incompatible /
      // Errors) still sums to Found — same pattern as the board-level catch.
      const uncategorized = br.found - (br.added + br.skipped + br.incompatible + br.errors)
      if (blockedBailout && uncategorized > 0) {
        br.errors += uncategorized
        bump('totalErrors', uncategorized)
      }
      // No trailing bumpFound — see the comment at br.found above.
    } catch (err) {
      br.error = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`${board.name}: ${br.error}`)
      // Board-level error: the per-listing loop threw before
      // categorizing every listing. totalFound was already bumped
      // (bumpFound fires at the start of the pass, before the loop),
      // so the per-listing counters are missing whatever the loop
      // didn't get to. Count those as errors so Found / Added /
      // Skipped / Incompatible / Errors still sums to Found at scan
      // end. Without this, a board that errors mid-loop leaves a
      // permanent gap in the live tally.
      const uncategorized = br.found - (br.added + br.skipped + br.incompatible + br.errors)
      if (uncategorized > 0) {
        br.errors += uncategorized
        bump('totalErrors', uncategorized)
      }
    }
    result.boards.push(br)
    // Retire the board's "Scanning X..." line (and any per-page
    // variants) in the renderer's in-progress card now that the board
    // is done — success, error, or abort all land here.
    progress(`\u0000end:Scanning ${board.name}${locTag}...`)
    return br
  }

  // Process boards split into two parallel tracks: HTTP-only boards
  // can run much wider (cheap I/O, no Chrome process) than browser
  // boards (each opens a fresh BrowserWindow). Running them
  // separately means a slow browser board doesn't block HTTP boards
  // for the same location, and vice versa. The browser cap is held
  // low because each concurrent browser session is a Chrome process
  // (~200MB+) and macOS throttles beyond ~5-6. The concurrency values
  // live in scanEstimate.ts so the estimator shares them.
  const selectedBoards = (() => {
    const explicit = filters?.boards && filters.boards.length > 0
      ? BOARDS.filter((b) => filters.boards!.includes(b.name))
      : BOARDS
    // Defence-in-depth: also drop boards the user has disabled in
    // Settings > Boards, regardless of whether the renderer's picker
    // was stale. The renderer filters too, but the main process is the
    // actual enforcement point — a stale persisted selection or a
    // hand-crafted IPC call can't bypass the user-visible toggle.
    const disabled = new Set((settings.disabled_boards || []) as string[])
    return explicit.filter((b) => !disabled.has(b.name))
  })()
  const httpBoards = selectedBoards.filter((b) => !b.useBrowser)
  const browserBoards = selectedBoards.filter((b) => b.useBrowser)
  // Track per-board totals across locations for health recording
  const boardTotals = new Map<string, { found: number; errored: boolean }>()
  // Per-board accumulated scan time (ms) across all locations, used for
  // the scan-time estimate. Recorded even for errored/blocked boards.
  const boardScanMs = new Map<string, number>()
  if (locations.length > 0) {
    const shown = locations.slice(0, 3).map(p => p.display).join(', ')
    const more = locations.length > 3 ? `, +${locations.length - 3} more` : ''
    progress(`Scanning ${locations.length} location(s): ${shown}${more}`)
  }
  for (let locIdx = 0; locIdx < locations.length; locIdx++) {
    const pick = locations[locIdx]
    const location = pick.display
    const locTag = locations.length > 1
      ? ` (loc ${locIdx + 1}/${locations.length} — ${location})`
      : (location ? ` (${location})` : '')
    if (signal?.aborted) break

    async function runTrack(track: BoardConfig[], concurrency: number, trackName: 'http' | 'browser') {
      for (let i = 0; i < track.length; i += concurrency) {
        if (signal?.aborted) break
        const chunk = track.slice(i, i + concurrency)
        const t0 = Date.now()
        const results = await Promise.allSettled(chunk.map(async (board) => {
          const start = Date.now()
          try {
            return await processBoard(board, location, signal)
          } finally {
            boardScanMs.set(board.name, (boardScanMs.get(board.name) ?? 0) + (Date.now() - start))
          }
        }))
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          const elapsed = Date.now() - t0
          log.info(`track=${trackName} chunk=[${chunk.map(b => b.name).join(',')}] ms=${elapsed}`)
        }
        for (let j = 0; j < results.length; j++) {
          const r = results[j]
          const boardName = chunk[j].name
          const totals = boardTotals.get(boardName) || { found: 0, errored: false }
          if (r.status === 'fulfilled') {
            totals.found += r.value.found
            if (r.value.error) totals.errored = true
          } else {
            totals.errored = true
          }
          boardTotals.set(boardName, totals)
        }
      }
    }

    // Both tracks run in parallel for the same location, so a slow
    // browser board never gates the HTTP track (and vice versa).
    await Promise.allSettled([
      runTrack(httpBoards, BOARD_CONCURRENCY_HTTP, 'http'),
      runTrack(browserBoards, BOARD_CONCURRENCY_BROWSER, 'browser')
    ])

    if (signal?.aborted) {
      result.cancelled = true
      break
    }
  }
  // Record per-board health (-1 means errored with no listings)
  for (const [name, totals] of boardTotals) {
    recordBoardResults(name, totals.errored && totals.found === 0 ? -1 : totals.found)
  }
  // Record per-board scan times for the estimate. Skipped on cancel —
  // a partial run would poison the averages with artificially short times.
  if (!result.cancelled) {
    for (const [name, ms] of boardScanMs) {
      recordBoardScanTime(name, ms)
    }
  }

  // Filter out boards with no activity from the returned result (we already
  // deduped in the frontend, but keep this consistent server-side)
  result.boards = result.boards.filter(
    (b) => b.found > 0 || b.added > 0 || b.skipped > 0 || !!b.error
  )

  result.durationMs = Date.now() - startedAt

  // Auto-tailor on scan (Task 3). When the user has the feature on and
  // the job's fit score clears the configured minimum, queue a
  // tailor_job_docs task for each admitted job. The 50/25 guardrail:
  // if more than 50 jobs pass the match filters in a single scan, only
  // the top 25 (by fit score) get auto-tailored — the rest must be
  // handled via the Quick Apply row action. The cap_hit log line is
  // what surfaces the toast in the renderer.
  if (settings.auto_tailor_on_scan && result.addedJobs.length > 0) {
    let autoTailorEligible = result.addedJobs
    if (result.addedJobs.length > 50) {
      categoryLog.tailor.warn('cap_hit', { total: result.addedJobs.length, cap: 50 })
      // Re-fetch per-job to read the live score (addedJobs only carries
      // id/title/company per `project-scan-results-lists-added-jobs`).
      const withScores = listJobs()
        .filter((j) => result.addedJobs.some((a) => a.id === j.id))
        .map((j) => ({ id: j.id, score: j.score ?? 0 }))
      autoTailorEligible = withScores
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
    }
    for (const j of autoTailorEligible) {
      // `withScores` above already attached the live score to each entry
      // (`{ id, score }`), so re-reading the entire store per item via
      // `listJobs().find(...)` would re-parse the encrypted file on every
      // iteration. Use the score that was just looked up.
      const score = j.score
      if (score >= settings.auto_tailor_min_fit / 100) {
        enqueue({ type: 'tailor_job_docs', jobId: j.id })
      }
    }
  }

  // Recycle the shared Camoufox singleton now that the scan is done.
  // Without this it accumulates leaked tabs/threads across scans (one
  // wedged browser grew to 9GB/1307 threads and stopped answering
  // newPage). Closing here bounds the footprint to a single scan; the
  // browser is auto-recreated on the next fetchHtmlViaCamoufox() call.
  // Not awaited — the scan result is ready and a slow teardown shouldn't
  // gate the UI. The next initCamoufox() awaits any in-flight kill.
  closeCamoufox()

  return result
}
