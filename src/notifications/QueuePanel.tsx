import type { AIQueueItem } from '../types'
import { queueItemLabel, queueItemStatusText } from '../fitQueue'

interface QueuePanelProps {
  items: AIQueueItem[]
  /** A queue call is in flight; suppress per-row actions to avoid double submits. */
  busyId: number | null
  onRetry: (item: AIQueueItem) => void
  onRemove: (item: AIQueueItem) => void
}

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
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
        No queued tasks.
      </div>
    )
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((item, index) => {
        const failed = item.status === 'failed'
        const busy = busyId === item.id
        return (
          <li
            key={item.id}
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
                  <span
                    aria-hidden="true"
                    style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 18 }}
                  >
                    {index + 1}.
                  </span>
                  <span
                    data-testid="queue-task-label"
                    style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500 }}
                  >
                    {queueItemLabel(item)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Job {item.jobId} · {queueItemStatusText(item)}
                </div>
                {item.status === 'failed' && item.lastError && (
                  <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                    {item.lastError}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {failed && (
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
      })}
    </ul>
  )
}
