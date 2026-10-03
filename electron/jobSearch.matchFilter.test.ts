import { describe, it, expect, vi, beforeEach } from 'vitest'

// The match floor. `scanAllBoards` used to persist every below-floor
// listing with score=null and still report it as `action: 'added'` — a
// labelling step that filtered nothing, which is how scans filled the
// store with jobs outside the user's experience/industries/skills. Both
// paths that carry the floor (per-listing scrape, first-party API fetch)
// are driven end-to-end through scanAllBoards here.
//
// Mutable fixtures live in vi.hoisted because the mock factories run
// before the module body's top-level consts are initialised.
const fx = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  scrape: { title: '', company: '', location: '', url: '', description: '' },
  rssJobs: [] as unknown[],
  // Stand-in for the store's persistent seen_urls. It is written ONLY by
  // createJob, exactly as the real database writes it, so a scan that
  // quietly recorded a filtered listing's URL would be caught by the
  // next scan reporting it as "Already in database" — the failure that
  // would make a filtered listing permanently unrecoverable.
  persistedUrls: [] as string[]
}))

const LISTING_HTML = `<html><body>
  <a href="/jobs/backend-engineer-12345">Backend Engineer</a>
</body></html>`

let nextJobId = 1

vi.mock('./database', () => ({
  getSettings: vi.fn(() => fx.settings),
  listJobs: vi.fn(() => []),
  getSeenUrls: vi.fn(() => [...fx.persistedUrls]),
  findDuplicateJob: vi.fn(() => false),
  createJob: vi.fn((input: { url?: string | null }) => {
    if (input.url) fx.persistedUrls.push(input.url)
    return { job: { id: nextJobId++, ...(input as object) } }
  }),
  recordBoardResults: vi.fn(),
  recordBoardScanTime: vi.fn(),
  JobBlacklistedError: class extends Error {},
  JobDuplicateError: class extends Error {},
  // Per-provider spend ledger + the cap constants that ai.ts imports at
  // module scope. A partial ./database mock that omits them makes the
  // import fail outright, which surfaces as every assertion in the file
  // failing for a reason that has nothing to do with this file.
  DEFAULT_PROVIDER_CALL_CAP: 50,
  MIN_PROVIDER_CALL_CAP: 1,
  MAX_PROVIDER_CALL_CAP: 100000,
  PROVIDER_SPEND_WINDOW_MS: 86400000,
  recordProviderCall: vi.fn(),
  getProviderSpend: vi.fn(() => ({})),
  clearProviderSpend: vi.fn(),

}))

vi.mock('./netUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./netUtils')>()
  return {
    ...actual,
    fetchPageHtml: vi.fn(async () => LISTING_HTML),
    fetchSitemapText: vi.fn(async () => '<urlset></urlset>')
  }
})

vi.mock('./rssFetcher', () => ({ fetchRssFeed: vi.fn(async () => fx.rssJobs) }))
vi.mock('./aiQueue', () => ({ enqueue: vi.fn() }))
vi.mock('./browserScraper', () => ({ paginateHtmlViaBrowser: vi.fn(), closeCamoufox: vi.fn() }))
vi.mock('./jobScraper', () => ({ scrapeJobFromUrl: vi.fn(async () => ({ ...fx.scrape })) }))
vi.mock('./ai', () => ({
  scoreJobFit: vi.fn(async () => ({
    score: 0.82,
    rationale: 'Strong overlap with the CV.',
    breakdown: { matched_skills: ['typescript', 'node'], missing_skills: [], experience_years_match: true },
    source: 'llm'
  }))
}))

import { scanAllBoards, checkMatchFloor, resolveScanMinMatch, DEFAULT_SCAN_MIN_MATCH } from './jobSearch'
import { createJob } from './database'
import { scoreJobFit } from './ai'
import { scoreCompatibility } from './fitHeuristic'

// A senior backend engineer's CV. Every fixture below is scored against it.
const BASE_CV = `Senior Backend Engineer with 8 years of experience.
Skills: TypeScript, Node.js, PostgreSQL, Docker, AWS, Kubernetes, GraphQL, REST.
Built payment services in Python and Java. Led a team of 5 engineers.
Industry: fintech.`

