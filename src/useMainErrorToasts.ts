// src/useMainErrorToasts.ts
import { useEffect } from 'react'
import { api } from './api'
import { notify } from './components/Notifications'

/**
 * How long one crash message is allowed to open a new toast.
 *
 * Longer than a toast's own lifetime on purpose. `notify` already
 * refuses a repeat while the previous copy is still on screen, but a
 * crash that keeps re-throwing is one fact spread over time, and the
 * toast TTL is the wrong window for it: an exception thrown from a
 * timer or an event handler recurs for as long as the condition holds,
 * so a per-toast window turns "one crash" into a toast every few
 * seconds for as long as the user leaves the app alone. crash.log keeps
 * every single occurrence — this only decides how many times the user is
 * interrupted about them.
 */
const CRASH_TOAST_WINDOW_MS = 30_000

/** message -> when it last opened a toast. */
const lastCrashToastAt = new Map<string, number>()

/**
 * Surfaces main-process crash notifications (uncaughtException) as
 * toasts. The main process emits these on 'main:errorToast' for errors
 * the user should know about that originate outside any IPC call.
 */
export function useMainErrorToasts(): void {
  useEffect(() => {
    const unsubscribe = api.onMainError((message) => {
      const now = Date.now()
      const lastAt = lastCrashToastAt.get(message)
      if (lastAt !== undefined && now - lastAt < CRASH_TOAST_WINDOW_MS) return
      lastCrashToastAt.set(message, now)
      notify(message, 'error')
    })
    return () => {
      unsubscribe()
      // Same reasoning as the toast funnel's own bookkeeping: with the
      // hook gone no crash toast is on screen, so nothing is left for
      // the window above to be right about.
      lastCrashToastAt.clear()
    }
  }, [])
}
