import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real ./database and the real ./ai are used here ON PURPOSE.
//
// The review -> regenerate loop spans four modules: aiQueue decides
// what to re-queue, ai decides what to write, and database decides
// whether the rebuild is a new row or the same one. Mocking any of
// them limits a test to the queue's own bookkeeping — which is how a
// cycle that ran exactly once, and left the user with a never-reviewed
// document, shipped behind an assertion (`toBeGreaterThanOrEqual(0)`)
// that passed with the whole regeneration enqueue deleted.
//
// So the only thing stubbed is the LLM transport, at `fetch`. Every
// document write, counter bump and queue row below is the real one.
//
// The store directory is its own (not the one database.test.ts wipes)
// so the two files cannot clobber each other's file while running in
// parallel.
vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => '/tmp/flow_job-test-regen',
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

import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  addApiModel,
  addAIQueueItem,
  createDocument,
  createJob,
  deleteDocument,
  getAIQueue,
  getDocument,
  listDocuments,
  listJobDocuments,
  reloadStore,
  updateSettings
} from './database'
import { resetModelHealth } from './ai'
import { processQueue, enqueue } from './aiQueue'
import { AUTO_REGEN_MAX, type Document } from './types'

const REVIEW_PROMPT_MARKER = 'strict career-document reviewer'
const KEYWORD_PROMPT_MARKER = 'You extract keywords'
const CV_PROMPT_MARKER = 'Tailor the candidate'

// Unique to the base CV's document ROW. Deliberately different from
// settings.base_cv, which is legitimately sent to the provider as the
// input to tailoring — so this marker can only reach a request if the
// base CV document itself was handed to the reviewer.
const BASE_DOC_MARKER = 'BASE-DOCUMENT-ROW-UNIQUE-8842'

interface Recorded {
  /** User prompt of every review request, in order. */
  reviews: string[]
  /** User prompt of every generation request, in order. */
  generations: string[]
  /** Every request (system + user), for "was this ever uploaded". */
  everyRequest: string[]
}

interface StubOptions {
  /** Score per review, by 1-based review number. Defaults to constant. */
  scoreFor?: (reviewNumber: number) => number
  /** Runs inside a review request, before the score comes back. */
  onReview?: (reviewNumber: number) => void
}

/**
 * One LLM: scores every review from `options`, and returns fresh
 * content for every generation request.
 *
 * Generated content names the review that triggered it, so a test can
 * tell WHICH version of the document each round reviewed — the
 * assertion that separates "the rebuilt document was re-queued" from
 * "the loop stopped after one round".
 */
function stubLlm(score: number, options: StubOptions = {}): Recorded {
  const rec: Recorded = { reviews: [], generations: [], everyRequest: [] }
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { content: string }[] }
    const system = body.messages[0].content
    const user = body.messages[1].content
    rec.everyRequest.push(`${system}\n${user}`)

    if (system.includes(REVIEW_PROMPT_MARKER)) {
      rec.reviews.push(user)
      options.onReview?.(rec.reviews.length)
      const s = options.scoreFor ? options.scoreFor(rec.reviews.length) : score
      return reply(JSON.stringify({ score: s, passed: s >= 70, feedback: 'Thin on evidence.' }))
    }
    if (system.startsWith(KEYWORD_PROMPT_MARKER)) {
      return reply(JSON.stringify({
        keywords: [{ phrase: 'python', weight: 0.9, category: 'hard', source: 'required' }]
      }))
    }
    rec.generations.push(user)
    if (system.includes(CV_PROMPT_MARKER)) {
      // Harvard shape: a bare section header, literal TABs, and a short
      // name-like first line — what looksLikeHarvardCv requires.
      return reply([
        'Alex Rivera',
        'alex@example.com',
        '',
        'Experience',
        'Acme Corp\tRemote',
        'Senior Engineer\tMar 2021 – Present',
        `- Rebuilt after review round ${rec.reviews.length}`,
        '',
        'Education',
        'MIT\tCambridge, MA',
        'B.S. Computer Science\tJun 2021'
      ].join('\n'))
    }
    return reply(`Dear Hiring Manager,\n\nRebuilt after review round ${rec.reviews.length}.\n\nBest regards,\nAlex`)
  }))
  return rec
}

