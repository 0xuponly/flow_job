import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// REVIEWER-ADDED (rv2-autofix). Attacking 88c3cfe's `manualQueued`
// origin flag — new state on a PERSISTED row, which is the only kind of
// change that can be right in every test and still lose a user's data on
// upgrade.
//
// 88c3cfe's stated rules, which this file attacks from both sides:
//
//   R1  absent  => AUTOMATIC  (legacy rows stay gated; the spend leak
//                             stays closed)
//   R2  manualQueued survives store round-trips AND revivePatch()
//   R3  set on all four manual producers, on none of the automatic ones
//   R4  MANUAL rows keep every restart behaviour they had before a36a43c
//
// The direction that matters most is the REVERSE one the commit does not
// test: if an AUTOMATIC row ever becomes flagged manual, it is ungated,
// it revives forever on the 4h cooldown, and that is the expensive
// direction. Everything in the "reverse bug" section hunts that.

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-review2-origin-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
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

// Provider down: a row that has failed is normally in this state, and
// the mock call count is a direct measure of tokens spent unattended.
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

import { addAIQueueItem, createDocument, createJob, getAIQueue, reloadStore, updateAIQueueItem, updateJob, updateSettings } from './database'
import { processQueue, reclaimInterruptedItems, enqueue, retryQueueItem } from './aiQueue'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { enqueueDocsBacklog } from './docsAutoQueue'
import { runFitAutoScoreBacklog } from './fitAutoScore'
import * as ai from './ai'
import { RateLimitError } from './ai'
import type { CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const ALL_OFF = {
  auto_queue_fit: false,
  auto_queue_cv: false,
  auto_queue_cover_letter: false,
  auto_queue_verify_cv: false,
  auto_queue_verify_cover_letter: false
}

let nextUrl = 0
function addJob(): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/review2-origin/${nextUrl}`
  }
  return createJob(input).job.id
}

function calls(name: 'tailorDocument' | 'verifyDocumentContent' = 'tailorDocument'): number {
  return vi.mocked(ai[name]).mock.calls.length
}

beforeEach(async () => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  nextUrl = 0
  updateSettings({ base_cv: 'MASTER CV' })
  for (const m of [ai.tailorDocument, ai.verifyDocumentContent]) vi.mocked(m).mockClear()
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
})

// ---------------------------------------------------------------------------
// R1 — ABSENT MEANS AUTOMATIC.
//
// The brief's question: "does mayReviveUnattended treat undefined as
// automatic, so all pre-existing queue rows silently stop being revived
// the moment this ships?"
//
// Answer: YES, by design, and the cost is real. This section pins the
// mechanism and the direction, and states the user-visible consequence
// so it cannot be rediscovered as a surprise.
// ---------------------------------------------------------------------------

describe('a LEGACY row — no manualQueued field at all', () => {
  it('is treated as AUTOMATIC by runPass: no revive, no tokens', async () => {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    // The literal pre-88c3cfe row shape: no `manualQueued` key on it.
    expect(Object.keys(row)).not.toContain('manualQueued')
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    expect(getAIQueue()[0].status).toBe('failed')
    expect(calls()).toBe(0)
  })

  it('is treated as AUTOMATIC by reclaimInterruptedItems: stays `processing`', () => {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('processing')
  })

  it('is treated as AUTOMATIC by the failure-path reschedule: terminal, not parked', async () => {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'pending', attempts: 12, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    expect(getAIQueue()[0].status).toBe('failed')
    expect(getAIQueue()[0].nextRetryAt).toBeLessThanOrEqual(Date.now())
  })

  it('STILL REVIVES with its switch ON, so "absent is automatic" is not "absent is dead"', async () => {
    // The half that makes the ruling a trade rather than a stranding.
    // Without this, the three cases above would also pass on a gate that
    // refused every legacy row unconditionally.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })

    await processQueue()

    expect(getAIQueue()[0].status).toBe('pending')
    expect(calls()).toBe(1)
  })

  it('the stranding is bounded and recoverable: Retry still works on a legacy row', () => {
    // The escape hatch the ruling leans on, pinned. A legacy row that
    // stops reviving is visible in the Queue panel and the user re-asks
    // for it; if THAT stopped working the ruling would be a stranding.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 3, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    retryQueueItem(row.id)

    expect(getAIQueue()[0].status).toBe('pending')
    // Retry does NOT promote the row to manual — it is one run, not a
    // standing exemption. Proven in the reverse-bug section too.
    expect(getAIQueue()[0].manualQueued).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// R2 — the flag survives everything a row goes through.
//
// The reclaim lane runs at STARTUP, so a flag held only in memory is
// worth nothing. `revivePatch()` is the single definition of a revive,
// used by Retry AND by enqueue's dedupe path.
// ---------------------------------------------------------------------------

describe('the origin survives the row', () => {
  it('survives revivePatch — Retry does not erase it', () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    const row = getAIQueue()[0]

    retryQueueItem(row.id)

    expect(getAIQueue()[0].manualQueued, 'a revived manual row must keep its origin').toBe(true)
  })

  it('survives a store round trip — the reclaim lane reads it from disk', async () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    await new Promise((r) => setTimeout(r, 0)) // persistStore chains onto a promise
    reloadStore()
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('survives the processor claiming the item (promotedAt is cleared, origin is not)', async () => {
    // `processItem` does `updateAIQueueItem(id, { status: 'processing',
    // promotedAt: undefined })` on the way in (aiQueue.ts:140). If that
    // patch dropped the origin, every manual row would silently become
    // automatic the first time the processor touched it — which is
    // exactly the reverse bug, reached through normal operation.
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    await processQueue()
    expect(getAIQueue()[0].manualQueued, 'claiming a row must not un-manual it').toBe(true)
  })

  it('survives the failure-path reschedule', async () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    await processQueue()
    // Parked or failed, the row must still know a person asked for it.
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('survives runPass reviving it', async () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    const row = getAIQueue()[0]
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('survives the documents-backlog sweep reviving it (a direct updateAIQueueItem)', async () => {
    // `enqueueDocsBacklog` writes its revive straight through
    // `updateAIQueueItem` (docsAutoQueue.ts:370), bypassing enqueue. A
    // patch that rebuilt the row instead of merging would drop the flag
    // here; `updateAIQueueItem` spreads, so it survives.
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    const row = getAIQueue()[0]
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    enqueueDocsBacklog()
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// THE REVERSE BUG — an automatic row that ends up flagged manual.
//
// The expensive direction, and the one 88c3cfe does not test. If any
// automatic producer, any queue mutation, or any dedupe path can set the
// flag, that row is ungated for the rest of its life: revived up to
// AUTO_REVIVE_MAX times, four hours apart, with the switch OFF.
// ---------------------------------------------------------------------------

describe('no AUTOMATIC producer can flag a row manual', () => {
  it('an automatic enqueue writes false, never absent and never true', () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId })
    const row = getAIQueue()[0]
    expect(row.manualQueued, 'an automatic row must be recorded as automatic').toBe(false)
  })

  it('the fit-landing trigger (fitScorer.ts:133) writes false', () => {
    const jobId = addJob()
    updateJob(jobId, { score: 0.9, fit_score_version: 0 })
    expect(maybeAutoEnqueueDocs(jobId)).toBe(true)
    expect(getAIQueue()[0].manualQueued).toBe(false)
  })

  it('the processor\'s own generation→review chain writes false', async () => {
    // The chain that fires after a row the USER queued. This is the
    // subtle one: a manual `generate_cv` row legitimately produces an
    // automatic `verify` row, and if the chain inherited the manual flag
    // the review would be ungated. It must not.
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    // The generation has to SUCCEED for the chain at aiQueue.ts:177 to
    // fire; with the provider down the catch runs instead. `content` is
    // part of the `TailorResult` contract and is not optional: the case
    // hands it to the sanitizer that stores the culled text, so a mock
    // that omits it (as this one did, behind an `as never`) threw inside
    // the case and the chain below it never ran.
    vi.mocked(ai.tailorDocument).mockResolvedValueOnce({
      content: 'CONTENT',
      document_id: doc.id
    } as never)
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    await processQueue()
    const rows = getAIQueue()
    const verify = rows.find((r) => r.type === 'verify')
    expect(verify, 'the generation→review chain must have fired').toBeTruthy()
    expect(verify!.manualQueued, 'the app\'s own follow-up must be gated').toBe(false)
  })

  it('the processor\'s own review→regenerate chain writes false', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    // A review that comes back as a real low score, so the loop fires.
    vi.mocked(ai.verifyDocumentContent).mockResolvedValueOnce({
      kind: 'review',
      score: 10,
      passed: false,
      issues: ['x']
    } as never)
    enqueue({ type: 'verify', jobId, documentId: doc.id }, { manual: true })
    await processQueue()
    const regen = getAIQueue().find((r) => r.type === 'generate_cv')
    expect(regen, 'the regenerate chain must have fired').toBeTruthy()
    expect(regen!.manualQueued, 'the app\'s own rebuild must be gated').toBe(false)
  })

  it('an automatic enqueue landing on a MANUAL row does not DOWNGRADE it', () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    enqueue({ type: 'generate_cv', jobId }) // automatic, lands on the manual row
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('an automatic enqueue landing on an AUTOMATIC row does not UPGRADE it', () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId })
    enqueue({ type: 'generate_cv', jobId })
    expect(getAIQueue()).toHaveLength(1)
    expect(getAIQueue()[0].manualQueued).toBe(false)
  })

  it('the Retry button does not promote an automatic row to manual', () => {
    // Deliberate: Retry is one run, not a standing exemption. If it set
    // the flag, a single Retry on an automatic row would exempt it from
    // the switch for the rest of the row's life — a one-click way to
    // reopen the exact leak a36a43c closed.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0 })
    updateSettings(ALL_OFF)

    retryQueueItem(row.id)

    expect(getAIQueue()[0].manualQueued).toBeUndefined()
  })

  it('a manual re-add DOES promote (the one sanctioned promotion)', () => {
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId })
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    expect(getAIQueue()).toHaveLength(1)
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('the fit re-seeder\'s direct addAIQueueItem leaves the field ABSENT, which reads automatic', () => {
    // `runFitAutoScoreBacklog` does not go through enqueue
    // (fitAutoScore.ts:158) — the one non-enqueue producer the doc
    // comment lists. Its rows carry no field at all, so `mayReviveUnattended`
    // consults the switch for them. That is the correct direction.
    const jobId = addJob()
    updateJob(jobId, { score: null, fit_score_version: null })
    updateSettings({ auto_queue_fit: true })
    runFitAutoScoreBacklog()
    expect(getAIQueue().some((r) => r.type === 'score_fit')).toBe(true)
    for (const r of getAIQueue().filter((q) => q.type === 'score_fit')) {
      expect(r.manualQueued).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// R3/R4 — the four manual producers, end to end.
//
// 88c3cfe pins the ORIGIN at the call site by a source scan and the
// BEHAVIOUR of the manual exemption by hand-written rows. Neither proves
// the four real ipcMain handlers leave a row that the restart lanes will
// actually exempt. These drive the handlers.
// ---------------------------------------------------------------------------

describe('the four REAL manual producers leave a restart-exempt row', () => {
  it('tailor:quickApply (no AI needed) leaves manualQueued true', async () => {
    const jobId = addJob()
    updateSettings(ALL_OFF)
    await handlers.get('tailor:quickApply')!({}, jobId)
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('documents:verify leaves manualQueued true', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    updateSettings(ALL_OFF)
    // Provider down, not throttled — the handler rethrows rather than
    // queueing. Force the queueing branch with a RateLimitError.
    vi.mocked(ai.verifyDocumentContent).mockRejectedValueOnce(new RateLimitError('429'))
    await handlers.get('documents:verify')!({}, jobId, doc.id, 'cv')
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('ai:tailor leaves manualQueued true', async () => {
    const jobId = addJob()
    updateSettings(ALL_OFF)
    vi.mocked(ai.tailorDocument).mockRejectedValueOnce(new RateLimitError('429'))
    await handlers.get('ai:tailor')!({}, { job_id: jobId, document_type: 'cv' })
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

  it('documents:regenerateSection leaves manualQueued true', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    updateSettings(ALL_OFF)
    vi.mocked(ai.regenerateSection).mockRejectedValueOnce(new RateLimitError('429'))
    await handlers.get('documents:regenerateSection')!({}, doc.id, 'Summary', jobId)
    expect(getAIQueue()[0].manualQueued).toBe(true)
  })

it('...and a row a real handler queued really does revive with the switch off', async () => {
    // The end-to-end half. Driving the handler proves the flag is set;
    // this proves the flag is what the lanes read. Without it, the four
    // cases above would also pass if `mayReviveUnattended` ignored it.
    //
    // `ai:tailor` rather than Quick Apply: `tailor_job_docs` swallows a
    // provider failure inside `timed()` and the row is REMOVED on
    // completion, so a `generate_cv` row is the type that survives a
    // failed run and is therefore the one a revival has to act on.
    const jobId = addJob()
    updateSettings(ALL_OFF)
    vi.mocked(ai.tailorDocument).mockRejectedValueOnce(new RateLimitError('429'))
    await handlers.get('ai:tailor')!({}, { job_id: jobId, document_type: 'cv' })
    vi.mocked(ai.tailorDocument).mockClear() // count only the REVIVAL's call
    const row = getAIQueue()[0]
    expect(row.manualQueued).toBe(true)
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })

    await processQueue()

    expect(getAIQueue()[0].status, 'the manual row was revived').toBe('pending')
    expect(calls(), 'the manual exemption really does spend, which is the point').toBe(1)
  })

it('...and a row a real handler queued is really reclaimed from a crash', async () => {
    const jobId = addJob()
    updateSettings(ALL_OFF)
    vi.mocked(ai.verifyDocumentContent).mockRejectedValue(new RateLimitError('429'))
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    await handlers.get('documents:verify')!({}, jobId, doc.id, 'cv')
    const row = getAIQueue()[0]
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('pending')
  })
})