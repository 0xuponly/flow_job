/**
 * WHAT A CAPPED PROVIDER DOES TO WORK IT REFUSED.
 *
 * The companion to providerSpendCap.test.ts, which owns the bound (how many
 * requests may leave). This file owns the other half: what happens to the
 * work when the bound is already spent. The gap between those two is where
 * the spend cap was unsound — the bound held, and the queue still destroyed
 * the work it existed to protect:
 *
 *   1. `score_fit` was DELETED at the cap rather than parked. The job's fit
 *      was scored by the fallback, the row was read as done, and there was
 *      nothing left to pick up later.
 *   2. every automated lane BURNED its retry budget on the cap — ten
 *      attempts, then three revivals four hours apart — and reached terminal
 *      `failed` at 22.07h into a 24h window, with the provider still capped
 *      and ~1.9h of budget left to free.
 *
 * and the three ways a provider could be silenced for good:
 *
 *   3. editing a model's API key re-bucketed the account and handed it a
 *      full allowance again;
 *   4. the persisted ledger only ever grew, one key per credential ever typed;
 *   5. a machine whose clock was once wrong kept every entry inside the
 *      window, with no way back except a test-only export.
 *
 * Same instrument as the file it follows: a real store, the real `ai.ts`,
 * the real processor, only `fetch` stubbed. Nothing here trusts a counter
 * the app keeps about itself — every assertion is against the transport, the
 * persisted ledger, or a queue row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-spendcap-recovery-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
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
  // The score_fit lane emits `job:scoreUpdated` to every open window, so the
  // mock needs the static that goes with it.
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
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
  getJob,
  getProviderSpend,
  listApiModels,
  recordProviderCall,
  reloadStore,
  saveApiModels,
  updateJob,
  updateSettings
} from './database'
import { callAI, providerBudget, providerKey, resetModelHealth, resetProviderSpend } from './ai'
import { processQueue } from './aiQueue'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const OPENROUTER = 'https://openrouter.ai/api/v1'
const KEY_A = 'sk-or-key-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-or-key-bbbbbbbbbbbbbbbb'

let calls = 0

function stubTransport(init: { status?: number; content?: string } = {}): void {
  const { status = 429, content = 'An ordinary answer.' } = init
  calls = 0
  vi.stubGlobal('fetch', vi.fn(() => {
    calls++
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      text: () => Promise.resolve('rate limited')
    })
  }))
}

function wipe() {
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

let jobSeq = 0
function jobWithCv(): { jobId: number; documentId: number } {
  jobSeq += 1
  const { job } = createJob({
    title: `Engineer ${jobSeq}`,
    company: `Acme ${jobSeq}`,
    location: 'Remote',
    url: `https://example.com/spendcap-recovery/${jobSeq}`,
    description: 'JD'
  })
  const doc = createDocument('cv', 'CV', 'CONTENT', job.id)
  return { jobId: job.id, documentId: doc.id }
}

beforeEach(() => {
  wipe()
  clearAIQueue()
  resetModelHealth()
  resetProviderSpend()
  updateSettings({ base_cv: 'MASTER CV', auto_doc_min_fit: 40, provider_call_cap: 50 })
  calls = 0
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// The count itself, because everything below is a claim about a refused call
// and a refused call is only interesting if the refusal is real. A test that
// awaits each call to completion first cannot tell "counted before the
// response" from "counted after it", which is the only thing that makes the
// ledger a fact about the wire.
// ---------------------------------------------------------------------------

describe('the ledger records a request while it is still on the wire', () => {
  it('a request that has not answered yet is already counted', async () => {
    addModels(OPENROUTER, KEY_A, 1)
    const key = bucketOf(OPENROUTER, KEY_A)

    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => {
      calls++
      return gate.then(() => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'done' } }] }),
        text: () => Promise.resolve('')
      }))
    }))

    const inflight = callAI('sys', 'user').catch(() => undefined)
    // A macrotask flushes the requestChain microtasks, so the request has
    // reached the transport by now.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toBe(1)
    // THE ASSERTION. Taken on success, or anywhere after the response, this
    // is where the count would not be yet.
    expect(providerBudget(key).used).toBe(1)

    release()
    await inflight
    expect(providerBudget(key).used).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 1. The score_fit lane is parked like every other lane.
//
// A cap refusal used to be laundered into `fit_last_error` by a swallow-
// everything catch, `processItem` saw a job whose score was already set,
// concluded the scoring had happened, and DELETED the row. The Settings copy
// promises the app "picks up the work later"; there was nothing to pick up.
// ---------------------------------------------------------------------------

describe('an automatic score_fit row at the cap is parked, like every other lane', () => {
  it('the row survives with the cap message on it', async () => {
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 2)
    stubTransport()
    const { jobId } = jobWithCv()

    // A job that already carries a score — the normal case for a re-seeded
    // job, and the branch that decides the row's fate.
    updateJob(jobId, { score: 82, fit_source: 'llm' } as never)

    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()
    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).used).toBe(1)

    addAIQueueItem({ type: 'score_fit', jobId, manualQueued: false })
    await processQueue()

    // The refusal IS recorded on the job, because that surface is how the
    // user learns WHICH provider stopped answering.
    expect(getJob(jobId)?.fit_last_error).toMatch(/call cap/i)
    // ...and the job keeps the fit it had. A spent budget is not a verdict
    // about the job, so nothing about the score is rewritten.
    expect(getJob(jobId)?.score).toBe(82)

    const row = getAIQueue().find((q) => q.jobId === jobId)
    // Not `failed` with a reason the user can act on, and not absent: the
    // queue panel has to show that work the cap stopped is still owed.
    expect(row?.status).toBe('pending')
    expect(row?.lastError).toMatch(/call cap/i)
    // ...and parked for the cap's reason, which is what lets the panel say
    // so instead of counting down a retry this row is not spending.
    expect(row?.parkedReason).toBe('provider_cap')
    // Parked is FREE. Nothing was tried and nothing was revived, so a day of
    // refusals cannot walk this row to a terminal state.
    expect(row?.attempts).toBe(0)
    expect(row?.autoRevives).toBeUndefined()
  })

  it('...while an automatic verify row at the same cap already is parked', async () => {
    // The contrast that makes this a finding about plumbing rather than about
    // intent: two automated lanes, one ProviderCapError, two fates — because
    // only one of them let the error escape.
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 2)
    const { jobId, documentId } = jobWithCv()

    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()

    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: false })
    await processQueue()

    const row = getAIQueue().find((q) => q.jobId === jobId)
    expect(row?.status).toBe('pending')
    expect(row?.lastError).toMatch(/call cap/i)
  })

  it('a genuine scoring failure is still survivable, and still says why', async () => {
    // The other half of the same catch: absorbing errors into `fit_last_error`
    // is load-bearing for everything that is not a spent budget, and turning
    // it into a blanket rethrow would reject a promise two fire-and-forget
    // callers never await.
    const { jobId } = jobWithCv()
    const { scoreOneJobInBackground } = await import('./fitScorer')
    const ai = await import('./ai')
    const scorer = vi.spyOn(ai, 'scoreJobFit').mockRejectedValue(new Error('scorer exploded'))
    try {
      const job = await scoreOneJobInBackground(jobId)
      expect(job?.fit_last_error).toBe('scorer exploded')
    } finally {
      scorer.mockRestore()
    }
    expect(getAIQueue()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. A cap refusal costs the row nothing.
//
// A rate limit clears in a minute, so ten attempts over ~2h33m plus three
// revivals four hours apart is the right budget for one. A cap clears in up
// to 24h, and the same ladder spent all of it and then declared the row
// terminally `failed` — 22.07h into the window, with the budget still capped.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. THE ORIGIN a row CARRIES is not an origin the cap reads.
//
// A `manualQueued` row is one a person asked for ONCE — and the app then
// finishes it unattended, on a poll timer, for as long as it lives. That is
// the right design for finishing the work. It is the wrong design for the
// spend exemption, because `manualQueued` was being read as "a person is
// asking for this now", and nothing in the processor ever is: measured on
// 2026-10-05, one click's worth of rows drove 369 requests over 6h44m in 37
// bursts of 10 on a 629s cycle — this file's re-park ceiling plus the poll
// interval — while the automatic ledger sat pinned at exactly the cap and
// every automatic row was refused 8,061 times.
//
// So the row keeps its provenance (it is still revived unattended, still
// ungated by the auto-queue switches, still promoted) and the PROCESSOR
// reports what it is: the app's own request.
// ---------------------------------------------------------------------------

describe('a manual-origin row cannot spend past the cap unattended', () => {
  it('a day of passes moves the ledger by nothing at all', async () => {
    const t0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 2)
    const { jobId, documentId } = jobWithCv()

    // Spend the budget on the first pass, so this row meets a full one.
    stubTransport({ status: 200 })
    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()
    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).used).toBe(1)

    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: true })
    const onTheWire = (): number => calls

    // 200 passes over 24h, jumping to each row's own nextRetryAt so no pass
    // is a no-op. This is the shape of the measured window.
    for (let i = 0; i < 200; i++) {
      const row = getAIQueue().find((q) => q.jobId === jobId)
      if (!row || row.status === 'failed') break
      vi.setSystemTime(Math.max(Date.now(), row.nextRetryAt))
      await processQueue()
    }

    // The whole point: 200 chances, zero requests. Before, a manual-origin
    // row took every one of them.
    expect(onTheWire()).toBe(1)
    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).used).toBe(1)

    // And it is parked on the cap for the cap's reason, still owed, still
    // free: no attempt and no revival out of a day of refusals.
    const row = getAIQueue().find((q) => q.jobId === jobId)
    expect(row?.status).toBe('pending')
    expect(row?.lastError).toMatch(/call cap/i)
    expect(row?.parkedReason).toBe('provider_cap')
    expect(row?.attempts).toBe(0)
    expect(row?.autoRevives).toBeUndefined()

    // The provenance is untouched by any of that. It is what lets the app
    // finish this work unattended later, past the auto-queue switches and
    // past a restart, so losing it would lose the user's document.
    expect(row?.manualQueued).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. A RATE LIMIT CLEARS IN A MINUTE. A CAP CLEARS IN UP TO 24 HOURS.
// ---------------------------------------------------------------------------

describe('a capped row stays parked for the whole 24h window', () => {
  it('the row is still pending for the whole 24h window', async () => {
    const t0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 2)
    const { jobId, documentId } = jobWithCv()

    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()

    // The budget frees 24h after the FIRST recorded call.
    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).freeAt).toBe(t0 + DAY)

    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: false })

    // Drive the queue the way the 30s poll would: jump to each row's own
    // nextRetryAt so no pass is a no-op.
    for (let i = 0; i < 200; i++) {
      const row = getAIQueue().find((q) => q.jobId === jobId)
      if (!row || row.status === 'failed') break
      vi.setSystemTime(Math.max(Date.now(), row.nextRetryAt))
      await processQueue()
    }

    const row = getAIQueue().find((q) => q.jobId === jobId)

    // The premise, as its own assertion: whenever we stopped looking, the
    // provider was STILL capped — the budget had not yet freed.
    const stillCapped = providerBudget(bucketOf(OPENROUTER, KEY_A)).freeAt!
    expect(stillCapped).toBeGreaterThan(Date.now())

    // Before: `failed` at 22.07h with attempts 10 and autoRevives 3.
    expect(row?.status).toBe('pending')
    expect(row?.lastError).toMatch(/call cap/i)
    // The whole point, measured rather than described: two hours of refusals
    // cost this row no attempt and no revival.
    expect(row?.attempts).toBe(0)
    expect(row?.autoRevives).toBeUndefined()
  })

  it('a park never sleeps past the moment the budget frees', async () => {
    const t0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport({ status: 200 })
    const { jobId, documentId } = jobWithCv()

    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()

    addAIQueueItem({ type: 'verify', jobId, documentId, manualQueued: false })
    await processQueue()

    const parked = getAIQueue().find((q) => q.jobId === jobId)
    const budget = providerBudget(bucketOf(OPENROUTER, KEY_A))
    // The next check is the ordinary retry tick OR the window sliding,
    // whichever comes first — never a fixed "wait for the cap" guess, and
    // never later than the budget actually frees.
    expect(parked!.nextRetryAt).toBeLessThanOrEqual(budget.freeAt!)
    expect(parked!.nextRetryAt).toBeGreaterThan(t0)
  })
})

// ---------------------------------------------------------------------------
// 3. The cap is keyed on the user's own configuration, so an edit to a model
//    row used to be a spend-cap reset.
//
// The Settings page saves the WHOLE model list back on any edit to any row,
// and the bucket is `(endpoint, credential hash)`. Paste a reissued key for
// an account the app has already been spending through and that account
// started again at a full allowance.
// ---------------------------------------------------------------------------

describe('editing a model row does not hand the account a new allowance', () => {
  it('re-entering the same host with a different key does not reset its budget', async () => {
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()

    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()
    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).used).toBe(1)

    // What the Settings page does on any edit to a model row: save the whole
    // list back. The user pasted a reissued key for the same account.
    saveApiModels(listApiModels().map((m) => ({ ...m, api_key: KEY_B })))

    const fresh = bucketOf(OPENROUTER, KEY_B)
    expect(fresh).not.toBe(bucketOf(OPENROUTER, KEY_A))
    // The spend belongs to the account, not to the string the user pasted, so
    // it arrives with the new credential.
    expect(providerBudget(fresh).used).toBe(1)

    const before = calls
    resetModelHealth()
    await callAI('sys', 'after the edit').catch(() => undefined)
    // ...so this call does not go out: 2 against a cap of 1.
    expect(calls).toBe(before)
  })

  it('moving a model to a DIFFERENT provider does not carry the spend with it', async () => {
    // The other direction, and the one that would make the carry above a bug:
    // a different base URL is a different provider with a different
    // allowance, and importing yesterday's spend into it would refuse work
    // the new provider could do.
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()
    await callAI('sys', 'drain').catch(() => undefined)
    resetModelHealth()

    saveApiModels(
      listApiModels().map((m) => ({ ...m, base_url: 'https://opencode.ai/zen/v1', api_key: KEY_B }))
    )

    expect(providerBudget(bucketOf('https://opencode.ai/zen/v1', KEY_B)).used).toBe(0)
  })

  it('the persisted ledger holds nothing older than the window', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    stubTransport()
    await callAI('sys', 'drain').catch(() => undefined)
    saveApiModels(listApiModels().map((m) => ({ ...m, api_key: KEY_B })))

    // Two days on, with the live bucket being written to. The abandoned key's
    // array is never rewritten, so a write-time-only prune would leave it.
    vi.setSystemTime(t0 + 2 * DAY)
    resetModelHealth()
    await callAI('sys', 'much later').catch(() => undefined)

    // One credential on record, not one per key the user has ever typed: the
    // MAP is pruned on read as well as on write, which is the only thing that
    // can bound a map whose entries stop being written to.
    expect(Object.keys(getProviderSpend())).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. A clock that was ever wrong must not silence a provider for good.
//
// Entries are stamped with `Date.now()`, so a machine once set to the wrong
// year wrote timestamps nothing will ever age out of the window. The only
// clearing path was a test-only export with no IPC behind it, so the provider
// read as capped for as long as the wrong clock implied, with no way back.
// ---------------------------------------------------------------------------

describe('correcting a wrong clock gives the provider its budget back', () => {
  it('automated work runs again once the real window has passed', async () => {
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    const key = bucketOf(OPENROUTER, KEY_A)

    // The machine's clock was a year ahead when the app made its calls.
    recordProviderCall(key, false, t0 + 365 * DAY)
    // The record still REPORTS the call — deleting the impossible stamp would
    // hide the anomaly rather than fix it — and the budget says out loud that
    // its timestamps cannot be trusted.
    expect(providerBudget(key).used).toBe(1)
    expect(providerBudget(key).clockSkewed).toBe(true)

    // The user fixes the clock. Every entry is now well into the future.
    vi.setSystemTime(t0 + DAY)

    stubTransport()
    resetModelHealth()
    // A bound that cannot be evaluated is not enforced, so the provider serves
    // again the moment the app can tell what time it is. Before: measured 0
    // calls, and still 0 for the whole year the wrong clock implied.
    await callAI('sys', 'user').catch(() => undefined)
    expect(calls).toBe(1)

    // ...and clearing the ledger is still the only way to forget the spend,
    // which is the point: a cap the user can reset with a button is a
    // suggestion.
    resetProviderSpend()
    expect(providerBudget(key).used).toBe(0)
  })

  it('a clock a little fast is still a real budget, and still capped', async () => {
    // The tolerance is a whole window of forward slack, and this is why it is
    // not zero: a machine minutes out is an ordinary thing, its calls really
    // were made, and the cap has to keep holding for them.
    const t0 = new Date(2026, 2, 10, 12, 0, 0).getTime()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)

    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1)
    const key = bucketOf(OPENROUTER, KEY_A)

    recordProviderCall(key, false, t0 + 2 * HOUR)
    expect(providerBudget(key).used).toBe(1)
    expect(providerBudget(key).clockSkewed).toBe(false)

    stubTransport()
    resetModelHealth()
    await callAI('sys', 'user').catch(() => undefined)
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. The unit is the credential, and that is deliberate.
//
// Two keys configured at the same time are two allowances, so at cap 50 with
// two keys the app will spend 50 before the provider's own per-account counter
// has seen 25. That is more permissive than OpenRouter's rule and it is the
// choice this file pins, because the alternative silently caps an unrelated
// credential. What is NOT available is buying a fresh allowance by editing the
// key in place — the carry in `saveApiModels` closes that route, and the case
// above is what stops it from being closed by merging the two keys instead.
// ---------------------------------------------------------------------------

describe('the bucket is per CREDENTIAL, and the free tier is per ACCOUNT', () => {
  it('two keys on one OpenRouter account get two independent allowances', async () => {
    updateSettings({ provider_call_cap: 1 })
    addModels(OPENROUTER, KEY_A, 1, 'a')
    addModels(OPENROUTER, KEY_B, 1, 'b')
    stubTransport()

    await callAI('sys', 'one').catch(() => undefined)
    resetModelHealth()
    await callAI('sys', 'two').catch(() => undefined)

    expect(providerBudget(bucketOf(OPENROUTER, KEY_A)).used).toBe(1)
    expect(providerBudget(bucketOf(OPENROUTER, KEY_B)).used).toBe(1)
    // Two calls against a single account whose documented free allowance is
    // per account — so at cap 50 the app spends 50 before the provider's own
    // counter has seen 25.
    expect(calls).toBe(2)
  })
})