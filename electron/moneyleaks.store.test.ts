/**
 * THREE SPEND LEAKS, closed and measured against the REAL store and the
 * REAL processor, with only `fetch` stubbed.
 *
 *   FINDING 1 — the fit-landing trigger regenerated a CV the document
 *     backlog sweep had deliberately left alone. `jobDocWorkInFlight`
 *     answers per document TYPE, but the trigger queued `tailor_job_docs`,
 *     the BOTH-documents unit, so the two producers asked two different
 *     questions and gave two different answers. Fix: the trigger queues
 *     the MISSING UNITS, `generate_cv` / `generate_cover_letter`, asking
 *     the sweep's four questions per unit.
 *
 *   FINDING 2 — `tailor_job_docs` wrote each document TWICE from one
 *     tailoring call: `tailorDocument` created the row (`createDocument`),
 *     and `tailorJobDocsForJob` then called `writeDocuments`, which
 *     INSERTED a second row for the same document.
 *
 *   FINDING 3 — the fit-landing trigger had no revive budget and no
 *     cooldown: two generations per fit landing, forever. Now it plans
 *     through the sweep's own `planDocUnit` and writes the sweep's own
 *     bounded revival, so it spends the SAME per-row budget.
 *
 * Why the numbers are measured rather than asserted by construction: the
 * number the user pays for is "how many documents did this job end up
 * with, and how many generations were billed". A mocked store cannot
 * answer that, and a mocked `processQueue` cannot answer whether a
 * failure leaves a row behind.
 *
 * Every count below is read off the store after real processor passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Own userData directory: vitest runs FILES in parallel and the other
// real-store suites drive their own stores, so a shared path would have
// them wiping each other's data mid-run. Hoisted because the electron mock
// factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-moneyleaks-review' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_k: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-money',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

import {
  addApiModel,
  addAIQueueItem,
  createDocument,
  createJob,
  getAIQueue,
  getJob,
  listJobDocuments,
  reloadStore,
  updateAIQueueItem,
  updateJob,
  updateSettings
} from './database'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { enqueueDocsBacklog, runDocsAutoQueueBacklog } from './docsAutoQueue'
import { tailorJobDocsForJob } from './tailorJobDocs'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, CreateJobInput, Document } from './types'

const HOUR = 3600_000
const COOLDOWN = AUTO_REVIVE_COOLDOWN_MS

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of ['apply-assistant-data.json', 'apply-assistant-key']) {
    const p = join(STORE_DIR, f)
    if (existsSync(p)) unlinkSync(p)
  }
  reloadStore()
}

let seq = 0

/** A job the shared eligibility gate ACCEPTS: base CV set, score over the bar. */
function eligibleJob(over: Partial<CreateJobInput> = {}) {
  seq += 1
  const { job } = createJob({
    title: `Staff Engineer ${seq}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/moneyleaks/${seq}`,
    description: 'Senior Python engineer. Kubernetes, Postgres, AWS.',
    ...over
  })
  updateJob(job.id, { score: 0.9 })
  return getJob(job.id)!
}

const rowsOf = (jobId: number): AIQueueItem[] => getAIQueue().filter((q) => q.jobId === jobId)
const typeList = (jobId: number): string[] => rowsOf(jobId).map((q) => q.type).sort()
const docsOf = (jobId: number, type: Document['type']): Document[] =>
  listJobDocuments(jobId).filter((d) => d.type === type)

/** A CV tailoring must pass `looksLikeHarvardCv`, or it costs a wasted attempt. */
const CV_BODY = [
  'JAMIE OKONKWO',
  'jamie@example.com',
  '',
  'Experience',
  'Globex\tRemote',
  'Staff Engineer\tMar 2020 - Present',
  '- Built the ingestion tier for 40M events a day',
  '',
  'Education',
  'Rutgers\tNew Brunswick, NJ',
  'B.S. Computer Science\tJun 2019'
].join('\n')

interface Counters {
  cv: number
  cl: number
  keywords: number
  review: number
}

function classify(system: string): keyof Counters {
  if (system.includes('strict career-document reviewer')) return 'review'
  if (system.includes('You extract keywords from a job description')) return 'keywords'
  if (system.includes('Tailor the candidate')) return 'cv'
  return 'cl'
}

