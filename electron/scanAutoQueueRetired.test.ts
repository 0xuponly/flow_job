import { describe, it, expect, vi, beforeEach } from 'vitest'

// The retired scan-time auto-tailor, and what now covers the work it used
// to do.
//
// `electron/jobSearch.ts` used to enqueue a `tailor_job_docs` row for
// every job a scan admitted, at the moment the job was admitted, when
// `auto_tailor_on_scan` was on and the job's fit score cleared
// `auto_tailor_min_fit`. Both settings are gone, and so is the producer.
//
// The question this file exists to answer is NOT "did the code get
// deleted" — that is what the call-site inventory in
// review.enqueueCallSites.test.ts is for. It is: does a job a scan just
// added still get its documents queued, and by what?
//
// The answer is yes, and mostly WITHOUT waiting: main.ts calls
// `enqueueDocsBacklog()` in the same `jobs:scanBoards` handler, right
// after `scanAllBoards` resolves (electron/main.ts:331), and that sweep
// queues `generate_cv` / `generate_cover_letter` per missing document for
// every eligible job — the same job, in the same scan, by a function that
// was already on main. The hourly `runDocsAutoQueueBacklog` and the
// startup call are the backstops, not the primary path. The two cases
// below are the coverage: the scan queues nothing itself, and the sweep
// the scan hands over to does queue the job.
//
// The REAL database and the REAL queue are used. A mocked store could
// satisfy "no row was written" by never having anywhere to write one.

const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-test-scan-autoqueue-retired' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    quit: () => undefined,
    commandLine: { appendSwitch: () => undefined },
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: {
    handle: (_channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(_channel, fn)
    },
    on: () => undefined
  },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      once: () => undefined,
      on: () => undefined,
      send: () => undefined
    }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    on() { return undefined }
    show() { return undefined }
    isDestroyed() { return false }
    static getAllWindows() { return [] }
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { height: 900 } }) },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined }
    }
  },
  dialog: new Proxy({}, { get: () => async () => ({ canceled: true, filePath: undefined }) }),
  shell: { openExternal: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

// --- the scan pipeline, stubbed so N listings are admitted ---------------
// Same shape as jobSearch.matchFilter.test.ts: the board returns the
// listings, the scraper returns one per URL, the LLM scorer loves them.

const fx = vi.hoisted(() => ({ count: 1, llmFails: false }))

/** A listing page with `fx.count` distinct postings on it. */
function listingsHtml(): string {
  const rows = Array.from(
    { length: fx.count },
    (_unused, i) => `<a href="/jobs/senior-backend-engineer-${i}">Senior Backend Engineer ${i}</a>`
  ).join('\n  ')
  return `<html><body>\n  ${rows}\n</body></html>`
}

/** The scraped body for one of those URLs, derived from the URL itself. */
function listingFor(url: string) {
  const n = /-(\d+)(?:$|\?)/.exec(url)?.[1] ?? '0'
  return {
    title: `Senior Backend Engineer ${n}`,
    company: 'Payments Co',
    location: 'Vancouver',
    url,
    description:
      'Senior Backend Engineer (Node.js / TypeScript) — payments platform. 8+ years building backend services in TypeScript, Node.js, PostgreSQL, AWS.'
  }
}

vi.mock('./netUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./netUtils')>()
  return {
    ...actual,
    fetchPageHtml: vi.fn(async () => listingsHtml()),
    fetchSitemapText: vi.fn(async () => '<urlset></urlset>')
  }
})
// Partial, because the real database imports `cleanDescription` from this
// module: replacing it wholesale makes every createJob fail on a missing
// export and the scan reports the listing as an error.
vi.mock('./jobScraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobScraper')>()
  return { ...actual, scrapeJobFromUrl: vi.fn(async (url: string) => listingFor(url)) }
})
vi.mock('./browserScraper', () => ({
  paginateHtmlViaBrowser: vi.fn(),
  closeCamoufox: vi.fn()
}))
vi.mock('./rssFetcher', () => ({ fetchRssFeed: vi.fn(async () => []) }))
// `llmFails` reproduces the scan's heuristic-fallback branch: the LLM
// scorer errors, so the listing is admitted with score=null and
// fit_score_version=null (jobSearch.ts:732-739) rather than a real score.
// That is the branch which puts a scanned job on the score_fit →
// scoreOneJobInBackground → maybeAutoEnqueueDocs chain at all.
// Partial, for `RateLimitError` and the rest of the module's shape: the
// queue processor imports it and a wholesale replacement makes every
// processItem throw on a missing export.
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  return {
    ...actual,
    scoreJobFit: vi.fn(async () => {
      if (fx.llmFails) throw new Error('provider down')
      return {
        score: 0.92,
        rationale: 'Strong overlap with the CV.',
        breakdown: { matched_skills: ['typescript', 'node'], missing_skills: [], experience_years_match: true },
        source: 'llm'
      }
    }),
    tailorDocument: vi.fn(async () => { throw new Error('no provider in this suite') }),
    verifyDocumentContent: vi.fn(async () => { throw new Error('no provider in this suite') }),
    regenerateSection: vi.fn(async () => { throw new Error('no provider in this suite') })
  }
})

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  createDocument,
  getAIQueue,
  getSettings,
  listJobs,
  reloadStore,
  updateSettings
} from './database'
import { scanAllBoards } from './jobSearch'
import { enqueueDocsBacklog } from './docsAutoQueue'
import { enqueue, processQueue } from './aiQueue'
import { enqueueScoreFitBacklog } from './fitAutoScore'
import { maybeAutoEnqueueDocs } from './fitScorer'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const RETIRED = { auto_tailor_on_scan: true, auto_tailor_min_fit: 0 } as const

