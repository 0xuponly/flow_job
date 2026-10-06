/**
 * THE SENTENCES, AND THE ONE THING THEY MUST NEVER DO.
 *
 * This module's whole job is to say two numbers the user already has — what
 * the AI providers spent in the last 24 hours, and the cap those numbers are
 * measured against — plus when the budget frees. It is not a second opinion
 * about either number: it reads `ProviderSpend` and does arithmetic on
 * nothing.
 *
 * The trap these tests exist for is the one the app shipped. A cap frees on a
 * rolling 24h window, so the moment it frees is routinely tomorrow's, and it
 * was rendered as a bare "Budget frees at 02:04 a.m." — 2,315 times on
 * 2026-10-05 against a ledger holding 629 requests, when the moment it named
 * was 3.4 to 9.7 hours in the PAST every single time. A bare time of day
 * cannot say which day it is, and the only 02:04 a reader has on the day they
 * read it is one that has gone by.
 *
 * So the rules pinned here are: the day is named, the year is named when it is
 * not the reader's own, no relative words, and — the load-bearing one — a
 * moment at or before `now` is not named at all. `now` is a parameter
 * everywhere in this file, never read internally, so a test can hand in a
 * stale one and a stale one is exactly what the last test does.
 *
 * The second half of the file is the freshness contract: the as-of marker,
 * which describes WHEN a number was measured and must therefore name a day
 * even when the moment is minutes away, and the capped line, which is the one
 * clause `describeProviderCap` gets to say for free and a per-row surface has
 * to earn with a condition. Both are asserted on the condition rather than on
 * the presence, because both failure directions are lies: a capped provider
 * rendered like any other is a warning that never comes, and an uncapped one
 * told it is capped is the queue's own defect in new words.
 *
 * These are pure functions: no clock, no store, no DOM. The wording is
 * asserted for IDENTITY against `describeProviderCap` in
 * `electron/providerSpend.test.ts`, which imports the real ai.ts; pinning the
 * same strings here as well would only re-state them.
 */
import { describe, it, expect } from 'vitest'
import {
  providerSpendAsOf,
  providerSpendCappedLine,
  providerSpendCountLine,
  providerSpendFreeLine,
  providerSpendLines,
  providerSpendSkewLine,
  type ProviderSpend
} from './providerSpend'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A 2026-10-05 row at noon local, which is the day the measurements were on. */
function noonOnFifthOctober(): number {
  return new Date(2026, 9, 5, 12, 0, 0).getTime()
}

function row(over: Partial<ProviderSpend> = {}): ProviderSpend {
  return {
    label: 'openrouter.ai',
    used: 12,
    automated: 12,
    manual: 0,
    cap: 50,
    freeAt: null,
    clockSkewed: false,
    ...over
  }
}

describe('the count line pairs the spend with the cap it is measured against', () => {
  it('names the total, the window and the cap', () => {
    expect(providerSpendCountLine(row())).toBe('12 calls in the last 24h against a cap of 50 (12 automated)')
  })

  it('reports the measured ledger rather than the cap the user typed', () => {
    // The defect in one assertion: 629 requests against a cap of 50, and the
    // two numbers in the sentence are those, not the 50 twice.
    const said = providerSpendCountLine(row({ used: 629, automated: 50, manual: 579 }))
    expect(said).toContain('629')
    expect(said).toContain('cap of 50')
    // The split is a parenthetical, not the thing standing between the reader
    // and the cap: "50 automated, 579 manual of 50" was the wording that read
    // as 579 against a cap of 50.
    expect(said).toBe('629 calls in the last 24h against a cap of 50 (50 automated, 579 manual)')
  })

  it('keeps the manual and automated counts legible rather than summing them away', () => {
    // This split is the only thing that tells a user whether the app or their
    // own clicking spent the budget, which is the question a cap is asked
    // about. A bare "12 calls" cannot answer it.
    const said = providerSpendCountLine(row({ used: 12, automated: 3, manual: 9 }))
    expect(said).toContain('3 automated')
    expect(said).toContain('9 manual')
  })

  it('drops the manual half when there were no manual calls', () => {
    // "12 automated, 0 manual" is noise on a row where nothing was manual.
    expect(providerSpendCountLine(row())).not.toMatch(/manual/)
  })
})

