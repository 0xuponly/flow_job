/**
 * REVIEWER-ADDED (rv2-dupe). Independent adversarial verification of the
 * duplicate-queue fix `6ce4d85` and of the merge-conflict resolution
 * `dc15d81`.
 *
 * Written from the BRIEF and the prior verdict, NOT from the fixing agent's
 * tests. `electron/docsAutoQueue.crossProducer.store.test.ts` exists and is
 * good work, but "the fixing agent tested it" is precisely the claim a
 * reviewer is not supposed to take, so every harness here is my own and the
 * end-to-end cases drive the REAL store and the REAL `processQueue` with
 * only `fetch` stubbed. The number the user pays for is "how many documents
 * did this job end up with", and a mocked store cannot answer that.
 *
 * Sections, mapped to the checklist:
 *   1. the duplicate is gone (sweep + trigger, real processor, real calls)
 *   2. both directions CALL one predicate, not two implementations
 *   3. the deferral completes the job (no "3 CVs traded for 0")
 *   4. the `fitScorer.ts` conflict resolution kept BOTH halves
 *   5. none of the five previously-fixed defects regressed, and the
 *      revival-rate bound still holds
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Own userData directory. vitest runs test FILES in parallel and several
// other suites drive the same real store, so a shared path would have them
// wiping each other's data mid-run. Hoisted: the electron mock factory runs
// before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-rv2dupe-review' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_k: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-rv2',
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
  createJob,
  createDocument,
  getAIQueue,
  getJob,
  listJobDocuments,
  reloadStore,
  updateAIQueueItem,
  updateJob,
  updateSettings
} from './database'
import { enqueueDocsBacklog, runDocsAutoQueueBacklog, getDocsAutoQueueState } from './docsAutoQueue'
import { getFitAutoScoreState } from './fitAutoScore'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { jobDocWorkInFlight } from './docAutoQueue'
import { AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, CreateJobInput, Document } from './types'

// ---------------------------------------------------------------------------
// Harness (mine, not the fixing agent's)
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
    url: `https://example.com/rv2dupe/${seq}`,
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

// Section headers are matched case-sensitively by `looksLikeHarvardCv`, and
// a CV that fails validation costs a wasted attempt, so the body below has
// to be a template-valid one.
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

/**
 * A provider that always succeeds, classified by system prompt.
 *
 * "Always succeeds" is the worst case for de-duplication: a document that
 * FAILS review gets regenerated and the queue keeps going, so a duplicate
 * shows up in the row count too. A document that PASSES review is what makes
 * the duplicate permanent and user-visible, which is the state the prior
 * review measured (3 rows -> 3 CVs + 3 cover letters, all passing).
 *
 * `kill` names which classes get a 429 instead, which is how the "one unit
 * landed, its sibling never did" state is reached without hand-writing it.
 */
/**
 * Cleared at the start of every provider request by the stub below, so a
 * request is never suppressed by a cooldown recorded by an earlier one.
 * Assigned in beforeEach.
 */
let clearModelHealth: () => void = () => undefined

function provider(opts: { kill?: readonly (keyof Counters)[]; reviewScore?: number } = {}): Counters {
  const kill = opts.kill ?? []
  const reviewScore = opts.reviewScore ?? 96
  const c: Counters = { cv: 0, cl: 0, keywords: 0, review: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      // Without this, a 429 puts the model on a 15s cooldown and the NEXT
      // `callAI` throws RateLimitError without reaching the wire, so the
      // second row in a pass — and every later attempt — would cost no
      // billed request at all. Clearing it here means one fetch per
      // ATTEMPT, which is the ceiling the revival budget is about; a real
      // provider's cooldowns only reduce it.
      clearModelHealth()
      const body = JSON.parse(init.body) as { messages: { content: string }[] }
      const system = body.messages[0].content
      const user = body.messages[1].content
      const kind = classify(system)
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

/**
 * Run the REAL processor until nothing is due, advancing the clock to each
 * row's own `nextRetryAt` so cooldowns do not have to be waited out in real
 * time. `maxSimDays` is a hard stop so a state machine that never converges
 * fails the test instead of hanging it.
 */
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
      if (Date.now() + (next - Date.now()) > t0 + maxSimDays * 86_400_000) return
      vi.setSystemTime(next)
    }
    await processQueue()
  }
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
  // Only Date is faked, so `vi.setSystemTime` can jump the clock forward
  // past a 4h cooldown inside `pump` while every real `await` still
  // resolves. Restored in afterEach.
  vi.useFakeTimers({ toFake: ['Date'] })
  // Model health suppresses calls after failures and would silently change
  // every count below, so every test starts healthy, `pump` resets it
  // before each processor pass, and the fetch stub resets it before each
  // request (see `provider`).
  const { resetModelHealth } = await import('./ai')
  clearModelHealth = resetModelHealth
  resetModelHealth()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. THE DUPLICATE IS GONE — real store, real processor, real provider calls
// ---------------------------------------------------------------------------

