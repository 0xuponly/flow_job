/**
 * THE TRIGGER -> SWEEP DUPLICATE, against the real store and the real
 * processor.
 *
 * Two producers write a job's documents and neither one used to know about
 * the other:
 *
 *   - the document backlog sweep queues `generate_cv` and
 *     `generate_cover_letter` as two units (electron/docsAutoQueue.ts);
 *   - the fit-landing trigger queues one `tailor_job_docs` row, which
 *     generates both documents in one pass (electron/fitScorer.ts).
 *
 * `enqueue`'s duplicate guard keys on `(type, jobId, documentId,
 * sectionName)`, so it cannot see that a `tailor_job_docs` row and a
 * `generate_cv` row are the same work. The sweep had a check for the
 * trigger's row (`jobCoveredByLiveTailor`); the trigger had NO check for
 * the sweep's. So the sweep running first and the user then recomputing
 * Fit — an ordinary action, and reachable at startup too — produced three
 * queue rows for one job's two documents, and therefore three CVs and
 * three cover letters, all of them billed. Every one of them passed AI
 * review, so nothing downstream collapsed them.
 *
 * The fix is ONE predicate, `jobDocWorkInFlight`
 * (electron/docAutoQueue.ts), asked by both directions about the document
 * types each is about to produce. So the tests here are deliberately
 * two-sided: for each direction, both the behavioural assertion (what the
 * queue and the documents look like afterwards) and the structural one
 * (the caller really CALLS the shared predicate, matched with a regex,
 * because a bare import satisfies `toContain` — a fact proved by a prior
 * reviewer gutting a function to `return false` and watching 15 tests
 * still pass).
 *
 * Every queue-state assertion runs against a real store and, for the
 * end-to-end cases, the real `processQueue` with only `fetch` stubbed.
 * A mocked store cannot tell you how many documents a job ends up with,
 * which is the number the user pays for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readFile } from 'fs/promises'

// Own userData directory: vitest runs test FILES in parallel and the other
// real-store suites drive the same store, so sharing a path would have
// them wiping each other's data mid-run. Hoisted because the electron mock
// factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: `/tmp/flow_job-test-docsweep-dedupe-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}` }))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
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
import { runDocsAutoQueueBacklog, enqueueDocsBacklog } from './docsAutoQueue'
import { maybeAutoEnqueueDocs } from './fitScorer'
import type { AIQueueItem, CreateJobInput, Document } from './types'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function wipe() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

let seq = 0

/** A job the shared gate ACCEPTS: base CV configured, score clears the bar. */
function eligibleJob(overrides: Partial<CreateJobInput> = {}) {
  seq += 1
  const { job } = createJob({
    title: `Engineer ${seq}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/job/dedupe-${seq}`,
    description: 'Senior Python engineer wanted. Kubernetes, Postgres, AWS.',
    ...overrides
  })
  updateJob(job.id, { score: 0.85 })
  return getJob(job.id)!
}

function rowsFor(jobId: number): AIQueueItem[] {
  return getAIQueue().filter((q) => q.jobId === jobId)
}

function typesFor(jobId: number): string[] {
  return rowsFor(jobId).map((q) => q.type).sort()
}

/** First-generation rows only: a row carrying a documentId rebuilds an existing document. */
function firstGenerationTypes(jobId: number): string[] {
  return rowsFor(jobId)
    .filter((q) => (q.documentId ?? null) === null)
    .map((q) => q.type)
    .sort()
}

function docsOfType(jobId: number, type: Document['type']): Document[] {
  return listJobDocuments(jobId).filter((d) => d.type === type)
}

/**
 * Every provider call, classified by its system prompt.
 *
 * The counts this file asserts on are the money: a CV tailoring is a real
 * generation of the job's CV, a review is a real provider call, and the
 * keyword extraction `tailorDocument` makes before each tailoring is a
 * third cost that has nothing to do with the duplicate. Classifying rather
 * than counting "everything" is what lets "the provider was not called
 * twice for this job's CV" be a claim about the CV.
 */
