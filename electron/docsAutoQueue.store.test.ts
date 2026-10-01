/**
 * The document backlog sweep against a REAL store and the REAL aiQueue.
 *
 * This file exists because the sweep's first test file mocks ./database
 * wholesale, and that is precisely why it could not see the three cost
 * defects this one pins. A mocked store cannot tell you that 200 unscored
 * jobs are about to become 400 LLM calls, that a live `tailor_job_docs`
 * row produces three rows for one job's two documents, or that the startup
 * path revives a row the processor has already given up on. Every claim
 * here is a claim about what the shipped code does to a real store, so it
 * runs against the real one.
 *
 * The interval cases use `timerDeadlineMs`'s actual contract: `nextRunAt`
 * is the REMAINING milliseconds, not an absolute timestamp, which is what
 * makes it a usable assertion on the live armed timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

// Own userData directory: vitest runs test FILES in parallel and the other
// real-store suites drive the same store, so sharing a path would have
// them wiping each other's data mid-run. Hoisted because the electron mock
// factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-test-docsweep' }))

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
  createJob,
  createDocument,
  updateJob,
  getJob,
  getAIQueue,
  addAIQueueItem,
  updateAIQueueItem,
  updateDocumentVerification,
  updateSettings,
  getSettings,
  reloadStore,
  listJobDocuments,
  recomputeJobStatusFromDocs
} from './database'
import {
  autoQueueFlags,
  runDocsAutoQueueBacklog,
  enqueueDocsBacklog,
  scheduleNextDocsAutoQueue,
  cancelDocsAutoQueue,
  getDocsAutoQueueState
} from './docsAutoQueue'
import {
  scheduleNextFitAutoScore,
  cancelFitAutoScore,
  getFitAutoScoreState
} from './fitAutoScore'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, CreateJobInput } from './types'

const HOUR_MS = 60 * 60 * 1000

// Unique to the base CV's document ROW, and deliberately different from
// settings.base_cv — which is legitimately sent to the provider as the
// input to tailoring. So this marker can only appear in a prompt if the
// base CV's ROW was handed over as a document under review.
const BASE_DOC_MARKER = 'BASE-DOCUMENT-ROW-UNIQUE-8842'

function wipe() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

let seq = 0
function newJob(overrides: Partial<CreateJobInput> = {}) {
  seq += 1
  const { job } = createJob({
    title: `Engineer ${seq}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/job/${seq}`,
    description: 'JD',
    ...overrides
  })
  return job
}

/**
 * A job the eligibility gate ACCEPTS: a base CV is configured (set in
 * beforeEach) and the score clears auto_doc_min_fit.
 *
 * Every test about queue mechanics has to seed this, or it is really
 * testing the gate and not the thing it names. The gate cases below seed
 * the ineligible variants deliberately.
 */
function eligibleJob(overrides: Partial<CreateJobInput> = {}) {
  const job = newJob(overrides)
  updateJob(job.id, { score: 0.8 })
  return getJob(job.id)!
}

function row(jobId: number, type: AIQueueItem['type']): AIQueueItem | undefined {
  return getAIQueue().find((q) => q.jobId === jobId && q.type === type)
}

function typesFor(jobId: number): string[] {
  return getAIQueue().filter((q) => q.jobId === jobId).map((q) => q.type).sort()
}

/** The state processItem's catch leaves behind once the budget is spent. */
function terminalFailure(id: number) {
  updateAIQueueItem(id, {
    status: 'failed',
    attempts: 9,
    autoRevives: AUTO_REVIVE_MAX,
    nextRetryAt: 0
  })
}

beforeEach(() => {
  wipe()
  seq = 0
  updateSettings({ base_cv: 'MASTER CV BODY', cv_version: 4, auto_doc_min_fit: 40 })
})

