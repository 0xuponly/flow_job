/**
 * THE PER-PROVIDER SPEND CAP, measured in provider calls.
 *
 * Same instrument as spendBound.test.ts and for the same reason: the queue's
 * own `attempts` counter can be made to disagree with reality (the rv3money
 * review mutated `recordModelFailure` into computing a 429 backoff and
 * discarding it — double the real spend, every queue-level test still green).
 * So every assertion below counts `fetch` calls, and the ledger is checked
 * against that count rather than trusted.
 *
 * A real store, the real `ai.ts`, the real processor. The only thing stubbed
 * is the transport, because the whole claim spans modules: the bucket is
 * derived in ai.ts, the record is persisted by database.ts, the origin comes
 * off a queue row in aiQueue.ts, and a mock at any of those would prove
 * nothing about the other two.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

// Own userData directory, like docsAutoQueue.store.test.ts: vitest runs test
// FILES in parallel and the shared store is driven by other real-store suites,
// which would wipe this file's ledger mid-run. Hoisted because the electron
// mock factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-spendcap-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
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
  clearAIQueue,
  createDocument,
  createJob,
  getAIQueue,
  getProviderSpend,
  getSettings,
  reloadStore,
  updateSettings
} from './database'
import {
  ProviderCapError,
  RateLimitError,
  callAI,
  providerBudget,
  providerKey,
  resetModelHealth,
  resetProviderSpend
} from './ai'
import { processQueue } from './aiQueue'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** The user's actual pool shape: one OpenRouter credential, one Zen one. */
const OPENROUTER = 'https://openrouter.ai/api/v1'
const OPENROUTER_KEY = 'sk-or-free-tier-key-aaaaaaaa'
const ZEN = 'https://opencode.ai/zen/v1'
const ZEN_KEY = 'zen-account-key-bbbbbbbb'

// ---------------------------------------------------------------------------
// The transport. Every test counts what reaches it, because that is what the
// user pays for.
// ---------------------------------------------------------------------------

let calls = 0

interface TransportInit {
  /** HTTP status. 429 is the default: it makes the rotation walk the whole
   *  pool instead of stopping at the first success, which is the case the
   *  cap has to bound. */
  status?: number
  /** A body for a 200 response. Default: something no call site rejects. */
  content?: string
  /** Throw instead of answering — a timeout or a dead socket. */
  throws?: string
}

function stubTransport(init: TransportInit = {}): void {
  const { status = 429, content = 'A perfectly ordinary answer.', throws } = init
  vi.stubGlobal('fetch', vi.fn(() => {
    calls++
    if (throws) return Promise.reject(new Error(throws))
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      text: () => Promise.resolve('rate limited')
    })
  }))
}

/** Requests this provider has actually been asked for, straight off the wire. */
function onTheWire(): number {
  return calls
}

/** Total calls the app believes it made, across every bucket. */
function recordedTotal(): number {
  return Object.values(getProviderSpend()).reduce((n, calls) => n + calls.length, 0)
}

function wipe() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

/** `n` models on one credential — the free-model shape that broke the bound. */
function addModels(baseUrl: string, apiKey: string, n: number, prefix = 'm'): string[] {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const models = addApiModel({
      name: `${prefix}${i}`,
      base_url: baseUrl,
      api_key: apiKey,
      model: `${prefix}${i}:free`,
      enabled: true
    })
    ids.push(models[models.length - 1].id)
  }
  return ids
}

/** One job with a CV, enough for a `verify` row to have something to review. */
let jobSeq = 0
function jobWithCv(): { jobId: number; documentId: number } {
  jobSeq += 1
  // Distinct on every field the dedupe looks at, so three jobs in one test
  // cannot collide on company+title+location.
  const { job } = createJob({
    title: `Engineer ${jobSeq}`,
    company: `Acme ${jobSeq}`,
    location: 'Remote',
    url: `https://example.com/spendcap/${jobSeq}`,
    description: 'JD'
  })
  const doc = createDocument('cv', 'CV', 'CONTENT', job.id)
  return { jobId: job.id, documentId: doc.id }
}

