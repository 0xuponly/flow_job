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
 * press, spent by `processItem` in the same write that claims the row. So a
 * gesture buys one CLAIM the cap cannot refuse, and the leak bound is a
 * consequence of WHERE the field is cleared rather than a promise about it.
 * THIS FILE IS THE PROOF OF THE BOUND, from all four sides:
 *
 *   - every user path gets its request out while the budget is spent
 *     (§ 1, "a click is never refused by the daily budget");
 *   - the job page's AUTOMATIC sweep gets nothing, however many pages are
 *     opened (§ 0 — the reviewer's MAJOR 1, which was that two of the five
 *     "user paths" above were also reached by a mount sweep, so opening a page
 *     armed a grant and five page opens bought five uncapped requests on a
 *     ledger already 7 calls into a cap of 1);
 *   - a row that is merely provenance-manual gets nothing, however long it
 *     waits, and a granted row gets exactly ONE claim and no more
 *     (§ 2, "the grant cannot be spent twice"), whose SIZE is measured rather
 *     than asserted (§ 2b — the reviewer's MAJOR 2, which was that the branch
 *     published "at most one `callAI`" and the real figure was 2-3 on one
 *     healthy model);
 *   - a press that lands MID-PASS is the one that claim spends, and a stale
 *     clear cannot revoke it (§ 2, the reviewer's MAJOR 3);
 *   - a chain of work a click starts cannot inherit the grant
 *     (§ 3, "work a click starts cannot cascade into uncapped work").
 *
 * WHO may arm the grant is not settled here — it is a property of the
 * renderer's call graph, so it lives in review.enqueueCallSites.test.ts, which
 * walks every renderer call site of the six channels and refuses one that is
 * reachable from a mount effect, a timer or the refresh listener.
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
  saveApiModels,
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
  // The list is REPLACED, not appended to. Each case gets a fresh store from
  // `beforeEach`, but a case that measures two fixtures in a row calls this
  // twice — and an appended pool would make the second measurement count
  // requests against a rotation the reader cannot see. `spentBy` below is
  // where that matters.
  saveApiModels([])
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

/**
 * A granted row of any shape, for the cases that are about the SIZE of what a
 * grant buys rather than about how it was armed.
 *
 * Written through `addAIQueueItem` rather than through `enqueue` so the row's
 * `type` can be chosen: the point of these cases is that the grant's cost is a
 * property of the UNIT the claim runs, and the unit is what the row's type
 * selects.
 */
function grantedRow(
  type: 'verify' | 'generate_cv' | 'generate_cover_letter' | 'tailor_job_docs' | 'regenerate_section',
  jobId: number,
  documentId: number,
  extra: Record<string, unknown> = {}
): number {
  const row = addAIQueueItem({
    type,
    jobId,
    ...(type === 'verify' || type === 'regenerate_section' ? { documentId } : {}),
    ...(type === 'regenerate_section' ? { sectionName: 'summary' } : {}),
    manualQueued: true,
    userPresentAt: Date.now(),
    ...extra
  } as never)
  expect(row.userPresentAt).toBeTypeOf('number')
  return row.id
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
// 0. A SWEEP IS NOT A PERSON. Opening a page must not buy anything.
// ---------------------------------------------------------------------------

describe('the job page\'s automatic sweep buys nothing', () => {
  // The regression this section exists for, and it is the reviewer's MAJOR 1.
  // The job page reviews every document that has no verification score on
  // mount (`useEffect(() => { load() }, [job.id])`), on the sidebar's Refresh,
  // and after every Generate / Apply / status change. It did that through the
  // same two IPC channels the Review and Generate buttons use, so every page
  // open armed a presence grant nobody asked for. The probe, on a store whose
  // budget was already spent (cap = 1, drained by a real manual call):
  //
  //   5x documents:verify on an unreviewed document -> { queued: true } each time
  //   then five passes, each preceded by the same press:
  //   PROBE five automatic sweeps bought 5 uncapped request(s); ledger 7
  //
  // Five automatic sweeps, five requests on the wire, on a ledger already 7
  // calls into a cap of 1. So the sweep now has channels of its own
  // (`documents:autoVerify`, `ai:autoTailor`), each running the same direct
  // call with `byPress` false, and the difference is everything: an
  // AUTOMATED call, and a fallback row carrying neither flag.
  //
  // The calls below are the ones `ensureDocVerified` makes, in the order it
  // makes them. Which function calls them is pinned in
  // review.enqueueCallSites.test.ts, transitively from the mount effect down;
  // what they cost is pinned here.

  it('a page open arms no grant, claims no provenance and is not promoted', async () => {
    addModel()
    stubTransport(200)
    await drainTheBudget()
    // No 429 stub: with the budget spent, an AUTOMATIC direct call is refused
    // by the cap before it reaches the provider. `ProviderCapError` extends
    // `RateLimitError`, so that IS the fallback branch — which is why the
    // row exists at all, and it is a row of the app's own making.
    const sweep = jobWithDoc()
    expect(await handler('documents:autoVerify', sweep.jobId, sweep.documentId, 'cv')).toEqual({
      queued: true
    })
    const reviewed = rowFor(sweep.jobId)
    expect(reviewed?.type, 'the fallback row is a review').toBe('verify')
    expect(reviewed?.userPresentAt, 'a page open must not arm a grant').toBeUndefined()
    expect(reviewed?.manualQueued, 'nor claim provenance — nobody asked for this review').toBe(false)
    expect(reviewed?.promotedAt, 'nor be promoted to the top of the queue').toBeUndefined()

    // The regeneration loop's half of the same sweep (`ensureDocVerified`'s
    // `autoTailorDocument`, after a review scored under 70).
    const regen = jobWithDoc()
    expect(await handler('ai:autoTailor', { job_id: regen.jobId, document_type: 'cv' })).toEqual({
      queued: true
    })
    const generated = rowFor(regen.jobId)
    expect(generated?.type).toBe('generate_cv')
    expect(generated?.userPresentAt, 'a page open must not arm a grant').toBeUndefined()
    expect(generated?.manualQueued).toBe(false)

    // And neither row may be run past the app's own budget.
    const before = wire
    await processQueue()
    expect(wire, "the app's own review waits for the app's own budget").toBe(before)
    expect(rowFor(sweep.jobId)?.parkedReason).toBe('provider_cap')
    expect(rowFor(regen.jobId)?.parkedReason).toBe('provider_cap')
  })

  it('five page opens buy nothing — no request, no grant, no provenance', async () => {
    // The probe, reproduced. Five job pages with an unreviewed document each,
    // opened and passed in turn — which is what a user comparing five
    // postings does — and the assertion is on the wire, not on the row.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)

    for (let open = 1; open <= 5; open++) {
      const page = jobWithDoc()
      expect(await handler('documents:autoVerify', page.jobId, page.documentId, 'cv')).toEqual({
        queued: true
      })
      const before = wire
      await processQueue()
      expect(wire - before, `page open ${open} spent uncapped budget`).toBe(0)
      // Nothing on the row is a person's request, at any point in that
      // sequence: no grant, no provenance, no promotion.
      const row = rowFor(page.jobId)
      expect(row?.userPresentAt, `page open ${open} armed a grant`).toBeUndefined()
      expect(row?.manualQueued, `page open ${open} claimed provenance`).toBe(false)
      expect(row?.promotedAt, `page open ${open} promoted the row`).toBeUndefined()
      // Cleared between opens, so the next pass has a queue of its own to
      // refuse rather than five parked rows to sort.
      clearAIQueue()
    }

    // The drain is the only request that ever left the app.
    expect(wire).toBe(1)
  })

  it('obeys the auto_queue switches, so "off" is finally true of a page load', async () => {
    // The provenance half of the same fix. While the sweep shared a channel
    // with the buttons, its rows were `manualQueued: true` and therefore
    // ungated by `auto_queue_verify_*` — so switching automatic review off
    // was overruled by opening a page.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    updateSettings({ auto_queue_verify_cv: false })

    const off = jobWithDoc()
    // `queued: false` is the honest answer here: the work was refused, so the
    // sweep must not tell anyone a row was added.
    expect(await handler('documents:autoVerify', off.jobId, off.documentId, 'cv')).toEqual({
      queued: false
    })
    expect(getAIQueue(), 'a switch the user turned off means no row').toHaveLength(0)

    // ...and the same switch, with the same spent budget, does not stop the
    // person. This is the pairing the whole design rests on, so both halves
    // are asserted in one place rather than in two that could drift.
    stubTransport(429)
    const press = jobWithDoc()
    expect(await handler('documents:verify', press.jobId, press.documentId, 'cv')).toEqual({
      queued: true
    })
    const row = rowFor(press.jobId)
    expect(row, "a person's request is queued whatever the switches say").toBeTruthy()
    expect(row!.userPresentAt, 'and it is a press, so it carries the grant').toBeTypeOf('number')
    expect(row!.manualQueued).toBe(true)

    const before = wire
    resetModelHealth()
    await processQueue()
    expect(wire, "the press reaches the provider; the sweep's work does not").toBe(before + 1)
    expectNotCapParked(rowFor(press.jobId), "the press, with auto_queue_verify_cv off")
  })
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

  it('a press made DURING a pass is honoured BY that pass, not lost to its clear', async () => {
    // The interleaving, and the direction that actually loses a request.
    //
    // A pass reads the queue and works through a snapshot. `item` is that
    // snapshot's row, and `updateAIQueueItem` REPLACES the store element, so
    // `item.userPresentAt` is whatever the row held when the pass STARTED. A
    // press that lands while the pass is mid-backlog therefore exists in the
    // store and not in `item`, which is the whole race.
    //
    // The press here is made from inside the transport stub, i.e. genuinely
    // between one claim and the next rather than before the snapshot: row A's
    // request is in flight when the user presses on row B. That is reachable
    // in the app — `JobDetail` re-runs `load()` right after a Generate, and
    // the sweep then reviews the document the processor has just chained a
    // review for, so the press lands while that row is `processing`.
    //
    // What the previous version did: it asked the SNAPSHOT whether it had
    // consumed a grant and cleared only then — so it read "no" here, built
    // `opts` from the snapshot, let the cap refuse the request the press was
    // waiting for, and (by not clearing) left the grant for a later pass. The
    // user's press became a row parked on the budget. What it does now: the
    // claim re-reads the row, sees the grant the press just armed, spends it,
    // and the request the press asked for goes out on THIS pass.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    // A's review passes, so A's row is retired and B is reached; everything
    // after the first request throttles, so B's row SURVIVES the pass and
    // what it went on to is observable. The press is made from inside the
    // first request, which is what puts it between one claim and the next.
    let served = 0
    let armed = false
    const queued = { id: 0 }
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      wire++
      served++
      if (served === 1 && !armed) {
        armed = true
        // Armed the way `enqueue`'s duplicate path and `retryQueueItem` arm
        // it: mid-pass, while a request is in flight and before this row's
        // claim has been written.
        updateAIQueueItem(queued.id, {
          manualQueued: true,
          promotedAt: Date.now(),
          userPresentAt: Date.now()
        })
      }
      const ok = served === 1
      return {
        ok,
        status: ok ? 200 : 429,
        headers: new Map<string, string>(),
        json: async () => ({
          choices: [{ message: { content: '{"score":90,"passed":true,"feedback":"good"}' } }]
        }),
        text: async () => 'rate limited'
      } as never
    })

    const first = jobWithDoc()
    const mine = jobWithDoc()
    // A is first and is granted, so it makes the request whose stub arms B.
    grantedRow('verify', first.jobId, first.documentId, { promotedAt: Date.now() })
    queued.id = addAIQueueItem({
      type: 'verify',
      jobId: mine.jobId,
      documentId: mine.documentId
    }).id

    const before = wire
    await processQueue()

    // Two requests: A's, and the one the press bought. Before the fix this was
    // 1 — B's was refused by the cap and parked.
    expect(wire - before, 'both rows made their request: the press bought its own').toBe(2)
    const row = rowFor(mine.jobId)
    expect(row, 'the pressed row survives (its request was throttled)').toBeTruthy()
    // Not parked on the budget — throttled, which is a different refusal and
    // one the user is told about in the row's own `lastError`.
    expectNotCapParked(row, 'the mid-pass press')
    expect(row!.lastError ?? '', 'refused by the provider, not by the cap').toMatch(/rate|429|too many/i)
    // And the grant that press armed was SPENT by this claim, not left alive
    // on the row — which is the other direction of the same race, and the one
    // that would let a claim's clear leave a grant behind.
    expect(row!.userPresentAt, 'the grant the press armed was consumed').toBeUndefined()
    expect(rows().filter((q) => q.userPresentAt !== undefined), 'no grant survives a claim').toHaveLength(0)
  })

  it('and a press that re-arms a row already holding a grant is still spent once', async () => {
    // The other interleaving, for completeness rather than for teeth: the row
    // already held a grant when the pass snapshotted it, and the press
    // RE-armed it mid-pass. Both versions consume exactly one grant, so this
    // asserts the property rather than a difference: one claim, one grant
    // spent, no grant left on the row and no second claim out of it.
    addModel()
    stubTransport(200)
    await drainTheBudget()
    stubTransport(429)

    const mine = jobWithDoc()
    const rowId = grantedRow('verify', mine.jobId, mine.documentId, { promotedAt: Date.now() })
    // The re-arm, with a timestamp a millisecond later than the first.
    vi.setSystemTime(Date.now() + 5)
    updateAIQueueItem(rowId, { userPresentAt: Date.now() })

    const before = wire
    await processQueue()

    expect(wire - before, 'one claim, and the work it runs').toBe(1)
    expect(rowFor(mine.jobId)?.userPresentAt, 'no grant survives the claim that spent one').toBeUndefined()
    const spent = wire
    await processQueue()
    expect(wire - spent, 'and nothing is uncapped on the next pass').toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2b. WHAT ONE GRANT ACTUALLY BUYS. The bound, measured rather than claimed.
// ---------------------------------------------------------------------------

describe('the size of one grant, measured', () => {
  // The reviewer's MAJOR 2, and it is a defect in a SENTENCE rather than in
  // the mechanism: `aiQueue.processItem` used to publish "one grant buys
  // exactly one claim, hence at most one `callAI` the cap cannot refuse", and
  // that was wrong by 2-3x on the floor. A unit is not one provider request:
  // `tailorDocument` derives keywords with one `callAI` and writes the
  // document with another, `tailorJobDocsForJob` runs that for both
  // documents, `verifyDocumentContent` wraps its `callAI` in a bounded
  // parse-retry ladder, and each call walks the user's model rotation.
  //
  // So the honest bound is a PRODUCT, and the only way to publish a product is
  // to measure it. Which is what these cases do — through the real handlers,
  // the real processor and the real `ai.ts`, on a fixture with a pinned model
  // count, with the budget genuinely drained so every request counted here is
  // one the cap could not have refused.
  //
  // What they buy is still bounded, and bounded by things the user chose: the
  // shape of the unit and the model list in Settings. It is also the SAME
  // product the button's own direct call already spends, because `MANUAL`
  // lifts the cap for that rotation too — pressing Generate has always walked
  // the pool on a spent budget. The grant replaces the CAP and nothing else.

  /** A CV that passes `looksLikeHarvardCv`, so a generation lane SUCCEEDS. */
  const CV =
    'Ada Lovelace\nCambridge, UK\n\nSummary\nBuilt the first program.\n\n' +
    'Experience\n2020 - 2024\tEngineer, Acme\nShipped a thing\tLondon\n\n' +
    'Education\n2016 - 2020\tCambridge\n'
  const PASSING_REVIEW = '{"score":90,"passed":true,"feedback":"good"}'
  const COVER_LETTER = 'Dear Team,\n\nA paragraph about the role.\n\nRegards,\nAda\n'
  const SECTION = 'A regenerated summary line, in prose.\n'

  /**
   * One grant on one row, one pass, and how many requests it bought.
   *
   * Each half gets its own budget and its own pass, because a unit that
   * chains follow-up work would otherwise let the parent's requests cool the
   * provider and the measurement would be about cooldowns instead.
   */
  async function spentBy(
    shape: Parameters<typeof grantedRow>[0],
    models: number,
    status: number,
    content: string
  ): Promise<number> {
    clearAIQueue()
    resetProviderSpend()
    resetModelHealth()
    addModel(models)
    stubTransport(200)
    await drainTheBudget()
    stubTransport(status, content)
    const who = jobWithDoc()
    grantedRow(shape, who.jobId, who.documentId)
    const before = wire
    await processQueue()
    return wire - before
  }

  it('is ONE request for a review and a regeneration, and TWO for a document', async () => {
    // One healthy model, content that validates first time. The product
    // reduces to (lanes) x (callAI per lane):
    //
    //   verify              1  a single callAI, and its parse ladder does not
    //                           run because the review parsed
    //   regenerate_section  1  same shape
    //   generate_cv         2  keywords (`extractJobKeywordsV3`) + the document
    //   generate_cover_letter 2  the same two
    //   tailor_job_docs     3  both lanes, and the second lane's KEYWORD call
    //                           coalesces onto the first's in-flight promise
    //                           (`coalesceKey` is the prompts, and both lanes
    //                           are handed the same job description), so it is
    //                           2 documents + 1 keyword extraction
    //
    // The keyword call is inside `tailorDocument`'s own try/catch, so a
    // refused extraction degrades to the rule pipeline rather than failing the
    // unit — which is why "2 for a document" is a floor in practice and not a
    // liability.
    expect(await spentBy('verify', 1, 200, PASSING_REVIEW)).toBe(1)
    expect(await spentBy('regenerate_section', 1, 200, SECTION)).toBe(1)
    expect(await spentBy('generate_cv', 1, 200, CV)).toBe(2)
    expect(await spentBy('generate_cover_letter', 1, 200, COVER_LETTER)).toBe(2)
    expect(await spentBy('tailor_job_docs', 1, 200, CV)).toBe(3)
  })

  it('is the model rotation, once per model — so a dead pool multiplies it and nothing else does', async () => {
    // The second term of the product, and the reason the bound is stated as a
    // product rather than as a number. Three models that all refuse: a single
    // `callAI` walks all three, so one claim buys three requests and no more.
    // A FOURTH model would make it four, and that is the user's own Settings
    // list talking — the same multiplier the direct Generate button has always
    // had, because `MANUAL` skips the cap for the whole rotation.
    //
    // 429 rather than 5xx so the refusal is a throttle the queue understands
    // and the row survives the pass, so what is left behind is a row and not a
    // deleted one.
    //
    // The two shapes here are the ones whose unit is a SINGLE `callAI`, so the
    // rotation is the only term left and each number says exactly one thing.
    // The 3 and the 4 are the linearity claim: exactly one request per enabled
    // model, no more and no fewer.
    //
    // A generation lane is deliberately NOT in this case. Its keyword call
    // (inside `tailorDocument`, and degrading to the rule pipeline when it
    // fails) walks the pool on the way to the document call and cools it as it
    // goes, so the total is "the pool, then whatever is still warm" — a fact
    // about cooldowns rather than about the bound. The healthy-pool numbers
    // above already account for both of its calls.
    expect(await spentBy('regenerate_section', 3, 429, 'rate limited')).toBe(3)
    expect(await spentBy('regenerate_section', 4, 429, 'rate limited')).toBe(4)
    expect(await spentBy('verify', 3, 429, 'rate limited')).toBe(3)
  })

  it('is the lane\'s own bounded ladder when the answers will not parse', async () => {
    // The third term, and the one that made the old sentence wrong in the
    // other direction: `verifyDocumentContent` retries on a parse failure with
    // every model that produced the bad answer excluded, up to
    // `MAX_RETRIES = 2` extra times — so a review unit is at most THREE
    // `callAI`s, and that "3" is a constant in ai.ts rather than a function of
    // anything the user chose.
    //
    // Each rung walks whatever is left of the rotation, which is why the
    // three-model fixture lands on three rather than nine: the model that
    // answered badly is not asked again. And one model is not three requests
    // either — with a single model there is nothing left for the second rung
    // to try, so the ladder gives up after one and the unit reports a skip.
    // Both halves matter: the first is the ceiling, the second is why the
    // ceiling is never reached by accident.
    expect(await spentBy('verify', 1, 200, 'not json at all')).toBe(1)
    expect(await spentBy('verify', 3, 200, 'not json at all')).toBe(3)
  })

  it('and a provenance-only row buys NONE of it, whatever the unit', async () => {
    // The control that makes the numbers above mean something. Identical rows,
    // identical spent budget, identical pass, differing only in the grant.
    for (const [shape, content] of [
      ['verify', PASSING_REVIEW],
      ['generate_cv', CV],
      ['tailor_job_docs', CV]
    ] as const) {
      clearAIQueue()
      resetProviderSpend()
      resetModelHealth()
      addModel(3)
      stubTransport(200)
      await drainTheBudget()
      stubTransport(429)
      const who = jobWithDoc()
      addAIQueueItem({
        type: shape,
        jobId: who.jobId,
        ...(shape === 'verify' ? { documentId: who.documentId } : {}),
        manualQueued: true
      } as never)
      const before = wire
      await processQueue()
      expect(wire - before, `${shape}: provenance alone must buy no request`).toBe(0)
      expect(rowFor(who.jobId)?.parkedReason, `${shape}: and is parked on the budget`).toBe(
        'provider_cap'
      )
    }
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