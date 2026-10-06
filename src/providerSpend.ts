/**
 * ONE AI PROVIDER'S SPEND, AS THE RENDERER IS ALLOWED TO SEE IT.
 *
 * The renderer cannot reach `ProviderBudget` (electron/ai.ts): the numbers
 * live in the main process behind a persisted ledger, and the renderer gets
 * them over IPC like every other piece of app state. This is that shape — the
 * contract for `ai:providerSpend` — and it is deliberately NOT
 * `ProviderBudget`:
 *
 *   * no `key`. That is the bucket identity, `endpoint#credential hash`, and
 *     the app's rule is that ids and credentials stay in the main process.
 *     The row is identified by its `label`, which `providerBudget` documents
 *     as "Host, for logs and the cap message. Never a path, a key or an id".
 *   * no `ProviderBudget` import, so the two sides cannot drift: the handler's
 *     return type and the renderer's are the same declaration. (This is the
 *     opposite of `src/queueBlocked.ts`, which mirrors a main-process type
 *     because the two halves of that shape were written separately; here the
 *     renderer half is the only place a renderer can legally import from, and
 *     main-process modules may import from `src/` — main.ts already does.)
 *
 * Every field is a real value read from the real ledger. Nothing here is
 * derived, rounded, defaulted or carried over: if the ledger cannot be read,
 * the answer is an error at the call site, never a zero standing in for one.
 */
export interface ProviderSpend {
  /** Host of the provider, or `<unclassifiable base URL>`. Never a path. */
  label: string
  /** Total real calls inside the rolling 24h window, automated and manual. */
  used: number
  /** Of those, the ones the app issued on its own. */
  automated: number
  /** Of those, the ones a person asked for. */
  manual: number
  /** The cap this provider is measured against, as the app enforces it. */
  cap: number
  /**
   * Epoch ms this provider's budget frees — the instant `used` drops BELOW
   * `cap`. Null while there is still room, which is not the same as "in the
   * past": it means there is no wait to describe.
   */
  freeAt: number | null
  /**
   * A recorded call is dated more than a whole window ahead of now, so every
   * timestamp in this ledger is suspect and the cap is not being applied to
   * this provider at all. The spend is still reported, because deleting it
   * would hide the anomaly rather than fix it — but it cannot be presented as
   * a number to act on.
   */
  clockSkewed: boolean
}

// ---------------------------------------------------------------------------
// THE WORDS
//
// These are not a second way of saying what `describeProviderCap` (ai.ts)
// says. They are the same sentences, with the two clauses that are only TRUE
// of a capped provider left out — "X is at its call cap" and "Automated work
// is paused" — because this page renders a row whether or not the provider is
// capped, and a page that told a user with 12 calls out of 50 that their
// provider "is at its call cap" would be the same defect in new words.
//
// The wording that survives is deliberately character-for-character
// `describeProviderCap`'s, because a user who reads the cap message on a
// parked queue row and then opens Settings must not find two different
// sentences about the same two numbers. `electron/providerSpend.test.ts`
// asserts that identity against the real function, so the two cannot drift.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
/**
 * The spend window, in ms — the same 24 hours as `PROVIDER_SPEND_WINDOW_MS`
 * in electron/database.ts, and duplicated here because this is the renderer
 * and cannot import a main-process constant.
 *
 * It is used only to turn a difference of two local midnights into a count of
 * days, which is why the duplication is tolerable: it is a calendar step, not
 * the window the ledger keeps. If the window ever stopped being exactly a
 * day this would need to move with it — and the drift test in
 * `electron/providerSpend.test.ts` is what would say so.
 */
const SPEND_WINDOW_MS = 24 * HOUR

function startOfLocalDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * A wall-clock time a reader cannot misplace in time — `clockTime` from
 * electron/ai.ts, reproduced here rather than imported because that function
 * is not exported and ai.ts is not this lane's to change.
 *
 * Same three rules, for the same reason each of them exists there:
 *
 *   * the DAY is always named, because a cap frees on a rolling 24h window
 *     and so the moment it frees is routinely tomorrow's. A bare "02:04
 *     a.m." cannot say which day, and the only 02:04 a reader has on the day
 *     they read it is one that has already gone by — measured on 2026-10-05,
 *     the app said "Budget frees at 02:04 a.m." 2,315 times against a ledger
 *     holding 629 requests, and the moment it named was 3.4 to 9.7 hours in
 *     the PAST every single time.
 *   * the calendar DATE is named, never "today" / "tomorrow". This copy is
 *     re-read from the ledger every time the tab is opened rather than
 *     persisted, but the queue row's identical sentence IS persisted and
 *     re-rendered on every poll, and the two are the same words on purpose:
 *     a relative word rots the moment the copy outlives its moment.
 *   * the YEAR is named whenever it is not the reader's own, because "7 Oct"
 *     is ambiguous across a year boundary and this is the one function whose
 *     whole job is not being ambiguous.
 *
 * `now` is a parameter and is never read here, so one clock reading decides
 * both "is this moment still ahead of us" and "which day is it on" and the
 * two cannot disagree.
 */
