import { getAIQueue } from './database'
import { providerAvailability } from './ai'
import { addNotification } from './notifications'
import { notifyStoreChanged } from './notifyStoreChanged'
import { log } from './logger'
import type { AIQueueItem } from './types'

/**
 * WHEN A QUEUE REFUSAL BECOMES A NOTIFICATION.
 *
 * THE RULE, in one sentence: **a refusal the queue resolves by itself is not
 * a thing that happened to the user's work; a refusal that has outlasted the
 * queue's own longest re-check is.**
 *
 * Both halves are load-bearing, and the first is the one that keeps this from
 * becoming the flood the record layer was just rebuilt to stop.
 *
 * A per-attempt refusal is the queue doing its job. It re-checks, it spends
 * nothing, and it succeeds when the provider answers — 6,621 cooldown parks
 * in a measured window, nearly all of which were a row waiting its turn on a
 * provider's own clock, and every one of them resolved without the user
 * doing anything. Write those and the centre becomes a log with a bell on it:
 * a badge reading ×200 for work that is merely queued is worse than silence,
 * because it teaches the user the centre is noise.
 *
 * The second half is the fact worth a row. Measured on 2026-10-05: 8,061
 * row-level refusals across 36 passes against 241 queue items over 6h44m,
 * 211 of them still cycling at the close, producing 1,440 ERROR log lines
 * and — because `aiQueue.ts` never called `addNotification` — zero rows, zero
 * badge, zero toast. The user learned all of it by opening the Queue tab of
 * the drawer, which is a place, not a surface. A parked-forever row is a fact
 * about their work: a document that was not written, for a reason that will
 * not clear on its own. That belongs where the badge already is.
 *
 * WHY THE THRESHOLD IS THE QUEUE'S OWN CONSTANT. `stallAfterMs` is
 * `PROVIDER_REPROBE_CAP_MS`, the ceiling of the re-probe ladder in
 * `parkBlockedRow`, passed in by `aiQueue.ts` rather than imported back out
 * of it. Up to it, waiting means the app is re-checking on an accelerating
 * schedule and the situation is expected to resolve. Past it, the ladder has
 * stopped accelerating — the row is being re-checked at the ceiling and
 * nothing about it is improving — so continuing to wait silently is the
 * defect rather than the patience. The number is not invented here; it is
 * the point at which the queue's own behaviour changes character.
 *
 * WHY ONCE PER STALL, NOT ONCE PER PASS. A pass is an implementation
 * detail; the user cannot act on "pass 31 of 36". The thing that happened is
 * one thing — the queue stopped — and it either is still happening or it is
 * not, so the centre holds one row for it, which stays on the badge for as
 * long as it is true. Recording per pass would turn the 8,061 refusals into
 * 36 rows and then into 36 more on the next bad afternoon.
 *
 * AND WHY "NOTHING IS PARKED" IS NOT RECOVERY. `runPass` alternates. While
 * every model is cooling it parks the due rows and claims nothing; the moment
 * a cooldown lapses it claims one, the provider 429s it again, and the next
 * pass is back to parking. So on alternate passes of a live outage there is
 * nothing parked to see, and over an afternoon the stretches between parks
 * are longer than the ceiling itself — the claimed row spends them in an
 * ordinary failure backoff. A stall clock that reset on the first of those
 * would restart on every second pass and never reach any threshold at all,
 * which is the whole hole again, one level down.
 *
 * So recovery is not "no row is parked". It is the queue having a provider
 * it could use AND nothing held: `providerAvailability` is the same query
 * `runPass` decides whether to park at all, and after a claimed row has been
 * 429'd again it answers blocked, so an outage's quiet passes keep the stall
 * alive while a genuinely recovered queue — rows claimed, calls answered, no
 * cooldown written — ends it.
 *
 * IN-PROCESS ON PURPOSE, like `modelHealth`: a restart is entitled to lose
 * this. The cost of losing it is that a stall which begins during the restart
 * is surfaced once the queue has been stuck for the threshold rather than
 * immediately, and `startup.log` already reports the queue's own state at
 * boot, so nothing is lost — only delayed by the same ten minutes the ladder
 * would have taken anyway.
 */
let stalledSince = 0
let reportedForStall = false