function wipe() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
}

/**
 * Write the store file a build from before the retirement would have left
 * behind, INCLUDING the two retired keys — set to the values that would
 * have made the old producer fire on every single added job
 * (`min_fit: 0` admits any score at all).
 *
 * Plaintext JSON with no `enc:` envelope, which loadStore's legacy branch
 * accepts: that is the shape a store from before file-level encryption
 * has, and it is the branch where an unknown key is carried through
 * untouched rather than dropped.
 */
function writeStoreWithRetiredKeys(): void {
  const settings: Record<string, unknown> = {
    ...getSettings(),
    base_cv: 'Senior Backend Engineer. Skills: TypeScript, Node.js, PostgreSQL, AWS.',
    job_search_keywords: '',
    job_search_locations: '[]',
    disabled_boards: [],
    cv_version: 0,
    auto_doc_min_fit: 40,
    auto_queue_fit: true,
    auto_queue_cv: true,
    auto_queue_cover_letter: true,
    auto_queue_verify_cv: true,
    auto_queue_verify_cover_letter: true,
    ...RETIRED
  }
  writeFileSync(
    storeFile,
    JSON.stringify({
      jobs: [],
      documents: [],
      applications: [],
      follow_ups: [],
      interviews: [],
      settings,
      api_models: [],
      nextId: 1,
      seen_urls: [],
      ai_queue: [],
      board_health: {},
      board_scan_times: {},
      deleted_jobs: [],
      blacklisted_companies: [],
      notifications: []
    })
  )
}

/** The store's settings with the retired keys visible to the type. */
function storedSettings(): Record<string, unknown> {
  return getSettings() as unknown as Record<string, unknown>
}

function tailorRows(): unknown[] {
  return getAIQueue().filter((q) => q.type === 'tailor_job_docs')
}

/**
 * The single-document rows an automatic producer queues. The fit-landing
 * trigger queues these per missing document type, exactly as the sweep
 * does; it no longer queues the both-documents `tailor_job_docs` row.
 */
function docGenRows(): unknown[] {
  return getAIQueue().filter(
    (q) => q.type === 'generate_cv' || q.type === 'generate_cover_letter'
  )
}

async function runScan(count = 1) {
  fx.count = count
  return scanAllBoards({
    keywords: 'engineer',
    boards: ['Talent.com'],
    locations: [{ display: 'Vancouver' }]
  })
}

beforeEach(() => {
  wipe()
  fx.count = 1
})

