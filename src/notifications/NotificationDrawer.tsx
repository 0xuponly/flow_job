import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNotifications } from './NotificationsProvider'
import { groupCountLabel, groupNotifications, type NotificationGroup } from './grouping'
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

/**
 * How many occurrences an expanded group renders before it asks.
 *
 * Grouping is what keeps the *collapsed* list to one line per kind of
 * thing; without a ceiling on the expanded list, expanding a group of 500
 * rebuilds the very flood the grouping just prevented, which is a worse
 * surprise because the user opened it deliberately. Same shape as the
 * queue panel's window (`QueuePanel.tsx`), same reason.
 *
 * Paged by ROW, because a row is what the window reveals. `shown` is a row
 * count and so is `occurrences.length`; deriving the button from anything
 * else is how it came to promise five more entries and reveal none — a
 * group holding one row whose counter read 30 satisfied `count > shown`
 * while there was no second row to show.
 */
const OCCURRENCE_PAGE = 25

/**
 * Counts both things, because they answer different questions and the
 * user needs both: how many distinct things went wrong, and how many lines
 * they collapse onto. A centre reading "1 notification" when twelve
 * documents failed would be technically true and practically a lie.
 *
 * Both numbers are ROW counts, for the reason in `NotificationGroup`. There
 * is no emission count anywhere in this component, because there is no
 * emission count anywhere in the product.
 */
function notificationsFooter(rowCount: number, groupCount: number): string {
  if (rowCount === 0) return '0 notifications'
  const total = `${rowCount} notification${rowCount === 1 ? '' : 's'}`
  if (groupCount >= rowCount) return total
  return `${total} in ${groupCount} group${groupCount === 1 ? '' : 's'}`
}

// The one control both the group header and each expanded entry render.
const dismissButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
}

/**
 * One occurrence, expanded: everything the collapsed row dropped.
 *
 * Every field here is conditional on being present. `job_title`,
 * `job_company` and `job_location` are null when the app could not source
 * them at record time, and a missing field is rendered as nothing — not
 * as `'—'`, not as `'Unknown'`. See `jobContext` in record.ts.
 */
function Occurrence({ row, onDismiss }: { row: NotificationRow; onDismiss: (id: number) => void }) {
  const job = row.job
  // One entry, one thing that went wrong, at one time, with one payload.
  // Nothing here repeats itself: a repeat of the same thing did not become
  // a second row, and it does not get an entry that claims it did — the
  // store decided it was the same thing inside a two-second window, so
  // this is one occurrence and the timestamp is the only time it has.
  return (
    <li
      className="notif-occurrence"
      style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          <time dateTime={new Date(row.created_at).toISOString()}>{formatTime(row.created_at)}</time>
          {job?.job_title ? <span> · {job.job_title}</span> : null}
          {job?.job_company ? <span> · {job.job_company}</span> : null}
          {job?.job_location ? <span> · {job.job_location}</span> : null}
          {/* The bare id, but only when there is nothing else to say. An
              id IS sourced data, so showing it invents nothing; a
              timestamp alone would leave the user unable to tell which
              job failed, which is the whole point of the citation. This is
              the same fallback the queue panel uses (QueuePanel.tsx). */}
          {job?.job_id != null && !job.job_title && !job.job_company
            ? <span> · Job {job.job_id}</span>
            : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(row.id)}
          style={dismissButtonStyle}
        >
          ×
        </button>
      </div>
      <div
        style={{
          marginTop: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text)',
          fontSize: 13,
        }}
      >
        {row.full_message}
      </div>
    </li>
  )
}

interface GroupProps {
  group: NotificationGroup
  onDismiss: (id: number) => void
  onDismissGroup: (ids: number[]) => void
}

