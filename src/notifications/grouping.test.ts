/**
 * Grouping: which rows share a line, and in what order they appear.
 *
 * The group key itself is written by the main process
 * (electron/notificationGroup.ts, covered in
 * electron/notificationCenter.store.test.ts). What is left for the
 * renderer is shape and order, and that is what this file is about —
 * including the cases where the store hands rows over in an order the
 * drawer must not depend on.
 */
import { describe, it, expect } from 'vitest'
import { groupCountLabel, groupNotifications } from './grouping'
import type { NotificationRow } from '../types'

function row(over: Partial<NotificationRow> & { id: number; group_key: string }): NotificationRow {
  return {
    type: 'error',
    source: 'ai',
    message: `message ${over.id}`,
    full_message: `full ${over.id}`,
    created_at: 1_700_000_000_000,
    dismissed_at: null,
    ...over
  }
}

const A = 'error|ai|group a'
const B = 'error|ai|group b'

describe('groupNotifications', () => {
  it('puts rows sharing a key into one group and nothing else together', () => {
    const groups = groupNotifications([
      row({ id: 1, group_key: A, created_at: 100 }),
      row({ id: 2, group_key: B, created_at: 200 }),
      row({ id: 3, group_key: A, created_at: 300 })
    ])

    expect(groups).toHaveLength(2)
    const a = groups.find((g) => g.key === A)!
    // Newest first, so id 3 (created_at 300) leads.
    expect(a.occurrences.map((r) => r.id)).toEqual([3, 1])
    expect(groups.find((g) => g.key === B)!.occurrences.map((r) => r.id)).toEqual([2])
  })

  it('orders a group newest first', () => {
    const groups = groupNotifications([
      row({ id: 1, group_key: A, created_at: 100 }),
      row({ id: 3, group_key: A, created_at: 300 }),
      row({ id: 2, group_key: A, created_at: 200 })
    ])
    expect(groups[0].occurrences.map((r) => r.id)).toEqual([3, 2, 1])
  })

  it('breaks a same-millisecond tie by id, so two rows written together are still ordered', () => {
    // `created_at` is Date.now() at insert, so rows written inside one
    // millisecond are routine rather than exotic, and their relative order
    // would otherwise be whatever the store's sort happened to produce.
    const groups = groupNotifications([
      row({ id: 1, group_key: A, created_at: 100 }),
      row({ id: 2, group_key: A, created_at: 100 }),
      row({ id: 3, group_key: A, created_at: 100 })
    ])
    expect(groups[0].occurrences.map((r) => r.id)).toEqual([3, 2, 1])
  })

  it('orders groups by their newest member, not by their oldest', () => {
    // A group that fired eleven times an hour ago and again just now is a
    // group the user is looking at.
    const groups = groupNotifications([
      row({ id: 1, group_key: A, created_at: 10 }),
      row({ id: 2, group_key: A, created_at: 1_000 }),
      row({ id: 3, group_key: B, created_at: 500 })
    ])
    expect(groups.map((g) => g.key)).toEqual([A, B])
  })

  it('does not assume the rows arrive pre-sorted', () => {
    const forwards = groupNotifications([
      row({ id: 1, group_key: A, created_at: 300 }),
      row({ id: 2, group_key: A, created_at: 100 })
    ])
    const backwards = groupNotifications([
      row({ id: 2, group_key: A, created_at: 100 }),
      row({ id: 1, group_key: A, created_at: 300 })
    ])
    expect(forwards[0].occurrences.map((r) => r.id)).toEqual(backwards[0].occurrences.map((r) => r.id))
  })

  it('shows the newest member on the collapsed row', () => {
    const groups = groupNotifications([
      row({ id: 1, group_key: A, message: 'the first one said this', created_at: 100 }),
      row({ id: 2, group_key: A, message: 'the second one said this', created_at: 300 })
    ])
    expect(groups[0].message).toBe('the second one said this')
  })

  it('takes the header fields from the newest member', () => {
    const groups = groupNotifications([
      row({ id: 1, group_key: A, type: 'info', source: 'app', created_at: 100 }),
      row({ id: 2, group_key: A, type: 'error', source: 'ai', created_at: 300 })
    ])
    expect(groups[0]).toMatchObject({ type: 'error', source: 'ai', latestAt: 300 })
  })

  it('an empty list is no groups, not one empty group', () => {
    expect(groupNotifications([])).toEqual([])
  })
})

/**
 * What the number on a collapsed row means.
 *
 * There is no `count` field and no per-row counter, and that is the fix
 * rather than a simplification of one: `electron/notifications.ts` refuses
 * to write a second row for the same thing inside `DEDUPE_WINDOW_MS`, so a
 * group's `occurrences.length` is already the number of things that went
 * wrong. Summing a per-row emission counter on top of it would have put
 * `× 12` back on screen for twelve emissions of one failure — the exact
 * number that was filed as a lie, reached from better code.
 */
describe('the count a group reports', () => {
  it('is the number of things that went wrong, which is the number of rows', () => {
    const groups = groupNotifications([
      row({ id: 1, group_key: A }),
      row({ id: 2, group_key: A }),
      row({ id: 3, group_key: A })
    ])

    expect(groups[0].occurrences).toHaveLength(3)
    // Three failures. Not three emissions, because a row IS a failure: the
    // store never writes a second one for the same thing inside its
    // window, so there is nothing here that could inflate this.
    expect(groupCountLabel(groups[0].occurrences.length)).toBe('× 3')
  })

  it('does not grow when the rows are identical repeats of each other', () => {
    // The store is what folds these — a byte-identical repeat inside the
    // window never becomes a second row — so at the render layer the count
    // is rows and only rows. Twelve emissions of one failure arrive as one
    // row and therefore as no count at all.
    const groups = groupNotifications([row({ id: 1, group_key: A })])
    expect(groups[0].occurrences).toHaveLength(1)
    // `× 1` would assert a repetition that did not happen.
    expect(groupCountLabel(groups[0].occurrences.length)).toBeNull()
  })
})
