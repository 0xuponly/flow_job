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
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: `/tmp/flow_job-test-rv2dupe-review-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}` }))

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
  const { resetModelHealth, resetProviderSpend } = await import('./ai')
  const t0 = Date.now()
  for (let i = 0; i < maxSteps; i++) {
    // Both, for the reason `resetModelHealth` is here: the per-provider
    // spend cap (ai.ts) would otherwise start refusing calls part-way
    // through a 30-day simulation and silently change every count below.
    // This file measures the queue's revival budget, not the cap.
    resetModelHealth()
    resetProviderSpend()
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
// The trigger asks about ONE document type — the unit it is about to
// queue — exactly as the sweep does. It used to ask about
// `['cv', 'cover_letter']`, which is the both-documents `tailor_job_docs`
// unit's question, and that mismatch between the two producers' questions
// is the residual duplicate this file's Finding 1 measured.
const TRIGGER_CALL = /if \(jobDocWorkInFlight\(queue, jobId, \[unit\.docType\]\)\) continue/
const SWEEP_CALL = /if \(jobDocWorkInFlight\(queue, job\.id, \[unit\.docType\]\)\) continue/

describe('2. both directions CALL jobDocWorkInFlight', () => {
  it('the fit-landing trigger calls it, asking about the unit it is queuing', () => {
    const b = body(code(readFileSync('electron/fitScorer.ts', 'utf8')), 'export function maybeAutoEnqueueDocs(')
    expect(b).toMatch(TRIGGER_CALL)
    // Exactly one call: two calls in one function is how a second
    // implementation starts.
    expect(b.match(/jobDocWorkInFlight\(/g) ?? []).toHaveLength(1)
  })

  it('the trigger no longer queues the both-documents row', () => {
    // Structural, because it is the shape of the fix and a behavioural test
    // cannot say "no producer anywhere enqueues this type".
    const trigger = code(readFileSync('electron/fitScorer.ts', 'utf8'))
    expect(trigger).not.toContain('tailor_job_docs')
    expect(trigger).toMatch(/enqueue\(\{ type: unit\.queueType, jobId \}\)/)
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

  it("BEHAVIOUR: with the trigger's rows live, the sweep queues nothing", () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    // A gutted sweep returns 2 here and two more rows appear.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(2)
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
    // The CV unit revives the dead row (charged to the budget) and the
    // cover-letter unit is queued; no second CV row appears.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    expect(rowsOf(job.id).filter((q) => q.type === 'generate_cv')).toHaveLength(1)
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
  it("a live generate_cv row stops the trigger on the CV, and the cover letter is still queued", () => {
    // The exact edge the predicate's per-unit granularity exists for: a
    // blanket "is this job covered?" here trades a duplicate CV for a job
    // with NO cover letter and nothing queued to produce one.
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    // ...and the sweep, arriving afterwards, has nothing left to add.
    expect(runDocsAutoQueueBacklog()).toBe(0)
  })

  it('...and that pair completes BOTH documents end to end', async () => {
    const calls = provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
  })

  it('the mirror image, for the cover letter', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    expect(runDocsAutoQueueBacklog()).toBe(0)
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

  it('FINDING (now FIXED): a job whose CV is mid-REVIEW — both producers queue only the cover letter', async () => {
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

  it('FINDING (now FIXED): ...and the trigger now gives the SAME answer', async () => {
    // Identical starting state to the case above, one test earlier in time,
    // so the two answers are the two producers' answers and not two
    // different setups. The trigger used to queue `tailor_job_docs` here,
    // which REGENERATED the CV the sweep had deliberately left alone.
    vi.useRealTimers()
    const calls = provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    await pump(1)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(typeList(job.id)).toEqual(['verify'])

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'verify'])

    await pump()

    // THE MONEY. One job, ONE cv document and ONE cover letter, from one
    // tailoring call each. This case used to end at THREE cv documents and
    // TWO cover letters.
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
  })

  it('FINDING (now FIXED): the regeneration loop no longer duplicates the CV either', () => {
    // The excluded `documentId` case, which is a far wider window than a
    // review: from the moment the review fails until AUTO_REGEN_MAX is
    // reached, a `generate_cv` row carrying the CV's id is in flight. The
    // predicate still excludes it — a rebuild produces no MISSING document
    // — but the trigger now consults `docTypeMissing` first, and the CV is
    // not missing, so it never gets as far as the predicate for that unit.
    vi.useRealTimers()
    provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    return pump(1).then(() => {
      const cvDoc = docsOf(job.id, 'cv')[0]
      // The regeneration row the review→regenerate loop enqueues, live.
      addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: cvDoc.id })
      expect(typeList(job.id)).toEqual(['generate_cv', 'verify'])

      // The CV exists, so the CV unit is not even considered; only the
      // cover letter is queued.
      expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
      expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv', 'verify'])
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

    // ...and the trigger, which used to have no budget of its own and would
    // have spent here on every landing, now refuses the same rows for the
    // same reason: `planDocUnit` is the sweep's own bounded planner.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id)).toHaveLength(2)
    for (const row of rowsOf(job.id)) {
      expect(row.autoRevives, row.type).toBe(AUTO_REVIVE_MAX)
    }
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
  // The per-unit switch gate, as a CALL-shaped `if`, not a mention in prose.
  const UNITS = /for \(const unit of docUnits\(autoQueueFlags\(settings\)\)\)/g
  const SWITCH = /if \(!unit\.enabled\) continue/
  const ELIGIBLE = /if \(!autoDocQueueEligible\(job, settings, docs\)\) return false/

  it('both halves are present in maybeAutoEnqueueDocs, gate first', () => {
    const b = body(code(readFileSync('electron/fitScorer.ts', 'utf8')), 'export function maybeAutoEnqueueDocs(')
    expect(b).toMatch(UNITS)
    expect(b).toMatch(SWITCH)
    expect(b).toMatch(ELIGIBLE)
    expect(b).toMatch(TRIGGER_CALL)
    // One pass over the shared unit list, and the job-level gate before
    // it. Order is a claim the comment makes; pinned because the comment
    // asserts it.
    expect(b.match(UNITS)).toHaveLength(1)
    expect(b.indexOf('autoDocQueueEligible(')).toBeLessThan(b.indexOf('docUnits('))
    expect(b.indexOf('docTypeMissing(')).toBeLessThan(b.indexOf('jobDocWorkInFlight('))
    expect(b.indexOf('jobDocWorkInFlight(')).toBeLessThan(b.indexOf('planDocUnit('))
  })

  it('either switch off stops THAT unit and only that unit', () => {
    // Both keys are written every round: `updateSettings` merges, so a
    // one-key update would inherit the previous round's `false`.
    for (const off of ['auto_queue_cv', 'auto_queue_cover_letter'] as const) {
      const on = off === 'auto_queue_cv'
        ? { auto_queue_cv: false, auto_queue_cover_letter: true }
        : { auto_queue_cv: true, auto_queue_cover_letter: false }
      const job = eligibleJob()
      updateSettings(on)
      expect(rowsOf(job.id), off).toHaveLength(0)
      expect(maybeAutoEnqueueDocs(job.id), off).toBe(true)
      expect(typeList(job.id), off).toEqual(
        off === 'auto_queue_cv' ? ['generate_cover_letter'] : ['generate_cv']
      )
    }
    // Both off: nothing at all.
    const job = eligibleJob()
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: false })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id)).toHaveLength(0)
  })

  it('both switches on, and no live work, means the trigger queues both units', () => {
    const job = eligibleJob()
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: true })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('neither half shadows the other: all eight combinations of (switches, live rows)', () => {
    // The truth table both halves jointly produce. Read as
    // [cv switch, cover-letter switch, a live generate_cv row] ->
    // [may the trigger queue, which rows it may leave]. The trigger and
    // the sweep are per unit, so the answer is a SET of unit types, not a
    // boolean.
    const table: [boolean, boolean, boolean, string[]][] = [
      //  cv     cl     liveCv   rows the trigger ADDS
      [true, true, false, ['generate_cover_letter', 'generate_cv']],
      [true, true, true, ['generate_cover_letter']],
      [true, false, false, ['generate_cv']],
      [true, false, true, []],
      [false, true, false, ['generate_cover_letter']],
      [false, true, true, ['generate_cover_letter']],
      [false, false, false, []],
      [false, false, true, []]
    ]
    for (const [cv, cl, liveRows, expected] of table) {
      updateSettings({ auto_queue_cv: cv, auto_queue_cover_letter: cl })
      const job = eligibleJob()
      if (liveRows) addAIQueueItem({ type: 'generate_cv', jobId: job.id })
      const before = typeList(job.id)
      expect(maybeAutoEnqueueDocs(job.id), `cv=${cv} cl=${cl} live=${liveRows}`).toBe(
        expected.length > 0
      )
      expect(
        rowsOf(job.id)
          .map((q) => q.type)
          .sort(),
        `cv=${cv} cl=${cl} live=${liveRows}`
      ).toEqual([...before, ...expected].sort())
    }
  })

  it('SOUNDNESS: the trigger never reports a row its per-unit toggle forbids', async () => {
    // The thing a gate can get wrong: `enqueue` is the central gate
    // (`autoQueueAllows`) and the trigger reads the same switches one step
    // earlier, so it can report work it was never allowed to create. If
    // the two ever disagree, `maybeAutoEnqueueDocs`'s boolean — the only
    // signal its four callers have — becomes a lie.
    //
    // Per unit, because that is the shape now: `enqueue` is asked about
    // `generate_cv` / `generate_cover_letter`, which each need only their
    // own switch.
    const { enqueue } = await import('./aiQueue')
    for (const cv of [true, false]) {
      for (const cl of [true, false]) {
        for (const type of ['generate_cv', 'generate_cover_letter'] as const) {
          updateSettings({ auto_queue_cv: cv, auto_queue_cover_letter: cl })
          const viaTrigger = eligibleJob()
          maybeAutoEnqueueDocs(viaTrigger.id)
          const reported = rowsOf(viaTrigger.id).map((q) => q.type).includes(type)

          const viaEnqueue = eligibleJob()
          const created = enqueue({ type, jobId: viaEnqueue.id }) !== null

          expect(reported, `cv=${cv} cl=${cl} ${type}: trigger said ${reported}, enqueue said ${created}`).toBe(
            created
          )
        }
      }
    }
  })

  it('SOUNDNESS: the trigger reads the switches with the same tolerance as the rest of the tree', () => {
    // `!== false` everywhere else, so an absent or hand-edited key must not
    // disable anything. The trigger reads through the same `autoQueueFlags`
    // the sweep uses; these are the values that would tell the two spellings
    // apart if they had drifted.
    for (const odd of [undefined, null, 0, 1, 'false', 'true']) {
      updateSettings({ auto_queue_cv: odd, auto_queue_cover_letter: odd } as never)
      const job = eligibleJob()
      // Both spellings resolve to "on" for every value except literal
      // `false`, so the trigger queues both units.
      expect(maybeAutoEnqueueDocs(job.id), JSON.stringify(odd)).toBe(true)
      expect(typeList(job.id), JSON.stringify(odd)).toEqual([
        'generate_cover_letter',
        'generate_cv'
      ])
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
  it('FIXED: `tailor_job_docs` writes each document ONCE, on its own', async () => {
    // The double write, measured rather than argued. `tailorJobDocsForJob`
    // called `tailorDocument`, which for a first generation calls
    // `createDocument` (ai.ts:1180) and PUSHES the row, and then called
    // `writeDocuments`, which INSERTED a second row for the same document
    // (database.ts:1041-1055). One tailoring call, one review, one billed
    // generation — and TWO `cv` rows and TWO `cover_letter` rows, one of
    // each orphaned, never reviewed, never deleted.
    //
    // This is why the trigger path's numbers in the finding above used to
    // be 3 CVs and 2 cover letters rather than 2 and 1.
    //
    // Driven through a manually queued `tailor_job_docs` row (Quick
    // Apply's shape) rather than through the trigger, because the trigger
    // no longer queues that type at all — this defect belongs to the
    // `tailor_job_docs` path itself, whatever queued it.
    const calls = provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    await pump()

    // One tailoring of each document...
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    // ...and ONE row of each. Two of each before.
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    // Both rows are the ones the review chain saw, so both were reviewed:
    // no orphan left behind holding an unreviewed duplicate.
    expect(getAIQueue()).toHaveLength(0)
    expect(calls.review).toBe(2)

    // And the SWEEP path, which never went through `writeDocuments`, still
    // writes one of each — so the two producers now agree on how many rows
    // they leave behind for the same work, not just on whether to work.
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
    // The both-documents row is still recognised — it is what Quick Apply
    // queues — and it covers BOTH units, in both directions. The trigger
    // itself no longer produces one (it queues the missing units), so this
    // row is seeded the way a person creates it.
    const job = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(1)
  })

  it('DEFECT 4: the trigger\'s own rows stop the sweep on both paths', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsOf(job.id)).toHaveLength(2)
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
    // `electron/jobSearch.ts` used to be scanned for the scan-time
    // auto-tailor, which was the seventh automatic producer and is retired;
    // it no longer holds an `enqueue(` call site at all.
    const files = ['electron/main.ts', 'electron/aiQueue.ts', 'electron/fitScorer.ts', 'electron/fitAutoScore.ts', 'electron/jobSearch.ts', 'electron/docsAutoQueue.ts']
    for (const file of files) {
      // Strip block comments across the WHOLE file first (with the line
      // structure preserved), then line by line: stripping per line would
      // let a `/** ... enqueue() ... */` block read as a call site, which is
      // exactly the class of false positive this audit must not have.
      const lines = code(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (!/(?<![\w$.])enqueue\s*\(/.test(line)) return
        if (line.includes('function enqueue')) return
        // The call's arguments can wrap, and a flag on the fourth line of
        // a call is still that call's flag — so the window is read rather
        // than the line. Four lines is what the widest call in the tree
        // needs, and a stray `manual:` that far from an `enqueue(` would
        // over-classify this row and fail the expectation below, which is
        // the direction that errs loudly.
        const window = lines.slice(i, i + 4).join('\n')
        // "Carries a manual flag", not "passes the literal `manual: true`":
        // a processor finishing a person's row passes that row's own
        // origin (`manual: item.manualQueued === true`), and filing that
        // as automatic is the misclassification this audit exists to
        // prevent. `manual: false` / `manual: undefined` stay automatic.
        rows.push({ where: file, line: i + 1, manual: /\{\s*manual\s*:\s*(?!false\b|undefined\b)/.test(window) })
      })
    }

    // Manual sites in the queue processor and in main.ts's IPC handlers; the
    // processor's do not assert the flag — they read it off the row they are
    // finishing, which is checked below rather than assumed; six automatic
    // sites, none of them — the scan-time auto-tailor that was the seventh is
    // retired.
    //
    // The line numbers moved when the cap's manual exemption was re-grounded
    // on PRESENCE rather than provenance: both files' comments above these
    // call sites grew to explain the two flags and what each one buys. No
    // call site was added, removed or reclassified, and this list is the
    // independent cross-check that says so — `review.enqueueCallSites.test.ts`
    // carries the same inventory with a `present` column beside `manual`.
    //
    // They moved again (+42) when the Queue banner's count was re-derived
    // from the shared waiting predicate: the import and the documented
    // `pausedCapRows` sit above every one of these sites. Same cross-check,
    // same answer — no call site added, removed or reclassified.
    expect(rows.filter((r) => r.manual).map((r) => `${r.where}:${r.line}`).sort()).toEqual([
      'electron/aiQueue.ts:1035',
      'electron/aiQueue.ts:1037',
      'electron/main.ts:653',
      'electron/main.ts:695',
      'electron/main.ts:910',
      'electron/main.ts:956'
    ])
    expect(rows.filter((r) => !r.manual).map((r) => `${r.where}:${r.line}`).sort()).toEqual([
      'electron/aiQueue.ts:1002',
      'electron/aiQueue.ts:845',
      'electron/aiQueue.ts:902',
      'electron/docsAutoQueue.ts:253',
      'electron/fitAutoScore.ts:191',
      'electron/fitScorer.ts:136',
      'electron/main.ts:670',
      'electron/main.ts:925'
    ])

    // Polarity, checked against the source rather than the table: each
    // manual site is reached from an `ipcMain.handle` whose channel is a
    // user action, and each automatic site is not.
    const main = code(readFileSync('electron/main.ts', 'utf8')).split('\n')
    for (const r of rows.filter((x) => x.manual && x.where === 'electron/main.ts')) {
      // Wide enough to reach the enclosing `ipcMain.handle` even when the
      // handler carries a long explanatory comment above the work. The
      // intent is "reachable from a user action", not "is 12 lines away".
      const window = main.slice(Math.max(0, r.line - 30), r.line).join('\n')
      const channel = [...window.matchAll(/ipcMain\.handle\('([^']+)'/g)].pop()?.[1]
      expect(channel, `main.ts:${r.line}`).toBeTruthy()
      expect(channel, `main.ts:${r.line}`).not.toMatch(/^(jobs|scan|queue:list)/)
    }
    // The two manual sites that are NOT entry points must therefore be
    // inheriting the flag from the row they are finishing, never asserting
    // it: a literal `manual: true` inside the processor would promote an
    // automatic row to a manual one, which is the whole thing the manual
    // flag is trusted not to do.
    for (const r of rows.filter((x) => x.manual && x.where !== 'electron/main.ts')) {
      const call = code(readFileSync(r.where, 'utf8')).split('\n').slice(r.line - 1, r.line + 3).join('\n')
      expect(call, `${r.where}:${r.line} must take its flag from the row, not assert it`).toMatch(
        /manualQueued/
      )
      expect(call, `${r.where}:${r.line} must not assert the flag outright`).not.toMatch(
        /manual\s*:\s*true/
      )
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
  /** Every job the run covered, `jobId` first. One entry unless asked for more. */
  jobIds: number[]
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
 * `attempts` is measured at the WIRE, not off the queue's own counter,
 * and that is the whole reason this file can measure the trigger lane at
 * all. The counter cannot see it: a `tailor_job_docs` row whose two
 * documents both fail is removed by `processItem` as a success
 * (`tailorJobDocsForJob` records the failure and returns), so it never
 * increments `attempts` and the queue keeps no record of the spend. The
 * counter also over-reports the other way — it used to charge one attempt
 * to any row that merely sat still, which is how a no-request provider
 * block (which costs nothing and is now not charged) came to be counted
 * as an attempt. Both errors are in the same direction as "the queue
 * thinks it spent more or less than it did", and the fix for the
 * 2026-10-02 bug was to stop confusing the two.
 *
 * So `attempts` here is `cv + cl`: provider requests that actually left
 * the app, which is the number the user pays for. The provider stub
 * clears model health before every request, so one wire call is one
 * attempt and the two agree for the sweep lane; a real provider would
 * suppress more of them, never fewer.
 */
/**
 * These two drive 720 simulated hours through the REAL processor and the
 * REAL store, so their honest cost is measured in seconds rather than
 * milliseconds and every step is a full-store encrypt plus an atomic write.
 * They carry their own budget for the reason vitest.config.ts states: the
 * global 5s is a hang detector and raising it for everyone would blunt it.
 */
const SIMULATION_TIMEOUT = 30_000

async function thirtyDays(withTrigger: boolean, jobCount = 1): Promise<DayCounters> {
  vi.useRealTimers()
  const calls = provider({ kill: ['cv', 'cl'] })
  const jobs = Array.from({ length: jobCount }, () => eligibleJob())
  const job = jobs[0]
  const start = Date.now()

  // Spend, read at the wire: the queue's own counter cannot see the
  // trigger lane (see the doc comment above).
  const spent = (): number => calls.cv + calls.cl

  let attemptsMark = 0
  const perDay: number[] = []
  for (let hour = 0; hour < 30 * 24; hour++) {
    vi.setSystemTime(start + hour * HOUR)
    if (hour % 4 === 0) {
      const { reclaimInterruptedItems } = await import('./aiQueue')
      reclaimInterruptedItems()
      enqueueDocsBacklog()
      if (withTrigger) for (const j of jobs) maybeAutoEnqueueDocs(j.id)
    }
    if (hour % 2 === 0) enqueueDocsBacklog()
    runDocsAutoQueueBacklog()

    // One processor pass at a time, so the `attempts` delta is exact: the
    // counter goes UP by one per attempt that reached the provider, and
    // resets to 0 the moment the tenth parks the row on the revive
    // cooldown (which the autoRevives bump catches, see below).
    for (let step = 0; step < 200; step++) {
      const { processQueue } = await import('./aiQueue')
      const { resetModelHealth, resetProviderSpend } = await import('./ai')
      resetModelHealth()
      resetProviderSpend()
      const runnable = getAIQueue().filter(
        (q) => q.status === 'pending' || (q.status === 'failed' && (q.autoRevives ?? 0) < AUTO_REVIVE_MAX)
      )
      if (runnable.length === 0) break
      const next = Math.min(...runnable.map((q) => q.nextRetryAt))
      if (next > Date.now()) {
        if (Date.now() + (next - Date.now()) > start + (hour + 1) * HOUR) break
        vi.setSystemTime(next)
      }
      await processQueue()
    }

    if ((hour + 1) % 24 === 0) {
      perDay.push(spent() - attemptsMark)
      attemptsMark = spent()
    }
  }
  return { jobId: job.id, jobIds: jobs.map((j) => j.id), perDay, attempts: spent(), cv: calls.cv, cl: calls.cl, review: calls.review, keywords: calls.keywords }
}

describe('the revival-rate bound: the SWEEP lane, 30 simulated days', () => {
  it('is 80 attempts for the whole 30 days, every one of them inside day one', async () => {
    // The number the prior review published and the one the brief asked me
    // to re-measure: the sweep's two document units, each living 4 cycles
    // (1 initial + AUTO_REVIVE_MAX) of 10 rate-limited attempts, for the
    // life of the row. Unchanged by the provider-block fix, and it should
    // be: a real 429 storm still costs a real request per attempt, so the
    // bound this lane is about is untouched by making free failures free.
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
    // `attempts` IS the wire-level cost (see thirtyDays), so this is the
    // shape check: the spend is CV and cover letter in equal measure.
    expect(r.cv).toBe(r.attempts / 2)
    expect(r.cl).toBe(r.attempts / 2)
    // Timeout LAST, not second. Vitest 4 types the collector as
    // `(name, fn, timeout)`, so `it(name, TIMEOUT, fn)` silently discards
    // the number and falls back to the global 5s — verified, not assumed:
    // with the number in second position this 30-day simulation runs on the
    // default budget and times out under parallel load.
  }, SIMULATION_TIMEOUT)

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

describe('the revival-rate bound: the FIT-TRIGGER lane', () => {
  it('is 80 attempts for the whole 30 days — the SAME bound as the sweep', async () => {
    // THE SECOND NUMBER, re-measured after the fix.
    //
    // It used to be 428. `maybeAutoEnqueueDocs` had no revive budget and
    // no cooldown of its own: it called `enqueue`, whose duplicate path
    // revives a `failed` row with `revivePatch()` (attempts reset,
    // nextRetryAt now, `autoRevives` untouched) — the same write the
    // sweep's fix was careful NOT to use. And there was nothing left to
    // bound even that: when both documents failed, `tailorJobDocsForJob`
    // wrote no document and threw nothing, so `processItem` treated the
    // item as a SUCCESS and removed it. The queue held no record, so every
    // subsequent fit landing added a brand-new row with a full fresh
    // attempt budget. 80 from the sweep plus 12 a day from the trigger,
    // forever.
    //
    // Two changes close it, and they compose:
    //   1. the trigger queues `generate_cv` / `generate_cover_letter`,
    //      whose processor cases THROW on failure — so a failed generation
    //      now leaves a row, and there is per-unit state to charge;
    //   2. the trigger plans through the sweep's own `planDocUnit` and
    //      writes the sweep's own `revivePatchForAutomatic`, so a landing
    //      on a dead row spends `autoRevives` and parks on the 4h
    //      cooldown instead of resurrecting it for free.
    //
    // ARITHMETIC (identical to the sweep lane):
    //   per document unit, per life:  (1 + AUTO_REVIVE_MAX) cycles
    //                                x 10 rate-limited attempts each
    //                                = 10 x (AUTO_REVIVE_MAX + 1) = 40
    //   a job has 2 units            = 80 attempts per job, EVER
    //   a fit landing can only add a row when the unit has NO row at all,
    //   and can only revive inside that same shared 40-per-unit budget,
    //   so no number of landings moves the total.
    const r = await thirtyDays(true)
    console.log(
      `[rv2dupe] sweep + fit-trigger lane: ATTEMPTS=${r.attempts} ` +
        `(cv=${r.cv} cl=${r.cl} on the wire) per-day=[${r.perDay.join(',')}]`
    )

    // The literal number and the formula it comes from.
    expect(r.attempts).toBe(10 * (AUTO_REVIVE_MAX + 1) * 2)
    expect(r.attempts).toBe(80)
    // Day one, and nothing after — the sweep lane's shape exactly. It was
    // [80, 12 x 29] before the fix.
    expect(r.perDay).toEqual([80, ...new Array(29).fill(0)])
    // Nothing succeeded, so nothing exists and the whole 80 is waste.
    expect(docsOf(r.jobId, 'cv')).toHaveLength(0)
    expect(docsOf(r.jobId, 'cover_letter')).toHaveLength(0)
    // And it is no longer strictly worse than the sweep lane on the wire.
    expect(r.cv + r.cl).toBeLessThanOrEqual(10 * (AUTO_REVIVE_MAX + 1) * 2)
    // And it is the whole of `attempts`, which is the point of measuring
    // at the wire: every one of these went to the provider.
    expect(r.attempts).toBe(r.cv + r.cl)
  })

  it('a job that DOES succeed spends nothing on later landings', async () => {
    // The bound's other half: the worst case above is a job that can never
    // be generated. The ordinary case — the one that decides whether the
    // trigger is a leak — is zero.
    vi.useRealTimers()
    const calls = provider()
    const job = eligibleJob()
    const start = Date.now()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    await pump()
    const spent = { ...calls }
    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)

    // 30 days, 720 fit landings on a 4-hourly loop, every sweep and
    // startup path alongside them.
    for (let hour = 0; hour < 30 * 24; hour++) {
      vi.setSystemTime(start + hour * HOUR)
      maybeAutoEnqueueDocs(job.id)
      enqueueDocsBacklog()
      runDocsAutoQueueBacklog()
      await pump(60, 1)
    }
    // Zero further generations, and still exactly one CV and one cover
    // letter: both documents exist and passed review, so neither unit is
    // missing and the trigger has nothing to say.
    expect(calls).toEqual(spent)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('no second spend inside the 4h cooldown', async () => {
    // A dead row that still has budget is parked by the revival, and a
    // landing inside the window must not pull it forward. This is the
    // specific write the sweep's fix made and the trigger used to skip:
    // `enqueue`'s `revivePatch` sets `nextRetryAt: Date.now()`.
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 12, autoRevives: 0, nextRetryAt: 0 })

    const first = Date.now()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    const revived = rowsOf(job.id).find((q) => q.id === row.id)!
    expect(revived.status).toBe('pending')
    expect(revived.autoRevives).toBe(1)
    expect(revived.nextRetryAt).toBeGreaterThanOrEqual(first + 4 * 60 * 60 * 1000)

    // Landings every 15 minutes, all of them INSIDE the 4h window (15 x
    // 15min = 225min < 240min): nothing is spent, nothing is charged, and
    // no second row appears. Before the fix each of these was a fresh
    // `tailor_job_docs` row and a fresh pair of tailorings.
    for (let i = 1; i <= 15; i++) {
      vi.setSystemTime(first + i * 15 * 60 * 1000)
      maybeAutoEnqueueDocs(job.id)
      const still = rowsOf(job.id).find((q) => q.id === row.id)!
      expect(still.autoRevives, `landing ${i}`).toBe(1)
      expect(still.nextRetryAt, `landing ${i}`).toBeGreaterThan(Date.now())
    }
    expect(rowsOf(job.id).filter((q) => q.type === 'generate_cv')).toHaveLength(1)

    // While the revived row is `pending` the trigger spends nothing at all:
    // `jobDocWorkInFlight` sees a live row, so it never reaches the planner.
    const pending = rowsOf(job.id).find((q) => q.id === row.id)!
    expect(pending.status).toBe('pending')
    vi.setSystemTime(first + 17 * 15 * 60 * 1000)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id).find((q) => q.id === row.id)!.autoRevives).toBe(1)

    // One processor failure later, past the window, it MAY be revived
    // again — a cooldown, not a lock — and it spends a second unit of the
    // shared budget doing so. That is what makes the whole thing finite.
    updateAIQueueItem(row.id, { status: 'failed', attempts: 12 })
    maybeAutoEnqueueDocs(job.id)
    const after = rowsOf(job.id).find((q) => q.id === row.id)!
    expect(after.autoRevives).toBe(2)
    expect(after.nextRetryAt).toBeGreaterThan(Date.now())
  })

  it('the budget is PER JOB: two jobs each get the whole 80', async () => {
    // Per job, not global: the budget is on the row and the rows are per
    // job, so a shared budget would starve every job after the first.
    //
    // Measured with `thirtyDays`, the harness the two cases above use and
    // the only one in this file that measures at the WIRE. This case used to
    // carry its own copy of the loop, and that copy was measuring the wrong
    // thing in two ways at once:
    //
    //   - it tallied `attempts` off the queue's own counter with an
    //     `else if (prev > 0) attempts += 1` branch that charges one attempt
    //     to any row that merely sat still. That is the counter-versus-wire
    //     confusion the `thirtyDays` doc comment above names, and it is
    //     exactly what a no-request provider block looks like to a counter.
    //
    //   - it ran with NO provider stub, so every request failed at the
    //     network layer with no status code. That marked the model cooling
    //     for 15s, which made the rest of that row's own AI calls block, and
    //     a block costs nothing by design. With a cap refusal also free, no
    //     row could ever spend an attempt, so none of them ever reached
    //     `failed` and the queue re-probed for the full 30 days without
    //     terminating — 60,000 passes for 1 real request each. Not a hang and
    //     not a leak, but a harness that cannot see the thing it is
    //     measuring.
    //
    // `thirtyDays` stubs the provider, resets health and the spend ledger
    // each step, and reads the total off the wire, so one billed 429 is one
    // attempt. That is the same arithmetic this case is about.
    const r = await thirtyDays(true, 2)
    console.log(
      `[rv2dupe] fit-trigger lane, TWO jobs: ATTEMPTS=${r.attempts} ` +
        `(cv=${r.cv} cl=${r.cl} on the wire) per-day=[${r.perDay.join(',')}]`
    )

    // Exactly two jobs' budgets, not one shared between them.
    expect(r.attempts).toBe(2 * 10 * (AUTO_REVIVE_MAX + 1) * 2)
    expect(r.attempts).toBe(160)
    // Every one of them reached the provider.
    expect(r.cv + r.cl).toBe(r.attempts)
    // And each job independently used its WHOLE budget: two rows apiece,
    // both bottomed out on the revive ceiling. A shared or truncated budget
    // would leave the second job short of it, which is the whole failure
    // this case exists to catch.
    expect(r.jobIds).toHaveLength(2)
    for (const id of r.jobIds) {
      expect(rowsOf(id), `job ${id}`).toHaveLength(2)
      for (const row of rowsOf(id)) {
        expect(row.autoRevives, `job ${id} ${row.type}`).toBe(AUTO_REVIVE_MAX)
        expect(row.attempts, `job ${id} ${row.type}`).toBe(10)
      }
    }
    // Timeout LAST — see the note on the sweep-lane simulation above.
  }, SIMULATION_TIMEOUT)
})
