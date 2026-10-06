import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron'
import { join } from 'path'
import { openQuickAddWindow } from './quickAddWindow'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import * as db from './database'
import * as secureStore from './secureStore'
import {
  appendAudit,
  detectSyncedFolder,
  signManifest,
  unwrapDekWithPassphrase,
  verifyManifest,
  wrapDekWithPassphrase
} from './backupCrypto'
import { tailorDocument, generateFollowUpMessage, regenerateSection, verifyDocumentContent, scoreJobFit, extractJobKeywordsV3, RateLimitError, resetModelHealthByIds, withAiOperation, type AiCallOptions } from './ai'
import { providerSpendRows, type ProviderSpend } from './providerSpend'
import { sanitizeDocument } from './tailorJobDocs'
import { scoreOneJobInBackground } from './fitScorer'
import { countPdfPages } from '../src/cvOnePage'
import { buildPdfHtml } from './pdfTemplate'
import { extractJobKeywordsStructured } from '../src/keywordExtractor'
import { scrapeJobFromUrl } from './jobScraper'
import { scanAllBoards, BOARDS } from './jobSearch'
import { computeScanEstimate } from './scanEstimate'
import { closeCamoufox } from './browserScraper'
import { createLogger } from './logger'
import { installStderrFilter } from './stderrFilter'

// Capture Electron's IPC-handler rejection dumps and known-harmless
// Chromium stderr noise into file logs instead of the terminal. See
// stderrFilter.ts. Set FLOW_JOB_VERBOSE=1 to restore full terminal output.
installStderrFilter()

// Small helpers used by the backup flow. Defined at module scope
// (not inside registerIpc) so the audit logger can call them.
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function stripHmac(manifest: Record<string, unknown>): Record<string, unknown> {
  // Deep-clone without the hmac field. The HMAC is computed over
  // every other field so the verifier can re-derive it from the
  // manifest-on-disk minus the stored signature.
  if (Array.isArray(manifest)) return manifest.map(stripHmac) as unknown as Record<string, unknown>
  if (manifest && typeof manifest === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(manifest)) {
      if (k === 'hmac') continue
      out[k] = stripHmac(v as Record<string, unknown>)
    }
    return out
  }
  return manifest
}
import { formatLocation } from './utils'
import { notifyStoreChanged } from './notifyStoreChanged'
import { startQueueProcessor, stopQueueProcessor, enqueue, listQueueInPickOrder, retryQueueItem, removeQueueItem, clearQueue, aiQueueBlockedState } from './aiQueue'
import type { AIQueueBlockedState } from './aiQueue'
import { scheduleNextAutoScan, cancelAutoScan, markScanStarted, markScanCompleted, restartAutoScanTimer } from './autoScan'
import { scheduleNextFitAutoScore, restartFitAutoScoreTimer, enqueueScoreFitBacklog } from './fitAutoScore'
import { scheduleNextDocsAutoQueue, restartDocsAutoQueueTimer, enqueueDocsBacklog } from './docsAutoQueue'
import {
  addNotification,
  listActiveNotifications,
  dismissNotification,
  dismissNotifications,
  dismissAllNotifications,
  purgeOldDismissedNotifications,
  startNotificationsPurgeInterval
} from './notifications'

// Pin the userData directory to the original "apply-assistant" location so
// existing users' data (jobs, documents, settings) is found after the rename.
// electron-builder's productName (now "FlowJob") would otherwise redirect
// app.getPath('userData') to ~/Library/Application Support/FlowJob/, which
// is empty. Called before app.whenReady() so the path resolves correctly
// the first time anything reads it. Must run before any code that calls
// app.getPath('userData') (database.ts::getStorePath, etc.).
app.setName('apply-assistant')

// Silence noisy Chromium internal logs in the dev terminal — most
// notably WebRTC STUN DNS lookups (stun.l.google.com,
// stun.cloudflare.com) which fail and spam
// `socket_manager.cc(147)` errors every time a BrowserWindow is
// created. Level 3 = LOG_FATAL only; app-level console.log/console.error
// are unaffected.
app.commandLine.appendSwitch('log-level', '3')

// File-backed category loggers. Each category writes to
// <userData>/logs/<category>.log so the per-import scraper trace
// and other category logs don't spam the dev terminal. The default
// log dir is resolved by logger.createLogger on first use.
export const log = {
  scraper: createLogger('scraper'),
  scanner: createLogger('scanner'),
  fit: createLogger('fit'),
  startup: createLogger('startup'),
  backup: createLogger('backup'),
  notifications: createLogger('notifications'),
  crash: createLogger('crash')
}

// Global crash safety net: unhandled rejections and uncaught exceptions
// in the main process are written to logs/crash.log instead of being
// dumped to the terminal (Electron's default). Registering these
// listeners suppresses that default print. An uncaught exception
// additionally toasts the renderer (channel 'main:errorToast', wired in
// Task 3) so the user knows something failed behind the scenes.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || `${reason.name}: ${reason.message}` : String(reason)
  log.crash.error(`unhandledRejection: ${msg}`)
})

process.on('uncaughtException', (err) => {
  log.crash.error(`uncaughtException: ${err.stack || `${err.name}: ${err.message}`}`)
  const message = `Internal error: ${err.message}`

  // A crash is a fact, so it goes in the notification center as a record
  // FIRST, here in the main process rather than in the renderer — and that
  // placement is the fix for the hole the routing below still has.
  //
  // The toast below goes to the focused window. A focused window cannot
  // render a toast: quickadd.tsx mounts neither the toast host nor the
  // main-error hook, and it is `alwaysOnTop` and explicitly focused, so
  // while it is open a real crash is delivered to a renderer that drops it
  // and the main window, which can show it, is never asked. Writing to the
  // store instead sidesteps window routing entirely: the center is read
  // out of the one shared store, so the crash is in the main window's
  // notification center by the next time the user opens it, whether or not
  // a toast ever appeared.
  //
  // `full_message` is the stack, not the sentence: a crash is the one
  // notification where the detail is the whole value and the toast could
  // never carry it.
  try {
    addNotification({
      type: 'error',
      source: 'app',
      message,
      full_message: err.stack || `${err.name}: ${err.message}`,
      group_key: `error|app|internal error: ${err.name}`,
    })
    // And the ping, which is what makes it a notification rather than a
    // line in a file. Without it the record is durable and invisible: the
    // drawer re-reads on open, so the user finds the crash only if they
    // happen to open the center and look, and the badge — the one thing on
    // screen that says "there is something you have not seen" — stays dark.
    notifyStoreChanged()
  } catch (notifyErr) {
    // A store that cannot be written must not mask the crash that is
    // already logged above. crash.log still has it either way. Notifying
    // from inside this catch would be worse than useless: with nothing in
    // the store, a badge that re-reads would find nothing to show.
    log.crash.error(`could not record the crash as a notification: ${String(notifyErr)}`)
  }

  // One window, not all of them. Broadcasting made a single crash cost
  // the user one toast per open window, so an error they caused in the
  // quick-add mini-window also lit up the main window they were not
  // even looking at. The focused window is the one whose user can act on
  // it; with nothing focused (the app is in the background) the first
  // still-alive window is the closest thing to "whoever is watching".
  //
  // `webContents` is checked as well as the window: a window can outlive
  // its renderer (a crashed tab, a window mid-teardown), and `send` on a
  // destroyed WebContents throws — from inside the handler for uncaught
  // exceptions, which loses the remaining windows' toasts and replaces
  // one reported crash with a second, confusing one.
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
    target.webContents.send('main:errorToast', message)
  }
})

// Top-level wrapper for IPC-handler catch blocks to call without
// pulling the full `log.notifications` reference into each handler.
// The IPC brief for the notification center prescribes a single
// `logToNotifications(msg)` entry point so handler bodies stay
// consistent with the other notification helpers.
function logToNotifications(msg: string): void {
  log.notifications.warn(msg)
}

import type {
  ApiModelConfig,
  Application,
  CreateJobInput,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  NotificationSource,
  NotificationJobContext,
  QueueItemView,
  ScanFilters,
  ScanResult,
  Settings,
  TailorRequest,
  TailorResult,
  VerificationResult
} from './types'

// Module-level scan state — survives tab switches in the renderer
const _scanState: { scanning: boolean; progress: string[]; result: ScanResult | null; startedAt: number | null } = {
  scanning: false,
  progress: [],
  result: null,
  startedAt: null
}
// Active scan's AbortController — created when a scan starts, aborted on
// user cancel. Replaces itself on the next scan.
let _scanAbortController: AbortController | null = null
// Active import-from-link's AbortController. Same pattern as the scan one;
// created per import, replaced on the next import, aborted on user cancel.
let _importAbortController: AbortController | null = null

