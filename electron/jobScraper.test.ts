import { describe, it, expect, vi } from 'vitest'

// Stub the ./database module the same way ai.test.ts does, so we
// don't pull in the real database (which transitively imports
// electron/logger and requires a live Electron `app` runtime).
vi.mock('./database', () => ({
  getSettings: vi.fn(),
  listApiModels: vi.fn(() => []),
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
  updateDocumentVerification: vi.fn(),
  listApplications: vi.fn(() => []),
  updateApplication: vi.fn(),
  createDocument: vi.fn(),
  getJob: vi.fn()
}))

// Mock ./browserScraper to spy on fetchHtmlViaBrowser while keeping the
// real isChallengePage. The test for the per-listing browser fallback
// asserts the 30s scrape timeout is threaded through to the browser.
vi.mock('./browserScraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browserScraper')>()
  return { ...actual, fetchHtmlViaBrowser: vi.fn(async () => '<html><body>cleared</body></html>') }
})

// Mock undici so the curl-like fallback never makes a real network call
// in tests. Default: reject — fetchViaUndici swallows the error and
// returns null, so existing tests that stub global.fetch with challenge /
// empty-shell pages still exercise the browser fallback as before. The
// rescue test below overrides it with a real page.
vi.mock('undici', () => ({
  request: vi.fn(async () => {
    throw new Error('undici not mocked for this test')
  })
}))

import { isLinkedInStubDescription, scrapeJobFromUrl, detectSource } from './jobScraper'
import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'
import { request as undiciRequest } from 'undici'

// We don't actually hit the network — we stub fetch and feed the
// extractor a realistic LinkedIn HTML page. The shape below mirrors
// the public LinkedIn job-view page when the full JD is gated behind
// the LinkedIn paywall / scrape gate: a short meta description stub
// pointing at the LinkedIn account wall, plus the real body sitting
// in <div class="description__text--rich">. The rich div wraps the
// body in a <section class="show-more-less-html"> (LinkedIn's
// "Show more" / "Show less" collapse) followed by a sibling
// <div class="description__job-criteria-list"> — the show-more-less
// button sits BETWEEN the rich div's </div> and the criteria list,
// which is why the old extractor (anchored on a sibling
// description__job-criteria div) produced zero matches. This is the
// exact shape the user reported on 2026-07-22 for job 4398322407
// (Instacart) — extracted from the actual fetched page.
const STUB_META_HTML = `<!doctype html>
<html>
<head>
  <meta property="og:title" content="Financial Data Analyst hiring at Instacart in Anywhere">
  <meta property="og:description" content="Posted 1:47:02 AM. We&#39;re transforming the grocery industryAt Instacart, we invite the world to share love through food…See this and similar jobs on LinkedIn.">
  <meta name="description" content="Posted 1:47:02 AM. We&#39;re transforming the grocery industryAt Instacart, we invite the world to share love through food…See this and similar jobs on LinkedIn.">
  <meta property="og:site_name" content="LinkedIn">
</head>
<body>
  <div class="description__text description__text--rich">
    <section class="show-more-less-html" data-max-lines="5">
      <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">
        <p>About the job</p>
        <p>We&#39;re transforming the grocery industry</p>
        <p>At Instacart, we invite the world to share love through food because we believe everyone should have access to the food they love and more time to enjoy it together.</p>
        <p>About The Role</p>
        <p>We are seeking a highly skilled and intellectually curious analyst to shape the future of financial data at Instacart. The successful candidate will join the Financial Data Analytics team.</p>
        <p>Key Responsibilities</p>
        <ul><li>Bridge Data &amp; Business Needs</li><li>Own Data Initiatives End-to-End</li></ul>
        <p>CAN $126,000—$133,000 CAD</p>
      </div>
    </section>
  </div>
  <button class="show-more-less-html__button show-more-less-button" data-tracking-control-name="public_jobs_show-more-html-btn">Show more</button>
  <div class="description__job-criteria-list">criteria goes here</div>
</body>
</html>`

