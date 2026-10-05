/**
 * WHAT A QUEUE REFUSAL IS ALLOWED TO DO TO THE NOTIFICATION CENTRE.
 *
 * The hole: on 2026-10-05 the AI queue made 8,061 row-level refusals across
 * 36 passes against 241 items over 6h44m, 211 of them still cycling at the
 * close, and wrote 1,440 ERROR lines and nothing else. `aiQueue.ts` never
 * called `addNotification`, so the notification centre — the thing built to
 * be the record of what went wrong — had no row, no badge and no toast for
 * any of it. The user learned about it by opening the Queue tab of the
 * drawer, which is a place rather than a surface.
 *
 * The opposite hole, and the one that decides the design: that record layer
 * had just been rebuilt so that one row is one thing that went wrong, and
 * 8,061 refusals are NOT one thing. Recording each refusal would have
 * replaced silence with a badge reading ×2000 for work that is merely queued,
 * which is worse than silence because it teaches the user that the centre is
 * noise. So the rule has two halves and both are load-bearing:
 *
 *   A REFUSAL THE QUEUE RESOLVES BY ITSELF IS NOT A THING THAT HAPPENED TO
 *   THE USER'S WORK. A REFUSAL THAT HAS OUTLASTED THE QUEUE'S OWN LONGEST
 *   RE-CHECK IS.
 *
 * The threshold is the queue's own constant — `PROVIDER_REPROBE_CAP_MS`, the
 * ceiling of the ladder `parkBlockedRow` parks on — passed in by the caller
 * rather than invented here, because up to it the app is re-checking on an
 * accelerating schedule and the wait is expected to resolve, and past it the
 * ladder has stopped accelerating.
 *
 * Instrument, as in the queue suites it follows: a real store, the real
 * queue, the real notification centre, `fetch` stubbed. Assertions are on
 * what the centre reads back and on what left the app, never on a counter
 * this file keeps about itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-queuestall-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

const toasts = vi.hoisted(() => ({ fired: [] as string[] }))
const notif = vi.hoisted(() => ({ failWrites: false }))

vi.mock('./notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications')>()
  return {
    ...actual,
    addNotification: (input: Parameters<typeof actual.addNotification>[0]) => {
      if (notif.failWrites) throw new Error('store is gone')
      return actual.addNotification(input)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => `${STORE_DIR}/app`,
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

// The drawer is a renderer surface and the queue is not allowed to touch it.
// The automated retry path emitting a toast is already pinned in
// toastFlood.main.test.ts; this asserts the queue's own new write adds
// none, so a future change that reaches for a toast is caught here too.
vi.mock('./main', () => ({ notifyError: (m: string) => toasts.fired.push(m) }))

import {
  addAIQueueItem,
  addApiModel,
  clearAIQueue,
  createDocument,
  createJob,
  getAIQueue,
  reloadStore,
  saveApiModels,
  updateAIQueueItem,
  updateSettings
} from './database'
import { callAI, resetModelHealth } from './ai'
import { PROVIDER_REPROBE_CAP_MS, processQueue } from './aiQueue'
import { reportStalledQueue, resetQueueStall } from './queueStalls'
import { addNotification, listActiveNotifications } from './notifications'
import { notificationGroupKey } from './notificationGroup'
import type { AIQueueItem } from './types'

const HOUR = 60 * 60 * 1000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()

let fetchCalls = 0

function stubProvider(status: number): void {
  fetchCalls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++
    return { ok: false, status, headers: new Map<string, string>(), text: async () => 'provider says no' }
  }))
}

/** A store of N rows parked on the spend cap, as `parkOnProviderCap` leaves them. */
function capParked(count: number, lastError = 'openrouter.ai/api/v1 is at its call cap'): number[] {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const { job } = createJob({ title: `Engineer ${i}`, company: `Acme ${i}` })
    const doc = createDocument('cv', 'CV', 'content', job.id)
    const row = addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id } as never)
    updateAIQueueItem(row.id, {
      status: 'pending',
      parkedReason: 'provider_cap',
      lastError,
      nextRetryAt: Date.now() + PROVIDER_REPROBE_CAP_MS
    })
    ids.push(row.id)
  }
  return ids
}