function createWindow(): void {
  const { height: displayHeight } = screen.getPrimaryDisplay().workAreaSize
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: displayHeight,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: 'FlowJob',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Window is shown immediately (show: true); backgroundColor '#0f1117'
  // matches the splash in index.html, so there is no flash. The splash is
  // removed by the renderer after first paint (see src/main.tsx).

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Defer the store-touching startup work until the renderer has finished
  // loading: the first loadStore() is a ~0.63s synchronous read that, if it
  // runs between loadFile and dom-ready, delays first paint ~1:1. Fires after
  // the page body is available but before the renderer's first data IPC.
  // Idempotent + flag-gated, so re-running on a reopened (macOS activate)
  // window is safe.
  mainWindow.webContents.once('did-finish-load', () => {
    runDeferredStoreWork()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * One tailoring call, and the SANITIZED text stored and returned.
 *
 * The `ai:tailor` handler's whole body, lifted out so the handler can stay
 * what it has always been: "try the model now, fall back to the queue when
 * the provider is throttling".
 *
 * WHY THE SANITIZING HAPPENS HERE. `tailorDocument` has to store the raw
 * provider output, because the ceilings and the rule checks can only run
 * once the model has returned — so sanitizing is the CALLER's job, and there
 * are exactly three callers. Two of them discharge it (the per-unit
 * `generate_cv` / `generate_cover_letter` case in aiQueue.ts, and
 * `tailorJobDocsForJob`); this one did not, for as long as ai.ts's comment
 * said the enforcement "runs downstream". It does not: this is a synchronous
 * handler that returns a document, not a queue item a processor then
 * sanitizes. So a user who clicked Tailor / Generate — and the renderer's
 * own five-attempt regeneration loop, which calls the same channel — got
 * unsanitized model prose in the same `documents` table the other two lanes
 * protect. That is R3, on the other lane.
 *
 * `sanitizeDocument` is imported, not restated, so all three store paths
 * share ONE implementation and cannot drift.
 *
 * Deliberately placed AFTER `withAiOperation`, so the sanitizing and the
 * store write happen with the AI slot released: neither is a model call, and
 * holding a slot across a full-store encrypt-and-rename would serialise the
 * queue behind it.
 *
 * `setDocumentContent` is an UPDATE of the row `tailorDocument` already
 * created — one generation, one row, one create plus this write, exactly the
 * shape both queue lanes use. Not `writeDocuments`, which was deleted for
 * inserting a second row per document.
 *
 * A `null` return means the user deleted the document in the gap and is left
 * as-is: inserting a replacement would resurrect it behind their back. The
 * returned id is then the one that was asked for, which is what
 * `tailorDocument` does in the same situation, so the renderer's
 * regeneration loop is never handed an id it did not have.
 *
 * The SANITIZED text is what goes back to the renderer, not the raw bytes:
 * `handleTailor` stores the returned `document_id` on the job's application
 * and `regenerateDocument` feeds `result.content` back in as `prevContent`
 * for the next of its five rounds, so returning the raw text would mean the
 * next iteration is built on prose this call just culled.
 */
async function tailorAndSanitize(
  request: TailorRequest,
  opts: AiCallOptions
): Promise<TailorResult> {
  const result = await withAiOperation(() => tailorDocument(request, opts))
  const docType: 'cv' | 'cover_letter' =
    request.document_type === 'cv' ? 'cv' : 'cover_letter'
  const sanitized = sanitizeDocument(
    result.content,
    docType,
    db.getJob(request.job_id)?.description ?? ''
  )
  const stored = db.setDocumentContent(result.document_id, sanitized.content)
  return { content: sanitized.content, document_id: stored?.id ?? result.document_id }
}

function registerIpc(): void {
  /**
   * The one flag that says "a person asked for this".
   *
   * The same division the queue draws with `manualQueued` on a row, applied
   * at the request itself: the per-provider spend cap in ai.ts stops the app
   * spending on its OWN work — the queue, the backlog sweeps, the fit
   * re-seeder, background document generation — and never stops a user
   * pressing a button. Every handler below that a person triggers passes
   * this.
   *
   * Automatic producers deliberately do NOT pass it, including the ones
   * that hang off a user gesture: adding a job by hand (jobs:create,
   * jobs:importFromUrl) fires a background fit score the user never asked
   * for, so it is the app's spend and is capped like any other. Nothing is
   * lost by that — the hourly fit re-seeder picks the job up once there is
   * budget again. A board scan is the same: `jobs:scanBoards` re-seeds the
   * fit and document backlogs afterwards, and that work is the app's, not
   * the user's.
   *
   * THIS CONSTANT IS NOT THE WHOLE INVENTORY, and it is the half that was
   * missed. It covers a request the app answers IN THE CALL: the user
   * presses Verify and the handler awaits the answer. It cannot cover a
   * request whose ONLY delivery mechanism is the queue, because nothing is
   * awaited and nobody gets an answer until a pass picks the row up — and
   * four of the handlers below hand such a request to `enqueue` when the
   * direct call has already thrown (`documents:verify`,
   * `documents:regenerateSection`, `ai:tailor`), while `tailor:quickApply`
   * is nothing but an enqueue. Those rows were then processed as automated
   * work, so a button press could be parked on a full day's budget for up to
   * 24h: a real regression, reproduced by the reviewer on a Quick Apply row
   * that sat `parkedReason: 'provider_cap'` with 0 outbound requests over
   * 6.7 hours while holding `manualQueued: true`.
   *
   * So those five call sites ALSO pass `{ present: true }`, which is a
   * different claim with a different life: `manualQueued` on the row records
   * that a person asked once and is permanent, and `userPresentAt` records
   * that they are still waiting and is spent by the processor at the row's
   * next claim. The first is provenance and the second is presence, they
   * cannot be read as each other, and `aiQueue.enqueue`'s doc carries the
   * full list of which is which. See `AIQueueItem.userPresentAt`.
   *
   * AND "EVERY HANDLER BELOW THAT A PERSON TRIGGERS PASSES THIS" IS A CLAIM
   * ABOUT THE CALL GRAPH, NOT ABOUT THE FLAG, so the channel is where it is
   * enforced. Two of the four handlers above were ALSO reached by the job
   * page's automatic verification sweep — `useEffect(() => load(), [job.id])`
   * on mount, the sidebar's Refresh, and after every Generate / Apply /
   * status change all re-run it — which then called the very channels the
   * buttons call. So opening a page armed a presence grant nobody asked for,
   * and the reviewer's probe bought five uncapped requests from five page
   * opens on a ledger already 7 calls against a cap of 1. Nothing about
   * `{ present: true }` was wrong; the caller was.
   *
   * So the automatic sweep no longer reaches a gesture handler. It has its
   * OWN channels (`documents:autoVerify`, `ai:autoTailor`, below), which run
   * `AUTOMATED` calls, and whose fallback rows carry neither `manual` nor
   * `present` — they are the app's own work, so they are capped like it and
   * gated by the `auto_queue_*` switches like it. Each pair shares ONE
   * implementation of the direct call and one `byPress` argument; the queue
   * row each handler creates is written in that handler, where the flags are
   * a thing a reader (and an audit) can see. Which channel a renderer call
   * site chose is therefore the whole claim, and
   * `review.enqueueCallSites.test.ts` re-derives it from `src/`,
   * transitively, so a sweep that reaches a gesture channel again fails there
   * rather than in a user's spend.
   */
  const MANUAL: AiCallOptions = { manual: true }

  /**
   * The absence of `MANUAL`, which is not the same as nothing: it is the
   * answer to "nobody is waiting for this", and it is the one that keeps the
   * app's own spend on the app's own budget.
   *
   * An object rather than `undefined` so the call sites read as a decision.
   * `verifyDocumentContent(jobId, documentId, docType)` with no options has
   * always meant automated (see `AiCallOptions`) and still does; naming it
   * says which of the two intents a handler is implementing at the point the
   * argument is threaded in.
   */
  const AUTOMATED: AiCallOptions = {}

  ipcMain.handle('dashboard:stats', () => db.getDashboardStats())

  // Quick-add mini-window: opened from the sidebar so it survives a
  // minimized main window (window creation lives in the main process).
  ipcMain.handle('quickadd:openWindow', () => {
    openQuickAddWindow()
  })

  ipcMain.handle('jobs:list', (_e, status?: JobStatus) => db.listJobs(status))
  ipcMain.handle('jobs:get', (_e, id: number) => db.getJob(id))
  ipcMain.handle('jobs:create', (_e, input: CreateJobInput) => {
    const dup = db.findDuplicateJob(input)
    if (dup) throw new Error(`Job already exists. (${dup.title} @ ${dup.company})`)
    // `force: true` lets the user re-add a previously-deleted job
    // from the manual-add form. The deleted-jobs blacklist entry is
    // preserved (so the scanner won't auto-re-add it) and
    // `wasBlacklisted` is returned so the renderer can prompt the
    // user to confirm.
    const { job, wasBlacklisted } = db.createJob(input, { skipDuplicateCheck: true, force: true })
    // Fire-and-forget background fit scoring. The job starts with
    // score=null and is updated in place when the LLM call resolves
    // (or falls back to a heuristic). Errors surface as fit_last_error
    // in the row.
    void withAiOperation(() => scoreOneJobInBackground(job.id))
    return { job, wasBlacklisted }
  })
  ipcMain.handle('jobs:update', (_e, id: number, fields: Partial<CreateJobInput & { status: JobStatus }>) =>
    db.updateJob(id, fields)
  )
  ipcMain.handle('jobs:delete', (_e, id: number) => db.deleteJob(id))
  ipcMain.handle('jobs:deleteMany', (_e, ids: number[]) => db.deleteJobs(ids))
  ipcMain.handle('jobs:dedupe', () => db.dedupeJobs())
  ipcMain.handle('jobs:search', (_e, query: string) => db.searchJobs(query))
  ipcMain.handle('jobs:importFromUrl', async (_e, url: string) => {
    _importAbortController = new AbortController()
    try {
      const input = await scrapeJobFromUrl(url, _importAbortController.signal)
      const dup = db.findDuplicateJob(input)
      if (dup) throw new Error(`Job already exists. (${dup.title} @ ${dup.company})`)
      // `force: true` lets the user re-add a previously-deleted job
      // from a link. The deleted-jobs blacklist entry is preserved
      // (so the scanner won't auto-re-add it) and `wasBlacklisted` is
      // returned so the renderer can prompt the user to confirm.
      const { job, wasBlacklisted } = db.createJob(input, { skipDuplicateCheck: true, force: true })
      // Fire-and-forget background fit scoring for the imported job.
      void withAiOperation(() => scoreOneJobInBackground(job.id))
      // Notify all renderers that a job was imported so lists can refresh.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('job:imported', job)
      }
      return { job, wasBlacklisted }
    } finally {
      _importAbortController = null
    }
  })

  ipcMain.handle('import:cancel', () => {
    if (_importAbortController) {
      _importAbortController.abort()
    }
  })

  ipcMain.handle('keywords:extract', async (_e, jobId: number) => {
    const job = db.getJob(jobId)
    if (!job) return { keywords: [], refinedByLlm: false, unknownPhrases: [] }
    // v3: return the rule-only result synchronously so JobDetail's chip
    // block + gaps panel render immediately (was the v2 behavior, ~5ms).
    // The LLM-first enhancement runs in a separate IPC (`keywords:refine`)
    // in the background; if it succeeds, the renderer replaces the rule-
    // only result with the merged one (LLM candidates + unknown-phrase
    // list). If the LLM call fails, the rule-only result stands.
    return extractJobKeywordsStructured(job.description ?? '')
  })

  ipcMain.handle('keywords:refine', async (_e, jobId: number) => {
    const job = db.getJob(jobId)
    if (!job) return { keywords: [], refinedByLlm: false, unknownPhrases: [] }
    // Runs the LLM-first v3 orchestrator. The renderer fires-and-forgets
    // this on top of the rule-only `keywords:extract` result.
    return extractJobKeywordsV3(job.description ?? '')
  })

  ipcMain.handle('jobs:recomputeFit', async (_e, id: number) => {
    // The shared background scorer handles the no-CV fallback, the
    // heuristic-fallback (don't overwrite), the error path, and emits
    // job:scoreUpdated. The handler returns the post-update row so
    // the renderer doesn't have to re-read the store.
    // `manual`: the user pressed Recompute Fit. This is one of the five
    // entry points that the per-provider spend cap (ai.ts) does NOT stop —
    // the cap exists to bound what the app spends on its own, and a person
    // asking for one score is not the app spending on its own.
    const updated = await withAiOperation(() => scoreOneJobInBackground(id, undefined, MANUAL))
    if (!updated) {
      throw new Error(`Job ${id} not found`)
    }
    return updated
  })

  ipcMain.handle('jobs:backfillDates', () => db.backfillJobPostingDates())

  ipcMain.handle('jobs:scanBoards', async (e, filters?: ScanFilters) => {
    _scanState.scanning = true
    _scanState.progress = []
    _scanState.result = null
    _scanState.startedAt = Date.now()
    _scanAbortController = new AbortController()
    markScanStarted()
    try {
      const result = await scanAllBoards(filters, (msg) => {
        // Drop progress messages that arrive after cancel — the in-flight
        // scrapes that were racing the abort signal may still resolve and
        // try to report, but the user has already moved on.
        if (_scanAbortController?.signal.aborted) return
        _scanState.progress.push(msg)
        e.sender.send('scan:progress', msg)
      }, _scanAbortController.signal, (counters) => {
        // Live counter snapshot, pushed per-listing. Drop after cancel
        // for the same reason as progress — a stale snapshot that ticks
        // up after the user cancelled is more confusing than a freeze.
        if (_scanAbortController?.signal.aborted) return
        e.sender.send('scan:counters', counters)
      })
      _scanState.result = result
      markScanCompleted()
      // Auto-queue: scan-added jobs that still lack a real fit score
      // (heuristic pre-filter or LLM-error fallback paths) get picked
      // up by the persistent queue processor.
      enqueueScoreFitBacklog()
      // Documents the same way: a scan that added jobs with no generated
      // documents re-seeds their CV / cover-letter work now rather than
      // waiting for the next hourly sweep.
      enqueueDocsBacklog()
      // Push the periodic fit-score timer out by a full interval so a
      // just-completed scan does not immediately collide with the timer.
      scheduleNextFitAutoScore()
      scheduleNextDocsAutoQueue()
      // Notify all renderers that the scan has completed (success or cancelled)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('scan:complete', result)
      }
      return result
    } finally {
      _scanState.scanning = false
      _scanState.startedAt = null
      _scanAbortController = null
    }
  })

  ipcMain.handle('scan:cancel', () => {
    if (_scanAbortController) {
      _scanAbortController.abort()
    }
  })

  ipcMain.handle('scan:status', () => ({
    scanning: _scanState.scanning,
    progress: [..._scanState.progress],
    result: _scanState.result,
    startedAt: _scanState.startedAt
  }))

  ipcMain.handle('scan:clearResult', () => {
    _scanState.result = null
    _scanState.progress = []
  })

  ipcMain.handle('documents:list', (_e, jobId?: number) => db.listDocuments(jobId))
  ipcMain.handle('documents:create', (_e, type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) => {
    const doc = db.createDocument(type, title, content, jobId)
    if (jobId) db.recomputeJobStatusFromDocs(jobId)
    return doc
  })
  ipcMain.handle('documents:update', (_e, id: number, title: string, content: string) => {
    const doc = db.updateDocument(id, title, content)
    if (doc.job_id) db.recomputeJobStatusFromDocs(doc.job_id)
    return doc
  })
  ipcMain.handle('documents:delete', (_e, id: number) => {
    // Capture the doc's job_id before deletion so we can recompute after.
    const docs = db.listDocuments()
    const target = docs.find((d) => d.id === id)
    db.deleteDocument(id)
    if (target?.job_id) db.recomputeJobStatusFromDocs(target.job_id)
  })
  /**
   * The DIRECT half of one review, shared by two channels whose fallback
   * halves are not.
   *
   * The work is identical either way — the same prompt, the same document —
   * and so is the classification of what happened to it. The only thing
   * `byPress` decides here is whether the request may spend the user's
   * daily budget, which is worth money: `documents:verify` is the Review
   * button and `documents:autoVerify` is the job page's mount sweep, and
   * until this was split the sweep reached the button's channel, so "a person
   * is asking" was true of a page open with nobody pressing anything. Five
   * page opens bought five uncapped requests on a ledger already 7 calls into
   * a cap of 1.
   *
   * So the two intents are two CHANNELS rather than an argument a caller
   * passes about itself, and the queue row each one creates on a throttle is
   * written in its own handler — where the `manual` / `present` pair is a
   * thing a reader can see, and where the audits that read these handlers
   * (`review.enqueueCallSites.test.ts`, `rv2dupe.test.ts`) still see an
   * `enqueue(` inside the channel it belongs to.
   *
   * WHAT COMES BACK AS `{ throttled: true }` is the rate-limit branch, which
   * is also where a ProviderCooldownError lands, deliberately: both mean "the
   * provider is throttling", and the queue is where throttled work belongs. A
   * cooldown block cost no attempt and no request, so the row each handler
   * enqueues parks itself on the provider's clock with its budget intact and
   * resumes on its own (aiQueue.runPass + parkBlockedRow) rather than being
   * charged a retry for something that never happened. What the user sees
   * instead of this silent deferral is the Queue panel's "no provider
   * available" state, computed from the same health query the queue parks on.
   *
   * WHY A CAP REFUSAL LANDS HERE TOO: `ProviderCapError` extends
   * `RateLimitError`, so a spent budget on an AUTOMATIC review is queued
   * rather than thrown at the page — which is right (the work is real, the
   * row is free, it parks on the budget and runs when the budget is back).
   */
  async function reviewDocumentNow(
    jobId: number,
    documentId: number,
    docType: 'cv' | 'cover_letter',
    byPress: boolean
  ): Promise<VerificationResult | { throttled: true }> {
    try {
      const result = await withAiOperation(() =>
        verifyDocumentContent(jobId, documentId, docType, byPress ? MANUAL : AUTOMATED)
      )
      db.recomputeJobStatusFromDocs(jobId)
      return result
    } catch (err) {
      if (err instanceof RateLimitError) return { throttled: true }
      throw err
    }
  }
  // The Review button (JobDetail's `handleReview`, the document's own
  // "Review" action).
  ipcMain.handle('documents:verify', async (_e, jobId: number, documentId: number, docType: 'cv' | 'cover_letter') => {
    const out = await reviewDocumentNow(jobId, documentId, docType, true)
    if (!('throttled' in out)) return out
    // From here the queue is the ONLY thing that will answer this press, so
    // the row has to carry the request the user is still waiting on.
    // `manual`: an already-queued review is revived and moved to the top of
    // its tier rather than being refused or duplicated. `present` as well:
    // the window is still showing a spinner on this document, so this row
    // must get an attempt the daily budget cannot refuse.
    enqueue({ type: 'verify', jobId, documentId }, { manual: true, present: true })
    return { queued: true }
  })
  // The job page's automatic sweep (`runLoad` -> `ensureDocVerified`), which
  // runs on mount, on the sidebar's Refresh, and after every Generate /
  // Apply / status change. Neither flag: this review is the app's own, so it
  // spends the app's budget and its row obeys `auto_queue_verify_cv` /
  // `_cover_letter` — which is what those switches are for.
  //
  // `queued` is the enqueue's own answer rather than a constant, because
  // `enqueue` returns `null` both for "already queued" and for "the switch
  // refused it" and this handler has to be able to tell the user which
  // happened. The sweep announces the rows it ADDED; it does not announce a
  // row the user's own switch-off deleted.
  ipcMain.handle('documents:autoVerify', async (_e, jobId: number, documentId: number, docType: 'cv' | 'cover_letter') => {
    const out = await reviewDocumentNow(jobId, documentId, docType, false)
    if (!('throttled' in out)) return out
    return { queued: enqueue({ type: 'verify', jobId, documentId }) !== null }
  })
  // `manual`: the user pressed Regenerate, so if this is already queued it
  // is revived and moved to the top of its tier rather than being refused or
  // duplicated. `present`: nobody has answered this press yet, so its row
  // must not wait on a budget.
  //
  // NO AUTOMATIC TWIN, unlike documents:verify and ai:tailor above, and the
  // reason is that there is nothing to have one for: no automatic producer of
  // `regenerate_section` exists anywhere in the tree. The regeneration loop
  // that could plausibly have become one is the review -> regenerate ladder,
  // and that is the QUEUE's (aiQueue's `verify` case, bounded by
  // AUTO_REGEN_MAX), not the renderer's. So the two callers here —
  // JobDetail's per-section Regenerate and DocumentsPage's — are both
  // buttons, which is what makes this `present: true` true rather than
  // merely plausible. Re-derived by review.enqueueCallSites.test.ts.
  ipcMain.handle('documents:regenerateSection', async (_e, documentId: number, sectionName: string, jobId: number, extraContext?: string) => {
    try {
      // `manual`: the user pressed Regenerate — see `MANUAL` above.
      return await withAiOperation(() => regenerateSection(documentId, sectionName, jobId, extraContext, undefined, MANUAL))
    } catch (err) {
      // ProviderCooldownError included, deliberately — see the note above
      // documents:verify. Nothing was spent, so this is a deferral of the
      // user's own request, not a second attempt.
      if (err instanceof RateLimitError) {
        enqueue({ type: 'regenerate_section', jobId, documentId, sectionName, extraContext }, { manual: true, present: true })
        return { queued: true }
      }
      throw err
    }
  })
  ipcMain.handle('documents:exportPdf', async (_e, title: string, content: string, docType: string, documentId: number | null, company?: string, position?: string) => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })

    const SHRINK_SCALES = [1.0, 0.92, 0.85] as const
    let bestPdf: Buffer | null = null
    let bestPages = Infinity
    let bestScale = 1.0

    // All markdown-to-HTML conversion and the CSS template live in pdfTemplate.ts
    const fullHtml = (scale: number) => buildPdfHtml(content, docType ?? 'cv', documentId, scale)
    let pdf: Buffer = Buffer.alloc(0)
    let lastPages = 0
    let lastScale = 1.0
    for (const scale of SHRINK_SCALES) {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml(scale))}`)
      const attempt = await win.webContents.printToPDF({})
      const pages = countPdfPages(attempt)
      if (pages < bestPages) {
        bestPdf = attempt
        bestPages = pages
        bestScale = scale
      }
      lastPages = pages
      lastScale = scale
      if (pages <= 1) break
    }
    win.close()
    if (bestPdf === null) {
      // Should not happen — SHRINK_SCALES always iterates at least once.
      throw new Error('CV render produced no PDF')
    }
    if (lastPages > 1) {
      log.scanner.warn(`[cv] PDF still ${lastPages} pages after shrink-to-fit (scale ${lastScale}); saving the best attempt (${bestPages} pages, scale ${bestScale})`)
    }
    pdf = bestPdf
    const settings = db.getSettings()
    const userName = (settings.user_name || '').replace(/[^a-zA-Z0-9]/g, '')
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '')
    const nameParts = [userName, company ? safe(company) : '', position ? safe(position) : '', docType || title.replace(/ .*/, '')].filter(Boolean)
    const fileName = `${nameParts.length > 1 ? nameParts.join('_') : `${title.replace(/[^a-z0-9]/gi, '_')}`  }.pdf`
    const docsDir = join(app.getAppPath(), 'docs')
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true })
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save PDF',
      defaultPath: join(docsDir, fileName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, pdf)
    return filePath
  })

  ipcMain.handle('applications:list', () => db.listApplications())
  ipcMain.handle('applications:getOrCreate', (_e, jobId: number) => db.getOrCreateApplication(jobId))
  ipcMain.handle('applications:update', (_e, id: number, fields: Partial<Application>) =>
    db.updateApplication(id, fields)
  )
  ipcMain.handle(
    'applications:markApplied',
    (_e, id: number, method: string, email?: string, name?: string) =>
      db.markApplied(id, method, email, name)
  )

  ipcMain.handle('followUps:list', (_e, includeCompleted?: boolean) =>
    db.listFollowUps(includeCompleted)
  )
  ipcMain.handle('followUps:create', (_e, appId: number, dueDate: string, type: FollowUp['type'], message?: string) => {
    const result = db.createFollowUp(appId, dueDate, type, message)
    // If the underlying application/job is in 'applied' state and has no
    // response_at yet, set response_at = now. One-line hook per spec:
    // the user creating a follow-up on an applied-but-unanswered job
    // is the moment we first hear back. We only fire once (response_at
    // is set; subsequent follow-ups won't re-trigger).
    //
    // When `app.job_id` points to a deleted job, `getJob` returns
    // undefined: silently skip the response-time hook and let the
    // follow-up persist as-is. The follow-up itself is still useful
    // (the application row survives; only the job row was deleted),
    // and surfacing an error here would block the create, which is
    // worse UX than a missed response-time stamp.
    const app = db.getApplication(appId)
    if (app) {
      const job = db.getJob(app.job_id)
      if (!job) {
        log.startup.warn('followup_missing_job', { appId, jobId: app.job_id })
      } else if (job.status === 'applied' && job.response_at == null) {
        db.markResponse(job.id, Date.now())
      }
    }
    return result
  })
  ipcMain.handle('followUps:complete', (_e, id: number) => db.completeFollowUp(id))
  ipcMain.handle('followUps:generateMessage', async (_e, company: string, title: string, days: number) =>
    // `manual`: the user pressed Generate on the follow-up row — see `MANUAL`.
    generateFollowUpMessage(company, title, days, MANUAL)
  )

  ipcMain.handle('interviews:list', (_e, upcomingOnly?: boolean) => db.listInterviews(upcomingOnly))
  ipcMain.handle(
    'interviews:create',
    (
      _e,
      appId: number,
      scheduledAt: string,
      type: Interview['type'],
      duration?: number,
      location?: string,
      interviewer?: string,
      notes?: string
    ) => db.createInterview(appId, scheduledAt, type, duration, location, interviewer, notes)
  )
  ipcMain.handle('interviews:update', (_e, id: number, fields: Partial<Interview>) =>
    db.updateInterview(id, fields)
  )

  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:update', (_e, partial: Partial<Settings>) => {
    const result = db.updateSettings(partial)
    // Re-schedule auto-scan if the relevant settings changed
    if ('auto_scan_enabled' in partial || 'auto_scan_interval_minutes' in partial) {
      restartAutoScanTimer()
    }
    if ('fit_autoscore_interval_minutes' in partial) {
      restartFitAutoScoreTimer()
      // The docs sweep reads the same setting, so it has to be re-read
      // here too or the two would disagree about when the next run is.
      restartDocsAutoQueueTimer()
    }
    return result
  })
  ipcMain.handle('settings:reset', () => db.resetSettings())

  ipcMain.handle('models:list', () => db.listApiModels())
  // P1.6: model-health reset. Disabling a model in the Settings UI
  // leaves its cooldown/circuit-breaker entry in ai.ts's in-memory
  // modelHealth map; re-enabling would inherit the stale state and the
  // just-re-enabled model would be silently skipped. After each
  // model-persistence IPC we call resetModelHealthByIds with the
  // affected ids so the next callAI rotation tries them again. We
  // export only the targeted reset from ai.ts (not the map itself) per
  // the BRIEF, so callers cannot iterate or hand-clear arbitrary
  // entries.
  //
  // Policy chosen for models:save: reset for every id in the new list
  // (management's preference — a fresh outlook after any user
  // action). models:add and models:delete reset for the single id
  // involved. The delete-then-readd-with-same-id case is covered by
  // models:add (the add reuses the canonical id, and the reset hook
  // handles "never in the map" as a no-op).
  ipcMain.handle('models:save', (_e, models: ApiModelConfig[]) => {
    const saved = db.saveApiModels(models)
    resetModelHealthByIds(saved.map((m) => m.id).filter((id): id is string => typeof id === 'string'))
    return saved
  })
  ipcMain.handle('models:add', (_e, model: Omit<ApiModelConfig, 'id'>) => {
    const saved = db.addApiModel(model)
    const last = saved[saved.length - 1]
    if (last && typeof last.id === 'string') resetModelHealthByIds([last.id])
    return saved
  })
  ipcMain.handle('models:delete', (_e, id: string) => {
    const saved = db.deleteApiModel(id)
    resetModelHealthByIds([id])
    return saved
  })

  /**
   * The DIRECT half of one tailoring, shared by two channels whose fallback
   * halves are not — the same shape as `reviewDocumentNow` above and for the
   * same reason. The job page's regeneration loop (`ensureDocVerified`, up to
   * five rounds after a review scored under 70) reached `ai:tailor` from a
   * mount sweep, so "the user pressed Generate" was true of a page nobody had
   * pressed anything on, and every round of that loop armed a fresh grant.
   *
   * `byPress: true` — the Tailor / Generate button: the direct call skips the
   * daily cap, and the handler below gives the queue row the pair of flags a
   * person's outstanding request needs.
   *
   * `byPress: false` — the sweep: the direct call is automated, and the row
   * obeys `auto_queue_cv` / `auto_queue_cover_letter` and waits for the app's
   * budget like the rest of the app's work.
   */
  async function tailorDocumentNow(
    request: TailorRequest,
    byPress: boolean
  ): Promise<TailorResult | { throttled: true }> {
    try {
      // Sanitizes before storing and before answering — see
      // `tailorAndSanitize` above, which is why that is a separate function
      // rather than three lines inline here.
      return await tailorAndSanitize(request, byPress ? MANUAL : AUTOMATED)
    } catch (err) {
      // A ProviderCooldownError takes this branch too (see the note above
      // documents:verify): the document was not generated and nothing was
      // spent, so the row enqueued below carries a full budget and waits on
      // the provider's clock rather than the queue's.
      if (err instanceof RateLimitError) return { throttled: true }
      throw err
    }
  }
  // The Tailor / Generate button (JobDetail's `handleTailor`). `manual`: an
  // already-queued generation item for this document is revived and promoted
  // to the top of its tier instead of being duplicated. `present` as well as
  // `manual` — see the note above MANUAL: the button answered "queued", so
  // from here the queue is the only thing that will produce the document, and
  // the user is waiting on it.
  ipcMain.handle('ai:tailor', async (_e, request: TailorRequest) => {
    const out = await tailorDocumentNow(request, true)
    if (!('throttled' in out)) return out
    enqueue(
      { type: request.document_type === 'cv' ? 'generate_cv' : 'generate_cover_letter', jobId: request.job_id },
      { manual: true, present: true }
    )
    return { queued: true }
  })
  // The job page's automatic regeneration loop, from the mount sweep. Neither
  // flag, for the reasons above `documents:autoVerify`; and `queued` is the
  // enqueue's own answer, because a row this handler did not add must not be
  // announced as one it did.
  ipcMain.handle('ai:autoTailor', async (_e, request: TailorRequest) => {
    const out = await tailorDocumentNow(request, false)
    if (!('throttled' in out)) return out
    return {
      queued:
        enqueue({
          type: request.document_type === 'cv' ? 'generate_cv' : 'generate_cover_letter',
          jobId: request.job_id
        }) !== null
    }
  })

  ipcMain.handle('queue:list', () => db.getReadyQueue())
  ipcMain.handle('queue:markSubmitted', (_e, jobId: number, submittedAt?: number) =>
    db.markSubmitted(jobId, submittedAt))
  ipcMain.handle('queue:markResponse', (_e, jobId: number, responseAt?: number) =>
    db.markResponse(jobId, responseAt))
  ipcMain.handle('tailor:quickApply', (_e, jobId: number) => {
    // `manual`: Quick Apply is a user action, so an already-queued
    // generation item for this job is promoted to the top of its tier
    // rather than stacked a second time.
    //
    // `present`, and this is the case the flag was added for. There is no
    // direct `callAI` anywhere on this path — the handler's whole body is the
    // enqueue and `{ queued: true }` — so the queue is not a fallback here,
    // it IS the delivery mechanism, and a row that can be parked on a spent
    // daily budget is a button that can say no to the person who pressed it.
    // The renderer's optimistic spinner (JobsPage `onQuickApply`) waits on
    // `tailor_generated_at` / `tailor_last_error`, so a parked row is a
    // spinner with no explanation outside the drawer, for up to a day.
    //
    // And its one caller is a button: the job row's Quick Apply action, and
    // nothing else in the tree. Unlike documents:verify and ai:tailor there
    // was never a sweep reaching this channel — the automatic producers of
    // documents are the fit-landing trigger and the documents backlog sweep,
    // and both go through `enqueue` without either flag.
    enqueue({ type: 'tailor_job_docs', jobId }, { manual: true, present: true })
    return { queued: true }
  })

  ipcMain.handle('db:clearSeenUrls', () => db.clearSeenUrls())
  ipcMain.handle('db:clearAllData', () => db.clearAllData())

  ipcMain.handle('db:retrofitLocations', () => {
    const result = db.retrofitLocations()
    return result
  })

  // Company blacklist
  ipcMain.handle('blacklist:list', () => db.listBlacklistedCompanies())
  ipcMain.handle('blacklist:add', (_e, name: string) => db.addBlacklistedCompany(name))
  ipcMain.handle('blacklist:remove', (_e, name: string) => db.removeBlacklistedCompany(name))

  // --- Data backup ----------------------------------------------------
  // Writes a timestamped folder containing the data file, encryption
  // key, and a manifest into a `flow_job_backups` subdirectory under
  // the user's chosen backup path. Returns { ok, path, error }.
  function backupTimestamp(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      d.getFullYear().toString() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    )
  }

  // Reverse of backupTimestamp: parses `YYYYMMDD-HHmmss` into an ISO
  // string. Returns '' on any parse failure so the caller can fall
  // back to the folder mtime.
  function parseBackupTimestamp(ts: string): string {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
    if (!m) return ''
    const [, y, mo, d, h, mi, s] = m
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
    if (isNaN(dt.getTime())) return ''
    return dt.toISOString()
  }

  function runBackup(
    dir: string,
    passphrase?: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return new Promise((resolve) => {
      const parentDir = join(dir, 'flow_job_backups')
      let backupDir = ''
      try {
        if (!dir) {
          resolve({ ok: false, error: 'No backup path set' })
          return
        }
        if (!existsSync(dir)) {
          resolve({ ok: false, error: `Backup path does not exist: ${dir}` })
          return
        }
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true })
        }
        backupDir = join(parentDir, `flow_job_backup_${backupTimestamp()}`)
        if (existsSync(backupDir)) {
          // Same-second collision (shouldn't happen in practice —
          // the timestamp has 1s resolution and quit can only fire
          // once per second). Refuse rather than overwriting.
          resolve({ ok: false, error: `Backup folder already exists: ${backupDir}` })
          return
        }
        mkdirSync(backupDir, { recursive: true })
        appendAudit(parentDir, { event: 'backup.start', folder: basename(backupDir), outcome: '' })

        const wrapped = passphrase
          ? wrapDekWithPassphrase(secureStore.getOrCreateDek(), passphrase)
          : null

        const manifest: Record<string, unknown> = {
          appVersion: app.getVersion(),
          createdAt: new Date().toISOString(),
          schema: 2,
          encryptionMode: secureStore.encryptionMode(),
          wrapped: !!wrapped,
          files: wrapped
            ? ['apply-assistant-data.json', 'apply-assistant-key.wrapped', 'kdf.json']
            : ['apply-assistant-data.json', 'apply-assistant-key']
        }

        if (wrapped) {
          manifest.kdf = wrapped.kdf
          // HMAC over the manifest EXCLUDING the hmac field itself.
          // canonicalJson() inside signManifest sorts keys so the
          // signature is stable across re-serialization.
          manifest.hmac = {
            alg: 'hmac-sha256',
            value: signManifest(stripHmac(manifest), passphrase, wrapped.kdf)
          }
        }

        writeFileSync(
          join(backupDir, 'manifest.json'),
          JSON.stringify(manifest, null, 2)
        )

        const dataFile = db.getStorePath()
        if (existsSync(dataFile)) {
          writeFileSync(join(backupDir, 'apply-assistant-data.json'), readFileSync(dataFile))
        }

        if (wrapped) {
          writeFileSync(
            join(backupDir, 'apply-assistant-key.wrapped'),
            wrapped.wrapped
          )
          writeFileSync(
            join(backupDir, 'kdf.json'),
            JSON.stringify(wrapped.kdf, null, 2)
          )
        } else {
          const keyFile = join(app.getPath('userData'), 'apply-assistant-key')
          if (existsSync(keyFile)) {
            writeFileSync(join(backupDir, 'apply-assistant-key'), readFileSync(keyFile))
          }
        }

        db.updateSettings({ backup_last_success_at: new Date().toISOString() })
        db.updateSettings({ backup_last_error: '' })
        appendAudit(parentDir, {
          event: 'backup.success',
          folder: basename(backupDir),
          outcome: wrapped ? 'wrapped' : 'legacy'
        })
        resolve({ ok: true, path: backupDir })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        try { db.updateSettings({ backup_last_error: msg }) } catch { /* ignore */ }
        if (parentDir) {
          appendAudit(parentDir, {
            event: 'backup.failed',
            folder: basename(backupDir) || '<uncreated>',
            outcome: msg
          })
        }
        resolve({ ok: false, error: msg })
      }
    })
  }

  ipcMain.handle('backup:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths || !filePaths[0]) return null
    // Detect synced/cloud folders. The renderer must surface a
    // confirmation step before committing the path to settings, so
    // the user has an explicit choice to proceed or pick again.
    const info = detectSyncedFolder(filePaths[0])
    return {
      path: filePaths[0],
      warning: info.synced
        ? `This folder is inside a synced cloud drive (${info.providers.join(', ')}). Backups may be locked or partially synced mid-write, and copies of the data may be stored on the cloud provider's servers. Continue anyway?`
        : null
    }
  })

  ipcMain.handle('backup:preview', async (_e, folderPath: string) => {
    // Manifest-only metadata for the restore preview. We do NOT
    // decrypt the data file here — counts are deliberately omitted
    // to keep the preview privacy-preserving. The user gets the
    // format details (date, schema, encryption mode, signature
    // status) and can decide whether to proceed with the actual
    // restore.
    if (!folderPath) return null
    if (!existsSync(folderPath)) return { error: 'Backup folder does not exist' }

    const manifestPath = join(folderPath, 'manifest.json')
    let manifest: Record<string, unknown> | null = null
    let manifestError = ''
    if (existsSync(manifestPath)) {
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch (err) {
        manifestError = err instanceof Error ? err.message : String(err)
      }
    }

    const hasWrappedKey = existsSync(join(folderPath, 'apply-assistant-key.wrapped'))
    const hasKdf = existsSync(join(folderPath, 'kdf.json'))
    const hasLegacyKey = existsSync(join(folderPath, 'apply-assistant-key'))

    const result: {
      error?: string
      manifestError?: string
      createdAt?: string
      schema?: number
      encryptionMode?: string
      wrapped?: boolean
      signed?: boolean
      hasKdf?: boolean
      hasWrappedKey?: boolean
      hasLegacyKey?: boolean
      requiresPassphrase?: boolean
      fileCount?: number
    } = {
      hasKdf,
      hasWrappedKey,
      hasLegacyKey,
      requiresPassphrase: hasWrappedKey
    }

    if (manifest) {
      result.createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : undefined
      result.schema = typeof manifest.schema === 'number' ? manifest.schema : undefined
      result.encryptionMode =
        typeof manifest.encryptionMode === 'string' ? manifest.encryptionMode : undefined
      result.wrapped = !!manifest.wrapped
      result.signed = !!manifest.hmac
    }
    if (manifestError) result.manifestError = manifestError

    // Count files in the backup folder for a quick "is this even a
    // complete backup" sanity check.
    let fileCount = 0
    try {
      const { readdirSync: rds } = require('fs') as typeof import('fs')
      fileCount = rds(folderPath).length
    } catch { /* ignore */ }
    result.fileCount = fileCount

    return result
  })

  ipcMain.handle('backup:run', async (_e, dir: string, passphrase?: string) => {
    if (!dir) return { ok: false, error: 'No backup path set' }
    return runBackup(dir, passphrase)
  })

  ipcMain.handle('backup:status', () => {
    const s = db.getSettings()
    return {
      path: s.backup_path || '',
      lastSuccessAt: s.backup_last_success_at || '',
      lastError: s.backup_last_error || ''
    }
  })

  ipcMain.handle('backup:list', () => {
    // Scan the configured backup parent folder for `flow_job_backup_*`
    // subfolders. Returns newest-first. The path comes from settings so
    // a stale or removed path simply yields an empty list — the UI
    // surfaces "no backups" rather than a crash.
    const s = db.getSettings()
    const parentDir = s.backup_path ? join(s.backup_path, 'flow_job_backups') : ''
    if (!parentDir || !existsSync(parentDir)) return []
    let entries: string[]
    try {
      entries = readdirSync(parentDir)
    } catch {
      return []
    }
    const backups: { name: string; path: string; createdAt: string }[] = []
    for (const name of entries) {
      if (!name.startsWith('flow_job_backup_')) continue
      const full = join(parentDir, name)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (!stat.isDirectory()) continue
      // Folder name encodes the timestamp: flow_job_backup_YYYYMMDD-HHmmss
      const ts = name.replace('flow_job_backup_', '')
      const iso = parseBackupTimestamp(ts)
      backups.push({ name, path: full, createdAt: iso || stat.mtime.toISOString() })
    }
    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return backups
  })

  ipcMain.handle('backup:restore', async (_e, folderPath: string, passphrase?: string) => {
    // Destructive. Overwrites the live data file and encryption key
    // with the contents of the chosen backup folder, then reloads
    // the in-memory store. Caller is expected to have confirmed with
    // the user.
    const parentDir = folderPath ? join(folderPath, '..') : ''
    const folderName = folderPath ? basename(folderPath) : '<none>'
    const logFailure = (code: string) => {
      if (parentDir) appendAudit(parentDir, { event: 'restore.failed', folder: folderName, outcome: code })
    }
    const logRefused = (code: string) => {
      if (parentDir) appendAudit(parentDir, { event: 'restore.refused', folder: folderName, outcome: code })
    }

    if (!folderPath) return { ok: false, error: 'No backup folder specified' }
    if (!existsSync(folderPath)) {
      logRefused('missing-folder')
      return { ok: false, error: `Backup folder does not exist: ${folderPath}` }
    }
    const srcData = join(folderPath, 'apply-assistant-data.json')
    if (!existsSync(srcData)) {
      logRefused('missing-data')
      return { ok: false, error: 'Backup is missing apply-assistant-data.json' }
    }

    // Read the manifest for HMAC verification + format detection.
    const manifestPath = join(folderPath, 'manifest.json')
    let manifest: Record<string, unknown> | null = null
    if (existsSync(manifestPath)) {
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch { /* tolerate */ }
    }

    // Detect the DEK format. Precedence:
    //   1. apply-assistant-key.wrapped + kdf.json (passphrase-wrapped)
    //   2. apply-assistant-key (legacy un-wrapped)
    const wrappedKeyPath = join(folderPath, 'apply-assistant-key.wrapped')
    const kdfPath = join(folderPath, 'kdf.json')
    const legacyKeyPath = join(folderPath, 'apply-assistant-key')
    const isWrapped = existsSync(wrappedKeyPath) && existsSync(kdfPath)
    const isLegacy = !isWrapped && existsSync(legacyKeyPath)

    if (!isWrapped && !isLegacy) {
      logRefused('missing-key')
      return { ok: false, error: 'Backup is missing apply-assistant-key (wrapped or legacy)' }
    }

    const warnings: string[] = []
    let verified = true

    if (isWrapped) {
      if (!passphrase) {
        logRefused('passphrase-required')
        return { ok: false, error: 'This backup is passphrase-protected. Enter the passphrase to restore.' }
      }
      // HMAC verify (if present in manifest) before any decrypt or write.
      const kdf = JSON.parse(readFileSync(kdfPath, 'utf-8'))
      if (manifest && manifest.hmac) {
        const expected = (manifest.hmac as { value: string }).value
        const recomputed = verifyManifest(stripHmac(manifest), expected, passphrase, kdf)
        if (!recomputed) {
          logRefused('hmac-fail')
          return { ok: false, error: 'Wrong passphrase or tampered backup (HMAC verification failed).' }
        }
      } else {
        warnings.push('This backup is not signed. Authenticity cannot be verified.')
      }
      try {
        const wrappedB64 = readFileSync(wrappedKeyPath, 'utf-8')
        unwrapDekWithPassphrase({ wrapped: wrappedB64, kdf }, passphrase)
        // We only need the unwrap to succeed (proves the passphrase is
        // correct); the live DEK is not yet replaced. The data file
        // itself is what gets restored, and decryption happens lazily
        // on the next load.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logRefused('unwrap-fail')
        return { ok: false, error: msg }
      }
    } else {
      // Legacy un-wrapped backup — no passphrase was used. Surface a
      // warning so the renderer can prompt for confirmation. We do
      // NOT silently restore because that's exactly the security
      // hole we're closing.
      warnings.push('This backup is not passphrase-protected (legacy format). Continuing restores the encryption key as-is.')
    }

    const dataDest = db.getStorePath()
    const keyDest = join(app.getPath('userData'), 'apply-assistant-key')
    // Snapshot the existing data file so we can roll back if the
    // reload fails (e.g. the live DEK no longer matches the backup's
    // DEK, which would cause loadStore to throw). Without rollback,
    // the user would be left with a data file they can't decrypt.
    const previousData = existsSync(dataDest) ? readFileSync(dataDest) : null
    const previousKey = existsSync(keyDest) ? readFileSync(keyDest) : null

    try {
      writeFileSync(dataDest, readFileSync(srcData))
      if (isWrapped) {
        // For passphrase-wrapped backups, we DO NOT write the live
        // DEK file from the backup (it isn't there). The user keeps
        // their current DEK, and the new data file is encrypted
        // under it. The data file's contents already contain the
        // ciphertext keyed to the DEK from the backup's environment;
        // but since the data file is encrypted with the DEK, this
        // only works if the user's current DEK matches the backup's.
        // In practice the user is restoring on the same machine
        // where the backup was made, so the DEK is identical.
        // If they migrated to a new machine, restore would require
        // also restoring the DEK — which is exactly the scenario
        // where the wrapped format protects them. We document this
        // trade-off in the renderer.
        //
        // Concretely: for a wrapped backup, do nothing for the key
        // file. The caller is expected to re-set the passphrase in
        // settings if it changed.
      } else {
        writeFileSync(keyDest, readFileSync(legacyKeyPath))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logFailure('write-fail')
      return { ok: false, error: msg }
    }

    // Discard the in-memory store and re-read the data file from
    // disk. The encryption-key file is re-read fresh on the next
    // load (secureStore.getOrCreateDek does not cache). If the
    // reload throws (e.g. DEK mismatch — the live key no longer
    // matches the backup's key), roll back the data file so the
    // user's previous state is preserved and surface a clear error.
    try {
      db.reloadStore()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (previousData !== null) writeFileSync(dataDest, previousData)
      else {
        try { unlinkSync(dataDest) } catch { /* ignore */ }
      }
      if (isWrapped && previousKey !== null) {
        // Wrapped backups never overwrite the key, so prior key
        // is still on disk — nothing to restore.
      } else if (!isWrapped && previousKey !== null) {
        writeFileSync(keyDest, previousKey)
      }
      logFailure('reload-fail')
      return { ok: false, error: msg }
    }

    if (parentDir) {
      appendAudit(parentDir, {
        event: 'restore.success',
        folder: folderName,
        outcome: isWrapped ? 'wrapped' : 'legacy'
      })
    }
    return { ok: true, warning: warnings[0] || undefined }
  })

  // Fire-and-forget backup on quit. Best-effort, never blocks quit —
  // a slow or failing backup should never prevent the user from
  // closing the app. We only attempt it if a backup_path is set, and
  // we re-check it inside runBackup so a stale or removed path
  // surfaces as a stored backup_last_error rather than a crash.
  //
  // Per product decision: if the user has NOT set a passphrase, we
  // skip the close-time auto-backup entirely. Un-wrapped backups
  // are the security failure mode we're trying to avoid.
  let lastAutoBackupAttempt = 0
  app.on('before-quit', () => {
    // Close the shared Camoufox browser if it's running (no-op if
    // never started). Fire-and-forget — the process is shutting down,
    // and we don't want to block the quit.
    closeCamoufox()
    const s = db.getSettings()
    if (!s.passphrase) return
    const now = Date.now()
    // Debounce: if multiple before-quit events fire in quick
    // succession (e.g. user hits Cmd+Q then confirms a dialog),
    // only run the backup once.
    if (now - lastAutoBackupAttempt < 5000) return
    lastAutoBackupAttempt = now
    if (!s.backup_path) return
    runBackup(s.backup_path, s.passphrase).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log.backup.error('close-time backup failed:', msg)
    })
  })

  ipcMain.handle('security:status', () => db.encryptionStatus())

  // AI Queue
  // Returns the queue in pick order (score_fit first, then fit DESC)
  // rather than raw store order, so the renderer's Queue panel shows
  // the order the processor will actually use.
  ipcMain.handle('aiQueue:list', (): QueueItemView[] => listQueueInPickOrder())

  // "Is the app able to spend a request at all?", as one app-wide state.
  // Not per-row: "no provider is available" is a property of the model
  // pool and every queued task waits on the same door. Same
  // `providerAvailability()` query the processor parks itself on, so the
  // panel cannot say "waiting" while the queue is running. Carries no
  // model names, statuses or health internals — see QueuePanel's copy.
  ipcMain.handle('aiQueue:blocked', (): AIQueueBlockedState => aiQueueBlockedState())

  // What the AI providers have ACTUALLY spent in the rolling 24h window,
  // per provider, read from the ledger the cap itself reads.
  //
  // This exists because the number was computed and never shipped: the
  // Auto-queue tab showed the cap a user typed beside nothing at all, so a
  // ledger holding 629 requests against a cap of 50 rendered as "50" and
  // nowhere as 629 (measured on 2026-10-05, a 6h44m window). One row per
  // provider bucket, because the cap is per credential — see
  // `providerSpendRows` for which providers get a row and which do not.
  //
  // Carries `label`, never `key`: the bucket identity is `endpoint#hash` and
  // the app's rule is that ids and credentials stay in this process. The
  // return type is `ProviderSpend[]` for the same reason — the view type
  // cannot grow a field the renderer must not have.
  ipcMain.handle('ai:providerSpend', (): ProviderSpend[] => providerSpendRows())

  ipcMain.handle('boards:list', () => {
    // Per-board enabled flag, sourced from settings.disabled_boards.
    // The Settings > Boards tab maintains that list; the scan page
    // reads `enabled` to decide which boards to render in the picker
    // and the main-process scan loop applies the same filter as a
    // defence-in-depth check (the renderer's filter alone is a UX
    // concern; this is the actual enforcement).
    const disabled = new Set(db.getSettings().disabled_boards || [])
    return BOARDS.map((b) => ({ name: b.name, useBrowser: b.useBrowser, enabled: !disabled.has(b.name) }))
  })
  ipcMain.handle('boards:health', () => db.getBoardHealth())
  ipcMain.handle('boards:scanEstimate', (_e, boardNames: string[]) => computeScanEstimate(boardNames))
  ipcMain.handle('aiQueue:retry', (_e, id: number): QueueItemView[] => retryQueueItem(id))
  // Returns the enriched pick-order view, not `db.getAIQueue()`. Every
  // queue-returning handler below answers with the SAME shape: raw rows
  // carry no jobTitle / jobCompany, and the Queue panel falls through to
  // its `Job <id>` fallback for a row missing them. Since the renderer
  // replaces its whole list with the response, one handler returning raw
  // rows blanked the title on every OTHER row too — deleting an
  // unrelated task silently renamed all of them to `Job <id>`. The
  // annotations below are the point: `QueueItemView[]` is not satisfied
  // by `AIQueueItem[]`, so a handler that returns the raw shape is a
  // compile error rather than a UI regression.
  ipcMain.handle('aiQueue:remove', (_e, id: number): QueueItemView[] => removeQueueItem(id))
  // Irreversible. The renderer confirms with the user before calling.
  ipcMain.handle('aiQueue:clear', (): { removed: number; queue: QueueItemView[] } => clearQueue())

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    return shell.openExternal(url)
  })

  // --- Notification center ------------------------------------------
  // All five handlers below follow the same pattern: try the helper
  // from ./notifications, return its result on success, and on
  // exception write a single WARN line to logs/notifications.log
  // (per the "no console.* from main process" project rule) and
  // return a typed error sentinel. The renderer treats the sentinel
  // as a soft failure and surfaces its own toast; the log line is the
  // diagnostic breadcrumb for grep.
  ipcMain.handle('notifications:notificationsAdd', async (_e, params: {
    type: string
    source?: NotificationSource
    message: string
    full_message: string
    group_key?: string
    job?: NotificationJobContext
  }) => {
    try {
      return addNotification(params)
    } catch (err) {
      logToNotifications(`addNotification failed: ${(err as Error).message}`)
      return { error: 'INTERNAL' as const }
    }
  })

  ipcMain.handle('notifications:notificationsList', async () => {
    try {
      // `unreadable` rides along on the success arm. The store migration
      // has to discard entries of `notifications` that are not rows —
      // `loadStore` is the accessor for the whole Store, so it cannot throw
      // here — and without the count the renderer had one shape to read and
      // it was the shape that means "nothing in here". See
      // `listActiveNotifications` in electron/notifications.ts.
      return listActiveNotifications()
    } catch (err) {
      logToNotifications(`listActiveNotifications failed: ${(err as Error).message}`)
      // An error envelope, NOT `{ rows: [] }`. The old answer was the
      // shape this file already uses to mean "nothing to report", so a
      // store that could not be decrypted, read or parsed was reported to
      // the renderer as a notification center with nothing in it — and
      // "nothing in it" is the one claim the user is entitled to trust.
      // The renderer keeps the rows it last read and says the read failed;
      // see `refresh` in src/notifications/NotificationsProvider.tsx.
      return { error: 'INTERNAL' as const }
    }
  })

  ipcMain.handle('notifications:notificationsDismiss', async (_e, params: { id: number }) => {
    try {
      return dismissNotification(params.id)
    } catch (err) {
      logToNotifications(`dismissNotification failed: ${(err as Error).message}`)
      return { error: 'INTERNAL' as const }
    }
  })

  ipcMain.handle('notifications:notificationsDismissMany', async (_e, params: { ids: number[] }) => {
    try {
      return dismissNotifications(Array.isArray(params.ids) ? params.ids : [])
    } catch (err) {
      logToNotifications(`dismissNotifications failed: ${(err as Error).message}`)
      return { error: 'INTERNAL' as const }
    }
  })

  ipcMain.handle('notifications:notificationsDismissAll', async () => {
    try {
      return dismissAllNotifications()
    } catch (err) {
      logToNotifications(`dismissAllNotifications failed: ${(err as Error).message}`)
      return { error: 'INTERNAL' as const }
    }
  })

  ipcMain.handle('notifications:notificationsPurgeOldDismissed', async () => {
    try {
      return purgeOldDismissedNotifications()
    } catch (err) {
      logToNotifications(`purgeOldDismissedNotifications failed: ${(err as Error).message}`)
      return { deleted: 0 }
    }
  })
}

