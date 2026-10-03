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

describe('groupCountLabel', () => {
  it('shows nothing for one occurrence', () => {
    // A single occurrence is not a repetition, and `× 1` would be the
    // widest thing on every ordinary row.
    expect(groupCountLabel(1)).toBeNull()
  })

  it('names the repetition for two or more', () => {
    expect(groupCountLabel(2)).toBe('× 2')
    expect(groupCountLabel(12)).toBe('× 12')
    expect(groupCountLabel(500)).toBe('× 500')
  })
})