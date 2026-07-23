import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { NotificationRow, NotificationSource } from '../types'

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
  open: () => void
  close: () => void
  dismiss: (id: number) => void
  dismissAll: () => void
  refresh: () => Promise<void>
  persistentNotify: (input: PersistentNotifyInput) => Promise<void>
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<NotificationRow[]>([])
  const [isOpen, setIsOpen] = useState(false)

  const refresh = useCallback(async () => {
    const { rows } = await api.notificationsList()
    setList(rows)
  }, [])

  useEffect(() => {
    void api.notificationsPurgeOldDismissed().catch(() => undefined)
    void refresh()
  }, [refresh])

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  const dismiss = useCallback(async (id: number) => {
    const before = list
    setList((cur) => cur.filter((r) => r.id !== id))
    const result = await api.notificationsDismiss({ id })
    if ('error' in result) {
      setList(before)  // rollback
      // surface a toast: caller can wire this later; for now, log to dev console
      // (renderer is allowed to console.warn per project memory)
    }
  }, [list])

  const dismissAll = useCallback(async () => {
    const before = list
    setList([])
    const result = await api.notificationsDismissAll()
    if ('error' in result) {
      setList(before)  // rollback
      await refresh()  // re-fetch to be safe
    }
  }, [list, refresh])

  const persistentNotify = useCallback(async (input: PersistentNotifyInput) => {
    await api.notificationsAdd(input)
    await refresh()
  }, [refresh])

  const value = useMemo<NotificationContextValue>(() => ({
    list,
    isOpen,
    hasUnread: list.length > 0,
    open,
    close,
    dismiss,
    dismissAll,
    refresh,
    persistentNotify,
  }), [list, isOpen, open, close, dismiss, dismissAll, refresh, persistentNotify])

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider')
  return ctx
}
