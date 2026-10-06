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
 *
 * AND EVERY FIELD IS A MEASUREMENT TAKEN AT A MOMENT. The ledger is spent by
 * the background queue continuously, so a row is true when it was read and
 * nothing after that, and this module now says which moment that was
 * (`providerSpendAsOf`) alongside how often the caller re-reads to make the
 * answer recent (`PROVIDER_SPEND_POLL_MS`). A number with neither a cadence
 * nor a timestamp is a claim about the present made by a snapshot, and that
 * claim is what this page was originally shipped doing.
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

/**
 * How often the page that shows these rows re-reads the ledger.
 *
 * Ten seconds, because that is the cadence the Queue panel already uses
 * (`QUEUE_POLL_MS` in NotificationDrawer.tsx) and for the same reason: both
 * surfaces exist so a person can watch what the background queue is doing to
 * the budget, and a person watching a ledger that only moves when they
 * re-click something is watching a snapshot and calling it a live number. The
 * two numbers are kept as separate constants rather than one shared import
 * because a page must not be able to change the Queue panel's cadence, but
 * they are deliberately the same value — a marker promising less freshness
 * than the poll actually delivers would be its own small lie.
 *
 * This is a PRESENTATION cadence. Nothing is enforced off it: `providerBudget`
 * is called at the point of refusal, so the cap holds whatever this number
 * says, and a poll that runs late leaves the screen behind the ledger, never
 * the ledger behind the cap.
 */
export const PROVIDER_SPEND_POLL_MS = 10_000

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
//
// Two clauses ARE added here, and neither is a rewording of the cap message:
//
//   * the as-of marker, which describes the READ rather than the budget and so
//     has no counterpart in `describeProviderCap` at all — that sentence is
//     built from a budget and rendered the instant it is taken, so it has
//     never had a staleness problem to describe;
//   * the capped line below, which is `describeProviderCap`'s own "automated
//     work is paused" reduced to a per-row conditional: it appears for a
//     provider that IS at its cap and for no other, where the cap message
//     says that clause to everyone who sees it. A page that renders 3-of-50
//     and 629-of-50 in identical grey is not lying, but once the rows tick
//     the absence stops reading as restraint and starts reading as an
//     oversight.
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
 *     re-read from the ledger every time the tab is opened and every
 *     `PROVIDER_SPEND_POLL_MS` after that rather than persisted, but the
 *     queue row's identical sentence IS persisted and re-rendered on every
 *     poll, and the two are the same words on purpose: a relative word rots
 *     the moment the copy outlives its moment.
 *   * the YEAR is named whenever it is not the reader's own, because "7 Oct"
 *     is ambiguous across a year boundary and this is the one function whose
 *     whole job is not being ambiguous.
 *
 * `now` is a parameter and is never read here, so one clock reading decides
 * both "is this moment still ahead of us" and "which day is it on" and the
 * two cannot disagree.
 *
 * `alwaysNameDay` exists for the AS-OF marker, which describes a moment that
 * has already passed and so gets none of the benefit of the rule above: the
 * "minutes away, so the day does not matter" exemption exists because a
 * moment about to happen cannot be out of date, and every moment this marker
 * names IS out of date by definition — a read from three hours ago is three
 * hours past whether or not the day is on it. So the marker always names the
 * day, and gets the year rule for free because it runs through here rather
 * than through a second copy of the formatting.
 */
function clockTime(at: number, now: number, alwaysNameDay = false): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((startOfLocalDay(at) - startOfLocalDay(now)) / SPEND_WINDOW_MS)
  if (!alwaysNameDay && days <= 0 && at - now < HOUR) {
    // Only a time minutes away is unambiguous without naming the day: it is
    // about to happen either way, so the words cannot be out of date.
    return time
  }
  const date = when.toLocaleDateString([], { day: 'numeric', month: 'short' })
  const year = when.getFullYear() === new Date(now).getFullYear() ? '' : ` ${when.getFullYear()}`
  return `${time} on ${date}${year}`
}

/**
 * HOW LONG AGO THESE NUMBERS WERE TRUE.
 *
 * The cap input above this section is the number the user SET; the rows under
 * it are the number the app SPENT, and the ledger they come from is being
 * spent by the background queue the whole time this tab is open. So every one
 * of those rows is a measurement taken at a moment, and the page used to keep
 * showing one with nothing on it saying when — "4 calls in the last 24h
 * against a cap of 50" stayed on screen through a sweep that took the ledger
 * to 200, reading exactly like a fresh number. Across the 24h boundary the
 * same copy stops being merely out of date and starts being wrong: a row read
 * at 23:50 naming a budget that frees at 01:20 is still on screen at 01:30,
 * describing a provider that has room again and refusing nothing.
 *
 * The value is the instant of the last SUCCESSFUL read and nothing else. Not
 * the render, not the start of the poll, not an approximation of either: a
 * timestamp invented at render time would be the same defect in a new place —
 * a fresh-looking time attached to a number that is not fresh. So the caller
 * hands in the moment the read that produced these rows was issued, and this
 * only formats it. When no read has succeeded there is no marker at all,
 * because "as of" nothing is not a freshness claim, it is a missing one.
 *
 * `now` is used for the YEAR comparison and nothing else — never for the
 * value, and never to decide whether the marker is out of date, because a
 * marker that hides its own age is the thing this exists to prevent. It is a
 * parameter for the same reason `clockTime` takes one: a panel left open
 * across midnight on 31 December has to be able to say "as of 23:04 on 31 Dec
 * 2026" rather than "as of 23:04 on 31 Dec".
 */
