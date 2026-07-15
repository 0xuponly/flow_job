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
import type { Job } from './types'

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
    next.onResult({ ok: true, job: updated })
  } catch (err) {
    next.onResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  } finally {
    inFlight = null
    bumpPending(-1)
    // Drain the next queued item on a microtask so the increment /
    // decrement pair for the just-finished item doesn't briefly
    // show a 0 count.
    void pump()
  }
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
export function enqueueFitRecompute(jobId: number, onResult: OnResult): boolean {
  // Cap is on QUEUED items, not the running count: 10 items can be
  // waiting behind the in-flight call. The in-flight call itself is
  // the 11th active item, which is fine. Reject the 11th enqueue.
  if (queue.length >= MAX_QUEUED) {
    return false
  }
  queue.push({ jobId, onResult })
  bumpPending(1)
  void pump()
  return true
}

export const FIT_QUEUE_MAX = MAX_QUEUED