// 0.00 against BASE_CV. A marine posting shares no measurable evidence
// with a backend-engineering CV, and the evidence-based scorer returns 0
// for "nothing comparable is stated" — the old composite handed every
// unrelated posting exactly 0.20 from neutral seniority/location priors,
// which is how noise beat weak-positive signal. This is the floor's real
// minimum: no threshold above 0 can admit it, and `scan_min_match: 0`
// does (see the recovery tests below).
const IRRELEVANT = {
  title: 'Marine Biologist',
  company: 'Oceanic Research Trust',
  location: 'Vancouver',
  url: 'https://www.indeed.com/viewjob?jk=irrelevant-1',
  description: `Marine Biologist wanted aboard a coral reef research vessel.
You will survey coral bleaching, collect plankton samples, and maintain
the research station. 3 years of experience in marine ecology required.
No software background needed.`
}

// 0.07 against BASE_CV: a real near-miss, not a total non-match. It
// evidences one skill the CV has (python) and nothing else — role 0
// (analyst, not engineer), sector 0 (growth analytics, not fintech
// engineering) — so it scores above zero but below the 0.25 default
// floor. This is the fixture the recovery tests use, because it is the
// case a user is actually reasoning about when they lower a threshold:
// borderline, not hopeless.
const NEAR_MISS = {
  title: 'Data Analyst, Growth',
  company: 'Funnelworks',
  location: 'Vancouver',
  url: 'https://www.indeed.com/viewjob?jk=nearmiss-1',
  description: `We are hiring a Data Analyst to instrument our signup funnel.
You will write SQL, run A/B tests, build dashboards in Amplitude and analyse retention.
Requirements: 2+ years in product or growth analytics, SQL, Python, statistics, experimentation. Tableau.`
}

// 0.96 against BASE_CV: comfortably above the floor.
const RELEVANT = {
  title: 'Senior Backend Engineer',
  company: 'Payments Co',
  location: 'Vancouver',
  url: 'https://www.indeed.com/viewjob?jk=relevant-1',
  description: `Senior Backend Engineer (Node.js / TypeScript) — payments platform.
Requirements: 8+ years of experience building backend services in TypeScript
and Node.js, PostgreSQL, Docker, AWS. You will design GraphQL and REST APIs
for a fintech payments product and mentor a team of engineers. Kubernetes
experience required.`
}

// 0.87 against BASE_CV — above the default floor, but not by much, so
// raising the threshold flips it.
const BORDERLINE = {
  title: 'Backend Engineer',
  company: 'Midco',
  location: 'Vancouver',
  url: 'https://www.indeed.com/viewjob?jk=borderline-1',
  description: 'Backend Engineer building Node.js services backed by PostgreSQL.'
}

interface SettingsOverride {
  base_cv?: string
  scan_min_match?: number
}

function reset(overrides: SettingsOverride = {}) {
  nextJobId = 1
  Object.assign(fx.settings, {
    job_search_keywords: '',
    job_search_locations: '',
    base_cv: '',
    disabled_boards: [],
    cv_version: 0
  }, overrides)
  fx.scrape = { ...IRRELEVANT }
  fx.rssJobs = []
  fx.persistedUrls = []
  vi.mocked(createJob).mockClear()
  vi.mocked(scoreJobFit).mockClear()
}

beforeEach(() => { reset() })

describe('scan match floor — per-listing scrape path', () => {
  it('skips a below-floor listing instead of adding it', async () => {
    reset({ base_cv: BASE_CV })
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Talent.com'],
      locations: [{ display: 'Vancouver' }]
    })
    const board = result.boards.find((b) => b.board === 'Talent.com')!
    expect(board.found).toBe(1)
    expect(board.added).toBe(0)
    expect(board.skipped).toBe(1)
    expect(result.totalAdded).toBe(0)
    expect(result.totalSkipped).toBe(1)
    // The whole point: nothing was written to the store...
    expect(createJob).not.toHaveBeenCalled()
    // ...and the LLM was never paid to score it.
    expect(scoreJobFit).not.toHaveBeenCalled()
  })

  it('adds a listing at or above the floor as before', async () => {
    reset({ base_cv: BASE_CV })
    fx.scrape = { ...RELEVANT }
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Talent.com'],
      locations: [{ display: 'Vancouver' }]
    })
    const board = result.boards.find((b) => b.board === 'Talent.com')!
    expect(board.found).toBe(1)
    expect(board.added).toBe(1)
    expect(board.skipped).toBe(0)
    expect(result.totalAdded).toBe(1)
    expect(createJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createJob).mock.calls[0][0]).toMatchObject({
      title: 'Senior Backend Engineer',
      company: 'Payments Co'
    })
    expect(result.notes).toEqual([])
  })

  it('states the threshold in the scan-result note', async () => {
    reset({ base_cv: BASE_CV })
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Talent.com'],
      locations: [{ display: 'Vancouver' }]
    })
    const note = result.notes.join('\n')
    expect(note).toMatch(/below the match threshold/i)
    expect(note).toContain(String(DEFAULT_SCAN_MIN_MATCH))
    expect(note).toMatch(/Settings → Scan/)
  })
})

