import { memo, useEffect, useRef, useState } from 'react'
import type { AIQueueItem } from '../types'
import { queueItemLabel, queueItemStatusText } from '../fitQueue'

/**
 * How many rows are mounted at once.
 *
 * The queue can hold ~900 items, and the panel re-renders on every 10s
 * poll. Mounting all of them means tearing down and rebuilding the
 * whole list on the main thread each time, which is what made opening
 * and clearing the panel feel janky. Paging keeps the mounted row count
 * flat regardless of queue size; the remainder is reachable on demand.
 */
const PAGE_SIZE = 60

interface QueuePanelProps {
  items: AIQueueItem[]
  /** A queue call is in flight; suppress per-row actions to avoid double submits. */
  busyId: number | null
  onRetry: (item: AIQueueItem) => void
  onRemove: (item: AIQueueItem) => void
}

/** "Senior Engineer - Acme", falling back to the id for a deleted job. */
function jobLine(item: AIQueueItem): string {
  if (item.jobTitle && item.jobCompany) return `${item.jobTitle} - ${item.jobCompany}`
  return `Job ${item.jobId}`
}

/**
 * One row, memoized on its own props.
 *
 * The status text is computed here rather than in the parent so the
 * comparison is between plain strings: a 10s poll that returns the same
 * queue re-renders no rows at all, rather than all ~900 of them.
 */
const QueueRow = memo(function QueueRow({
  item, position, statusText, error, busy, onRetry, onRemove,
}: {
  item: AIQueueItem
  position: number
  statusText: string
  error: string | null
  busy: boolean
  onRetry: (item: AIQueueItem) => void
  onRemove: (item: AIQueueItem) => void
}) {
  return (
    <li
      data-testid="queue-task"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 8,
        background: 'var(--bg-elevated)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 18 }}>
              {position}.
            </span>
            <span data-testid="queue-task-label" style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500 }}>
              {queueItemLabel(item)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            <span data-testid="queue-task-job">{jobLine(item)}</span>
            {' · '}
            <span data-testid="queue-task-status">{statusText}</span>
          </div>
          {error && (
            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>{error}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {item.status === 'failed' && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onRetry(item)}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => onRemove(item)}
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  )
})

/**
 * The Queue tab of the notification center: every AI task the app has
 * queued, in the order the main process says it will be picked.
 *
 * This component deliberately does NOT sort. `aiQueue:list` returns
 * pick order (score_fit first, then fit score descending, nulls last,
 * queue id as the tie-break) computed by the same `pickOrder` the
 * processor uses, so re-sorting here would let the displayed order
 * drift from the order tasks actually run in. The list is rendered in
 * the exact array it is given.
 */
export default function QueuePanel({ items, busyId, onRetry, onRemove }: QueuePanelProps) {
  const [visible, setVisible] = useState(PAGE_SIZE)
  const previousCount = useRef(items.length)

  // Reset the window when the queue SHRINKS, not whenever it is shorter
  // than the window. `items.length < visible` also fires when the user
  // pages past the end of a short queue, which made the window snap
  // shut mid-paging and made the tail unreachable.
  useEffect(() => {
    if (items.length < previousCount.current) setVisible(PAGE_SIZE)
    previousCount.current = items.length
  }, [items.length])

  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
        No queued tasks.
      </div>
    )
  }

  const shown = items.slice(0, visible)
  const remaining = items.length - shown.length

  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {shown.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            position={index + 1}
            statusText={queueItemStatusText(item)}
            error={item.status === 'failed' && item.lastError ? item.lastError : null}
            busy={busyId === item.id}
            onRetry={onRetry}
            onRemove={onRemove}
          />
        ))}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          style={{ width: '100%', marginTop: 4 }}
        >
          Show {remaining} more
        </button>
      )}
    </>
  )
}
