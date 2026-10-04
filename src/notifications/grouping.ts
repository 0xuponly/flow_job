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
  /**
   * How many times the thing this group describes actually happened.
   *
   * The sum of each row's own `occurrences`, and NOT `occurrences.length`.
   * Those differ because the main process folds a repeat it recognises —
   * a re-render, a StrictMode double-mount, a retry with the same error —
   * into the row that is already there instead of writing a second one
   * (electron/notifications.ts). So a group can be three rows and a count
   * of 12, and using the row count would report the double-emission the
   * fold exists to remove, which is the number that made the badge a lie
   * in the first place.
   */
  count: number
  /** Newest occurrence's timestamp; the group's position in the list. */
  latestAt: number
}

/**
 * How many times one row's fact happened.
 *
 * The only place in the renderer that interprets the field, because it is
 * optional on this side of the IPC boundary (see src/types.ts) and the
 * store migration backfills it main-side. Anything that is not a finite
 * number >= 1 is read as 1: a row is the record of one thing having
 * happened, and the only failure mode available to a missing counter is
 * under-reporting, never inventing a count the store never asserted.
 */
export function rowOccurrences(row: NotificationRow): number {
  const n = row.occurrences
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
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
    let count = 0
    for (const row of occurrences) count += rowOccurrences(row)
    groups.push({
      key,
      message: newest.message,
      type: newest.type,
      source: newest.source,
      occurrences,
      count,
      latestAt: newest.created_at,
    })
  }
  groups.sort((a, b) => b.latestAt - a.latestAt)
  return groups
}

/** Every occurrence in a list, counting each row's own `occurrences`. */
export function totalOccurrences(rows: NotificationRow[]): number {
  let total = 0
  for (const row of rows) total += rowOccurrences(row)
  return total
}

/** How many occurrences a collapsed group row shows a count for. */
export function groupCountLabel(count: number): string | null {
  // No `× 1`. A single occurrence is not a repetition, and the number
  // would otherwise be the widest thing on every ordinary row.
  return count > 1 ? `× ${count}` : null
}