beforeEach(() => {
  wipe()
  clearAIQueue()
  // In-process health AND the persisted ledger. A test that starts with
  // someone else's spend is not measuring the cap.
  resetModelHealth()
  resetProviderSpend()
  updateSettings({ base_cv: 'MASTER CV', auto_doc_min_fit: 40 })
  calls = 0
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. THE BUCKET: one credential is one budget, twenty models is not twenty.
// ---------------------------------------------------------------------------

describe('the provider key is the credential, not the model', () => {
  /** Configure `n` models on one credential and hand back their configs. */
  function models(baseUrl: string, apiKey: string, n: number, prefix: string) {
    addModels(baseUrl, apiKey, n, prefix)
    return Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      name: `${prefix}${i}`,
      base_url: baseUrl,
      api_key: apiKey,
      model: `${prefix}${i}:free`,
      enabled: true
    }))
  }

  it('twenty free OpenRouter models on one key are ONE bucket', () => {
    const keys = new Set(models(OPENROUTER, OPENROUTER_KEY, 20, 'or').map((m) => providerKey(m as never)))
    // The number that matters: a per-model cooldown is what left this
    // credential unbounded, so the bucket has to be the credential's.
    expect(keys.size).toBe(1)
  })

  it("a pool like the user's is exactly TWO buckets: openrouter and opencode/zen", () => {
    // 20 free models on the OpenRouter key, 3 free models on the Zen
    // account. Two credentials, two quotas, two budgets — and emphatically
    // not one bucket for everything (which would let one provider's
    // exhaustion silence the other) and not twenty-three.
    const pool = [...models(OPENROUTER, OPENROUTER_KEY, 20, 'or'), ...models(ZEN, ZEN_KEY, 3, 'zen')]
    const keys = new Set(pool.map((m) => providerKey(m as never)))
    expect(pool).toHaveLength(23)
    expect(keys.size).toBe(2)
  })

  it('a different base URL is a different provider, whatever the model is called', () => {
    const a = providerKey({ id: '1', name: 'x', base_url: OPENROUTER, api_key: 'k', model: 'deepseek/deepseek-r1' } as never)
    const b = providerKey({ id: '2', name: 'x', base_url: ZEN, api_key: 'k', model: 'deepseek/deepseek-r1' } as never)
    expect(a).not.toBe(b)
  })

  it('a different KEY on the same host is a different budget', () => {
    // Each key has its own allowance, and the thing being protected is the
    // key, so the bucket cannot stop at the host.
    const a = providerKey({ id: '1', name: 'x', base_url: OPENROUTER, api_key: 'key-one-aaaaaaaaaaaa', model: 'a' } as never)
    const b = providerKey({ id: '1', name: 'x', base_url: OPENROUTER, api_key: 'key-two-bbbbbbbbbbbb', model: 'a' } as never)
    expect(a).not.toBe(b)
  })

  it('the SAME endpoint spelled two ways is one provider', () => {
    // A trailing slash, or a different case, is not a different provider.
    // Two spellings of one key would give one credential two budgets.
    const a = providerKey({ id: '1', name: 'x', base_url: OPENROUTER, api_key: 'k', model: 'a' } as never)
    const b = providerKey({ id: '1', name: 'x', base_url: `${OPENROUTER}/`, api_key: 'k', model: 'a' } as never)
    const c = providerKey({ id: '1', name: 'x', base_url: 'https://OpenRouter.AI/api/v1', api_key: 'k', model: 'a' } as never)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('never puts the key, or any fragment of it, in the bucket', () => {
    const key = providerKey({ id: '1', name: 'x', base_url: OPENROUTER, api_key: OPENROUTER_KEY, model: 'a' } as never)
    expect(key).not.toContain(OPENROUTER_KEY)
    expect(key).not.toContain(OPENROUTER_KEY.slice(0, 6))
    expect(key).not.toContain(OPENROUTER_KEY.slice(-4))
  })

  it('an UNCLASSIFIABLE base URL gets its own bucket, and never a real provider\'s', () => {
    // Fail safe, and specifically: an unknown model must not be able to
    // drain a live provider's budget by landing in its bucket, and it must
    // not silence the pool either by landing in a shared "unknown" one.
    const live = providerKey({ id: 'live', name: 'live', base_url: OPENROUTER, api_key: OPENROUTER_KEY, model: 'a' } as never)
    const odd1 = providerKey({ id: 'odd1', name: 'odd', base_url: 'not a url', api_key: OPENROUTER_KEY, model: 'a' } as never)
    const odd2 = providerKey({ id: 'odd2', name: 'odd', base_url: 'not a url', api_key: OPENROUTER_KEY, model: 'a' } as never)
    const empty = providerKey({ id: 'odd3', name: 'odd', base_url: '', api_key: OPENROUTER_KEY, model: 'a' } as never)

    expect(odd1).not.toBe(live)
    // ...and no two unclassifiable models are silently lumped together,
    // because there is no evidence they share a credential.
    expect(odd2).not.toBe(odd1)
    expect(empty).not.toBe(odd1)
  })

  it('an unclassifiable model is STILL capped, per its own bucket', async () => {
    // One model, cap of 2: the rotation can only spend what it has models
    // for, so the bound is shown across three passes rather than one.
    updateSettings({ provider_call_cap: 2 })
    addModels('not a url', 'k', 1, 'odd')
    stubTransport()

    await expect(callAI('sys', 'one')).rejects.toThrow()
    // Read the bucket the app actually created rather than re-deriving it:
    // an unclassifiable bucket is keyed by the model's own store id.
    const oddKey = Object.keys(getProviderSpend())[0]
    expect(oddKey).toBeDefined()
    expect(onTheWire()).toBe(1)
    resetModelHealth()
    await expect(callAI('sys', 'two')).rejects.toThrow()
    expect(onTheWire()).toBe(2)
    expect(providerBudget(oddKey).used).toBe(2)

    // Capped, exactly like a real provider.
    resetModelHealth()
    await expect(callAI('sys', 'three')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(2)
  })

  it('three unclassifiable models do NOT share one budget', async () => {
    // The other half of "its own bucket", and the reason it is per-model
    // rather than one shared `unknown`: lumping them together would let a
    // base URL the app cannot parse go dark the whole pool, which is the
    // silent-bucketing failure this design exists to avoid. Three unknown
    // endpoints, three budgets.
    updateSettings({ provider_call_cap: 1 })
    addModels('not a url', 'k', 3, 'odd')
    stubTransport()

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(3)
    expect(Object.keys(getProviderSpend())).toHaveLength(3)
  })

  it('the default cap is the documented free-tier allowance', () => {
    // `beforeEach` wiped the store, so nothing has ever written this key:
    // what is read here is the default every existing user gets, not a
    // value this file put there.
    expect(getSettings().provider_call_cap).toBe(50)
  })

  it('a cap that cannot be read resolves to the default, never to unbounded', () => {
    // "Unreadable" is the dangerous case, so it is checked twice: on load
    // (the normaliser) and on read (the resolver in ai.ts, which covers the
    // window between a bad write and the next restart).
    for (const bad of ['lots', null, NaN, Infinity]) {
      updateSettings({ provider_call_cap: bad as never })
      reloadStore()
      expect(getSettings().provider_call_cap, String(bad)).toBe(50)
      updateSettings({ provider_call_cap: bad as never })
      expect(providerBudget('any').cap, String(bad)).toBe(50)
    }
  })

  it('an out-of-range cap clamps to the bound, never to zero and never off', async () => {
    // A hand-typed 0 is the interesting one: "off" would mean unbounded,
    // which is the opposite of what this setting is for, so the floor is 1.
    // `persistStore` chains its write onto a promise, so each reload waits
    // a macrotask for the file to catch up — otherwise the reload reads the
    // store as it stood BEFORE the write and asserts nothing.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    updateSettings({ provider_call_cap: 0 })
    expect(providerBudget('any').cap).toBe(1)
    await flush()
    reloadStore()
    expect(getSettings().provider_call_cap).toBe(1)

    updateSettings({ provider_call_cap: -5 })
    expect(providerBudget('any').cap).toBe(1)

    // And the ceiling, for the user who knows their provider's real quota.
    updateSettings({ provider_call_cap: 99_999 })
    expect(providerBudget('any').cap).toBe(5000)
    await flush()
    reloadStore()
    expect(getSettings().provider_call_cap).toBe(5000)

    // A value the user chose, in range, is untouched.
    updateSettings({ provider_call_cap: 250 })
    await flush()
    reloadStore()
    expect(getSettings().provider_call_cap).toBe(250)
  })
})

// ---------------------------------------------------------------------------
// 2. THE BOUND: one rotation, twenty models, one credential.
// ---------------------------------------------------------------------------

describe('a rotation cannot spend past the cap', () => {
  it('twenty models on one credential issue AT MOST the cap in a single pass', async () => {
    updateSettings({ provider_call_cap: 3 })
    addModels(OPENROUTER, OPENROUTER_KEY, 20)
    stubTransport()

    // Every model 429s, so the rotation walks the entire pool rather than
    // stopping at the first success — which is exactly the situation that
    // made the credential unbounded: twenty per-model cooldowns, twenty
    // calls, one key.
    await expect(callAI('sys', 'user')).rejects.toThrow()

    expect(onTheWire()).toBe(3)
    // ...and the app's own record agrees with the wire, which is the whole
    // point: the ledger is not a second opinion, it is the same fact.
    expect(recordedTotal()).toBe(3)
  })

  it('a SECOND rotation at the cap issues zero calls', async () => {
    updateSettings({ provider_call_cap: 3 })
    addModels(OPENROUTER, OPENROUTER_KEY, 20)
    stubTransport()

    await expect(callAI('sys', 'user')).rejects.toThrow()
    const afterFirst = onTheWire()
    expect(afterFirst).toBe(3)

    // Health is cleared so the 429 cooldown CANNOT be what stops this — the
    // budget is the only guard left standing, and it has to hold alone.
    resetModelHealth()

    await expect(callAI('sys', 'other prompt')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(afterFirst)
  })

  it('the refusal names the provider, the spend, and when it frees up', async () => {
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 3)
    stubTransport()

    await expect(callAI('sys', 'user')).rejects.toThrow(ProviderCapError)
    resetModelHealth()
    const err = await callAI('sys', 'user 2').catch((e: Error) => e)

    // Specific enough to act on: which provider, how much of its budget is
    // gone, and — the part that matters most — that the user's own actions
    // are unaffected, because "the app is broken" is the reading they would
    // otherwise take.
    expect(err.message).toContain('openrouter.ai')
    expect(err.message).toMatch(/2 automated of 2 in the last 24h/)
    expect(err.message).toMatch(/frees at/i)
    expect(err.message).toMatch(/Generate, Regenerate, Verify and Tailor still run/)
    // No key, and no provider id, in the message the queue panel shows.
    expect(err.message).not.toContain(OPENROUTER_KEY)
  })

  it('it is a RateLimitError, so the queue parks the work instead of failing it', () => {
    // Not cosmetic: the processor's retry shape keys on exactly this, and a
    // cap that arrived as a plain Error would burn a row's whole retry
    // budget on a limit that resets tomorrow by itself.
    expect(new ProviderCapError('x')).toBeInstanceOf(RateLimitError)
  })
})

// ---------------------------------------------------------------------------
// 3. SEPARATION: two credentials, two budgets.
// ---------------------------------------------------------------------------

describe('exhausting one provider does not silence the other', () => {
  it('the second provider keeps serving after the first is spent', async () => {
    // The user's actual pool, built up in the order the failure happened:
    // twenty free OpenRouter models first, then the Zen account.
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 20, 'or')
    stubTransport()
    const orKey = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)

    // Drain OpenRouter on its own. Twenty models, one credential, two calls:
    // the per-model cooldown is what used to make this twenty.
    await expect(callAI('sys', 'openrouter please')).rejects.toThrow()
    const drainedWire = onTheWire()
    expect(drainedWire).toBe(2)
    expect(providerBudget(orKey).used).toBe(2)
    expect(providerBudget(orKey).freeAt).not.toBeNull()

    // Now the Zen account is added. The rotation walks PAST every OpenRouter
    // model — all six of them are refused, at zero cost — and spends on the
    // other credential, which is entirely unaffected.
    addModels(ZEN, ZEN_KEY, 3, 'zen')
    resetModelHealth()
    stubTransport()
    const zenKey = providerKey({ base_url: ZEN, api_key: ZEN_KEY } as never)
    expect(providerBudget(zenKey).used).toBe(0)

    await expect(callAI('sys', 'zen please')).rejects.toThrow(ProviderCapError)

    // Zen spent its own budget of 2, and OpenRouter's stayed at 2: the two
    // ledgers are independent, and the wire moved exactly as much as Zen did
    // and not one call more for the six models it walked past.
    expect(providerBudget(zenKey).used).toBe(2)
    expect(providerBudget(orKey).used).toBe(2)
    expect(onTheWire()).toBe(drainedWire + 2)
  })

  it('both budgets are independent, and only both being spent stops the pool', async () => {
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 4, 'or')
    addModels(ZEN, ZEN_KEY, 4, 'zen')
    stubTransport()

    // Drain both, resetting health between so neither the 429 cooldown nor
    // an unrelated failure can be what ends the rotation.
    for (const prompt of ['a', 'b', 'c', 'd']) {
      resetModelHealth()
      await callAI('sys', prompt).catch(() => undefined)
    }
    const total = recordedTotal()
    expect(total).toBe(4)
    expect(onTheWire()).toBe(4)

    // Four calls for a pool of eight models at a cap of two each: the
    // bound is per provider, so it is 2 + 2 and not 2 overall.
    expect(total).toBe(4)

    resetModelHealth()
    const err = await callAI('sys', 'e').catch((e: Error) => e)
    expect(err).toBeInstanceOf(ProviderCapError)
    expect(onTheWire()).toBe(4)
    // Both providers named, because both are the reason.
    expect(err.message).toContain('openrouter.ai')
    expect(err.message).toContain('opencode.ai')
  })

  it('one credential exhausts only its OWN models', async () => {
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, OPENROUTER_KEY, 4, 'or')
    addModels(ZEN, ZEN_KEY, 4, 'zen')
    stubTransport()

    await callAI('sys', 'a').catch(() => undefined)
    resetModelHealth()

    const orKey = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)
    const zenKey = providerKey({ base_url: ZEN, api_key: ZEN_KEY } as never)
    expect(providerBudget(orKey).used).toBe(1)
    expect(providerBudget(zenKey).used).toBe(1)
    expect(providerBudget(orKey).freeAt).not.toBeNull()
    expect(providerBudget(zenKey).freeAt).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. THE WINDOW: rolling, so it cannot be gamed by waiting for midnight.
// ---------------------------------------------------------------------------

describe('the cap is a rolling window, not a calendar day', () => {
  it('crossing midnight does NOT reset it', async () => {
    // 23:30 on the 10th, cap of 2 on two models.
    const late = new Date(2026, 2, 10, 23, 30, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(late)
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport()

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(2)

    // Half an hour later it is the 11th. A calendar-day cap would be fresh
    // and fully available; this one is unchanged.
    vi.setSystemTime(late + 30 * 60 * 1000)
    resetModelHealth()
    await expect(callAI('sys', 'after midnight')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(2)
  })

  it('the budget frees as the window slides, one full day after the FIRST call', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport()

    await expect(callAI('sys', 'first')).rejects.toThrow()
    expect(onTheWire()).toBe(2)
    const key = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)
    // The oldest in-window call is the one that frees first.
    expect(providerBudget(key).freeAt).toBe(t0 + DAY)

    // 23h in, the second call is still inside the window and the budget is
    // still full.
    vi.setSystemTime(t0 + 23 * HOUR)
    resetModelHealth()
    await expect(callAI('sys', '23h')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(2)

    // Past 24h from the FIRST call, that call has aged out and the provider
    // is available again — without any midnight having been involved.
    vi.setSystemTime(t0 + DAY + 1)
    resetModelHealth()
    const before = onTheWire()
    await callAI('sys', 'after the window').catch(() => undefined)
    expect(onTheWire()).toBeGreaterThan(before)
    expect(providerBudget(key).used).toBeGreaterThan(0)
  })

  it('the record is pruned to the window, so it cannot grow forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    updateSettings({ provider_call_cap: 1000 })
    addModels(OPENROUTER, OPENROUTER_KEY, 1)
    stubTransport({ status: 200 })
    const key = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)

    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(t0 + i * HOUR)
      await callAI('sys', `p${i}`).catch(() => undefined)
    }
    expect(getProviderSpend()[key]).toHaveLength(5)

    // Two days later: every one of those has aged out of the window, so the
    // persisted record does not keep them (and does not keep costing disk).
    vi.setSystemTime(t0 + 2 * DAY + 1)
    resetModelHealth()
    await callAI('sys', 'much later').catch(() => undefined)
    expect(getProviderSpend()[key]).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. SURVIVES A RESTART. A budget a relaunch hands back is not a budget.
// ---------------------------------------------------------------------------

describe('the cap outlives the process', () => {
  it('a store reload — the restart — finds the budget already spent', async () => {
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport()

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(2)

    // What a relaunch does: throw away every scrap of in-memory state and
    // read the store back off disk. `persistStore` chains its write onto a
    // promise, so the macrotask yield is what a real process boundary gives
    // us for free (same shape as review.enqueueCallSites.test.ts's restart).
    await new Promise((resolve) => setTimeout(resolve, 0))
    resetModelHealth()
    reloadStore()
    stubTransport()

    const atRestart = onTheWire()
    await expect(callAI('sys', 'after restart')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(atRestart)
  })

  it('the ledger is in the store, not in a module variable', async () => {
    updateSettings({ provider_call_cap: 5 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport()

    await callAI('sys', 'user').catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Read it back through the raw store accessors rather than through
    // ai.ts, so this asserts where the fact LIVES.
    const written = getProviderSpend()
    const keys = Object.keys(written)
    expect(keys).toHaveLength(1)
    expect(written[keys[0]].length).toBe(2)
    expect(written[keys[0]][0]).toMatchObject({ manual: false })
    expect(typeof written[keys[0]][0].at).toBe('number')
  })

  it('the setting itself survives the restart', async () => {
    updateSettings({ provider_call_cap: 7 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    reloadStore()
    expect(getSettings().provider_call_cap).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// 6. A REQUEST MADE AND FAILED IS STILL SPEND.
//    This is the failure the whole thing started from: a provider notice
//    arrives as HTTP 200 and used to be counted as a success.
// ---------------------------------------------------------------------------

describe('every request that goes out is counted, whatever comes back', () => {
  beforeEach(() => {
    addModels(OPENROUTER, OPENROUTER_KEY, 1)
  })

  const key = () => providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)

  it('a 429 counts', async () => {
    updateSettings({ provider_call_cap: 50 })
    stubTransport({ status: 429 })

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(1)
    expect(providerBudget(key()).used).toBe(1)
  })

  it('a timeout counts — the request was made, and it cost the whole budget', async () => {
    updateSettings({ provider_call_cap: 50 })
    stubTransport({ throws: 'The operation was aborted' })

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(1)
    expect(providerBudget(key()).used).toBe(1)
  })

  it('a network error counts', async () => {
    updateSettings({ provider_call_cap: 50 })
    stubTransport({ throws: 'ECONNRESET' })

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(onTheWire()).toBe(1)
    expect(providerBudget(key()).used).toBe(1)
  })

  it('an HTTP 200 carrying a BILLING NOTICE counts — the failure this started from', async () => {
    // Not a 402 and not a 429: an ordinary 200 whose body is the provider
    // telling us the account is out of credit. It used to take the success
    // branch, which DELETED the model's health entry, so an out-of-credit
    // provider looked healthy precisely because it was failing.
    updateSettings({ provider_call_cap: 50 })
    stubTransport({
      status: 200,
      content:
        "The account behind this API key doesn't have enough credits. " +
        'This model needs paid Pollen. Please [top up](https://pollinations.ai/top-up), then try again.'
    })

    await expect(callAI('sys', 'user')).rejects.toThrow(/billing|quota notice/i)
    expect(onTheWire()).toBe(1)
    expect(providerBudget(key()).used).toBe(1)
  })

  it('a refused request is NOT counted — it never went out', async () => {
    // The mirror image, and the one that would make the number a lie in the
    // other direction: 100 refusals must not look like 100 requests.
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 8, 'more')
    stubTransport({ status: 429 })

    await expect(callAI('sys', 'user')).rejects.toThrow()
    for (let i = 0; i < 5; i++) {
      resetModelHealth()
      await expect(callAI('sys', `prompt ${i}`)).rejects.toThrow(ProviderCapError)
    }
    expect(onTheWire()).toBe(2)
    expect(providerBudget(key()).used).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 7. NEVER A DEAD END: a person's own action always runs, and is counted.
// ---------------------------------------------------------------------------

describe('manual work is never capped — and is never free', () => {
  it('a manual call at the cap still goes out', async () => {
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 4)
    stubTransport({ status: 429 })

    await expect(callAI('sys', 'auto one')).rejects.toThrow()
    resetModelHealth()
    await expect(callAI('sys', 'auto two')).rejects.toThrow(ProviderCapError)
    expect(onTheWire()).toBe(2)

    // At the cap. The user pressed a button; the request happens — on all
    // four models if the rotation needs them, which is the point: manual work
    // is not rationed, it is only counted.
    resetModelHealth()
    stubTransport({ status: 200 })
    const result = await callAI('sys', 'manual', 0.7, 45_000, undefined, undefined, undefined, { manual: true })
    expect(result.content).not.toBeNull()
    expect(onTheWire()).toBe(3)
  })

  it('...and it is counted, so clicking repeatedly cannot spend without bound', async () => {
    updateSettings({ provider_call_cap: 2 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport({ status: 200 })
    const key = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)

    for (let i = 0; i < 4; i++) {
      await callAI('sys', `manual ${i}`, 0.7, 45_000, undefined, undefined, undefined, { manual: true })
    }
    expect(onTheWire()).toBe(4)
    const budget = providerBudget(key)
    expect(budget.used).toBe(4)
    // Split, so the two kinds stay legible in the number rather than
    // blending into one total the user cannot act on.
    expect(budget.manual).toBe(4)
    expect(budget.automated).toBe(0)
  })

  it('manual and automated calls share the one budget', async () => {
    updateSettings({ provider_call_cap: 3 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    stubTransport({ status: 200 })
    const key = providerKey({ base_url: OPENROUTER, api_key: OPENROUTER_KEY } as never)

    await callAI('sys', 'auto', 0.7, 45_000)
    await callAI('sys', 'manual', 0.7, 45_000, undefined, undefined, undefined, { manual: true })
    const budget = providerBudget(key)
    expect(budget.automated).toBe(1)
    expect(budget.manual).toBe(1)
    // ...and the third automated call is refused, because the manual one
    // spent real budget on the same credential.
    resetModelHealth()
    await callAI('sys', 'auto 2', 0.7, 45_000).catch(() => undefined)
    await callAI('sys', 'auto 3', 0.7, 45_000).catch(() => undefined)
    expect(providerBudget(key).used).toBe(3)
  })

  it('the origin travels off the queue row: a MANUAL row runs at the cap', async () => {
    // The end-to-end version, through the real processor, because the
    // plumbing that matters is `manualQueued` on the row becoming `{ manual:
    // true }` at the request. Testing callAI's flag alone would leave that
    // hop unproven — and it is exactly the hop a future change could break
    // in the one direction that silently re-introduces the dead end.
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, OPENROUTER_KEY, 2)
    const { jobId, documentId } = jobWithCv()
    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: true })
    stubTransport({ status: 200, content: '{"score":90,"passed":true,"feedback":"ok"}' })

    // The user's Verify runs.
    await processQueue()
    expect(onTheWire()).toBe(1)

    // The budget is now spent, so a row the APP queued is refused — while the
    // user's own keeps working.
    const second = jobWithCv()
    addAIQueueItem({ type: 'verify', jobId: second.jobId, documentId: second.documentId, manualQueued: false })
    const before = onTheWire()
    await processQueue()
    expect(onTheWire()).toBe(before)

    const third = jobWithCv()
    addAIQueueItem({ type: 'verify', jobId: third.jobId, documentId: third.documentId, manualQueued: true })
    await processQueue()
    expect(onTheWire()).toBe(before + 1)

    // The automatic row is parked, not failed: the work is still wanted and
    // the provider will be affordable again in a day.
    const parked = getAIQueue().find((q) => q.jobId === second.jobId)
    expect(parked?.status).toBe('pending')
    expect(parked?.lastError).toMatch(/call cap/i)
  })
})

// ---------------------------------------------------------------------------
// 8. THE ACCOUNTING HAS TEETH.
// ---------------------------------------------------------------------------

describe('the ledger and the wire are the same fact', () => {
  it('every counted call is a request that went out, and vice versa', async () => {
    updateSettings({ provider_call_cap: 50 })
    addModels(OPENROUTER, OPENROUTER_KEY, 3, 'or')
    addModels(ZEN, ZEN_KEY, 3, 'zen')
    stubTransport({ status: 200 })

    for (const prompt of ['a', 'b', 'c']) {
      await callAI('sys', prompt).catch(() => undefined)
    }

    // Coalescing means one request per distinct prompt, not three per
    // rotation, so the ledger must equal the wire EXACTLY — not a per-model
    // estimate of it.
    expect(recordedTotal()).toBe(onTheWire())
    expect(recordedTotal()).toBe(3)
  })

  it('a successful rotation that coalesces still costs one call, not one per model', async () => {
    updateSettings({ provider_call_cap: 50 })
    addModels(OPENROUTER, OPENROUTER_KEY, 5)
    stubTransport({ status: 200 })

    const result = await callAI('sys', 'same prompt')
    expect(result.content).not.toBeNull()
    // The rotation stops at the first success, and the ledger says so.
    expect(onTheWire()).toBe(1)
    expect(recordedTotal()).toBe(1)
  })
})