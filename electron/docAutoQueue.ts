import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX, PASSING_REVIEW_SCORE } from './types'
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
 * job may be worked on AT ALL — one answer, and the trigger and the sweep
 * both get it. Which units are missing is the next question, asked per
 * document type by every caller now (see `docTypeMissing` /
 * `planDocUnit`). Keeping the two apart is what lets a cover-letter-only
 * trigger share the gate with a CV-only sweep; fusing them is what let the
 * two producers disagree about whether a job was covered.
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

/**
 * The five auto-queue toggles, read TOLERENTLY: absent means on.
 *
 * These keys are being added to `Settings` by a concurrent branch
 * (autotoggles). They are read through a local cast rather than through the
 * `Settings` type so this module compiles on a tree where the keys do not
 * exist yet and the two branches merge without either waiting on the
 * other. The cast goes away the moment the keys land in the type.
 *
 * Every comparison is `!== false` rather than a plain truthiness read, so
 * a store written before the keys existed (or one missing the key) still
 * resolves to ON. A missing key must never disable the feature.
 *
 * `auto_queue_verify_cv` / `auto_queue_verify_cover_letter` are resolved
 * here for completeness but applied in aiQueue.ts, where the `verify` rows
 * are created: a `generate_cv` / `generate_cover_letter` item is chained to
 * its review by the processor, so gating that chain belongs where the chain
 * is created. `auto_queue_fit` gates the fit re-seeder in fitAutoScore.ts.
 *
 * Lives here, not in the sweep, because BOTH producers need it: the sweep
 * for its per-unit gating and the fit-landing trigger for the same
 * per-unit gating. Two readers and one tolerant read, or two tolerant
 * reads that disagree about what "absent" means.
 *
 * Takes its settings as an argument rather than reading the store: this
 * module is a pure decision module with no dependency on `./database`, so
 * `fitScorer` and the sweep both keep one shape of "read the settings once
 * and pass them to every predicate".
 */
export interface AutoQueueFlags {
  auto_queue_fit: boolean
  auto_queue_cv: boolean
  auto_queue_cover_letter: boolean
  auto_queue_verify_cv: boolean
  auto_queue_verify_cover_letter: boolean
}

export function autoQueueFlags(settings: Settings): AutoQueueFlags {
  const s = settings as Settings & Partial<AutoQueueFlags>
  return {
    auto_queue_fit: s.auto_queue_fit !== false,
    auto_queue_cv: s.auto_queue_cv !== false,
    auto_queue_cover_letter: s.auto_queue_cover_letter !== false,
    auto_queue_verify_cv: s.auto_queue_verify_cv !== false,
    auto_queue_verify_cover_letter: s.auto_queue_verify_cover_letter !== false
  }
}

/**
 * One document unit: a document type, the queue row type that produces it,
 * and the toggle that gates it.
 *
 * `tailor_job_docs` is deliberately absent. It is the BOTH-documents unit,
 * and it is only ever produced by a person (Quick Apply, `manual: true`).
 * An automatic producer that queues it cannot honour one toggle without
 * doing the other, which is why the sweep never queues it and why the
 * fit-landing trigger stopped queueing it too: queueing the missing unit
 * instead is both cheaper and the only shape that can respect a
 * CV-only or cover-letter-only setting.
 */
export interface DocUnit {
  docType: Document['type']
  queueType: Extract<AIQueueItem['type'], 'generate_cv' | 'generate_cover_letter'>
  enabled: boolean
}

export function docUnits(flags: AutoQueueFlags): DocUnit[] {
  return [
    { docType: 'cv', queueType: 'generate_cv', enabled: flags.auto_queue_cv },
    {
      docType: 'cover_letter',
      queueType: 'generate_cover_letter',
      enabled: flags.auto_queue_cover_letter
    }
  ]
}

/**
 * Whether this job is still missing a GENERATED document of this type.
 *
 * "Generated" is `!is_base`, and the filter is the whole point.
 * `listDocuments(jobId)` deliberately unions in the user's master CV (the
 * base row, `is_base = 1`) so the Documents / JobDetail views can show it
 * beside every job — which means a bare `some(d => d.type === 'cv')`
 * reports a CV for EVERY job in the store and every automatic producer
 * would enqueue nothing, ever, for exactly the users it exists to serve.
 * The user's requirement is explicit: a document that is only the base CV
 * the user supplied is not a generated CV and must never satisfy this
 * check. The cover letter is the same case.
 *
 * (`is_base` is 0 on every generated row: `createDocument`'s `isBase`
 * argument is only ever passed false, and the tailor path never passes it
 * at all — see the commit body for the full reading of the column.)
 *
 * ONE implementation, asked by every automatic producer. The sweep asks it
 * per unit in its loop; the fit-landing trigger asks it for the same two
 * units before queueing anything. It used to be a private function of the
 * sweep, which is how the trigger could end up with a second opinion: it
 * asked "is this job covered?" and got a different answer from the one the
 * sweep got from "is the cover letter missing?".
 */