describe('a free time is named only when there is one, and never in the past', () => {
  it('says the budget is available rather than naming a moment for a wait that does not exist', () => {
    // `freeAt === null` is not "unknown": `windowFreesAt` returns null exactly
    // while there is still room, so there is no wait to describe and no
    // timestamp to invent.
    const said = providerSpendFreeLine(row({ used: 49, freeAt: null }), noonOnFifthOctober())
    expect(said).toBe('Budget is available now.')
    expect(said).not.toMatch(/\d/)
  })

  it('names the day whenever the free time is not minutes away', () => {
    const now = noonOnFifthOctober()
    // Exactly at the cap with the first call at noon, so the budget frees a
    // window later — noon on the 6th, while the only noon the reader has on
    // the 5th is one that has gone by.
    const said = providerSpendFreeLine(row({ used: 50, freeAt: now + DAY }), now)
    expect(said).toMatch(/Budget frees at \d{1,2}[:.]\d{2}.* on /)
    expect(new Date(now + DAY).toLocaleDateString([], { day: 'numeric', month: 'short' })).toMatch(/6/)
    expect(said).toContain(new Date(now + DAY).toLocaleDateString([], { day: 'numeric', month: 'short' }))
  })

  it('never says today or tomorrow, because a copy outlives the moment it describes', () => {
    const now = new Date(2026, 9, 5, 0, 30, 0).getTime()
    const said = providerSpendFreeLine(row({ used: 50, freeAt: now + DAY }), now)
    // The queue row carrying the identical sentence persists it as `lastError`
    // and re-renders it on every poll, so a relative word read back tomorrow
    // is a moment 24 hours in the past with nothing in it to say so. An
    // explicit date that has gone by is plainly a date that has gone by.
    expect(said).not.toMatch(/\b(today|tomorrow|later|shortly)\b/i)
  })

  it('names the year when the moment falls in another one', () => {
    // "7 Oct" is ambiguous across a year boundary, and this is the one
    // function whose whole job is not being ambiguous. Late on 31 December,
    // with the window freeing three hours later, the moment is next year.
    const now = new Date(2026, 11, 31, 23, 0, 0).getTime()
    const said = providerSpendFreeLine(row({ used: 50, freeAt: now + 3 * HOUR }), now)
    expect(new Date(now + 3 * HOUR).getFullYear()).toBe(2027)
    expect(said).toContain('2027')
    expect(new Date(now + 3 * HOUR).getFullYear()).toBe(new Date(now).getFullYear() + 1)
  })

  it('leaves the date off a moment minutes away, which cannot be stale', () => {
    const now = noonOnFifthOctober()
    const said = providerSpendFreeLine(row({ used: 50, freeAt: now + 20 * 60_000 }), now)
    expect(said).toMatch(/Budget frees at \d/)
    expect(said).not.toMatch(/Budget frees at \d.* on /)
  })

  it('names no time at all when the moment has already gone by', () => {
    // The rule that does not care how the state arose. A consistent ledger
    // cannot produce this — `windowFreesAt` is an identity, a provider is
    // over its cap exactly when `freeAt > now` — but a row READ at one moment
    // and RENDERED at another can, and that is what happened: the queue read
    // each budget at the top of `callAI` and formatted it further down, so
    // the sentence could name an instant that had already passed. The answer
    // here is to name nothing rather than to repeat the stale time.
    const now = noonOnFifthOctober()
    const freeAt = now + 6 * HOUR
    const said = providerSpendFreeLine(row({ used: 629, freeAt }), freeAt)
    expect(said).not.toMatch(/Budget frees at/)
    expect(said).not.toMatch(/\d{1,2}[:.]\d{2}/)
    expect(said).toMatch(/not known yet/)
    // The spend is still reported by the other line: dropping the time is not
    // the same as dropping the fact.
    expect(providerSpendCountLine(row({ used: 629, automated: 50, manual: 579 }))).toMatch(/in the last 24h/)
  })

  it('takes the moment it is handed, not one it reads for itself', () => {
    // Two clocks is the original defect in miniature: a stale `now` decided
    // which day it was while a fresh `Date.now()` decided whether the moment
    // was still ahead, and the two can disagree. One reading now decides both.
    const readAt = noonOnFifthOctober()
    const freeAt = readAt + 20 * HOUR
    const said = providerSpendFreeLine(row({ used: 629, freeAt }), readAt)
    expect(said).toMatch(/Budget frees at/)
    expect(said).not.toMatch(/not known yet/)
  })
})

