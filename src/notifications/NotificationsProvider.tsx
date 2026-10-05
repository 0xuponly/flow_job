import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { NotificationRow, NotificationSource } from '../types'
import { notify } from '../components/Notifications'
import { NOTIFICATION_RECORDED_EVENT } from './record'

export interface PersistentNotifyInput {
  type: string
  source?: NotificationSource
  message: string
  full_message: string
}

interface NotificationContextValue {
  list: NotificationRow[]
  isOpen: boolean
  hasUnread: boolean
  /**
   * Set when the LAST read of the store failed.
   *
   * Not derivable from `list`. An empty list is the answer to "the store
   * has nothing in it", and a failed read is not an answer at all — before
   * this existed the two were indistinguishable in the UI, so a store that
   * could not be read rendered as a center with nothing in it. That is how
   * a crash record could sit in the file, in plain sight of the user, and
   * be reported by the drawer as "No notifications."
   *
   * `string` rather than `boolean` so the drawer can say which read failed
   * without the provider inventing a message the user then has to parse.
   */
  loadError: string | null
  /**
   * How many entries of the stored notification list the main process had
   * to discard because they were not rows.
   *
   * The corrupt-row arm of the same problem `loadError` covers, and it
   * needs a number rather than a flag because "something" cannot be acted
   * on and "three entries" can be reasoned about. Zero on every read of a
   * store that holds nothing but well-formed rows, which is every read in
   * normal operation — the store migration in electron/database.ts has to
   * drop them (`loadStore` is the accessor for the whole Store and a
   * `null` in that array would take jobs and documents down with it), but
   * dropping them quietly is what let a store containing one string report
   * itself as empty.
   */
  unreadable: number
  /**
   * The last read did not give the whole story, so the bell must not read as
   * "there is nothing here".
   *
   * `hasUnread` alone cannot carry this, and folding it in would be its own
   * lie in the other direction: the dot means "something you have not seen",
   * and a store that could not be read is not something unseen. So this is a
   * separate flag and the sidebar renders it differently. Before it existed
   * the failure was reachable only by opening the centre — the user had to
   * open the thing that was broken to find out that it was broken, and
   * nothing outside the drawer said a word.
   *
   * True for either arm: the read failed outright (`loadError`), or it
   * succeeded over a store holding entries that had to be discarded
   * (`unreadable`).
   */
  readFailed: boolean
  open: () => void
  close: () => void
  dismiss: (id: number) => void
  /**
   * Dismiss every row of one collapsed group.
   *
   * Takes ids rather than a group key on purpose: the key groups the
   * *active* rows, and a dismissal has to name the rows the user was
   * actually looking at. Passing the key would re-resolve it at dismiss
   * time and sweep up anything recorded in between.
   */
  dismissGroup: (ids: number[]) => void
  dismissAll: () => void
  refresh: () => Promise<void>
  persistentNotify: (input: PersistentNotifyInput) => Promise<void>
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

/**
 * How long a burst of freshly-written records is collapsed into one read.
 *
 * Long enough to span every write in a single tick — which is what a
 * document sweep is — and short enough that a record written while the
 * drawer is open is on screen essentially at once.
 */
const RECORDED_REFRESH_COALESCE_MS = 50

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<NotificationRow[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unreadable, setUnreadable] = useState(0)

  /**
 * Re-read the store into `list`.
 *
 * This is the list the badge counts and the drawer renders, which makes
 * it a cache rather than a source of truth — so it never throws and never
 * reports failure by rejecting:
 *
 *   - It VALIDATES the envelope. This codebase returns `{ error:
 *     'INTERNAL' }` from handlers that can fail, and destructuring
 *     `{ rows }` off one is how `NotificationDrawer`'s queue panel used to
 *     crash the drawer on render (see its `runQueueAction`). A bad shape
 *     means "leave the cache alone", never "render undefined".
 *   - It swallows a rejection. `ipcRenderer.invoke` rejects when the
 *     channel itself fails, and the four callers — mount, the coalesced
 *     recorded-event timer, the drawer on open, `persistentNotify` — all
 *     float the promise.
 *
 * A failed read now RECORDS the failure instead of only swallowing it.
 * That is the change, and it is the load-error half of "a record list that
 * fails to load must not render as silently empty": the previous
 * arrangement returned quietly, which left `list` at whatever it was —
 * and at mount that is `[]` — so the drawer rendered its empty state and
 * the user was told there was nothing to see. Records that exist, including
 * a crash recorded by the main process while no renderer was listening,
 * were in the file and absent from the screen.
 *
 * So the cache is never replaced by the failure: `list` keeps whatever it
 * last successfully read, and `loadError` says the drawer is looking at a
 * possibly-stale copy. An error that blanked the list would be a second
 * lie, this time on top of rows the user had already read.
 *
 * `unreadable` is the other half and rides along on the same envelope. It
 * is deliberately NOT folded into `loadError`: the read succeeded, and
 * saying it failed would be its own kind of wrong. The drawer needs to
 * distinguish "I could not read the store" from "I read the store and some
 * of what is in it is not a record", because only the second one still has
 * a usable list to show.
 */
const refresh = useCallback(async () => {
  try {
    const result = await api.notificationsList()
    if (!result || !('rows' in result) || !Array.isArray(result.rows)) {
      setLoadError('The notification center could not be read.')
      return
    }
    setList(result.rows)
    // Coerced rather than trusted. A main-process build older than the
    // field omits it, and `NaN > 0` is false so a `?? 0` would not help
    // anyway — the only failure mode worth worrying about is a count that
    // is not a non-negative integer, and the drawer must never render one.
    const dropped = Number(result.unreadable)
    setUnreadable(Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0)
    setLoadError(null)
  } catch {
    // Leave the cache as it is, and say so. See the doc comment.
    setLoadError('The notification center could not be reached.')
  }
}, [])

