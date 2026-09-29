// Single-job fit scorer. Lives outside main.ts because main.ts has heavy
// import-time side effects (BrowserWindow, ipcMain handlers, scan state)
// that make it hard to import from a test. fitScorer.ts only depends on
// ./database, ./ai, and electron.BrowserWindow, so it stays trivially
// mockable.
//
// Shared by:
//   - main.ts: jobs:create, jobs:importFromUrl, jobs:recomputeFit
//   - aiQueue.ts: dynamic import for the score_fit queue item
//
// IMPORTANT: no Fit score is fabricated here. The no-base-CV path keeps
// score=null and only stamps fit_score_version + an explanatory
// fit_rationale/fit_last_error. The heuristic fallback path likewise
// leaves score=null (it only sets fit_last_error + fit_source). Only
// a successful LLM call writes a real number to the row.

import { BrowserWindow } from 'electron'
import { log } from './logger'
import * as db from './database'
import { scoreJobFit } from './ai'
import { enqueue } from './aiQueue'
import { PASSING_REVIEW_SCORE } from './types'
import type { Job } from './types'

/**
 * P1.7 (BRIEF5 §1/§4): auto-queue document generation when a job's
 * fit score lands at or above `auto_doc_min_fit` (default 40).
 *
 * Called from `scoreOneJobInBackground` after a real score is
 * persisted, so every fit-landing path (manual recompute, the queue's
 * score_fit item, jobs:create, jobs:importFromUrl) gets the trigger
 * from one place.
 *
 * Returns true when a generation item was enqueued, false otherwise
 * (below threshold, no score, job gone, already queued, or docs
 * already good enough).
 *
 * Skip rules (BRIEF5 §1: "Don't re-generate a job's docs if they
 * already exist with a passing AI review"):
 *   - A job whose documents all carry verification_score >= 80 is
 *     already in a shippable state; regenerating would burn LLM calls
 *     and could make a good CV worse.
 *   - A `tailor_job_docs` item that is still pending/processing means
 *     generation is already scheduled; enqueueing again would stack
 *     duplicate work.
 */
export function maybeAutoEnqueueDocs(
  jobId: number,
  isStale?: () => boolean
): boolean {
  // The caller (the queue processor) can tell us the work it was doing
  // has since been cancelled — the user cleared the queue while this
  // LLM call was in flight. Re-queueing document generation at that
  // point would rebuild the pipeline the user just emptied.
  if (isStale?.()) return false
  const job = db.getJob(jobId)
  if (!job) return false
  if (job.score === null) return false

  const settings = db.getSettings()
  const minFit = settings.auto_doc_min_fit ?? 40
  // `score` is stored 0-1; the setting is 0-100 (same scale as
  // auto_tailor_min_fit, normalized on migration).
  if (job.score * 100 < minFit) return false

  // Already shipped-ready: every document for this job reviewed at or
  // above the pass bar. `every` on an empty list is true, so guard the
  // "has any docs" case explicitly.
  const docs = db.listDocuments(jobId)
  if (docs.length > 0 && docs.every((d) => (d.verification_score ?? 0) >= PASSING_REVIEW_SCORE)) {
    return false
  }

  // Generation already scheduled (pending or in flight). `enqueue`
  // only dedupes against `pending`, so a `processing` item has to be
  // checked here or a re-trigger mid-generation would queue a second
  // run.
  const alreadyQueued = db
    .getAIQueue()
    .some(
      (q) =>
        q.type === 'tailor_job_docs' &&
        q.jobId === jobId &&
        (q.status === 'pending' || q.status === 'processing')
    )
  if (alreadyQueued) return false

  enqueue({ type: 'tailor_job_docs', jobId })
  return true
}

/**
 * Send a 'job:scoreUpdated' notification to every live renderer. The
 * IPC handlers in main.ts register the listener on each renderer's
 * webContents, and the renderer refreshes the affected row without a
 * full re-list. No-op when no BrowserWindow is open (e.g. headless
 * test runs).
 */
