/**
 * PRESENCE IS NOT PROVENANCE, AND THE CAP MUST NOT PARK A PERSON'S ROW.
 *
 * The regression this file exists for. `c526332` stopped `processItem` reading
 * a row's `manualQueued` as the spend cap's definition of "a person is
 * asking", and in doing so left `tailor:quickApply` with NO uncapped path at
 * all: that handler's entire body is
 *
 *     enqueue({ type: 'tailor_job_docs', jobId }, { manual: true })
 *     return { queued: true }
 *
 * so its row is not a fallback for a direct call that already failed — it is
 * the ONLY delivery mechanism for the press, and it was processed as
 * automated work. The reviewer reproduced the consequence on a real store:
 * with the cap drained, a row enqueued exactly as Quick Apply enqueues it sat
 * `pending` / `parkedReason: 'provider_cap'` / `manualQueued: true` across
 * **0 outbound requests over 30+ consecutive parked passes and 6.7 hours**.
 *
 * And that was not the only path of that shape. Retry (`retryQueueItem`) is
 * the second, and the three `ipcMain` handlers that queue as a rate-limit
 * fallback are the same shape from the user's side: the window was handed
 * "queued" and left holding a spinner, so the queue is what will answer. All
 * five are pinned here, by driving the REAL handlers and then the REAL
 * processor.
 *
 * The fix is a GRANT, not a flag. `userPresentAt` on the row, armed only by a
 * click, spent by `processItem` in the same write that claims the row. So a
 * gesture buys exactly one request the cap cannot refuse, and the leak bound
 * is a consequence of WHERE the field is cleared rather than a promise about
 * it. THIS FILE IS THE PROOF OF THE BOUND, from both sides:
 *
 *   - every user path gets its request out while the budget is spent
 *     (§ "a click is never refused by the daily budget");
 *   - a row that is merely provenance-manual gets nothing, however long it
 *     waits, and a granted row gets exactly ONE request and no more
 *     (§ "the grant cannot be spent twice");
 *   - a chain of work a click starts cannot inherit the grant
 *     (§ "work a click starts cannot cascade into uncapped work").
 *
 * Instrument, as in `providerSpendCap.test.ts` and for the same reason: a real
 * store, the real `ai.ts`, the real processor, the real `ipcMain` handlers.
 * Only the transport is stubbed, because these claims span modules — the
 * bucket is derived in ai.ts, the grant is spent in aiQueue.ts, the flag is
 * written by main.ts, and a mock at any one of them would prove nothing about
 * the others. Every assertion counts `fetch` calls, which is what the user
 * pays for, and cross-checks the ledger rather than trusting it.
 *
 * ON THE PROVIDER'S ANSWER. Most cases here answer 429, and the row's
 * resulting `lastError` depends on the LANE rather than on the flag under
 * test: `verify` and `regenerate_section` surface the ordinary rate limit and
 * cost an attempt, while `tailor_job_docs` runs its two lanes through a
 * validation retry ladder, so a throttled provider ends that lane on a
 * `ProviderCooldownError` and the row parks on the provider's CLOCK — a
 * ten-minute wait. Both are correct outcomes for a request that was actually
 * made. That is exactly why the assertions below are about the CAP and the
 * WIRE — `parkedReason` never `provider_cap`, the cap's own sentence never on
 * the row, a request on the wire — rather than about which retry shape the
 * lane happened to produce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-presence-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => `${STORE_DIR}/app`,
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
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
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
    loadURL() {
      return Promise.resolve()
    }
    loadFile() {
      return Promise.resolve()
    }
    on() {
      return undefined
    }
    show() {
      return undefined
    }
    isDestroyed() {
      return false
    }
    static getAllWindows() {
      return []
    }
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

import {
  addAIQueueItem,
  addApiModel,
  clearAIQueue,
  createDocument,
  createJob,
  getAIQueue,
  getProviderSpend,
  reloadStore,
  updateAIQueueItem,
  updateSettings
} from './database'
import { callAI, providerBudget, providerKey, resetModelHealth, resetProviderSpend } from './ai'
import { processQueue } from './aiQueue'
import type { AIQueueItem } from './types'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
/** One credential, so one bucket, so `cap = 1` really is "the budget". */
const BASE_URL = 'https://openrouter.ai/api/v1'
const KEY = 'sk-or-free-tier-key-presence-aaaa'

let wire = 0