/** A store of N rows parked on a provider cooldown, as `parkBlockedRow` leaves them. */
function cooldownParked(count: number): number[] {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const { job } = createJob({ title: `Analyst ${i}`, company: `Globex ${i}` })
    const doc = createDocument('cv', 'CV', 'content', job.id)
    const row = addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id } as never)
    updateAIQueueItem(row.id, {
      status: 'pending',
      blockedSince: Date.now(),
      blockedCount: 3,
      lastError: 'no AI provider is available',
      nextRetryAt: Date.now() + PROVIDER_REPROBE_CAP_MS
    })
    ids.push(row.id)
  }
  return ids
}

/** A row that is merely queued behind other work: no provider holds it. */
function merelyWaiting(count: number): number[] {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const { job } = createJob({ title: `Writer ${i}`, company: `Initech ${i}` })
    const doc = createDocument('cv', 'CV', 'content', job.id)
    ids.push(addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id } as never).id)
  }
  return ids
}

function rows(): ReturnType<typeof listActiveNotifications>['rows'] {
  return listActiveNotifications().rows
}

/**
 * Report the pass `elapsedMs` into a stall that has been running since T0.
 *
 * Two calls, because a duration cannot be measured from one observation: the
 * first pass establishes that this is happening, and the second is the one
 * that can say how long it has been happening for. `runPass` supplies both
 * by calling on every pass, which is why the end-to-end case below does not
 * need this helper.
 */
function reportAfter(elapsedMs: number): void {
  reportStalledQueue(T0, PROVIDER_REPROBE_CAP_MS)
  vi.setSystemTime(T0 + elapsedMs)
  reportStalledQueue(T0 + elapsedMs, PROVIDER_REPROBE_CAP_MS)
}

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

beforeEach(() => {
  wipe()
  clearAIQueue()
  resetModelHealth()
  resetQueueStall()
  saveApiModels([])
  addApiModel({
    name: 'm0',
    base_url: 'https://example.invalid',
    api_key: 'k',
    model: 'model-0',
    enabled: true
  } as never)
  updateSettings({ base_cv: 'MASTER CV', provider_call_cap: 50 })
  fetchCalls = 0
  toasts.fired.length = 0
  notif.failWrites = false
  vi.unstubAllGlobals()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetModelHealth()
  resetQueueStall()
  clearAIQueue()
})

// ---------------------------------------------------------------------------
// HALF ONE: a refusal the queue resolves by itself stays in the log.
// ---------------------------------------------------------------------------

