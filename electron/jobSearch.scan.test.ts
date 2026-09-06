import { describe, it, expect, vi } from 'vitest'

// Full isolation for scanAllBoards: stub every module the scan pipeline
// touches so the test drives processBoard with deterministic fixtures.
vi.mock('./database', () => ({
  getSettings: vi.fn(() => ({
    job_search_keywords: '',
    job_search_locations: '',
    base_cv: '',
    disabled_boards: [],
    cv_version: 0
  })),
  listJobs: vi.fn(() => []),
  getSeenUrls: vi.fn(() => []),
  findDuplicateJob: vi.fn(() => false),
  createJob: vi.fn((input: unknown) => ({ id: 1, ...(input as object) })),
  recordBoardResults: vi.fn(),
  recordBoardScanTime: vi.fn(),
  JobBlacklistedError: class extends Error {},
  JobDuplicateError: class extends Error {}
}))

vi.mock('./netUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./netUtils')>()
  const sitemapXml = Array.from({ length: 40 }, (_, i) =>
    `<url><loc>https://www.charityvillage.com/job/test-job-${i}</loc></url>`
  ).join('\n')
  return {
    ...actual,
    fetchSitemapText: vi.fn(async (url: string) =>
      url.includes('page=1') ? `<urlset>${sitemapXml}</urlset>` : '<urlset></urlset>'
    ),
    fetchPageHtml: vi.fn(async () => '<html></html>')
  }
})

vi.mock('./jobScraper', () => ({
  scrapeJobFromUrl: vi.fn(async () => {
    throw new Error('Blocked by anti-bot protection (empty shell)')
  })
}))

vi.mock('./ai', () => ({ scoreJobFit: vi.fn() }))
vi.mock('./aiQueue', () => ({ enqueue: vi.fn() }))
vi.mock('./browserScraper', () => ({ paginateHtmlViaBrowser: vi.fn(), closeCamoufox: vi.fn() }))
// Deterministic API path: RSS apiFetchers return zero jobs without
// touching the network.
vi.mock('./rssFetcher', () => ({ fetchRssFeed: vi.fn(async () => []) }))

import { extractJobUrls, scanAllBoards } from './jobSearch'
import { BOARDS } from './boards'
import { fetchSitemapText } from './netUtils'

describe('scan progress end markers', () => {
  it('emits a matching end marker for every board Scanning line', async () => {
    const msgs: string[] = []
    await scanAllBoards(
      {
        keywords: 'data',
        boards: ['CharityVillage'],
        locations: [{ display: 'Vancouver' }, { display: 'Toronto' }]
      },
      (msg) => msgs.push(msg)
    )

    // Board start lines: "Scanning <board><locTag>..." — excludes the
    // once-per-scan location header and pagination page lines.
    const starts = msgs.filter(
      (m) => m.startsWith('Scanning ')
        && m.endsWith('...')
        && !/Scanning \d+ location/.test(m)
        && !m.includes(' page ')
    )
    expect(starts.length).toBeGreaterThan(0)
    for (const start of starts) {
      // The marker carries the exact start text prefixed with \u0000end:,
      // and appears after the start line (the renderer retires the line
      // while the board is still shown as active only until it finishes).
      expect(msgs).toContain(`\u0000end:${start}`)
    }
  })

  it('emits an end marker for API-fetcher boards too (no early-return leak)', async () => {
    // Regression: the apiFetcher path returns early and previously
    // skipped the end marker, which would leave the board's blue
    // "Scanning..." line stuck on the card for the whole scan.
    const msgs: string[] = []
    await scanAllBoards(
      { keywords: 'data', boards: ['Indeed (RSS)'], locations: [{ display: 'Vancouver' }] },
      (msg) => msgs.push(msg)
    )
    expect(msgs).toContain('Scanning Indeed (RSS) (Vancouver)...')
    expect(msgs).toContain('\u0000end:Scanning Indeed (RSS) (Vancouver)...')
  })
})