/** The only thing stubbed. Every assertion below is about `wire`. */
function stubTransport(status: number, content = 'A perfectly ordinary answer.'): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    wire++
    return {
      ok: status < 300,
      status,
      headers: new Map<string, string>(),
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => 'rate limited'
    }
  }))
}

function addModel(n = 1): void {
  for (let i = 0; i < n; i++) {
    addApiModel({
      name: `m${i}`,
      base_url: BASE_URL,
      api_key: KEY,
      model: `m${i}:free`,
      enabled: true
    } as never)
  }
}

let seq = 0
function jobWithDoc(): { jobId: number; documentId: number } {
  seq += 1
  const { job } = createJob({
    title: `Engineer ${seq}`,
    company: `Acme ${seq}`,
    location: 'Remote',
    url: `https://example.com/presence/${seq}`,
    description: 'A job description with a few words in it.'
  })
  return {
    jobId: job.id,
    // A document with real sections, because `documents:regenerateSection`
    // resolves the section against the row's own content before it will call
    // anything — and a throw there is not a RateLimitError, so the handler
    // would rethrow instead of queueing and the case would prove nothing.
    documentId: createDocument(
      'cv',
      'CV',
      'SUMMARY\nA line of prose about the things I have done.\n\nEXPERIENCE\n2020 - 2024\tEngineer, Acme\n- Shipped a thing that mattered\n',
      job.id
    ).id
  }
}

/** Total calls the app believes it made, across every bucket. */
function recordedTotal(): number {
  return Object.values(getProviderSpend()).reduce((n, calls) => n + calls.length, 0)
}

/**
 * Spend the whole budget with REAL requests, so "the cap is exhausted" is a
 * fact about the ledger rather than an assertion about a setting.
 *
 * One manual call against `cap = 1`: a person clicking a button, which is
 * exactly how the ledger on 2026-10-05 reached 629 — a manual call is not
 * refused by the cap, so a full budget is reachable without faking a stamp.
 * A 200 leaves the model health clean, so the provider is AVAILABLE for
 * everything after, and the cap is then the only thing in the way — which is
 * the condition under which every claim below means anything.
 */
async function drainTheBudget(): Promise<void> {
  const before = wire
  await callAI('sys', 'drain', 0.7, 45_000, undefined, undefined, undefined, { manual: true })
  expect(wire).toBe(before + 1)
  const key = providerKey({ base_url: BASE_URL, api_key: KEY } as never)
  const budget = providerBudget(key)
  expect(budget.used).toBe(budget.cap)
  expect(budget.freeAt).not.toBeNull()
}

function rows(): AIQueueItem[] {
  return getAIQueue()
}

function rowFor(jobId: number): AIQueueItem | undefined {
  return rows().find((q) => q.jobId === jobId)
}

/** What a person pressing Generate on a job produces, presence included. */
function enqueueWithGrant(jobId: number, documentId: number): void {
  const row = addAIQueueItem({
    type: 'verify',
    jobId,
    documentId,
    manualQueued: true,
    userPresentAt: Date.now()
  })
  expect(row.userPresentAt).toBeTypeOf('number')
}

/**
 * The claim being made about a row the user pressed a button for: the
 * provider was actually asked, and the DAILY BUDGET is not what stopped it.
 */
function expectNotCapParked(row: AIQueueItem | undefined, label: string): void {
  expect(row, `${label}: the row must still be there to be refused by anything`).toBeTruthy()
  expect(row!.parkedReason, `${label}: parked on a spent budget`).not.toBe('provider_cap')
  expect(row!.lastError ?? '', `${label}: refused by the cap`).not.toMatch(/call cap/i)
}

async function handler(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  expect(fn, `${channel} is not registered`).toBeTruthy()
  return fn!({}, ...args)
}

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [
    join(STORE_DIR, 'apply-assistant-data.json'),
    join(STORE_DIR, 'apply-assistant-key')
  ]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

beforeEach(async () => {
  wipe()
  clearAIQueue()
  resetModelHealth()
  resetProviderSpend()
  updateSettings({ base_cv: 'MASTER CV', provider_call_cap: 1 })
  wire = 0
  vi.unstubAllGlobals()
  // `Date` only, so the `setTimeout` inside `callAI`'s abort timers stays
  // real and the awaits below resolve normally.
  vi.useFakeTimers({ toFake: ['Date'] })
  // registerIpc() runs off app.whenReady() at import time, once per module —
  // which is why the handler map is NOT cleared between cases. The window mock
  // never fires `did-finish-load`, so the queue processor is not started by it
  // and every pass in this file is one this file asked for.
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
  expect(handlers.get('tailor:quickApply'), 'the real handlers must be reachable').toBeTruthy()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetModelHealth()
  resetProviderSpend()
  clearAIQueue()
})

