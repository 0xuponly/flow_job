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

import { scanAllBoards } from './jobSearch'

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