interface Calls {
  cvTailorings: number
  clTailorings: number
  keywordExtractions: number
  reviews: number
  total: number
}

const CV_CONTENT = [
  'Alex Rivera',
  'alex@example.com',
  '',
  'Experience',
  'Acme Corp\tRemote',
  'Senior Engineer\tMar 2021 – Present',
  '- Did the thing',
  '',
  'Education',
  'MIT\tCambridge, MA',
  'B.S. Computer Science\tJun 2021'
].join('\n')

function stubTransport() {
  const calls: Calls = {
    cvTailorings: 0,
    clTailorings: 0,
    keywordExtractions: 0,
    reviews: 0,
    total: 0
  }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { content: string }[] }
    const system = body.messages[0].content
    const user = body.messages[1].content
    calls.total++
    const reply = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

    if (system.includes('strict career-document reviewer')) {
      calls.reviews++
      return reply(JSON.stringify({ score: 95, passed: true, feedback: 'Good.' }))
    }
    if (system.includes('You extract keywords from a job description')) {
      calls.keywordExtractions++
      return reply(JSON.stringify({ keywords: [{ phrase: 'Python', weight: 1, category: 'hard', source: 'body' }] }))
    }
    if (system.includes('Tailor the candidate')) {
      calls.cvTailorings++
      return reply(CV_CONTENT)
    }
    calls.clTailorings++
    return reply(`Dear Hiring Manager,\n\nI am writing to apply for ${user.slice(0, 24)}.\n\nBest regards,\nAlex`)
  }))
  return calls
}

async function drainQueue(maxPasses = 40) {
  const { processQueue } = await import('./aiQueue')
  for (let pass = 0; pass < maxPasses; pass++) {
    const due = getAIQueue().some((q) => q.status === 'pending' && q.nextRetryAt <= Date.now())
    if (!due) return
    await processQueue()
  }
}

