/**
 * What a rate-limited provider costs the queue, measured in provider
 * requests rather than in the queue's own counters.
 *
 * The incident this pins down (2026-10-02, verified against the logs):
 * FlowJob ran 20 hours with 265 queued tasks and completed none. Every
 * provider call came back 429, so `callAI` spent most of that time
 * throwing before it made a request — "every model is cooling down" —
 * and `processItem`'s catch block could not tell that from a real
 * failure, because both were `RateLimitError`. It charged each one an
 * attempt. 4,122 of 4,143 logged failures were that throw; rows burned
 * all 10 attempts while the provider was refusing, and had nothing left
 * to retry with when it came back.
 *
 * So the instrument here is `fetch`. `attempts` is a number the queue
 * increments about itself, and a bound asserted on it cannot fail when
 * the real spend doubles — which is exactly what a reviewer proved about
 * the previous spend bound (see spendBound.test.ts). Every case below
 * counts requests that actually left the app, and asserts on
 * `attempts` only to show what the queue did with them.
 *
 * A real store and the real modules throughout: a mocked store cannot
 * see a retry budget being spent, and a mocked `./ai` would replace the
 * very function whose behaviour is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Own userData directory: vitest runs test FILES in parallel against
// shared store paths, so sharing one would have this suite wiping
// another suite's rows mid-run. Hoisted because the electron mock factory
// runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-qblocked-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

/**
 * Every line the queue writes to `ai.log`.
 *
 * Log volume is part of what this change is for: the outage produced
 * 4,143 lines, and the fix has to keep a long outage quiet rather than
 * replacing one flood with another. A blocked pass must therefore say so
 * ONCE, however many rows it parked — which is only checkable by
 * counting what was written.
 */
const logLines = vi.hoisted(() => ({ warns: [] as string[], errors: [] as string[] }))

vi.mock('./logger', () => {
  const record = (bucket: string[]) => (...args: unknown[]) => {
    bucket.push(args.map((a) => String(a)).join(' '))
  }
  // Only `log.ai` is recorded, and only its two severities: those are the
  // lines the queue's own bookkeeping writes, and the claim under test is
  // that a blocked pass logs ONE warning and no errors at all.
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const silentCategory = { info: () => undefined, warn: () => undefined, error: () => undefined }
  return {
    log: {
      ai: { info: () => undefined, warn: record(logLines.warns), error: record(logLines.errors) },
      fit: silentCategory,
      tailor: silentCategory
    },
    createLogger: () => silent,
    LogLevel: undefined
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => `${STORE_DIR}/app`,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  // `getAllWindows` is not optional: the fit lane emits score updates to
  // every open window, and a mock without it turns the emit into a
  // TypeError that would be reported as a scorer failure.
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return [] }
  },
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
  removeAIQueueItem,
  saveApiModels,
  updateAIQueueItem,
  updateSettings
} from './database'
import { ProviderCooldownError, providerAvailability, resetModelHealth } from './ai'
import { PROVIDER_REPROBE_CAP_MS, aiQueueBlockedState, processQueue } from './aiQueue'
import { scoreOneJobInBackground } from './fitScorer'
import type { AIQueueItem } from './types'

const MODEL_COUNT = 3
/** Tighter than the 1ms resolution of the assertions that need it. */
const CLOCK_SLOP_MS = 250

let fetchCalls = 0

/**
 * Every request the app makes. The counters are the point of this file,
 * so they are not wrapped in a `vi.fn()` that a test could assert
 * nothing about.
 */
function stubProvider(status: number, body = 'provider says no'): void {
  fetchCalls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++
    return { ok: false, status, headers: new Map<string, string>(), text: async () => body }
  }))
}

function emptyQueue(): void {
  for (const row of getAIQueue()) removeAIQueueItem(row.id)
}

let seq = 0

/** A job with a CV to review, and the `verify` row that reviews it. */
function queueVerify(): { jobId: number; documentId: number; rowId: number } {
  // Distinct jobs each call: `createJob` refuses a duplicate
  // company+title+location, and several cases need two rows to be
  // different rows rather than one row twice.
  seq++
  const { job } = createJob({ title: `Engineer ${seq}`, company: `Acme ${seq}` })
  const doc = createDocument('cv', 'CV', 'content', job.id)
  const row = addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id } as never)
  return { jobId: job.id, documentId: doc.id, rowId: row.id }
}