describe('run-level blocked-board bailout', () => {
  it('grinds a blocked board once across multiple locations, not once per location', async () => {
    const result = await scanAllBoards({
      keywords: 'data',
      boards: ['CharityVillage'],
      locations: [{ display: 'Vancouver' }, { display: 'Toronto' }]
    })

    const cv = result.boards.filter((b) => b.board === 'CharityVillage')
    // Loc 1: 40 listings found, bail after 3 batches (18 scraped),
    // remaining 22 counted as errors. Loc 2: early-returned, zero-result
    // board filtered out of result.boards.
    expect(cv).toHaveLength(1)
    expect(cv[0].found).toBe(40)
    expect(cv[0].errors).toBe(40)
    expect(result.totalFound).toBe(40)
    expect(result.totalErrors).toBe(40)
  })
})

describe('PowerToFly extractor (regression: filter links scraped as jobs)', () => {
  // The search page at /jobs/ is a server-rendered shell whose only
  // anchors are filter/nav links (the job grid is JS-rendered). Before
  // the /jobs/detail/ path guard, every one of these passed the generic
  // /^\/jobs?/ path match and was scraped as a job-detail page,
  // producing "missing fields [description]" errors in scraper.log.
  it('extracts zero listings from the search-page shell', () => {
    const shell = `<!DOCTYPE html><html><head><title>Jobs - PowerToFly</title></head><body>
      <a href="/jobs/?keywords=Software+Engineering">Software Engineering</a>
      <a href="/jobs/?primary_skills=Java">Java</a>
      <a href="/jobs/?experience_level=Junior">Junior</a>
      <a href="/jobs/saved">Saved Jobs</a>
      <a href="/jobs/">Browse All Jobs</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://powertofly.com/jobs/?keywords=Software', 'PowerToFly')).toEqual([])
  })

  it('extracts real /jobs/detail/ URLs from a rendered grid', () => {
    const grid = `<!DOCTYPE html><html><head><title>Jobs - PowerToFly</title></head><body>
      <a href="/jobs/detail/2560655">Emergency Services Event Staff at NASCAR</a>
      <a href="/jobs/?keywords=Data">Data</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://powertofly.com/jobs/?keywords=Software', 'PowerToFly')
    expect(urls.map((u) => u.url)).toEqual(['https://powertofly.com/jobs/detail/2560655'])
  })
})

describe('web3.career extractor (regression: nav/category links scraped as jobs)', () => {
  // The homepage's only real job links are /{company-slug}/{numericId}.
  // Category, salary, learn, and hire pages (/crypto-jobs,
  // /web3-salaries/nft, /learn-web3/tutorial, /hire/ai,
  // /web3-jobs-oceania) are shells — scraping them triggered
  // Cloudflare blocks and produced bogus errors.
  it('extracts zero listings from nav/category/salary links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Web3 Jobs</title></head><body>
      <a href="/crypto-jobs">Crypto Jobs</a>
      <a href="/infrastructure-jobs">Infrastructure</a>
      <a href="/web3-salaries/nft">NFT Salaries</a>
      <a href="/learn-web3/tutorial">Tutorial</a>
      <a href="/hire/ai">Hire AI</a>
      <a href="/ads">Ads</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://web3.career/', 'Web3.career')).toEqual([])
  })

  it('extracts real /{slug}/{numericId} URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Web3 Jobs</title></head><body>
      <a href="/binance-accelerator-program-marketing-bd-operations-binance/152415">Binance Accelerator Program</a>
      <a href="/crypto-jobs">Crypto Jobs</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://web3.career/', 'Web3.career')
    expect(urls.map((u) => u.url)).toEqual([
      'https://web3.career/binance-accelerator-program-marketing-bd-operations-binance/152415'
    ])
  })
})

