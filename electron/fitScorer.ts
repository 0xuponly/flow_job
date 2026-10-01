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
import { autoDocQueueEligible } from './docAutoQueue'
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
 * already exist with a passing AI review") — all of them now live in
 * `autoDocQueueEligible` (electron/docAutoQueue.ts), shared with the
 * document backlog sweep. They used to be inlined here, which meant the
 * sweep had to either copy them (and drift) or ignore them (and queue
 * work that could not succeed). One predicate, two callers.
 *
 *   - A `tailor_job_docs` item for this job means generation is already
 *     scheduled, queued or not; enqueueing again would stack duplicate
 *     work. That is decided by `enqueue`'s own duplicate guard, which
 *     returns null instead of adding a second row — this function does
 *     not re-check it. (A `failed` row is included in that guard: it is
 *     revived in place rather than re-queued, so the answer here is
 *     still "not newly added.")
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

  const settings = db.getSettings()
  // The user's Auto-queue switches come BEFORE the fit threshold, and
  // the reason is the return value: a caller reads `false` here as
  // "generation was not scheduled", which is true whether the job
  // scored low or the user turned CV auto-queueing off. Checking the
  // threshold first would make a switch-off indistinguishable from a
  // below-threshold score in the only signal this function has.
  //
  // `tailor_job_docs` generates the CV and the cover letter in one
  // pass, so it needs both switches on. enqueue() enforces the same
  // rule for every other caller; this is the same check one step
  // earlier, made here so the fit-landing trigger cannot report a
  // queue row it was never allowed to create. Manual Tailor and Quick
  // Apply do not come through here — they are user actions and are
  // never gated.
  //
  // It stays here rather than moving into the shared predicate, and the
  // asymmetry with the sweep is deliberate: the sweep gates each
  // document unit by its OWN toggle (a CV-only sweep is legitimate when
  // the user turned cover letters off), whereas `tailor_job_docs` is the
  // both-documents unit and cannot honour one toggle without quietly
  // doing the other.
  if (settings.auto_queue_cv === false || settings.auto_queue_cover_letter === false) {
    return false
  }

  // Real fit score, `auto_doc_min_fit`, and "not already shippable" all
  // live in `autoDocQueueEligible` (electron/docAutoQueue.ts), which the
  // document backlog sweep also calls — one predicate, two callers, so
  // the sweep cannot drift from the trigger's preconditions.
  if (!autoDocQueueEligible(job, settings, db.listDocuments(jobId))) return false


  // Duplicate suppression is `enqueue`'s job: its guard matches a row
  // of the same work in ANY status on (type, jobId, documentId,
  // sectionName) — a `failed` one is revived in place, a
  // pending/processing one is left alone — and a `tailor_job_docs` item
  // is only ever enqueued with a jobId (see main.ts, jobSearch.ts, and
  // this function), so the guard's key is exactly this pre-check's
  // predicate. It used to be re-implemented here — a second full scan
  // of the queue on every fit-landing, before the one `enqueue` was
  // about to do anyway. The old comment justified it by claiming
  // "`enqueue` only dedupes against `pending`"; that stopped being true
  // when the guard was widened to cover `processing`, and a second copy
  // of a dedupe rule is a second thing to keep correct.
  return enqueue({ type: 'tailor_job_docs', jobId }) !== null
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