function queueScoreFit(jobId: number): number {
  return addAIQueueItem({ type: 'score_fit', jobId } as never).id
}

/** One real rotation, so the whole pool is in cooldown afterwards. */
async function callAIForHeat(): Promise<void> {
  const { callAI } = await import('./ai')
  await expect(callAI('sys', 'user')).rejects.toThrow()
}

function row(id: number): AIQueueItem {
  const found = getAIQueue().find((q) => q.id === id)
  if (!found) throw new Error(`no queue row ${id}`)
  return found
}

/** Make a row due now, standing in for the passage of time. */
function makeDue(id: number): void {
  updateAIQueueItem(id, { nextRetryAt: 0 })
}

beforeEach(() => {
  fetchCalls = 0
  logLines.warns.length = 0
  logLines.errors.length = 0
  resetModelHealth()
  emptyQueue()
  saveApiModels([])
  for (let i = 0; i < MODEL_COUNT; i++) {
    addApiModel({
      name: `m${i}`,
      base_url: 'https://example.invalid',
      api_key: 'k',
      model: `model-${i}`,
      enabled: true
    } as never)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetModelHealth()
  emptyQueue()
  saveApiModels([])
})

describe('a genuine rate limit costs the queue an attempt', () => {
  it('spends one attempt and one request per model on a 429 rotation', async () => {
    stubProvider(429)

    const { rowId } = queueVerify()
    await processQueue()

    expect(fetchCalls).toBe(MODEL_COUNT)
    expect(row(rowId).attempts).toBe(1)
  })

  it('keeps spending one attempt per rotation, so the budget still means something', async () => {
    stubProvider(429)

    const { rowId } = queueVerify()
    for (let pass = 1; pass <= 3; pass++) {
      // A fresh rotation every pass. Without the reset the second pass
      // would find every model cooling down and this test would prove
      // nothing about rate limits.
      resetModelHealth()
      makeDue(rowId)
      await processQueue()
      expect(row(rowId).attempts).toBe(pass)
      expect(fetchCalls).toBe(MODEL_COUNT * pass)
    }
  })
})

describe('a provider block costs the queue nothing', () => {
  it('spends no attempt and makes no request across N consecutive blocks', async () => {
    // Two rows in one pass: the first walks the rotation for real and
    // puts every model into cooldown, so the second is blocked. That
    // second row is the subject — it never reaches the provider at all.
    stubProvider(429)
    const first = queueVerify()
    const second = queueVerify()

    await processQueue()

    // Only the first row spent anything, and only on real requests.
    expect(fetchCalls).toBe(MODEL_COUNT)
    expect(row(first.rowId).attempts).toBe(1)
    expect(row(second.rowId).attempts).toBe(0)

    // N more passes, each with the row made due, as a queue that keeps
    // ticking through the outage would be. Not one request leaves the app
    // and not one attempt is spent.
    const callsAfterFirstPass = fetchCalls
    for (let pass = 0; pass < 5; pass++) {
      makeDue(second.rowId)
      await processQueue()
      expect(fetchCalls).toBe(callsAfterFirstPass)
      expect(row(second.rowId).attempts).toBe(0)
    }

    // And the row is still queued work, not a failure: it survived the
    // whole outage with its budget and its place in the queue intact.
    expect(row(second.rowId).status).toBe('pending')
    expect(row(first.rowId).attempts).toBe(1)
  })

  it('charges a real attempt for a fit row on a real rotation, and nothing for a block', async () => {
    stubProvider(429)
    updateSettings({ base_cv: 'A CV with some words in it.' })
    seq++
    const { job } = createJob({ title: `Engineer ${seq}`, company: `Acme ${seq}` })

    // Both rows in one pass. `score_fit` is tier 0, so it walks the
    // rotation FIRST and puts every model into cooldown; the `verify` row
    // behind it then cannot make a request at all. Same pass, same
    // outage, two different prices.
    const fitRowId = queueScoreFit(job.id)
    const verifyRowId = queueVerify().rowId

    await processQueue()

    expect(fetchCalls).toBe(MODEL_COUNT)
    // The row that really asked, really paid.
    expect(row(fitRowId).attempts).toBe(1)
    expect(row(fitRowId).lastError).toMatch(/rate limited \(429\)/)
    // The row that never could.
    expect(row(verifyRowId).attempts).toBe(0)

    // Five more passes with that row due: no requests, no attempts.
    const callsAfterFirstPass = fetchCalls
    for (let pass = 0; pass < 5; pass++) {
      makeDue(verifyRowId)
      await processQueue()
      expect(fetchCalls).toBe(callsAfterFirstPass)
      expect(row(verifyRowId).attempts).toBe(0)
    }
  })

  it('keeps a blocked fit score honest: it records why, and never invents a score', async () => {
    // The same bug reached the fit lane through a string instead of a
    // type. `scoreJobFit` caught every callAI error and returned a
    // heuristic fallback, so the block reached `processItem` as
    // `new Error(fit_last_error)` — not a RateLimitError at all — and was
    // charged one of the five score_fit attempts. The fix is to let the
    // typed error through while still recording the reason on the job, so
    // the manual Recompute path keeps explaining itself.
    stubProvider(429)
    updateSettings({ base_cv: 'A CV with some words in it.' })
    seq++
    const { job } = createJob({ title: `Engineer ${seq}`, company: `Acme ${seq}` })

    // One real rotation, so the pool is in cooldown.
    await callAIForHeat()
    expect(fetchCalls).toBe(MODEL_COUNT)

    await expect(scoreOneJobInBackground(job.id)).rejects.toBeInstanceOf(ProviderCooldownError)
    // No request was made by that second call...
    expect(fetchCalls).toBe(MODEL_COUNT)
    // ...no score was invented for it...
    expect(getJob(job.id)?.score).toBeNull()
    // ...and the job row still says why, in the user's own words.
    expect(getJob(job.id)?.fit_last_error).toMatch(/cooling down/)
  })
})

describe('the queue waits on the provider clock', () => {
  it('never wakes a parked row before the provider said it would be free', async () => {
    stubProvider(429)
    const first = queueVerify()
    const second = queueVerify()
    await processQueue()

    const parked = row(second.rowId)
    const now = Date.now()
    const availability = providerAvailability(now)

    expect(availability.blocked).toBe(true)
    expect(availability.nextAvailableAt).not.toBeNull()
    // The whole point: not the row's own 30s ladder, which is what
    // re-probed a provider that had just refused.
    expect(parked.nextRetryAt).toBeGreaterThanOrEqual(availability.nextAvailableAt! - CLOCK_SLOP_MS)
    expect(row(first.rowId).nextRetryAt).toBeGreaterThan(parked.nextRetryAt)
  })

  it('caps the wait so a one-hour circuit break does not park the queue for an hour', async () => {
    // 402 opens the circuit breaker for CIRCUIT_BREAKER_MS (1h). The
    // cap is what stops that from becoming an hour of silence: the queue
    // looks again every 10 minutes, for free, because a blocked pass
    // makes no requests at all.
    stubProvider(402, 'payment required')
    updateSettings({ base_cv: 'A CV with some words in it.' })
    seq++
    const { job } = createJob({ title: `Engineer ${seq}`, company: `Acme ${seq}` })
    const rowId = queueScoreFit(job.id)

    // First pass is a genuine failure (a 402 rotation is not a rate
    // limit, so it goes down the ordinary retry path); the second one
    // finds the whole pool circuit-broken and parks on the capped clock.
    await processQueue()
    expect(row(rowId).attempts).toBe(1)
    makeDue(rowId)
    await processQueue()

    const parked = row(rowId)
    expect(parked.blockedSince).toBeGreaterThan(0)
    const waitMs = parked.nextRetryAt - Date.now()
    expect(waitMs).toBeGreaterThan(0)
    expect(waitMs).toBeLessThanOrEqual(PROVIDER_REPROBE_CAP_MS + CLOCK_SLOP_MS)
    // Six times sooner than the hour the provider asked for, which is the
    // cap's whole purpose. Stated against 20 minutes rather than against
    // the cap so this asserts the ORDER OF MAGNITUDE and not a boundary:
    // the wait is measured after the write, so it is always a few
    // milliseconds under the cap.
    expect(waitMs).toBeLessThan(20 * 60 * 1000)
    expect(fetchCalls).toBe(MODEL_COUNT)
  })

  it('remembers the block: each further block waits longer than the last', async () => {
    // A health map that keeps pushing its own clock forward must not hold
    // a row on the shortest possible wake-up forever, and the escalation
    // is what bounds the re-probing. It has to be bounded from above too.
    stubProvider(429)
    const first = queueVerify()
    const second = queueVerify()
    await processQueue()

    const waits: number[] = []
    for (let pass = 0; pass < 5; pass++) {
      makeDue(second.rowId)
      const before = Date.now()
      await processQueue()
      waits.push(row(second.rowId).nextRetryAt - before)
    }

    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1])
    }
    expect(waits[0]).toBeGreaterThan(0)
    for (const wait of waits) {
      expect(wait).toBeLessThanOrEqual(PROVIDER_REPROBE_CAP_MS + CLOCK_SLOP_MS)
    }
    // And it did escalate rather than sit on the floor: five blocks put
    // this row past 30s * 2^4.
    expect(waits[waits.length - 1]).toBeGreaterThan(30000 * 2 ** 3)
    expect(row(first.rowId).attempts).toBe(1)
  })

  it('clears the block memory once the row is handed back to a provider', async () => {
    stubProvider(429)
    const first = queueVerify()
    const second = queueVerify()
    await processQueue()
    makeDue(second.rowId)
    await processQueue()
    expect(row(second.rowId).blockedCount).toBeGreaterThan(1)

    // The provider recovers: a 200 with a reviewable JSON body.
    resetModelHealth()
    fetchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Map<string, string>(),
        json: async () => ({ choices: [{ message: { content: '{"score": 90, "feedback": "good"}' } }] })
      }
    }))
    makeDue(second.rowId)
    await processQueue()

    // The row completed, so there is no row left carrying a block it has
    // already got past.
    expect(getAIQueue().some((q) => q.id === second.rowId)).toBe(false)
    expect(row(first.rowId).blockedSince).toBeUndefined()
  })
})

