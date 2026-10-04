import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNotifications } from './NotificationsProvider'
import QueuePanel from './QueuePanel'
import { notify } from '../components/Notifications'
import { api } from '../api'
import type { NotificationRow, QueueItemView } from '../types'
import { NOT_BLOCKED } from '../queueBlocked'
import type { AIQueueBlockedState } from '../queueBlocked'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString()
}

interface RowProps {
  row: NotificationRow
  onDismiss: (id: number) => void
}

function Row({ row, onDismiss }: RowProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li
      className="notif-row"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 8,
        background: 'var(--bg-elevated)',
      }}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8 }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, color: 'var(--text)' }}>{row.message}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {row.type} · {row.source} · {formatTime(row.created_at)}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => { e.stopPropagation(); onDismiss(row.id) }}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', whiteSpace: 'pre-wrap', color: 'var(--text)', fontSize: 13 }}>
          {row.full_message}
        </div>
      )}
    </li>
  )
}

type Panel = 'notifications' | 'queue'

const QUEUE_POLL_MS = 10000

export default function NotificationDrawer() {
  const { list, isOpen, close, dismiss, dismissAll } = useNotifications()
  const [mounted, setMounted] = useState(false)
  const [panel, setPanel] = useState<Panel>('notifications')
  const [queue, setQueue] = useState<QueueItemView[]>([])
  // App-wide provider availability, fetched with the queue it describes so
  // the banner and the rows it marks cannot come from different moments.
  // Starts as "nothing is blocked" so the first render before the first
  // fetch is the old behaviour rather than a banner about a state nobody
  // has asked about yet.
  const [blocked, setBlocked] = useState<AIQueueBlockedState>(NOT_BLOCKED)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  const loadQueue = useCallback(async () => {
    const items = await api.listAIQueue()
    setQueue(items)
    // Both calls are independent and neither may fail the panel: the
    // previous rows (and the previous blocked state) stay put on error,
    // exactly as runQueueAction below keeps the list on a failed write.
    try {
      setBlocked(await api.aiQueueBlocked())
    } catch {
      /* keep the last known state */
    }
  }, [])

  // Poll only while the Queue tab is actually on screen. Fetching on
  // every drawer open would make the notifications tab pay for a queue
  // round-trip it never displays, and the interval is cleared when the
  // drawer closes so a backgrounded app does no work.
  useEffect(() => {
    if (!isOpen || panel !== 'queue') return
    void loadQueue()
    const id = setInterval(() => { void loadQueue() }, QUEUE_POLL_MS)
    return () => clearInterval(id)
  }, [isOpen, panel, loadQueue])

  // A queue call either returns the full updated queue or an error
  // envelope. On error the previous rows are left in place: dropping
  // them would make a transient IPC failure look like the queue
  // drained itself.
  const runQueueAction = useCallback(
    async (fn: (id: number) => Promise<QueueItemView[]>, id: number) => {
      setBusyId(id)
      try {
        const result = await fn(id)
        if (Array.isArray(result)) setQueue(result)
        else notify('Could not update the queue', 'error')
      } catch {
        notify('Could not update the queue', 'error')
      } finally {
        setBusyId(null)
      }
    },
    []
  )

  // Irreversible, and the queue can hold hundreds of pending fit
  // scores and document generations, so confirm before calling — the
  // codebase convention for destructive actions (JobsPage, SettingsPage,
  // DocumentsPage all use window.confirm). The count goes in the prompt
  // so the user is confirming the size of what they are discarding, not
  // just its existence.
  const handleClearQueue = useCallback(async () => {
    const count = queue.length
    if (count === 0) return
    const ok = window.confirm(
      `Clear all ${count} queued task${count === 1 ? '' : 's'}?\n\n` +
      'Pending fit scores and document generation will be cancelled. ' +
      'This list is only refreshed periodically, so the actual number may ' +
      'differ. This cannot be undone.'
    )
    if (!ok) return
    setClearing(true)
    try {
      const result = await api.clearAIQueue()
      // Validated like runQueueAction above: this codebase uses error
      // envelopes in its IPC handlers, and trusting the shape blindly
      // would setQueue(undefined) and crash the drawer on render.
      if (!result || !Array.isArray(result.queue)) {
        notify('Could not clear the queue', 'error')
        return
      }
      setQueue(result.queue)
      notify(`Cleared ${result.removed} queued task${result.removed === 1 ? '' : 's'}.`, 'info')
    } catch {
      notify('Could not clear the queue', 'error')
    } finally {
      setClearing(false)
    }
  }, [queue.length])

  if (!mounted || !isOpen) return null

  return createPortal(
    <>
      <div
        data-testid="notif-backdrop"
        onClick={close}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          zIndex: 999,
        }}
      />
      <aside
        role="dialog"
        aria-label="Notification center"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 400,
          height: '100vh',
          background: 'var(--bg)',
          borderLeft: '1px solid var(--border)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 16, color: 'var(--text)' }}>Notification center</h2>
            {panel === 'queue' ? (
              <button
                type="button"
                aria-label="Clear queue"
                onClick={handleClearQueue}
                disabled={queue.length === 0 || clearing}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: queue.length === 0 ? 'var(--text-muted)' : 'var(--danger)',
                  padding: '4px 10px',
                  cursor: queue.length === 0 || clearing ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                }}
              >
                Clear queue
              </button>
            ) : (
              <button
                type="button"
                aria-label="Clear all notifications"
                onClick={dismissAll}
                disabled={list.length === 0}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: list.length === 0 ? 'var(--text-muted)' : 'var(--text)',
                  padding: '4px 10px',
                  cursor: list.length === 0 ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                }}
              >
                Dismiss all
              </button>
            )}
          </div>
          <div role="tablist" aria-label="Notification center panels" style={{ display: 'flex', gap: 4, marginTop: 12 }}>
            {([['notifications', 'Notifications'], ['queue', 'Queue']] as const).map(([key, label]) => {
              const active = panel === key
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setPanel(key)}
                  style={{
                    background: active ? 'var(--bg-elevated)' : 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: active ? 'var(--text)' : 'var(--text-muted)',
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {label}
                  {key === 'queue' && queue.length > 0 && ` (${queue.length})`}
                </button>
              )
            })}
          </div>
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {panel === 'notifications' ? (
            list.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
                No notifications.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {list.map((row) => (
                  <Row key={row.id} row={row} onDismiss={dismiss} />
                ))}
              </ul>
            )
          ) : (
            <QueuePanel
              items={queue}
              busyId={busyId}
              blocked={blocked}
              onRetry={(item) => { void runQueueAction(api.retryAIQueueItem, item.id) }}
              onRemove={(item) => { void runQueueAction(api.removeAIQueueItem, item.id) }}
            />
          )}
        </div>
        <footer style={{ padding: 12, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
          {panel === 'notifications'
            ? (list.length === 0 ? '0 notifications' : `${list.length} notification${list.length === 1 ? '' : 's'}`)
            : (queue.length === 0 ? '0 queued tasks' : `${queue.length} queued task${queue.length === 1 ? '' : 's'}`)}
        </footer>
      </aside>
    </>,
    document.body
  )
}