let clearModelHealth: () => void = () => undefined

/**
 * The provider, classified by system prompt, so "the provider was called
 * once per document" is a claim about the CV rather than about everything.
 *
 * `kill` names which classes get a 429 instead: a rate-limited tailoring
 * is a real billed request that fails, which is how "a job that can never
 * be generated" is reached without hand-writing the queue state. Model
 * health is cleared before EVERY request so one attempt is one wire call
 * and the attempt counts below are the ceiling, never suppressed by an
 * earlier request's cooldown (a real provider suppresses more, never less).
 */
function provider(opts: { kill?: readonly (keyof Counters)[]; reviewScore?: number } = {}): Counters {
  const kill = opts.kill ?? []
  const reviewScore = opts.reviewScore ?? 96
  const c: Counters = { cv: 0, cl: 0, keywords: 0, review: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      clearModelHealth()
      const body = JSON.parse(init.body) as { messages: { content: string }[] }
      const kind = classify(body.messages[0].content)
      const user = body.messages[1].content
      c[kind] += 1
      if (kill.includes(kind)) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
      }
      const say = (content: string) =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
      if (kind === 'review') {
        return say(JSON.stringify({ score: reviewScore, passed: reviewScore >= 70, feedback: 'ok' }))
      }
      if (kind === 'keywords') {
        return say(
          JSON.stringify({ keywords: [{ phrase: 'Python', weight: 1, category: 'hard', source: 'body' }] })
        )
      }
      if (kind === 'cv') return say(CV_BODY)
      return say(`Dear Hiring Manager,\n\nI am applying for ${user.slice(0, 20)}.\n\nRegards,\nJamie`)
    })
  )
  return c
}

/** Run the REAL processor until nothing is runnable, jumping the clock to each row's own due time. */
async function pump(maxSteps = 400, maxSimDays = 60): Promise<void> {
  const { processQueue } = await import('./aiQueue')
  const { resetModelHealth } = await import('./ai')
  const t0 = Date.now()
  for (let i = 0; i < maxSteps; i++) {
    resetModelHealth()
    const runnable = getAIQueue().filter(
      (q) =>
        q.status === 'pending' ||
        (q.status === 'failed' && (q.autoRevives ?? 0) < AUTO_REVIVE_MAX)
    )
    if (runnable.length === 0) return
    const next = Math.min(...runnable.map((q) => q.nextRetryAt))
    if (next > Date.now()) {
      if (next > t0 + maxSimDays * 86_400_000) return
      vi.setSystemTime(next)
    }
    await processQueue()
  }
}

/**
 * 30 simulated days for `jobs`, with the provider failing every tailoring.
 *
 * Every other automatic producer runs too — the hourly periodic sweep, the
 * startup path every 4 hours, and the fit-landing trigger — because a
 * bound that only holds when the trigger is measured alone is not a bound.
 *
 * Attempts are read off the queue's own `attempts` counter as it moves, so
 * the figure does not depend on how many requests a provider cooldown
 * happened to swallow.
 */