describe('scan match floor — first-party API path', () => {
  it('skips a below-floor listing instead of adding it', async () => {
    reset({ base_cv: BASE_CV })
    fx.rssJobs = [IRRELEVANT]
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    const board = result.boards.find((b) => b.board === 'Indeed (RSS)')!
    expect(board.found).toBe(1)
    expect(board.added).toBe(0)
    expect(board.skipped).toBe(1)
    expect(result.totalSkipped).toBe(1)
    expect(createJob).not.toHaveBeenCalled()
  })

  it('adds an above-floor listing as before', async () => {
    reset({ base_cv: BASE_CV })
    fx.rssJobs = [RELEVANT, BORDERLINE]
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    const board = result.boards.find((b) => b.board === 'Indeed (RSS)')!
    expect(board.found).toBe(2)
    expect(board.added).toBe(2)
    expect(board.skipped).toBe(0)
    expect(result.totalAdded).toBe(2)
    expect(createJob).toHaveBeenCalledTimes(2)
  })

  it('honours scan_min_match: raising it skips what the default would add', async () => {
    reset({ base_cv: BASE_CV })
    fx.rssJobs = [BORDERLINE]
    const atDefault = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(atDefault.totalAdded).toBe(1)
    expect(atDefault.totalSkipped).toBe(0)
    vi.mocked(createJob).mockClear()

    reset({ base_cv: BASE_CV, scan_min_match: 0.9 })
    fx.rssJobs = [BORDERLINE]
    const raised = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(raised.totalAdded).toBe(0)
    expect(raised.totalSkipped).toBe(1)
    expect(createJob).not.toHaveBeenCalled()
    expect(raised.notes.join('\n')).toContain('0.9')
  })

  it('honours a lowered scan_min_match on a near-miss the default drops', async () => {
    // The reason a user moves the threshold at all. IRRELEVANT scores
    // exactly 0.00 under the evidence-based scorer, so no threshold
    // above 0 can admit it (0 < 0.1) and using it here would only be
    // testing arithmetic. A genuine near-miss is the case that matters:
    // a threshold below its score re-admits it.
    const score = scoreCompatibility(NEAR_MISS.title, NEAR_MISS.description, BASE_CV)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(DEFAULT_SCAN_MIN_MATCH)
    const lowered = Number((score / 2).toFixed(4))

    reset({ base_cv: BASE_CV, scan_min_match: lowered })
    fx.rssJobs = [NEAR_MISS]
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(result.totalAdded).toBe(1)
    expect(result.totalSkipped).toBe(0)
    expect(createJob).toHaveBeenCalledTimes(1)
  })
})

describe('scan with no base CV', () => {
  // Deliberately permissive (see the commit body): with no CV there is
  // no signal, so nothing is filtered — but the run says so out loud
  // instead of silently flooding the store.
  it('adds everything and says the match filter was off', async () => {
    reset({ base_cv: '' })
    fx.rssJobs = [IRRELEVANT, RELEVANT]
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(result.totalFound).toBe(2)
    expect(result.totalAdded).toBe(2)
    expect(result.totalSkipped).toBe(0)
    expect(createJob).toHaveBeenCalledTimes(2)
    const note = result.notes.join('\n')
    expect(note).toMatch(/no base CV is configured/i)
    // The note has to point at the fix, not just complain.
    expect(note).toMatch(/Settings → Profile/)
  })

  it('filters nothing even with a raised threshold, since there is nothing to compare', async () => {
    reset({ base_cv: '', scan_min_match: 1 })
    fx.rssJobs = [IRRELEVANT]
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(result.totalAdded).toBe(1)
    expect(result.totalSkipped).toBe(0)
  })

  it('says nothing about a no-CV run that found no listings at all', async () => {
    reset({ base_cv: '' })
    fx.rssJobs = []
    const result = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(result.totalFound).toBe(0)
    expect(result.notes).toEqual([])
  })
})