// Auto-queue: any job without a real fit score is enqueued for
// background scoring. Covers the scan paths that persist
// score=null (heuristic pre-filter, LLM-error fallback) plus legacy
// rows. The fit_score_version guard matches database.ts's
// documented invariant: score-less rows have version null/old, so
// they qualify; rows scored against the current CV (version match,
// real score) are skipped.
// Lives in ./fitAutoScore next to the hourly re-seeder — it is the same
// question asked of the same jobs table, and the two MUST agree on
// which jobs a "Clear queue" suppresses. It used to be a private
// function here, which meant that half of the clear-durability
// contract (see isScoreFitSuppressed) was untestable and silently
// rebuilt the rows the user had just cancelled.

// Score a single job against the current base CV. Shared by the manual
// background scorer (fired after createJob), the import-from-link flow,
// the explicit recomputeFit handler, and aiQueue's score_fit retries.
// Lives in ./fitScorer so it can be imported without dragging in the
// full main-process module graph (which would break unit tests).

// Deferred startup work — runs only after the renderer has finished
// loading (did-finish-load), so the first synchronous loadStore() (~0.63s)
// and the one-shot retrofits no longer sit in the loadFile → dom-ready
// critical path (a sync main-thread block there delays the renderer ~1:1).
// The three services are idempotent and the retrofits are flag-gated, so
// re-running on a reopened window is safe. loadStore is a synchronous
// singleton, so ordering against the renderer’s first data IPC is
// harmless either way.
function runDeferredStoreWork(): void {
  // Before anything reads or writes the queue. A one-shot repair for
  // duplicate rows left by the old enqueue guards — first the
  // pending/processing class, now also the `failed` class (the second
  // run is gated separately, see dedupeAIQueueItems). It must run first
  // so the backlog re-seed below does not race rows that are about to be
  // collapsed, and so the processor never picks up a duplicate.
  try {
    const dedupe = db.dedupeAIQueueItems()
    if (dedupe.removed > 0) {
      log.startup.info(`Collapsed ${dedupe.removed} duplicate AI queue task(s).`)
    }
  } catch (err) {
    log.startup.warn(
      'AI queue dedupe failed:',
      err instanceof Error ? err.message : String(err)
    )
  }

  // One-shot: give back the retry budget that a provider outage spent
  // for free. Rows written by the old build are `failed` (or parked on a
  // 4h cooldown) with an exhausted budget and a `lastError` recording the
  // no-request cooldown throw rather than anything that cost a request.
  // Runs BEFORE the processor so those rows are picked up on the first
  // pass instead of waiting out the rest of their cooldown.
  try {
    const unpoisoned = db.unpoisonCooldownFailedAIQueueItems()
    if (!unpoisoned.alreadyMigrated && unpoisoned.reset + unpoisoned.unstuck > 0) {
      log.startup.info(
        `Restored the retry budget for ${unpoisoned.reset} task(s) that failed while no AI provider was ` +
        `available, and unstuck ${unpoisoned.unstuck} parked task(s).`
      )
    }
    if (unpoisoned.clearedWorkSkipped > 0) {
      log.startup.info(
        `Left ${unpoisoned.clearedWorkSkipped} cleared task(s) alone — they belong to a queue the user cancelled.`
      )
    }
  } catch (err) {
    log.startup.warn(
      'AI queue cooldown repair failed:',
      err instanceof Error ? err.message : String(err)
    )
  }

  startQueueProcessor()
  // Re-seed the score_fit backlog on every session start: jobs left
  // score-less by a crashed/killed scan (or by queue items that burned
  // their attempts) get re-enqueued here, so the backlog drains across
  // sessions until empty.
  enqueueScoreFitBacklog()
  // Same for documents: generation used to be queued only as a
  // side-effect of a fit score landing (maybeAutoEnqueueDocs in
  // fitScorer.ts), so a cleared queue lost the CV / cover-letter work
  // permanently — nothing walked the DOCUMENTS table to bring it back.
  enqueueDocsBacklog()
  scheduleNextAutoScan()
  scheduleNextFitAutoScore()
  scheduleNextDocsAutoQueue()
  // Fire-and-forget: the returned `stop` is intentionally dropped
  // (the interval lives for the app's lifetime; the helper
  // double-registers are guarded inside the module).
  startNotificationsPurgeInterval()

  // One-shot: re-canonicalize legacy locations to honor the country-last
  // contract (every stored value ends in a 2-letter country code or is
  // remote/unknown). Gated by the v3 flag — v2 ran the previous, looser
  // writer; v3 covers the stricter formatSingleLocation that ships with
  // the currency-decider fix. Idempotent.
  if (!db.hasLocationsNormalizedV3() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitLocations()
      if (result.updated > 0) {
        log.startup.info(`Normalized ${result.updated}/${result.total} job locations.`)
      }
    } catch (err) {
      log.startup.error('Location retrofit failed:', err)
    }
  }

  // v4 retrofit (2026-07-23): the writer's 1-part branch no longer
  // appends the defaultCountry when the input is already a known
  // full country name. Pre-existing rows that were written by the
  // older writer still hold the redundant trailing 2-letter code.
  // Note: the v4 nameAsCC check only matched 2-letter tokens, so
  // the first v4 run was a no-op for "Canada, CA"-style rows. The
  // v5 retrofit below re-runs the work with the fixed lookup.
  if (!db.hasLocationsNormalizedV4() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitLocationsV4()
      if (result.updated > 0) {
        log.startup.info(`Collapsed ${result.updated}/${result.total} redundant country suffixes.`)
      }
    } catch (err) {
      log.startup.error('Location retrofit v4 failed:', err)
    }
  }

  // v6 retrofit (2026-07-23): the writer's 1-part branch expands a
  // bare 2-letter country code to the full name. Pre-existing rows
  // that the user stored as just "CA" / "US" / "GB" need the same
  // expansion. Gated by locations_normalized_v6; once set, never
  // runs again.
  if (!db.hasLocationsNormalizedV6() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitLocationsV6()
      if (result.updated > 0) {
        log.startup.info(`Expanded ${result.updated}/${result.total} bare country codes to full names.`)
      }
    } catch (err) {
      log.startup.error('Location retrofit v6 failed:', err)
    }
  }

  // One-shot: copy the legacy job_search_location string into the
  // job_search_locations array, then clear the old field. Gated by a
  // flag, idempotent, runs once per store.
  try {
    const arrayMig = db.migrateJobSearchLocationsV1()
    if (arrayMig.updated) log.startup.info(`Migrated job_search_location → job_search_locations: ${arrayMig.reason}`)
  } catch (err) {
    log.startup.error('Location array migration failed:', err)
  }

  // One-shot: union the Cloudflare-walled default-disabled boards into
  // the saved disabled_boards list (1ca07d9 shipped them as a fresh-
  // install default only). Idempotent, flag-gated.
  try {
    const boardMigV1 = db.migrateDefaultDisabledBoardsV1()
    if (boardMigV1.updated) log.startup.info('Disabled default Cloudflare-walled boards (existing install migration v1).')
  } catch (err) {
    log.startup.error('Disabled-boards migration v1 failed:', err)
  }

  // One-shot: union the additional 6 walled boards added on 2026-09-07
  // into the saved disabled_boards list. Idempotent, flag-gated.
  try {
    const boardMigV2 = db.migrateDefaultDisabledBoardsV2()
    if (boardMigV2.updated) log.startup.info('Disabled additional Cloudflare-walled boards (existing install migration v2).')
  } catch (err) {
    log.startup.error('Disabled-boards migration v2 failed:', err)
  }

  // One-shot: annualize legacy salary strings ("$43/hour" → "$86,000",
  // "CAD Monthly" → annual equivalent, etc.) on first load with a
  // populated store. Idempotent — gated by a flag. New jobs added
  // after this point are normalized at the persistence boundary
  // (createJob / updateJob) so the retrofit only touches pre-existing
  // rows that landed before this feature shipped.
  if (!db.hasSalaryNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitSalaryNormalization()
      if (result.updated > 0) {
        log.startup.info(`Annualized ${result.updated}/${result.total} job salaries.`)
      }
      db.markSalaryNormalized()
    } catch (err) {
      log.startup.error('Salary normalization retrofit failed:', err)
    }
  }

  // One-shot: re-canonicalize legacy title/company strings to honor
  // the extended casing contract (Roman numerals + curated acronyms).
  // Gated by the title_casing_normalized flag — runs at most once
  // per install. Idempotent. New rows added after this point are
  // normalized at the persistence boundary (createJob / updateJob).
  if (!db.hasTitleCasingNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitTitleCasing()
      if (result.updated > 0) {
        log.startup.info(`Re-cased ${result.updated}/${result.total} job title/company fields.`)
      }
    } catch (err) {
      log.startup.error('Title casing retrofit failed:', err)
    }
  }

  // v2 of the casing migration. Re-runs the normalizer to pick up:
  //   - mid-title Roman numerals ("Senior Engineer Ii - ..." → "II")
  //   - newly-curated acronym CSE
  // Existing rows captured by the v1 migration still have the old
  // narrowed behavior. Idempotent.
  if (!db.hasTitleCasingNormalizedV2() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitTitleCasingV2()
      if (result.updated > 0) {
        log.startup.info(`Re-cased ${result.updated}/${result.total} job title/company fields (casing v2).`)
      }
    } catch (err) {
      log.startup.error('Title casing v2 retrofit failed:', err)
    }
  }

  // One-shot: collapse legacy employment_type strings to the 8 canonical
  // tokens that the Edit dropdown is constrained to. Unmappable values
  // are nulled so the user can pick the right token. New jobs added
  // after this point are normalized at the persistence boundary
  // (createJob / updateJob) so the retrofit only touches pre-existing
  // rows. Idempotent — gated by a flag, mirroring the salary/locations
  // pattern.
  if (!db.hasEmploymentTypeNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitEmploymentTypeNormalization()
      if (result.updated > 0 || result.nulled > 0) {
        log.startup.info(
          `Standardized ${result.updated} employment_type values, ` +
          `nulled ${result.nulled} unmappable.`
        )
      }
      db.markEmploymentTypeNormalized()
    } catch (err) {
      log.startup.error('Employment type retrofit failed:', err)
    }
  }

  // One-shot: collapse legacy work_mode strings ("Remote", "On-site",
  // "Work from home", "Hybrid (2 days)", etc.) to the 3 canonical
  // tokens (ON_SITE, HYBRID, REMOTE) that the Edit dropdown is
  // constrained to. Unmappable values are nulled. New jobs added
  // after this point are normalized at the persistence boundary.
  if (!db.hasWorkModeNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitWorkModeNormalization()
      if (result.updated > 0 || result.nulled > 0) {
        log.startup.info(
          `Standardized ${result.updated} work_mode values, ` +
          `nulled ${result.nulled} unmappable.`
        )
      }
      db.markWorkModeNormalized()
    } catch (err) {
      log.startup.error('Work mode retrofit failed:', err)
    }
  }

  // One-shot: recompute every job's status from its current documents the
  // first time the app loads after the doc-derived status rule landed. This
  // backfills statuses that drifted while the recompute was per-handler
  // only. Idempotent — gated by a flag.
  if (!db.hasStatusesRecomputed() && db.listJobs().length > 0) {
    try {
      const result = db.recomputeAllJobStatuses()
      if (result.updated > 0) {
        log.startup.info(`Refreshed status for ${result.updated}/${result.total} jobs.`)
      }
    } catch (err) {
      log.startup.error('Status refresh failed:', err)
    }
  }

  // One-shot v2: the old rule auto-promoted verified jobs to 'ready'.
  // 'ready' is now user-only, so demote those auto-promotions back to
  // 'reviewing'. Runs after the recompute backfill so both land before
  // the UI ever renders. Idempotent — gated by its own flag.
  if (!db.hasStatusesManualV2() && db.listJobs().length > 0) {
    try {
      const result = db.demoteAutoReadyJobs()
      if (result.updated > 0) {
        log.startup.info(`Demoted ${result.updated} auto-ready jobs to reviewing (manual-status rule).`)
      }
    } catch (err) {
      log.startup.error('Manual-status migration failed:', err)
    }
  }

  // One-shot: bump the global CV version so the bootstrap score pass re-scores
  // every job that's currently holding a heuristic-only fit score. This
  // self-heals the bug where the LLM scorer silently fell back to a keyword
  // overlap score and the user got a misleading number. After this runs
  // once the flag is set, so subsequent launches only re-score when the
  // user actually edits the base CV.
  if (!db.hasFitRescoreFlag() && db.listJobs().length > 0) {
    try {
      const v = db.bumpCvVersion()
      db.markFitRescored()
      log.startup.info(`Bumped cv_version to ${v} to force fit re-score of all jobs.`)
    } catch (err) {
      log.startup.error('CV version bump failed:', err)
    }
  }
}

app.whenReady().then(() => {
  // Set a strict Content-Security-Policy on the main renderer session
  // so scraped HTML rendered in-app cannot execute injected scripts.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws:; font-src 'self'; object-src 'none'; base-uri 'self';"
        ]
      }
    })
  })

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopQueueProcessor()
    app.quit()
  }
})
