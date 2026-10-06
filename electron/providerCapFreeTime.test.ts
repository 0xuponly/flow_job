/**
 * WHEN THE CAP MESSAGE SAYS THE BUDGET IS FREE.
 *
 * A cap frees on a rolling 24h window, and the one field a user would act
 * on is the moment that happens. Measured on 2026-10-05, a 6h44m window
 * emitted "Budget frees at 02:04 a.m." 2,315 times against a ledger holding
 * 629 requests against a cap of 50, and between 3.4 and 9.7 hours after the
 * moment named, for 100% of the window, never corrected.
 *
 * Two independent defects, and this file pins both because fixing either
 * alone leaves the message still lying:
 *
 *   1. THE VALUE. `freeAt` was the oldest in-window call plus one window.
 *      One call ageing out moves `used` by ONE, so on that ledger the moment
 *      it named was 629 -> 628 — still 12.6x the cap of 50. The provider
 *      would still have refused the user. The moment the budget frees is the
 *      one at which `used` drops BELOW the cap, which is the call at index
 *      `used - cap`, and on that ledger it was ~24h later than the old value.
 *   2. THE DAY. The value is in the future by construction — the window
 *      filter keeps only stamps newer than `now - window`, so `freeAt` is
 *      always later than `now` — but it is routinely in the FUTURE
 *      TOMORROW, and it was rendered as a bare time of day. A bare "02:04
 *      a.m." cannot say which day, so the only 02:04 a reader has on the
 *      day they read it is one that has already gone by. A correct value,
 *      rendered into a false claim.
 *
 * Instrument, as in the two files it follows: a real store, the real
 * `ai.ts`, the real provider budget; only `fetch` stubbed. The ledger is
 * written through `recordProviderCall` — the same call the wire path makes —
 * so every assertion is against the record the cap actually reads, and the
 * boundary tests are exact rather than approximate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-capfreetime-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    quit: () => undefined,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

import { addApiModel, recordProviderCall, reloadStore, updateSettings } from './database'
import {
  callAI,
  describeProviderCap,
  nextProviderCapFreeAt,
  providerBudget,
  providerKey,
  resetModelHealth,
  resetProviderSpend,
  type ProviderBudget
} from './ai'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const OPENROUTER = 'https://openrouter.ai/api/v1'
const ZEN = 'https://opencode.ai/zen/v1'
const KEY_A = 'sk-or-key-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-zen-key-bbbbbbbbbbbbbbb'

let wireCalls = 0

function stubTransport(init: { status?: number; content?: string; onCall?: () => void } = {}): void {
  const { status = 200, content = 'An ordinary answer.', onCall } = init
  wireCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      wireCalls++
      onCall?.()
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        text: () => Promise.resolve('rate limited')
      })
    })
  )
}

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

function addModels(baseUrl: string, apiKey: string, n: number, prefix = 'm'): void {
  for (let i = 0; i < n; i++) {
    addApiModel({
      name: `${prefix}${i}`,
      base_url: baseUrl,
      api_key: apiKey,
      model: `${prefix}${i}:free`,
      enabled: true
    } as never)
  }
}

function bucketOf(baseUrl: string, apiKey: string): string {
  return providerKey({ base_url: baseUrl, api_key: apiKey } as never)
}

/**
 * The ledger the assessment measured: 629 real requests against a cap of 50,
 * one a second apart, the first 50 automated and the rest manual.
 *
 * Built through `recordProviderCall` — the one function the wire path uses —
 * so `used` here is the count the cap compares, not a number this file keeps
 * about itself.
 */
function ledgerOf629(t0: number): string {
  const key = bucketOf(OPENROUTER, KEY_A)
  for (let i = 0; i < 629; i++) recordProviderCall(key, i >= 50, t0 + i * 1000)
  return key
}

/** The instant this ledger stops being capped, computed by walking the window. */
function freesAt(t0: number, cap: number): number {
  const ats = Array.from({ length: 629 }, (_, i) => t0 + i * 1000)
  return ats[629 - cap] + DAY
}