async function thirtyDays(
  jobs: { id: number }[],
  withTrigger: boolean
): Promise<{ perDay: number[]; attempts: number; cv: number; cl: number }> {
  vi.useRealTimers()
  const calls = provider({ kill: ['cv', 'cl'] })
  const start = Date.now()
  const attemptsOf = (): Map<number, number> =>
    new Map(getAIQueue().map((q) => [q.id, q.attempts]))
  let attempts = 0
  let attemptsMark = 0
  const perDay: number[] = []

  for (let hour = 0; hour < 30 * 24; hour++) {
    vi.setSystemTime(start + hour * HOUR)
    enqueueDocsBacklog()
    runDocsAutoQueueBacklog()
    if (withTrigger) for (const job of jobs) maybeAutoEnqueueDocs(job.id)

    // One processor pass at a time, so the attempts delta is exact: the
    // counter only goes UP by one per attempt, or resets to 0 the moment
    // the tenth attempt parks the row on the revive cooldown.
    for (let step = 0; step < 200; step++) {
      const { processQueue } = await import('./aiQueue')
      const { resetModelHealth } = await import('./ai')
      resetModelHealth()
      const runnable = getAIQueue().filter(
        (q) => q.status === 'pending' || (q.status === 'failed' && (q.autoRevives ?? 0) < AUTO_REVIVE_MAX)
      )
      if (runnable.length === 0) break
      const before = attemptsOf()
      const next = Math.min(...runnable.map((q) => q.nextRetryAt))
      if (next > Date.now()) {
        if (next > start + (hour + 1) * HOUR) break
        vi.setSystemTime(next)
      }
      await processQueue()
      for (const row of getAIQueue()) {
        const prev = before.get(row.id) ?? 0
        if (row.attempts > prev) attempts += row.attempts - prev
        // A counter that was CLEARED means the attempt that spent it is gone
        // from the row, so it still has to be counted. A counter that did not
        // move means nothing was billed — the row was not picked, or it was
        // picked and parked on a spent provider budget, which by design
        // charges no attempt at all. The old `else if (prev > 0)` conflated
        // the two and charged a phantom attempt for every park.
        else if (row.attempts === 0 && prev > 0) attempts += 1
      }
    }

    if ((hour + 1) % 24 === 0) {
      perDay.push(attempts - attemptsMark)
      attemptsMark = attempts
    }
  }
  return { perDay, attempts, cv: calls.cv, cl: calls.cl }
}