describe('LinkedIn scraper stub-description handling', () => {
  it('extracts the real body from description__text--rich when the meta tags carry only the LinkedIn paywall stub', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () => new Response(STUB_META_HTML, { status: 200 })) as unknown as typeof fetch

    try {
      const result = await scrapeJobFromUrl('https://www.linkedin.com/jobs/view/4398322407/')

      // Must NOT have written the stub.
      expect(result.description).toBeDefined()
      expect(result.description).not.toMatch(/see this and similar jobs on linkedin/i)
      // Must have the real body text.
      expect(result.description).toMatch(/transforming the grocery industry/i)
      expect(result.description!.length).toBeGreaterThan(300)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('still rejects JSON-LD description when it is the LinkedIn stub (regression for ba2de25)', async () => {
    // This page has BOTH a stub JSON-LD description AND a real
    // description__text--rich body. The JSON-LD must be rejected, and
    // the real body should be picked up.
    const jsonLdStubHtml = STUB_META_HTML.replace(
      '</head>',
      `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Financial Data Analyst",
  "description": "Posted 11:34:39 AM. See this and similar jobs on LinkedIn.",
  "datePosted": "2026-07-22"
}
</script>
</head>`
    )
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () => new Response(jsonLdStubHtml, { status: 200 })) as unknown as typeof fetch

    try {
      const result = await scrapeJobFromUrl('https://www.linkedin.com/jobs/view/4398322407/')

      expect(result.description).not.toMatch(/see this and similar jobs on linkedin/i)
      expect(result.description).toMatch(/transforming the grocery industry/i)
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('isLinkedInStubDescription', () => {
  // The user-reported stub on 2026-07-22 for job 4398322407. This is
  // the canonical "yes" case — short, with the LinkedIn paywall
  // marker. Used by the gated re-scrape migration to find rows that
  // need a real body pulled.
  it('returns true for the canonical paywall stub', () => {
    const stub = "Posted 1:47:02 AM. We're transforming the grocery industryAt Instacart, we invite the world to share love through food…See this and similar jobs on LinkedIn."
    expect(isLinkedInStubDescription(stub)).toBe(true)
  })

  it('returns true for the "Sign in to see" variant', () => {
    expect(isLinkedInStubDescription("Sign in to see this job. We have an opening at Acme Co.")).toBe(true)
  })

  it('returns false for a real LinkedIn JD body', () => {
    const real = "We're transforming the grocery industry. At Instacart, we invite the world to share love through food because we believe everyone should have access to the food they love and more time to enjoy it together. Where others see a simple need for grocery delivery, we see exciting complexity and endless opportunity to serve the varied needs of our community. We work to deliver an essential service that customers rely on to get their groceries and household goods, while also offering safe and flexible earnings opportunities to Instacart Personal Shoppers."
    expect(real.length).toBeGreaterThan(400)
    expect(isLinkedInStubDescription(real)).toBe(false)
  })

  it('returns false for a 400-char real body with no marker text', () => {
    const real = "A".repeat(400)
    expect(isLinkedInStubDescription(real)).toBe(false)
  })
})

describe('detectSource', () => {
  it('returns RareRoles for rareroles.com', () => {
    expect(detectSource('rareroles.com')).toBe('RareRoles')
    expect(detectSource('www.rareroles.com')).toBe('RareRoles')
  })

  it('returns Flexa for flexa.careers', () => {
    expect(detectSource('flexa.careers')).toBe('Flexa')
    expect(detectSource('www.flexa.careers')).toBe('Flexa')
  })

  it('returns Jobspresso for jobspresso.co', () => {
    expect(detectSource('jobspresso.co')).toBe('Jobspresso')
    expect(detectSource('www.jobspresso.co')).toBe('Jobspresso')
  })

  // New boards from the 2026-07-28 batch
  it('returns FlexJobs for flexjobs.com', () => {
    expect(detectSource('flexjobs.com')).toBe('FlexJobs')
    expect(detectSource('www.flexjobs.com')).toBe('FlexJobs')
  })

  it('returns Virtual Vocations for virtualvocations.com', () => {
    expect(detectSource('virtualvocations.com')).toBe('Virtual Vocations')
    expect(detectSource('www.virtualvocations.com')).toBe('Virtual Vocations')
  })

  it('returns Pangian for pangian.com', () => {
    expect(detectSource('pangian.com')).toBe('Pangian')
    expect(detectSource('www.pangian.com')).toBe('Pangian')
  })

  it('returns PowerToFly for powertofly.com', () => {
    expect(detectSource('powertofly.com')).toBe('PowerToFly')
    expect(detectSource('www.powertofly.com')).toBe('PowerToFly')
  })

  it('returns Dice for dice.com', () => {
    expect(detectSource('dice.com')).toBe('Dice')
    expect(detectSource('www.dice.com')).toBe('Dice')
  })

  it('returns Ladders for theladders.com', () => {
    expect(detectSource('theladders.com')).toBe('Ladders')
    expect(detectSource('www.theladders.com')).toBe('Ladders')
  })

  it('returns Work At A Startup for workatastartup.com', () => {
    expect(detectSource('workatastartup.com')).toBe('Work At A Startup')
    expect(detectSource('www.workatastartup.com')).toBe('Work At A Startup')
  })

  it('returns Career Vault for careervault.io', () => {
    expect(detectSource('careervault.io')).toBe('Career Vault')
    expect(detectSource('www.careervault.io')).toBe('Career Vault')
  })

  it('returns Remote Rocketship for remoterocketship.com', () => {
    expect(detectSource('remoterocketship.com')).toBe('Remote Rocketship')
    expect(detectSource('www.remoterocketship.com')).toBe('Remote Rocketship')
  })

  it('returns Dribbble Jobs for dribbble.com', () => {
    expect(detectSource('dribbble.com')).toBe('Dribbble Jobs')
    expect(detectSource('www.dribbble.com')).toBe('Dribbble Jobs')
  })

  it('returns Behance Jobs for behance.net', () => {
    expect(detectSource('behance.net')).toBe('Behance Jobs')
    expect(detectSource('www.behance.net')).toBe('Behance Jobs')
  })

  it('returns Crossover for crossover.com', () => {
    expect(detectSource('crossover.com')).toBe('Crossover')
    expect(detectSource('www.crossover.com')).toBe('Crossover')
  })

  it('returns AI Jobs for aijobs.ai', () => {
    expect(detectSource('aijobs.ai')).toBe('AI Jobs')
    expect(detectSource('www.aijobs.ai')).toBe('AI Jobs')
  })

  it('returns Toptal for toptal.com', () => {
    expect(detectSource('toptal.com')).toBe('Toptal')
    expect(detectSource('www.toptal.com')).toBe('Toptal')
  })

  it('returns Upwork for upwork.com', () => {
    expect(detectSource('upwork.com')).toBe('Upwork')
    expect(detectSource('www.upwork.com')).toBe('Upwork')
  })

  it('returns Fiverr for fiverr.com', () => {
    expect(detectSource('fiverr.com')).toBe('Fiverr')
    expect(detectSource('www.fiverr.com')).toBe('Fiverr')
  })

  it('returns Gun.io for gun.io', () => {
    expect(detectSource('gun.io')).toBe('Gun.io')
    expect(detectSource('www.gun.io')).toBe('Gun.io')
  })

  it('returns Freelancer for freelancer.com', () => {
    expect(detectSource('freelancer.com')).toBe('Freelancer')
    expect(detectSource('www.freelancer.com')).toBe('Freelancer')
  })

  it('returns PeoplePerHour for peopleperhour.com', () => {
    expect(detectSource('peopleperhour.com')).toBe('PeoplePerHour')
    expect(detectSource('www.peopleperhour.com')).toBe('PeoplePerHour')
  })

  it('returns Hubstaff Talent for hubstaff.com', () => {
    expect(detectSource('hubstaff.com')).toBe('Hubstaff Talent')
    expect(detectSource('www.hubstaff.com')).toBe('Hubstaff Talent')
  })
})

describe('per-listing browser fallback timeout', () => {
  it('passes SCAN_LOAD_TIMEOUT_MS to the browser fallback when a listing page is a challenge page', async () => {
    const fetchHtmlViaBrowserMock = vi.mocked(fetchHtmlViaBrowser)
    const originalFetch = global.fetch
    // ~500 bytes of Cloudflare challenge HTML — big enough to clear the
    // Fix 3 empty-shell check (< 200 bytes) and still hit the challenge path.
    global.fetch = vi.fn(async () =>
      new Response('<html><title>Just a moment...</title></html>'.repeat(10), { status: 200 })
    ) as unknown as typeof fetch

    try {
      fetchHtmlViaBrowserMock.mockClear()
      await expect(scrapeJobFromUrl('https://www.charityvillage.com/job/test-1')).rejects.toThrow()
      expect(fetchHtmlViaBrowserMock).toHaveBeenCalled()
      const [, opts] = fetchHtmlViaBrowserMock.mock.calls[0]
      expect(opts).toMatchObject({ timeoutMs: 30_000 })
    } finally {
      global.fetch = originalFetch
    }
  })
})

// Fixture shape for a Vancouver Jobs (Neogov) posting. The description
// body sits inside the paired itemprop="description" /
// class="jobdescription" wrapper that applyVancouverJobs anchors on.
// The pay-grade label + salary are written the way BC public-sector
// postings actually present them.
function vancouverJobsHtml(opts: { salary: string; payGrade: string }): string {
  return `<!doctype html>
<html>
<head>
  <meta property="og:title" content="Director, Financial Services">
</head>
<body>
  <span itemprop="title">Director, Financial Services</span>
  <span itemprop="hiringOrganization" content="City of Vancouver"></span>
  <span itemprop="description">
    <span class="jobdescription">
      <p>Salary Information:</p>
      <p>${opts.payGrade}: ${opts.salary}</p>
      <p>This is a senior position with the City of Vancouver.</p>
    </span>
  </span>
</body>
</html>`
}

describe('Vancouver Jobs pay-grade salary rewrite', () => {
  it('leaves annual-scale "per annum" salaries untouched (management grades quote annual pay)', async () => {
    // Regression for the $205M bug: EXM- (excluded management) grades on
    // Vancouver Jobs quote ANNUAL salaries, e.g. "$102,960 to $128,691
    // per annum". The pay-grade rewrite must NOT fire for annual-scale
    // amounts — it exists only for unionized RNG- grades that quote
    // hourly rates suffixed with "per annum".
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () =>
      new Response(vancouverJobsHtml({ salary: '$102,960 to $128,691 per annum', payGrade: 'Pay Grade EXM-3' }), { status: 200 })
    ) as unknown as typeof fetch

    try {
      const result = await scrapeJobFromUrl('https://jobs.vancouver.ca/job/12345')

      expect(result.source).toBe('Vancouver Jobs')
      expect(result.salary_range).toBe('$102,960 to $128,691 per annum')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('still rewrites hourly-scale "per annum" to "per hour" for union pay grades (regression for 1987ac1)', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () =>
      new Response(vancouverJobsHtml({ salary: '$60.26 to $75.32 per annum', payGrade: 'Pay Grade RNG-091' }), { status: 200 })
    ) as unknown as typeof fetch

    try {
      const result = await scrapeJobFromUrl('https://jobs.vancouver.ca/job/12346')

      expect(result.salary_range).toBe('$60.26 to $75.32 per hour')
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('empty-shell detection', () => {
  it('treats a sub-200-byte empty shell as blocked, not a parseable page', async () => {
    const originalFetch = global.fetch
    // The exact 39-byte shell CharityVillage returns:
    // <html><head></head><body></body></html>
    global.fetch = vi.fn(async () =>
      new Response('<html><head></head><body></body></html>', { status: 200 })
    ) as unknown as typeof fetch

    try {
      await expect(scrapeJobFromUrl('https://www.charityvillage.com/job/test-1'))
        .rejects.toThrow('Blocked by anti-bot protection (empty shell)')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('does not flag a page larger than 200 bytes as an empty shell', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () =>
      new Response('<html><body>' + '<p>content</p>'.repeat(50) + '</body></html>', { status: 200 })
    ) as unknown as typeof fetch

    try {
      try {
        await scrapeJobFromUrl('https://www.charityvillage.com/job/test-1')
        throw new Error('expected rejection')
      } catch (err) {
        // Extraction legitimately fails on this fixture, but the error
        // must NOT be the empty-shell signature.
        expect((err as Error).message).not.toContain('Blocked by anti-bot protection (empty shell)')
      }
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('undici fallback (curl-like TLS fingerprint rescues WAF-soft-blocked hosts)', () => {
  // CharityVillage and Crypto.jobs answer Electron's global fetch
  // (Chromium net stack) with an empty shell / challenge while serving a
  // plain curl a real 200 page. Before burning a 10-90s headless-browser
  // round trip, fetchPageHtml tries one undici pass over Node's own
  // socket stack. This test proves the rescue: undici's page wins and the
  // browser is never touched.
  it('scrapes through undici when global fetch returns an empty shell', async () => {
    const originalFetch = global.fetch
    const fetchHtmlViaBrowserMock = vi.mocked(fetchHtmlViaBrowser)
    const undiciRequestMock = vi.mocked(undiciRequest)
    // A real CharityVillage listing page — comfortably over the 200-byte
    // empty-shell floor, with og:title / og:site_name / og:description
    // so the generic extractor can complete the scrape.
    const pageHtml = `<!doctype html>
<html>
<head>
  <meta property="og:title" content="Executive Director at Vancouver Food Bank">
  <meta property="og:site_name" content="Vancouver Food Bank">
  <meta property="og:description" content="${'We are seeking an experienced leader to guide our organization. '.repeat(5)}">
</head>
<body>
  <p>${'Job description content. '.repeat(30)}</p>
</body>
</html>`
    undiciRequestMock.mockImplementation(async () => ({
      statusCode: 200,
      body: { text: async () => pageHtml }
    }))

    try {
      // Chromium net stack (global fetch) gets the 39-byte empty shell;
      // undici gets the real page.
      global.fetch = vi.fn(async () =>
        new Response('<html><head></head><body></body></html>', { status: 200 })
      ) as unknown as typeof fetch
      fetchHtmlViaBrowserMock.mockClear()

      const result = await scrapeJobFromUrl('https://www.charityvillage.com/job/test-1')
      expect(result.title).toBe('Executive Director')
      expect(result.company).toBe('Vancouver Food Bank')
      expect(result.description).toMatch(/experienced leader/)
      // The undici pass returned a parseable page, so the browser
      // fallback never ran — no 10-90s round trip for a soft block.
      expect(fetchHtmlViaBrowserMock).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
      undiciRequestMock.mockImplementation(async () => {
        throw new Error('undici not mocked for this test')
      })
    }
  })

  it('rejects an undici challenge page and falls through to the browser', async () => {
    const originalFetch = global.fetch
    const fetchHtmlViaBrowserMock = vi.mocked(fetchHtmlViaBrowser)
    const undiciRequestMock = vi.mocked(undiciRequest)
    undiciRequestMock.mockImplementation(async () => ({
      statusCode: 200,
      body: { text: async () => '<html><title>Just a moment...</title></html>'.repeat(10) }
    }))

    try {
      global.fetch = vi.fn(async () =>
        new Response('<html><head></head><body></body></html>', { status: 200 })
      ) as unknown as typeof fetch
      fetchHtmlViaBrowserMock.mockClear()

      await expect(scrapeJobFromUrl('https://www.charityvillage.com/job/test-1')).rejects.toThrow()
      // The undici page was itself a challenge, so the browser got its
      // chance (mocked) and the scan proceeded as before.
      expect(fetchHtmlViaBrowserMock).toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
      undiciRequestMock.mockImplementation(async () => {
        throw new Error('undici not mocked for this test')
      })
    }
  })
})

// Fixture shape for a Crossover (xoc-pipeline) job page. The Angular
// SPA is fully server-rendered: the h1 > strong.name holds the title,
// xoc-pipeline-salary carries the annual pay with an explicit
// "USD/year" unit, the xoc-pipeline-chips block holds the
// location/work-mode/employment/company chips, and the JD lives in
// repeating .pipeline-content-section blocks (h2 title + body).
// Mirrors the real DOM dumped 2026-08-06 from a Director of Academics
// listing. Note the page deliberately omits the prerender-status-code
// marker — with it, scrapeJobFromUrl would route through the browser.
function crossoverHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta property="og:site_name" content="Crossover">
  <title>Director of Academics</title>
</head>
<body>
  <xoc-pipeline>
    <div class="pipeline-header">
      <h1 data-kontent-element-codename="name" class="title">
        <strong class="name">Director of Academics </strong>
        <div class="salary">
          <xoc-pipeline-salary>
            <span class="tw-bg-gradient-to-r tw-from-[#3bc4b2] tw-to-[#9c72fb] tw-bg-clip-text tw-text-xl tw-font-semibold tw-text-transparent ng-star-inserted"> $400,000 </span> USD/year <sup>info</sup>
            <label class="hourlyrate tw-mb-0 ng-star-inserted">($200 USD/hour)</label>
          </xoc-pipeline-salary>
        </div>
      </h1>
      <xoc-pipeline-chips>
        <div class="infoChips header ng-star-inserted">
          <div class="chip ng-star-inserted">
            <div class="chip-data ng-star-inserted" title="">
              <i class="fas fa-map-marker-alt" aria-hidden="true"></i><span class="chip-text hours" title=""> Worldwide <!----></span>
            </div>
          </div>
          <div class="chip ng-star-inserted">
            <div class="chip-data ng-star-inserted" title="">
              <i class="fas fa-globe-americas" aria-hidden="true"></i><span class="chip-text hours" title=""> Fully-remote <!----></span>
            </div>
          </div>
          <div class="chip ng-star-inserted">
            <div class="chip-data ng-star-inserted" title="">
              <i class="fas fa-clock" aria-hidden="true"></i><span class="chip-text hours" title=""> full-time (40 hrs/week) <!----></span>
            </div>
          </div>
          <div class="chip ng-star-inserted">
            <div class="chip-data ng-star-inserted">
              <a target="_blank" class="chip-link" href="https://ed.crossover.com/clients/2-hour-learning"><i class="fas fa-building" aria-hidden="true"></i><span class="chip-text hours"> 2 Hour Learning </span></a>
            </div>
          </div>
        </div>
      </xoc-pipeline-chips>
    </div>
    <div class="pipeline-body">
      <xoc-pipeline-content>
        <div class="pipeline-content">
          <div xoccontentvisibility="" class="pipeline-content-section ng-star-inserted" style="content-visibility: visible;">
            <h2 class="pipeline-content-section-title">Description</h2>
            <div data-kontent-element-codename="hook" class="contentsection">
              <p>You’ve defined a bold academic vision before and owned the outcomes. You’ve led from the front, not from behind the scenes.</p>
              <p>At 2 Hour Learning, we’ve engineered a model where students learn twice as fast in just two hours a day. AI tutors, mastery-based progression, and a radical departure from conventional classroom structures drive these outcomes.</p>
              <p>This is not an academic theory role. It’s a leadership mandate. You’ll own the academic strategy in practice, set clear standards, identify execution gaps, and coach top-tier teams to deliver real outcomes.</p>
            </div>
          </div>
          <div xoccontentvisibility="" class="pipeline-content-section ng-star-inserted" style="content-visibility: visible;">
            <h2 class="pipeline-content-section-title">What you will be doing</h2>
            <div data-kontent-element-codename="what_you_will_be_doing">
              <ul>
                <li>Creating academic frameworks that translate learning science into practical guidance for curriculum and app design.</li>
                <li>Leading academic execution reviews across Heads of Academics to ensure school teams are aligned, accountable, and delivering results.</li>
              </ul>
            </div>
          </div>
          <div xoccontentvisibility="" class="pipeline-content-section ng-star-inserted" style="content-visibility: visible;">
            <h2 class="pipeline-content-section-title">Candidate requirements</h2>
            <div data-kontent-element-codename="candidate_requirements">
              <ul>
                <li>Advanced degree (Masters or Ph.D) in Learning Science, Educational Psychology, or a related field.</li>
                <li>At least 7 years in academic or EdTech leadership roles, leading a team of staff/employees.</li>
              </ul>
            </div>
          </div>
        </div>
      </xoc-pipeline-content>
    </div>
  </xoc-pipeline>
</body>
</html>`
}

describe('Crossover extractor (xoc-pipeline pages)', () => {
  it('extracts title, chips, salary and full JD from a rendered listing', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () =>
      new Response(crossoverHtml(), { status: 200 })
    ) as unknown as typeof fetch

    try {
      const result = await scrapeJobFromUrl('https://www.crossover.com/jobs/5595/2-hour-learning/director-of-academics')

      expect(result.source).toBe('Crossover')
      expect(result.title).toBe('Director of Academics')
      expect(result.company).toBe('2 Hour Learning')
      expect(result.location).toBe('Worldwide')
      expect(result.work_mode).toBe('REMOTE')
      expect(result.employment_type).toBe('FULL_TIME')
      expect(result.salary_range).toBe('$400,000 USD/year')
      expect(result.description).toContain('Description: You’ve defined a bold academic vision')
      expect(result.description).toContain('What you will be doing: Creating academic frameworks')
      expect(result.description).toContain('Candidate requirements: Advanced degree')
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('isChallengePage weak signal handling (regression: crypto.jobs/web3.career false positives)', () => {
  // challenge-platform and cf-turnstile appear on legitimate Cloudflare-fronted
  // job pages (crypto.jobs, web3.career) — they're injected for passive bot scoring
  // or appear as apply-form widgets. The detector must not false-positive on these
  // when the page has rich job content.
  const richJobPage = (weakSignal: string): string =>
    `<!doctype html><html><head><title>Senior Blockchain Engineer</title></head>
<body><article class="job-listing"><div class="job-description">
<p>We are looking for a senior engineer...</p>
</div></article>
<script src="${weakSignal}"></script>
</body></html>`

  it('returns false for challenge-platform on a rich job page (>50KB)', () => {
    const html = ' '.repeat(50001) + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'
    expect(isChallengePage(html)).toBe(false)
  })

  it('returns false for cf-turnstile on a page with <article>', () => {
    const html = richJobPage('/turnstile.js')
    expect(isChallengePage(html)).toBe(false)
  })

  it('returns false for challenge-platform on a page with <main>', () => {
    const html = `<!doctype html><html><body><main><div class="job">Job details here</div></main>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`
    expect(isChallengePage(html)).toBe(false)
  })

  it('returns true for challenge-platform on a tiny shell (<10KB, no rich markers)', () => {
    const html = '<html><head></head><body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>'
    expect(isChallengePage(html)).toBe(true)
  })

  it('returns true for strong signal "Just a moment..." regardless of rich content', () => {
    const html = richJobPage('') + '<title>Just a moment...</title>'
    expect(isChallengePage(html)).toBe(true)
  })

  it('returns true for strong signal _cf_chl_opt regardless of size', () => {
    const html = ' '.repeat(60000) + '<script>var _cf_chl_opt={}</script>'
    expect(isChallengePage(html)).toBe(true)
  })

  it('returns false for data-turnstile on a page with job-description class', () => {
    const html = `<!doctype html><html><body>
<div class="job-description">We are hiring!</div>
<div data-turnstile-sitekey="test"></div>
</body></html>`
    expect(isChallengePage(html)).toBe(false)
  })

  it('returns true for data-turnstile on a shell with no rich content', () => {
    const html = '<html><body><div data-turnstile-sitekey="test"></div></body></html>'
    expect(isChallengePage(html)).toBe(true)
  })
})

describe('extractMeta apostrophe handling (regression: Freelancer description)', () => {
  // The og:description capture class used to be [^"']* — it stops at
  // the first apostrophe, so Freelancer's "I'm looking for a product
  // designer…" was truncated to 59 chars and rejected by the >100-char
  // threshold in applyGeneric. That surfaced as
  // "missing fields [description]" on real project pages. The capture
  // now back-references the opening quote so apostrophes survive.
  it('extracts a full meta description containing an apostrophe', async () => {
    const originalFetch = global.fetch
    const body =
      '<!doctype html><html><head>' +
      '<meta property="og:title" content="Universal Beverage Dispenser Prototype">' +
      '<meta property="og:site_name" content="Freelancer">' +
      '<meta property="og:description" content="3D Modelling Projects for INR 15000-45000. ' +
      "I'm looking for a skilled product designer to create a physical prototype of a " +
      "universal beverage dispensing platform. The device should dispense multiple beverages " +
      'from a single unit.">' +
      '</head><body></body></html>'

    global.fetch = vi.fn(async () =>
      new Response(body, { status: 200 })
    ) as unknown as typeof fetch

    try {
      const job = await scrapeJobFromUrl('https://www.freelancer.com/projects/prototyping/universal-beverage-dispenser-prototype')
      expect(job.description).toContain("I'm looking for a skilled product designer")
      expect(job.description).toContain('dispense multiple beverages')
    } finally {
      global.fetch = originalFetch
    }
  })
})
