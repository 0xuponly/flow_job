import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The dead end the Auto-queue gate opened, and the escape hatch that
// closes it.
//
// `reclaimInterruptedItems` refuses to requeue an AUTOMATIC row a crash
// left `processing` when its Auto-queue switch is off. That is correct —
// it is the unattended spend the user bought out of — but it left the row
// in the one status the Queue panel never offered Retry for. So an
// automatic row, crashed mid-generation, with the switch off, was
// `processing` for ever: no run, no button, no sign it would ever move.
//
// This file pins the two halves of the fix against the REAL store and the
// REAL processor, with only the provider mocked (so "did the app spend
// tokens on its own" is measurable):
//
//   * the app still does NOT resume a gated automatic row on its own, and
//     the row is REPORTED as stranded so the panel can offer the button;
//   * the user's Retry is ungated and reaches the row, and the pass that
//     picks it up afterwards is not blocked by the switches either.
//
// It also pins what "stranded" is NOT, because the whole trick is telling
// a crash leftover from a run in progress: a row the processor is working
// on right now must never be labelled stranded, or the panel would offer
// Retry on a running task and pressing it would queue the work twice.

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: '/tmp/flow_job-test-stranded-row',
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
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
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    on: () => undefined
  },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      once: () => undefined,
      on: () => undefined,
      send: () => undefined
    }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    on() { return undefined }
    show() { return undefined }
    isDestroyed() { return false }
    static getAllWindows() { return [] }
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { height: 900 } }) },
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined } } },
  dialog: new Proxy({}, { get: () => async () => ({ canceled: true, filePath: undefined }) }),
  shell: { openExternal: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  const down = async () => { throw new Error('provider down') }
  return {
    ...actual,
    tailorDocument: vi.fn(down),
    verifyDocumentContent: vi.fn(down),
    regenerateSection: vi.fn(down),
    scoreJobFit: vi.fn(down)
  }
})

