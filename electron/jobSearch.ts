import { createJob, findDuplicateJob, getSeenUrls, getSettings, listJobs, recordBoardResults, JobBlacklistedError, JobDuplicateError } from './database'
import { decodeEntities } from './utils'
import { scrapeJobFromUrl } from './jobScraper'
import { createLogger, log as categoryLog } from './logger'
import { enqueue } from './aiQueue'

// File-backed category logger. Writes to <userData>/logs/scanner.log.
const log = createLogger('scanner')
import { fetchHtmlViaBrowser, isChallengePage, paginateHtmlViaBrowser } from './browserScraper'
import { fetchArbeitnowJobs, fetchHimalayasJobs, fetchJobicyJobs, fetchRemotiveJobs } from './aggregatorApis'
import { fetchAtsJobs } from './atsAdapter'
import { fetchJobBankJobs, fetchWorkBcJobs, fetchWorkBcSearchJobs } from './govApis'
import { fetchRssFeed } from './rssFetcher'
import { scoreJobFit } from './ai'
import { scoreCompatibility } from './fitHeuristic'
export { scoreCompatibility } from './fitHeuristic'
import type { CreateJobInput, Job, ScanFilters, WorkType } from './types'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

export const BOARDS: BoardConfig[] = [
  {
    name: 'LinkedIn',
    searchUrl: (k, l) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Indeed',
    searchUrl: (k, l) => `https://www.indeed.com/q-${encodeURIComponent(k)}-l-${encodeURIComponent(l || '')}-jobs.html`,
    useBrowser: true
  },
  {
    name: 'Indeed Canada',
    searchUrl: (k, l) => `https://ca.indeed.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Monster',
    searchUrl: (k, l) => `https://www.monster.com/jobs/search?q=${encodeURIComponent(k)}${l ? `&where=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'ZipRecruiter',
    searchUrl: (k, l) => `https://www.ziprecruiter.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'SimplyHired',
    searchUrl: (k, l) => `https://www.simplyhired.com/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Talent.com',
    searchUrl: (k, l) => `https://www.talent.com/jobs?k=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Jora',
    searchUrl: (k, l) => `https://jora.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Remote OK',
    searchUrl: (k) => `https://remoteok.com/remote-${encodeURIComponent(k)}-jobs`,
    useBrowser: false
  },
  {
    name: 'We Work Remotely',
    searchUrl: (k) => `https://weworkremotely.com/categories/remote-${encodeURIComponent(k)}-jobs`,
    useBrowser: true
  },
  {
    name: 'Remotive',
    searchUrl: (k) => `https://remotive.com/?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Remote.co',
    searchUrl: (k) => `https://remote.co/remote-jobs/search/?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Working Nomads',
    searchUrl: (k) => `https://www.workingnomads.com/jobs?keywords=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'JustRemote',
    searchUrl: (k) => `https://justremote.co/search?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Job Bank (GC)',
    searchUrl: (k, l) => `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=${encodeURIComponent(k)}${l ? `&locationstring=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Eluta.ca',
    searchUrl: (k, l) => `https://www.eluta.ca/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Workopolis',
    searchUrl: (k, l) => `https://www.workopolis.com/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Jobboom',
    searchUrl: (k) => `https://www.jobboom.com/en/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'WorkBC',
    // WorkBC's search is a single-page hash-based route. The hash carries
    // `q` (keyword) and `city` (location) segments separated by `;`. We
    // omit a segment entirely when its value is empty so the URL matches
    // what the user sees when searching with only a keyword or only a
    // city (e.g. `#/job-search;city=Vancouver;`).
    searchUrl: (k, l) => {
      const parts = ['job-search']
      if (k) parts.push(`q=${encodeURIComponent(k)}`)
      if (l) parts.push(`city=${encodeURIComponent(l)}`)
      return `https://www.workbc.ca/find-job/search-jobs#/${parts.join(';')}`
    },
    useBrowser: true
  },
  {
    name: 'WorkBC (API)',
    // First-party search + detail API. Replaces the browser-based
    // listing walk and the per-job HTML scrape. Faster and
    // structured; the user can keep both enabled (the search-side
    // dedup will skip duplicates) or disable the browser one.
    searchUrl: () => 'https://workbc-jb.a55eb5-prod.stratus.cloud.gov.bc.ca/api/Search/SearchJobs',
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchWorkBcJobs(k, l, signal)
  },
  {
    name: 'CareerBeacon',
    searchUrl: (k, l) => `https://www.careerbeacon.com/en/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'CharityVillage',
    searchUrl: (k, l) => `https://www.charityvillage.com/jobs/?keywords=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Crypto Careers',
    searchUrl: (k) => `https://www.crypto-careers.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Cryptorecruit',
    searchUrl: (k) => `https://www.cryptorecruit.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Remote3',
    searchUrl: (k) => `https://remote3.co/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Cryptocurrency Jobs',
    searchUrl: (k) => `https://cryptocurrencyjobs.co/?search=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'CryptoJobsList',
    searchUrl: (k) => `https://cryptojobslist.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'cryptojobs.com',
    searchUrl: (k) => `https://www.cryptojobs.com/jobs?query=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Crypto.jobs',
    searchUrl: (k) => `https://crypto.jobs/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Web3.career',
    searchUrl: () => `https://web3.career/`,
    useBrowser: false
  },
  {
    name: 'Startup.jobs',
    searchUrl: (k) => `https://startup.jobs/${encodeURIComponent(k)}-jobs`,
    useBrowser: true
  },
  {
    name: 'Selby Jennings',
    searchUrl: (k, l) => `https://www.selbyjennings.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Idealist',
    searchUrl: (k) => `https://www.idealist.org/en/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Built In',
    searchUrl: (k, l) => `https://builtin.com/jobs?search=${encodeURIComponent(k)}${l ? `&city=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Vancouver Jobs',
    searchUrl: (k) => `https://jobs.vancouver.ca/search/?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Built In Toronto',
    searchUrl: (k) => `https://builtintoronto.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Wellfound',
    searchUrl: (k) => `https://wellfound.com/search/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'UToronto',
    searchUrl: (k) => `https://jobs.entrepreneurs.utoronto.ca/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Y Combinator',
    searchUrl: (k) => `https://www.ycombinator.com/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'CVCA',
    searchUrl: (k) => `https://www.cvca.ca/professional-development/job-board/?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Top Startups',
    searchUrl: (k) => `https://topstartups.io/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Rocketships',
    searchUrl: (k) => `https://rocketships.io/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Built In Vancouver',
    searchUrl: (k) => `https://www.builtinvancouver.org/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Braintrust',
    searchUrl: (k) => `https://app.usebraintrust.com/jobs/?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Google Careers',
    // Google Careers search is driven by the `q` (free-text), `location`, and
    // `hl` (locale) params. We keep `hl=en-GB` so results lean towards UK/CA
    // listings; users can override by editing the URL after the scan starts.
    searchUrl: (k, l) => `https://www.google.com/about/careers/applications/jobs/results/?q=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}&hl=en-GB`,
    useBrowser: true
  },
  {
    name: 'CareerHound',
    // CareerHound's search uses `categories` (slug) and `countries` (ISO code).
    // The user pastes keywords into `q`; the `categories` and `countries`
    // params stay pinned to the defaults so the result set stays broad.
    searchUrl: (k) => `https://www.careerhound.io/job-search/all?categories=Data+and+Analytics&countries=CA&q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Northern Health',
    // Northern Health (BC health authority) job board. URL pattern is
    // /JobSearch/s-/{keyword}-{location}-{employeeType}-{category}-{region}-{sort}-{status}-{page}-{perPage}
    //
    // Quirks of the server (verified empirically):
    //   1. The keyword segment in the path is NOT used for filtering
    //      by the server — ASP.NET WebForms does that via form state,
    //      not the path. The path carries pagination + perPage.
    //   2. When the keyword segment is non-empty, the path-based page
    //      parameter is IGNORED — the server returns page 0 of the
    //      filtered (or unfiltered) set on every request, regardless
    //      of the page number in the URL.
    //   3. When the keyword segment is empty, the page parameter
    //      works correctly — each page returns a unique set of jobs.
    //
    // We therefore leave the keyword segment empty and rely on the
    // unfiltered listing + URL pagination. The unfiltered list is
    // ~1.7k jobs ≈ 170 pages at 10 per page. The scan loop's
    // empty-page detection is the natural terminator; no upper cap.
    // (Keyword filtering, if wanted, would require running the search
    // through a real browser via the form — out of scope for the
    // plain-fetch path.)
    //
    // ASP.NET WebForms renders each page fully server-side, so direct
    // URL navigation works — no browser fallback needed. The
    // `paginate` driver swaps the page segment to walk through all
    // result pages.
    searchUrl: () => 'https://jobs.northernhealth.ca/JobSearch/s-/-0-0-0-0-0-false-0-0-0',
    useBrowser: false,
    paginate: (searchUrl, page) => {
      // Match the trailing "-{page}-{perPage}" segment pair and
      // rewrite only the page index. Anchoring on the END of the
      // pathname (not on any keyword segment) keeps this driver
      // robust regardless of which segments precede the page index.
      const u = new URL(searchUrl)
      const rewritten = u.pathname.replace(/-(\d+)-\d+$/, () => `-${page}-0`)
      return `${u.origin}${rewritten}`
    }
  },
  {
    name: 'Interior Health',
    // Interior Health (BC health authority) runs the same ASP.NET
    // WebForms platform as Northern Health with identical URL
    // patterns and the same per-job `JobPosting` JSON-LD block.
    // Same pagination approach: direct URL navigation, stop on
    // empty page. Same keyword-in-path quirk: we leave the keyword
    // segment empty so the path-based page parameter works.
    searchUrl: () => 'https://jobs.interiorhealth.ca/JobSearch/s-/-0-0-0-0-0-false-0-0-0',
    useBrowser: false,
    paginate: (searchUrl, page) => {
      const u = new URL(searchUrl)
      const rewritten = u.pathname.replace(/-(\d+)-\d+$/, () => `-${page}-0`)
      return `${u.origin}${rewritten}`
    }
  },
  // Aggregator API boards. Each of these is a separate BOARDS entry
  // so the per-board stats in the scan results card are accurate
  // (Remotive vs Arbeitnow overlap a lot but we want the user to
  // see each one independently). All four are gated on the matching
  // settings.aggregator_*_enabled flag.
  {
    name: 'Remotive (API)',
    searchUrl: () => 'https://remotive.com/remote-jobs',
    useBrowser: false,
    apiFetcher: (k, _l, signal) => fetchRemotiveJobs({ keywords: k, location: '', signal })
  },
  {
    name: 'Arbeitnow (API)',
    searchUrl: () => 'https://arbeitnow.com',
    useBrowser: false,
    apiFetcher: (k, _l, signal) => fetchArbeitnowJobs({ keywords: k, location: '', signal })
  },
  {
    name: 'Jobicy (API)',
    searchUrl: () => 'https://jobicy.com',
    useBrowser: false,
    apiFetcher: (k, _l, signal) => fetchJobicyJobs({ keywords: k, location: '', signal })
  },
  {
    name: 'Himalayas (API)',
    searchUrl: () => 'https://himalayas.app',
    useBrowser: false,
    apiFetcher: (k, _l, signal) => fetchHimalayasJobs({ keywords: k, location: '', signal })
  },
  {
    name: 'ATS boards',
    searchUrl: () => '',
    useBrowser: false,
    // Pulls from the user's configured ats_boards in Settings.
    apiFetcher: (k, l, signal) => fetchAtsJobs(k, l, signal)
  },
  {
    name: 'We Work Remotely (RSS)',
    searchUrl: () => 'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    useBrowser: false,
    apiFetcher: (_k, _l, signal) => fetchRssFeed('https://weworkremotely.com/categories/remote-programming-jobs.rss', 'weworkremotely', { signal })
  },
  {
    name: 'Authentic Jobs (RSS)',
    searchUrl: () => 'https://authenticjobs.com/?feed=job_feed',
    useBrowser: false,
    apiFetcher: (_k, _l, signal) => fetchRssFeed('https://authenticjobs.com/?feed=job_feed', 'authenticjobs', { signal })
  },
  {
    name: 'Job Bank GC (API)',
    // First-party JSON-LD search endpoint. Replaces the legacy
    // scrape path that was the most-fragile board in the list.
    searchUrl: () => 'https://www.jobbank.gc.ca/jobsearch/search',
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchJobBankJobs(k, l, { signal })
  },
  {
    name: 'Hiring Cafe',
    // hiring.cafe is a remote-first job aggregator. The search
    // page is server-rendered with JSON-LD JobPosting blocks per
    // listing; per-job URLs are /?job_id={uuid} so the listing
    // fetch and the per-job scrape share the same scrapeJobFromUrl
    // path. useBrowser=true: the keyword filter is client-side and
    // the static HTML only ships the unfiltered list, so we walk
    // the unfiltered page and rely on the per-listing scraper to
    // honour the keyword.
    searchUrl: (k) => `https://hiring.cafe/?keyword=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Sprout',
    // Sprout (sproutjobs.com) is a marketing/creative remote job
    // board on WordPress. Per-job URLs are /jobs/{slug}/ — covered
    // by the generic /jobs path regex. Search URL is the standard
    // WP /?s= shape; useBrowser=true because the search is a
    // client-rendered overlay.
    searchUrl: (k) => `https://sproutjobs.com/jobs?s=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Arc',
    // Arc (arc.dev) is a dev-focused remote job board. Each listing
    // has its own /remote-jobs/{slug} URL (the slug IS the job,
    // not a category). Per-job pages carry a single JobPosting
    // JSON-LD block. useBrowser=true: the listing grid is rendered
    // client-side; static HTML carries only category nav.
    searchUrl: (k) => `https://arc.dev/remote-jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Contra',
    // Contra (contra.com) lists freelance projects (gigs, not
    // 1099 jobs). Per-project URLs are /projects/{slug}/. Static
    // HTML is a thin shell — the React app fetches the listing
    // grid from an internal API, so useBrowser=true.
    searchUrl: (k) => `https://contra.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'SkipTheDrive',
    // SkipTheDrive (skipthedrive.com) is a remote-only job board
    // on WordPress. Per-job URLs are /job/{slug}-{numericId}/. The
    // search page is server-rendered, so useBrowser=false.
    searchUrl: (k) => `https://www.skipthedrive.com/?s=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Jobspresso',
    // Jobspresso (jobspresso.co) is a curated remote job board on
    // WordPress. Per-job URLs are bare /{slug}/ posts (not under
    // /jobs/). The search page is server-rendered and the /search/
    // path carries the listings; the per-job anchor pattern matches
    // the generic /jobs|post|... regex. useBrowser=false.
    searchUrl: (k) => `https://jobspresso.co/?s=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Dynamite Jobs',
    // Dynamite Jobs (dynamitejobs.com) is a remote-only curated
    // board. Per-job URLs are /job/{slug}/. Static HTML is a thin
    // shell — listings render via the SPA — so useBrowser=true.
    searchUrl: (k) => `https://dynamitejobs.com/?s=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'DailyRemote',
    // DailyRemote (dailyremote.com) — the search page
    // (?s=…) is a WordPress blog post list, not a real job search.
    // The per-job URLs are listed in two job-specific sitemaps
    // (sitemap-jobs-01.xml + sitemap-jobs-02.xml) under
    // /remote-job/{slug}-{numericId}. The per-job pages have
    // JSON-LD JobPosting blocks; the per-listing scrape fills in
    // title + company from there. Keyword filtering is applied
    // per-listing via the existing fit / location / score funnel
    // (the LLM fit scorer is the keyword gate in practice).
    searchUrl: () => 'https://dailyremote.com/',
    useBrowser: false,
    sitemapListingUrls: async (_k, _l, signal) => {
      const sub = [
        'https://www.dailyremote.com/sitemap-jobs-01.xml',
        'https://www.dailyremote.com/sitemap-jobs-02.xml'
      ]
      const all: string[] = []
      for (const u of sub) {
        if (signal?.aborted) break
        const xml = await fetchSitemapText(u, false)
        for (const loc of extractSitemapUrls(xml)) {
          if (loc.includes('/remote-job/')) all.push(loc)
        }
      }
      return all
    }
  },
  {
    name: 'NoDesk',
    // NoDesk (nodesk.co) — the search page (/remote-jobs?q=…) is
    // JS-rendered and returns an empty static HTML. The
    // per-job URLs are listed in /sitemap-jobs.xml under
    // /remote-jobs/{slug}/. The per-job pages have JSON-LD; the
    // per-listing scraper fills in title + company from there.
    searchUrl: () => 'https://nodesk.co/remote-jobs',
    useBrowser: false,
    sitemapListingUrls: async (_k, _l, signal) => {
      const xml = await fetchSitemapText('https://nodesk.co/sitemap-jobs.xml', false)
      if (signal?.aborted) return []
      return extractSitemapUrls(xml)
    }
  },
  {
    name: 'Remote100k',
    // Remote100k (remote100k.com) — the search page is JS-rendered
    // and returns an empty static HTML. The per-job URLs are
    // listed in /sitemap.xml under /remote-job/{slug} (706 active
    // at probe time). The per-job pages have JSON-LD; the
    // per-listing scraper fills in title + company from there.
    searchUrl: () => 'https://remote100k.com/',
    useBrowser: false,
    sitemapListingUrls: async (_k, _l, signal) => {
      const xml = await fetchSitemapText('https://remote100k.com/sitemap.xml', false)
      if (signal?.aborted) return []
      // The /sitemap.xml is a single <urlset> with ~706 /remote-job/
      // entries. extractSitemapUrls returns ALL <loc>s (including
      // nav pages like /about, /contact); filter to the job path.
      return extractSitemapUrls(xml).filter((u) => u.includes('/remote-job/'))
    }
  }
]

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