describe('1. one job, one CV, one cover letter', () => {
  it('sweep, then trigger, then processor: exactly one cv and one cover_letter doc', async () => {
    const calls = provider()
    const job = eligibleJob()

    // The periodic sweep queues the two units.
    expect(runDocsAutoQueueBacklog()).toBe(2)
    // The user then recomputes Fit. This is the direction the defect was
    // in: `enqueue`'s guard keys on (type, jobId, documentId, sectionName),
    // so a `tailor_job_docs` row never matched a `generate_cv` row.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)

    expect(rowsOf(job.id)).toHaveLength(2)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])

    await pump()

    // THE MONEY. Three cv rows + three cover_letter rows is what the prior
    // review measured; one of each is what the fix has to produce.
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    // And no duplicate tailoring was billed: one generation of each
    // document, not two.
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    // One review per generated document, chained by the processor.
    expect(calls.review).toBe(2)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('the same through the startup/post-scan path, which runs BEFORE score_fit', async () => {
    const calls = provider()
    const job = eligibleJob()

    // `runDeferredStoreWork` calls enqueueScoreFitBacklog() and then
    // enqueueDocsBacklog(), and the score_fit rows land later — so this
    // ordering is the cold-launch one, with no user action at all.
    expect(enqueueDocsBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
  })

  it('a second sweep + trigger pass after processing adds nothing and spends nothing', async () => {
    const calls = provider()
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await pump()
    const spent = { ...calls }

    // Both documents exist and passed review, so `needsDoc` is false for
    // both and the job is shippable. Had the generated documents failed to
    // satisfy those two predicates this pass would queue them again — once
    // an hour, for the life of the install.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await pump()

    expect(rowsOf(job.id)).toHaveLength(0)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls).toEqual(spent)
  })

  it('both sweep paths interleaved with the trigger, repeatedly, still produce one of each', async () => {
    const calls = provider()
    const job = eligibleJob()

    for (let pass = 0; pass < 4; pass++) {
      enqueueDocsBacklog()
      runDocsAutoQueueBacklog()
      maybeAutoEnqueueDocs(job.id)
    }
    expect(rowsOf(job.id)).toHaveLength(2)

    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
  })

  it("the base CV row is not mistaken for the job's generated CV", async () => {
    // needsDoc's trap: listDocuments unions in the user's master CV, so a
    // bare `some(d => d.type === 'cv')` would make every job look covered.
    const calls = provider()
    createDocument('cv', 'Base', 'MASTER ROW', undefined, true)
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
  })

  it('the duplicate is per job: job A being swept does not starve job B', () => {
    const a = eligibleJob()
    const b = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(4)
    expect(maybeAutoEnqueueDocs(a.id)).toBe(false)
    expect(maybeAutoEnqueueDocs(b.id)).toBe(false)
    expect(rowsOf(a.id)).toHaveLength(2)
    expect(rowsOf(b.id)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 2. ONE PREDICATE, CALLED BY BOTH DIRECTIONS
// ---------------------------------------------------------------------------

/** `src` with block and line comments removed. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** The source of one exported function, from its signature to its closing brace. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `no ${signature}`).toBeGreaterThan(-1)
  const rest = src.slice(start + signature.length)
  const end = rest.indexOf('\n}\n')
  return rest.slice(0, end === -1 ? rest.length : end)
}

// A CALL, not a name. `toContain('jobDocWorkInFlight')` is satisfied by the
// import line on its own — the prior reviewer proved that by gutting
// maybeAutoEnqueueDocs to `return false` and watching 15 tests stay green —
// so every structural assertion below requires the `if (` and the arguments.
const TRIGGER_CALL =
  /if \(jobDocWorkInFlight\(db\.getAIQueue\(\), jobId, \['cv', 'cover_letter'\]\)\) return false/
const SWEEP_CALL = /if \(jobDocWorkInFlight\(queue, job\.id, \[unit\.docType\]\)\) continue/

describe('2. both directions CALL jobDocWorkInFlight', () => {
  it('the fit-landing trigger calls it, asking about BOTH documents', () => {
    const b = body(code(readFileSync('electron/fitScorer.ts', 'utf8')), 'export function maybeAutoEnqueueDocs(')
    expect(b).toMatch(TRIGGER_CALL)
    // Exactly one call: two calls in one function is how a second
    // implementation starts.
    expect(b.match(/jobDocWorkInFlight\(/g) ?? []).toHaveLength(1)
  })

  it('BOTH sweep paths call it, once each, per unit', () => {
    const src = code(readFileSync('electron/docsAutoQueue.ts', 'utf8'))
    expect(src.match(new RegExp(SWEEP_CALL, 'g'))?.length).toBe(2)
    // Pinned to the two exported entry points, so deleting ONE of the two
    // gates fails even with the other's text still in the file.
    expect(body(src, 'export function runDocsAutoQueueBacklog(')).toMatch(SWEEP_CALL)
    expect(body(src, 'export function enqueueDocsBacklog(')).toMatch(SWEEP_CALL)
  })

  it('the old single-direction check is GONE, not left as a second opinion', () => {
    for (const f of [
      'electron/docsAutoQueue.ts',
      'electron/fitScorer.ts',
      'electron/docAutoQueue.ts',
      'electron/aiQueue.ts',
      'electron/database.ts'
    ]) {
      expect(code(readFileSync(f, 'utf8')), f).not.toContain('jobCoveredByLiveTailor')
    }
    // A second implementation has to name the row types it is scanning
    // for. Only the predicate module may.
    const sweep = code(readFileSync('electron/docsAutoQueue.ts', 'utf8'))
    const trigger = code(readFileSync('electron/fitScorer.ts', 'utf8'))
    expect(sweep).not.toMatch(/q\.type === 'tailor_job_docs'/)
    expect(sweep).not.toMatch(/q\.type === 'generate_cv'/)
    expect(trigger).not.toMatch(/type === 'generate_cv'/)
    expect(trigger).not.toMatch(/type === 'tailor_job_docs'/)
    // And the type -> documents mapping is written exactly once.
    const pred = code(readFileSync('electron/docAutoQueue.ts', 'utf8'))
    expect(pred.match(/DOC_PRODUCING_ROWS/g)?.length).toBe(2)
    expect(pred.match(/export function jobDocWorkInFlight\(/g)).toHaveLength(1)
  })

  // --- behavioural halves: each of these fails if EITHER caller is gutted ---

  it("BEHAVIOUR: with the sweep's rows live, the trigger queues nothing", () => {
    const job = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    // A gutted trigger returns true here and a third row appears.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id)).toHaveLength(2)
  })

  it("BEHAVIOUR: with the trigger's row live, the sweep queues nothing", () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    // A gutted sweep returns 2 here and two more rows appear.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(1)
  })

  it('BEHAVIOUR: a PROCESSING row counts, not just a pending one', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    updateAIQueueItem(rowsOf(job.id)[0].id, { status: 'processing' })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })

  it('BEHAVIOUR: a FAILED row is not in flight in either direction', () => {
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, nextRetryAt: 0 })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cv', 'tailor_job_docs'])
  })

  it('BEHAVIOUR: a regeneration row (carries a documentId) covers nothing', () => {
    // It rebuilds a document that EXISTS. Counting it as coverage would
    // suppress a first generation the job still needs — and the rebuild has
    // nothing to replace, so the job would end with no CV at all.
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 4242 })
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })

  it('the predicate has one truth table, so the two producers cannot disagree', () => {
    // Unit-level, independent of both callers: this is the shared answer.
    const base = {
      id: 1,
      jobId: 1,
      createdAt: 0,
      attempts: 0,
      nextRetryAt: 0,
      lastError: null
    } as unknown as AIQueueItem
    const cv = { ...base, type: 'generate_cv', status: 'pending' } as AIQueueItem
    const cl = { ...base, type: 'generate_cover_letter', status: 'pending' } as AIQueueItem
    const both = { ...base, type: 'tailor_job_docs', status: 'pending' } as AIQueueItem

    // A single-unit row covers its own document and nothing else.
    expect(jobDocWorkInFlight([cv], 1, ['cv'])).toBe(true)
    expect(jobDocWorkInFlight([cv], 1, ['cover_letter'])).toBe(false)
    expect(jobDocWorkInFlight([cl], 1, ['cover_letter'])).toBe(true)
    expect(jobDocWorkInFlight([cl], 1, ['cv'])).toBe(false)
    // A both-documents row covers either question.
    expect(jobDocWorkInFlight([both], 1, ['cv'])).toBe(true)
    expect(jobDocWorkInFlight([both], 1, ['cover_letter'])).toBe(true)
    // Asking about both is the trigger's question and any of the three
    // answers it.
    for (const row of [cv, cl, both]) {
      expect(jobDocWorkInFlight([row], 1, ['cv', 'cover_letter'])).toBe(true)
    }
    // Another job's row is another job's work.
    expect(jobDocWorkInFlight([{ ...cv, jobId: 2 }], 1, ['cv', 'cover_letter'])).toBe(false)
    // failed is not in flight; processing is.
    expect(jobDocWorkInFlight([{ ...cv, status: 'failed' }], 1, ['cv'])).toBe(false)
    expect(jobDocWorkInFlight([{ ...both, status: 'processing' }], 1, ['cover_letter'])).toBe(true)
    // A rebuild of an existing document covers no missing one.
    expect(jobDocWorkInFlight([{ ...cv, documentId: 9 }], 1, ['cv'])).toBe(false)
    // Rows that produce no document are irrelevant.
    for (const t of ['score_fit', 'verify', 'regenerate_section'] as const) {
      expect(jobDocWorkInFlight([{ ...base, type: t, status: 'pending' }], 1, ['cv', 'cover_letter'])).toBe(false)
    }
    // No rows, no coverage.
    expect(jobDocWorkInFlight([], 1, ['cv', 'cover_letter'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. THE DEFERRAL IS SOUND — it completes the job, it does not strand it
// ---------------------------------------------------------------------------

describe('3. the deferred work actually completes the job', () => {
  it("a live generate_cv row stops the trigger, and the sweep still queues the cover letter", () => {
    // The exact edge the predicate's per-unit granularity exists for: a
    // blanket "is this job covered?" here trades a duplicate CV for a job
    // with NO cover letter and nothing queued to produce one.
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('...and that pair completes BOTH documents end to end', async () => {
    const calls = provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
  })

  it('the mirror image, for the cover letter', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  // --- the state the BRIEF asked me to hunt for, in every reachable shape ---

  it('COVER-LETTER OFF + a live generate_cv row: the job is owed nothing', () => {
    // `tailor_job_docs` needs BOTH switches, so the trigger was never
    // allowed to produce this job's documents. Declining is not a deferral
    // here, so it cannot leave a debt: the cover letter is switched off and
    // the CV has its own live row.
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: false })
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(typeList(job.id)).toEqual(['generate_cv'])
  })

  it('COVER-LETTER OFF + a live generate_cv row: no debt survives the CV landing', async () => {
    const calls = provider()
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: false })
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)

    await pump()
    runDocsAutoQueueBacklog()
    enqueueDocsBacklog()
    maybeAutoEnqueueDocs(job.id)
    await pump()

    // 1 CV, no cover letter — which is what the switches asked for — and an
    // empty queue, so nothing is left pending that will never run.
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(0)
    expect(getAIQueue()).toHaveLength(0)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(0)
  })

  it('CV OFF + a live generate_cover_letter row: also nothing owed', () => {
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: true })
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(typeList(job.id)).toEqual(['generate_cover_letter'])
  })

  it('CV OFF, cover letters ON: a cover-letter-only sweep is legitimate, the trigger still refuses', () => {
    // This is the case that decides whether the trigger's switch check can
    // live inside the shared predicate. It cannot: here the sweep has real
    // work to do and the trigger has none.
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: true })
    const job = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typeList(job.id)).toEqual(['generate_cover_letter'])
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })

  it('the dead-sibling state with a PASSING CV: the trigger refuses, nothing is duplicated', async () => {
    // The shape the BRIEF asked me to hunt for, and the one the fix does
    // close: the sweep's CV landed and passed review, the cover letter's
    // revive budget is spent, so the job has a CV and no cover letter.
    // `autoDocQueueEligible` reads that as shippable (every document it has
    // clears the bar) and refuses — so no second CV is bought. Worth
    // pinning: "the trigger is the both-documents producer" would be the
    // wrong conclusion, and this is why.
    vi.useRealTimers()
    const calls = provider({ kill: ['cl'] })
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    vi.useFakeTimers({ toFake: ['Date'] })
    await pump()

    const clRow = rowsOf(job.id).find((q) => q.type === 'generate_cover_letter')!
    expect(clRow.status).toBe('failed')
    expect(clRow.autoRevives).toBe(AUTO_REVIVE_MAX)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(0)

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    const spent = { ...calls }
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(calls).toEqual(spent)
  })

  it('FINDING: a job whose CV is mid-REVIEW — the two producers disagree', async () => {
    // THE RESIDUAL DUPLICATE. `jobDocWorkInFlight` answers "is a first
    // generation of one of these documents in flight?" and `verify` /
    // documentId-carrying rows are deliberately excluded — a review or a
    // rebuild produces no MISSING document. That is the right rule for the
    // sweep, which decides per unit against `needsDoc`. It is the wrong
    // question for the trigger, which does not consult `needsDoc` at all:
    // it means "both documents", so a job that already HAS a CV gets a new
    // one anyway.
    //
    // Reached with no contrivance: the sweep generates the CV, the
    // processor chains the review, and the review takes seconds to a minute
    // of real provider time. The user presses Recompute Fit in that window
    // — or a `score_fit` row lands, or the next scan adds the job.
    provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    // ONE processor pass: the CV is written and its `verify` row is queued
    // but not run. `runPass` snapshots the due rows, so the chained review
    // is not in this pass.
    await pump(1)

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(typeList(job.id)).toEqual(['verify'])

    // ANSWER A, the sweep's. Exactly the one document that is missing; the
    // CV that exists is left alone.
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'verify'])
  })

  it('FINDING: ...and the trigger\'s answer to the same job is a fresh CV', async () => {
    // The identical starting state as the case above, one test earlier in
    // time, so the two answers are the two producers' answers and not two
    // different setups.
    vi.useRealTimers()
    const calls = provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    await pump(1)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(typeList(job.id)).toEqual(['verify'])

    // ANSWER B, the trigger's. The CV is not reviewed yet, so
    // `autoDocQueueEligible` admits the job, and no live first-generation
    // row exists — so it queues `tailor_job_docs`, which produces both
    // documents including the one already on disk.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['tailor_job_docs', 'verify'])

    await pump()

    // One job. THREE cv documents and TWO cover letters, every one of them
    // billed. (Two of the CVs because `tailor_job_docs` double-writes — see
    // finding 2 — so the trigger's own row contributes two where the sweep's
    // contributes one.)
    expect(docsOf(job.id, 'cv')).toHaveLength(3)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(2)
    expect(calls.cv).toBe(2)
  })

  it('FINDING: the regeneration loop is invisible to the trigger too', () => {
    // The excluded `documentId` case, which is a far wider window than a
    // review: from the moment the review fails until AUTO_REGEN_MAX is
    // reached, a `generate_cv` row carrying the CV's id is in flight and the
    // predicate says the CV is not covered.
    vi.useRealTimers()
    provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    return pump(1).then(() => {
      const cvDoc = docsOf(job.id, 'cv')[0]
      // The regeneration row the review→regenerate loop enqueues, live.
      addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: cvDoc.id })
      expect(typeList(job.id)).toEqual(['generate_cv', 'verify'])

      // The trigger does not see it, because a documentId means "rebuild a
      // document that exists".
      expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
      expect(typeList(job.id)).toEqual(['generate_cv', 'tailor_job_docs', 'verify'])
    })
  })

  it('a dead-sibling state with NO documents at all: the budget is the bound', () => {
    // The control for the two findings above: with nothing generated, both
    // units are spent and the SWEEP adds nothing. That is the bound doing
    // its job, not a silent queue.
    vi.useRealTimers()
    const job = eligibleJob()
    runDocsAutoQueueBacklog()
    for (const row of rowsOf(job.id)) {
      updateAIQueueItem(row.id, {
        status: 'failed',
        attempts: 12,
        autoRevives: AUTO_REVIVE_MAX,
        nextRetryAt: 0
      })
    }

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(2)

    // ...and the trigger, which has no budget of its own, is the one that
    // will spend here.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. THE CONFLICT RESOLUTION IN dc15d81 — is it right on its own merits?
//
// `fix-docsweep` predated the Auto-queue tab, so merging it into the
// settings branch could have silently deleted the tab's guarantee for the
// fit-landing path. The resolution kept BOTH halves: the two switch checks
// and the shared predicate. This section asks whether keeping both is
// actually correct, and whether either half can shadow the other.
// ---------------------------------------------------------------------------

describe('4. the fitScorer.ts conflict resolution', () => {
  // The switch check, as a CALL-shaped `if`, not a mention in prose.
  const SWITCHES =
    /if \(settings\.auto_queue_cv === false \|\| settings\.auto_queue_cover_letter === false\) \{\s*return false\s*\}/
  const ELIGIBLE = /if \(!autoDocQueueEligible\(job, settings, db\.listDocuments\(jobId\)\)\) return false/

  it('both halves are present in maybeAutoEnqueueDocs, switches first', () => {
    const b = body(code(readFileSync('electron/fitScorer.ts', 'utf8')), 'export function maybeAutoEnqueueDocs(')
    expect(b).toMatch(SWITCHES)
    expect(b).toMatch(ELIGIBLE)
    expect(b).toMatch(TRIGGER_CALL)
    // Order is a claim the comment makes ("come BEFORE the fit threshold,
    // and the reason is the return value"): a caller reads `false` as
    // "generation was not scheduled", which is true either way, so the
    // order is about the comment's honesty rather than behaviour. Pinned
    // anyway, since the comment asserts it.
    expect(b.indexOf('auto_queue_cv === false')).toBeLessThan(b.indexOf('autoDocQueueEligible('))
    expect(b.indexOf('autoDocQueueEligible(')).toBeLessThan(b.indexOf('jobDocWorkInFlight('))
  })

  it('either switch off means the trigger queues nothing', () => {
    for (const off of ['auto_queue_cv', 'auto_queue_cover_letter'] as const) {
      const job = eligibleJob()
      updateSettings({ [off]: false })
      expect(maybeAutoEnqueueDocs(job.id), off).toBe(false)
      expect(rowsOf(job.id), off).toHaveLength(0)
    }
  })

  it('both switches on, and no live work, means the trigger queues', () => {
    const job = eligibleJob()
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: true })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['tailor_job_docs'])
  })

  it('neither half shadows the other: all eight combinations of (switches, live rows)', () => {
    // The truth table both halves jointly produce. Read as
    // [cv switch, cover-letter switch] -> may the trigger queue?
    const table: [boolean, boolean, boolean, boolean][] = [
      //  cv     cl     withLiveRows  mayQueue
      [true, true, false, true],
      [true, true, true, false],
      [true, false, false, false],
      [true, false, true, false],
      [false, true, false, false],
      [false, true, true, false],
      [false, false, false, false],
      [false, false, true, false]
    ]
    for (const [cv, cl, liveRows, mayQueue] of table) {
      updateSettings({ auto_queue_cv: cv, auto_queue_cover_letter: cl })
      const job = eligibleJob()
      if (liveRows) addAIQueueItem({ type: 'generate_cv', jobId: job.id })
      expect(maybeAutoEnqueueDocs(job.id), `cv=${cv} cl=${cl} live=${liveRows}`).toBe(mayQueue)
      const expectedRows = liveRows || mayQueue ? 1 : 0
      expect(rowsOf(job.id).length, `cv=${cv} cl=${cl} live=${liveRows}`).toBe(expectedRows)
    }
  })

  it('SOUNDNESS: the trigger\'s inline switch rule agrees with enqueue\'s central one, in all four', async () => {
    // The thing a conflict resolution can get wrong: `enqueue` is the
    // central gate (`autoQueueAllows`: `tailor_job_docs` needs BOTH
    // switches) and the trigger also has a copy of that rule one step
    // earlier, so it can report a row it was never allowed to create. If
    // the two ever disagree, `maybeAutoEnqueueDocs`'s boolean — the only
    // signal its four callers have — becomes a lie.
    //
    // Two fresh jobs per combination, because the first call would leave a
    // row the second one's dedupe guard would trip over.
    for (const cv of [true, false]) {
      for (const cl of [true, false]) {
        updateSettings({ auto_queue_cv: cv, auto_queue_cover_letter: cl })
        const viaTrigger = eligibleJob()
        const reported = maybeAutoEnqueueDocs(viaTrigger.id)

        const viaEnqueue = eligibleJob()
        const { enqueue } = await import('./aiQueue')
        const created = enqueue({ type: 'tailor_job_docs', jobId: viaEnqueue.id }) !== null

        expect(reported, `cv=${cv} cl=${cl}: trigger said ${reported}, enqueue said ${created}`).toBe(created)
      }
    }
  })

  it('SOUNDNESS: the trigger reads the switches with the same tolerance as the rest of the tree', () => {
    // `!== false` everywhere else, so an absent or hand-edited key must not
    // disable anything. The trigger's `=== false` is the same rule written
    // the other way round; these are the values that would tell them apart.
    for (const odd of [undefined, null, 0, 1, 'false', 'true']) {
      updateSettings({ auto_queue_cv: odd, auto_queue_cover_letter: odd } as never)
      const job = eligibleJob()
      // Both spellings resolve to "on" for every value except literal
      // `false`, so the trigger queues.
      expect(maybeAutoEnqueueDocs(job.id), JSON.stringify(odd)).toBe(true)
    }
    // And literal `false` is the only value that is off.
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: false })
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TWO PRE-EXISTING DEFECTS THE FIX DOES NOT OWN, pinned so the numbers in
// the verdict are measured rather than assumed. Neither is introduced by
// 6ce4d85 and neither is in a module this change touches.
// ---------------------------------------------------------------------------

describe('residual defects, pinned for the record', () => {
  it('FINDING: `tailor_job_docs` writes each document TWICE, on its own', async () => {
    // `tailorJobDocsForJob` calls `tailorDocument`, which for a first
    // generation calls `createDocument` (ai.ts:1180), and then calls
    // `writeDocuments`, which INSERTS a second row (database.ts:1041-1055).
    // So one `tailor_job_docs` row — one tailoring call, one review, one
    // billed generation — lands two identical document rows.
    //
    // This is pre-existing and out of scope for the fix, but it is why the
    // trigger path's numbers in the finding above are 3 CVs and 2 cover
    // letters rather than 2 and 1, and it means the trigger path on its own
    // has always shown a user two of everything.
    const calls = provider()
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    await pump()

    // One tailoring of each document...
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    // ...and TWO rows of each.
    expect(docsOf(job.id, 'cv')).toHaveLength(2)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(2)

    // The SWEEP path, by contrast, writes one of each, because it goes
    // through `generate_cv` / `generate_cover_letter` (aiQueue.ts:159) and
    // that case creates its document and stops. So the two producers do not
    // just differ on WHETHER to regenerate — they differ on how many rows
    // they leave behind for the same work.
    wipe()
    addApiModel({ name: 'm', base_url: 'https://llm.test/v1', api_key: 'k', model: 'm', enabled: true })
    updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
    const job2 = eligibleJob()
    provider()
    runDocsAutoQueueBacklog()
    await pump()
    expect(docsOf(job2.id, 'cv')).toHaveLength(1)
    expect(docsOf(job2.id, 'cover_letter')).toHaveLength(1)
  })

  it('FINDING: the startup dedupe repair cannot collapse a cross-type duplicate either', async () => {
    // `dedupeAIQueueItems`'s `sameWork` compares `type` first
    // (database.ts:2475), so it can never fold a `tailor_job_docs` row into
    // a `generate_cv` row. Worth stating plainly: after this fix the shared
    // predicate is the ONLY thing in the tree that knows those two are the
    // same work. There is no second line of defence.
    const job = eligibleJob()
    runDocsAutoQueueBacklog()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    expect(rowsOf(job.id)).toHaveLength(3)

    const { dedupeAIQueueItems } = await import('./database')
    expect(dedupeAIQueueItems().removed).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 5. NOTHING ELSE REGRESSED
// ---------------------------------------------------------------------------

describe('5. the five previously-fixed defects are still fixed', () => {
  it('DEFECT 1: the hourly cadence is real, not a 240-minute no-op', async () => {
    const { scheduleNextFitAutoScore, cancelFitAutoScore } = await import('./fitAutoScore')
    const { scheduleNextDocsAutoQueue, cancelDocsAutoQueue } = await import('./docsAutoQueue')
    try {
      const fit = getFitAutoScoreState()
      const docs = getDocsAutoQueueState()
      // Armed: both must actually be running.
      scheduleNextFitAutoScore()
      scheduleNextDocsAutoQueue()
      for (const [name, s] of [
        ['fit', getFitAutoScoreState()],
        ['docs', getDocsAutoQueueState()]
      ] as const) {
        expect(s.intervalMinutes, name).toBe(60)
        expect(s.nextRunAt, name).not.toBeNull()
        expect(s.nextRunAt!, name).toBeLessThanOrEqual(3600000)
        expect(s.nextRunAt!, name).toBeGreaterThan(0)
      }
      expect(fit.intervalMinutes).toBe(60)
      expect(docs.intervalMinutes).toBe(60)
    } finally {
      cancelFitAutoScore()
      cancelDocsAutoQueue()
    }
  })

  it('DEFECT 1: no stale 240 anywhere in the cadence sources', () => {
    for (const f of [
      'electron/database.ts',
      'electron/fitAutoScore.ts',
      'electron/docsAutoQueue.ts'
    ]) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        // 2400 s (40 min) and 2_400 are not 240; match the number as a
        // standalone token so an unrelated digit does not trip this.
        if (/(?<![\d_.])240(?![\d_.])/.test(l)) {
          throw new Error(`${f}:${i + 1} still says 240: ${l.trim()}`)
        }
      })
    }
  })

  it('DEFECT 2: autoDocQueueEligible gates BOTH sweep paths and the trigger', () => {
    // Below the threshold, no score at all, and (for the sweep only) no
    // base CV. Every one of them must be refused on every automatic path.
    const lowScore = eligibleJob()
    updateJob(lowScore.id, { score: 0.2 })
    const noScore = eligibleJob()
    updateJob(noScore.id, { score: null })

    for (const job of [lowScore, noScore]) {
      expect(maybeAutoEnqueueDocs(job.id), `trigger ${job.id}`).toBe(false)
      expect(runDocsAutoQueueBacklog(), `periodic ${job.id}`).toBe(0)
      expect(enqueueDocsBacklog(), `startup ${job.id}`).toBe(0)
      expect(rowsOf(job.id)).toHaveLength(0)
    }

    // The base-CV requirement is the sweep-only one, and it is still there.
    const scored = eligibleJob()
    updateSettings({ base_cv: '' })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(scored.id)).toHaveLength(0)
  })

  it('DEFECT 3: the revive budget is respected on BOTH sweep paths', () => {
    const job = eligibleJob()
    runDocsAutoQueueBacklog()
    expect(rowsOf(job.id)).toHaveLength(2)

    // Spent: neither path resurrects them.
    for (const row of rowsOf(job.id)) {
      updateAIQueueItem(row.id, { status: 'failed', attempts: 12, autoRevives: AUTO_REVIVE_MAX, nextRetryAt: 0 })
    }
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    for (const row of rowsOf(job.id)) {
      expect(row.autoRevives).toBe(AUTO_REVIVE_MAX)
      expect(row.status).toBe('failed')
    }
  })

  it('DEFECT 3: a revival CHARGES the budget and APPLIES the cooldown, on both paths', () => {
    // The gap the prior reviewer flagged in their own suite: they mutated
    // the startup revive back to `enqueue()` and all 29 of their tests
    // still passed. So this asserts the WRITE, not just the outcome: the
    // row's `autoRevives` must go up and its `nextRetryAt` must move to
    // now + 4h. `enqueue`'s `revivePatch` resets `attempts` and
    // `nextRetryAt` to now and leaves `autoRevives` alone, so this test
    // fails on exactly that mutation.
    const COOLDOWN = 4 * 60 * 60 * 1000
    for (const path of ['periodic', 'startup'] as const) {
      wipe()
      addApiModel({
        name: 'm',
        base_url: 'https://llm.test/v1',
        api_key: 'k',
        model: 'm',
        enabled: true
      })
      updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
      const job = eligibleJob()
      runDocsAutoQueueBacklog()
      for (const row of rowsOf(job.id)) {
        updateAIQueueItem(row.id, {
          status: 'failed',
          attempts: 12,
          autoRevives: 0,
          nextRetryAt: 0,
          lastError: 'boom'
        })
      }
      const before = Date.now()
      const n = path === 'periodic' ? runDocsAutoQueueBacklog() : enqueueDocsBacklog()
      expect(n, path).toBe(2)

      for (const row of rowsOf(job.id)) {
        expect(row.status, path).toBe('pending')
        expect(row.autoRevives, `${path}: the budget was charged`).toBe(1)
        expect(row.attempts, `${path}: a fresh attempt budget`).toBe(0)
        expect(row.lastError, path).toBeUndefined()
        expect(row.nextRetryAt, `${path}: parked on the 4h cooldown, not due now`).toBeGreaterThanOrEqual(
          before + COOLDOWN
        )
      }

      // And a second pass inside the cooldown changes nothing.
      expect(path === 'periodic' ? runDocsAutoQueueBacklog() : enqueueDocsBacklog(), path).toBe(0)
    }
  })

  it('DEFECT 4: a live tailor_job_docs row stops the sweep, on both paths', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(1)
  })

  it('DEFECT 5: the prior reviewer\'s zzReviewDocsweep.test.ts is absent', () => {
    for (const f of [
      'electron/zzReviewDocsweep.test.ts',
      'electron/rvDocsweep.test.ts'
    ]) {
      expect(existsSync(f), f).toBe(false)
    }
  })

  it('db9f12e: the enqueue() call-site inventory matches the tree, and every polarity does too', async () => {
    // Re-derived from the source rather than trusting the table, because a
    // test asserting a wrong list is worse than no test. `rg` for
    // `enqueue(` misses nothing here: these are all the production sites.
    const { enqueue } = await import('./aiQueue')
    expect(typeof enqueue).toBe('function')

    const rows: { where: string; line: number; manual: boolean }[] = []
    const files = ['electron/main.ts', 'electron/aiQueue.ts', 'electron/fitScorer.ts', 'electron/fitAutoScore.ts', 'electron/jobSearch.ts', 'electron/docsAutoQueue.ts']
    for (const file of files) {
      // Strip block comments across the WHOLE file first (with the line
      // structure preserved), then line by line: stripping per line would
      // let a `/** ... enqueue() ... */` block read as a call site, which is
      // exactly the class of false positive this audit must not have.
      code(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (!/(?<![\w$.])enqueue\s*\(/.test(line)) return
        if (line.includes('function enqueue')) return
        rows.push({ where: file, line: i + 1, manual: /\{\s*manual\s*:\s*true\s*\}/.test(line) })
      })
    }

    // Four manual sites, all in main.ts, all inside an IPC handler whose
    // channel is a user action; seven automatic sites, none of them.
    expect(rows.filter((r) => r.manual).map((r) => `${r.where}:${r.line}`).sort()).toEqual([
      'electron/main.ts:394',
      'electron/main.ts:407',
      'electron/main.ts:586',
      'electron/main.ts:602'
    ])
    expect(rows.filter((r) => !r.manual).map((r) => `${r.where}:${r.line}`).sort()).toEqual([
      'electron/aiQueue.ts:177',
      'electron/aiQueue.ts:234',
      'electron/aiQueue.ts:307',
      'electron/docsAutoQueue.ts:363',
      'electron/fitAutoScore.ts:191',
      'electron/fitScorer.ts:133',
      'electron/jobSearch.ts:1513'
    ])

    // Polarity, checked against the source rather than the table: each
    // manual site is reached from an `ipcMain.handle` whose channel is a
    // user action, and each automatic site is not.
    const main = code(readFileSync('electron/main.ts', 'utf8')).split('\n')
    for (const r of rows.filter((x) => x.manual)) {
      const window = main.slice(Math.max(0, r.line - 12), r.line).join('\n')
      const channel = [...window.matchAll(/ipcMain\.handle\('([^']+)'/g)].pop()?.[1]
      expect(channel, `main.ts:${r.line}`).toBeTruthy()
      expect(channel, `main.ts:${r.line}`).not.toMatch(/^(jobs|scan|queue:list)/)
    }
    // The one ungated type has no automatic producer, which is what makes
    // `autoQueueAllows`'s `default: return true` safe for it.
    const regen = rows.filter((r) =>
      code(readFileSync(r.where, 'utf8')).split('\n')[r.line - 1].includes('regenerate_section')
    )
    expect(regen).toHaveLength(1)
    expect(regen[0].manual).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// THE REVIVAL-RATE BOUND, re-measured — in TWO lanes, because they are two
// different questions and the prior review only measured one of them.
// ---------------------------------------------------------------------------

const HOUR = 3600_000

interface DayCounters {
  perDay: number[]
  cv: number
  cl: number
  review: number
  keywords: number
}

/**
 * 30 simulated days of a job that can never be generated, with the
 * provider rate-limited forever (so every attempt is a real billed
 * request and each row's 10-attempt ladder always runs out).
 *
 * `withTrigger` adds the fit-landing trigger on a 4-hourly loop, which is
 * the most adversarial thing that can reach `maybeAutoEnqueueDocs`
 * repeatedly. Everything else — hourly periodic sweep, a launch every 4
 * hours, a scan every 2 hours, a crash-reclaim on every launch, model
 * health reset before every processor pass — is the prior review's
 * worst-case-for-spend configuration.
 */
interface DayCounters {
  jobId: number
  /** TAILORING ATTEMPTS consumed, per simulated day. */
  perDay: number[]
  attempts: number
  cv: number
  cl: number
  review: number
  keywords: number
}

/**
 * 30 simulated days of a job that can never be generated, with the
 * provider rate-limited forever (so every attempt fails and each row's
 * 10-attempt ladder always runs out).
 *
 * `withTrigger` adds the fit-landing trigger on a 4-hourly loop, which is
 * the most adversarial thing that can reach `maybeAutoEnqueueDocs`
 * repeatedly. Everything else — hourly periodic sweep, a launch every 4
 * hours, a scan every 2 hours, a crash-reclaim on every launch, model
 * health reset before every processor pass and before every provider
 * request — is the prior review's worst-case-for-spend configuration.
 *
 * Two counts, deliberately:
 *
 *   `attempts` — how many times a TAILORING was asked for, read off the
 *     queue's own `attempts` counter as it moves. This is the ceiling the
 *     revive budget bounds, and it is the number the prior review
 *     published.
 *
 *   `cv + cl` — how many of those actually reached the provider. It is
 *     LOWER, and always lower, than `attempts`: a 429 puts the model on a
 *     15s cooldown, so the second document unit processed in the same pass
 *     throws before it reaches the wire. A real provider would suppress
 *     more, never less, so `attempts` is the upper bound and `cv + cl` is
 *     what this particular configuration costs.
 */
async function thirtyDays(withTrigger: boolean): Promise<DayCounters> {
  vi.useRealTimers()
  const calls = provider({ kill: ['cv', 'cl'] })
  const job = eligibleJob()
  const start = Date.now()

  const attemptsOf = (): Map<number, number> =>
    new Map(getAIQueue().map((q) => [q.id, q.attempts]))

  let attempts = 0
  let attemptsMark = 0
  const perDay: number[] = []
  for (let hour = 0; hour < 30 * 24; hour++) {
    vi.setSystemTime(start + hour * HOUR)
    if (hour % 4 === 0) {
      const { reclaimInterruptedItems } = await import('./aiQueue')
      reclaimInterruptedItems()
      enqueueDocsBacklog()
      if (withTrigger) maybeAutoEnqueueDocs(job.id)
    }
    if (hour % 2 === 0) enqueueDocsBacklog()
    runDocsAutoQueueBacklog()

    // One processor pass at a time, so the `attempts` delta is exact: the
    // counter only ever goes UP by one per attempt, or resets to 0 the
    // moment the tenth attempt parks the row on the revive cooldown.
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
        if (Date.now() + (next - Date.now()) > start + (hour + 1) * HOUR) break
        vi.setSystemTime(next)
      }
      await processQueue()
      for (const row of getAIQueue()) {
        const prev = before.get(row.id) ?? 0
        if (row.attempts > prev) attempts += row.attempts - prev
        else if (prev > 0) attempts += 1
        else attempts += row.attempts
      }
    }

    if ((hour + 1) % 24 === 0) {
      perDay.push(attempts - attemptsMark)
      attemptsMark = attempts
    }
  }
  return { jobId: job.id, perDay, attempts, cv: calls.cv, cl: calls.cl, review: calls.review, keywords: calls.keywords }
}

describe('the revival-rate bound: the SWEEP lane, 30 simulated days', () => {
  it('is 80 attempts for the whole 30 days, every one of them inside day one', async () => {
    // The number the prior review published and the one the brief asked me
    // to re-measure: the sweep's two document units, each living 4 cycles
    // (1 initial + AUTO_REVIVE_MAX) of 10 rate-limited attempts, for the
    // life of the row.
    const r = await thirtyDays(false)
    console.log(
      `[rv2dupe] sweep lane: ATTEMPTS=${r.attempts} (cv=${r.cv} cl=${r.cl} on the wire) ` +
        `per-day=[${r.perDay.join(',')}] keywords=${r.keywords}`
    )

    // The literal 80, and the formula it comes from, so a change to either
    // constant has to be a deliberate edit of this line.
    expect(r.attempts).toBe(10 * (AUTO_REVIVE_MAX + 1) * 2)
    expect(r.attempts).toBe(80)
    expect(r.perDay).toEqual([80, ...new Array(29).fill(0)])
    // Nothing succeeded, so nothing exists and the whole 80 is waste.
    expect(docsOf(r.jobId, 'cv')).toHaveLength(0)
    expect(docsOf(r.jobId, 'cover_letter')).toHaveLength(0)
    // And the wire-level cost in this configuration is strictly below the
    // ceiling, because the provider's own 429 cooldown absorbs the second
    // unit's attempts.
    expect(r.cv + r.cl).toBeLessThanOrEqual(r.attempts)
  })

  it('and a job that DOES succeed spends nothing at all afterwards', async () => {
    // The 80 is the worst case for a job that can never succeed. The
    // ordinary case is the one that decides whether the sweep is a leak.
    vi.useRealTimers()
    const calls = provider()
    const job = eligibleJob()
    const start = Date.now()
    runDocsAutoQueueBacklog()
    await pump()
    const spent = { ...calls }
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)

    for (let hour = 0; hour < 30 * 24; hour++) {
      vi.setSystemTime(start + hour * HOUR)
      enqueueDocsBacklog()
      runDocsAutoQueueBacklog()
      await pump(60, 1)
    }
    // Zero further generations across 30 days and 30 launches, and still
    // exactly one CV and one cover letter.
    expect(calls).toEqual(spent)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
  })
})

describe('the revival-rate bound: the FIT-TRIGGER lane, which has no bound', () => {
  it('spends 2 generations per fit landing, every day, for 30 days', async () => {
    // THE SECOND NUMBER, and it is the one the prior review did not
    // measure. `maybeAutoEnqueueDocs` has no revive budget and no cooldown
    // of its own: it calls `enqueue`, whose duplicate path revives a
    // `failed` row with `revivePatch()` (attempts reset, nextRetryAt now,
    // `autoRevives` untouched) — the same write the sweep's fix was careful
    // NOT to use.
    //
    // It is worse than that, because there is nothing left to bound: when
    // both documents fail, `tailorJobDocsForJob` writes no document and
    // throws nothing, so `processItem` treats the item as a SUCCESS and
    // removes it. The queue therefore holds no record at all, and every
    // subsequent fit landing adds a brand-new row.
    //
    // Reachability in production is narrower than "every four hours": the
    // hourly fit re-seeder only queues `score_fit` for jobs whose score is
    // missing or whose `fit_score_version` is stale, so this repeats once
    // per fit landing — a Recompute Fit, a CV edit that bumps
    // `cv_version` for every job, a `score_fit` retry. It needs user
    // action, which is why this is reported rather than called a leak, but
    // it is unbounded in the number of fit landings and completely silent.
    const r = await thirtyDays(true)
    console.log(
      `[rv2dupe] sweep + fit-trigger lane: ATTEMPTS=${r.attempts} ` +
        `(cv=${r.cv} cl=${r.cl} on the wire) per-day=[${r.perDay.join(',')}]`
    )

    // Day one is the sweep's whole budget: the two sweep rows are the only
    // thing the queue holds for most of it, and the trigger's rows ride in
    // the gaps. From day two the sweep is out of budget entirely and the
    // trigger is the only thing spending — 6 landings a day, 2 documents
    // each, every day, with nothing to stop it.
    expect(r.perDay[0]).toBe(80)
    const tail = r.perDay.slice(1)
    expect(tail).toHaveLength(29)
    for (const d of tail) expect(d).toBe(12)
    expect(r.attempts).toBe(80 + 29 * 12)
    expect(r.attempts).toBe(428)
    // The wire-level cost shows the same shape: 5.35x the sweep lane's.
    expect(r.cv + r.cl).toBeGreaterThan(10 * (AUTO_REVIVE_MAX + 1) * 2)
  })
})