/** Run passes until the queue is empty, as the 30s poll would. */
async function drain(maxPasses = 60): Promise<number> {
  for (let passes = 0; passes < maxPasses; passes++) {
    const due = getAIQueue().some((q) => q.status === 'pending' && q.nextRetryAt <= Date.now())
    if (!due) return passes
    await processQueue()
  }
  throw new Error(`queue did not drain within ${maxPasses} passes`)
}

function makeJob() {
  return createJob({
    title: 'Senior Engineer',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/job/regen-1',
    description: 'Senior Python engineer wanted.'
  }).job
}

const storeDir = '/tmp/flow_job-test-regen'
const storeFiles = [
  join(storeDir, 'apply-assistant-data.json'),
  join(storeDir, 'apply-assistant-key')
]

beforeEach(() => {
  vi.unstubAllGlobals()
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
  for (const f of storeFiles) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  resetModelHealth()
  addApiModel({
    name: 'test-model',
    base_url: 'https://llm.test/v1',
    api_key: 'k',
    model: 'test-model',
    enabled: true
  })
  updateSettings({ base_cv: 'Base CV used as tailoring input.' })
})

// A review below the pass bar must rebuild the document and review the
// REBUILD, round after round, until the budget is spent. The cycle used
// to be verify -> fail -> regenerate -> STOP, which left the user
// looking at a document nothing had ever reviewed.
describe('auto review -> regenerate loop', () => {
  function seedFailingDoc() {
    const job = makeJob()
    const doc = createDocument('cover_letter', 'Cover Letter — Acme', 'ORIGINAL COVER LETTER', job.id)
    addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id })
    return { job, doc }
  }

  it('iterates to the full AUTO_REGEN_MAX budget when every review fails', async () => {
    const { doc } = seedFailingDoc()
    const rec = stubLlm(40)

    await drain()

    // The budget is spent, not reset every round: the counter on the
    // surviving document is the number the Settings copy advertises.
    expect(getDocument(doc.id)?.auto_regen_attempts).toBe(AUTO_REGEN_MAX)
    // One review to start, then one per rebuild.
    expect(rec.reviews).toHaveLength(AUTO_REGEN_MAX + 1)
    expect(rec.generations).toHaveLength(AUTO_REGEN_MAX)
  })

  it('spends no more than the budget — a permanently failing document stops', async () => {
    seedFailingDoc()
    const rec = stubLlm(40)

    await drain()

    // Exactly the budget: not a sixth rebuild, not a runaway loop, and
    // nothing left queued for the user to discover.
    expect(rec.generations).toHaveLength(AUTO_REGEN_MAX)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('re-queues a review of the rebuilt document every round', async () => {
    seedFailingDoc()
    const rec = stubLlm(40)

    await drain()

    // The first review saw the original; every later review saw the
    // content produced by the review that triggered it. That is the
    // assertion whose absence let the loop dead-end after one round:
    // nothing reviewed twice, nothing left unreviewed.
    expect(rec.reviews).toHaveLength(AUTO_REGEN_MAX + 1)
    expect(rec.reviews[0]).toContain('ORIGINAL COVER LETTER')
    for (let round = 1; round <= AUTO_REGEN_MAX; round++) {
      expect(rec.reviews[round]).toContain(`Rebuilt after review round ${round}`)
    }
    expect(new Set(rec.reviews).size).toBe(AUTO_REGEN_MAX + 1)
  })

  it('keeps one document and lets it carry the review score', async () => {
    const { job, doc } = seedFailingDoc()
    stubLlm(40)

    await drain()

    // Same row, rebuilt in place: no replacement was inserted, and the
    // id the job, the queue and the reviewer all point at still
    // resolves.
    const survivors = listJobDocuments(job.id)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].id).toBe(doc.id)
    // Carries the review, rather than sitting there as an unreviewed
    // replacement wearing the previous round's score.
    expect(survivors[0].verification_score).toBe(40)
    expect(survivors[0].verification_feedback).toContain('Thin on evidence')
  })

  it('stops looping as soon as a rebuild passes the bar', async () => {
    const { doc } = seedFailingDoc()
    // First review fails, the rebuild fixes it, the second passes.
    const rec = stubLlm(40, { scoreFor: (n) => (n >= 2 ? 95 : 40) })

    await drain()

    expect(rec.generations).toHaveLength(1)
    expect(rec.reviews).toHaveLength(2)
    expect(getDocument(doc.id)?.verification_score).toBe(95)
    // Budget left over, and deliberately not spent.
    expect(getDocument(doc.id)?.auto_regen_attempts).toBe(1)
  })

  it('does not resurrect a document the user deleted mid-review', async () => {
    const { doc } = seedFailingDoc()
    const rec = stubLlm(40, { onReview: () => deleteDocument(doc.id) })

    await drain()

    // No rebuild of a row that is gone, and nothing re-queues it: the
    // counter would have been bumped on a document nobody can see.
    expect(rec.generations).toHaveLength(0)
    expect(getDocument(doc.id)).toBeUndefined()
  })
})

