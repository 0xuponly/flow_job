import {
  getSettings,
  getAIQueue,
  addAIQueueItem,
  updateAIQueueItem,
  listJobs,
  listDocuments,
  isScoreFitSuppressed
} from './database'
import { enqueue } from './aiQueue'
import { createLogger } from './logger'
import { timerDeadlineMs } from './utils'
import { autoDocQueueEligible, jobDocWorkInFlight } from './docAutoQueue'
import { AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, Document, Settings } from './types'

const log = createLogger('tailor')

// The same cadence the fit re-seeder uses (electron/fitAutoScore.ts), and
// deliberately driven by the SAME setting so a user who retimes the fit
// sweep retimes both: two sweeps reading one interval is the only way they
// cannot drift apart. No `docs_autosweep_interval_minutes` key is read —
// the Settings type and the settings defaults are owned by another branch
// (autotoggles) and this module must not add keys it does not own.
const DEFAULT_INTERVAL_MINUTES = 60

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
 * The five auto-queue toggles, read TOLERANTLY: absent means on.
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
 * Not applied by this module, deliberately:
 *   - `auto_queue_fit` gates the fit re-seeder in fitAutoScore.ts, which is
 *     out of scope here.
 *   - `auto_queue_verify_cv` / `auto_queue_verify_cover_letter` gate the
 *     REVIEW rows. This sweep enqueues no `verify` rows: a
 *     `generate_cv` / `generate_cover_letter` item is chained to its
 *     review by the processor (aiQueue.ts), so gating that chain belongs
 *     where the chain is created, not here.
 */
export interface AutoQueueFlags {
  auto_queue_fit: boolean
  auto_queue_cv: boolean
  auto_queue_cover_letter: boolean
  auto_queue_verify_cv: boolean
  auto_queue_verify_cover_letter: boolean
}