describe('a ledger the app cannot trust is qualified, not hidden', () => {
  it('says the clock was wrong rather than presenting the count as sound', () => {
    expect(providerSpendSkewLine()).toMatch(/clock was wrong/)
    // It names no internal detail: not a timestamp, not a store, not a key.
    expect(providerSpendSkewLine()).not.toMatch(/\d{4}-\d{2}|\/|provider_spend/i)
  })

  it('leads with the correction, because the two lines under it describe a cap that is not applied', () => {
    // `providerOverCap` returns null for a skewed ledger, so nothing is being
    // enforced. The count line still names a cap and the free line still
    // describes a wait, and a reader who took only those two would conclude
    // the app is holding these numbers to a bound. The correction was last on
    // this row and now leads it — a row that re-asserts itself every ten
    // seconds cannot carry its correction at the bottom.
    const now = noonOnFifthOctober()
    const lines = providerSpendLines(row({ used: 4, clockSkewed: true }), now)
    expect(lines.map((l) => l.id)).toEqual(['skew', 'count', 'free'])
    expect(lines[0].text).toBe(providerSpendSkewLine())
    // The count is still there — hiding it would hide the anomaly rather than
    // fix it — and it is still the number, not a replacement for one.
    expect(lines[1].text).toMatch(/4 calls in the last 24h/)
  })

  it('names no free moment on a skewed ledger, whose freeAt is arithmetic over untrusted stamps', () => {
    // A stamp dated 30 days in the future makes the window's free time land in
    // the PAST, which is a broken clock and not a rolling window. So a skewed
    // row must not print a time in either direction, and the sentence it
    // prints instead says the real reason: there is no wait, because there is
    // no cap being applied.
    const now = noonOnFifthOctober()
    const skewed = row({ used: 4, clockSkewed: true, freeAt: now + 6 * HOUR })
    const said = providerSpendFreeLine(skewed, now)
    expect(said).not.toMatch(/Budget frees at/)
    expect(said).not.toMatch(/\d{1,2}[:.]\d{2}/)
    expect(said).toMatch(/not being applied/i)
    // ...and it does not claim the budget is simply available either, which
    // would be a second thing this ledger cannot support.
    expect(said).not.toMatch(/available now/)
    // A skewed row is never described as capped either, for the same reason:
    // the app is refusing nothing, so there is no refusal to announce.
    expect(providerSpendLines(skewed, now).map((l) => l.id)).not.toContain('capped')
  })

  it('adds no third line for a ledger that is not skewed', () => {
    expect(providerSpendLines(row(), noonOnFifthOctober())).toHaveLength(2)
  })
})