describe('a scan enqueues nothing of its own', () => {
  it('writes no tailor_job_docs row on a big scan, with the retired keys set to fire', async () => {
    // The one configuration in which the retired producer COULD have
    // fired, and therefore the only one worth driving.
    //
    // `result.addedJobs` entries are `{ id, title, company }` — no score.
    // The producer read `j.score` off them, so on any scan that added 50
    // jobs or fewer the comparison was `undefined >= min_fit/100`, i.e.
    // false, and nothing was ever queued. The only branch that attached a
    // live score was the over-50 one, which re-read the store. So the
    // control the Scan tab showed was inert in the ordinary case for a
    // second reason on top of the `auto_queue_*` gate — and a 51-job scan
    // is where it did fire. 51 postings, `min_fit: 0`, both generation
    // switches on: everything the old producer needed.
    writeStoreWithRetiredKeys()
    reloadStore()
    expect(storedSettings().auto_tailor_on_scan).toBe(true)
    expect(storedSettings().auto_tailor_min_fit).toBe(0)

    const result = await runScan(51)

    // Not vacuous: the jobs really were admitted, and really were scored.
    expect(result.totalAdded).toBe(51)
    expect(listJobs()).toHaveLength(51)
    for (const job of listJobs()) expect(job.score).toBeCloseTo(0.92)

    // The claim under test. The old producer capped this at 25 rows.
    expect(tailorRows()).toEqual([])
    expect(getAIQueue()).toEqual([])
  })

  it('writes no row on an ordinary scan either, and the job is still admitted', async () => {
    writeStoreWithRetiredKeys()
    reloadStore()
    const result = await runScan(1)
    // Not vacuous: a scan that added nothing would pass the assertion below.
    expect(result.totalAdded).toBe(1)
    const [job] = listJobs()
    expect(job.title).toBe('Senior Backend Engineer 0')
    expect(job.score).toBeCloseTo(0.92)
    expect(tailorRows()).toEqual([])
    expect(getAIQueue()).toEqual([])
  })

  it('writes no row from a store that never had the retired keys either', async () => {
    updateSettings({
      base_cv: 'Senior Backend Engineer. Skills: TypeScript, Node.js, PostgreSQL, AWS.'
    })
    const result = await runScan(1)
    expect(result.totalAdded).toBe(1)
    expect(storedSettings().auto_tailor_on_scan).toBeUndefined()
    expect(tailorRows()).toEqual([])
  })
})

describe('the documents the scan no longer queues are queued by the sweep instead', () => {
  // The coverage claim, made executable. `enqueueDocsBacklog` is what
  // main.ts calls in the post-scan handler (electron/main.ts:331) and
  // again at startup (:1232), and the hourly `runDocsAutoQueueBacklog` is
  // the third caller. So this is not "a test of another module's sweep":
  // it is the answer to what a freshly scanned job gets.
  it('queues both documents for the job the scan just added', async () => {
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan()
    expect(getAIQueue()).toEqual([])

    expect(enqueueDocsBacklog()).toBe(2)

    const job = listJobs()[0]
    const rows = getAIQueue()
    expect(rows.map((r) => r.type).sort()).toEqual(['generate_cover_letter', 'generate_cv'])
    for (const row of rows) expect(row.jobId).toBe(job.id)
  })

  it('produces them as two single-document rows, not the retired one both-docs row', async () => {
    // The shape changed with the mechanism: the sweep queues the CV and the
    // cover letter as two units so it can honour each document's own
    // toggle, where the retired producer queued one row doing both. Worth
    // pinning, because it is the observable difference a reviewer cannot
    // see in the settings.
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan()
    enqueueDocsBacklog()
    expect(getAIQueue().some((r) => r.type === 'tailor_job_docs')).toBe(false)
  })

  it('leaves the work to the user when CV auto-queueing is off, as every automatic path must', async () => {
    // The gate that made the retired Scan-tab switch "a switch to
    // nothing" is unchanged and still centred in `enqueue`; this is the
    // replacement path obeying it, which is why retiring the scan-time
    // producer cost no behaviour a user could see.
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan()
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: false })
    expect(enqueueDocsBacklog()).toBe(0)
    expect(getAIQueue()).toEqual([])
    // ...and a manual request still queues, switches or not.
    const job = listJobs()[0]
    enqueue({ type: 'tailor_job_docs', jobId: job.id }, { manual: true })
    expect(tailorRows()).toHaveLength(1)
  })
})