beforeEach(async () => {
  wipe()
  addApiModel({
    name: 'm',
    base_url: 'https://llm.test/v1',
    api_key: 'k',
    model: 'm',
    enabled: true
  })
  updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
  vi.unstubAllGlobals()
  const { resetModelHealth } = await import('./ai')
  clearModelHealth = resetModelHealth
  resetModelHealth()
  // Only Date is faked, so `vi.setSystemTime` can jump past a 4h cooldown
  // inside `pump` while every real `await` still resolves.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// FINDING 1 — the trigger queues only what is MISSING
// ---------------------------------------------------------------------------

describe('FINDING 1: the trigger regenerates nothing that already exists', () => {
  /**
   * The reported state: the job HAS its CV, that CV's review is live (a
   * `pending` `verify` row carrying its id), and it has NO cover letter.
   *
   * `jobDocWorkInFlight` deliberately excludes `verify` rows and rows
   * carrying a `documentId` — a review and a rebuild produce no MISSING
   * document, which is the right rule for the sweep, which decides per unit
   * against "is this document missing". It was the wrong question for a
   * trigger that meant "both documents".
   *
   * The sweep answered "queue the cover letter". The trigger answered
   * "queue a `tailor_job_docs` row", which REGENERATED the CV. Reached
   * with no contrivance: the review is a real provider call taking seconds
   * to a minute, and a fit landing inside that window is an ordinary event
   * (Recompute Fit, a `score_fit` row landing, a cold launch).
   */
  function cvMidReview(jobId: number): number {
    const row = createDocument('cv', 'CV', CV_BODY, jobId)
    addAIQueueItem({ type: 'verify', jobId, documentId: row.id })
    return row.id
  }

  it('a CV mid-review and no cover letter: the trigger queues ONE row, for the cover letter', () => {
    const job = eligibleJob()
    const cvId = cvMidReview(job.id)

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    // ONE row, and it is the cover letter. Not `tailor_job_docs`, which
    // would have regenerated the CV the sweep leaves alone.
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'verify'])
    expect(rowsOf(job.id).filter((q) => q.type === 'generate_cv')).toHaveLength(0)

    // And the sweep agrees, in the same state.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(docsOf(job.id, 'cv').map((d) => d.id)).toEqual([cvId])
  })

  it('the mirror: a cover letter mid-review and no CV: the trigger queues ONE row, for the CV', () => {
    const job = eligibleJob()
    const row = createDocument('cover_letter', 'CL', 'Dear Hiring Manager, ...', job.id)
    addAIQueueItem({ type: 'verify', jobId: job.id, documentId: row.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cv', 'verify'])
    expect(rowsOf(job.id).filter((q) => q.type === 'generate_cover_letter')).toHaveLength(0)

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
  })

  it('both documents missing: two units, and NEVER tailor_job_docs', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    // Structural, because "no producer queues this type" is not something a
    // behaviour test can say.
    expect(codeOnly(readFileSync('electron/fitScorer.ts', 'utf8'))).not.toContain('tailor_job_docs')
  })

  it('nothing missing: nothing is queued', async () => {
    provider()
    const job = eligibleJob()
    runDocsAutoQueueBacklog()
    await pump()
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getAIQueue()).toHaveLength(0)

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(0)
  })

  it('sweep then trigger, end to end: exactly one CV and one cover letter', async () => {
    const calls = provider()
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id)).toHaveLength(2)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('trigger then sweep, end to end: exactly one CV and one cover letter', async () => {
    const calls = provider()
    const job = eligibleJob()

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('all four interleaved orderings, repeatedly, still give exactly one of each', async () => {
    // The four cases a reviewer enumerated — startup first, periodic first,
    // trigger first, trigger between two sweeps — each repeated four times
    // with a processor pass in the middle, because the interesting window is
    // a producer arriving while another's row is `processing`: the CV lands,
    // its review goes live, and a producer that means "both documents"
    // arrives inside that window. That is the state that used to produce
    // THREE CVs and TWO cover letters for one job.
    const orders: [string, (jobId: number) => void][] = [
      ['startup first', () => enqueueDocsBacklog()],
      ['periodic first', () => runDocsAutoQueueBacklog()],
      ['trigger first', (jobId) => maybeAutoEnqueueDocs(jobId)],
      ['trigger between two sweeps', (jobId) => maybeAutoEnqueueDocs(jobId)]
    ]
    for (const [name, first] of orders) {
      wipe()
      addApiModel({ name: 'm', base_url: 'https://llm.test/v1', api_key: 'k', model: 'm', enabled: true })
      updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
      const calls = provider()
      const job = eligibleJob()
      for (let round = 0; round < 4; round++) {
        first(job.id)
        runDocsAutoQueueBacklog()
        enqueueDocsBacklog()
        maybeAutoEnqueueDocs(job.id)
        await pump(2, 0)
      }
      await pump()

      expect(docsOf(job.id, 'cv'), name).toHaveLength(1)
      expect(docsOf(job.id, 'cover_letter'), name).toHaveLength(1)
      expect(calls.cv, name).toBe(1)
      expect(calls.cl, name).toBe(1)
      expect(getAIQueue(), name).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// FINDING 2 — one tailoring call, one write per document
// ---------------------------------------------------------------------------

describe('FINDING 2: tailor_job_docs writes each document ONCE', () => {
  it('through the real processor: one cv row, one cover_letter row, one call each', async () => {
    // The double write: `tailorDocument` ends a first generation by calling
    // `createDocument` (which PUSHES the row) and returns its id, and
    // `tailorJobDocsForJob` then called `writeDocuments`, which INSERTED a
    // second row for the same document. One tailoring call, one review, one
    // billed generation — and two `cv` rows and two `cover_letter` rows,
    // one of each orphaned: never in the review chain, never deleted, and
    // `recomputeJobStatusFromDocs` and the Documents view showing two of
    // everything for one generation.
    const calls = provider()
    const job = eligibleJob()
    // Queued the way Quick Apply queues it, because that is the only
    // remaining producer of the both-documents row.
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    await pump()

    // ONE provider call per document...
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    // ...and ONE row per document.
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    // Both rows were reviewed, so neither is an orphan left holding an
    // unreviewed duplicate, and the queue drained.
    expect(calls.review).toBe(2)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('called directly: same result, and the stored content is the SANITIZED one', async () => {
    // The content that reaches the store still goes through the paragraph
    // ceilings, so dropping `writeDocuments` did not drop the sanitization
    // with it — it now writes onto the row `tailorDocument` created.
    const calls = provider()
    const job = eligibleJob()
    const result = await tailorJobDocsForJob(job.id)

    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    // The returned ids are the rows that exist — one write, one truth.
    expect(docsOf(job.id, 'cv').map((d) => d.id)).toEqual([result.cvId])
    expect(docsOf(job.id, 'cover_letter').map((d) => d.id)).toEqual([result.clId])
    expect(docsOf(job.id, 'cv')[0].content).toContain('Globex')
  })

  it('a document that FAILED leaves no row at all, not an empty one', async () => {
    // `tailorDocument` throws before `createDocument` on a validation
    // failure, so "write whatever succeeded" still holds — and the job
    // ends with exactly the one document it actually has.
    const calls = provider({ kill: ['cv'] })
    const job = eligibleJob()
    await tailorJobDocsForJob(job.id)

    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    expect(docsOf(job.id, 'cv')).toHaveLength(0)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FINDING 3 — the trigger has the sweep's bound
// ---------------------------------------------------------------------------

describe('FINDING 3: the fit-landing trigger is bounded', () => {
  it('30 days of repeated fit landings spend a BOUNDED number: 80, all on day one', async () => {
    // BEFORE: 428 attempts (80 from the sweep + 12 a day from the trigger),
    // per-day [80, 12 x 29], unbounded in the number of landings and silent
    // — no row survived, no error touched the job, and the trigger returned
    // true every time so every caller believed it had scheduled something.
    //
    // AFTER, the arithmetic is the sweep's own:
    //
    //   per document unit, per life:
    //       attempts ladder   aiQueue.ts   `isRateLimit && attempts < 10`
    //                                      -> 10 attempts, then park
    //       lifetime budget   aiQueue.ts   `autoRevives < AUTO_REVIVE_MAX`
    //                                      -> AUTO_REVIVE_MAX parks it
    //       => (1 + AUTO_REVIVE_MAX) cycles x 10 attempts = 40 per unit
    //   a job has 2 units  => 80 attempts per job, EVER
    //
    // and the trigger cannot move that number, because:
    //   - it only ADDS a row when the unit has no row at all in any status,
    //     so the first landing is the only one that can create one;
    //   - a row it revives spends `autoRevives` and parks on the 4h
    //     cooldown, the same per-row budget the sweep and the processor
    //     charge, so whichever producer revives, the cycles are finite;
    //   - a landing that finds a row `pending` / `processing` spends
    //     nothing at all (`jobDocWorkInFlight`).
    //
    // The TOTAL is unchanged at 80 — that is the bound this case exists to
    // hold, and the ladder still holds it. What the per-provider call cap
    // changed is WHEN the money goes out: 80 429s are 80 billed requests
    // against one credential, so the cap refuses the 51st, the refusals
    // charge no attempt (that is the whole point of parking a cap refusal),
    // and the rest of the ladder runs on day two once the window has slid.
    // Before the cap, all 80 came out of day one.
    const job = eligibleJob()
    const r = await thirtyDays([job], true)

    expect(r.attempts).toBe(10 * (AUTO_REVIVE_MAX + 1) * 2)
    expect(r.attempts).toBe(80)
    // It was [80, 0 x 29] before the cap and [80, 12 x 29] before the
    // trigger's bound. Bounded either way; bounded EARLIER now, which is
    // what the cap is for.
    expect(r.perDay).toEqual([52, 28, ...new Array(28).fill(0)])
    // Nothing succeeded, so nothing exists and the whole 80 is waste.
    expect(docsOf(job.id, 'cv')).toHaveLength(0)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(0)
    // Two rows for the job, both parked with a spent budget: the trigger
    // added no third row on any of the 180 landings.
    expect(rowsOf(job.id)).toHaveLength(2)
    for (const row of rowsOf(job.id)) {
      expect(row.autoRevives, row.type).toBe(AUTO_REVIVE_MAX)
      expect(row.status, row.type).toBe('failed')
    }
    // The wire-level cost in this configuration is at or below the ceiling.
    expect(r.cv + r.cl).toBeLessThanOrEqual(r.attempts)
  })

  it('the bound is PER JOB, not global: two jobs each get the whole 80', async () => {
    // A shared budget would starve every job after the first, which is the
    // failure mode the cross-producer predicate's per-job scoping exists to
    // avoid.
    const a = eligibleJob()
    const b = eligibleJob()
    const r = await thirtyDays([a, b], true)

    expect(r.attempts).toBe(2 * 10 * (AUTO_REVIVE_MAX + 1) * 2)
    expect(r.attempts).toBe(160)
    // 80 each, measured per job rather than on the total alone.
    for (const job of [a, b]) {
      expect(rowsOf(job.id), `job ${job.id}`).toHaveLength(2)
      for (const row of rowsOf(job.id)) {
        expect(row.autoRevives, `job ${job.id} ${row.type}`).toBe(AUTO_REVIVE_MAX)
      }
    }
  })

  it('a job that SUCCEEDS spends nothing on later landings', async () => {
    // The bound's other half, and the one that decides whether this is a
    // leak: the 80 above is the worst case for a job that can never be
    // generated. The ordinary case is zero.
    vi.useRealTimers()
    const calls = provider()
    const job = eligibleJob()
    const start = Date.now()

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    await pump()
    const spent = { ...calls }
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)

    // 30 days on a 4-hourly landing loop (720 landings), with both sweep
    // paths running alongside them.
    for (let hour = 0; hour < 30 * 24; hour++) {
      vi.setSystemTime(start + hour * HOUR)
      maybeAutoEnqueueDocs(job.id)
      enqueueDocsBacklog()
      runDocsAutoQueueBacklog()
      await pump(60, 1)
    }

    expect(calls).toEqual(spent)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('the 4h cooldown is respected: no second spend inside the window', async () => {
    // The write the sweep's fix made and the trigger used to skip.
    // `enqueue`'s `revivePatch` sets `nextRetryAt: Date.now()` and leaves
    // `autoRevives` alone, so a landing every few minutes bought one
    // generation each time.
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 12, autoRevives: 0, nextRetryAt: 0 })

    const first = Date.now()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    const revived = rowsOf(job.id).find((q) => q.id === row.id)!
    expect(revived.status).toBe('pending')
    expect(revived.autoRevives).toBe(1)
    expect(revived.attempts).toBe(0)
    expect(revived.nextRetryAt).toBeGreaterThanOrEqual(first + COOLDOWN)

    // A landing every 15 minutes, all inside the window (15 x 15min =
    // 225min < 240min): nothing is spent, no budget is charged, and no
    // second row appears.
    for (let i = 1; i <= 15; i++) {
      vi.setSystemTime(first + i * 15 * 60_000)
      maybeAutoEnqueueDocs(job.id)
      const still = rowsOf(job.id).find((q) => q.id === row.id)!
      expect(still.autoRevives, `landing ${i}`).toBe(1)
      expect(still.nextRetryAt, `landing ${i}`).toBeGreaterThan(Date.now())
    }
    expect(rowsOf(job.id).filter((q) => q.type === 'generate_cv')).toHaveLength(1)
  })

  it('a DEAD row parked on its cooldown is not pulled forward either', () => {
    // The other shape the cooldown has to hold: the row is already `failed`
    // and its own `nextRetryAt` is in the future — which is what a
    // non-rate-limit failure leaves behind, because the terminal-failure
    // write does not move `nextRetryAt`. A landing must not drag it to now,
    // which is precisely what `enqueue`'s `revivePatch` does
    // (`nextRetryAt: Date.now()`, `autoRevives` untouched).
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    const start = Date.now()
    updateAIQueueItem(row.id, {
      status: 'failed',
      attempts: 4,
      autoRevives: 1,
      nextRetryAt: start + 3 * HOUR
    })

    // Landings every 30 minutes for the next two hours: all inside the
    // window, so the CV unit is refused every time.
    for (let i = 1; i <= 4; i++) {
      vi.setSystemTime(start + i * 30 * 60_000)
      maybeAutoEnqueueDocs(job.id)
      const still = rowsOf(job.id).find((q) => q.id === row.id)!
      expect(still.status, `landing ${i}`).toBe('failed')
      expect(still.autoRevives, `landing ${i}`).toBe(1)
      expect(still.nextRetryAt, `landing ${i}`).toBe(start + 3 * HOUR)
    }

    // Past the window it revives, and the revival is the bounded one.
    vi.setSystemTime(start + 3 * HOUR + 1)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    const after = rowsOf(job.id).find((q) => q.id === row.id)!
    expect(after.status).toBe('pending')
    expect(after.autoRevives).toBe(2)
    expect(after.nextRetryAt).toBeGreaterThan(Date.now())
  })
})

/** `src` with line comments removed: naming the type in prose is fine, queueing it in code is not. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n')
}
