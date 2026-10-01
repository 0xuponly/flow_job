import { getSettings, getAIQueue, addAIQueueItem, updateAIQueueItem, listJobs, isScoreFitSuppressed } from './database'
import { enqueue } from './aiQueue'
import { createLogger } from './logger'
import { timerDeadlineMs } from './utils'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import type { Job } from './types'

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
 * The jobs both re-seeders are allowed to queue, and why.
 *
 * "Needs a fit score" is a statement about the JOBS table, so both
 * re-seeding paths ask it the same way. The suppression clause is what
 * makes "Clear queue" mean what the confirm dialog says it means: work
 * the user cancelled is not rebuilt out of the jobs table four hours
 * later, on the next launch, or after the next scan. See
 * `isScoreFitSuppressed`.
 */
function needsFitScore(job: Job, cvVersion: number): boolean {
  if (job.score !== null || job.fit_score_version === cvVersion) return false
  return !isScoreFitSuppressed(job.id)
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
  const now = Date.now()
  let enqueued = 0

  for (const job of listJobs()) {
    if (!needsFitScore(job, cvVersion)) continue

    // Deliberately not the shared `enqueue()`. `enqueue` now matches a
    // row of the same work in ANY status and revives a `failed` one in
    // place, but it revives it the way a person asking for it would:
    // full fresh budget, run now. This path resurrects the way the
    // PROCESSOR does — one unit of the revive budget, parked on the 4h
    // cooldown — which is what stops a job that can never be scored from
    // being re-woken every four hours forever. The pending/processing
    // check below is the same question `enqueue` asks, asked for the
    // reason this path needs it (is anything in flight?), and it must
    // stay in step — when this checked only `pending` (as `enqueue` once
    // did) both paths added a row for the same job during a long
    // `processing` window, which is how the Queue panel came to show
    // three score_fit entries per job.
    // Every matching row, not just the first: a job that somehow has
    // more than one must be judged on whether ANY of them is in flight,
    // or a duplicate pair reads as "exhausted" and gets resurrected.
    const matches = queue.filter((q) => q.type === 'score_fit' && q.jobId === job.id)
    if (matches.some((q) => q.status === 'pending' || q.status === 'processing')) {
      // Already in flight; do not stack duplicates.
      continue
    }

    const existing = matches[0]
    if (existing && existing.status === 'failed') {
      // The item burned its attempts while the app was open. Resurrecting
      // it is the SAME operation the processor's own `revive()` performs
      // on the next pass, so it is written the same way: it costs one
      // unit of the revive budget and parks on the same cooldown.
      //
      // Both halves used to be missing here, and together they made this
      // path a free and unlimited retry lane — the 4h cooldown and
      // AUTO_REVIVE_MAX that every other queue type honours simply did not
      // apply to score_fit, so a job whose provider was permanently
      // rejecting it kept burning a full attempt budget every 4 hours,
      // forever, with the budget counter never moving.
      const revives = existing.autoRevives ?? 0
      if (revives >= AUTO_REVIVE_MAX) {
        // Budget spent. Leave it failed for the user, as runPass does.
        continue
      }
      if (existing.nextRetryAt > now) {
        // Its cooldown has not elapsed. Same guard runPass applies to
        // every row, which is why a row parked on a cooldown is never
        // pulled forward here.
        continue
      }
      updateAIQueueItem(existing.id, {
        status: 'pending',
        attempts: 0,
        autoRevives: revives + 1,
        nextRetryAt: now + AUTO_REVIVE_COOLDOWN_MS,
        lastError: undefined
      })
    } else {
      addAIQueueItem({ type: 'score_fit', jobId: job.id })
    }
    enqueued++
  }

  return enqueued
}

/**
 * Queue a fit score for every job that has never been scored against the
 * current CV. Covers the scan paths that persist score=null (heuristic
 * pre-filter, LLM-error fallback) plus legacy rows. The
 * fit_score_version guard matches database.ts's documented invariant:
 * score-less rows have version null/old, so they qualify; rows scored
 * against the current CV (version match, real score) are skipped.
 *
 * Lives here, next to the other re-seeder, because it is the same
 * question asked of the same table: this used to be a private function in
 * main.ts, called both at session start and after every scan, and being
 * private it was the one half of the clear-durability contract that
 * nothing could test. Exported, the two paths sit in one file and cannot
 * drift apart on the suppression rule.
 */
export function enqueueScoreFitBacklog(): number {
  const cvVersion = getSettings().cv_version ?? 0
  let enqueued = 0
  for (const job of listJobs()) {
    if (!needsFitScore(job, cvVersion)) continue
    if (enqueue({ type: 'score_fit', jobId: job.id })) enqueued++
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