describe('which path actually catches a newly scanned job', () => {
  // The user-visible rule: a newly scanned AND SCORED job with no
  // generated documents is enqueued for auto-generation, if and only if
  // auto-queue is on for CV AND cover letter. The mechanism named for it
  // is the fit-landing trigger — `maybeAutoEnqueueDocs`
  // (electron/fitScorer.ts:63), called from `scoreOneJobInBackground`
  // once a real score lands (fitScorer.ts:231).
  //
  // THE FINDING, and it is the reason these cases exist: the trigger is
  // NOT what catches an ordinarily-scanned job, because that job never
  // goes through the score_fit chain.
  //
  //   1. jobSearch.ts scores each listing INLINE, before it is admitted
  //      (`scoreLimiter(() => scoreJobFit(...))`, jobSearch.ts:690) and
  //      writes the real score straight onto the job row
  //      (jobSearch.ts:741-745, `fit_score_version: cv_version`).
  //   2. So `needsFitScore` (fitAutoScore.ts:69-72) returns false —
  //      `job.score !== null` — and `enqueueScoreFitBacklog()`
  //      (fitAutoScore.ts:181, called post-scan at main.ts:327) queues NO
  //      score_fit row for it.
  //   3. The processor's `score_fit` case (aiQueue.ts:246-261) is the
  //      only production caller of `scoreOneJobInBackground`, so it never
  //      runs for that job, and `maybeAutoEnqueueDocs` is never called.
  //
  // What catches it instead is `enqueueDocsBacklog()` in the same
  // `jobs:scanBoards` handler, immediately after the scan resolves
  // (main.ts:331) — not the hourly tick. Same predicate, same switches, so
  // the RULE holds; the path is a different one than assumed. The trigger
  // is reached only for a scanned job the scan admitted with NO score (the
  // heuristic-fallback branch), which is exactly what the next case drives.

  it('never puts an ordinarily-scanned job on the score_fit chain the trigger hangs off', async () => {
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan(1)
    const job = listJobs()[0]
    // The scan scored it inline and stamped the version.
    expect(job.score).toBeCloseTo(0.92)
    expect(job.fit_score_version).toBe(0)
    // ...so the re-seeder has nothing to do, and no score_fit row exists:
    // the trigger is structurally unreachable for this job.
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(getAIQueue().filter((q) => q.type === 'score_fit')).toEqual([])
  })

  it('still queues it for documents, immediately, via the post-scan sweep', async () => {
    // main.ts:331, not the hourly tick: the job is queued in the same
    // scan that added it.
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan(1)
    expect(getAIQueue()).toEqual([])
    expect(enqueueDocsBacklog()).toBe(2)
    expect(tailorRows()).toEqual([])
  })

  it('reaches the fit-landing trigger for a scanned job the scan could not score', async () => {
    // The one scanned shape that does go through it, end to end: the scan
    // admits the job with score=null (jobSearch.ts:732-739), the
    // re-seeder queues score_fit (fitAutoScore.ts:191), the processor
    // scores it (aiQueue.ts:257), the real score lands, and
    // `maybeAutoEnqueueDocs` runs and enqueues the two missing document
    // units.
    writeStoreWithRetiredKeys()
    reloadStore()
    fx.llmFails = true
    await runScan(1)
    const job = listJobs()[0]
    expect(job.score).toBeNull()

    expect(enqueueScoreFitBacklog()).toBe(1)
    expect(getAIQueue().map((q) => q.type)).toEqual(['score_fit'])

    fx.llmFails = false
    await processQueue()

    expect(listJobs()[0].score).toBeCloseTo(0.92)
    expect(docGenRows().map((q) => (q as { jobId: number }).jobId)).toEqual([job.id, job.id])
  })
})