import {
  addAIQueueItem,
  createJob,
  getAIQueue,
  reloadStore,
  updateAIQueueItem,
  updateSettings
} from './database'
import {
  listQueueInPickOrder,
  processQueue,
  reclaimInterruptedItems,
  retryQueueItem,
  startQueueProcessor,
  stopQueueProcessor
} from './aiQueue'
import * as ai from './ai'
import type { AIQueueItem, CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const ALL_OFF = {
  auto_queue_fit: false,
  auto_queue_cv: false,
  auto_queue_cover_letter: false,
  auto_queue_verify_cv: false,
  auto_queue_verify_cover_letter: false
} as const

let nextUrl = 0

function addJob(): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/stranded-row/${nextUrl}`
  }
  return createJob(input).job.id
}

/** Tokens spent by the app on its own. */
function calls(name: 'tailorDocument' | 'verifyDocumentContent'): number {
  return vi.mocked(ai[name]).mock.calls.length
}

/** A row exactly as a killed app leaves it: `processing`, nothing running. */
function strandedByCrash(type: AIQueueItem['type'], jobId: number, origin?: boolean): AIQueueItem {
  const row = addAIQueueItem({
    type,
    jobId,
    ...(origin === undefined ? {} : { manualQueued: origin })
  })
  updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
  return row
}

function viewOf(id: number): { status: string; stranded: boolean } {
  const row = listQueueInPickOrder().find((r) => r.id === id)
  expect(row, `row ${id} is not in the list`).toBeTruthy()
  return { status: row!.status, stranded: row!.stranded === true }
}

/**
 * Start a processor session the way the app does at launch, and stop it
 * again.
 *
 * `startQueueProcessor` is the only thing that snapshots the interrupted
 * rows, so this is also how a test gets a clean slate: `stopQueueProcessor`
 * forgets the snapshot, so each test sees its own "startup".
 *
 * Awaited all the way out on purpose. The session's first pass runs
 * unawaited, and until it has finished the processor is still "in
 * flight" — a `processQueue()` called synchronously after this returns
 * would be dropped as a re-entrant pass, and the test would read that as
 * the queue being broken.
 */
async function session(): Promise<void> {
  startQueueProcessor(60_000)
  await flush()
}

async function flush(): Promise<void> {
  // The processor reaches the provider through a promise chain and its
  // failure path is a few awaits deep, so one macrotask turn is not
  // always enough to see a pass settle. Each turn drains every pending
  // microtask, which is what a passing test actually needs: a pass left
  // in flight would hold the processor's re-entrancy guard and make
  // every LATER test's `processQueue()` a silent no-op.
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Releases an `inFlight` call, if one is still hanging. */
let releasePending: (() => void) | null = null

/** A provider call that stays in flight until the test releases it. */
function inFlight(): { release: (result: unknown) => void } {
  let release!: (result: unknown) => void
  const pending = new Promise((resolve) => { release = resolve })
  vi.mocked(ai.tailorDocument).mockImplementation((() => pending) as never)
  // Registered globally, so a test that fails before it releases cannot
  // leave a promise the whole provider chain is waiting behind: every
  // later test in the file would find the processor permanently "busy".
  releasePending = () => release({ document_id: 1 })
  return { release }
}

beforeEach(async () => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  nextUrl = 0
  updateSettings({ base_cv: 'MASTER CV', ...ALL_OFF })
  for (const m of [ai.tailorDocument, ai.verifyDocumentContent]) {
    vi.mocked(m).mockReset()
    vi.mocked(m).mockImplementation(async () => { throw new Error('provider down') })
  }
  // registerIpc() runs off app.whenReady() at import time; the queue
  // handlers are what the Queue panel's buttons actually call.
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
})

afterEach(async () => {
  // No test may leave a live run (or the interval behind it) behind.
  releasePending?.()
  releasePending = null
  vi.mocked(ai.tailorDocument).mockReset()
  vi.mocked(ai.tailorDocument).mockImplementation(async () => { throw new Error('provider down') })
  stopQueueProcessor()
  await flush()
})

describe('the gate still refuses to spend on its own', () => {
  it('leaves a gated automatic row a crash stranded `processing`', async () => {
    // The regression that must survive this change. If the reclaim
    // un-gated, this row would resume by itself with the switch off.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)

    await session()
    await processQueue()

    expect(getAIQueue()[0].status).toBe('processing')
    expect(calls('tailorDocument')).toBe(0)
    expect(viewOf(row.id).stranded).toBe(true)
  })

  it('treats a LEGACY row with no origin field as automatic, so the leak stays closed', async () => {
    // Constructed by omitting the field from the store write, which is
    // what a row from before the field existed looks like. Reading absent
    // as MANUAL would hand every pre-existing row a free pass; what it
    // must still get is the user's Retry.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, undefined)
    expect('manualQueued' in row).toBe(false)

    await session()

    expect(getAIQueue()[0].status).toBe('processing')
    expect(viewOf(row.id).stranded).toBe(true)
    retryQueueItem(row.id)
    expect(getAIQueue()[0].status).toBe('pending')
  })

  it('still reclaims a row the user queued by hand', async () => {
    // The other half of the gate: a manual row is finished for the user
    // exactly as it always was, and is not stranded — it is back in line.
    //
    // Driven through the reclaim directly rather than through a whole
    // processor session, because a session's first pass would claim the
    // row it just requeued and the assertion would be reading a live run.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, true)
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('pending')
    expect(viewOf(row.id).stranded).toBe(false)
  })
})

describe('telling a crash leftover from a run in progress', () => {
  it('reports a row the processor is working on right now as NOT stranded', async () => {
    // The control, and the reason the flag is not simply "status is
    // processing". A live run must not get a Retry button: pressing it
    // would put the same generation in the queue a second time while the
    // first one is still spending tokens on it.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    const provider = inFlight()

    await session()

    // Claimed, and the provider call is still outstanding.
    expect(calls('tailorDocument')).toBe(1)
    expect(viewOf(row.id)).toEqual({ status: 'processing', stranded: false })
    expect(listQueueInPickOrder()[0].stranded).toBe(false)

    provider.release({ document_id: 1 })
    await flush()
  })

  it('forgets a stranded row once this process takes it over', async () => {
    // The user's other way out: turn the switch back on. The reclaim runs
    // again, the row goes back in line, the processor claims it — and
    // from that moment it is a live run, not a crash leftover, so the
    // button disappears exactly as it should.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true })
    reclaimInterruptedItems()
    expect(getAIQueue()[0].status).toBe('pending')

    const provider = inFlight()
    // Deliberately not awaited: the provider call is hanging, so awaiting
    // the pass would wait for the test to release it.
    void processQueue()
    await flush()
    expect(viewOf(row.id)).toEqual({ status: 'processing', stranded: false })

    provider.release({ document_id: 1 })
    await flush()
  })

  it('does not brand a live run stranded when the reclaim runs again', async () => {
    // The one-shot property, pinned. `reclaimInterruptedItems` scans for
    // rows left `processing`, and a row this process is working on is
    // indistinguishable from one, so a SECOND call must not re-snapshot:
    // the stranded set describes the moment this process started and
    // nothing later.
    //
    // The switch stays OFF, so the reclaim skips the row — that is the
    // state this has to be right about. (With it on, the reclaim would
    // requeue the row, live or not; it cannot tell, which is why it only
    // ever runs once, before the first pass.)
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    const provider = inFlight()
    await session()
    expect(viewOf(row.id).status).toBe('processing')

    reclaimInterruptedItems()

    // Reclaiming did not requeue it (it is not abandoned) and, more to the
    // point, did not label it stranded either.
    expect(viewOf(row.id)).toEqual({ status: 'processing', stranded: false })

    provider.release({ document_id: 1 })
    await flush()
  })
})

describe('Retry on a gated stranded row', () => {
  it('requeues it, and the pass runs it, with every switch off', async () => {
    // The whole point. Manual retry is the user asking, so neither the
    // retry nor the pass it queues for consults a switch — and the row
    // is genuinely picked up rather than looking like it worked.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    retryQueueItem(row.id)

    const revived = getAIQueue()[0]
    expect(revived.status).toBe('pending')
    expect(revived.nextRetryAt).toBeLessThanOrEqual(Date.now())
    // A fresh budget, so a row that spent its attempts on the crash does
    // not fail again on its first retry.
    expect(revived.attempts).toBe(0)
    // Not flagged any more: it is back in line, not stranded.
    expect(viewOf(row.id).stranded).toBe(false)

    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
  })

  it('the real aiQueue:retry handler reaches it, with every switch off', async () => {
    // Driven through the handler the Queue panel's button calls, not
    // through retryQueueItem directly, so a gate added to the IPC layer
    // would fail here.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()

    const handler = handlers.get('aiQueue:retry')
    expect(handler).toBeTruthy()
    const answer = (await handler!({}, row.id)) as { id: number; status: string; stranded: boolean }[]
    const retried = answer.find((r) => r.id === row.id)
    expect(retried?.status).toBe('pending')

    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
    // The row really went through a run: its attempt was spent and it
    // came back for another try rather than being left untouched.
    expect(getAIQueue().find((q) => q.id === row.id)?.attempts).toBeGreaterThan(0)
  })

  it('works on a row out of automatic-revival budget', async () => {
    // AUTO_REVIVE_MAX bounds what the app may restart by itself. It is not
    // a limit on the user: a row the app has given up on is still the
    // user's to re-run, and the Retry that does it grants a full budget.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, {
      status: 'failed',
      attempts: 9,
      autoRevives: 3,
      nextRetryAt: Date.now() + 4 * 60 * 60 * 1000
    })
    updateSettings(ALL_OFF)

    // Control: the app will not touch it.
    await processQueue()
    expect(calls('tailorDocument')).toBe(0)
    expect(getAIQueue()[0].status).toBe('failed')

    retryQueueItem(row.id)

    const revived = getAIQueue()[0]
    expect(revived.status).toBe('pending')
    expect(revived.attempts).toBe(0)
    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
  })
})