export function providerSpendAsOf(readAt: number, now: number): string {
  return `As of ${clockTime(readAt, now, true)}.`
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
 * Four branches, and the last two are the ones that matter most:
 *
 *   * `clockSkewed` means the cap is not being applied to this provider at
 *     all (`providerOverCap` returns null for a ledger the clock has broken),
 *     so there is no wait being served and no moment that means anything. The
 *     `freeAt` on such a row is arithmetic over stamps the app has just said
 *     it cannot trust — a stamp dated 30 days in the future makes the "wait"
 *     land in the past, which is a broken clock and not a rolling window. So
 *     a skewed row names no time either way, and says why.
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
 * queue parking and re-parking a row; this page re-reads the ledger every
 * `PROVIDER_SPEND_POLL_MS` instead, and naming the queue's cadence would be
 * naming a promise this screen does not make.
 */
export function providerSpendFreeLine(row: ProviderSpend, now: number): string {
  if (row.clockSkewed) return 'This budget is not being applied, so there is no wait to describe.'
  if (row.freeAt === null) return 'Budget is available now.'
  if (row.freeAt <= now) return 'The window is still rolling, so the exact wait is not known yet.'
  return `Budget frees at ${clockTime(row.freeAt, now)}.`
}

/**
 * THE CAPPED LINE — the one thing this page says that the queue's cap message
 * says to everyone.
 *
 * `describeProviderCap` opens with "X is at its call cap" and closes with
 * "Automated work is paused; Generate, Regenerate, Verify and Tailor still
 * run", because it is only ever rendered for a provider that IS capped. This
 * page renders a row for every provider the app has, so those two clauses
 * cannot be carried across unconditionally and are not: a row at 3 of 50
 * saying its provider "is at its call cap" would be a lie told to make the
 * other rows look consistent. So they come back as a conditional — shown for
 * a capped provider only — which is what a per-row surface owes the reader,
 * and what stops a live number from being readable only by doing arithmetic.
 *
 * The condition is the ledger's own, not a second copy of it: `freeAt` is
 * non-null exactly when the window has more than `cap` calls in it, which is
 * exactly when `providerOverCap` refuses (`windowFreesAt` is an identity, and
 * `providerOverCap` is `used >= cap`). So this line reads the same field the
 * free line above it reads, and the two cannot disagree with each other or
 * with the refusal the app is making in the background.
 *
 * `clockSkewed` is excluded, and not as a formality: on a skewed ledger
 * `providerOverCap` returns null and the app is refusing nothing, so saying
 * the app has stopped calling this provider would be a claim about a
 * mechanism that is switched off. `now` is the same clock reading the free
 * line is judged against, so a row whose wait has elapsed since the read
 * loses this line on the same render that stops it naming the moment — the
 * safe direction, since the line claims something that is true now.
 */
export function providerSpendCappedLine(): string {
  return 'This provider is at its cap, so the app is not calling it on its own until then. Anything you ask for directly still runs.'
}

/**
 * The line for a ledger this app cannot trust — and it is shown ALONGSIDE the
 * count rather than instead of it, and ABOVE it rather than below.
 *
 * A stamp dated more than a whole window ahead of now means the machine's
 * clock was wrong when it was written, which makes every other stamp in that
 * bucket suspect; the cap is not applied to such a provider at all, because a
 * bound that cannot be evaluated must not be enforced (see
 * `ProviderBudget.clockSkewed`). Dropping the count here would hide the
 * anomaly rather than fix it, and `used` is still what was recorded.
 *
 * First, though, because the other two lines on this row describe a bound
 * this provider is not being held to: the count line still names a cap, and
 * the free line still describes a wait, and on a skewed ledger a reader who
 * took those two lines and nothing else would conclude the app is enforcing a
 * budget against these numbers. It is not. The correction was last on this row
 * and that was survivable while a row was read once and left alone; it is not
 * survivable on a row that re-asserts itself every ten seconds, so it now
 * leads.
 */
export function providerSpendSkewLine(): string {
  return 'Your computer\'s clock was wrong when some of these calls were recorded, so this count is not reliable and the budget is not being applied here.'
}

/**
 * ONE ROW'S SENTENCES, EACH WITH A NAME.
 *
 * `id` is not for the reader — it is how the page keys and labels each line,
 * so the order lives here and nowhere else. The page maps this list straight
 * to the DOM; it does not decide which lines a row has or what order they go
 * in, because a page that re-derived that order would be a second place for
 * the skew correction to be left out of.
 */
export interface ProviderSpendLine {
  id: 'skew' | 'count' | 'capped' | 'free'
  text: string
}

/**
 * Everything one provider's row says, in the order it is said.
 *
 * The count first for a sound ledger, because it is the number the whole page
 * is for: the cap input is directly above it and the input alone said 50
 * where the ledger said 629. The capped line sits between the count and the
 * free time, so "this one is at its limit" is read before the moment that
 * limit lifts, and the skew line leads the lot when the ledger cannot be
 * believed at all.
 *
 * So there are four shapes, and none of them is a default: sound and under
 * cap is two lines, sound and at cap is three, skewed is three with a
 * different first one and no moment named, and a read that failed is none of
 * them because the page renders no row at all for it.
 */
export function providerSpendLines(row: ProviderSpend, now: number): ProviderSpendLine[] {
  const lines: ProviderSpendLine[] = []
  if (row.clockSkewed) lines.push({ id: 'skew', text: providerSpendSkewLine() })
  lines.push({ id: 'count', text: providerSpendCountLine(row) })
  if (!row.clockSkewed && row.freeAt !== null && row.freeAt > now) {
    lines.push({ id: 'capped', text: providerSpendCappedLine() })
  }
  lines.push({ id: 'free', text: providerSpendFreeLine(row, now) })
  return lines
}
