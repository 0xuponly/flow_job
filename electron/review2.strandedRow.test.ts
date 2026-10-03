import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// REVIEWER-ADDED (rv2-autofix). A NEW defect introduced by a36a43c's
// DEFECT 2 fix, found by reading the claim against the UI.
//
// a36a43c's justification for leaving a crashed row alone, in its own
// commit message and twice in the code comments:
//
//   "The row is not lost; it is visible in the panel, and Retry
//    resumes it ungated."          (electron/aiQueue.ts, reclaimInterruptedItems)
//   "the row stays visible in the Queue panel and the ungated Retry
//    button re-asks for it."       (commit message, RULING ON A HAND-QUEUED FAILED ROW)
//
// That escape hatch does not exist. The Retry button is rendered ONLY
// for `failed` rows:
//
//   src/notifications/QueuePanel.tsx:117
//     {item.status === 'failed' && (
//       <button ... onClick={() => onRetry(item)}>Retry</button>
//     )}
//
// and `reclaimInterruptedItems` leaves a gated AUTOMATIC row in exactly
// the one status it will never show a Retry button for:
//
//   electron/aiQueue.ts:445  if (!mayReviveUnattended(item)) continue
//
// So: the app crashes mid-generation, the user restarts with the switch
// off, and the row sits at "Processing…" (src/fitQueue.ts,
// `if (item.status === 'processing') return 'Processing…'`) for the rest
// of its life, with no Retry, and no code path that will ever move it —
// the processor only ever picks `pending`, and `reclaimInterruptedItems`
// skips it on every subsequent launch. Turning the switch back on does
// not help either: that lane runs once, at startup.
//
// This file drives both halves, so the finding is not "I read the code
// and the two halves do not meet".

const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-test-review2-stranded' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_k: string) => STORE_DIR,
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
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: () => undefined, once: () => undefined, on: () => undefined, send: () => undefined }
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

import { addAIQueueItem, createJob, getAIQueue, reloadStore, updateAIQueueItem, updateJob, updateSettings } from './database'
import { reclaimInterruptedItems, processQueue } from './aiQueue'
import { enqueueDocsBacklog, runDocsAutoQueueBacklog } from './docsAutoQueue'
import { runFitAutoScoreBacklog } from './fitAutoScore'
import { queueItemStatusText } from '../src/fitQueue'
import type { CreateJobInput } from './types'
import type { QueueItemView } from '../src/types'

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
    url: `https://example.com/review2-stranded/${nextUrl}`
  }
  return createJob(input).job.id
}

/**
 * Whether the Queue panel offers Retry for this row.
 *
 * Read from QueuePanel's OWN source rather than by rendering it: the
 * panel imports the notification API surface, and this file is a
 * main-process test with `electron` stubbed. `src/notifications/QueuePanel.tsx`
 * renders the button under exactly one condition, and that condition is
 * the whole finding — so the source is the authority and a render would
 * only be a slower way to read it.
 */
function retryButtonCondition(): string {
  const src = readFileSync('src/notifications/QueuePanel.tsx', 'utf8')
  const i = src.indexOf('onClick={() => onRetry(item)}')
  const before = src.slice(Math.max(0, i - 600), i)
  // The guard is `{canRetry(item) && (` — the predicate was extracted into a
  // named function when the `stranded` arm was added, so the real condition
  // lives in that function's body, not inline above the button. Return the
  // call site AND the predicate body together, so neither can change alone.
  const call = before.slice(before.lastIndexOf('{canRetry'))
  const m = src.match(/function canRetry\(item: QueueItemView\): boolean \{[\s\S]*?\n\}/)
  return `${call}\n${m ? m[0] : '/* canRetry not found */'}`
}

beforeEach(() => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  nextUrl = 0
  updateSettings({ base_cv: 'MASTER CV' })
})

describe('a row the crash gate strands is a DEAD END in the UI', () => {
  it('HALF 1 — the main process really does leave it `processing` forever', async () => {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()
    expect(getAIQueue()[0].status).toBe('processing')

    // Every later pass and every later launch leaves it exactly there.
    await processQueue()
    expect(getAIQueue()[0].status).toBe('processing')
    reclaimInterruptedItems()
    expect(getAIQueue()[0].status).toBe('processing')

    // Turning the switch back on DOES recover it — the lane is not a
    // one-way trip. (I asserted the opposite first and this test caught
    // me: the recovery exists, it just is not reachable from the UI.)
    // So the stranded state lasts as long as the user leaves the switch
    // off, which is exactly when they least want the app spending.
    updateSettings({ auto_queue_cv: true })
    reclaimInterruptedItems()
    expect(getAIQueue()[0].status, 'turning the switch back on recovers the row').toBe('pending')
  })

  it('HALF 2 — the Queue panel shows no Retry for a `processing` row', () => {
    // The condition under which QueuePanel renders the Retry button.
    // The gate now reads `status === 'failed' || item.stranded === true`.
    // The `failed` arm is the button's original contract and must survive;
    // the `stranded` arm is the fix for the dead end this test proved.
    expect(retryButtonCondition(), 'HALF 2').toMatch(
      /status\s*===\s*'failed'\s*\|\|\s*item\.stranded\s*===\s*true/
    )
  })

  it('...so the stranded row reads "Processing…" with no way to ask for it again', () => {
    const view = {
      id: 1,
      type: 'generate_cv',
      jobId: 1,
      jobTitle: 'Engineer',
      jobCompany: 'Acme',
      status: 'processing' as const,
      attempts: 1,
      createdAt: 0,
      nextRetryAt: 0
    } as QueueItemView
    const text = queueItemStatusText(view)
    expect(text, 'the stranded row is presented as still running').toBe('Processing…')
    expect(text).not.toMatch(/auto-retry|needs attention|failed/i)
  })

  it('CONTROL — a `failed` row does get the Retry the commit message promises', () => {
    // Without this, "no Retry for `processing`" could be satisfied by a
    // panel that offers Retry for nothing at all.
    const view = {
      id: 1,
      type: 'generate_cv',
      jobId: 1,
      jobTitle: 'Engineer',
      jobCompany: 'Acme',
      status: 'failed' as const,
      attempts: 5,
      createdAt: 0,
      nextRetryAt: 0
    } as QueueItemView
    expect(queueItemStatusText(view)).toMatch(/needs attention|auto-retry/i)
    expect(retryButtonCondition(), 'CONTROL').toMatch(/status\s*===\s*'failed'/)
  })
})