function clockTime(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((startOfLocalDay(at) - startOfLocalDay(now)) / SPEND_WINDOW_MS)
  if (days <= 0 && at - now < HOUR) {
    // Only a time minutes away is unambiguous without naming the day: it is
    // about to happen either way, so the words cannot be out of date.
    return time
  }
  const date = when.toLocaleDateString([], { day: 'numeric', month: 'short' })
  const year = when.getFullYear() === new Date(now).getFullYear() ? '' : ` ${when.getFullYear()}`
  return `${time} on ${date}${year}`
}

/**
 * How much this provider has spent, against the cap.
 *
 * The total is the thing that meets the cap and the split hangs off it as a
 * parenthetical, because the split is the part worth keeping legible: it is
 * what tells a user whether the app or their own clicking did the spending.
 * (`describeProviderCap` learned this the hard way — see its comment on the
 * old "50 automated, 579 manual of 50" wording, which reads as 579 against a
 * cap of 50.)
 *
 * "calls" is plural for a count of one, on purpose: it is what the sentence
 * on a parked queue row says, and consistency with that is the point of this
 * module.
 */
export function providerSpendCountLine(row: ProviderSpend): string {
  const split = row.manual > 0
    ? `${row.automated} automated, ${row.manual} manual`
    : `${row.automated} automated`
  return `${row.used} calls in the last 24h against a cap of ${row.cap} (${split})`
}

/**
 * When the budget frees — or the honest reason there is no time to name.
 *
 * Three branches, and the third is the one that matters most:
 *
 *   * `freeAt === null` means the spend is under the cap, so there is no wait
 *     to describe: "available now", never a timestamp for a wait that does
 *     not exist.
 *   * `freeAt` ahead of `now` is the normal case and goes through
 *     `clockTime`, which cannot drop the day.
 *   * `freeAt` at or before `now` is a budget and a clock that disagree.
 *     `windowFreesAt` is an identity — a provider is over its cap exactly when
 *     `freeAt > now` — so a consistent ledger cannot reach this, but a row
 *     read at one moment and rendered at another can, and this page does read
 *     and render at different moments. The rule is the one that does not care
 *     how the state arose: never name a moment that has already gone by, so
 *     it names no time at all rather than repeating a stale one. This is the
 *     branch that shipped the defect, and the row above is the reason a page
 *     that shows a free time has to be held to it.
 *
 * The stale branch stops one clause short of `describeProviderCap`'s wording
 * ("… it is re-checked every pass"), because that cadence belongs to the
 * queue parking and re-parking a row; this page re-reads the ledger when it is
 * opened and when the cap is written, and promising a cadence here would be a
 * promise about nothing.
 */
export function providerSpendFreeLine(row: ProviderSpend, now: number): string {
  if (row.freeAt === null) return 'Budget is available now.'
  if (row.freeAt <= now) return 'The window is still rolling, so the exact wait is not known yet.'
  return `Budget frees at ${clockTime(row.freeAt, now)}.`
}

/**
 * The line for a ledger this app cannot trust — and it is shown ALONGSIDE the
 * count rather than instead of it.
 *
 * A stamp dated more than a whole window ahead of now means the machine's
 * clock was wrong when it was written, which makes every other stamp in that
 * bucket suspect; the cap is not applied to such a provider at all, because a
 * bound that cannot be evaluated must not be enforced (see
 * `ProviderBudget.clockSkewed`). Dropping the count here would hide the
 * anomaly rather than fix it, and `used` is still what was recorded.
 */
export function providerSpendSkewLine(): string {
  return 'Your computer\'s clock was wrong when some of these calls were recorded, so this count is not reliable and the budget is not being applied here.'
}

/**
 * Everything one provider's row says, in the order it is said.
 *
 * The count first, because it is the number the whole page is for: the cap
 * input is directly above it and the input alone said 50 where the ledger
 * said 629.
 */
export function providerSpendLines(row: ProviderSpend, now: number): string[] {
  const lines = [providerSpendCountLine(row), providerSpendFreeLine(row, now)]
  if (row.clockSkewed) lines.push(providerSpendSkewLine())
  return lines
}
