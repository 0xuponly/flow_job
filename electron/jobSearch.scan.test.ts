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
vi.mock('./browserScraper', () => ({ paginateHtmlViaBrowser: vi.fn() }))

import { scanAllBoards } from './jobSearch'

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