export function autoQueueFlags(settings: Settings = getSettings()): AutoQueueFlags {
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
 * Schedule the next document-backlog sweep. Mirrors
 * `scheduleNextFitAutoScore`: a one-shot `setTimeout` that re-arms itself
 * after each run rather than a `setInterval` (which would start a second
 * pass on top of a slow first one), the interval read from settings, and
 * "each call replaces the previous schedule" so a settings change or a
 * completed scan pushes the next run out by a full interval.
 */
export function scheduleNextDocsAutoQueue(): void {
  clearTimer()
  const settings = getSettings()
  const minutes = Math.max(1, settings.fit_autoscore_interval_minutes ?? DEFAULT_INTERVAL_MINUTES)
  const ms = minutes * 60 * 1000
  timer = setTimeout(runDocsAutoQueue, ms)
  timerStartedAt = Date.now()
  timerDelayMs = ms
}

export function cancelDocsAutoQueue(): void {
  clearTimer()
}

export function restartDocsAutoQueueTimer(): void {
  scheduleNextDocsAutoQueue()
}

export function getDocsAutoQueueState(): { intervalMinutes: number; nextRunAt: number | null } {
  const settings = getSettings()
  return {
    intervalMinutes: settings.fit_autoscore_interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
    nextRunAt: timer ? timerDeadlineMs(timerStartedAt, timerDelayMs) : null
  }
}

/**
 * Whether a job is still missing a GENERATED document of this type.
 *
 * "Generated" is `!is_base`, and the filter is the whole point.
 * `listDocuments(jobId)` deliberately unions in the user's master CV (the
 * base row, `is_base = 1`) so the Documents / JobDetail views can show it
 * beside every job — which means a bare `some(d => d.type === 'cv')`
 * reports a CV for EVERY job in the store and this sweep would enqueue
 * nothing, ever, for exactly the users it exists to serve. The user's
 * requirement is explicit: a document that is only the base CV the user
 * supplied is not a generated CV and must never satisfy this check. The
 * cover letter is the same case.
 *
 * (`is_base` is 0 on every generated row: `writeDocuments` in
 * database.ts stamps both tailored docs with `is_base: 0`, and
 * `createDocument`'s `isBase` argument is only ever passed false — see the
 * commit body for the full reading of the column.)
 */
function needsDoc(docs: Document[], type: Document['type']): boolean {
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
 * sweep is supposed to queue — which is reachable whenever the user
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

interface DocUnit {
  docType: Document['type']
  queueType: Extract<AIQueueItem['type'], 'generate_cv' | 'generate_cover_letter'>
  enabled: boolean
}

function docUnits(flags: AutoQueueFlags): DocUnit[] {
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
 * 'skip'          — nothing to do, or a refusal (below).
 * 'add'           — no row for this work at all.
 * { revive: row } — an exhausted row that may be resurrected in place.
 */
type UnitPlan = 'skip' | 'add' | { revive: AIQueueItem }

/**
 * Decide what, if anything, to do about one document unit of one job.
 *
 * Every `skip` is a refusal and says why on its branch. The revival branch
 * is the PROCESSOR's revival, written the same way `runFitAutoScoreBacklog`
 * writes it: one unit of the revive budget and parked on the shared
 * cooldown. Honouring both is what keeps this sweep from becoming a second,
 * unlimited retry lane — the defect the score_fit path used to have.
 */
function planUnit(jobId: number, docs: Document[], queue: AIQueueItem[], now: number, unit: DocUnit): UnitPlan {
  if (!needsDoc(docs, unit.docType)) return 'skip'

  // The in-flight half of this decision is NOT here: it is
  // `jobDocWorkInFlight`, called by both callers before they get here,
  // and it sees both this unit's own rows and a `tailor_job_docs` row,
  // which produces both documents. A duplicate pair is handled there for
  // the same reason runFitAutoScoreBacklog does it — every live row is
  // judged, not just the first — so nothing is resurrected alongside a
  // live one.
  const matches = sameWorkRows(queue, jobId, unit.queueType)
  const existing = matches[0]
  if (existing && existing.status === 'failed') {
    if ((existing.autoRevives ?? 0) >= AUTO_REVIVE_MAX) return 'skip'
    // Its cooldown has not elapsed. Same guard runPass applies to every
    // row, which is why a row parked on a cooldown is never pulled
    // forward here.
    if (existing.nextRetryAt > now) return 'skip'
    return { revive: existing }
  }

  return 'add'
}

/**
 * Re-enqueue generation for every document unit a job is still missing.
 *
 * The unit-for-unit mirror of `runFitAutoScoreBacklog`: no generated doc
 * means the work exists; anything already in flight is left alone; an
 * exhausted row is revived the way the processor would rather than having
 * a second row added beside it. Returns the number of queue rows created
 * or revived.
 *
 * `isScoreFitSuppressed` is honoured, exactly as both fit re-seeders
 * honour it: the sweep walks the JOBS and DOCUMENTS tables rather than the
 * queue, so without it every job the user cancelled with "Clear queue"
 * would be re-seeded on the next tick and the confirm dialog's promise
 * would be false. What the sweep restores is work lost to a crash, an
 * exhausted item, or a fit that never landed — not work the user
 * deliberately threw away.
 *
 * The cost ceiling is the other half of not being an unlimited retry lane,
 * and it is why this function and `enqueueDocsBacklog` share
 * `autoDocQueueEligible` and `planUnit` rather than each carrying their own
 * copy. A sweep that queues work no automatic path would otherwise have
 * queued is not a more convenient sweep; it is a queue that fills on every
 * launch with generations that cannot succeed.
 */
export function runDocsAutoQueueBacklog(): number {
  const flags = autoQueueFlags()
  const queue = getAIQueue()
  const now = Date.now()
  const units = docUnits(flags)
  const settings = getSettings()
  let enqueued = 0

  for (const job of listJobs()) {
    if (isScoreFitSuppressed(job.id)) continue
    const docs = listDocuments(job.id)
    // The gate the fit-landing trigger applies, applied here too, plus the
    // base-CV requirement only the sweep can reach. Without the gate this
    // sweep is not "a bit more permissive than the trigger" — it is the
    // trigger's job list multiplied by the size of the store, re-run on
    // startup, after every scan, and every hour.
    if (!autoDocQueueEligible(job, settings, docs, { requireConfiguredBaseCv: true })) continue

    for (const unit of units) {
      if (!unit.enabled) continue
      // "Is this unit already covered or in flight, by ANY producer?" —
      // `jobDocWorkInFlight`, the predicate the fit-landing trigger asks
      // too. It used to be answered per direction, which is how one job
      // reached three queue rows and three CVs plus three cover letters;
      // see electron/docAutoQueue.ts.
      //
      // Asked per unit rather than once per job, and that granularity is
      // load-bearing: `tailor_job_docs` produces BOTH documents so a live
      // one blocks both units, while a live `generate_cv` row covers the
      // CV only — skipping the whole job there would leave a job whose
      // CV is already queued with no cover letter and nothing queued to
      // produce one.
      if (jobDocWorkInFlight(queue, job.id, [unit.docType])) continue
      const plan = planUnit(job.id, docs, queue, now, unit)
      if (plan === 'skip') continue

      if (plan === 'add') {
        addAIQueueItem({ type: unit.queueType, jobId: job.id })
      } else {
        updateAIQueueItem(plan.revive.id, {
          status: 'pending',
          attempts: 0,
          autoRevives: (plan.revive.autoRevives ?? 0) + 1,
          nextRetryAt: now + AUTO_REVIVE_COOLDOWN_MS,
          lastError: undefined
        })
      }
      enqueued++
    }
  }

  return enqueued
}

/**
 * Queue generation for every missing document unit, on startup and after
 * every scan.
 *
 * The counterpart of `runDocsAutoQueueBacklog`, and deliberately identical
 * to it in every respect that decides COST: same suppression rule, same
 * eligibility gate, same live-tailor skip, and — the part that was wrong
 * when this was `enqueue()` on both branches — the same bounded revival.
 *
 * It previously delegated the whole decision to the shared `enqueue()`,
 * which revives a `failed` row via `revivePatch()`: `attempts: 0`,
 * `nextRetryAt: Date.now()`, `autoRevives` untouched. That is the right
 * write for a person pressing Retry, and the wrong one for a sweep:
 *
 *   - it charges no revive budget, so the budget that bounds every other
 *     queue path did not bound this one;
 *   - it clears `nextRetryAt`, so a row the periodic sweep had parked on
 *     the 4h revive cooldown was dragged back to due-now by the next
 *     startup or scan, i.e. the hourly cadence I had just introduced
 *     became an hourly retry of doomed rows.
 *
 * So every startup and every scan resurrected the row, the LLM call failed,
 * the processor's catch spent another attempt budget, and the row went
 * back to failed — forever, with `autoRevives` frozen at whatever it was.
 * One wasted tailoring call per launch or scan per row, with no bound.
 *
 * `enqueue()` is still used for the `add` case, because there its dedupe
 * guard is exactly the right rule; the revive case goes through
 * `updateAIQueueItem` with the budget and cooldown applied, which is the
 * processor's own revival and the same one the periodic sweep performs.
 */
export function enqueueDocsBacklog(): number {
  const units = docUnits(autoQueueFlags())
  const queue = getAIQueue()
  const now = Date.now()
  const settings = getSettings()
  let enqueued = 0

  for (const job of listJobs()) {
    if (isScoreFitSuppressed(job.id)) continue
    const docs = listDocuments(job.id)
    // The same gate the fit-landing trigger uses, plus the base-CV
    // requirement only the sweep can reach. This path runs at startup and
    // after every scan, so an ungated job in the store is four hundred
    // LLM calls waiting to happen on the next launch.
    if (!autoDocQueueEligible(job, settings, docs, { requireConfiguredBaseCv: true })) continue

    for (const unit of units) {
      if (!unit.enabled) continue
      // The same shared predicate as in `runDocsAutoQueueBacklog`, and
      // for the same reason: this path and the fit-landing trigger are two
      // producers of one job's documents and must not both queue.
      if (jobDocWorkInFlight(queue, job.id, [unit.docType])) continue
      const plan = planUnit(job.id, docs, queue, now, unit)
      if (plan === 'skip') continue

      if (plan === 'add') {
        // `enqueue` rather than `addAIQueueItem`: it is the dedupe-aware
        // writer, so a row that appeared since the snapshot (or one
        // `planUnit` deliberately did not match, such as an
        // auto-regeneration carrying a documentId) cannot be duplicated.
        // A revive it performs instead is charged to the budget and put
        // on the cooldown by `planUnit` above, never by enqueue's
        // `revivePatch`, which would pull the row forward to now and
        // leave `autoRevives` untouched — the unbounded-requeue bug this
        // path used to have.
        if (enqueue({ type: unit.queueType, jobId: job.id })) enqueued++
        continue
      }

      // `planUnit` returned a row to revive. It has already checked the
      // budget and the cooldown, and it is the same revive the processor
      // performs, so both docs paths now share one bounded revival.
      updateAIQueueItem(plan.revive.id, {
        status: 'pending',
        attempts: 0,
        autoRevives: (plan.revive.autoRevives ?? 0) + 1,
        nextRetryAt: now + AUTO_REVIVE_COOLDOWN_MS,
        lastError: undefined
      })
      enqueued++
    }
  }

  return enqueued
}

async function runDocsAutoQueue() {
  if (running) return
  running = true
  try {
    runDocsAutoQueueBacklog()
  } catch (err) {
    // Swallow and reschedule, exactly as runFitAutoScore does: this is
    // background maintenance and must not crash the timer loop.
    const msg = err instanceof Error ? err.message : String(err)
    log.error('docsAutoQueue run failed:', msg)
  } finally {
    running = false
    scheduleNextDocsAutoQueue()
  }
}