/** Normalize a URL for dedup comparison: lowercase, strip trailing slash, strip common tracking params */
function dedupKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    // Remove common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'src', 'tracking', 'trackingId', 'trk', 'spm', 'ta', 'refId']
    trackingParams.forEach(p => u.searchParams.delete(p))
    const key = u.origin + u.pathname.replace(/\/$/, '').toLowerCase() + u.search
    return key
  } catch {
    return url.toLowerCase().replace(/\/$/, '')
  }
}

function extractJobUrls(html: string, baseUrl: string, boardName: string): { url: string; title?: string; company?: string }[] {
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

    const knownBoardDomains = /linkedin\.com|indeed\.com|ca\.indeed\.com|monster\.com|ziprecruiter\.com|simplyhired\.com|adzuna\.com|talent\.com|jora\.com|remoteok\.com|weworkremotely\.com|remotive\.com|remote\.co|workingnomads\.com|justremote\.co|jobbank\.gc\.ca|eluta\.ca|workopolis\.com|jobboom\.com|workbc\.ca|careerbeacon\.com|charityvillage\.com|crypto-careers\.com|cryptorecruit\.com|remote3\.co|cryptocurrencyjobs\.co|cryptojobslist\.com|cryptojobs\.com|crypto\.jobs|web3\.career|startup\.jobs|selbyjennings\.com|idealist\.org|builtin\.com|jobs\.vancouver\.ca|google\.com\/about\/careers|careerhound\.io|usebraintrust\.com|hiring\.cafe|sproutjobs\.com|arc\.dev|contra\.com|skipthedrive\.com|jobspresso\.co|dynamitejobs\.com|dailyremote\.com|nodesk\.co|remote100k\.com/
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
      if (pathname === '/' || pathname === '/index.html') continue
      const pathParts = pathname.split('/').filter(Boolean)
      if (pathParts.length < 1) continue
      if (inner.length < 3 || inner.length >= 300) continue
    } else if (boardLower.includes('google')) {
      // Google Careers lives under /about/careers/applications/jobs/... —
      // the generic /jobs|...|... regex anchors at `^/` and would reject
      // every real listing. Accept any path under /about/careers instead.
      if (!pathname.startsWith('/about/careers')) continue
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

async function fetchPageHtml(url: string, useBrowser: boolean, signal?: AbortSignal): Promise<string> {
  if (useBrowser) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error('Blocked by anti-bot protection (Cloudflare/Cloudfront).')
    }
  }
  // Combine the scan-cancel signal with the 30s per-request timeout.
  // Without this, a Cancel click during a long fetch leaves the request
  // running until the timeout fires (up to 30s), which the user reads as
  // "Cancel is broken." Combining the two signals means either source of
  // abort tears the in-flight request down immediately.
  const timeoutSignal = AbortSignal.timeout(30000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    signal: combinedSignal,
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  if (isChallengePage(html)) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error(`HTTP ${  response.status  } (blocked)`)
    }
  }
  return html
}