afterEach(() => {
  cancelDocsAutoQueue()
  cancelFitAutoScore()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// The cadence is measured on the LIVE armed timer, not on the constant.
// `nextRunAt` is remaining ms, so "under an hour" is a direct read.
// ---------------------------------------------------------------------------

describe('the fit and docs sweeps actually come up hourly', () => {
  it('a brand-new store defaults to 60 minutes', () => {
    // The constant in fitAutoScore.ts is unreachable in production: every
    // store has this key, so the settings default and the normaliser are
    // what decide the cadence. Both had to move, not just the constant.
    expect(getSettings().fit_autoscore_interval_minutes).toBe(60)
  })

  it('scheduleNextFitAutoScore() arms a timer under an hour on a real store', () => {
    scheduleNextFitAutoScore()
    const state = getFitAutoScoreState()
    expect(state.intervalMinutes).toBe(60)
    expect(state.nextRunAt!).toBeGreaterThan(HOUR_MS - 2000)
    expect(state.nextRunAt!).toBeLessThanOrEqual(HOUR_MS)
  })

  it('scheduleNextDocsAutoQueue() arms a timer under an hour on a real store', () => {
    scheduleNextDocsAutoQueue()
    const state = getDocsAutoQueueState()
    expect(state.intervalMinutes).toBe(60)
    expect(state.nextRunAt!).toBeGreaterThan(HOUR_MS - 2000)
    expect(state.nextRunAt!).toBeLessThanOrEqual(HOUR_MS)
  })

  it('both live timers are under an hour', () => {
    scheduleNextFitAutoScore()
    scheduleNextDocsAutoQueue()
    // Real timers, so the reading is a hair under a full interval rather
    // than exactly one: `<=`, not `<`.
    expect(getFitAutoScoreState().nextRunAt!).toBeLessThanOrEqual(HOUR_MS)
    expect(getDocsAutoQueueState().nextRunAt!).toBeLessThanOrEqual(HOUR_MS)
    expect(getFitAutoScoreState().nextRunAt!).toBeGreaterThan(HOUR_MS - 2000)
    expect(getDocsAutoQueueState().nextRunAt!).toBeGreaterThan(HOUR_MS - 2000)
  })

  it('normalises a store missing the setting to 60, not the old 240', () => {
    updateSettings({ fit_autoscore_interval_minutes: 0 })
    reloadStore()
    expect(getSettings().fit_autoscore_interval_minutes).toBe(60)
  })

  it('an hourly tick cannot outrun the revive cooldown: one revive per 4h window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })

    // Tick 1: the CV row is revived, the still-missing CL is added.
    vi.advanceTimersByTime(HOUR_MS)
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(row(job.id, 'generate_cv')!.autoRevives).toBe(1)
    // The processor claims it and the LLM call fails.
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9 })

    // Ticks 2-4: refused by the cooldown, so the budget does not move.
    for (let h = 2; h <= 4; h++) {
      vi.advanceTimersByTime(HOUR_MS)
      expect(runDocsAutoQueueBacklog()).toBe(0)
      expect(row(job.id, 'generate_cv')!.autoRevives).toBe(1)
      updateAIQueueItem(r.id, { status: 'failed', attempts: 9 })
    }

    // Tick 5: the cooldown has elapsed, so the second revive.
    vi.advanceTimersByTime(HOUR_MS)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(row(job.id, 'generate_cv')!.autoRevives).toBe(2)
  })

  it('48 hourly ticks cannot spend more than AUTO_REVIVE_MAX revivals', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })

    let revivals = 0
    for (let h = 0; h < 48; h++) {
      vi.advanceTimersByTime(HOUR_MS)
      const before = row(job.id, 'generate_cv')!.status
      runDocsAutoQueueBacklog()
      const after = row(job.id, 'generate_cv')!
      if (before !== 'pending' && after.status === 'pending') revivals++
      if (after.status === 'pending') {
        // The processor claims it, the call fails, the catch rewrites the
        // terminal state without moving the budget.
        updateAIQueueItem(r.id, { status: 'failed', attempts: 9, nextRetryAt: Date.now() })
      }
    }
    // A 4h cooldown over 48 hourly ticks would allow 12 wake-ups; the
    // lifetime budget is what caps it at 3.
    expect(revivals).toBeLessThanOrEqual(AUTO_REVIVE_MAX)
  })
})