/**
 * The rows a provider, rather than the user's own turn, is holding.
 *
 * Read straight off the two fields the park writes and the claim clears:
 * `parkedReason` for a spend cap and `blockedSince` for a cooldown. Both are
 * set when the app parks a row and removed in the same write that claims it,
 * so membership here means "the app has tried and the provider stopped it" —
 * and nothing about the row's own backoff, which is what distinguishes a row
 * that is genuinely waiting its turn. `nextRetryAt` is deliberately not
 * consulted: a cap park pushes it up to a full window out, and a row waiting
 * a day for a budget is the most stuck row in the queue, not the least.
 */
function providerBlockedRows(): AIQueueItem[] {
  return getAIQueue().filter(
    (q) =>
      q.status === 'pending' && (q.blockedSince !== undefined || q.parkedReason === 'provider_cap')
  )
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000))
}

function distinctErrors(rows: AIQueueItem[], limit: number): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    const text = (r.lastError ?? '').trim()
    if (!text) continue
    seen.add(text.length > 240 ? `${text.slice(0, 240)}…` : text)
    if (seen.size >= limit) break
  }
  return [...seen]
}

/**
 * Note the outcome of a queue pass. Never throws, never toasts, and is a
 * total function of the store's current contents.
 */
export function reportStalledQueue(now: number, stallAfterMs: number): void {
  try {
    const blocked = providerBlockedRows()

    // Recovery, on both halves: a provider the rotation could use, and
    // nothing held. See the note on the state above for why the first half
    // is the one doing the work.
    if (blocked.length === 0 && !providerAvailability(now).blocked) {
      stalledSince = 0
      reportedForStall = false
      return
    }
    if (stalledSince === 0) stalledSince = now
    // Strictly past the ceiling: at exactly the ceiling the app has only
    // just stopped trying harder, which is the patience, not the defect.
    if (reportedForStall || now - stalledSince <= stallAfterMs) return
    reportedForStall = true

    const capped = blocked.filter((q) => q.parkedReason === 'provider_cap')
    const cooling = blocked.filter((q) => q.parkedReason !== 'provider_cap')
    const waitedMs = now - stalledSince

    // One sentence a user can act on, with no provider name in it: the group
    // key below already fixes which rows collapse together, and the details
    // belong in the expanded record where there is room for them.
    const headline =
      capped.length >= cooling.length
        ? `Your queued AI work is not running — ${capped.length} task(s) are waiting on an AI provider's daily call cap.`
        : `Your queued AI work is not running — ${cooling.length} task(s) are waiting for an AI provider to become available.`

    const detail = [
      `${blocked.length} of your queued tasks have been unable to run for ${minutes(waitedMs)} minutes.`,
      '',
      // Scoped to what the parks themselves guarantee, because the queue
      // does NOT guarantee it for the whole stall: a lapsing cooldown lets a
      // pass claim a row and the provider refuse it, so requests can and do
      // happen while this is true. What parking always guarantees is that
      // the row spent no attempt, was charged no revival, and was not marked
      // failed — which is the part the user needs, since it is the
      // difference between work waiting and work being thrown away.
      'Waiting on a provider costs a task no attempt and no revival, and none of them has been marked failed — this work is still queued and will run as soon as a provider can answer. It is not a retry countdown.',
      '',
      `Waiting on the daily call cap (${capped.length}):`,
      ...distinctErrors(capped, 3).map((t) => `  · ${t}`),
      '',
      `Waiting for a provider to finish cooling down (${cooling.length}):`,
      ...distinctErrors(cooling, 3).map((t) => `  · ${t}`)
    ].join('\n')

    addNotification({
      type: 'error',
      source: 'ai',
      message: headline,
      full_message: detail,
      // Explicit, and `type|source|…`-shaped like the crash handler's, because
      // the derived key is built from the message and every message here
      // carries a different count and so would give every stall its own
      // group. Two differently-worded records that are one thing, which is
      // what the override exists for.
      //
      // It names the queue, so it cannot collapse into a document failure that
      // happens to read alike, and it carries no severity — `coerceType` and
      // `notificationDedupeKey` take the type and source off the ROW, so a
      // caller's key still cannot decide what a record is (that is 660e4f4
      // and it is why writing this is safe).
      group_key: `error|ai|queued AI work is not running`
    })
    notifyStoreChanged()
  } catch (err) {
    // A store that cannot be written must not stop the queue from running the
    // work the record was about. The rows are still parked and still logged.
    log.ai.warn(`could not record the stalled queue in the notification centre: ${String(err)}`)
  }
}

/** Tests only: forget the current stall, as a fresh process would. */
export function resetQueueStall(): void {
  stalledSince = 0
  reportedForStall = false
}