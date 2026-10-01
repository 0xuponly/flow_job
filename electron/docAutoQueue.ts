import { PASSING_REVIEW_SCORE } from './types'
import type { AIQueueItem, Document, Job, Settings } from './types'

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

/**
 * The queue types that PRODUCE a document for a job, and which document
 * each one produces.
 *
 * `tailor_job_docs` is the both-documents unit: processItem's case for it
 * calls `tailorJobDocsForJob`, which tailors the CV and the cover letter
 * and writes both. The other two produce exactly one each. This is the
 * mapping that lets `jobDocWorkInFlight` be asked "will a live row give
 * this job a CV?" in the same words by a caller that means only the CV
 * (the sweep's unit) and by one that means both (the trigger's
 * `tailor_job_docs`).
 */
const DOC_PRODUCING_ROWS: Partial<Record<AIQueueItem['type'], Document['type'][]>> = {
  tailor_job_docs: ['cv', 'cover_letter'],
  generate_cv: ['cv'],
  generate_cover_letter: ['cover_letter']
}

/**
 * Whether a LIVE queue row for this job will already produce a first
 * generation of any of `docTypes` — i.e. whether a producer other than
 * the caller's own has this job's document work covered or in flight.
 *
 * One predicate, BOTH directions, and the reason it is shared is the whole
 * defect this exists to close. Document work for one job can be produced
 * two ways:
 *
 *   - the document backlog sweep queues `generate_cv` and
 *     `generate_cover_letter` as two units, one per missing document
 *     (electron/docsAutoQueue.ts);
 *   - the fit-landing trigger queues a single `tailor_job_docs` row,
 *     which generates both in one pass (electron/fitScorer.ts).
 *
 * `enqueue`'s duplicate guard keys on `(type, jobId, documentId,
 * sectionName)`, so it can never see that these two are the same work: a
 * `tailor_job_docs` row does not match a `generate_cv` row. Each
 * direction therefore had to answer "is this job already covered?" for
 * itself, and only the sweep→trigger direction had an answer at all:
 * `jobCoveredByLiveTailor` stopped the sweep when a live tailor row
 * existed, while nothing stopped the trigger when the sweep's rows
 * existed. Proved end to end against the real store and the real
 * processor: one job, 3 queue rows, 3 CVs and 3 cover letters, and every
 * one of them billed. Both directions now ask this function, so they
 * cannot drift apart the way they just did.
 *
 * What counts as covered:
 *
 *   - A row for THIS job only. Another job's row is another job's work.
 *   - `pending` or `processing` — the states the processor works from.
 *     A `failed` row is NOT in flight: the work has not happened, and
 *     reviving that row is exactly what the sweep's revive branch is for.
 *   - A row with NO `documentId`. A `generate_cv` that carries a
 *     `documentId` is the review→regenerate loop rebuilding a document
 *     that EXISTS (aiQueue.ts's `verify` case), not a first generation
 *     of a missing one. Counting it would suppress the fresh generation
 *     the caller is about to queue — and it does not cover anything
 *     either: `tailorDocument` with a `document_id` replaces that row in
 *     place, so a job whose CV was deleted while its regeneration row
 *     was still queued would be left with no CV and nothing to produce
 *     one. This is the same exclusion `sameWorkRows` makes in
 *     docsAutoQueue.ts, for the same reason.
 *   - A row whose type produces one of the requested document types, per
 *     `DOC_PRODUCING_ROWS`. This is what makes the check per-document
 *     rather than per-job: a live `generate_cv` row covers the CV and
 *     nothing else, so it does not stop a caller that is about to
 *     generate a cover letter.
 *
 * Deferral semantics — what the caller gets when this returns true.
 *
 * The caller does NOT get its work skipped: it gets it handed to
 * whichever producer holds the live row, and the two producers are not
 * equivalent, so the two cases are:
 *
 *   - Deferring to a `tailor_job_docs` row is total. That row generates
 *     both documents, so the job gets exactly what the trigger would have
 *     given it, from one row instead of the trigger's one row. Nothing
 *     is left undone.
 *   - Deferring to a single-unit row is total only for that unit. A live
 *     `generate_cv` row will produce the CV and never a cover letter, so
 *     the other document stays the backlog sweep's job — which is what
 *     the sweep is for: it is armed at startup, after every scan, and on
 *     the hourly cadence, and it asks about each missing unit separately,
 *     gated by that unit's own toggle. A `tailor_job_docs` row covering
 *     both types means neither unit is ever stranded by this.
 *
 * So: the trigger asks about BOTH types, because it produces both, and a
 * partial overlap leaves the uncovered document to the sweep rather than
 * to a second `tailor_job_docs` row that would duplicate the live one.
 * Which also means the trigger's own switch checks stay load-bearing: if
 * the uncovered document's toggle is off, the trigger was never allowed
 * to produce it either, so a deferral can never override the user's
 * settings.
 */
export function jobDocWorkInFlight(
  queue: AIQueueItem[],
  jobId: number,
  docTypes: readonly Document['type'][]
): boolean {
  return queue.some((q) => {
    if (q.jobId !== jobId) return false
    if (q.status !== 'pending' && q.status !== 'processing') return false
    if ((q.documentId ?? null) !== null) return false
    const produced = DOC_PRODUCING_ROWS[q.type]
    return produced !== undefined && produced.some((t) => docTypes.includes(t))
  })
}
