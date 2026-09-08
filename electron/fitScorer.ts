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
import type { Job } from './types'

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
export async function scoreOneJobInBackground(jobId: number): Promise<Job | null> {
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