// ---------------------------------------------------------------------------
// The doc comment's OTHER inventory is short, and the previous review's
// whole Finding 3 was about a short inventory.
//
// `electron/aiQueue.ts:766` now says, of the paths that make the
// processor pick work up WITHOUT calling enqueue:
//
//   "Four exist:
//      runPass's revival of a `failed` row
//      processItem's failure-path reschedule
//      reclaimInterruptedItems at startup
//      fitAutoScore.runFitAutoScoreBacklog"
//
// Re-derived from the tree, every production write that can put a row
// into a runnable state without going through `enqueue` is:
//
//   electron/aiQueue.ts:335       rate-limit backoff, row back to pending
//   electron/aiQueue.ts:346       score_fit backoff, row back to pending
//   electron/aiQueue.ts:369-381   failure-path reschedule            [listed]
//   electron/aiQueue.ts:441-450   reclaimInterruptedItems            [listed]
//   electron/aiQueue.ts:518-527   runPass revival                    [listed]
//   electron/aiQueue.ts:611-613   retryQueueItem (Retry, MANUAL)  [NOT listed]
//   electron/docsAutoQueue.ts:280 periodic sweep add              [NOT listed]
//   electron/docsAutoQueue.ts:282 periodic sweep revive          [NOT listed]
//   electron/docsAutoQueue.ts:370 startup/post-scan revive       [NOT listed]
//   electron/fitAutoScore.ts:150  fit re-seeder resurrect           [listed]
//   electron/fitAutoScore.ts:158  fit re-seeder add              [NOT listed]
//
// Eleven, not four. The comment is the document the next reviewer trusts
// instead of counting — the previous review's Finding 3 was precisely a
// comment that said five, named six, and missed the seventh, and this one
// repeats the shape of that mistake three commits later.
//
// REPORTED, not fixed: correcting the wording is the team's call, and a
// wrong count in a comment is documentation debt rather than a spend
// leak. The cases below are the part that is NOT documentation — they
// assert that each of the unlisted lanes is actually gated, so "the
// comment is incomplete" and "the gate is incomplete" stay separable.
// ---------------------------------------------------------------------------

describe('every NON-enqueue lane that can make a row runnable is gated', () => {
  it('the two processItem backoff requeues are in-run, not revivals, and ungated by design', async () => {
    // aiQueue.ts:335 / :346. These requeue the row the pass is already
    // working on, after an attempt that was itself sanctioned. Gating
    // them would refuse a run the app had already begun.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'pending', attempts: 1, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)
    const { processQueue } = await import('./aiQueue')
    await processQueue()
    // It ran, failed, and was NOT parked on the 4h cooldown (that is
    // the else branch, gated separately) — it is terminal or backoff'd
    // by attempts, never revived with a fresh budget.
    const after = getAIQueue()[0]
    expect(after.autoRevives ?? 0).toBe(0)
  })

  it('the periodic docs sweep is gated per-unit by the switches', () => {
    // docsAutoQueue.ts:262 `if (!unit.enabled) continue`, where the units
    // come from `docUnits(autoQueueFlags())` at :251. Proved by driving
    // the real sweep with the switches off and the switches on.
    const jobId = addJob()
    updateJob(jobId, { score: 95, fit_score_version: 1, description: 'd' })
    updateSettings(ALL_OFF)
    expect(runDocsAutoQueueBacklog()).toBe(0)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true, auto_queue_cover_letter: true })
    expect(runDocsAutoQueueBacklog()).toBeGreaterThan(0)
  })

  it('the startup docs backlog is gated per-unit by the switches', () => {
    const jobId = addJob()
    updateJob(jobId, { score: 95, fit_score_version: 1, description: 'd' })
    updateSettings(ALL_OFF)
    expect(enqueueDocsBacklog()).toBe(0)

    updateSettings({ ...ALL_OFF, auto_queue_cv: true, auto_queue_cover_letter: true })
    expect(enqueueDocsBacklog()).toBeGreaterThan(0)
  })

  it('the fit re-seeder is gated by auto_queue_fit', () => {
    const jobId = addJob()
    updateJob(jobId, { score: null, fit_score_version: null })
    updateSettings(ALL_OFF)
    expect(runFitAutoScoreBacklog()).toBe(0)

    updateSettings({ ...ALL_OFF, auto_queue_fit: true })
    expect(runFitAutoScoreBacklog()).toBe(1)
  })

  it('the fit re-seeder cannot resurrect a row the switch is off for, even a manual one', () => {
    // The un-listed fitAutoScore.ts:150 resurrect. `auto_queue_fit` off
    // short-circuits the whole function at :88, before the loop, so no
    // row of any origin is touched.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'score_fit', jobId, manualQueued: true })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 9, autoRevives: 0, nextRetryAt: 0 })
    updateJob(jobId, { score: null, fit_score_version: null })
    updateSettings(ALL_OFF)

    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(getAIQueue()[0].status).toBe('failed')
  })
})
