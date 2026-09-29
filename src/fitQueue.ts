/**
 * Serialized fit-recompute queue. The IPC handler `recomputeFit` is
 * single-shot per call, but the user can click "Recompute Fit" on
 * multiple jobs (or click the same one twice) before the first one
 * resolves. Running them in parallel would compete for the LLM
 * provider's rate limit and produce interleaved `job:scoreUpdated`
 * events. Instead, we serialize: one in-flight call, the rest wait
 * in a FIFO queue with a hard cap of 10.
 *
 * Each enqueue is associated with a callback (typically "update my
 * local state with the result") — the callback runs whether the call
 * resolved or threw, so the calling component can show the result
 * (or the error toast) without waiting on a separate channel.
 *
 * The queue fires `app:fit-progress` events with delta ±1 per
 * in-flight call so the sidebar's "Calculating Fit…" indicator
 * stays accurate when a click is queued (counts as pending) vs.
 * when it's actively running. Stale-tab close is safe: a queued
 * jobId that the user no longer cares about still runs to
 * completion and the matching decrement still fires.
 */
import { api } from './api'
import { notify } from './components/Notifications'
import type { AIQueueItem, Job } from './types'

const MAX_QUEUED = 10

type OnResult = (result: { ok: true; job: Job } | { ok: false; error: string }) => void

interface QueueItem {
  jobId: number
  onResult: OnResult
}

const queue: QueueItem[] = []
let inFlight: QueueItem | null = null
// Count of items the user has clicked but that haven't been processed
// yet (in flight + queued). The sidebar indicator subscribes to the
// matching `app:fit-progress` events.
let pendingDelta = 0
// Per-job state: a Set of jobIds that are currently in flight or
// queued. The JobDetail button subscribes to `app:fit-pending-jobs`
// events to know whether its own job is in the queue (drives the
// per-button spinner and disabled state).
const pendingJobIds = new Set<number>()

// Job ID the user is currently viewing in JobDetail, or null if the
// detail view is closed. Updated by JobDetail's mount/unmount
// `app:viewedJob` event. Read by the fit-computed toast to decide
// whether to skip the "click to open" prompt (the user can already
// see the result).
let viewedJobId: number | null = null

function bumpPending(delta: number, jobId?: number): void {
  pendingDelta += delta
  if (pendingDelta < 0) pendingDelta = 0
  if (jobId !== undefined) {
    if (delta > 0) pendingJobIds.add(jobId)
    else pendingJobIds.delete(jobId)
  }
  window.dispatchEvent(new CustomEvent('app:fit-progress', { detail: { delta } }))
  window.dispatchEvent(new CustomEvent('app:fit-pending-jobs'))
}

function announceFitComputed(job: Job): void {
  if (viewedJobId === job.id) {
    // User is already on the detail page; the recomputed score is
    // visible. No toast — silently let the page update in place.
    return
  }
  // Passive notification only. No action button, no auto-navigation:
  // the user reported the previous "click Open" implementation still
  // auto-navigated, so we drop the affordance entirely. The user
  // can find the recomputed job in the Job Board (the fit dot
  // updates in place via the job:scoreUpdated channel) and click
  // the row to open its detail. A future iteration can add an
  // explicit "View" button back if the user wants it, once we
  // understand why the click handler was firing pre-emptively.
  notify(
    `The Fit score has been computed for the ${job.title} role at ${job.company}.`,
    'success',
    6000
  )
}

export function isJobInFitQueue(jobId: number): boolean {
  return pendingJobIds.has(jobId)
}

async function pump(): Promise<void> {
  if (inFlight) return
  const next = queue.shift()
  if (!next) return
  inFlight = next
  try {
    const updated = await api.recomputeFit(next.jobId)
    if (!updated) {
      // The job was deleted between enqueue and pump, or the main
      // process returned undefined for some other reason. Surface as
      // an error rather than letting the callback try to read .company
      // off undefined.
      next.onResult({ ok: false, error: `Job ${next.jobId} not found` })
    } else {
      // Skip the toast when the LLM scored but set fit_last_error
      // (heuristic fallback, LLM error): the score wasn't actually
      // recomputed, so there's no "fit score has been computed"
      // event to announce. The job row already shows the error.
      if (!updated.fit_last_error) {
        announceFitComputed(updated)
      }
      next.onResult({ ok: true, job: updated })
    }
  } catch (err) {
    next.onResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  } finally {
    inFlight = null
    bumpPending(-1, next.jobId)
    // Drain the next queued item on a microtask so the increment /
    // decrement pair for the just-finished item doesn't briefly
    // show a 0 count.
    void pump()
  }
}

// Wire the viewedJobId tracker. Mounted once when the module loads;
// the listener stays for the rest of the app's life.
if (typeof window !== 'undefined') {
  window.addEventListener('app:viewedJob', (e) => {
    const detail = (e as CustomEvent<{ jobId: number | null }>).detail
    viewedJobId = detail?.jobId ?? null
  })
}

/**
 * Enqueue a fit recompute for the given jobId. Returns true if the
 * call was queued, false if the queue is full (10 pending).
 *
 * The first call starts immediately; subsequent calls wait in FIFO
 * order behind the current in-flight call. The onResult callback
 * fires once per enqueue, with the resolved Job on success or the
 * error message on failure.
 */
/**
 * Human-readable label for an AI queue task.
 *
 * Lives here rather than in each consumer because the queue is now
 * rendered in two places (the Documents page modal and the
 * notification center's Queue panel) and a task with no label would
 * render as a blank row. Extracted from DocumentsPage for that reason.
 */
export function queueItemLabel(item: AIQueueItem): string {
  switch (item.type) {
    case 'generate_cv': return 'Generate CV'
    case 'generate_cover_letter': return 'Generate Cover Letter'
    case 'regenerate_section': return `Regenerate section: ${item.sectionName}`
    case 'verify': return 'Verify document'
    case 'tailor_job_docs': return 'Generate CV + cover letter'
    case 'score_fit': return 'Score fit'
  }
}

/**
 * One-line status for a queue task: where it is now, or when it will
 * next be attempted. A pending item with a future `nextRetryAt` is
 * waiting out a rate-limit backoff, so the countdown is the useful
 * thing to show.
 */
export function queueItemStatusText(item: AIQueueItem, now: number = Date.now()): string {
  if (item.status === 'processing') return 'Processing…'
  if (item.status === 'failed') return `Failed (${item.attempts} attempts)`
  if (item.attempts > 0) {
    const wait = Math.max(0, Math.ceil((item.nextRetryAt - now) / 1000))
    return `Retry in ${wait}s (attempt ${item.attempts})`
  }
  return 'Pending'
}

export function enqueueFitRecompute(jobId: number, onResult: OnResult): boolean {
  // Cap is on QUEUED items, not the running count: 10 items can be
  // waiting behind the in-flight call. The in-flight call itself is
  // the 11th active item, which is fine. Reject the 11th enqueue.
  if (queue.length >= MAX_QUEUED) {
    return false
  }
  queue.push({ jobId, onResult })
  bumpPending(1, jobId)
  void pump()
  return true
}

export const FIT_QUEUE_MAX = MAX_QUEUED