// ---------------------------------------------------------------------------
// THE USER'S EXPLICIT REQUIREMENT — the base CV is not a generated CV.
// ---------------------------------------------------------------------------

describe('the base CV never satisfies the sweep or the status rule', () => {
  it('re-queues BOTH units for a job whose only cv document is the master CV', () => {
    const job = eligibleJob()
    createDocument('cv', 'Base CV', 'MASTER', undefined, true)
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a base CV that carries the job id still does not count', () => {
    const job = eligibleJob()
    createDocument('cv', 'Base CV', 'MASTER', job.id, true)
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })

  it('a base cover letter does not count either', () => {
    const job = eligibleJob()
    createDocument('cv', 'Tailored', 'x', job.id)
    createDocument('cover_letter', 'Base CL', 'MASTER', job.id, true)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(row(job.id, 'generate_cover_letter')).toBeDefined()
  })

  it('the status path: a job whose only cv is the master CV stays sourced', () => {
    const job = eligibleJob()
    createDocument('cv', 'Base CV', 'MASTER', job.id, true)
    expect(recomputeJobStatusFromDocs(job.id)).toBe('sourced')
    expect(getJob(job.id)!.status).toBe('sourced')
  })

  it('the status path: a base CV plus a generated cover letter stays sourced', () => {
    const job = eligibleJob()
    createDocument('cv', 'Base CV', 'MASTER', job.id, true)
    createDocument('cover_letter', 'Tailored CL', 'x', job.id)
    expect(recomputeJobStatusFromDocs(job.id)).toBe('sourced')
  })

  it('the status path: a genuinely generated pair still reaches reviewing', () => {
    // The other half, so the is_base filter cannot be "fixed" by
    // excluding too much: a job with real documents must still progress.
    const job = eligibleJob()
    createDocument('cv', 'Tailored CV', 'x', job.id)
    createDocument('cover_letter', 'Tailored CL', 'x', job.id)
    expect(recomputeJobStatusFromDocs(job.id)).toBe('reviewing')
  })

  it('each of the four document combinations queues exactly the missing unit', () => {
    const both = eligibleJob()
    createDocument('cv', 'a', 'x', both.id)
    createDocument('cover_letter', 'b', 'x', both.id)
    const onlyCv = eligibleJob()
    createDocument('cv', 'a', 'x', onlyCv.id)
    const onlyCl = eligibleJob()
    createDocument('cover_letter', 'b', 'x', onlyCl.id)
    const neither = eligibleJob()

    expect(runDocsAutoQueueBacklog()).toBe(4)
    expect(typesFor(both.id)).toEqual([])
    expect(typesFor(onlyCv.id)).toEqual(['generate_cover_letter'])
    expect(typesFor(onlyCl.id)).toEqual(['generate_cv'])
    expect(typesFor(neither.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })
})

// ---------------------------------------------------------------------------
// THE COST GATE — the sweep must cost what the fit-landing trigger costs.
// ---------------------------------------------------------------------------

describe('the sweep refuses jobs the fit-landing trigger would refuse', () => {
  it('a job far below auto_doc_min_fit gets nothing', () => {
    const job = eligibleJob()
    updateJob(job.id, { score: 0.05 })
    expect(getSettings().auto_doc_min_fit).toBe(40)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('a job with no fit score at all gets nothing', () => {
    const job = eligibleJob()
    updateJob(job.id, { score: null })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('a shippable job (every document reviewed at or above the pass bar) gets nothing', () => {
    // Both documents exist and both passed review, so the trigger's own
    // "already shipped-ready" rule applies: regenerating would burn calls
    // and could make a good CV worse.
    const job = eligibleJob()
    const cv = createDocument('cv', 'CV', 'x', job.id)
    const cl = createDocument('cover_letter', 'CL', 'x', job.id)
    updateDocumentVerification(cv.id, 88, 'Good.')
    updateDocumentVerification(cl.id, 92, 'Good.')
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('a job with no base CV configured gets nothing', () => {
    eligibleJob()
    updateSettings({ base_cv: '' })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('the startup path has the same holes closed', () => {
    const job = eligibleJob()
    updateJob(job.id, { score: 0.01 })
    expect(enqueueDocsBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('MAGNITUDE: 200 tracked jobs that are not eligible queue no work at all', () => {
    // The number that matters. Before the gate this was 400 tailoring
    // calls on the next launch — for jobs with no score, which the scan
    // paths persist in bulk.
    updateSettings({ base_cv: '' })
    for (let i = 0; i < 200; i++) newJob()
    expect(enqueueDocsBacklog()).toBe(0)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('raising auto_doc_min_fit above the score refuses the job on BOTH paths', () => {
    // Reads the same setting the trigger reads, rather than a copy of the
    // conditions taken once and frozen. A fresh job each time, so nothing
    // here can be satisfied by an existing row's revive budget.
    const low = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(low.id)).toEqual(['generate_cover_letter', 'generate_cv'])

    updateSettings({ auto_doc_min_fit: 90 })
    const startup = eligibleJob()
    const periodic = eligibleJob()
    expect(enqueueDocsBacklog()).toBe(0)
    expect(typesFor(startup.id)).toEqual([])
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(typesFor(periodic.id)).toEqual([])
  })

  it('lowering it again admits the identical job', () => {
    // The gate tracks the setting in both directions, which a hardcoded
    // copy of the threshold cannot do.
    const job = eligibleJob()
    updateSettings({ auto_doc_min_fit: 95 })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    updateSettings({ auto_doc_min_fit: 40 })
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })
})

// ---------------------------------------------------------------------------
// ONE ROW PER WORK ITEM — a live tailor_job_docs covers both units.
// ---------------------------------------------------------------------------

describe('a live tailor_job_docs row means both units are already in flight', () => {
  it('the periodic sweep adds nothing beside a pending tailor row', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    // Without this, the sweep sees a job with no generated documents and
    // queues both units: three rows for one job's two documents, all of
    // which spend LLM calls, producing duplicate CVs and cover letters.
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(1)
  })

  it('a PROCESSING tailor row counts as in flight too', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'processing' })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(1)
  })

  it('the startup path honours it as well', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    expect(enqueueDocsBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(1)
  })

  it('a FAILED tailor row does NOT count: the work really has not happened', () => {
    // Otherwise the sweep could never recover from a tailoring failure,
    // which is one of the things it exists to do.
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'tailor_job_docs', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9 })
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv', 'tailor_job_docs'])
  })

  it("another job's tailor row does not cover this one", () => {
    const covered = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: covered.id })
    const uncovered = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(uncovered.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })
})

// ---------------------------------------------------------------------------
// NO DOUBLE-QUEUEING across repeated sweeps.
// ---------------------------------------------------------------------------

describe('no duplicate rows and no attempt resets across successive sweeps', () => {
  it('a live pending generate_cv row is not duplicated, on either path', () => {
    const periodic = eligibleJob()
    const r1 = addAIQueueItem({ type: 'generate_cv', jobId: periodic.id })
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(getAIQueue().filter((x) => x.jobId === periodic.id && x.type === 'generate_cv')).toEqual([r1])
    expect(typesFor(periodic.id)).toEqual(['generate_cover_letter', 'generate_cv'])

    const startup = eligibleJob()
    const r2 = addAIQueueItem({ type: 'generate_cv', jobId: startup.id })
    expect(enqueueDocsBacklog()).toBe(1)
    expect(getAIQueue().filter((x) => x.jobId === startup.id && x.type === 'generate_cv')).toEqual([r2])
    expect(typesFor(startup.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a live processing generate_cv row is not duplicated', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'processing' })
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a live processing generate_cover_letter row is not duplicated either', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'processing' })
    expect(enqueueDocsBacklog()).toBe(1)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('ANY live duplicate suppresses the sweep, not just the first row', () => {
    const job = eligibleJob()
    const a = addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    updateAIQueueItem(a.id, { status: 'failed', attempts: 5 })
    const b = addAIQueueItem({ type: 'generate_cover_letter', jobId: job.id })
    updateAIQueueItem(b.id, { status: 'processing', attempts: 1 })
    // Only the CV unit is free.
    expect(runDocsAutoQueueBacklog()).toBe(1)
  })

  it('does not mistake an auto-regeneration row for the missing first generation', () => {
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: 77 })
    expect(runDocsAutoQueueBacklog()).toBe(2)
  })

  it('two sweeps in a row leave no duplicates and do not reset the budget', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 4, autoRevives: 1, nextRetryAt: 0 })

    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(row(job.id, 'generate_cv')!.status).toBe('pending')
    expect(row(job.id, 'generate_cv')!.autoRevives).toBe(2)

    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue().filter((x) => x.jobId === job.id)).toHaveLength(2)
    expect(row(job.id, 'generate_cv')!.autoRevives).toBe(2)
  })

  it('startup then periodic produces no duplicates', () => {
    const job = eligibleJob()
    enqueueDocsBacklog()
    expect(getAIQueue()).toHaveLength(2)
    runDocsAutoQueueBacklog()
    expect(getAIQueue()).toHaveLength(2)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('the timer is not double-registered: one armed timer per schedule call', () => {
    // Three schedule calls leaving three live timers would run the sweep
    // three times per interval — idempotent in row count, but three full
    // walks of JOBS + DOCUMENTS + QUEUE per hour.
    vi.useFakeTimers()
    const job = eligibleJob()
    scheduleNextDocsAutoQueue()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    scheduleNextDocsAutoQueue()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    scheduleNextDocsAutoQueue()
    expect(vi.getTimerCount()).toBe(1)
    // One fire: both units, and only one set of them. The sweep is
    // idempotent per tick, so a leaked timer would cost CPU here rather
    // than duplicate work — the timer count is the real assertion.
    vi.advanceTimersByTime(HOUR_MS)
    expect(typesFor(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('the same for the fit sweep timer', () => {
    vi.useFakeTimers()
    scheduleNextFitAutoScore()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    scheduleNextFitAutoScore()
    expect(vi.getTimerCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// THE REVIVE BUDGET — both paths, and the startup path repeatedly.
// ---------------------------------------------------------------------------

describe('both paths respect the bounded revive budget', () => {
  it('the periodic sweep refuses a row whose budget is spent', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    terminalFailure(r.id)
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(row(job.id, 'generate_cv')!.status).toBe('failed')
  })

  it('the startup path refuses the same row', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    terminalFailure(r.id)
    expect(enqueueDocsBacklog()).toBe(1)
    expect(row(job.id, 'generate_cv')!.status).toBe('failed')
  })

  it('the startup path does not drag a row forward through its cooldown', () => {
    // The bug: enqueue()'s revivePatch writes nextRetryAt: Date.now(), so
    // the hourly cadence became an hourly retry of rows the sweep had
    // deliberately parked on the 4h revive cooldown.
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, {
      status: 'failed',
      attempts: 9,
      autoRevives: 1,
      nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS
    })
    // The periodic sweep refuses it: the cooldown has not elapsed.
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(row(job.id, 'generate_cv')!.status).toBe('failed')
    // And so must the startup path.
    enqueueDocsBacklog()
    expect(row(job.id, 'generate_cv')!.status).toBe('failed')
    expect(row(job.id, 'generate_cv')!.nextRetryAt!).toBeGreaterThan(Date.now())
  })

  it('BOUNDED: repeated startups and scans never resurrect a spent row', () => {
    // The infinite-requeue proof. main.ts calls enqueueDocsBacklog() at
    // startup and again after EVERY scan; if that path revived on every
    // call, each pass would burn one tailoring call for a row the
    // processor had already given up on, forever, with the budget frozen.
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    terminalFailure(r.id)

    let wastedGenerations = 0
    for (let scan = 0; scan < 10; scan++) {
      enqueueDocsBacklog()
      const live = row(job.id, 'generate_cv')!.status === 'pending'
      if (live) {
        wastedGenerations++
        // The processor claims it, the LLM call fails, and the catch
        // writes the terminal state again.
        terminalFailure(r.id)
      }
    }
    expect(wastedGenerations).toBe(0)
  })

  it('a startup and a periodic pass together cannot exceed AUTO_REVIVE_MAX', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })

    let revivals = 0
    for (let cycle = 0; cycle < 8; cycle++) {
      const before = row(job.id, 'generate_cv')!.autoRevives ?? 0
      enqueueDocsBacklog()
      runDocsAutoQueueBacklog()
      const after = row(job.id, 'generate_cv')!.autoRevives ?? 0
      if (after > before) revivals++
      if (row(job.id, 'generate_cv')!.status === 'pending') {
        updateAIQueueItem(r.id, { status: 'failed', attempts: 9, nextRetryAt: Date.now() })
      }
      vi.setSystemTime(Date.now() + AUTO_REVIVE_COOLDOWN_MS)
    }
    expect(revivals).toBeLessThanOrEqual(AUTO_REVIVE_MAX)
    expect(row(job.id, 'generate_cv')!.autoRevives).toBeLessThanOrEqual(AUTO_REVIVE_MAX)
  })

  it('a revived row is parked on the shared cooldown, not run now', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })
    runDocsAutoQueueBacklog()
    expect(row(job.id, 'generate_cv')!.nextRetryAt!).toBeGreaterThanOrEqual(Date.now() + AUTO_REVIVE_COOLDOWN_MS - 50)
  })

  it('a legacy row with no autoRevives counter counts as zero and is charged one', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    updateAIQueueItem(r.id, { status: 'failed', attempts: 9, autoRevives: undefined, nextRetryAt: 0 })
    runDocsAutoQueueBacklog()
    expect(row(job.id, 'generate_cv')!.autoRevives).toBe(1)
    void r
  })
})

// ---------------------------------------------------------------------------
// THE RETURN CONTRACT — the count follows work actually done.
// ---------------------------------------------------------------------------

describe('the return value counts work actually done', () => {
  it('counts the revive as work, and adds the missing unit', () => {
    const job = eligibleJob()
    const r = addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    terminalFailure(r.id)
    // The CV is refused (budget spent) and only the CL is queued.
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(getAIQueue().filter((x) => x.jobId === job.id)).toHaveLength(2)
  })

  it('returns 0 when there is nothing to do', () => {
    const job = eligibleJob()
    createDocument('cv', 'a', 'x', job.id)
    createDocument('cover_letter', 'b', 'x', job.id)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)
  })

  it('returns 0 rather than counting an ineligible job', () => {
    updateSettings({ base_cv: '' })
    eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// THE auto_queue_* CONTRACT — read tolerantly, default ON.
// ---------------------------------------------------------------------------

describe('auto_queue_* reads', () => {
  it('auto_queue_cv:false suppresses CV work on BOTH paths', () => {
    updateSettings({ auto_queue_cv: false } as never)
    const periodic = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(periodic.id)).toEqual(['generate_cover_letter'])

    const startup = eligibleJob()
    expect(enqueueDocsBacklog()).toBe(1)
    expect(typesFor(startup.id)).toEqual(['generate_cover_letter'])
  })

  it('auto_queue_cover_letter:false suppresses cover-letter work on BOTH paths', () => {
    updateSettings({ auto_queue_cover_letter: false } as never)
    const periodic = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(1)
    expect(typesFor(periodic.id)).toEqual(['generate_cv'])

    const startup = eligibleJob()
    expect(enqueueDocsBacklog()).toBe(1)
    expect(typesFor(startup.id)).toEqual(['generate_cv'])
  })

  it('both false suppresses the sweep entirely', () => {
    eligibleJob()
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: false } as never)
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('an ABSENT key resolves to ON, on both paths', () => {
    // A store written before these keys existed must not have
    // auto-queuing silently disabled. The read is `!== false`, so a
    // missing key and an undefined one both resolve to true — and the
    // startup path gets its own job so the assertion cannot be satisfied
    // by rows the periodic sweep already created.
    const stored = (getSettings() as Record<string, unknown>).auto_queue_cv
    expect(stored === undefined || stored === true).toBe(true)
    expect(autoQueueFlags().auto_queue_cv).toBe(true)

    const periodic = eligibleJob()
    expect(runDocsAutoQueueBacklog()).toBe(2)
    expect(typesFor(periodic.id)).toEqual(['generate_cover_letter', 'generate_cv'])

    const startup = eligibleJob()
    expect(enqueueDocsBacklog()).toBe(2)
    expect(typesFor(startup.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('a non-boolean value also resolves to ON (fail open)', () => {
    // A hand-edited or partially-written store must not be able to
    // disable the feature with something that is not `false`.
    expect(autoQueueFlags({ ...getSettings(), auto_queue_cv: 'false' } as never).auto_queue_cv).toBe(true)
    expect(autoQueueFlags({ ...getSettings(), auto_queue_cv: 0 } as never).auto_queue_cv).toBe(true)
    expect(autoQueueFlags({ ...getSettings(), auto_queue_cover_letter: null } as never)
      .auto_queue_cover_letter).toBe(true)
  })

  it('reads all five keys independently', () => {
    const flags = autoQueueFlags({
      ...getSettings(),
      auto_queue_fit: false,
      auto_queue_cv: false,
      auto_queue_cover_letter: false,
      auto_queue_verify_cv: false,
      auto_queue_verify_cover_letter: false
    } as never)
    expect(flags).toEqual({
      auto_queue_fit: false,
      auto_queue_cv: false,
      auto_queue_cover_letter: false,
      auto_queue_verify_cv: false,
      auto_queue_verify_cover_letter: false
    })
  })
})


// ---------------------------------------------------------------------------
// THE GATE COVERS THE REVIEW ROWS TOO.
//
// The user asked for one thing: the same threshold for auto-queuing
// document generation AND the subsequent review. The sweep queues no
// `verify` rows of its own — a `generate_*` row is chained to its review
// by the processor (aiQueue.ts), so the review is downstream of the
// generation. That is the argument; these tests are the proof, and they
// run the REAL processor against the REAL store with only the LLM
// transport stubbed, because the claim spans modules: a gate that only
// held inside docsAutoQueue.ts would prove nothing about the review rows
// the processor creates after the sweep has handed off.
// ---------------------------------------------------------------------------

describe('the gate covers the review rows the processor chains on', () => {
  // A minimal LLM transport: generation returns content, review returns a
  // score. Nothing here asserts on the CONTENT — the point is which rows
  // exist afterwards and how many provider calls were made.
  function stubTransport() {
    const calls = { generations: 0, reviews: 0, reviewed: [] as string[], reviewedDocumentIds: [] as number[] }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[] }
      const system = body.messages[0].content
      const user = body.messages[1].content
      const reply = (content: string) =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
      if (system.includes('strict career-document reviewer')) {
        calls.reviews++
        calls.reviewed.push(user)
        return reply(JSON.stringify({ score: 95, passed: true, feedback: 'Good.' }))
      }
      calls.generations++
      if (system.includes('Tailor the candidate')) {
        return reply([
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
        ].join('\n'))
      }
      return reply(`Dear Hiring Manager,\n\n${user.slice(0, 20)}\n\nBest regards,\nAlex`)
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

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('an eligible job\'s generation DOES chain a review', async () => {
    // The positive control. Without it, "no review rows appeared" below
    // could be true merely because the chain never works at all.
    const { addApiModel } = await import('./database')
    const { resetModelHealth } = await import('./ai')
    addApiModel({ name: 'test-model', base_url: 'https://llm.test/v1', api_key: 'k', model: 'test-model', enabled: true })
    resetModelHealth()

    const calls = stubTransport()
    // The master CV as a document ROW, present for the whole run — so the
    // sweep has to see it (and refuse to count it) and the reviewer has to
    // not.
    createDocument('cv', 'Base CV', BASE_DOC_MARKER, undefined, true)
    const job = eligibleJob()
    // The base CV does NOT satisfy the sweep: both units still get queued.
    expect(runDocsAutoQueueBacklog()).toBe(2)

    await drainQueue()
    await drainQueue()

    expect(calls.generations).toBeGreaterThan(0)
    expect(calls.reviews).toBeGreaterThan(0)
    // The reviews that ran were of documents generated FOR THIS JOB, not
    // of the master CV: the is_base exclusion has to hold on the review
    // path too, and that is the path these calls came through. The base
    // row carries a marker unique to its own content, so it can only
    // reach a prompt if that row was handed to the reviewer.
    expect(calls.reviewed.length).toBeGreaterThan(0)
    expect(calls.reviewed.some((r) => r.includes(BASE_DOC_MARKER))).toBe(false)
    // Every reviewed document row belongs to this job and is generated.
    for (const d of listJobDocuments(job.id)) expect(d.is_base).not.toBe(1)
    expect(job.score).toBe(0.8)
  })

  it('a job the gate refuses produces NO generation and NO review', async () => {
    // The whole point. Below the threshold, below `auto_doc_min_fit`: the
    // sweep queues nothing, so the processor has nothing to chain, so no
    // review row is created either. One threshold gates both halves of
    // "generate and then review".
    const { addApiModel } = await import('./database')
    const { resetModelHealth } = await import('./ai')
    addApiModel({ name: 'test-model', base_url: 'https://llm.test/v1', api_key: 'k', model: 'test-model', enabled: true })
    resetModelHealth()

    const calls = stubTransport()
    const job = eligibleJob()
    updateJob(job.id, { score: 0.05 })
    expect(runDocsAutoQueueBacklog()).toBe(0)
    expect(enqueueDocsBacklog()).toBe(0)

    await drainQueue()

    expect(calls.generations).toBe(0)
    expect(calls.reviews).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })

  it('a shippable job produces no regeneration either', async () => {
    // The gate's fourth condition has to reach the review side too: a job
    // whose documents all pass review must not be rebuilt, which is the
    // case where the regen loop would otherwise re-enter.
    const { addApiModel } = await import('./database')
    const { resetModelHealth } = await import('./ai')
    addApiModel({ name: 'test-model', base_url: 'https://llm.test/v1', api_key: 'k', model: 'test-model', enabled: true })
    resetModelHealth()

    const calls = stubTransport()
    const job = eligibleJob()
    const cv = createDocument('cv', 'CV', 'ORIGINAL CV', job.id)
    const cl = createDocument('cover_letter', 'CL', 'ORIGINAL CL', job.id)
    updateDocumentVerification(cv.id, 92, 'Good.')
    updateDocumentVerification(cl.id, 95, 'Good.')

    expect(runDocsAutoQueueBacklog()).toBe(0)
    await drainQueue()

    expect(calls.generations).toBe(0)
    expect(getAIQueue()).toHaveLength(0)
  })
})