// Fetch a sitemap XML document. Uses the same HTTP-with-challenge-
// fallback as fetchPageHtml. Sitemaps are <urlset> or <sitemapindex>
// XML; the caller runs extractSitemapUrls on the result.
async function fetchSitemapText(url: string, useBrowser: boolean): Promise<string> {
  // Sitemaps are well-known XML; tell the server that's what we
  // want so a Cloudflare-fronted origin doesn't try to serve us
  // an HTML challenge page by default.
  return fetchPageHtml(url, useBrowser)
}

// Pull <loc>...</loc> URLs out of a sitemap XML document. Handles
// both <urlset> (returns the per-URL <loc>s) and <sitemapindex>
// (returns the sub-sitemap <loc>s — the caller fetches them in
// turn). Returns a de-duplicated list.
function extractSitemapUrls(xml: string): string[] {
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = locRe.exec(xml)) !== null) {
    const u = m[1].trim()
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
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

  let input: { title: string; company: string; location?: string; url?: string; description?: string; salary_range?: string; source?: string; notes?: string; requirements?: string; application_requirements?: string; hiring_manager?: string; employment_type?: string; work_mode?: string }
  try {
    input = await scrapeJobFromUrl(url)
  } catch (err) {
    return { action: 'error', reason: `Scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }

  if (!input.title || !input.company || !input.description) {
    return { action: 'error', reason: 'Missing required fields' }
  }

  // Duplicate check by URL (normalized) and company+title
  if (findDuplicateJob({ ...input, url: input.url || url } as any)) {
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
  const HEURISTIC_FLOOR = 0.15
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
      console.error(`[scan] stage=llm-score source=${fit.source} score=${fit.score?.toFixed(3)} ms=${Date.now() - tLlm0}`)
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

export async function scanAllBoards(
  filters?: ScanFilters,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  onCounters?: (counters: Pick<ScanResult, 'totalFound' | 'totalAdded' | 'totalSkipped' | 'totalIncompatible' | 'totalErrors'>) => void
): Promise<ScanResult> {
  const settings = getSettings()
  const keywords = (filters?.keywords || settings.job_search_keywords || '').trim()
  const locationInput = (filters?.location || settings.job_search_location || '').trim()
  const locations = locationInput
    ? locationInput.split(',').map((s) => s.trim()).filter(Boolean)
    : ['']
  const workType = filters?.workType || 'any'
  const baseCv = settings.base_cv || ''

  const existingJobs = listJobs()
  const seenUrls = new Set(getSeenUrls().map(dedupKey))
  const scanSeenUrls = new Set<string>()

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
  const bump = (field: 'totalAdded' | 'totalSkipped' | 'totalIncompatible' | 'totalErrors') => {
    result[field]++
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
  async function fetchBoardListingsHtml(searchUrl: string, board: BoardConfig, signal?: AbortSignal): Promise<string> {
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
      return paginateHtmlViaBrowser(baseUrl, pageHashes, 3000)
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
            progress(`Scanning ${board.name}... page ${r.pageNum + 1}`)
            lastReportedPage = r.pageNum
          }
        }
      }
      return chunks.join('\n')
    }

    return fetchPageHtml(searchUrl, board.useBrowser, signal)
  }

  async function processBoard(board: BoardConfig, location: string, signal?: AbortSignal): Promise<ScanBoardResult> {
    const br: ScanBoardResult = { board: board.name, found: 0, added: 0, skipped: 0, errors: 0, incompatible: 0 }
    try {
      const locTag = location ? ` (${location})` : ''
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
          console.error(`[scan] stage=api board=${board.name} jobs=${apiJobs.length} ms=${Date.now() - tApi0}`)
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
              ...(baseCv && heuristicScore < 0.15
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
        return br
      }

      const searchUrl = board.searchUrl(keywords, location)
      const tFetch0 = Date.now()
      const html = await fetchBoardListingsHtml(searchUrl, board, signal)
      if (process.env.FLOW_JOB_SCAN_TIMING) {
        console.error(`[scan] stage=board-fetch board=${board.name} bytes=${html.length} ms=${Date.now() - tFetch0}`)
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
        listings = urls.map((url) => ({ url }))
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          console.error(`[scan] stage=parse board=${board.name} listings=${listings.length} (sitemap) ms=${Date.now() - tParse0}`)
        }
      } else {
        listings = extractJobUrls(html, searchUrl, board.name)
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          console.error(`[scan] stage=parse board=${board.name} listings=${listings.length} ms=${Date.now() - tParse0}`)
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

      for (const batch of batches) {
        if (signal?.aborted) break
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
        // Race the batch against the abort signal. If the user cancels mid-
        // batch, we don't wait for the in-flight listings to finish; we drop
        // whatever hasn't settled yet and bail out. The settled values for
        // already-completed listings in this batch are discarded (since the
        // per-listing accounting happens after the await). The outer board
        // loop's `signal.aborted` check picks up the cancellation on the
        // next iteration.
        const settled = await Promise.race([
          Promise.allSettled(
            batch.map(async (l) => {
              progress(`Scraping ${board.name}${location ? ` (${location})` : ''} — ${decodeEntities(l.company || l.title || l.url)}`)
              return fetchAndScore(l.url, baseCv, seenUrls, scanSeenUrls, workType, location, signal)
            })
          ),
          abortPromise(signal).then(() => null)
        ])
        if (settled === null) break
        const results = settled
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
        bump('totalErrors')
      }
    }
    result.boards.push(br)
    return br
  }

  // Process boards split into two parallel tracks: HTTP-only boards
  // can run much wider (cheap I/O, no Chrome process) than browser
  // boards (each opens a fresh BrowserWindow). Running them
  // separately means a slow browser board doesn't block HTTP boards
  // for the same location, and vice versa. The browser cap is held
  // low because each concurrent browser session is a Chrome process
  // (~200MB+) and macOS throttles beyond ~5-6.
  const BOARD_CONCURRENCY_HTTP = 6
  const BOARD_CONCURRENCY_BROWSER = 3
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
  for (const location of locations) {
    if (location) progress(`Searching in: ${location}`)
    if (signal?.aborted) break

    async function runTrack(track: BoardConfig[], concurrency: number, trackName: 'http' | 'browser') {
      for (let i = 0; i < track.length; i += concurrency) {
        if (signal?.aborted) break
        const chunk = track.slice(i, i + concurrency)
        const t0 = Date.now()
        const results = await Promise.allSettled(chunk.map(board => processBoard(board, location, signal)))
        if (process.env.FLOW_JOB_SCAN_TIMING) {
          const elapsed = Date.now() - t0
          console.error(`[scan] track=${trackName} chunk=[${chunk.map(b => b.name).join(',')}] ms=${elapsed}`)
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
      if (score >= settings.auto_tailor_min_fit) {
        enqueue({ type: 'tailor_job_docs', jobId: j.id })
      }
    }
  }

  return result
}