  useEffect(() => {
    void api.notificationsPurgeOldDismissed().catch(() => undefined)
    void refresh()
  }, [refresh])

  // A record written by any renderer window announces itself on
  // `app:notification-recorded` (see record.ts) rather than going through
  // this provider, so that recording a failure never requires a provider
  // to be mounted above the component that hit it. This is the read side
  // of that arrangement: the badge count and the drawer would otherwise go
  // stale until the user pressed Refresh.
  //
  // Coalesced, and that is not a micro-optimisation. The reported bug is
  // one action producing a burst of records — a six-document sweep writes
  // six — and each of those is a `notificationsList` call, which reads and
  // decrypts the entire store. Six reads to learn what one read would have
  // said makes recording a failure the expensive part of failing. The
  // window only has to be long enough to span a burst of writes in the
  // same tick, and it re-arms itself so a later burst is picked up too.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onRecorded = () => {
      if (refreshTimer.current !== null) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        void refresh()
      }, RECORDED_REFRESH_COALESCE_MS)
    }
    window.addEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
    return () => {
      window.removeEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [refresh])

  // The other direction: a record written by the MAIN process.
  //
  // There is one of those, and it is the one that matters most. An
  // `uncaughtException` is handled in `electron/main.ts`, which writes the
  // crash straight to the store — there is no renderer there to fire
  // `NOTIFICATION_RECORDED_EVENT` from, which is exactly why the write is
  // in the main process rather than in `useMainErrorToasts`. So without
  // this subscription the crash sits in the file, the sidebar badge stays
  // dark, and the only way to find out it happened is to open the center
  // and look. A record the user has to go looking for is not a
  // notification.
  //
  // Every live window is sent the ping rather than the focused one (see
  // `notifyStoreChanged` in electron/main.ts), because unlike the crash
  // toast there is no question of who can act on it: the badge is a dot in
  // each window's own sidebar, and a window nobody is looking at costs
  // nothing. The same coalescing timer serves both events, so a burst from
  // either side is still one read.
  useEffect(() => {
    const unsubscribe = api.onNotificationsChanged(() => {
      if (refreshTimer.current !== null) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        void refresh()
      }, RECORDED_REFRESH_COALESCE_MS)
    })
    return () => {
      unsubscribe()
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [refresh])

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  /**
   * Settle the list against the store after a dismissal.
   *
   * On BOTH outcomes, and that is the part that is easy to get wrong. The
   * optimistic removal above is a guess, and two things can overtake it
   * while the IPC call is in flight — the coalesced refresh fired by a
   * freshly written record, and the drawer's own re-read on open. Either
   * installs the pre-dismissal list, and with only the failure path
   * reconciling, a dismissal that then SUCCEEDED left the row back on
   * screen and in the badge: the store had it dismissed, the UI did not,
   * and re-dismissing it was a no-op.
   *
   * So the store is re-read either way. `refresh` never throws, so this is
   * a settle and not a second failure path. The cost is one store read per
   * explicit dismissal — a user action, not the per-record burst the
   * coalescing timer above exists for.
   */
  const settle = useCallback(async (failed?: string) => {
    await refresh()
    if (failed) notify(failed, 'error')
  }, [refresh])

  const dismiss = useCallback(async (id: number) => {
    setList((cur) => cur.filter((r) => r.id !== id))
    try {
      const result = await api.notificationsDismiss({ id })
      await settle('error' in result ? 'Could not dismiss notification' : undefined)
    } catch {
      // `ipcRenderer.invoke` REJECTS when the channel itself fails — no
      // handler registered, which is exactly the window while the main
      // process restarts under `npm run dev`, or a torn-down renderer.
      // Unhandled, that left the row optimistically removed with no toast
      // and no restore: the user had dismissed nothing and could no longer
      // see the thing they tried to dismiss.
      await settle('Could not dismiss notification')
    }
  }, [settle])

  // Optimistic on the ids named, not on the key: see dismissGroup's doc
  // comment. A group whose rows are all gone disappears from the rendered
  // list on its own, since grouping is derived.
  const dismissGroup = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return
    const wanted = new Set(ids)
    setList((cur) => cur.filter((r) => !wanted.has(r.id)))
    try {
      const result = await api.notificationsDismissMany({ ids })
      await settle('error' in result ? 'Could not dismiss notifications' : undefined)
    } catch {
      await settle('Could not dismiss notifications')
    }
  }, [settle])

  const dismissAll = useCallback(async () => {
    setList([])
    try {
      const result = await api.notificationsDismissAll()
      await settle('error' in result ? 'Could not dismiss all notifications' : undefined)
    } catch {
      await settle('Could not dismiss all notifications')
    }
  }, [settle])

  const persistentNotify = useCallback(async (input: PersistentNotifyInput) => {
    await api.notificationsAdd(input)
    await refresh()
  }, [refresh])

  const value = useMemo<NotificationContextValue>(() => ({
    list,
    isOpen,
    hasUnread: list.length > 0,
    loadError,
    unreadable,
    readFailed: loadError !== null || unreadable > 0,
    open,
    close,
    dismiss,
    dismissGroup,
    dismissAll,
    refresh,
    persistentNotify,
  }), [list, isOpen, loadError, unreadable, open, close, dismiss, dismissGroup, dismissAll, refresh, persistentNotify])

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider')
  return ctx
}