export function docTypeMissing(docs: Document[], type: Document['type']): boolean {
  return !docs.some((d) => d.type === type && !d.is_base)
}

/**
 * The queue rows that are the SAME piece of work as `queueType` for this
 * job, by `enqueue`'s duplicate key — (type, jobId, documentId,
 * sectionName) — rather than by type and jobId alone.
 *
 * A `generate_cv` row that carries a `documentId` is an AUTO-REGENERATION
 * of an existing document (the review->regenerate loop in aiQueue.ts), not
 * a first generation. Treating it as this unit's row would be wrong in
 * both directions: reviving it in place would aim a "this job has no CV"
 * re-seed at a document that is not the CV this unit is missing, and
 * letting it count as in-flight would suppress the fresh generation the
 * caller is about to queue — which is reachable whenever the user
 * deletes a CV while its regeneration row is still queued.
 */
function sameWorkRows(
  queue: AIQueueItem[],
  jobId: number,
  queueType: AIQueueItem['type']
): AIQueueItem[] {
  return queue.filter(
    (q) => q.type === queueType && q.jobId === jobId && (q.documentId ?? null) === null
  )
}

/**
 * 'skip'          — nothing to do, or a refusal (below).
 * 'add'           — no row for this work at all.
 * { revive: row } — an exhausted row that may be resurrected in place.
 */
export type DocUnitPlan = 'skip' | 'add' | { revive: AIQueueItem }

/**
 * Decide what, if anything, to do about one document unit of one job.
 *
 * Every `skip` is a refusal and says why on its branch. The revival branch
 * is the PROCESSOR's revival, written the same way `runFitAutoScoreBacklog`
 * writes it: one unit of the revive budget and parked on the shared
 * cooldown. Honouring both is what keeps every automatic producer of
 * document work from becoming a second, unlimited retry lane.
 *
 * ONE implementation, asked by BOTH producers — the sweep's two paths
 * (electron/docsAutoQueue.ts) and the fit-landing trigger
 * (electron/fitScorer.ts). That is the whole of the fit-landing trigger's
 * cost bound: a trigger landing on a spent row is refused here exactly as
 * a sweep tick is, so `AUTO_REVIVE_MAX` and `AUTO_REVIVE_COOLDOWN_MS` bound
 * the trigger without any state of its own.
 *
 * The in-flight half of this decision is NOT here: it is
 * `jobDocWorkInFlight`, called by all three callers before they get here,
 * and it sees both this unit's own rows and a `tailor_job_docs` row,
 * which produces both documents. A duplicate pair is handled there for
 * the same reason runFitAutoScoreBacklog does it — every live row is
 * judged, not just the first — so nothing is resurrected alongside a
 * live one.
 */
export function planDocUnit(
  jobId: number,
  docs: Document[],
  queue: AIQueueItem[],
  now: number,
  unit: DocUnit
): DocUnitPlan {
  if (!docTypeMissing(docs, unit.docType)) return 'skip'

  const matches = sameWorkRows(queue, jobId, unit.queueType)
  const existing = matches[0]
  if (existing && existing.status === 'failed') {
    if ((existing.autoRevives ?? 0) >= AUTO_REVIVE_MAX) return 'skip'
    // Its cooldown has not elapsed. Same guard runPass applies to every
    // row, which is why a row parked on a cooldown is never pulled
    // forward here — and why a producer that lands every few minutes
    // cannot spend one generation per landing.
    if (existing.nextRetryAt > now) return 'skip'
    return { revive: existing }
  }

  return 'add'
}

/**
 * The bounded revival WRITE: the one patch every automatic producer of
 * document work uses to resurrect a spent row.
 *
 * `enqueue`'s `revivePatch()` is deliberately NOT this — it resets
 * `attempts` and `nextRetryAt` to now and leaves `autoRevives` alone,
 * which is right for a person pressing Retry and unbounded for a machine
 * that lands on a score every few minutes. Charging the budget and parking
 * on the cooldown is what makes the revival finite.
 *
 * Exported so the three producers cannot each write their own.
 */
export function revivePatchForAutomatic(
  row: AIQueueItem,
  now: number
): Partial<AIQueueItem> {
  return {
    status: 'pending',
    attempts: 0,
    autoRevives: (row.autoRevives ?? 0) + 1,
    nextRetryAt: now + AUTO_REVIVE_COOLDOWN_MS,
    lastError: undefined
  }
}
