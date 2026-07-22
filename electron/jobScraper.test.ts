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

import { isLinkedInStubDescription, scrapeJobFromUrl } from './jobScraper'

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