describe('a stall shorter than the queue\'s own re-check ceiling is not a record', () => {
  it('a pass that parks rows and then clears them writes nothing', () => {
    const ids = cooldownParked(3)

    // The first pass establishes that this is happening.
    reportStalledQueue(T0, PROVIDER_REPROBE_CAP_MS)
    expect(rows()).toHaveLength(0)

    // Nine more minutes of it — inside the ceiling, so the ladder is still
    // accelerating and the situation is expected to resolve.
    vi.setSystemTime(T0 + 9 * 60_000)
    reportStalledQueue(Date.now(), PROVIDER_REPROBE_CAP_MS)
    expect(rows()).toHaveLength(0)

    // ...and it resolves. A provider answers, the rows are claimed, and the
    // park fields are cleared in the same write that claims them.
    for (const id of ids) {
      updateAIQueueItem(id, { blockedSince: undefined, blockedCount: undefined, status: 'processing' })
    }
    reportStalledQueue(T0 + 9 * 60_000 + 1000, PROVIDER_REPROBE_CAP_MS)
    expect(rows()).toHaveLength(0)
  })

  it('rows merely waiting their turn are not a stall', () => {
    // The case the Queue panel renders as "Pending", which the assessment
    // noted is indistinguishable from a row that cannot run at all. It is
    // not a stall: nothing has been refused.
    merelyWaiting(40)
    vi.setSystemTime(T0 + 6 * HOUR)
    reportStalledQueue(Date.now(), PROVIDER_REPROBE_CAP_MS)
    expect(rows()).toHaveLength(0)
  })

  it('an empty queue is not a stall', () => {
    vi.setSystemTime(T0 + 6 * HOUR)
    reportStalledQueue(Date.now(), PROVIDER_REPROBE_CAP_MS)
    expect(rows()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// HALF TWO: a stall that outlasts the ceiling IS a fact about the user's work.
// ---------------------------------------------------------------------------

describe('a stall past the ceiling is one row, however many refusals it contains', () => {
  it('36 passes and 8,061 refusals produce exactly one record', () => {
    // The measured shape: 241 items, a refusal every pass, for six and a half
    // hours. The number the centre shows is the number of things that went
    // wrong, and here that is one thing.
    capParked(241)
    let passes = 0
    for (let i = 0; i < 36; i++) {
      vi.setSystemTime(T0 + i * 629_000)
      reportStalledQueue(Date.now(), PROVIDER_REPROBE_CAP_MS)
      passes++
    }
    expect(passes).toBe(36)
    expect(rows()).toHaveLength(1)
  })

  it('the record says what is stuck and what is holding it', () => {
    capParked(176, 'openrouter.ai/api/v1 is at its call cap — 50 automated of 50 in the last 24h.')
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)

    const [row] = rows()
    expect(row.type).toBe('error')
    expect(row.source).toBe('ai')
    // Every number in the record is read off a row, so it is checkable.
    expect(row.message).toContain('176')
    expect(row.message).toMatch(/call cap/i)
    // The detail carries the provider's own sentence, so the user can act on
    // it rather than being told only that something is wrong.
    expect(row.full_message).toContain('openrouter.ai/api/v1 is at its call cap')
    // ...and what has NOT happened, because "no attempts spent" is the part
    // that tells the user this is not their work being destroyed.
    expect(row.full_message).toMatch(/No attempts have been spent/)
    expect(row.full_message).toMatch(/no provider requests made/i)
    // The waited time is derived from when this stall began, not invented.
    expect(row.full_message).toMatch(/11 minutes/)
  })

  it('a cooldown stall and a cap stall are told apart', () => {
    cooldownParked(4)
    capParked(9)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)

    const [row] = rows()
    // The dominant reason leads, and the breakdown is both in the detail.
    expect(row.message).toContain('9')
    expect(row.message).toMatch(/call cap/i)
    expect(row.full_message).toContain('Waiting for a provider to finish cooling down (4)')
  })

  it('a second stall after the queue recovers is a second fact', () => {
    const ids = cooldownParked(2)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)
    expect(rows()).toHaveLength(1)

    // The queue recovers and STAYS recovered: the rows are claimed, which
    // clears the park, and it holds that way past a full threshold, which is
    // the only thing that ends a stall.
    for (const id of ids) {
      updateAIQueueItem(id, { blockedSince: undefined, blockedCount: undefined, status: 'processing' })
    }
    vi.setSystemTime(T0 + 2 * HOUR)
    reportStalledQueue(T0 + 2 * HOUR, PROVIDER_REPROBE_CAP_MS)

    // ...and it stops again.
    for (const id of ids) {
      updateAIQueueItem(id, { status: 'pending', blockedSince: Date.now(), blockedCount: 1 })
    }
    reportAfter(2 * HOUR + PROVIDER_REPROBE_CAP_MS + 60_000)
    expect(rows()).toHaveLength(2)
  })

  it('the record is a store row, so the badge lights without a window event', () => {
    cooldownParked(2)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)
    // `hasUnread` in the renderer is `list.length > 0`, so a row IS the
    // badge. Nothing else has to happen for the user to see it.
    expect(listActiveNotifications().rows.length).toBeGreaterThan(0)
  })

  it('a store that cannot be written does not stop the queue', () => {
    cooldownParked(2)
    reportStalledQueue(T0, PROVIDER_REPROBE_CAP_MS)
    // The exact condition `reportStalledQueue` guards: the record is a
    // courtesy, and the rows it is about are parked and logged either way.
    notif.failWrites = true
    const past = T0 + PROVIDER_REPROBE_CAP_MS + 60_000
    vi.setSystemTime(past)
    expect(() => reportStalledQueue(past, PROVIDER_REPROBE_CAP_MS)).not.toThrow()
    notif.failWrites = false
    expect(rows()).toHaveLength(0)
    expect(getAIQueue().filter((q: AIQueueItem) => q.blockedSince !== undefined)).toHaveLength(2)
  })

  it('the queue still emits no toast for it', () => {
    cooldownParked(2)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)
    expect(rows()).toHaveLength(1)
    expect(toasts.fired).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The identity of the row: it must not fold into anything else, and it must
// not be able to decide what it is.
// ---------------------------------------------------------------------------

describe('the queue record keeps its own identity', () => {
  it('cannot be folded into a document failure that reads alike', () => {
    // The specific hazard: `group_key` is caller-overridable, and the derived
    // key is built from the message. If this record took its key from its
    // own text it would share a group with any other `error|ai|…` row whose
    // message happened to normalise the same way, and a document failure
    // would appear to be the queue.
    const text = 'Your queued AI work is not running — 12 task(s) are waiting.'
    addNotification({
      type: 'error',
      source: 'ai',
      message: text,
      full_message: 'Content review failed: the CV is missing a summary.'
    })
    capParked(12)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)

    expect(rows()).toHaveLength(2)
    const groups = new Set(rows().map((r) => r.group_key))
    expect(groups.size).toBe(2)
    // The document failure is untouched, and so is the queue record.
    const document = rows().find((r) => r.full_message.startsWith('Content review failed'))
    const stall = rows().find((r) => r.message.includes('queued AI work is not running'))
    expect(document?.group_key).toBe(notificationGroupKey('error', 'ai', text))
    expect(stall?.group_key).toBe('error|ai|queued AI work is not running')
  })

  it('carries no severity of its own', () => {
    // 660e4f4's fix: a caller's `group_key` must not be able to decide what a
    // row IS. The key here names type and source for the GROUPING only, and
    // the store still takes both off the row, so a second writer reusing this
    // key with a different type still gets a separate row.
    cooldownParked(1)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)
    expect(rows()[0].type).toBe('error')

    addNotification({
      type: 'warning',
      source: 'ai',
      message: 'A different sentence entirely.',
      full_message: 'A different payload entirely.',
      group_key: 'error|ai|queued AI work is not running'
    })
    const after = rows()
    expect(after).toHaveLength(2)
    expect(after.map((r) => r.type).sort()).toEqual(['error', 'warning'])
  })

  it('says nothing the store cannot source', () => {
    cooldownParked(3)
    reportAfter(PROVIDER_REPROBE_CAP_MS + 60_000)

    const [row] = rows()
    // No provider name in the headline: the group key already fixes which
    // rows collapse together, and a headline that named a host would split
    // one stall into one row per host.
    expect(row.message).not.toMatch(/https?:\/\//)
    // No placeholder for a number the rows did not carry.
    expect(row.message).not.toMatch(/\bnull\b|\bundefined\b|NaN/)
    expect(row.full_message).not.toMatch(/\bundefined\b|NaN/)
  })
})

// ---------------------------------------------------------------------------
// The wiring: the pass itself has to call this, or none of the above is a fact
// about the app rather than about this file.
// ---------------------------------------------------------------------------

describe('a real blocked pass records the stall, end to end', () => {
  it('a provider that refuses everything is recorded once the ceiling passes', async () => {
    // One rotation, so the whole pool is cooling: the pass then has nothing
    // it can accomplish and parks the due rows instead of claiming them. The
    // health is left in place on purpose — clearing it is what would let a
    // pass claim a row that the provider is in fact refusing.
    stubProvider(429)
    await callAI('sys', 'heat').catch(() => undefined)
    expect(fetchCalls).toBeGreaterThan(0)

    const { job } = createJob({ title: 'Real', company: 'Real' })
    const doc = createDocument('cv', 'CV', 'content', job.id)
    const row = addAIQueueItem({ type: 'verify', jobId: job.id, documentId: doc.id } as never)
    updateAIQueueItem(row.id, { nextRetryAt: 0 })

    // Passes on the ladder. The row is parked on some of them and claimed on the
    // others — a lapsing cooldown lets one pass claim it, the provider 429s it
    // again, and the next pass is back to parking — so what matters is that
    // the quiet passes do NOT read as recovery, and that nothing is recorded
    // while the queue is still inside its own ceiling.
    let sawPark = false
    for (const minute of [0, PROVIDER_REPROBE_CAP_MS / 60_000]) {
      vi.setSystemTime(T0 + minute * 60_000)
      await processQueue()
      if (getAIQueue()[0].blockedSince !== undefined) sawPark = true
      expect(rows()).toHaveLength(0)
    }
    expect(sawPark, 'the pass must actually have parked the row').toBe(true)
    // And something really was refused: the provider never returned a body.
    expect(fetchCalls).toBeGreaterThan(0)

    // The first pass after the ceiling, with the provider still refusing.
    const past = T0 + 2 * PROVIDER_REPROBE_CAP_MS
    vi.setSystemTime(past)
    await processQueue()
    expect(rows()).toHaveLength(1)
    expect(rows()[0].message).toMatch(/not running/i)

    // ...and the passes after that add nothing, because the thing that
    // happened has not happened again.
    for (const at of [3, 4]) {
      vi.setSystemTime(T0 + at * PROVIDER_REPROBE_CAP_MS)
      await processQueue()
      expect(rows()).toHaveLength(1)
    }
  })
})