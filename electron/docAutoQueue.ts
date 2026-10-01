import { PASSING_REVIEW_SCORE } from './types'
import type { Document, Job, Settings } from './types'

/**
 * Whether this job is allowed to have document generation queued FOR IT,
 * by an automatic path.
 *
 * One predicate, two callers, because the question has exactly one answer
 * and the whole point of extracting it is that the two paths cannot give
 * different answers:
 *
 *   - `maybeAutoEnqueueDocs` (electron/fitScorer.ts), the fit-landing
 *     trigger, which enqueues `tailor_job_docs`.
 *   - the document backlog sweep (electron/docsAutoQueue.ts), which walks
 *     the JOBS and DOCUMENTS tables instead of reacting to a landing.
 *
 * The sweep is the dangerous one, and that is why this exists. The
 * fit-landing trigger runs once, for one job, at the moment a score
 * arrives — so a job that fails the gate costs nothing. The sweep runs
 * over EVERY job in the store on startup, after every scan, and every hour.
 * A sweep with no gate is therefore not "slightly more permissive than the
 * trigger": it multiplies every missing precondition by the size of the
 * user's job list. Two hundred jobs with no documents and no fit score is
 * four hundred LLM tailoring calls on the next launch, none of which the
 * user asked for and none of which could have succeeded.
 *
 * The conditions, in the order `maybeAutoEnqueueDocs` applied them:
 *
 *   1. (sweep only, via `requireConfiguredBaseCv`) A base CV is
 *      configured. Generation means "tailor this job's documents FROM the
 *      user's master CV" — with no base CV there is nothing to tailor
 *      from. See the option's doc comment for why the trigger does not
 *      ask this.
 *   2. There is a real fit score. A job with no score has not been
 *      assessed against anything, so "worth tailoring for" is unknown —
 *      and the sweep sees those jobs in bulk, since the scan paths that
 *      persist score=null are exactly the ones that leave them unscored.
 *   3. The score clears `auto_doc_min_fit`. `score` is stored 0-1 and the
 *      setting is 0-100, on the same scale normalisation
 *      `auto_tailor_min_fit` uses.
 *   4. The job is not already shippable — every document it has carries a
 *      verification score at or above the pass bar. Regenerating would burn
 *      LLM calls and could make a good CV worse. `every` on an empty list
 *      is true, so "has any documents" is checked explicitly.
 *
 * Note what is NOT here: `is_stale` / the clear epoch. That is a
 * caller-local concern (the fit-landing trigger is told mid-flight that the
 * user cleared the queue), and it is not a property of the job.
 *
 * Also not here: which documents are missing. The gate decides whether a
 * job may be worked on at all; the sweep then asks per document type which
 * unit is missing. Keeping those two questions apart is what lets the
 * trigger — which always means "both documents" — share the gate with a
 * sweep that means "just the cover letter".
 */
export interface DocEligibilityOptions {
  /**
   * Also require a base CV to be configured.
   *
   * Off for the fit-landing trigger, on for the sweep, and the asymmetry
   * is deliberate rather than an oversight:
   *
   * The trigger is structurally unreachable with no base CV —
   * `scoreOneJobInBackground` returns early in that state and never calls
   * `maybeAutoEnqueueDocs` — so the check would be dead code there, and
   * adding it anyway would change a shipped function's behaviour (and its
   * tests) to guard a state it cannot be in.
   *
   * The sweep IS reachable there, and cheaply so: a job row keeps the
   * score it earned while a base CV was configured, so clearing the base
   * CV in Settings leaves scored, documentless jobs in the store with
   * nothing to tailor from. Generation is literally "tailor this job's
   * documents FROM the user's master CV", so every one of those would
   * fail after a round trip to the provider.
   */
  requireConfiguredBaseCv?: boolean
}

export function autoDocQueueEligible(
  job: Job,
  settings: Settings,
  docs: Document[],
  opts?: DocEligibilityOptions
): boolean {
  if (opts?.requireConfiguredBaseCv && !settings.base_cv) return false
  if (job.score === null) return false

  const minFit = settings.auto_doc_min_fit ?? 40
  if (job.score * 100 < minFit) return false

  const shippable = docs.length > 0 && docs.every((d) => (d.verification_score ?? 0) >= PASSING_REVIEW_SCORE)
  return !shippable
}
