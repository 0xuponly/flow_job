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

import { scrapeJobFromUrl } from './jobScraper'

// We don't actually hit the network — we stub fetch and feed the
// extractor a realistic LinkedIn HTML page. The shape below mirrors
// the public LinkedIn job-view page when the full JD is gated behind
// the LinkedIn paywall / scrape gate: a short meta description stub
// pointing at the LinkedIn account wall, plus the real body sitting
// in <div class="description__text--rich">. This is the exact shape
// the user reported on 2026-07-22 for job 4398322407 (Instacart).
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
    <p>About the job</p>
    <p>We&#39;re transforming the grocery industry</p>
    <p>At Instacart, we invite the world to share love through food because we believe everyone should have access to the food they love and more time to enjoy it together.</p>
    <p>About The Role</p>
    <p>We are seeking a highly skilled and intellectually curious analyst to shape the future of financial data at Instacart. The successful candidate will join the Financial Data Analytics team.</p>
    <p>Key Responsibilities</p>
    <ul><li>Bridge Data &amp; Business Needs</li><li>Own Data Initiatives End-to-End</li></ul>
    <p>CAN $126,000—$133,000 CAD</p>
  </div>
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