// The base CV is the user's master document. It is shown next to every
// job in the UI and `listDocuments(jobId)` unions it in for that
// reason — but the review fan-out used that same list, so every job's
// generation pass uploaded the base CV to the provider, gave it a
// verification score it never asked for, and pushed it through the
// auto-regeneration counter.
describe('the base CV is never sent to the AI reviewer', () => {
  // No production path creates this row today (the base CV lives in
  // settings.base_cv), but the column, the union in listDocuments and
  // the reviewer all still read it, so the guard is proven against the
  // row shape itself rather than left to a code path that may arrive.
  function seedBaseCv(): Document {
    return createDocument('cv', 'Base CV', BASE_DOC_MARKER, undefined, true)
  }

  it('is excluded from the review fan-out a generation pass enqueues', async () => {
    const job = makeJob()
    const rec = stubLlm(95)
    seedBaseCv()
    enqueue({ type: 'tailor_job_docs', jobId: job.id })

    await processQueue()

    const reviewed = getAIQueue().filter((q) => q.type === 'verify')
    expect(reviewed.length).toBeGreaterThan(0)
    for (const item of reviewed) {
      const d = getDocument(item.documentId as number)!
      expect(d.is_base).not.toBe(1)
      expect(d.job_id).toBe(job.id)
    }
    // And the base CV's content never reached the provider.
    expect(rec.everyRequest.some((r) => r.includes(BASE_DOC_MARKER))).toBe(false)
  })

  it('never accumulates auto_regen_attempts, however long the loop runs', async () => {
    const job = makeJob()
    const rec = stubLlm(40)
    const base = seedBaseCv()
    enqueue({ type: 'tailor_job_docs', jobId: job.id })

    await drain()

    // The job's own documents went round the loop the full budget...
    expect(rec.reviews.length).toBeGreaterThan(AUTO_REGEN_MAX)
    // ...and the base CV, which was never one of them, is untouched:
    // no score written, no regeneration budget spent, content intact.
    expect(getDocument(base.id)?.verification_score ?? null).toBeNull()
    expect(getDocument(base.id)?.auto_regen_attempts ?? 0).toBe(0)
    expect(getDocument(base.id)?.content).toBe(BASE_DOC_MARKER)
    expect(rec.everyRequest.some((r) => r.includes(BASE_DOC_MARKER))).toBe(false)
  })

  it('is still shown to the user alongside the job', async () => {
    // The display list keeps the union on purpose: this filter is for
    // job-scoped AUTOMATION, not for hiding the base CV from the user.
    const job = makeJob()
    const base = seedBaseCv()
    createDocument('cover_letter', 'Cover Letter — Acme', 'JOB DOC', job.id)
    expect(listDocuments(job.id).map((d) => d.id)).toContain(base.id)
    expect(listJobDocuments(job.id).map((d) => d.id)).not.toContain(base.id)
  })
})