describe('Built In extractor (regression: filter/nav links scraped as jobs)', () => {
  // Built In (builtin.com) and its Toronto/Vancouver variants share the
  // /job/{slug}/{numericId} listing pattern. The listing page's filter
  // and category links (/jobs?city=..., /jobs/artificial-intelligence,
  // /jobs/dev-engineering/search/...) are shells — scraping them
  // triggered Cloudflare blocks.
  it('extracts zero listings from search/filter/category links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Jobs - Built In</title></head><body>
      <a href="/jobs?city=Austin&state=Texas">All Austin Jobs</a>
      <a href="/jobs/artificial-intelligence">AI Jobs</a>
      <a href="/jobs/dev-engineering/search/director-of-engineering">Engineering Search</a>
      <a href="/jobs">Browse Jobs</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://builtin.com/jobs?search=engineer', 'Built In')).toEqual([])
  })

  it('extracts real /job/{slug}/{numericId} URLs on all three Built In variants', () => {
    const grid = `<!DOCTYPE html><html><head><title>Jobs</title></head><body>
      <a href="/job/devops-engineer/10084814">DevOps Engineer</a>
      <a href="/jobs/artificial-intelligence">AI</a>
    </body></html>`
    const builtIn = extractJobUrls(grid, 'https://builtin.com/jobs?search=engineer', 'Built In')
    const builtInToronto = extractJobUrls(grid, 'https://builtintoronto.com/jobs?q=engineer', 'Built In Toronto')
    const builtInVan = extractJobUrls(grid, 'https://www.builtinvancouver.org/jobs?q=engineer', 'Built In Vancouver')
    // The knownBoardDomains gate previously dropped the Toronto and
    // Vancouver domains entirely, so those boards scraped zero jobs.
    expect(builtIn.map((u) => u.url)).toEqual(['https://builtin.com/job/devops-engineer/10084814'])
    expect(builtInToronto.map((u) => u.url)).toEqual(['https://builtintoronto.com/job/devops-engineer/10084814'])
    expect(builtInVan.map((u) => u.url)).toEqual([
      'https://www.builtinvancouver.org/job/devops-engineer/10084814'
    ])
  })
})

describe('Remote Rocketship extractor (regression: category pages wedged camoufox)', () => {
  // Real Remote Rocketship job URLs are /job/{slug} or
  // /remote-job/{slug}. The search page's category links
  // (/jobs/recruitment/, /jobs/software-engineer/, /jobs/project-manager/)
  // are index pages — scraping them triggered Cloudflare blocks and
  // "camoufox newPage timed out after 10000ms" wedges that stalled the
  // whole scan while the board's card stayed blue.
  it('extracts zero listings from /jobs/ category index links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Remote Rocketship</title></head><body>
      <a href="/jobs/recruitment/">Recruitment Jobs</a>
      <a href="/jobs/software-engineer/">Software Engineer Jobs</a>
      <a href="/jobs/project-manager/">Project Manager Jobs</a>
      <a href="/jobs/">All Remote Jobs</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://remoterocketship.com/remote-jobs?q=engineer', 'Remote Rocketship')).toEqual([])
  })

  it('extracts real /job/ and /remote-job/ URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Remote Rocketship</title></head><body>
      <a href="/job/senior-backend-engineer-nodejs/">Senior Backend Engineer</a>
      <a href="/remote-job/product-designer-remote/">Product Designer</a>
      <a href="/jobs/recruitment/">Recruitment</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://remoterocketship.com/remote-jobs?q=engineer', 'Remote Rocketship')
    expect(urls.map((u) => u.url)).toEqual([
      'https://remoterocketship.com/job/senior-backend-engineer-nodejs/',
      'https://remoterocketship.com/remote-job/product-designer-remote/'
    ])
  })
})

describe('Eluta extractor (regression: employer index links scraped as jobs)', () => {
  // Eluta's real per-job URLs are /spl/{slug} (server-rendered with
  // JobPosting JSON-LD). The search page's employer sidebar and
  // onclick-navigated cards produce /jobs-at-{company}?imo=N links —
  // company INDEX pages with no og:description and no individual job
  // links — which produced recurring "missing fields" errors.
  it('extracts zero listings from jobs-at employer links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Eluta.ca Search</title></head><body>
      <a href="/jobs-at-atkinsréalis?imo=12">Jobs at AtkinsRéalis</a>
      <a href="/jobs-at-coeur-mining?imo=12">Jobs at Coeur Mining</a>
      <a href="/browse-jobs">Browse Jobs</a>
      <a href="/search?q=developer">Search</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.eluta.ca/search?q=developer', 'Eluta.ca')).toEqual([])
  })

  it('extracts real /spl/ detail URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Eluta.ca Search</title></head><body>
      <a href="/spl/account-manager-f9180f30c3e2aa85ede039eb75dd6458?imo=12">Account Manager</a>
      <a href="/spl/full-stack-developer-ai-platform-2ab9f0c1?imo=12">Full Stack Developer</a>
      <a href="/jobs-at-aritzia?imo=12">Jobs at Aritzia</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.eluta.ca/search?q=developer', 'Eluta.ca')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.eluta.ca/spl/account-manager-f9180f30c3e2aa85ede039eb75dd6458?imo=12',
      'https://www.eluta.ca/spl/full-stack-developer-ai-platform-2ab9f0c1?imo=12'
    ])
  })
})

