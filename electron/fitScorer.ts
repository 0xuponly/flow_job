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
import { scoreJobFit, ProviderCooldownError, type AiCallOptions } from './ai'
import { enqueue } from './aiQueue'
import {
  autoDocQueueEligible,
  autoQueueFlags,
  docTypeMissing,
  docUnits,
  jobDocWorkInFlight,
  planDocUnit,
  revivePatchForAutomatic
} from './docAutoQueue'
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
 * WHAT IT QUEUES: the MISSING UNITS, one row each — `generate_cv` and/or
 * `generate_cover_letter`, decided per document type. It used to queue a
 * single `tailor_job_docs` row, which is the both-documents unit, and that
 * is where this function used to disagree with the sweep. Asked "is this
 * job's document work in flight?" it declined when a `verify` row was live
 * for the CV (so it queued nothing at all, stranding the missing cover
 * letter until the next sweep); asked with the sweep's rows on disk it saw
 * no live cover-letter row and queued a `tailor_job_docs`, REGENERATING the
 * CV the sweep had deliberately left alone. Two producers, two answers to
 * one question, because only one of the two was per document type.
 *
 * So: same unit list as the sweep, same per-unit questions, same answers.
 *   - the toggle that gates THIS unit (a CV-only trigger is now a real
 *     answer, which `tailor_job_docs` could not express: it needs both
 *     switches because it cannot honour one without doing the other);
 *   - `docTypeMissing` — is this document still missing at all;
 *   - `jobDocWorkInFlight` — will some producer's LIVE row produce a first
 *     generation of it already;
 *   - `planDocUnit` — is there a dead row to resurrect, and may it be?
 *
 * None of that is private to this function. It is why the two producers
 * cannot drift, and it is why the trigger's cost is bounded: the last
 * question is the sweep's own budget, `AUTO_REVIVE_MAX` revivals
 * `AUTO_REVIVE_COOLDOWN_MS` apart, charged on the SAME per-row field the
 * sweep and the processor charge.
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
  const docs = db.listDocuments(jobId)

  // Real fit score, `auto_doc_min_fit`, and "not already shippable" all
  // live in `autoDocQueueEligible` (electron/docAutoQueue.ts), which the
  // document backlog sweep also calls — one predicate, two callers, so
  // the sweep cannot drift from the trigger's preconditions. This is the
  // JOB-level gate; the per-document questions come next, per unit.
  if (!autoDocQueueEligible(job, settings, docs)) return false

  const queue = db.getAIQueue()
  const now = Date.now()
  let enqueued = 0

  // One pass per document unit, in the sweep's order, asking the sweep's
  // questions. `docTypeMissing` is what makes this the "queue only what is
  // missing" rule rather than the old "queue both or nothing": a job with
  // a CV whose review is in flight and no cover letter queues exactly one
  // row here, for the cover letter, and the CV is left alone.
  for (const unit of docUnits(autoQueueFlags(settings))) {
    // The user's toggle, applied to THIS unit, exactly as the sweep does.
    // `enqueue` would enforce the same rule centrally for the `add` case;
    // reading it here is what keeps the return value honest about what
    // was queued, and what lets a CV-only or cover-letter-only trigger be
    // a real answer.
    if (!unit.enabled) continue
    if (!docTypeMissing(docs, unit.docType)) continue

    // ...and "is this unit already covered or in flight, by ANY producer?"
    // — `jobDocWorkInFlight`, the same shared predicate the sweep
    // consults for each unit it is about to queue. Asked per unit, like
    // the sweep, so a live `generate_cv` row blocks the CV and leaves the
    // cover letter free. That granularity is load-bearing: it is what
    // keeps one job from reaching three queue rows — and three CVs plus
    // three cover letters — because `enqueue`'s duplicate guard below
    // cannot see across row types.
    if (jobDocWorkInFlight(queue, jobId, [unit.docType])) continue

    const plan = planDocUnit(jobId, docs, queue, now, unit)
    if (plan === 'skip') continue

    if (plan === 'add') {
      // `enqueue` rather than `addAIQueueItem`: it is the dedupe-aware
      // writer, so a row that appeared since the snapshot cannot be
      // duplicated, and it is the same writer the sweep uses.
      if (enqueue({ type: unit.queueType, jobId }) !== null) enqueued++
      continue
    }

    // A dead row for this unit that may be resurrected. `planDocUnit` has
    // already refused one whose revive budget is spent or whose cooldown
    // has not elapsed, and the write charges the budget and parks the row
    // on the cooldown — so a trigger that lands every few minutes cannot
    // buy one generation per landing, which is exactly the unbounded
    // lane this function used to be. Deliberately NOT `enqueue`, whose
    // duplicate path revives a `failed` row with `revivePatch()`:
    // `attempts: 0`, `nextRetryAt: now`, `autoRevives` untouched.
    db.updateAIQueueItem(plan.revive.id, revivePatchForAutomatic(plan.revive, now))
    enqueued++
  }

  // A caller reads this as "a generation item was enqueued", so it is the
  // count, not "the gate said yes".
  return enqueued > 0
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
  isStale?: () => boolean,
  opts?: AiCallOptions
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
    }, undefined, opts)
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
    let updated: Job | null
    try {
      updated = db.updateJob(jobId, { fit_last_error: msg })
      emitJobScoreUpdatedModule(jobId)
    } catch (writeErr) {
      if (writeErr instanceof Error && writeErr.message === 'Job not found') {
        log.fit.warn(`scoreOneJobInBackground: job ${jobId} was deleted mid-run, skipping`)
        return null
      }
      throw writeErr
    }
    // A provider block is not a fit failure, so it is recorded on the
    // job (above) but NOT laundered into a plain return.
    //
    // This function is the boundary between the scorer and the queue: the
    // `score_fit` case in aiQueue turns a null `score` back into an
    // exception, so swallowing here is what let a no-request cooldown
    // block reach the queue as `new Error(msg)` and be charged one of
    // the five score_fit attempts — the same bug as in the generate /
    // review lanes, one file over, reached through a string instead of
    // through a type (2026-10-02).
    //
    // Both callers want the type preserved: aiQueue parks the row on the
    // provider's clock for free, and `jobs:recomputeFit` surfaces "no
    // provider available" rather than a fit score nobody computed.
    if (err instanceof ProviderCooldownError) throw err
    return updated
  }
}