beforeEach(async () => {
  wipe()
  addApiModel({
    name: 'test-model',
    base_url: 'https://llm.test/v1',
    api_key: 'k',
    model: 'test-model',
    enabled: true
  })
  updateSettings({ base_cv: 'MASTER CV CONTENT', auto_doc_min_fit: 40 })
  vi.unstubAllGlobals()
  // Model health suppresses calls after failures and would silently change
  // every count below, so it is reset to "healthy" for each test.
  const { resetModelHealth } = await import('./ai')
  resetModelHealth()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// THE DEFECT: the sweep queues both units, the trigger queues a third row
// ---------------------------------------------------------------------------

describe('the sweep running first means the fit-landing trigger adds nothing', () => {
  it('the periodic sweep queues 2 rows and the trigger\'s 3rd row never appears', () => {
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])

    // The whole defect in one line. Before the shared predicate this was
    // `true` and the queue held three rows for two documents.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('the startup/post-scan path says the same thing as the periodic one', () => {
    // Both sweep paths are separate functions with their own loop, so the
    // guarantee has to be asserted on both: this is the one that runs on
    // every launch, and at startup it runs BEFORE the score_fit rows that
    // make the trigger fire — so it is the ordering that makes the
    // duplicate reachable on a cold start with no user action at all.
    const job = eligibleJob()

    expect(enqueueDocsBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(2)
  })

  it('a second sweep + trigger pass over the same job adds nothing', () => {
    const job = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(2)
  })

  it('the duplicate is per job: another job\'s sweep does not stop this one', () => {
    // The predicate reads rows for THIS job. Getting that wrong would
    // "fix" the duplicate by starving every job after the first.
    const first = eligibleJob()
    const second = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(4)
    expect(maybeAutoEnqueueDocs(second.id)).toBe(false)
    expect(rowsFor(first.id)).toHaveLength(2)
    expect(rowsFor(second.id)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// THE DEFERRED WORK ACTUALLY COMPLETES THE JOB
// ---------------------------------------------------------------------------

describe('deferral to the sweep\'s rows completes the job', () => {
  it('sweep queues, trigger declines, processor runs: exactly ONE cv and ONE cover letter', async () => {
    const calls = stubTransport()
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(2)

    await drainQueue()

    // The number the user is billed for. Three rows used to become three
    // CVs and three cover letters, each with its own tailoring calls and
    // its own review, and all of them passed review so nothing
    // downstream collapsed them.
    expect(docsOfType(job.id, 'cv')).toHaveLength(1)
    expect(docsOfType(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cvTailorings).toBe(1)
    expect(calls.clTailorings).toBe(1)
    // One review per generated document, chained by the processor.
    expect(calls.reviews).toBe(2)
    // And the queue drains to empty: the deferral left nothing behind to
    // finish later, because there is nothing left to do.
    expect(getAIQueue()).toHaveLength(0)
  })

  it('a second sweep + trigger pass after processing changes nothing and costs nothing', async () => {
    const calls = stubTransport()
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await drainQueue()
    const spent = { ...calls }

    // Both documents exist and both passed review, so neither producer
    // has anything left to do. This is the half of the deferral contract
    // that decides whether the money stops: if the sweep's rows produced
    // documents that did NOT satisfy the gate, a second pass would queue
    // them again and again, forever.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await drainQueue()

    expect(rowsFor(job.id)).toHaveLength(0)
    expect(docsOfType(job.id, 'cv')).toHaveLength(1)
    expect(docsOfType(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls).toEqual(spent)
  })

  it('the base CV the user configured is not mistaken for the job\'s generated CV', async () => {
    const calls = stubTransport()
    // The master CV as a document ROW, present for the whole run. It is
    // the trap `needsDoc` has to avoid: a bare `some(d => d.type === 'cv')`
    // reads the user's master document as this job's CV, the sweep would
    // queue nothing, and the trigger's deferral would be deferring to a
    // document that will never exist.
    createDocument('cv', 'Base CV', 'MASTER ROW CONTENT', undefined, true)
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    await drainQueue()

    expect(docsOfType(job.id, 'cv')).toHaveLength(1)
    expect(docsOfType(job.id, 'cover_letter')).toHaveLength(1)
    expect(calls.cvTailorings).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// THE REVERSE ORDERING STILL HOLDS (this direction was already checked)
// ---------------------------------------------------------------------------

describe('the trigger running first still stops the sweep', () => {
  it('a live tailor_job_docs row makes the sweep queue nothing', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['tailor_job_docs'])

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(rowsFor(job.id)).toHaveLength(1)
  })

  it('a PROCESSING tailor row still stops the sweep, not just a pending one', () => {
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    updateAIQueueItem(rowsFor(job.id)[0].id, { status: 'processing' })

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(rowsFor(job.id)).toHaveLength(1)
  })

  it('trigger then sweep, end to end: still one CV and one cover letter', async () => {
    const calls = stubTransport()
    const job = eligibleJob()

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    await drainQueue()

    // NOTE: this direction is the pre-existing behaviour and it produces
    // FOUR document rows for the job — `tailorJobDocsForJob` writes each
    // document twice, once inside `tailorDocument` (which calls
    // createDocument) and again through `writeDocuments`. That double
    // write is a separate defect in a module this change does not own
    // (electron/tailorJobDocs.ts / electron/ai.ts) and it is unchanged by
    // this fix; it is pinned here so the number in the report is measured
    // rather than assumed, and so a future fix to that path has to update
    // this assertion on purpose.
    expect(rowsFor(job.id)).toHaveLength(0)
    expect(calls.cvTailorings).toBe(1)
    expect(calls.clTailorings).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// PER-DOCUMENT GRANULARITY: a live single-unit row must not strand the other
// document. This is the case where a blanket "is this job covered?" would
// trade three CVs for none.
// ---------------------------------------------------------------------------

describe('partial coverage leaves the other document to the sweep', () => {
  it('a live generate_cv row stops the trigger, and the sweep still queues the cover letter', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    // The trigger produces BOTH documents, so a live CV row means it
    // would duplicate the CV.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)

    // ...but the cover letter is nobody's work yet. The sweep is what
    // brings it back, and it has to: a blanket skip on "this job is
    // covered" here would leave the job with a CV and no cover letter and
    // nothing queued to produce one.
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
    expect(docsOfType(job.id, 'cover_letter')).toHaveLength(0)
  })

  it('the same in the other order, for the cover letter', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)

    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a live generate_cv row that is PROCESSING stops the trigger too', () => {
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'processing' })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(1)
  })

  it('a FAILED row is not in flight: the trigger queues and the sweep revives', () => {
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, nextRetryAt: 0 })

    // Deferring to a failed row would defer to work that will never
    // happen: the sweep's revive branch is what brings a spent row back,
    // and `tailor_job_docs` produces both documents, so the trigger has
    // work the failed CV row cannot do.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typesFor(job.id)).toEqual(['generate_cv', 'tailor_job_docs'])
  })

  it('a regeneration row carrying a documentId does not block a first generation', () => {
    // The review -> regenerate loop rebuilds a document that EXISTS, by
    // replacing that row in place (`tailorDocument`'s document_id path).
    // It is not in flight *first generation*, so counting it as coverage
    // would suppress the sweep's fresh generation for a job whose CV the
    // user deleted — and the regeneration would produce nothing, because
    // there is no row left to replace. Job ends with no CV and nothing
    // queued: three CVs traded for none.
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 999 })

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    // Three rows, and the third is the regeneration: two FIRST
    // generations plus the rebuild of a document that does not exist.
    expect(rowsFor(job.id)).toHaveLength(3)
    expect(firstGenerationTypes(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('the sweep would revive that regeneration row rather than queue beside it', () => {
    // ...but when the row IS failed, it is the row the revive branch acts
    // on, and the predicate must still see the sweep's own first
    // generation for the CV. Both halves of `planUnit` in one state.
    const job = eligibleJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 999 })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(rowsFor(job.id)).toHaveLength(3)
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// THE auto_queue_cover_letter EDGE CASE
// ---------------------------------------------------------------------------

describe('the toggles: the trigger needs BOTH, and deferral cannot override them', () => {
  it('a live generate_cv row with cover-letter auto-queueing OFF leaves nothing owed', () => {
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: false })
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })

    // `tailor_job_docs` produces both documents, so it needs both
    // switches; with the cover letter off the trigger was never allowed to
    // produce this job's documents at all. Declining is not a deferral
    // here, so it cannot leave the job holding a CV and no cover letter
    // that something was supposed to finish: the cover letter is off, and
    // the CV has its own live row.
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(typesFor(job.id)).toEqual(['generate_cv'])

    // The sweep honours the same toggle, per unit, and queues nothing for
    // the cover letter either.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(rowsFor(job.id)).toHaveLength(1)
  })

  it('cover letters OFF and a live tailor row: the sweep still queues nothing', () => {
    updateSettings({ auto_queue_cv: true, auto_queue_cover_letter: false })
    const job = eligibleJob()
    // Only reachable manually (Quick Apply enqueues with `manual: true`,
    // which the switches never gate), which is exactly why the sweep has
    // to recognise the row: it produces both documents and is in flight.
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
    expect(typesFor(job.id)).toEqual(['tailor_job_docs'])
  })

  it('CV auto-queueing OFF, cover letters ON: a CV-only job is left alone entirely', () => {
    // The mirror image. The sweep's per-unit gating is the reason the
    // trigger's switch check cannot simply move into the shared
    // predicate: here a cover-letter-only sweep is legitimate.
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: true })
    const job = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter'])
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsFor(job.id)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// BOTH DIRECTIONS CALL THE SHARED PREDICATE
// ---------------------------------------------------------------------------
//
// These are the assertions that would have caught the defect, and they are
// written against the CALL rather than the name on purpose. A prior
// reviewer proved the weaker form worthless: `toContain('autoDocQueueEligible')`
// is satisfied by an import, so gutting the function to `return false`
// left 15 tests green. `if (!jobDocWorkInFlight(` cannot be satisfied by an
// import, and the behavioural tests above fail if either caller's gate is
// removed, so the two halves have teeth together.

describe('both directions CALL the shared coverage predicate', () => {
  // The whole `if (...)` statement is matched, not the function name: an
  // import line cannot produce `if (`, and pinning the arguments means the
  // assertion also says the trigger asks about BOTH document types (which
  // is what `tailor_job_docs` produces) while the sweep asks about one
  // (which is what a unit produces).
  const TRIGGER_GATE =
    /if \(jobDocWorkInFlight\(db\.getAIQueue\(\), jobId, \['cv', 'cover_letter'\]\)\) return false/

  it('the fit-landing trigger gates on it', async () => {
    const src = await readFile('electron/fitScorer.ts', 'utf8')
    const body = bodyOf(
      src,
      'export function maybeAutoEnqueueDocs',
      '/**\n * Send a \'job:scoreUpdated\''
    )
    expect(body).toMatch(TRIGGER_GATE)
  })

  it('BOTH sweep paths gate on it, per unit', async () => {
    const src = await readFile('electron/docsAutoQueue.ts', 'utf8')
    // The call, not the import: matched as a whole statement.
    expect(src).toMatch(/if \(jobDocWorkInFlight\(queue, job\.id, \[unit\.docType\]\)\) continue/)
    // Two of them — one per exported path. Counting rather than
    // `toContain`-ing is what makes editing one of them fail.
    expect(src.split('if (jobDocWorkInFlight(queue, job.id, [unit.docType])) continue').length - 1).toBe(2)
  })

  it('neither module keeps a private copy of "is this job covered"', async () => {
    // Comments are stripped: naming the old function in prose is fine
    // (the history is worth keeping), reading the queue in code is not.
    const sweep = codeOnly(await readFile('electron/docsAutoQueue.ts', 'utf8'))
    const trigger = codeOnly(await readFile('electron/fitScorer.ts', 'utf8'))
    // The old per-direction implementation, gone rather than left as a
    // second opinion: a live-tailor scan here, or any queue row type
    // test written in either caller, is a second implementation of the
    // shared predicate waiting to drift from it.
    expect(sweep).not.toContain('jobCoveredByLiveTailor')
    expect(sweep).not.toMatch(/q\.type === 'tailor_job_docs'/)
    expect(sweep).not.toMatch(/q\.type === 'generate_cv'/)
    expect(trigger).not.toMatch(/type === 'generate_cv'/)
    expect(trigger).not.toMatch(/type === 'tailor_job_docs'/)
    // The mapping from row type to the documents it produces exists once,
    // in the module that owns the question.
    const predicate = codeOnly(await readFile('electron/docAutoQueue.ts', 'utf8'))
    expect(predicate.match(/DOC_PRODUCING_ROWS/g)?.length).toBe(2)
  })

  it('the predicate itself is the one the two callers imported', async () => {
    const [sweep, trigger, predicate] = await Promise.all([
      readFile('electron/docsAutoQueue.ts', 'utf8'),
      readFile('electron/fitScorer.ts', 'utf8'),
      readFile('electron/docAutoQueue.ts', 'utf8')
    ])
    expect(sweep).toMatch(/import \{[^}]*jobDocWorkInFlight[^}]*\} from '\.\/docAutoQueue'/)
    expect(trigger).toMatch(/import \{[^}]*jobDocWorkInFlight[^}]*\} from '\.\/docAutoQueue'/)
    expect(predicate).toMatch(/export function jobDocWorkInFlight\(/)
  })
})

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n')
}

function bodyOf(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `could not find ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start)
  return src.slice(start, end === -1 ? undefined : end)
}