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
  STORE_DIR: `/tmp/flow_job-test-stranded-row-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
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
  createDocument,
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
  stopQueueProcessor,
  enqueue
} from './aiQueue'
import * as ai from './ai'
import { readFileSync } from 'node:fs'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
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

/** A partial set of the five switches, for turning one back on. */
type Switches = { [K in keyof typeof ALL_OFF]?: boolean }

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

/** Every provider call, of any kind: "did the app spend at all". */
function spend(): number {
  return (
    vi.mocked(ai.tailorDocument).mock.calls.length +
    vi.mocked(ai.verifyDocumentContent).mock.calls.length +
    vi.mocked(ai.regenerateSection).mock.calls.length +
    vi.mocked(ai.scoreJobFit).mock.calls.length
  )
}

/** A row exactly as a killed app leaves it: `processing`, nothing running. */
function strandedByCrash(
  type: AIQueueItem['type'],
  jobId: number,
  origin?: boolean,
  documentId?: number
): AIQueueItem {
  const row = addAIQueueItem({
    type,
    jobId,
    ...(documentId === undefined ? {} : { documentId }),
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
  // `content` is required since the per-unit lane began sanitizing before
  // storing (R3): `sanitizeDocument` calls `.split` on it, so a stub that
  // omits it throws `Cannot read properties of undefined (reading 'split')`
  // and the row fails instead of completing.
  releasePending = () => release({ document_id: 1, content: 'CV CONTENT LINE' })
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

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
  })

  it('forgets a stranded row once this process takes it over', async () => {
    // The user's way out, and it has to end with the button gone. The row
    // is revived by a REQUEST — Retry here, or a manual Generate on the job
    // (the sibling hatch, pinned below) — so the next pass claims it, and
    // from the claim it is a live run rather than a crash leftover.
    //
    // This used to be driven by flipping `auto_queue_cv` back on and
    // calling `reclaimInterruptedItems()` a second time by hand, which
    // reached the right state by a path the app does not have: nothing
    // after startup revives a `processing` row, so the reclaim never
    // revives one either. The state it asserted was real and the reason
    // was fiction, and the comment at the claim said the fiction out loud.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    retryQueueItem(row.id)
    expect(getAIQueue()[0].status).toBe('pending')

    const provider = inFlight()
    // Deliberately not awaited: the provider call is hanging, so awaiting
    // the pass would wait for the test to release it.
    void processQueue()
    await flush()
    expect(viewOf(row.id)).toEqual({ status: 'processing', stranded: false })

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
  })

  it('does NOT revive a stranded row when the user flips the switch back on', async () => {
    // The truth the old comment denied, pinned so it cannot be denied
    // again. A stranded row reads `processing`, and after startup nothing
    // in this file revives a `processing` row on its own: `runPass` picks
    // `pending` and revives `failed`, `enqueue`'s duplicate path revives
    // `failed` and (for a manual request) a stranded row, and the reclaim
    // is the one-shot it has always been.
    //
    // So turning auto-queueing back on is a PERMISSION, not a request for
    // this row, and it must not resume a crash leftover the user has not
    // asked about — with the provider down here, a resume would be a
    // generation nobody asked for. The request is Retry, or Generate on
    // the job, and both are ungated.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true })
    await processQueue()

    expect(getAIQueue()[0].status).toBe('processing')
    expect(viewOf(row.id).stranded).toBe(true)
    expect(calls('tailorDocument')).toBe(0)
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

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
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
/**
 * The false positive, and the two guards that close it.
 *
 * `stranded` answers "is anyone working on this row?", and the only wrong
 * answer is "no" for a row this process is in the middle of running. That
 * answer has consequences twice over: the panel shows Retry on a task the
 * user is watching, and pressing it used to DELETE the task, because the
 * in-flight `processItem` reaches `removeAIQueueItem(item.id)` when its
 * provider call returns and the row the user had just asked to re-run is
 * the row it removes.
 *
 * Both of those were reachable from the exported API even though the panel
 * never offered the button: `stopQueueProcessor()` forgets the startup
 * snapshot on purpose, so a restart taken while a pass is in flight takes a
 * FRESH one — and the fresh snapshot found the live row.
 */
describe('a row this process is running can never read stranded', () => {
  it('survives a stop/start taken while a pass is in flight', async () => {
    // The composition that used to brand the live row. `stopQueueProcessor`
    // drops the snapshot so a restarted processor takes a fresh one, and the
    // pass that was mid-run is still running when it does — so the fresh
    // snapshot sees a row this process is paying for, records it, and (with
    // the Auto-queue switch off, which is the whole premise) the reclaim
    // then leaves it `processing`, stranded, and Retry-able.
    //
    // Not reachable in the app as shipped: `stopQueueProcessor` has one
    // caller, inside `window-all-closed` on non-darwin, immediately before
    // `app.quit()`. That is a landmine, not a live bug, and landmines are
    // what the next person wires "pause the processor when occluded" onto.
    const liveJob = addJob()
    const live = addAIQueueItem({ type: 'generate_cv', jobId: liveJob })
    // A real crash leftover in the same store, so the fix cannot be "ignore
    // the snapshot while a pass runs" — that would drop this row's button
    // and make it a dead end again.
    const deadJob = addJob()
    const dead = strandedByCrash('generate_cv', deadJob, false)
    updateSettings(ALL_OFF)
    const provider = inFlight()

    await session()
    expect(viewOf(live.id)).toEqual({ status: 'processing', stranded: false })
    expect(viewOf(dead.id).stranded).toBe(true)

    stopQueueProcessor()
    startQueueProcessor(60_000)
    await flush()

    // The live row: not stranded, and not requeued either. A second reclaim
    // cannot tell an abandoned row from a running one, so it must not guess
    // in the direction that spends money.
    expect(viewOf(live.id)).toEqual({ status: 'processing', stranded: false })
    // The crash leftover it was called for: still reported, still Retry-able.
    expect(viewOf(dead.id)).toEqual({ status: 'processing', stranded: true })

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
  })

  it('is not revived by the reclaim either, so a restart cannot double the spend', async () => {
    // The same composition with the Auto-queue switch ON, which is the other
    // half of the same hole: the reclaim would requeue the live row and the
    // next pass would run a second generation while the first was still
    // being paid for. The gate does not cover this — the switch is on — so
    // the only thing standing between a restart and a double spend is the
    // same answer the stranded flag uses.
    const jobId = addJob()
    const live = addAIQueueItem({ type: 'generate_cv', jobId })
    updateSettings({ ...ALL_OFF, auto_queue_cv: true })
    const provider = inFlight()

    await session()
    expect(viewOf(live.id).status).toBe('processing')

    stopQueueProcessor()
    startQueueProcessor(60_000)
    await flush()

    expect(viewOf(live.id).status).toBe('processing')
    expect(calls('tailorDocument')).toBe(1)

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
  })

  it('a fresh row is not branded by an id a crashed row left behind', async () => {
    // The other way an id can be in the stranded set without naming an
    // abandoned row. `clearAllData` (Reset all data) replaces the store: the
    // queue is emptied and the shared `nextId` rewinds to 1, so an id the
    // stranded set is still holding — it is memory, and a reset does not
    // reach into it — is handed straight back out to an unrelated row.
    //
    // Two layers stand here. The claim drops the id (`clearStranded`), so
    // the set keeps the invariant it is built on ("an id here names a row
    // this process never claimed"), and `isStranded` refuses any row this
    // process owns, so the panel is safe even if the invariant slips. This
    // test pins the user-visible half, and it does not care which layer
    // caught it.
    const jobId = addJob()
    const dead = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    // Driven straight at the reclaim rather than through a session, because
    // a session's `stopQueueProcessor` would drop the very id under test.
    reclaimInterruptedItems()
    expect(viewOf(dead.id).stranded).toBe(true)

    const { clearAllData } = await import('./database')
    clearAllData()
    expect(getAIQueue(), 'Reset all data replaces the store').toHaveLength(0)

    // Re-mint the same id: the job takes 1, the queue row takes 2 — the id
    // the crashed row is still remembered by.
    const freshJob = addJob()
    const fresh = addAIQueueItem({ type: 'generate_cv', jobId: freshJob })
    expect(fresh.id).toBe(dead.id)
    expect(viewOf(fresh.id).stranded).toBe(false)

    // ...and while this process is running it, which is the state a Retry
    // button must never appear on.
    const provider = inFlight()
    void processQueue()
    await flush()
    const live = listQueueInPickOrder().find((r) => r.jobId === freshJob)
    expect(live?.status).toBe('processing')
    expect(live?.stranded).toBe(false)

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
  })
})

describe('Retry cannot destroy the run it lands on', () => {
  it('refuses a row this process is running, and the run finishes as it was', async () => {
    // Not a duplicate-queue problem. `retryQueueItem` writes `pending` over a
    // row with a `processItem` on the stack; that run then reaches
    // `removeAIQueueItem(item.id)` and deletes the row the user just asked to
    // re-run. The re-request is swallowed and the task disappears from the
    // panel — strictly worse than a double queue, which would at least be
    // visible.
    //
    // Unreachable from the panel (no Retry on a live row), which is exactly
    // why it survived review: `aiQueue:retry` takes whatever id the renderer
    // sends, so a stale view or any other caller reaches it directly.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    const provider = inFlight()
    await session()
    expect(viewOf(row.id).status).toBe('processing')

    const answer = retryQueueItem(row.id)

    // Not rewritten to `pending`: the write is refused, and the answer is
    // the unchanged queue (the shape every queue entry point returns), so the
    // panel keeps rendering the truth.
    const live = answer.find((r) => r.id === row.id)!
    expect(live.status).toBe('processing')
    expect(live.stranded).toBe(false)
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('processing')

    // And the in-flight run is untouched: one generation, and when it lands
    // it chains its review rather than finding its row deleted.
    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
    expect(calls('tailorDocument')).toBe(1)
    // The ORIGINAL row survives the run and is retired BY it, and the run
    // chains its review on the way out. (The chain is written from inside
    // the in-flight pass, so it is not refused by auto_queue_verify_cv the
    // way a cold `enqueue` would be — the reviewer's point is that the row
    // the user asked to re-run must not be deleted out from under a live
    // generation, and it is not.)
    expect(getAIQueue().filter((q) => q.type === 'verify')).toHaveLength(1)
    expect(getAIQueue().find((q) => q.id === row.id)).toBeUndefined()
  })

  it('and the real aiQueue:retry handler refuses it too', async () => {
    // Through the handler, so the guard cannot be satisfied by something
    // only `retryQueueItem` knows.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    const provider = inFlight()
    await session()

    const handler = handlers.get('aiQueue:retry')
    expect(handler).toBeTruthy()
    const answer = (await handler!({}, row.id)) as { id: number; status: string }[]
    expect(answer.find((r) => r.id === row.id)?.status).toBe('processing')
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('processing')

    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
    expect(calls('tailorDocument')).toBe(1)
  })

  it('still revives a failed row and a stranded one — the guard is not a gate', async () => {
    // The two rows the button exists for, so the guard above cannot be
    // widened into "refuse anything `processing`, refuse anything live"
    // without these going red.
    const jobId = addJob()
    const dead = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(dead.id).stranded).toBe(true)
    retryQueueItem(dead.id)
    expect(getAIQueue()[0].status).toBe('pending')

    updateAIQueueItem(dead.id, { status: 'failed', attempts: 4 })
    retryQueueItem(dead.id)
    expect(getAIQueue()[0].status).toBe('pending')
  })
})

describe('the sibling escape hatch: Generate on a stranded job', () => {
  it('requeues the stranded row, in place, and the pass runs it', async () => {
    // Retry is one button on the row. The other is Generate on the job, which
    // reaches the queue through `enqueue(..., { manual: true })`. That landed
    // on the stranded row, matched the duplicate guard — which covers every
    // status — and then revived nothing, because only `failed` was revived:
    // `promotedAt` was set and the row stayed `processing` for ever. No run,
    // no button that moves it, no toast. A button next to a working one that
    // silently does nothing is the defect; a user who turned CV auto-queueing
    // back on and pressed Generate was told nothing by either.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    const added = enqueue({ type: 'generate_cv', jobId }, { manual: true })

    // `null` is the documented "not newly added" answer and must not change:
    // the work already had a row, and reviving it is not a second row.
    expect(added).toBeNull()
    const rows = getAIQueue()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(row.id)
    expect(rows[0].status).toBe('pending')
    expect(viewOf(row.id).stranded).toBe(false)
    // The request is also recorded as the user's, so a later crash-reclaim or
    // revival is finishing something they asked for.
    expect(rows[0].manualQueued).toBe(true)

    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
  })

  it('does not queue a row that is already running', async () => {
    // The control, and the reason the revival above is keyed on `manual`
    // AND on the row being stranded rather than on the status. A live row
    // reads `processing` too; reviving it would put the same generation in
    // the queue a second time while the first is still being paid for.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    const provider = inFlight()
    await session()
    expect(viewOf(row.id).status).toBe('processing')

    enqueue({ type: 'generate_cv', jobId }, { manual: true })

    expect(getAIQueue().filter((q) => q.type === 'generate_cv')).toHaveLength(1)
    expect(getAIQueue()[0].status).toBe('processing')
    provider.release({ document_id: 1, content: 'CV CONTENT LINE' })
    await flush()
    expect(calls('tailorDocument')).toBe(1)
  })

  it('is still not a hole in the gate: an AUTOMATIC re-add does not revive it', async () => {
    // The fix must not turn into "any duplicate wakes a crash leftover". An
    // automatic producer re-adding the work is the app asking on its own
    // behalf, and resuming a row the user has not asked about is the
    // unattended spend the switch-off was bought to stop. So the stranded
    // revival requires `manual`.
    //
    // Built with the switch ON so the enqueue actually reaches the duplicate
    // scan: with it off, `autoQueueAllows` refuses before the scan, which
    // would make this test pass for the wrong reason.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true })
    enqueue({ type: 'generate_cv', jobId })
    await processQueue()

    expect(getAIQueue()[0].status).toBe('processing')
    expect(viewOf(row.id).stranded).toBe(true)
    expect(calls('tailorDocument')).toBe(0)
  })
})

/**
 * THE GATE. Everything else in this file is about one row; this is about
 * the promise the whole feature rests on — with the Auto-queue switches
 * off, the app spends nothing on its own, and a user turning a switch off
 * has not thereby cancelled work they queued by hand.
 *
 * Every case is written as "the switch is the discriminator": the refused
 * half is asserted, then the same row with the switch turned back on is
 * asserted to move. Without the control, "nothing happened" and "the path
 * is broken" are the same observation.
 */
describe('the gate itself', () => {
  /** Every gated type, with the switches that let it through. */
  const GATED: { type: AIQueueItem['type']; on: Switches; withDocument?: boolean }[] = [
    { type: 'score_fit', on: { auto_queue_fit: true } },
    { type: 'generate_cv', on: { auto_queue_cv: true } },
    { type: 'generate_cover_letter', on: { auto_queue_cover_letter: true } },
    { type: 'verify', on: { auto_queue_verify_cv: true }, withDocument: true },
    // Needs BOTH generation switches: the item writes both documents in one
    // pass, so honouring one of them would quietly generate the other.
    { type: 'tailor_job_docs', on: { auto_queue_cv: true, auto_queue_cover_letter: true } }
  ]

  for (const c of GATED) {
    it(`the startup reclaim skips a gated automatic ${c.type} row`, async () => {
      const jobId = addJob()
      // A `verify` row is classified by its document's type, so the document
      // is not optional here: without one the row is ungated by design.
      const documentId = c.withDocument ? createDocument('cv', 'My CV', 'body', jobId).id : undefined
      const row = strandedByCrash(c.type, jobId, false, documentId)
      updateSettings(ALL_OFF)

      await session()
      await processQueue()

      expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('processing')
      expect(viewOf(row.id).stranded).toBe(true)
      // The spend assertion is the point of the whole gate.
      expect(spend()).toBe(0)

      // ...and the switch is what stopped it, not something structural about
      // this type or this row.
      updateSettings({ ...ALL_OFF, ...c.on })
      reclaimInterruptedItems()
      expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('pending')
    })
  }

  it("the processor's revival lane skips it too, and spends no budget", async () => {
    // The lane `rg "enqueue("` cannot see. A `failed` automatic row with
    // revival budget left is woken and re-run by a pass — new provider calls
    // nobody asked for — so it takes the same gate as the reclaim.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, manualQueued: false })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 1, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    const after = getAIQueue()[0]
    expect(after.status).toBe('failed')
    // Not merely dormant: the budget was not charged either, so a gate that
    // revived and re-parked could not hide behind a row that looks asleep.
    expect(after.autoRevives).toBe(1)
    expect(spend()).toBe(0)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true })
    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
    expect(getAIQueue()[0].autoRevives).toBeGreaterThan(1)
  })

  it('AUTO_REVIVE_MAX and AUTO_REVIVE_COOLDOWN_MS are untouched', () => {
    // Asserted rather than trusted: the numbers ARE the budget, and a
    // "harmless" bump to either one is an unbounded-spend change that no
    // behavioural test in the tree would notice.
    expect(AUTO_REVIVE_MAX).toBe(3)
    expect(AUTO_REVIVE_COOLDOWN_MS).toBe(4 * 60 * 60 * 1000)
  })

  it('both restart lanes still consult the gate, and it is still narrowed', () => {
    // A source pin, because the claim under test is that these lines were
    // not touched. A diff says so once; a test says so until somebody
    // changes it.
    const src = readFileSync('electron/aiQueue.ts', 'utf8')
    const slice = (from: string, to: string): string => {
      const start = src.indexOf(from)
      expect(start, `cannot find ${from}`).toBeGreaterThan(-1)
      const end = src.indexOf(to, start)
      expect(end, `cannot find ${to}`).toBeGreaterThan(start)
      return src.slice(start, end)
    }

    const reclaim = slice('export function reclaimInterruptedItems()', 'export function startQueueProcessor(')
    expect(reclaim).toContain('mayReviveUnattended(item)')
    // The reclaim must not consult the switches directly, or a manual row
    // would need its switch on to be finished.
    expect(reclaim).not.toContain('autoQueueAllows(')

    const revival = slice('async function runPass()', 'function revive(')
    expect(revival).toContain('revive(q) && mayReviveUnattended(q)')
    expect(revival).not.toContain('autoQueueAllows(')

    // The narrowed gate itself: a hand-queued row is exempt, everything else
    // — including a row with no `manualQueued` field — consults the switch.
    const gate = slice('function mayReviveUnattended(', 'export function enqueue(')
    expect(gate).toContain('manualQueued === true')
    expect(gate).toContain('autoQueueAllows(item)')

    // The two guards this change added, pinned where they belong rather than
    // only through behaviour: the stranded flag refuses a row this process
    // owns, and Retry does too.
    expect(slice('function isStranded(', 'const strandedRowIds')).toContain('ownedByThisProcess(item.id)')
    expect(slice('export function retryQueueItem(', 'export function removeQueueItem')).toContain(
      'ownedByThisProcess(id)'
    )
  })

  it('a hand-queued row still auto-revives with every switch off', async () => {
    // The promise the gate must not cost the user: a row a person queued
    // comes back on its own exactly as it always did, because a revival
    // finishes work they requested rather than new unattended spend.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, manualQueued: true })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    // Revived and actually run, which is two: 0 -> 1 on the revive, and the
    // provider being down parked it again (1 -> 2) on the 4h cooldown.
    expect(calls('tailorDocument')).toBe(1)
    const after = getAIQueue()[0]
    expect(after.status).toBe('pending')
    expect(after.manualQueued).toBe(true)
  })

  it('a LEGACY row with no manualQueued field is automatic in both lanes', async () => {
    // Constructed by omitting the field from the store write, which is what a
    // row from before the field existed looks like. Reading absent as MANUAL
    // would hand every pre-existing row a free pass and undo the gate for
    // exactly the rows it protects.
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, undefined)
    expect('manualQueued' in row).toBe(false)
    updateSettings(ALL_OFF)

    await session()
    // Reclaim lane: left as the crash left it, and reported so the user can
    // reach it.
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('processing')
    expect(viewOf(row.id).stranded).toBe(true)

    // Revival lane: same answer, and no spend either way.
    const dead = strandedByCrash('generate_cv', addJob(), undefined)
    updateAIQueueItem(dead.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    await processQueue()
    expect(getAIQueue().find((q) => q.id === dead.id)?.status).toBe('failed')
    expect(spend()).toBe(0)

    // And the user's own way out is untouched, which is the only thing that
    // makes "automatic" a defensible answer for this row.
    retryQueueItem(row.id)
    expect(getAIQueue().find((q) => q.id === row.id)?.status).toBe('pending')
  })

  it('a row at the revival cap is still the user\'s to re-run by hand', async () => {
    // The budget bounds UNATTENDED revival, not the user. Auto-reviving is
    // the app spending on the user's behalf; Retry is the user spending.
    // Pinning the budget as a cap on the button would make a task that has
    // burned three revivals unrecoverable while the app is running — the
    // only way out would be quitting and relaunching.
    //
    // The stranded-at-the-cap case is the one that matters: it is the row
    // this feature exists for AND the row the app has given up on, so it is
    // the one where "out of budget" is most tempting to read as "closed".
    const jobId = addJob()
    const row = strandedByCrash('generate_cv', jobId, false)
    updateAIQueueItem(row.id, { autoRevives: AUTO_REVIVE_MAX, attempts: 7 })
    updateSettings(ALL_OFF)
    await session()
    expect(viewOf(row.id).stranded).toBe(true)

    // Control: the app will not touch it.
    await processQueue()
    expect(getAIQueue()[0].status).toBe('processing')
    expect(spend()).toBe(0)

    retryQueueItem(row.id)

    const revived = getAIQueue()[0]
    expect(revived.status).toBe('pending')
    // A full fresh budget of attempts...
    expect(revived.attempts).toBe(0)
    // ...and the app's own counter untouched, so the user's request is not
    // charged to the budget that governs the app.
    expect(revived.autoRevives).toBe(AUTO_REVIVE_MAX)
    await processQueue()
    expect(calls('tailorDocument')).toBe(1)
  })
})