// ---------------------------------------------------------------------------
// 1. EVERY USER PATH GETS ITS REQUEST OUT WHILE THE BUDGET IS SPENT.
// ---------------------------------------------------------------------------

describe('a click is never refused by the daily budget', () => {
  it('Quick Apply — enqueue-only, no direct call anywhere on the path', async () => {
    addModel()
    stubTransport(200)
    await drainTheBudget()
    // The provider throttles, so the documents cannot land on this pass. The
    // row is what the user is waiting for either way.
    stubTransport(429)

    const { jobId } = jobWithDoc()
    expect(await handler('tailor:quickApply', jobId)).toEqual({ queued: true })

    const queued = rowFor(jobId)
    expect(queued?.type).toBe('tailor_job_docs')
    // The grant, and the provenance beside it. Both — and they are different
    // fields, on different terms: the first is spent, the second is not.
    expect(queued?.userPresentAt).toBeTypeOf('number')
    expect(queued?.manualQueued).toBe(true)

    const before = wire
    await processQueue()

    // A request went out. Under the old behaviour this row was refused with
    // ZERO requests and sat parked on `provider_cap` until the window slid.
    expect(wire).toBeGreaterThan(before)
    expectNotCapParked(rowFor(jobId), 'Quick Apply')
    // And the grant is spent by the claim, whatever the lane went on to do:
    // nothing in the queue still holds one.
    expect(rows().filter((q) => q.userPresentAt !== undefined)).toHaveLength(0)
  })

  it('Retry — the Queue panel\'s button on a failed row', async () => {
    addModel()
    stubTransport(200)
    await drainTheBudget()

    const { jobId, documentId } = jobWithDoc()
    const failed = addAIQueueItem({
      type: 'verify',
      jobId,
      documentId,
      manualQueued: false
    })
    updateAIQueueItem(failed.id, {
      status: 'failed',
      attempts: 10,
      lastError: 'the provider fell over'
    })
    stubTransport(429)

    await handler('aiQueue:retry', failed.id)

    // Retry is presence on a row that is NOT provenance-manual, which is the
    // cleanest statement of the distinction this whole file rests on: the two
    // flags are orthogonal, and only one of them buys a request.
    const revived = rows().find((q) => q.id === failed.id)
    expect(revived?.status).toBe('pending')
    expect(revived?.manualQueued).toBe(false)
    expect(revived?.userPresentAt).toBeTypeOf('number')

    const before = wire
    await processQueue()
    expect(wire).toBeGreaterThan(before)
    expectNotCapParked(rows().find((q) => q.id === failed.id), 'Retry')
  })

  it('Verify, Regenerate and Tailor — queued as a rate-limit fallback', async () => {
    // The three the reviewer accepted as having an uncapped direct path, and
    // they do — `MANUAL` skips the cap. But the direct call had already
    // thrown by the time their row exists, the window was handed "queued", and
    // the queue is therefore the only thing that will answer. A person
    // waiting on a spinner is a person waiting on a spinner.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    // Every model throttles, which is what drives these three down their
    // fallback branch and creates the rows at all.
    stubTransport(429)

    const verify = jobWithDoc()
    expect(await handler('documents:verify', verify.jobId, verify.documentId, 'cv')).toEqual({
      queued: true
    })
    expect(rowFor(verify.jobId)?.type).toBe('verify')
    expect(rowFor(verify.jobId)?.userPresentAt).toBeTypeOf('number')

    const regen = jobWithDoc()
    expect(
      await handler('documents:regenerateSection', regen.documentId, 'summary', regen.jobId)
    ).toEqual({ queued: true })
    expect(rowFor(regen.jobId)?.type).toBe('regenerate_section')
    expect(rowFor(regen.jobId)?.userPresentAt).toBeTypeOf('number')

    const tailor = jobWithDoc()
    expect(await handler('ai:tailor', { job_id: tailor.jobId, document_type: 'cv' })).toEqual({
      queued: true
    })
    expect(rowFor(tailor.jobId)?.type).toBe('generate_cv')
    expect(rowFor(tailor.jobId)?.userPresentAt).toBeTypeOf('number')

    // The throttled calls above left the models cooling, which would park the
    // whole pass without claiming anything. The provider has recovered; the
    // BUDGET has not. Clearing the health in between is what isolates the cap
    // as the only thing left in the way.
    resetModelHealth()
    const before = wire
    await processQueue()
    expect(wire, 'every one of the three rows must reach the provider').toBeGreaterThan(before)
    for (const j of [verify.jobId, regen.jobId, tailor.jobId]) {
      expectNotCapParked(rowFor(j), `job ${j}`)
    }
  })

  it('and the GRANT is what does it — the same row without one still parks', async () => {
    // The A/B that makes the mechanism a fact rather than a correlation. The
    // identical row, the identical spent budget, the identical pass —
    // differing only in whether a person is recorded as waiting for it.
    //
    // Each half gets its OWN store and its own pass on purpose. Running both
    // rows in one pass would let the present row's own request cool the
    // provider down, and the unattended row would then be parked on a
    // cooldown instead — which would make the contrast look like the cap's
    // doing when it is really the first row's.
    addModel()

    const shapes: { type: 'tailor_job_docs' | 'verify'; label: string }[] = [
      { type: 'tailor_job_docs', label: 'Quick Apply' },
      { type: 'verify', label: 'Verify' }
    ]

    for (const shape of shapes) {
      for (const present of [true, false]) {
        clearAIQueue()
        resetProviderSpend()
        resetModelHealth()
        stubTransport(200)
        await drainTheBudget()
        stubTransport(429)

        const who = jobWithDoc()
        addAIQueueItem({
          type: shape.type,
          jobId: who.jobId,
          ...(shape.type === 'verify' ? { documentId: who.documentId } : {}),
          manualQueued: true,
          ...(present ? { userPresentAt: Date.now() } : {})
        } as never)
        expect(rowFor(who.jobId)?.userPresentAt !== undefined).toBe(present)

        const before = wire
        await processQueue()
        const label = `${shape.label} (${present ? 'present' : 'provenance only'})`

        if (present) {
          expect(wire, `${label}: a present row must reach the provider`).toBeGreaterThan(before)
          expectNotCapParked(rowFor(who.jobId), label)
          continue
        }
        // The very same work, provenance only: refused, parked on the cap, and
        // disclosed there.
        const parked = rowFor(who.jobId)
        expect(parked?.parkedReason, `${label}: provenance alone must not buy a request`).toBe(
          'provider_cap'
        )
        expect(parked?.lastError).toMatch(/call cap/i)
        expect(wire, `${label}: nothing went out`).toBe(before)
        // A cap refusal costs nothing, which is what makes it free to keep
        // refusing: no attempt, no revival, still queued, still on the panel.
        expect(parked?.attempts).toBe(0)
        expect(parked?.autoRevives).toBeUndefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. THE BOUND: provenance buys nothing, and a grant buys exactly one.
// ---------------------------------------------------------------------------

describe('the grant cannot be spent twice', () => {
  it('a provenance-only row sits on the cap for 40 passes and 6.7 hours', async () => {
    // The reviewer's probe, kept as a regression: `manualQueued: true` on its
    // own is NOT presence and must not buy a single request, however long the
    // row waits. Model health is cleared before every pass, so the provider is
    // AVAILABLE throughout and the cap is demonstrably the only thing refusing
    // — a stronger claim than "the provider was down as well".
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(200)

    const { jobId, documentId } = jobWithDoc()
    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: true })

    const start = Date.now()
    for (let pass = 1; pass <= 40; pass++) {
      vi.setSystemTime(start + pass * 11 * MINUTE)
      resetModelHealth()
      await processQueue()
    }
    // 6h40m of passes, well inside a 24h window, so the budget never frees on
    // its own and the refusal really is the cap rather than the clock.
    expect(Date.now() - start).toBeGreaterThan(6 * HOUR)
    expect(providerBudget(providerKey({ base_url: BASE_URL, api_key: KEY } as never)).used).toBe(1)
    // The drain is the only request that ever left the app.
    expect(wire).toBe(1)
    expect(recordedTotal()).toBe(1)

    const parked = rowFor(jobId)
    expect(parked?.status).toBe('pending')
    expect(parked?.parkedReason).toBe('provider_cap')
    expect(parked?.attempts).toBe(0)
  })

  it('a granted row gets ONE request and then is capped like anything else', async () => {
    addModel()
    stubTransport(200)
    await drainTheBudget()
    // The granted attempt fails, so the row SURVIVES and its later passes are
    // observable. A throttled provider rather than a cap refusal: a cap
    // refusal would take the row out of contention by proving nothing about
    // what the next pass would do.
    stubTransport(429)

    const { jobId, documentId } = jobWithDoc()
    enqueueWithGrant(jobId, documentId)

    const start = Date.now()
    for (let pass = 1; pass <= 40; pass++) {
      vi.setSystemTime(start + pass * 11 * MINUTE)
      resetModelHealth()
      await processQueue()
      if (pass === 1) expect(wire, 'the grant must buy its one request').toBe(2)
    }

    // 39 further passes, 39 further opportunities, and not one request. This
    // is the number the 12.6x was made of: 369 requests, all `origin=manual`,
    // bought by one click. Here one click buys 1.
    expect(wire).toBe(2)
    expect(recordedTotal()).toBe(2)
    // The grant is gone from the row, provenance is not, and the row is parked
    // on the cap — so the next person to look at it is told the truth about
    // what is holding it.
    const row = rowFor(jobId)
    expect(row?.userPresentAt).toBeUndefined()
    expect(row?.manualQueued, 'provenance survives the grant').toBe(true)
    expect(row?.parkedReason).toBe('provider_cap')
  })

  it('a grant survives an unclaimed wait — it is spent by the claim, not a clock', async () => {
    // The fix must not decay into the bug it fixes when the queue behind the
    // user's button is deep. A row the processor cannot claim (the whole pool
    // is cooling, exactly as in the measurement) parks on the provider's
    // clock WITHOUT being claimed — so its grant is not spent, and hours later
    // the first claim that does happen still spends it.
    //
    // No expiry would be wrong here; an expiry is exactly what would bring the
    // 24-hour park back for a press nobody has cancelled.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)
    // A direct MANUAL call the throttling provider refuses, which leaves the
    // whole pool cooling — the state the reviewer's probe was taken in. Manual
    // because an automated one is turned away by the spent cap without ever
    // reaching the provider, and would therefore cool nothing.
    await callAI('sys', 'heat', 0.7, 45_000, undefined, undefined, undefined, { manual: true }).catch(
      () => undefined
    )

    const { jobId, documentId } = jobWithDoc()
    enqueueWithGrant(jobId, documentId)

    await processQueue()
    // Parked on the provider's clock, not claimed, and the grant is intact.
    expect(rowFor(jobId)?.blockedSince).toBeTypeOf('number')
    expect(rowFor(jobId)?.userPresentAt).toBeTypeOf('number')

    // Hours of nothing happening, then the provider is reachable again and the
    // budget is still spent. The press is answered.
    const spent = wire
    vi.setSystemTime(Date.now() + 4 * HOUR)
    resetModelHealth()
    await processQueue()

    expect(wire, 'a press four hours old is still a press').toBeGreaterThan(spent)
    expect(rowFor(jobId)?.userPresentAt).toBeUndefined()
    expectNotCapParked(rowFor(jobId), 'the late pass')
  })

  it('a press made DURING a pass is not clobbered by that pass\'s claim', async () => {
    // The snapshot race. A pass reads the queue and then works through it; the
    // user presses Quick Apply while it is mid-backlog. An unconditional clear
    // in the claim write would delete a grant the pass never consumed and
    // leave the press with a capped row — the bug, one click later. The clear
    // is conditional on having consumed one for exactly this reason.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)

    const slow = jobWithDoc()
    const mine = jobWithDoc()
    addAIQueueItem({
      type: 'verify',
      jobId: slow.jobId,
      documentId: slow.documentId,
      manualQueued: true
    })
    const queued = addAIQueueItem({
      type: 'verify',
      jobId: mine.jobId,
      documentId: mine.documentId
    })
    // Armed the way `enqueue`'s duplicate path arms it, between one pass's
    // snapshot and the next claim.
    updateAIQueueItem(queued.id, { manualQueued: true, userPresentAt: Date.now() })

    await processQueue()

    // The press was not thrown away: either it was honoured on this pass, or
    // it is still on the row for the next one. Never "claimed and discarded".
    const row = rowFor(mine.jobId)
    expect(row, 'the row a person pressed for must survive the pass').toBeTruthy()
    expect(wire, 'a press made during a pass still reaches the provider').toBeGreaterThan(1)
    expectNotCapParked(row, 'the mid-pass press')
  })
})

// ---------------------------------------------------------------------------
// 3. A CHAIN STARTED BY A CLICK CANNOT INHERIT THE GRANT.
// ---------------------------------------------------------------------------

describe('work a click starts cannot cascade into uncapped work', () => {
  it('the review → regeneration loop is enqueued with no grant at all', async () => {
    // The structural half of the bound, driven rather than argued: a granted
    // row that finishes and chains follow-up work produces children with no
    // grant, because the parent spends its own in the claim write before it
    // ever reaches the enqueue. Not a convention — there is nothing left to
    // pass on.
    //
    // The cap is generous here on purpose: this case is about provenance and
    // the grant, not about the cap refusing anything.
    updateSettings({ provider_call_cap: 50 })
    addModel()
    stubTransport(200, '{"score":10,"passed":false,"feedback":"needs work"}')

    const { jobId, documentId } = jobWithDoc()
    enqueueWithGrant(jobId, documentId)
    expect(wire).toBe(0)

    await processQueue()

    // The review ran (so the grant really was honoured) and failed, so the
    // processor chained a regeneration for the document it just reviewed.
    expect(wire).toBeGreaterThan(0)
    const child = rows().find((q) => q.jobId === jobId && q.type === 'generate_cv')
    expect(child, 'the failing review must chain a regeneration').toBeTruthy()
    // No grant. The parent is gone, and the child is the app's own work.
    expect(child?.userPresentAt).toBeUndefined()
    for (const q of rows()) expect(q.userPresentAt, 'no row may hold a grant now').toBeUndefined()
  })

  it('a REPEATED press does not accumulate grants', async () => {
    // The one place a grant can be re-armed is `enqueue`'s duplicate path,
    // and it OVERWRITES with a fresh timestamp rather than adding anything. So
    // ten presses before the next pass are worth one claim, and one row.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)

    const { jobId } = jobWithDoc()
    for (let i = 0; i < 10; i++) await handler('tailor:quickApply', jobId)

    // One row — the duplicate guard's whole job — and one grant on it.
    expect(rows()).toHaveLength(1)
    expect(rowFor(jobId)?.userPresentAt).toBeTypeOf('number')
    expect(rows().filter((q) => q.userPresentAt !== undefined)).toHaveLength(1)

    const before = wire
    await processQueue()
    // One or two requests, because this is the both-documents unit and
    // `tailor_job_docs` runs a CV lane and a cover-letter lane — and the
    // second lane can find the model already cooling from the first, which is
    // a refusal rather than a request. What is pinned is the BOUND: the number
    // is set by the WORK THE CLICK ASKED FOR, never by the ten presses.
    expect(wire - before).toBeGreaterThan(0)
    expect(wire - before).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 4. The store round-trip: a grant is durable, and only a person makes one.
// ---------------------------------------------------------------------------

describe('the grant is durable, and only because a person made it', () => {
  it('survives reloadStore, and a legacy row has none', async () => {
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)

    const { jobId, documentId } = jobWithDoc()
    // The literal pre-grant row shape: no `userPresentAt` key at all. Absent
    // means nobody is waiting, for the same reason absent `manualQueued` means
    // automatic — the reading that cannot hand out an exemption.
    //
    // Queued FIRST on purpose: a pass works through rows in pick order, and
    // the row behind a present one would find the model cooling from its
    // neighbour's request and be parked on a COOLDOWN instead. That is also a
    // correct outcome, but it would be measuring the wrong refusal — this row
    // has to be refused by the BUDGET to show what absence means.
    const legacy = jobWithDoc()
    addAIQueueItem({ type: 'verify', jobId: legacy.jobId, documentId: legacy.documentId })
    addAIQueueItem({
      type: 'verify',
      jobId,
      documentId,
      manualQueued: true,
      userPresentAt: Date.now()
    })

    // `persistStore` serialises the encrypted write through a promise chain,
    // so the file is a tick behind the in-memory store. Let it land before
    // reloading, or this asserts that a write never happened rather than that
    // the field round-trips.
    for (let tick = 0; tick < 4; tick++) await new Promise((r) => setTimeout(r, 0))
    reloadStore()

    expect(rowFor(jobId)?.userPresentAt).toBeTypeOf('number')
    expect(Object.keys(rowFor(legacy.jobId)!).some((k) => k === 'userPresentAt')).toBe(false)

    resetModelHealth()
    const before = wire
    await processQueue()
    expect(wire, 'the press still reaches the provider after a restart').toBeGreaterThan(before)
    // The legacy row spent nothing and was granted nothing by the restart,
    // which is the entire point of absence.
    expect(rowFor(legacy.jobId)?.lastError ?? '').toMatch(/call cap/i)
  })
})