describe('a provider at its cap says so, and only that provider does', () => {
  it('says nothing extra while there is still room', () => {
    // The clause is `describeProviderCap`'s "is at its call cap", and that
    // sentence is only ever rendered for a capped provider. Carrying it into
    // a per-row surface unconditionally would tell a user with 3 calls out of
    // 50 that their provider is at its cap — the same defect in new words.
    const now = noonOnFifthOctober()
    const lines = providerSpendLines(row({ used: 3, freeAt: null }), now)
    expect(lines.map((l) => l.id)).toEqual(['count', 'free'])
  })

  it('adds the capped line between the count and the free time when the wait is still ahead', () => {
    const now = noonOnFifthOctober()
    const lines = providerSpendLines(row({ used: 629, freeAt: now + 6 * HOUR }), now)
    expect(lines.map((l) => l.id)).toEqual(['count', 'capped', 'free'])
    // Order is the argument: "this one is at its limit" is read before the
    // moment the limit lifts, and the count above it is the number.
    expect(lines[1].text).toMatch(/at its cap/i)
    expect(lines[2].text).toMatch(/Budget frees at/)
  })

  it('drops the line the moment the wait has elapsed, on the same clock the free line uses', () => {
    // Both lines read the ledger's own `freeAt` and the SAME `now`, so they
    // cannot contradict each other: there is no state in which the row claims
    // the app is refusing this provider while naming no moment to stop it.
    // The direction is the safe one — the claim goes when the refusal may have
    // ended, never lingers after it.
    const now = noonOnFifthOctober()
    const row_ = row({ used: 629, freeAt: now + 20 * 60_000 })
    expect(providerSpendLines(row_, now).map((l) => l.id)).toContain('capped')
    const after = now + 20 * 60_000 + 1
    expect(providerSpendLines(row_, after).map((l) => l.id)).toEqual(['count', 'free'])
    expect(providerSpendLines(row_, after)[1].text).not.toMatch(/at its cap/i)
  })

  it('tells the user their own actions still run, so a capped row does not read as a broken app', () => {
    // `callAI` refuses the cap for automated work only and never for a manual
    // one, so this is the same reassurance `describeProviderCap` gives and it
    // is true of this row.
    expect(providerSpendCappedLine()).toMatch(/ask for directly still runs/i)
    // ...and it claims no internals: no setting key, no store field, no id.
    expect(providerSpendCappedLine()).not.toMatch(/provider_call_cap|provider_spend|manual|automated/i)
  })
})

describe('the as-of marker names the read, and cannot be mistaken for now', () => {
  it('names the moment of the read, with the day, however long ago it was', () => {
    // The day is not optional here, whatever `clockTime` does for a moment
    // minutes away: an as-of marker describes something already past, so the
    // exemption that exists for "about to happen" can never apply to it, and a
    // bare "09:12" from three hours ago is a time a reader has no way to place.
    const now = new Date(2026, 9, 5, 20, 0, 0).getTime()
    const readAt = new Date(2026, 9, 5, 9, 12, 0).getTime()
    const said = providerSpendAsOf(readAt, now)
    expect(said).toMatch(/^As of \d{1,2}[:.]\d{2}.* on /)
    expect(said).toContain(new Date(readAt).toLocaleDateString([], { day: 'numeric', month: 'short' }))
    // The marker says when the numbers were READ. It must never render the
    // current time instead, which is how a stale number gets a fresh-looking
    // timestamp bolted to it.
    expect(said).not.toContain(new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })

  it('names the year when the read falls in another one, judged against now', () => {
    // The marker takes `now` for the year comparison and for nothing else. A
    // panel left open across midnight on 31 December reading a number taken
    // the night before has to be able to say which year that was: "as of
    // 23:04 on 31 Dec" is ambiguous the moment the reader's clock ticks over,
    // and a marker that is ambiguous about its own age is not a marker.
    const now = new Date(2027, 0, 1, 0, 30, 0).getTime()
    const readAt = new Date(2026, 11, 31, 23, 4, 0).getTime()
    expect(providerSpendAsOf(readAt, now)).toContain('2026')
  })

  it('never says how long ago in words, because the words rot the moment they are read', () => {
    // A relative word would need the marker to be re-rendered continuously to
    // stay true, and the one thing a relative word cannot do here is survive
    // the reader looking away. An explicit date that has gone by is plainly a
    // date that has gone by — the rule `clockTime` already works by.
    const now = noonOnFifthOctober()
    const said = providerSpendAsOf(now - 3 * HOUR, now)
    expect(said).not.toMatch(/\b(minutes?|hours?|days?|ago|just now|recently)\b/i)
    expect(said).not.toMatch(/\b(today|tomorrow|yesterday)\b/i)
  })
})
