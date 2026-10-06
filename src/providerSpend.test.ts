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
 * These are pure functions: no clock, no store, no DOM. The wording is
 * asserted for IDENTITY against `describeProviderCap` in
 * `electron/providerSpend.test.ts`, which imports the real ai.ts; pinning the
 * same strings here as well would only re-state them.
 */
import { describe, it, expect } from 'vitest'
import {
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

  it('keeps the count next to the warning, because hiding it hides the anomaly', () => {
    const now = noonOnFifthOctober()
    const lines = providerSpendLines(row({ used: 4, clockSkewed: true }), now)
    expect(lines[0]).toMatch(/4 calls in the last 24h/)
    expect(lines[1]).toBe('Budget is available now.')
    expect(lines[2]).toBe(providerSpendSkewLine())
  })

  it('adds no third line for a ledger that is not skewed', () => {
    expect(providerSpendLines(row(), noonOnFifthOctober())).toHaveLength(2)
  })
})
