// Board configuration and scan result types.
// Extracted from jobSearch.ts to keep the scan pipeline readable.

import { fetchArbeitnowJobs, fetchHimalayasJobs, fetchIndeedCanadaRss, fetchIndeedRss, fetchJobicyJobs, fetchRareRolesJobs, fetchRemotiveJobs, fetchZipRecruiterRss } from './aggregatorApis'
import { fetchAtsJobs } from './atsAdapter'
import { fetchJobBankJobs, fetchWorkBcJobs } from './govApis'
import { fetchRssFeed } from './rssFetcher'
import { fetchPageHtml, fetchSitemapText, extractSitemapUrls } from './netUtils'

export interface BoardConfig {
  name: string
  searchUrl: (keywords: string, location: string) => string
  useBrowser: boolean
  paginate?: (searchUrl: string, page: number) => string
  apiFetcher?: (keywords: string, location: string, signal?: AbortSignal) => Promise<import('./types').CreateJobInput[]>
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
    name: 'Indeed (RSS)',
    searchUrl: (k, l) => `https://www.indeed.com/rss?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchIndeedRss(k, l, signal)
  },
  {
    name: 'Indeed Canada (RSS)',
    searchUrl: (k, l) => `https://ca.indeed.com/rss?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchIndeedCanadaRss(k, l, signal)
  },
  {
    name: 'Monster',
    searchUrl: (k, l) => `https://www.monster.com/jobs/search?q=${encodeURIComponent(k)}${l ? `&where=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'ZipRecruiter',
    // The /jobs?q= page is Cloudflare-challenged for both the static
    // fetcher and the browser (found=0 in every scan). The site's RSS
    // endpoint (&format=rss) serves the same search without the WAF
    // gauntlet — pull that instead.
    searchUrl: (k, l) => `https://www.ziprecruiter.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}&format=rss`,
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchZipRecruiterRss(k, l, signal)
  },
  {
    name: 'ZipRecruiter (RSS)',
    searchUrl: (k, l) => `https://www.ziprecruiter.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}&format=rss`,
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchZipRecruiterRss(k, l, signal)
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
    // The category search pages are Cloudflare-challenged (the scan
    // always came back found=0 with "This site blocked automated access
    // (Cloudflare)"). The site's public RSS feeds are not — this board
    // pulls the same feed the (RSS) variant uses; URL dedup drops the
    // overlap.
    searchUrl: () => 'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    useBrowser: false,
    apiFetcher: (_k, _l, signal) => fetchRssFeed('https://weworkremotely.com/categories/remote-programming-jobs.rss', 'weworkremotely', { signal })
  },
  {
    // The ?q= search page renders job cards client-side (no server-side
    // job links to extract), so this board uses the public Remotive API
    // instead — same fetcher as the Remotive (API) entry below; URL
    // dedup drops the overlap.
    name: 'Remotive',
    searchUrl: () => 'https://remotive.com/remote-jobs',
    useBrowser: false,
    apiFetcher: (k, _l, signal) => fetchRemotiveJobs({ keywords: k, location: '', signal })
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
    // CharityVillage is Drupal-based and serves static HTML for
    // per-job pages at /job/{slug}-{id}. The sitemap (7 pages)
    // lists all job URLs under /job/. Walk all pages and collect
    // job URLs for per-listing scraping.
    searchUrl: () => 'https://www.charityvillage.com/jobs/',
    useBrowser: false,
    sitemapListingUrls: async (_k, _l, signal) => {
      const all: string[] = []
      for (let page = 1; page <= 7; page++) {
        if (signal?.aborted) break
        const xml = await fetchSitemapText(`https://www.charityvillage.com/sitemap.xml?page=${page}`, false, signal)
        for (const loc of extractSitemapUrls(xml)) {
          if (loc.includes('/job/')) all.push(loc)
        }
      }
      return all
    }
  },
  {
    name: 'Crypto Careers',
    searchUrl: (k) => `https://www.crypto-careers.com/jobs?q=${encodeURIComponent(k)}`,
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
    // The /jobs?search= page is Cloudflare-challenged (found=0 in every
    // scan), but crypto.jobs publishes a public sitemap-jobs.xml (~1360
    // per-job URLs, newest-first) that is NOT WAF'd, and each per-job
    // page is server-rendered with JSON-LD — so this board walks the
    // sitemap instead of the search page, same pattern as CharityVillage.
    searchUrl: () => 'https://crypto.jobs/jobs',
    useBrowser: false,
    sitemapListingUrls: async (_k, _l, signal) => {
      const xml = await fetchSitemapText('https://crypto.jobs/sitemap-jobs.xml', false, signal)
      return extractSitemapUrls(xml).filter((loc) => loc.startsWith('https://crypto.jobs/jobs/'))
    }
  },
  {
    name: 'Web3.career',
    searchUrl: () => `https://web3.career/`,
    useBrowser: false
  },
  {
    name: 'Startup.jobs',
    // The site (startup.jobs) is Cloudflare-challenged on every path
    // (found=0 in every scan), but the sitemap index lives on an
    // unprotected CDN (cdn.startup.jobs) and lists job posts under
    // posts*.xml. Walk those for listings; per-job pages still go
    // through scrapeJobFromUrl's browser fallback when the static
    // fetch is challenged.
    searchUrl: () => 'https://startup.jobs/',
    useBrowser: true,
    sitemapListingUrls: async (_k, _l, signal) => {
      const index = await fetchSitemapText('https://cdn.startup.jobs/sitemaps/startupjobs/sitemap.xml.gz', false, signal)
      const posts = extractSitemapUrls(index).filter((loc) => /sitemaps\/startupjobs\/posts\d*\.xml(\.gz)?$/.test(loc))
      const all: string[] = []
      for (const url of posts) {
        if (signal?.aborted) break
        const xml = await fetchSitemapText(url, false, signal)
        for (const loc of extractSitemapUrls(xml)) {
          if (/^https:\/\/startup\.jobs\/.+-\d+$/.test(loc)) all.push(loc)
        }
      }
      return all
    }
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
    name: 'RareRoles',
    searchUrl: (k) => `https://www.rareroles.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: false,
    apiFetcher: (k, l, signal) => fetchRareRolesJobs({ keywords: k, location: l, signal })
  },
  {
    name: 'Flexa',
    // Flexa (flexa.careers) is a workplace-flexibility-focused careers
    // platform. Search pages are Next.js client-rendered with query
    // params on `/jobs`. Individual job pages at `/jobs/{slug}` have
    // server-rendered meta tags (og:title, description) that the
    // generic scraper can extract.
    searchUrl: (k) => `https://flexa.careers/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
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
        const xml = await fetchSitemapText(u, false, signal)
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
      const xml = await fetchSitemapText('https://nodesk.co/sitemap-jobs.xml', false, signal)
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
      const xml = await fetchSitemapText('https://remote100k.com/sitemap.xml', false, signal)
      if (signal?.aborted) return []
      // The /sitemap.xml is a single <urlset> with ~706 /remote-job/
      // entries. extractSitemapUrls returns ALL <loc>s (including
      // nav pages like /about, /contact); filter to the job path.
      return extractSitemapUrls(xml).filter((u) => u.includes('/remote-job/'))
    }
  },
  {
    name: 'FlexJobs',
    // FlexJobs (flexjobs.com) is a hand-screened remote/hybrid
    // job board known for quality listings and no ads. The search
    // page uses /search with a ?search= keyword param. FlexJobs
    // has aggressive bot protection (Cloudflare) and the
    // per-listing pages require a subscription; useBrowser=true
    // to give the browser fallback a chance, but results are
    // expected to be limited.
    searchUrl: (k) => `https://www.flexjobs.com/search?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Virtual Vocations',
    // Virtual Vocations (virtualvocations.com) is a remote-only
    // job board. The search page is server-rendered at /jobs with
    // ?search= keyword parameter. Per-job URLs follow
    // /job/{slug}/ pattern (covered by generic /job/ check).
    searchUrl: (k) => `https://www.virtualvocations.com/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Pangian',
    // Pangian (pangian.com) is a remote job board. Search at
    // /jobs?q={keywords}. Per-job URLs are /job/{slug}/ (covered
    // by generic /job/ check).
    searchUrl: (k) => `https://pangian.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'PowerToFly',
    // PowerToFly (powertofly.com) focuses on connecting diverse
    // talent with remote/hybrid roles at inclusive companies.
    // The search page at /jobs/?keywords= has server-rendered
    // shell but JS-rendered listings (a search API at
    // search.prd.powertofly.com powers the grid). Per-job URLs
    // are /jobs/{slug}.
    searchUrl: (k) => `https://powertofly.com/jobs/?keywords=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Dice',
    // Dice (dice.com) is a major tech-focused job board.
    // Next.js-rendered single-page app. Search at /jobs with
    // ?q=keywords&location= params. Per-job URLs are
    // /job-detail/{uuid} — does NOT match the generic /jobs/
    // path pattern, handled by a board-specific rule.
    searchUrl: (k, l) => `https://www.dice.com/jobs?q=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Ladders',
    // Ladders (theladders.com) curates high-paying ($100k+)
    // professional jobs. Search at /jobs/search?q=. Likely
    // behind bot protection.
    searchUrl: (k) => `https://www.theladders.com/jobs/search?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Work At A Startup',
    // Work At A Startup (workatastartup.com) is Y Combinator's
    // job board for YC-backed companies. Search at /jobs?query=.
    // Per-job URLs are /companies/{slug} — does NOT match the
    // generic path regex, handled by a board-specific rule.
    searchUrl: (k) => `https://workatastartup.com/jobs?query=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Career Vault',
    // Career Vault (careervault.io) is a remote job board.
    // Search at /jobs?q=. Per-job URLs follow typical slug
    // patterns (generic /job/ or /jobs/ path).
    searchUrl: (k) => `https://careervault.io/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Remote Rocketship',
    // Remote Rocketship (remoterocketship.com) is a remote-only
    // job board. Search at /remote-jobs?q=. Per-job URLs follow
    // /job/{slug} or /remote-job/{slug} patterns (generic).
    searchUrl: (k) => `https://remoterocketship.com/remote-jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Dribbble Jobs',
    // Dribbble Jobs (dribbble.com/jobs) lists design-related
    // roles on the Dribbble design portfolio platform. Search at
    // /jobs?query=. The site is a JS-heavy SPA.
    // Per-job URLs match /jobs/{id}-{slug} (covered by generic
    // path regex).
    searchUrl: (k) => `https://dribbble.com/jobs?query=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Behance Jobs',
    // Behance Jobs (behance.net/joblist) is Adobe's creative
    // portfolio platform with a job board. Search at
    // /joblist?search=. Per-job URLs are /joblist/{id}/{slug}
    // — does NOT match generic path regex, handled by a
    // board-specific rule.
    searchUrl: (k) => `https://www.behance.net/joblist?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Crossover',
    // Crossover (crossover.com) places senior remote tech
    // talent in long-term roles. Search at /jobs?q=.
    // Per-job URLs follow /jobs/{slug} pattern (generic).
    searchUrl: (k) => `https://www.crossover.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'AI Jobs',
    // AI Jobs (aijobs.ai) is a job board focused on AI/ML
    // roles. Search at /jobs?search=. Per-job URLs follow
    // generic /jobs/ path.
    searchUrl: (k) => `https://aijobs.ai/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Toptal',
    // Toptal (toptal.com) is a high-end freelancer marketplace
    // matching engineers/designers/finance pros with clients.
    // Does not have public per-job listings in the traditional
    // sense — this entry is informational and will likely
    // produce 0 results from the generic scraper, since Toptal
    // works through private matching.
    searchUrl: (k) => `https://www.toptal.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Fiverr',
    // Fiverr (fiverr.com) is a freelance services marketplace
    // (gig-based, not job listings). Search at /search/gigs?query=.
    // Will likely produce 0 results — included for completeness.
    searchUrl: (k) => `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Gun.io',
    // Gun.io (gun.io) is a freelance developer marketplace
    // with public opportunities at /opportunities?q=.
    // Per-job URLs at /opportunities/{slug} — the /opportunities/
    // path matches the generic opportunities? regex already in
    // the path matcher. Title/company/description extraction is
    // expected to work for some listings.
    searchUrl: (k) => `https://gun.io/opportunities?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Freelancer',
    // Freelancer (freelancer.com) is a project marketplace.
    // /jobs/?q= shows project listings. Per-job URLs are
    // /projects/{slug} — handled by board-specific rule
    // since /projects/ is not in the generic path matcher.
    searchUrl: (k) => `https://www.freelancer.com/jobs/?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'PeoplePerHour',
    // PeoplePerHour (peopleperhour.com) is a freelance
    // project marketplace. Search at /hire/{keyword}/.
    // Per-job URLs follow /hire/{slug} pattern — handled
    // by board-specific rule.
    searchUrl: (k) => `https://www.peopleperhour.com/hire/${encodeURIComponent(k)}/`,
    useBrowser: true
  },
  {
    name: 'Hubstaff Talent',
    // Hubstaff Talent (hubstaff.com/talent) is a free remote
    // talent directory. Search at /talent/search?q=.
    // Per-job/detail URLs follow directory profile patterns
    // (not standard job paths). Likely produces 0 results.
    searchUrl: (k) => `https://hubstaff.com/talent/search?q=${encodeURIComponent(k)}`,
    useBrowser: true
  }
]