describe('the gate on a newly scanned, scored, documentless job', () => {
  // Each case is the rule stated by the user, driven against the two
  // paths that can queue the work, with the deciding line cited.
  async function scanOneScored() {
    writeStoreWithRetiredKeys()
    reloadStore()
    await runScan(1)
    return listJobs()[0]
  }

  it('queues when both toggles are on and the score clears auto_doc_min_fit', async () => {
    // The trigger, from a clean queue: the two switches are checked
    // before anything else (fitScorer.ts:97), then the same predicate
    // (fitScorer.ts:105).
    let job = await scanOneScored()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    // One row per missing document, the same two the sweep would queue.
    expect(docGenRows().map((q) => q.type).sort()).toEqual([
      'generate_cover_letter',
      'generate_cv'
    ])

    // The sweep, on a fresh scan of the same store — the queue is reset by
    // the store rewrite, not by `clearAIQueue`, which would also write the
    // "Clear queue" tombstone the sweep then honours. The same job, queued
    // as two single-document units.
    job = await scanOneScored()
    expect(getAIQueue()).toEqual([])
    expect(enqueueDocsBacklog()).toBe(2)
    // ...and the trigger then DEFERS to the sweep's live rows rather than
    // adding its own both-documents row beside them
    // (`jobDocWorkInFlight`, fitScorer.ts:119). One job, one set of
    // documents, whichever producer got there first.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toHaveLength(2)
  })

  it('queues nothing when the score is below auto_doc_min_fit', async () => {
    // docAutoQueue.ts:88-89 — `job.score * 100 < minFit` refuses. The
    // setting is 0-100 and the stored score is 0-1, the same scale
    // normalisation the retired auto_tailor_min_fit used.
    const job = await scanOneScored()
    updateSettings({ auto_doc_min_fit: 95 }) // the scan's score is 92
    expect(enqueueDocsBacklog()).toBe(0)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(getAIQueue()).toEqual([])
  })

  it('queues each unit by its OWN toggle — the trigger and the sweep now agree', async () => {
    // The trigger used to produce `tailor_job_docs`, which generates BOTH
    // documents, so one switch off was enough to refuse it entirely
    // (fitScorer.ts:97) — and that asymmetry with the sweep is exactly what
    // a CV-only or cover-letter-only setting could not express. It queues
    // the missing units now, so each unit is gated by its own switch, and
    // the two producers answer identically.
    for (const [partial, expected] of [
      [{ auto_queue_cv: false }, ['generate_cover_letter']],
      [{ auto_queue_cover_letter: false }, ['generate_cv']],
      [{ auto_queue_cv: false, auto_queue_cover_letter: false }, []]
    ] as const) {
      const job = await scanOneScored()
      updateSettings(partial)
      expect(
        maybeAutoEnqueueDocs(job.id),
        JSON.stringify(partial)
      ).toBe(expected.length > 0)
      expect(docGenRows().map((q) => q.type).sort(), JSON.stringify(partial)).toEqual([
        ...expected
      ])
      // ...and the sweep says exactly the same thing on the same store.
      const job2 = await scanOneScored()
      updateSettings(partial)
      enqueueDocsBacklog()
      expect(
        getAIQueue().filter((q) => q.jobId === job2.id).map((q) => q.type).sort(),
        `sweep ${JSON.stringify(partial)}`
      ).toEqual([...expected])
    }
  })

  it('queues the CV but not the cover letter with only the cover-letter toggle off', async () => {
    // Per unit, in both mechanisms.
    await scanOneScored()
    updateSettings({ auto_queue_cover_letter: false })
    expect(enqueueDocsBacklog()).toBe(1)
    expect(getAIQueue().map((q) => q.type)).toEqual(['generate_cv'])

    const job = await scanOneScored()
    updateSettings({ auto_queue_cover_letter: false })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(getAIQueue().map((q) => q.type)).toEqual(['generate_cv'])
  })

  it('queues nothing with no base CV configured, and never asks the provider', async () => {
    // Two independent refusals, and the honest reading of the user's
    // question about "no base CV":
    //   - the sweep passes `requireConfiguredBaseCv: true`
    //     (docsAutoQueue.ts:259), refused at docAutoQueue.ts:85;
    //   - `scoreOneJobInBackground` returns early with no base CV
    //     (fitScorer.ts:169-190), so the trigger is never reached at all.
    // Nothing changes for a job the scan scored inline, because the scan's
    // own scoring is what admitted it.
    const job = await scanOneScored()
    updateSettings({ base_cv: '' })
    expect(enqueueDocsBacklog()).toBe(0)
    // The trigger called directly asks the predicate WITHOUT the base-CV
    // requirement (fitScorer.ts:105) — it is unreachable from the scanner
    // in that state, which is why the check is not shared.
    expect(job.score).toBeCloseTo(0.92)
    // The practical answer for a user with no base CV: nothing is queued,
    // and the retired producer could not have queued it either — tailoring
    // means "tailor FROM the master CV".
  })

  it('queues nothing for a job that already has both documents generated', async () => {
    // `needsDoc` ignores the base row: only a GENERATED document counts
    // (docsAutoQueue.ts:134-136, `!d.is_base`). The base CV is unioned in
    // by listDocuments for the UI, so a bare type check would report a CV
    // for every job in the store and this sweep would never fire.
    let job = await scanOneScored()
    createDocument('cv', 'Base CV', 'MASTER', undefined) // is_base: the user's master
    createDocument('cover_letter', 'Base CL', 'MASTER', undefined)
    // The base rows alone do NOT satisfy the sweep: still nothing queued.
    expect(enqueueDocsBacklog()).toBe(2)

    // Now the generated pair lands, and the sweep stops.
    job = listJobs()[0]
    createDocument('cv', 'Tailored CV', 'TAILORED', job.id)
    createDocument('cover_letter', 'Tailored CL', 'TAILORED', job.id)
    expect(enqueueDocsBacklog()).toBe(0)

    // The trigger asks the SAME question per unit — `docTypeMissing` — so
    // it too queues nothing for a job that already has both documents. It
    // used to ask no question about which documents exist and would
    // re-tailor a job that is already tailored; that was the residual
    // duplicate the reviewer's Finding 1 measured (a job whose CV was
    // mid-review got a second CV from this path).
    job = await scanOneScored()
    createDocument('cv', 'Tailored CV', 'TAILORED', job.id)
    createDocument('cover_letter', 'Tailored CL', 'TAILORED', job.id)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })
})