beforeEach(() => {
  wipe()
  resetModelHealth()
  resetProviderSpend()
  updateSettings({ base_cv: 'MASTER CV', provider_call_cap: 50 })
  wireCalls = 0
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. THE VALUE: the moment named is the moment the provider actually frees.
// ---------------------------------------------------------------------------

describe('the cap message names the moment the budget frees, not the moment it changes', () => {
  it('on the measured ledger the old value names an instant that is still capped', () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = ledgerOf629(t0)
    const budget = providerBudget(key)

    expect(budget.used).toBe(629)
    expect(budget.cap).toBe(50)

    // The old formula: the oldest in-window call plus one window. At that
    // instant the ledger holds 628 requests against a cap of 50 — so the
    // instant the message used to name was ~24h early, and the provider was
    // still refusing the user right through it.
    const oldFreeAt = t0 + DAY
    expect(providerBudget(key, oldFreeAt).used).toBe(628)
    expect(providerBudget(key, oldFreeAt).used).toBeGreaterThanOrEqual(50)

    // The fixed value: the instant `used` drops below the cap.
    expect(budget.freeAt).toBe(freesAt(t0, 50))
    expect(budget.freeAt).toBeGreaterThan(oldFreeAt)

    // Which is not a nicer number, it is the true one: exactly at `freeAt`
    // there is room again, and exactly one millisecond before there is not.
    expect(providerBudget(key, budget.freeAt!).used).toBe(49)
    expect(providerBudget(key, budget.freeAt! - 1).used).toBe(50)
  })

  it('a provider that is exactly at its cap still frees one window after its first call', () => {
    // The exact-fit case, which is the one the old formula got right, pinned
    // so the fix is a correction and not a change of convention: at
    // `used === cap`, index `used - cap` IS index 0.
    const t0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    for (let i = 0; i < 50; i++) recordProviderCall(key, false, t0 + i * 60 * 1000)

    expect(providerBudget(key).used).toBe(50)
    expect(providerBudget(key).freeAt).toBe(t0 + DAY)
  })

  it('one request over the cap moves the free time by one call, not by a window', () => {
    // The depth of the overage is the whole correction, so it is worth
    // seeing it move by exactly the right amount: 51 against 50 frees when
    // the 51st-oldest call leaves, one window after that call — a window
    // after the FIRST call is already too early, and one window after the
    // second is exactly right.
    const t0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    for (let i = 0; i < 51; i++) recordProviderCall(key, false, t0 + i * 60 * 1000)

    // 51 calls a minute apart, oldest at t0: index `used - cap` is 1, which is
    // t0 + 1min. So the budget frees a window after the SECOND call — a
    // window after the first is too early, and a window after the last is a
    // day too late.
    expect(providerBudget(key).freeAt).toBe(t0 + 60 * 1000 + DAY)
    expect(providerBudget(key, providerBudget(key).freeAt!).used).toBe(49)
  })

  it('there is no time to name while the spend is under the cap', () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    for (let i = 0; i < 49; i++) recordProviderCall(key, false, t0 + i * 1000)

    // Nothing is waiting on anything, so the field says so instead of naming
    // an instant for a wait that does not exist — which is what the old
    // `null ? 'shortly'` had to dress up, and "shortly" described nothing.
    const budget = providerBudget(key)
    expect(budget.used).toBe(49)
    expect(budget.freeAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. THE SENTENCE: it never puts a future time in the past, and it never
//    claims a day it does not name.
// ---------------------------------------------------------------------------

describe('the sentence about a capped provider never tells the user to come back too late', () => {
  it('a free time on another day says which day', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    ledgerOf629(t0)
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()

    // 629 calls, cap 50, oldest at 12:00 on the 10th. The budget frees ~9
    // minutes past noon on the 11th — which the old formatter rendered as a
    // bare "12:09 PM", and the only 12:09 PM on the 10th is one that has
    // already gone by.
    const err = await callAI('sys', 'go').then(
      () => null,
      (e: Error) => e
    )
    expect(err).not.toBeNull()
    const message = err!.message
    expect(message).toMatch(/call cap/i)
    // The calendar date, not a relative word — computed the same way the
    // formatter computes it, so the assertion is about WHICH day is named
    // rather than about the host's locale format.
    const freeAt = providerBudget(bucketOf(OPENROUTER, KEY_A)).freeAt!
    expect(message).toContain(
      new Date(freeAt).toLocaleDateString([], { day: 'numeric', month: 'short' })
    )
    // ...and the instant behind the words is a real one, in the future.
    expect(freeAt).toBeGreaterThan(Date.now())
  })

  it('never names the day relative to the reader, so a stored copy cannot rot', async () => {
    // "today" and "tomorrow" were the intermediate fix and they fail by the
    // same reasoning that motivated naming the day at all: this string is
    // persisted as the row's `lastError` and the Queue panel re-renders it on
    // every poll, so a copy outlives the moment it describes. "06:09 a.m.
    // tomorrow" read back the day after that is 24 hours in the past, with
    // nothing in it to say so. A date that has gone by is plainly a date that
    // has gone by; a relative word is not.
    const t0 = new Date(2026, 2, 10, 0, 30, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    // Exactly at the cap, first call at 00:30, so it frees 00:30 the NEXT day.
    for (let i = 0; i < 50; i++) recordProviderCall(key, false, t0 + i * 1000)
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()

    const err = await callAI('sys', 'go').then(
      () => null,
      (e: Error) => e
    )
    const freeAt = providerBudget(key).freeAt!
    // The day is the 11th, and it says WHICH one.
    expect(new Date(freeAt).getDate()).toBe(11)
    expect(err!.message).toContain(
      new Date(freeAt).toLocaleDateString([], { day: 'numeric', month: 'short' })
    )
    expect(err!.message).not.toMatch(/\b(today|tomorrow)\b/i)
    // The bare time is always paired with that date, so there is no version of
    // this sentence a reader can resolve to the wrong day.
    expect(err!.message).toMatch(/Budget frees at \d{1,2}[:.]\d{2}.* on /)
  })

  it('a free time an hour away is not dressed up with a date it does not need', () => {
    // The one case that keeps the bare time: a moment minutes away cannot be
    // stale, so naming its date would only make the sentence longer.
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    const budget: ProviderBudget = {
      key: 'k',
      label: 'openrouter.ai',
      used: 50,
      automated: 50,
      manual: 0,
      cap: 50,
      freeAt: t0 + 20 * 60_000,
      clockSkewed: false
    }
    const said = describeProviderCap(budget, t0)
    expect(said).toMatch(/Budget frees at \d/)
    expect(said).not.toMatch(/Budget frees at \d.* on /)
  })

  it('the day is judged against the `now` it is handed, not a second clock', () => {
    // m1. `clockTime` used to read `Date.now()` internally while this
    // function's freshness test was made against the `now` argument — two
    // clocks, so a caller passing a stale `now` got a sentence that had
    // already passed its own guard: with the wall clock an hour past
    // `freeAt` and a stale `now` in hand, it rendered a bare PAST time, which
    // is the original defect in miniature. One reading now decides both
    // questions, so they cannot disagree.
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0 + 2 * HOUR)

    const budget: ProviderBudget = {
      key: 'k',
      label: 'openrouter.ai',
      used: 50,
      automated: 50,
      manual: 0,
      cap: 50,
      freeAt: t0 + 60 * 60 * 1000,
      clockSkewed: false
    }
    // Read through a stale `now`, so the instant really is in the future as
    // far as this call is concerned...
    const said = describeProviderCap(budget, t0)
    expect(said).toMatch(/Budget frees at/)
    // ...and it must not read as a moment that has gone by, even though the
    // wall clock says it has.
    expect(said).not.toMatch(/not known yet/)
    expect(said).toContain(new Date(budget.freeAt!).toLocaleDateString([], {
      day: 'numeric',
      month: 'short'
    }))
  })

  it('a budget that is already free is described as available now, with no timestamp', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    for (let i = 0; i < 49; i++) recordProviderCall(key, false, t0 + i * 1000)
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()

    // Under the cap, so this call goes out — which is the point: "available
    // now" is a statement the cap is willing to make, and it is only ever
    // reached when there really is no wait to describe.
    expect(providerBudget(key).freeAt).toBeNull()
    await callAI('sys', 'go')
    expect(wireCalls).toBe(1)
  })

  it('never claims a time that has already passed, when the ledger and the clock disagree', () => {
    // `windowFreesAt` is an identity: for any `now`, this provider is over
    // its cap exactly when `freeAt > now`, so a consistent ledger cannot
    // produce a stale instant. What can is a budget READ through one clock
    // and FORMATTED through another, which is what `callAI`'s pre-filter
    // does — it reads every budget at the top and formats them further down.
    // So the guard is pinned here, where a stale instant can be handed
    // directly: the rule is that the sentence must not repeat a moment that
    // has gone by, and the queue does not go quiet on this — it re-reads the
    // ledger on the next pass and names a fresh one.
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    const key = bucketOf(OPENROUTER, KEY_A)
    for (let i = 0; i < 50; i++) recordProviderCall(key, false, t0 + i * 60_000)

    const budget = providerBudget(key, t0)
    expect(budget.freeAt).not.toBeNull()

    // Read at t0, so the free time is a real future instant...
    const asRead = describeProviderCap(budget, t0)
    expect(asRead).toMatch(/Budget frees at/)
    // ...and formatted a millisecond after it, which must not claim it.
    const tooLate = describeProviderCap(budget, budget.freeAt!)
    expect(tooLate).toMatch(/call cap/i)
    expect(tooLate).not.toMatch(/Budget frees at/)
    expect(tooLate).toMatch(/re-checked every pass/)
    // The spend is still reported: dropping the time is not the same as
    // dropping the fact.
    expect(tooLate).toMatch(/in the last 24h/)
  })

  it('a stamp dated in the future does not produce a free time in the past', async () => {
    // `Date.now()` earlier than a stored stamp: the clock moved backwards, or
    // was wrong when the call was written. The window is one-sided on
    // purpose, so such a stamp counts rather than being deleted, and the
    // free time derived from it has to stay in the future.
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)
    updateSettings({ provider_call_cap: 1 })

    const key = bucketOf(OPENROUTER, KEY_A)
    // One call stamped 2h AHEAD of now — inside the skew tolerance, so it is
    // real spend and still counts, and the provider is over its cap of 1.
    recordProviderCall(key, false, t0 + 2 * HOUR)
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()

    const budget = providerBudget(key)
    expect(budget.clockSkewed).toBe(false)
    expect(budget.used).toBe(1)
    expect(typeof budget.freeAt).toBe('number')
    expect(budget.freeAt!).toBeGreaterThan(Date.now())

    const err = await callAI('sys', 'go').then(
      () => null,
      (e: Error) => e
    )
    expect(err).not.toBeNull()
    // A future instant, and named as one — not the stale-time fallback.
    expect(err!.message).not.toMatch(/not known yet/)
    expect(err!.message).toContain(
      new Date(budget.freeAt!).toLocaleDateString([], { day: 'numeric', month: 'short' })
    )
  })
})

// ---------------------------------------------------------------------------
// 3. SEVERAL PROVIDERS: the row parks until the earliest one that could
//    actually serve it, and that is measured, not assumed.
// ---------------------------------------------------------------------------

describe('with several capped providers the row waits for the earliest real one', () => {
  it('a deep overage on the oldest ledger frees LATER than a shallow one on a newer ledger', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)
    updateSettings({ provider_call_cap: 50 })

    // OpenRouter holds the OLDEST call in the ledger and is the deepest in
    // debt: 629 against 50. Its budget needs 580 of them to age out.
    const or = ledgerOf629(t0)
    expect(providerBudget(or).freeAt).toBe(freesAt(t0, 50))

    // Zen is over its cap by ONE, and its oldest call is 100s newer than
    // OpenRouter's. One call ageing out is enough for it, so it is the first
    // provider that could actually answer — even though the old formula,
    // which read only the oldest call, ranked OpenRouter ahead of it on
    // every provider in the pool.
    const zen = bucketOf(ZEN, KEY_B)
    for (let i = 0; i < 51; i++) recordProviderCall(zen, false, t0 + 100_000 + i * 60_000)
    expect(providerBudget(zen).freeAt).toBe(t0 + 160_000 + DAY)

    addModels(OPENROUTER, KEY_A, 1, 'or')
    addModels(ZEN, KEY_B, 1, 'zen')
    stubTransport()

    // The soonest free time across every capped, eligible provider — which is
    // what the queue parks a row until.
    expect(nextProviderCapFreeAt()).toBe(providerBudget(zen).freeAt)

    // And it is the earliest instant a request can actually go out: refused
    // right up to it, accepted at it.
    vi.setSystemTime(providerBudget(zen).freeAt! - 1)
    resetModelHealth()
    stubTransport({ status: 429 })
    await callAI('sys', 'go').catch(() => undefined)
    expect(wireCalls).toBe(0)

    vi.setSystemTime(providerBudget(zen).freeAt!)
    resetModelHealth()
    stubTransport()
    await callAI('sys', 'go')
    expect(wireCalls).toBeGreaterThan(0)
  })
})