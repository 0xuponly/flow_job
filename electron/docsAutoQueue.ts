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
import {
  autoDocQueueEligible,
  autoQueueFlags as readAutoQueueFlags,
  docUnits,
  jobDocWorkInFlight,
  planDocUnit,
  revivePatchForAutomatic
} from './docAutoQueue'
import type { Settings } from './types'
import type { AutoQueueFlags } from './docAutoQueue'

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
 * The five auto-queue toggles, read from the store.
 *
 * A one-line wrapper over `docAutoQueue.autoQueueFlags`, which owns the
 * tolerant read itself because the fit-landing trigger reads them through
 * the same function. This stays so callers in this module (and its tests)
 * can ask for "the current flags" without threading a `Settings` through.
 */
export function autoQueueFlags(settings: Settings = getSettings()): AutoQueueFlags {
  return readAutoQueueFlags(settings)
}

export type { AutoQueueFlags } from './docAutoQueue'

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
 * Whether this job is still missing a GENERATED document of this type, and
 * whether a dead row for it may be resurrected.
 *
 * Both questions now live in `docAutoQueue` (`docTypeMissing` and
 * `planDocUnit`), because the fit-landing trigger asks exactly the same two
 * questions about the same two units. They were private here, which is how
 * the trigger ended up with a third opinion — `jobDocWorkInFlight` was
 * shared, but "which document is missing" and "may this row come back" were
 * not, and the trigger's answer to a job whose CV was mid-review was
 * "regenerate both documents".
 */

/**
 * 'skip'          — nothing to do, or a refusal (below).
 * 'add'           — no row for this work at all.
 * { revive: row } — an exhausted row that may be resurrected in place.
 */

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
      const plan = planDocUnit(job.id, docs, queue, now, unit)
      if (plan === 'skip') continue

      if (plan === 'add') {
        addAIQueueItem({ type: unit.queueType, jobId: job.id })
      } else {
        updateAIQueueItem(plan.revive.id, revivePatchForAutomatic(plan.revive, now))
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
      const plan = planDocUnit(job.id, docs, queue, now, unit)
      if (plan === 'skip') continue

      if (plan === 'add') {
        // `enqueue` rather than `addAIQueueItem`: it is the dedupe-aware
        // writer, so a row that appeared since the snapshot (or one
        // `planDocUnit` deliberately did not match, such as an
        // auto-regeneration carrying a documentId) cannot be duplicated.
        // A revive it performs instead is charged to the budget and put
        // on the cooldown by `planDocUnit` above, never by enqueue's
        // `revivePatch`, which would pull the row forward to now and
        // leave `autoRevives` untouched — the unbounded-requeue bug this
        // path used to have.
        if (enqueue({ type: unit.queueType, jobId: job.id })) enqueued++
        continue
      }

      // `planDocUnit` returned a row to revive. It has already checked the
      // budget and the cooldown, and it is the same revive the processor
      // performs, so both docs paths now share one bounded revival.
      updateAIQueueItem(plan.revive.id, revivePatchForAutomatic(plan.revive, now))
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
