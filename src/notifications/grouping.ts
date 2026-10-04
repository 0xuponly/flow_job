import type { NotificationRow, NotificationSource, NotificationType } from '../types'

/**
 * Collapsing the center's rows onto one line each.
 *
 * The rule that decides membership lives in the main process —
 * `electron/notificationGroup.ts` — and is stored on each row as
 * `group_key`. This module never re-derives it. That is the whole reason
 * grouping is done here rather than in the drawer: a second
 * implementation of "similar" is a second opinion about which rows
 * belong together, and the visible symptom of the two disagreeing is a
 * center that splits a twelve-failure group into eleven groups of one.
 *
 * So this file is only about ordering and shape. Rows arrive newest-first
 * from the store, but that is the store's choice, not this module's
 * premise: a group is ordered by its newest member, and a group list is
 * ordered by its newest group, so a user opening the drawer sees the most
 * recent thing at the top regardless of how the rows were interleaved on
 * disk.
 */

export interface NotificationGroup {
  key: string
  /** The summary shown on the collapsed row: the newest member's. */
  message: string
  type: NotificationType
  source: NotificationSource
  /** Newest first. Never empty — a group with no rows is not a group. */
  occurrences: NotificationRow[]
  /** Newest occurrence's timestamp; the group's position in the list. */
  latestAt: number
}

export function groupNotifications(rows: NotificationRow[]): NotificationGroup[] {
  const byKey = new Map<string, NotificationRow[]>()
  for (const row of rows) {
    const bucket = byKey.get(row.group_key)
    if (bucket) bucket.push(row)
    else byKey.set(row.group_key, [row])
  }

  const groups: NotificationGroup[] = []
  for (const [key, occurrences] of byKey) {
    // Sorted here rather than assumed. `created_at` is `Date.now()` at
    // insert, so two rows written in the same millisecond are common and
    // their relative order would otherwise be whatever the store's sort
    // happened to produce. `id` breaks the tie: it is monotonic per
    // insert, so a later insert with an equal timestamp still sorts last.
    occurrences.sort((a, b) => b.created_at - a.created_at || b.id - a.id)
    const newest = occurrences[0]
    groups.push({
      key,
      message: newest.message,
      type: newest.type,
      source: newest.source,
      occurrences,
      latestAt: newest.created_at,
    })
  }
  groups.sort((a, b) => b.latestAt - a.latestAt)
  return groups
}

/** How many occurrences a collapsed group row shows a count for. */
export function groupCountLabel(count: number): string | null {
  // No `× 1`. A single occurrence is not a repetition, and the number
  // would otherwise be the widest thing on every ordinary row.
  return count > 1 ? `× ${count}` : null
}