describe('Jobboom extractor (regression: sponsored banner id links scraped as jobs)', () => {
  // Jobboom's real per-job URLs are /en/job-offer/{slug}_p{numericId}.
  // The search page carries a sponsored banner anchored to
  // /en/job/?id=GXXXX plus facet links reusing the id as a query param
  // — all of which render "Job search by employer" shells and produced
  // the same missing-field error on every scan.
  it('extracts zero listings from /en/job/?id= and facet links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Jobboom</title></head><body>
      <a href="/en/job/?id=G353748">Featured employer</a>
      <a href="/en/permanent-job/_t1?id=G353748">Permanent jobs</a>
      <a href="/en/jobs-part-time/_s1?id=G353748">Part-time jobs</a>
      <a href="/en/jobs?q=developer">All jobs</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.jobboom.com/en/jobs?q=developer', 'Jobboom')).toEqual([])
  })

  it('extracts real /en/job-offer/ URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Jobboom</title></head><body>
      <a href="/en/job-offer/cuisinier-a-temps-partiel_hotel-honeyrosemontreal-a-tribute-portfolio-hotel_p3675355">Cuisinier</a>
      <a href="/en/job/?id=G353748">Featured employer</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.jobboom.com/en/jobs?q=developer', 'Jobboom')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.jobboom.com/en/job-offer/cuisinier-a-temps-partiel_hotel-honeyrosemontreal-a-tribute-portfolio-hotel_p3675355'
    ])
  })
})

describe('WorkBC extractor (regression: legacy .aspx links scraped as jobs)', () => {
  // WorkBC (browser board) is hash-routed: real cards live in the
  // fragment (#/job-details/{id}). The rendered page also carries
  // legacy /Jobs-Careers.aspx links whose pathname slips past the
  // generic ^\/jobs? prefix match (no boundary after "Jobs") — that
  // path is a maintenance shell with no description.
  it('extracts zero listings from path-only .aspx links', () => {
    const shell = `<!DOCTYPE html><html><head><title>WorkBC</title></head><body>
      <a href="/Jobs-Careers.aspx">Jobs and Careers</a>
      <a href="/find-job/search-jobs">Search jobs</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.workbc.ca/find-job/search-jobs#/job-search;q=developer', 'WorkBC')).toEqual([])
  })

  it('extracts hash-fragment job cards', () => {
    const grid = `<!DOCTYPE html><html><head><title>WorkBC</title></head><body>
      <a href="/find-job/search-jobs#/job-details/49898249">Software Developer</a>
      <a href="/Jobs-Careers.aspx">Jobs and Careers</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.workbc.ca/find-job/search-jobs#/job-search;q=developer', 'WorkBC')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.workbc.ca/find-job/search-jobs#/job-details/49898249'
    ])
  })
})

describe('Dribbble extractor (regression: homepage/social links scraped as jobs)', () => {
  // Dribbble's real per-job URLs are /jobs/{numericId}-{slug}. The
  // jobs page also links the homepage, /session/new, /for-designers,
  // /advertise, and footer social profiles — including a TikTok
  // profile whose handle contains "dribbble.com" and passes the
  // domain-substring gate.
  it('extracts zero listings from homepage, utility, and social links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Dribbble Jobs</title></head><body>
      <a href="/">Dribbble</a>
      <a href="/session/new">Sign in</a>
      <a href="/for-designers">For Designers</a>
      <a href="/advertise">Advertise</a>
      <a href="/careers">Careers</a>
      <a href="/job-board">Job Board</a>
      <a href="https://www.tiktok.com/@dribbble.com">TikTok</a>
      <a href="https://www.instagram.com/dribbble">Instagram</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://dribbble.com/jobs', 'Dribbble Jobs')).toEqual([])
  })

  it('extracts real /jobs/{numericId}-{slug} URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Dribbble Jobs</title></head><body>
      <a href="/jobs/183719-Graphic-Designer?source=index">Graphic Designer</a>
      <a href="/jobs/267968-Social-Media-Designer">Social Media Designer</a>
      <a href="/jobs?page=2">Next page</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://dribbble.com/jobs', 'Dribbble Jobs')
    expect(urls.map((u) => u.url)).toEqual([
      'https://dribbble.com/jobs/183719-Graphic-Designer?source=index',
      'https://dribbble.com/jobs/267968-Social-Media-Designer'
    ])
  })
})

