import { getSettings, getAIQueue, addAIQueueItem, updateAIQueueItem, listJobs } from './database'
import { createLogger } from './logger'
import { timerDeadlineMs } from './utils'

const log = createLogger('fit')

const DEFAULT_INTERVAL_MINUTES = 240

let timer: NodeJS.Timeout | null = null
let timerStartedAt = 0
let timerDelayMs = 0
let running = false

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
    timerStartedAt = 0
    timerDelayMs = 0
  }
}

/**
 * Schedule the next automatic fit-score backfill. The interval is read from
 * settings (`fit_autoscore_interval_minutes`) and defaults to 4 hours. Each
 * call replaces the previous schedule, so settings changes and manual scan
 * completions always push the next run out by a full interval.
 */
export function scheduleNextFitAutoScore() {
  clearTimer()
  const settings = getSettings()
  const minutes = Math.max(1, settings.fit_autoscore_interval_minutes ?? DEFAULT_INTERVAL_MINUTES)
  const ms = minutes * 60 * 1000
  timer = setTimeout(runFitAutoScore, ms)
  timerStartedAt = Date.now()
  timerDelayMs = ms
}

export function cancelFitAutoScore() {
  clearTimer()
}

export function restartFitAutoScoreTimer() {
  // Re-read settings and reschedule (used when settings change).
  scheduleNextFitAutoScore()
}

export function getFitAutoScoreState(): { intervalMinutes: number; nextRunAt: number | null } {
  const settings = getSettings()
  return {
    intervalMinutes: settings.fit_autoscore_interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
    nextRunAt: timer ? timerDeadlineMs(timerStartedAt, timerDelayMs) : null
  }
}

/**
 * Re-enqueue `score_fit` for every job that still has no real fit score and
 * whose queue item is either missing or has exhausted its retries. Jobs with a
 * live pending/processing queue item are skipped so the timer never stacks
 * duplicates. Returns the number of jobs re-enqueued.
 */
export function runFitAutoScoreBacklog(): number {
  const cvVersion = getSettings().cv_version ?? 0
  const queue = getAIQueue()
  let enqueued = 0

  for (const job of listJobs()) {
    if (job.score !== null || job.fit_score_version === cvVersion) continue

    const existing = queue.find((q) => q.type === 'score_fit' && q.jobId === job.id)
    if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
      // Already in flight; do not stack duplicates.
      continue
    }

    if (existing && existing.status === 'failed') {
      // The item burned its attempts while the app was open. Reset it to
      // pending so the queue processor will try again on the next tick.
      updateAIQueueItem(existing.id, {
        status: 'pending',
        attempts: 0,
        nextRetryAt: Date.now(),
        lastError: undefined
      })
    } else {
      addAIQueueItem({ type: 'score_fit', jobId: job.id })
    }
    enqueued++
  }

  return enqueued
}

async function runFitAutoScore() {
  if (running) return
  running = true
  try {
    runFitAutoScoreBacklog()
  } catch (err) {
    // Swallow and reschedule: this is a background maintenance task and should
    // not crash the timer loop.
    const msg = err instanceof Error ? err.message : String(err)
    log.error('fitAutoScore run failed:', msg)
  } finally {
    running = false
    scheduleNextFitAutoScore()
  }
}