export function emitJobScoreUpdatedModule(jobId: number): void {
  const job = db.getJob(jobId)
  if (!job) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('job:scoreUpdated', job)
  }
}

/**
 * Score a single job against the current base CV. Used by:
 *   - jobs:create / jobs:importFromUrl handlers in main.ts (fire-and-forget)
 *   - jobs:recomputeFit (returns the post-update row)
 *   - aiQueue processItem for the score_fit queue type
 *
 * Returns the post-update row, or null if the job was deleted between
 * the call and the read.
 */
export async function scoreOneJobInBackground(
  jobId: number,
  isStale?: () => boolean
): Promise<Job | null> {
  const job = db.getJob(jobId)
  if (!job) return null
  const settings = db.getSettings()
  const baseCv = settings.base_cv || ''
  const currentVersion = settings.cv_version ?? 0
  if (!baseCv) {
    // No CV configured — leave score null (no Fit was computed) but
    // stamp fit_score_version so we don't retry on every subsequent
    // add, and record the explanation on fit_rationale/fit_last_error.
    try {
      const updated = db.updateJob(jobId, {
        fit_rationale: 'No base CV configured.',
        fit_breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
        fit_score_version: currentVersion,
        fit_source: 'heuristic',
        fit_last_error: 'No base CV configured.'
      })
      emitJobScoreUpdatedModule(jobId)
      return updated
    } catch (err) {
      if (err instanceof Error && err.message === 'Job not found') {
        log.fit.warn(`scoreOneJobInBackground: job ${jobId} was deleted mid-run, skipping`)
        return null
      }
      throw err
    }
  }
  try {
    const fit = await scoreJobFit({
      title: job.title,
      description: job.description,
      requirements: job.requirements,
      location: job.location,
      baseCv
    })
    if (fit.source === 'heuristic') {
      // Don't pretend a heuristic fallback is a real fit score.
      try {
        const updated = db.updateJob(jobId, {
          fit_last_error: fit.error || 'LLM scorer fell back to heuristic.',
          fit_source: 'heuristic'
        })
        emitJobScoreUpdatedModule(jobId)
        return updated
      } catch (err) {
        if (err instanceof Error && err.message === 'Job not found') {
          log.fit.warn(`scoreOneJobInBackground: job ${jobId} was deleted mid-run, skipping`)
          return null
        }
        throw err
      }
    }
    try {
      const updated = db.updateJob(jobId, {
        score: fit.score,
        fit_rationale: fit.rationale,
        fit_breakdown: fit.breakdown,
        fit_score_version: currentVersion,
        fit_source: 'llm',
        fit_last_error: null
      })
      // P1.7 §1: a real score just landed — if it clears
      // `auto_doc_min_fit`, queue document generation (the queue then
      // chains generation -> AI review sequentially for this job).
      // Fire-and-forget: a failure here must not lose the score we
      // just persisted.
      try {
        maybeAutoEnqueueDocs(jobId, isStale)
      } catch (enqueueErr) {
        log.fit.warn(
          `auto-doc enqueue failed for job ${jobId}:`,
          enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
        )
      }
      emitJobScoreUpdatedModule(jobId)
      return updated
    } catch (err) {
      if (err instanceof Error && err.message === 'Job not found') {
        log.fit.warn(`scoreOneJobInBackground: job ${jobId} was deleted mid-run, skipping`)
        return null
      }
      throw err
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    log.fit.warn(`job ${jobId} (${job.company} — ${job.title}): ${msg}`)
    try {
      const updated = db.updateJob(jobId, { fit_last_error: msg })
      emitJobScoreUpdatedModule(jobId)
      return updated
    } catch (writeErr) {
      if (writeErr instanceof Error && writeErr.message === 'Job not found') {
        log.fit.warn(`scoreOneJobInBackground: job ${jobId} was deleted mid-run, skipping`)
        return null
      }
      throw writeErr
    }
  }
}