describe('Work At A Startup extractor (regression: company wrappers scraped as jobs)', () => {
  // WAS renders each job card as /companies/{companySlug} (company
  // wrapper, only a short company blurb) linking to /jobs/{numericId}
  // — the JobDetailPage route with full descriptionHtml. Requiring
  // /jobs/{id} picks the page that actually has the description.
  it('extracts zero listings from company-wrapper links', () => {
    const shell = `<!DOCTYPE html><html><head><title>WAS</title></head><body>
      <a href="/companies/sitefire">Sitefire</a>
      <a href="/companies">All companies</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.workatastartup.com/jobs?query=developer', 'Work At A Startup')).toEqual([])
  })

  it('extracts real /jobs/{id} detail URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>WAS</title></head><body>
      <a href="/companies/sitefire">Sitefire</a>
      <a href="/jobs/98761">Founding Product Engineer</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.workatastartup.com/jobs?query=developer', 'Work At A Startup')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.workatastartup.com/jobs/98761'
    ])
  })
})

describe('Ladders extractor (regression: upgrade/corporate links scraped as jobs)', () => {
  // The Ladders' real per-job URLs are /jobs/{companySlug}/{jobId}.
  // The rendered page links /upgrade, /jobs/search-jobs (the search
  // page), and /corporate/{terms,privacy,editorial-policy} — all of
  // which passed the old single-URL rejection and errored.
  it('extracts zero listings from upgrade, search, and corporate links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Ladders</title></head><body>
      <a href="/upgrade">Upgrade</a>
      <a href="/jobs/search-jobs">Search jobs</a>
      <a href="/corporate/terms">Terms</a>
      <a href="/corporate/privacy">Privacy</a>
      <a href="/corporate/editorial-policy">Editorial Policy</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.theladders.com/jobs/search?q=developer', 'Ladders')).toEqual([])
  })

  it('extracts real /jobs/{company}/{id} detail URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Ladders</title></head><body>
      <a href="/jobs/acme-corp/12345678">Senior Software Engineer</a>
      <a href="/upgrade">Upgrade</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.theladders.com/jobs/search?q=developer', 'Ladders')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.theladders.com/jobs/acme-corp/12345678'
    ])
  })
})

describe('Job Bank (GC) extractor (regression: RSS feed and hash links scraped as jobs)', () => {
  // Job Bank's real per-job URLs are /jobsearch/jobposting/{id}. The
  // search page also links the RSS feed
  // (/jobsearch/feed/jobSearchRSSfeed;jsessionid=...), favourite
  // popups (#favourite-popup-N), in-page anchors (#wb-cont), and
  // /career-planning — all passed the generic path regex and errored;
  // the feed URL recurs on every scan.
  it('extracts zero listings from feed, hash, and career-planning links', () => {
    const shell = `<!DOCTYPE html><html><head><title>Job Bank</title></head><body>
      <a href="/jobsearch/feed/jobSearchRSSfeed;jsessionid=ABC?dkw=developer&amp;sort=D">RSS</a>
      <a href="#favourite-popup-50209079">Save to favourites</a>
      <a href="#wb-cont">Skip to main</a>
      <a href="/career-planning">Career planning</a>
    </body></html>`
    expect(extractJobUrls(shell, 'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=developer', 'Job Bank (GC)')).toEqual([])
  })

  it('extracts real /jobsearch/jobposting/{id} URLs (with jsessionid suffix)', () => {
    const card = (id) => `<a href="/jobsearch/jobposting/${id};jsessionid=ABC?source=searchresults" class="resultJobItem"><h3 class="title"><span class="new">New</span><span class="postedonJB">Posted on Job Bank <span class="description">This job was posted directly by the employer on Job Bank.</span></span><span class="noctitle">framing carpenter ${id}</span></h3><ul><li class="date">September 02, 2026</li><li class="business">Megastruct Developments Ltd</li><li class="location">Vancouver BC</li></ul></a>`
    const grid = `<!DOCTYPE html><html><head><title>Job Bank</title></head><body>
      ${card(50209079)}
      ${card(50201021)}
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=developer', 'Job Bank (GC)')
    expect(urls.map((u) => u.url).sort()).toEqual([
      'https://www.jobbank.gc.ca/jobsearch/jobposting/50201021;jsessionid=ABC?source=searchresults',
      'https://www.jobbank.gc.ca/jobsearch/jobposting/50209079;jsessionid=ABC?source=searchresults'
    ])
  })
})

