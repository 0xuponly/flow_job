// src/useMainErrorToasts.ts
import { useEffect } from 'react'
import { api } from './api'
import { notify } from './components/Notifications'

/**
 * Surfaces main-process crash notifications (uncaughtException) as
 * toasts. The main process emits these on 'main:errorToast' for errors
 * the user should know about that originate outside any IPC call.
 */
export function useMainErrorToasts(): void {
  useEffect(() => {
    return api.onMainError((message) => {
      notify(message, 'error')
    })
  }, [])
}