describe('a filtered listing is recoverable', () => {
  it('re-admits a near-miss on a later scan once the threshold is lowered', async () => {
    // The floor must not leave a permanent mark: the listing was never
    // written, so a later run at a lower threshold still sees it. This
    // is the escape hatch for a user who filtered too aggressively, and
    // it is asserted across two separate scans rather than one, so the
    // in-run dedupe set cannot be what let it back in.
    const score = scoreCompatibility(NEAR_MISS.title, NEAR_MISS.description, BASE_CV)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(DEFAULT_SCAN_MIN_MATCH)

    reset({ base_cv: BASE_CV })
    fx.rssJobs = [NEAR_MISS]
    const first = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(first.totalFound).toBe(1)
    expect(first.totalAdded).toBe(0)
    expect(first.totalSkipped).toBe(1)
    expect(createJob).not.toHaveBeenCalled()
    // The filtered listing left no trace in the store's seen-urls. If
    // it had, the scan below would skip it as "Already in database" and
    // the recovery would silently stop working.
    expect(fx.persistedUrls).toEqual([])

    reset({ base_cv: BASE_CV, scan_min_match: Number((score / 2).toFixed(4)) })
    fx.rssJobs = [NEAR_MISS]
    const second = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(second.totalAdded).toBe(1)
    expect(createJob).toHaveBeenCalledTimes(1)
  })

  it('re-admits a zero-score listing at scan_min_match 0, and only there', async () => {
    // Under the evidence-based scorer a posting that states nothing
    // comparable scores 0.00 rather than collecting a neutral prior.
    // 0 < min_match for every threshold above 0, so no setting other
    // than 0 can bring such a listing back — that is what a floor means,
    // not a guard that discards zero specially, and `checkMatchFloor(0,
    // 0)` passing below is the same fact stated in one line. The
    // settings control offers 0 explicitly for exactly this.
    const score = scoreCompatibility(IRRELEVANT.title, IRRELEVANT.description, BASE_CV)
    expect(score).toBe(0)

    reset({ base_cv: BASE_CV, scan_min_match: 0.1 })
    fx.rssJobs = [IRRELEVANT]
    const notQuite = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(notQuite.totalAdded).toBe(0)
    expect(notQuite.totalSkipped).toBe(1)

    reset({ base_cv: BASE_CV, scan_min_match: 0 })
    fx.rssJobs = [IRRELEVANT]
    const atZero = await scanAllBoards({
      keywords: 'engineer',
      boards: ['Indeed (RSS)'],
      locations: [{ display: 'Vancouver' }]
    })
    expect(atZero.totalAdded).toBe(1)
    expect(atZero.totalSkipped).toBe(0)
    expect(createJob).toHaveBeenCalledTimes(1)
  })
})

describe('checkMatchFloor', () => {
  it('passes a score at or above the threshold', () => {
    expect(checkMatchFloor(0.25, 0.25)).toEqual({ pass: true })
    expect(checkMatchFloor(0.9, 0.25)).toEqual({ pass: true })
  })

  it('treats 0 as a score, not as a reason to skip unconditionally', () => {
    // The regression this guards: an early-out on a zero score would
    // make a listing un-admittable at ANY threshold, including 0, and
    // a user lowering the setting to 0 would get nothing back.
    expect(checkMatchFloor(0, 0)).toEqual({ pass: true })
    expect(checkMatchFloor(0, 0.0001).pass).toBe(false)
  })

  it('fails a score below the threshold with a specific, non-empty reason', () => {
    const decision = checkMatchFloor(0.18, 0.25)
    expect(decision.pass).toBe(false)
    const reason = (decision as { reason: string }).reason
    expect(reason.trim().length).toBeGreaterThan(0)
    // Names the score and the threshold, so the user can act on it.
    expect(reason).toContain('0.18')
    expect(reason).toContain('0.25')
    expect(reason).toMatch(/below match threshold/i)
  })
})

describe('resolveScanMinMatch', () => {
  it('falls back to the default for a missing or unusable value', () => {
    expect(DEFAULT_SCAN_MIN_MATCH).toBe(0.25)
    expect(resolveScanMinMatch(undefined)).toBe(0.25)
    expect(resolveScanMinMatch(null)).toBe(0.25)
    // NaN makes every comparison false and would silently disable the
    // floor — the failure this whole change exists to close.
    expect(resolveScanMinMatch(NaN)).toBe(0.25)
    expect(resolveScanMinMatch('0.5')).toBe(0.25)
    expect(resolveScanMinMatch(Infinity)).toBe(0.25)
  })

  it('clamps an out-of-range value to the nearest bound', () => {
    expect(resolveScanMinMatch(-1)).toBe(0)
    expect(resolveScanMinMatch(5)).toBe(1)
  })

  it('passes a valid user value through untouched', () => {
    expect(resolveScanMinMatch(0)).toBe(0)
    expect(resolveScanMinMatch(0.6)).toBe(0.6)
    expect(resolveScanMinMatch(1)).toBe(1)
  })
})