describe('href entity unescaping (regression: Indeed /rc/clk params lost to &amp;)', () => {
  // href attributes are HTML-escaped: <a href="/rc/clk?jk=X&amp;bb=Y">.
  // Fetching the raw attr value sends the literal '&amp;' — Indeed then
  // serves a page with no description (missing-field errors 2026-09-06).
  it('unescapes &amp; into & in extracted URLs', () => {
    const grid = `<!DOCTYPE html><html><head><title>Indeed</title></head><body>
      <a href="/rc/clk?jk=92b8166c200420cf&amp;bb=MXBXYYhpaoJQ&amp;vjs=3">Senior Developer</a>
    </body></html>`
    const urls = extractJobUrls(grid, 'https://www.indeed.com/jobs?q=developer', 'Indeed')
    expect(urls.map((u) => u.url)).toEqual([
      'https://www.indeed.com/rc/clk?jk=92b8166c200420cf&bb=MXBXYYhpaoJQ&vjs=3'
    ])
  })
})

describe('rewired Cloudflare-blocked boards (regression: sitemap extractors admit non-job URLs)', () => {
  // These boards were re-rewired from Cloudflare-challenged search pages
  // to public sitemaps. The extractors must keep only real per-job URLs:
  // Crypto.jobs' sitemap leads with its own bare /jobs search page, and
  // Startup.jobs' CDN index lists non-job sitemaps (collections, tags,
  // markets, roles, articles...) alongside the posts sitemaps.
  it('Crypto.jobs keeps /jobs/ prefixed URLs, drops the bare /jobs search page', async () => {
    vi.mocked(fetchSitemapText).mockImplementation(async (url: string) => {
      if (url === 'https://crypto.jobs/sitemap-jobs.xml') {
        return `<urlset>
          <url><loc>https://crypto.jobs/jobs</loc></url>
          <url><loc>https://crypto.jobs/jobs/business-developer-at-miren-partners</loc></url>
          <url><loc>https://crypto.jobs/jobs/head-of-engineering-at-alemx</loc></url>
          <url><loc>https://crypto.jobs/</loc></url>
        </urlset>`
      }
      return '<urlset></urlset>'
    })
    try {
      const board = BOARDS.find((b) => b.name === 'Crypto.jobs')
      expect(board?.sitemapListingUrls).toBeDefined()
      const urls = await board!.sitemapListingUrls!('data', '')
      expect(urls).toEqual([
        'https://crypto.jobs/jobs/business-developer-at-miren-partners',
        'https://crypto.jobs/jobs/head-of-engineering-at-alemx'
      ])
    } finally {
      vi.mocked(fetchSitemapText).mockImplementation(async (url: string) =>
        url.includes('page=1')
          ? `<urlset>${Array.from({ length: 40 }, (_, i) =>
              `<url><loc>https://www.charityvillage.com/job/test-job-${i}</loc></url>`
            ).join('\n')}</urlset>`
          : '<urlset></urlset>'
      )
    }
  })

  it('Startup.jobs walks posts sitemaps only, keeps /{slug}-{numericId} URLs', async () => {
    vi.mocked(fetchSitemapText).mockImplementation(async (url: string) => {
      if (url === 'https://cdn.startup.jobs/sitemaps/startupjobs/sitemap.xml.gz') {
        return `<sitemapindex>
          <sitemap><loc>https://cdn.startup.jobs/sitemaps/startupjobs/collections.xml.gz</loc></sitemap>
          <sitemap><loc>https://cdn.startup.jobs/sitemaps/startupjobs/tags.xml.gz</loc></sitemap>
          <sitemap><loc>https://cdn.startup.jobs/sitemaps/startupjobs/posts.xml.gz</loc></sitemap>
          <sitemap><loc>https://cdn.startup.jobs/sitemaps/startupjobs/posts1.xml</loc></sitemap>
          <sitemap><loc>https://cdn.startup.jobs/sitemaps/startupjobs/markets.xml.gz</loc></sitemap>
        </sitemapindex>`
      }
      if (url === 'https://cdn.startup.jobs/sitemaps/startupjobs/posts.xml.gz') {
        return `<urlset>
          <url><loc>https://startup.jobs/general-inquiries-dots-23020</loc></url>
          <url><loc>https://startup.jobs/blog</loc></url>
        </urlset>`
      }
      if (url === 'https://cdn.startup.jobs/sitemaps/startupjobs/posts1.xml') {
        return `<urlset>
          <url><loc>https://startup.jobs/deployment-strategist-palantir-23781</loc></url>
          <url><loc>https://startup.jobs/pricing</loc></url>
        </urlset>`
      }
      return '<urlset></urlset>'
    })
    try {
      const board = BOARDS.find((b) => b.name === 'Startup.jobs')
      expect(board?.sitemapListingUrls).toBeDefined()
      const urls = await board!.sitemapListingUrls!('data', '')
      // collections/tags/markets sitemaps never fetched; only posts
      // sitemaps are walked, and only /{slug}-{numericId} URLs kept.
      expect(urls).toEqual([
        'https://startup.jobs/general-inquiries-dots-23020',
        'https://startup.jobs/deployment-strategist-palantir-23781'
      ])
    } finally {
      vi.mocked(fetchSitemapText).mockImplementation(async (url: string) =>
        url.includes('page=1')
          ? `<urlset>${Array.from({ length: 40 }, (_, i) =>
              `<url><loc>https://www.charityvillage.com/job/test-job-${i}</loc></url>`
            ).join('\n')}</urlset>`
          : '<urlset></urlset>'
      )
    }
  })
})

describe('sitemap listing cap (regression: archive-size phantom errors)', () => {
  // Sitemap-listing boards (DailyRemote, NoDesk, CharityVillage) draw
  // from an XML sitemap covering the site's ENTIRE history — DailyRemote
  // ~225k URLs, NoDesk ~15k. Before the cap, the scan ground through the
  // whole archive, the host rate-limited (~2k scrapes in), and the
  // blocked-bailout counted every untouched listing as an error (223k
  // phantom errors from one board). The cap keeps the newest-first head
  // of the list only.
  it('caps sitemap listings at MAX_SITEMAP_LISTINGS, not the full archive', async () => {
    const bigSitemap = Array.from(
      { length: 2000 },
      (_, i) => `<url><loc>https://www.charityvillage.com/job/capped-job-${i}</loc></url>`
    ).join('\n')
    vi.mocked(fetchSitemapText).mockImplementation(async (url: string) =>
      url.includes('page=1') ? `<urlset>${bigSitemap}</urlset>` : '<urlset></urlset>'
    )

    try {
      const result = await scanAllBoards({
        keywords: 'data',
        boards: ['CharityVillage'],
        locations: [{ display: 'Vancouver' }]
      })
      const cv = result.boards.filter((b) => b.board === 'CharityVillage')
      // 2000 sitemap URLs → 1500 listings. Un-capped this would be 2000
      // (and the bailout would phantom-count the ~1980 untouched ones).
      expect(cv).toHaveLength(1)
      expect(cv[0].found).toBe(1500)
      // The scan never grinds the archive tail: only the capped head is
      // ever touched, so the error tally is bounded by the cap — NOT the
      // sitemap's full archive size (which is what produced the 223k
      // DailyRemote / 11.6k NoDesk phantom totals).
      expect(result.totalErrors).toBe(1500)
      expect(result.totalFound).toBe(1500)
    } finally {
      // Restore the default 40-URL sitemap fixture for other tests.
      vi.mocked(fetchSitemapText).mockImplementation(async (url: string) =>
        url.includes('page=1')
          ? `<urlset>${Array.from({ length: 40 }, (_, i) =>
              `<url><loc>https://www.charityvillage.com/job/test-job-${i}</loc></url>`
            ).join('\n')}</urlset>`
          : '<urlset></urlset>'
      )
    }
  })
})