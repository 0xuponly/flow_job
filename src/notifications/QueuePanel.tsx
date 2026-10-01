import { memo, useEffect, useRef, useState } from 'react'
import type { QueueItemView } from '../types'
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
  /**
   * The enriched view, not `AIQueueItem[]`. The panel renders
   * jobTitle / jobCompany for every row it is given, and the renderer
   * swaps its whole list for whatever a queue call returns — so the
   * shape it accepts is the shape the backend must send. Requiring the
   * view type is what makes a handler answering with raw store rows a
   * compile error instead of a panel that shows `Job <id>` on every row.
   */
  items: QueueItemView[]
  /** A queue call is in flight; suppress per-row actions to avoid double submits. */
  busyId: number | null
  onRetry: (item: QueueItemView) => void
  onRemove: (item: QueueItemView) => void
}

/**
 * "Senior Engineer - Acme", falling back to the id for a deleted job.
 *
 * Three cases, because a job row can be partially populated and the two
 * failures are not the same:
 *
 * - both present: `Title - Company`, the normal case.
 * - neither present: `Job <id>`. The job row is genuinely gone, and the
 *   id is the only thing that still identifies the task.
 * - exactly one present: the half we DO have plus the id. The job
 *   exists but one field is missing or blank (a scraped posting with no
 *   company, a title that was never filled in). Dropping to a bare
 *   `Job <id>` there would throw away real information the main process
 *   just sent us, which is the same user-visible loss as the bug this
 *   whole change is about; keeping the id alongside keeps the row
 *   unambiguous, since two different jobs can easily share a title. A
 *   dangling `Title - ` is never rendered.
 */
function jobLine(item: QueueItemView): string {
  const title = item.jobTitle?.trim() ?? ''
  const company = item.jobCompany?.trim() ?? ''
  if (title && company) return `${title} - ${company}`
  if (title) return `${title} - Job ${item.jobId}`
  if (company) return `${company} - Job ${item.jobId}`
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
  item: QueueItemView
  position: number
  statusText: string
  error: string | null
  busy: boolean
  onRetry: (item: QueueItemView) => void
  onRemove: (item: QueueItemView) => void
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
 *
 * The window moves both ways: "Show N more" grows it a page at a time
 * and "Show fewer" walks it back to the first page. Growth alone would
 * leave a user who paged into a long queue with no way back to the
 * default view short of closing and reopening the panel.
 */
export default function QueuePanel({ items, busyId, onRetry, onRemove }: QueuePanelProps) {
  const [visible, setVisible] = useState(PAGE_SIZE)
  const previousCount = useRef(items.length)

  // Reset the window on ANY change in length, not only a shrink. The
  // queue is polled every 10s, and a poll can miss a clear-and-rebuild
  // entirely: the count the effect compares against is whatever the last
  // render saw, so a queue that grew to 900 and came back to 3 between
  // two polls presents as 3 -> 3 and leaves the window showing rows that
  // are not there. Comparing the count against itself can only ever see
  // the net change, which is exactly the change that is invisible.
  //
  // `items.length < visible` would fire mid-paging and snap the window
  // shut, which is why this keys on a change rather than on the window.
  useEffect(() => {
    if (items.length !== previousCount.current) setVisible(PAGE_SIZE)
    previousCount.current = items.length
  }, [items.length])

  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
        No queued tasks.
      </div>
    )
  }

  // `slice` clamps, so a window left wider than the list cannot render
  // phantom rows; the shrink control is what makes that window reachable
  // again in the first place.
  const shown = items.slice(0, visible)
  const remaining = items.length - shown.length
  const canShowFewer = visible > PAGE_SIZE

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
      {(remaining > 0 || canShowFewer) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {remaining > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setVisible((v) => v + PAGE_SIZE)}
              style={{ flex: 1 }}
            >
              Show {remaining} more
            </button>
          )}
          {canShowFewer && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setVisible((v) => Math.max(PAGE_SIZE, v - PAGE_SIZE))}
              style={{ flex: 1 }}
            >
              Show fewer
            </button>
          )}
        </div>
      )}
    </>
  )
}