describe('the app-wide blocked state the Queue panel renders', () => {
  it('reports one blocked state and names the rows parked on it', async () => {
    stubProvider(429)
    const first = queueVerify()
    const second = queueVerify()

    // Before the outage there is nothing to report, even with rows
    // queued — a row that is merely waiting its turn is not blocked.
    expect(aiQueueBlockedState().blocked).toBe(false)

    await processQueue()
    const state = aiQueueBlockedState()
    expect(state.blocked).toBe(true)
    expect(state.providerFreeAt).not.toBeNull()
    expect(state.blockedRowIds).toEqual([second.rowId])
    expect(state.waitingRows).toBe(1)
    // The wake time the queue will actually use is the capped one, and
    // never later than the cap.
    expect(state.retryAt!).toBeLessThanOrEqual(Date.now() + PROVIDER_REPROBE_CAP_MS + CLOCK_SLOP_MS)
    // The row that spent a real attempt on real requests is not counted as
    // waiting on a provider: it is waiting out its own backoff.
    expect(state.blockedRowIds).not.toContain(first.rowId)
  })

  it('reports not-blocked for an empty model pool, which is a settings problem', async () => {
    saveApiModels([])
    resetModelHealth()
    const state = aiQueueBlockedState()
    expect(state.blocked).toBe(false)
    expect(state.blockedRowIds).toEqual([])
    expect(state.providerFreeAt).toBeNull()
  })

  it('says the queue is blocked once per pass, not once per row', async () => {
    // The log is the only signal an app-wide block has for anyone who is
    // not looking at the panel, so it has to exist — and it has to be one
    // line, because the row-by-row version is the flood this replaces.
    stubProvider(429)
    for (let i = 0; i < 4; i++) queueVerify()

    await processQueue()
    // First pass: one row really asked, so there are per-row lines.
    expect(logLines.errors.some((l) => l.includes('failed on attempt'))).toBe(true)

    // The parked rows are not due yet, which is itself the fix working.
    // Make them due to reach the pass that sees a blocked pool.
    logLines.warns.length = 0
    logLines.errors.length = 0
    for (const r of getAIQueue()) makeDue(r.id)
    await processQueue()

    expect(logLines.warns).toHaveLength(1)
    expect(logLines.warns[0]).toMatch(/no AI provider is available/)
    expect(logLines.errors).toEqual([])
  })

  it('reports not-blocked once a model works again', async () => {
    stubProvider(429)
    queueVerify()
    await processQueue()
    expect(aiQueueBlockedState().blocked).toBe(true)

    resetModelHealth()
    expect(aiQueueBlockedState().blocked).toBe(false)
  })
})