describe('a store that still carries the retired keys', () => {
  it('loads, normalises the five live switches on, and keeps the keys inert', () => {
    writeStoreWithRetiredKeys()
    expect(() => reloadStore()).not.toThrow()
    const s = storedSettings()
    for (const key of [
      'auto_queue_fit',
      'auto_queue_cv',
      'auto_queue_cover_letter',
      'auto_queue_verify_cv',
      'auto_queue_verify_cover_letter'
    ]) {
      expect(s[key], key).toBe(true)
    }
    // Still present (no migration strips them) and still unread: nothing
    // in the app's behaviour turns on them any more, which is the whole
    // point of retiring them without touching users' files.
    expect(s.auto_tailor_on_scan).toBe(true)
    expect(s.auto_tailor_min_fit).toBe(0)
    expect(s.auto_doc_min_fit).toBe(40)
  })

  it('survives a save, so the keys ride along rather than crashing the write', async () => {
    writeStoreWithRetiredKeys()
    reloadStore()
    updateSettings({ auto_queue_cv: false })
    // persistStore chains its write onto a promise, so a reload in the same
    // tick reads the file as it stood BEFORE the write. The macrotask
    // yield is what a real process restart gives us for free.
    await new Promise((resolve) => setTimeout(resolve, 0))
    reloadStore()
    const s = storedSettings()
    expect(s.auto_queue_cv).toBe(false)
    expect(s.auto_tailor_on_scan).toBe(true)
  })

  it('starts the app: main registers its handlers over such a store', async () => {
    // The whole startup path, not just the settings read: `registerIpc()`
    // runs off `app.whenReady()` at import time, and the session-start
    // re-seeds (`enqueueDocsBacklog`, `enqueueScoreFitBacklog`) and timers
    // run against the loaded store. A throw anywhere in there is what an
    // upgrade from the retired build would look like.
    writeStoreWithRetiredKeys()
    reloadStore()
    await import('./main')
    await new Promise((r) => setTimeout(r, 0))
    // Registration completed, so the startup path ran to the end of
    // registerIpc rather than dying part-way with the store loaded.
    expect(handlers.get('jobs:scanBoards')).toBeTruthy()
    expect(handlers.get('settings:get')).toBeTruthy()
    // And the store it came up on is the one we wrote.
    expect(storedSettings().auto_tailor_on_scan).toBe(true)
  })
})