function GroupRow({ group, onDismiss, onDismissGroup }: GroupProps) {
  const [expanded, setExpanded] = useState(false)
  const [shown, setShown] = useState(OCCURRENCE_PAGE)
  // One number for the badge AND for the pager, because they are the same
  // number: rows. They were briefly different — the badge summed a
  // per-row counter while `shown` counted rows — which made the pager offer
  // "Show 5 more" on a group holding a single row and reveal nothing on
  // click. A badge and a pager that disagree about what they are counting
  // cannot both be right, so they read the same field.
  const count = group.occurrences.length
  const countLabel = groupCountLabel(count)
  const visible = expanded ? group.occurrences.slice(0, shown) : []

  return (
    <li
      className="notif-group"
      data-testid="notif-group"
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
          <div style={{ fontSize: 14, color: 'var(--text)' }}>{group.message}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {group.type} · {group.source} · {formatTime(group.latestAt)}
          </div>
        </div>
        {countLabel && (
          <span
            data-testid="notif-group-count"
            aria-label={`${count} occurrences`}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-muted)',
              alignSelf: 'flex-start',
              whiteSpace: 'nowrap',
            }}
          >
            {countLabel}
          </span>
        )}
        <button
          type="button"
          aria-label="Dismiss group"
          onClick={(e) => { e.stopPropagation(); onDismissGroup(group.occurrences.map((r) => r.id)) }}
          style={dismissButtonStyle}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div data-testid="notif-group-occurrences">
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {visible.map((row) => (
              <Occurrence key={row.id} row={row} onDismiss={onDismiss} />
            ))}
          </ul>
          {/* `count > shown` and the number in the label are both row
              arithmetic, and `shown` only ever grows by OCCURRENCE_PAGE, so
              the label cannot promise more rows than exist. The label is
              `count - shown` rather than a bare page size because that is
              the honest answer to "how much is left" — and when it is wrong
              the button is dead, so the two are read from one number. */}
          {count > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + OCCURRENCE_PAGE)}
              style={{
                marginTop: 8,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text-muted)',
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {`Show ${Math.min(OCCURRENCE_PAGE, count - shown)} more`}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

type Panel = 'notifications' | 'queue'

const QUEUE_POLL_MS = 10000

export default function NotificationDrawer() {
  const { list, isOpen, close, dismiss, dismissGroup, dismissAll, refresh, loadError, unreadable } = useNotifications()
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

  // Re-read on every open. The provider's list is a cache, and not every
  // record in the store is announced to it: `electron/main.ts` writes an
  // `uncaughtException` into the store from the main process, where there
  // is no renderer to fire a window event. Without this the crash would be
  // durably recorded and unreachable — present in the file, absent from
  // the drawer, which is the same as not recorded from the user's side.
  // Opening the center is the one moment the user has said they want to
  // see everything that is in it.
  useEffect(() => {
    if (!isOpen) return
    void refresh()
  }, [isOpen, refresh])

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

  const groups = groupNotifications(list)

  // The list, or nothing at all when there is nothing to be honest about.
  //
  // Two different ways the list can be incomplete, and both suppress the
  // empty state rather than sitting beside it, because "No notifications."
  // over an incomplete list is indistinguishable from the truth and is a
  // lie exactly when the user most needs to be told:
  //
  //   `loadError` — the read itself failed (a store that cannot be
  //     decrypted, or an IPC channel that is gone).
  //
  //   `unreadable` — the read worked, but the store file holds entries the
  //     migration had to discard because they were not rows. A store whose
  //     only entry is the string `'not-an-object'` used to land here
  //     indistinguishable from a centre that had genuinely never been used.
  //
  // Rows the last successful read DID produce stay on screen under the
  // banner. Blanking them would replace one lie with another, this time on
  // top of rows the user had already read, so the banner says they may be
  // stale instead.
  let body: React.ReactNode = null
  if (list.length > 0) {
    body = (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {groups.map((group) => (
          <GroupRow
            key={group.key}
            group={group}
            onDismiss={dismiss}
            onDismissGroup={dismissGroup}
          />
        ))}
      </ul>
    )
  } else if (!loadError && unreadable === 0) {
    body = (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
        No notifications.
      </div>
    )
  }

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
            <>
              {loadError && (
                <div
                  data-testid="notif-load-error"
                  role="alert"
                  style={{
                    border: '1px solid var(--danger)',
                    borderRadius: 6,
                    padding: 12,
                    marginBottom: 12,
                    fontSize: 13,
                    color: 'var(--text)',
                  }}
                >
                  <div>{loadError}</div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                    {list.length > 0
                      ? 'What is shown below is the last list that could be read.'
                      : 'Nothing could be shown.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void refresh() }}
                    style={{
                      marginTop: 8,
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      color: 'var(--text)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {unreadable > 0 && (
                <div
                  data-testid="notif-unreadable"
                  role="alert"
                  style={{
                    border: '1px solid var(--danger)',
                    borderRadius: 6,
                    padding: 12,
                    marginBottom: 12,
                    fontSize: 13,
                    color: 'var(--text)',
                  }}
                >
                  <div>
                    {`${unreadable} ${unreadable === 1 ? 'entry' : 'entries'} in the notification store could not be read.`}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                    {list.length > 0
                      ? 'What is shown below is everything else the store holds.'
                      : 'Nothing could be shown.'}
                  </div>
                </div>
              )}
              {body}
            </>
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
            ? notificationsFooter(list.length, groups.length)
            : (queue.length === 0 ? '0 queued tasks' : `${queue.length} queued task${queue.length === 1 ? '' : 's'}`)}
        </footer>
      </aside>
    </>,
    document.body
  )
}
