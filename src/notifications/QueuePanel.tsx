import { memo, useEffect, useRef, useState } from 'react'
import type { QueueItemView } from '../types'
import { queueItemLabel, queueItemStatusText } from '../fitQueue'
import { blockedBannerLines, queueRowStatusText } from '../queueBlocked'
import type { AIQueueBlockedState } from '../queueBlocked'

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
  /**
   * App-wide: can the app reach a provider at all right now?
   *
   * Optional so a caller that has not fetched it renders exactly what it
   * rendered before. See src/queueBlocked.ts for the shape and for the
   * rule that keeps model names and health internals out of the panel.
   */
  blocked?: AIQueueBlockedState | null
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
 * May the user press Retry on this row?
 *
 * A `failed` row always may — that has been the button's whole contract.
 *
 * A STRANDED row may too, and that is the case this file exists for. A
 * crash leaves its row `processing` with nothing running; the app
 * deliberately does not resume it when the relevant Auto-queue switch is
 * off, because that spend is what the user turned off. That is the right
 * call, but on its own it made the row a dead end: no run, no retry
 * button, and no sign it would ever move again — the user had no way to
 * re-ask for work they had already asked for once. Offering Retry here
 * puts the decision back where it belongs: the app will not spend on its
 * own, the user still can.
 *
 * A row that IS being worked on does not get one. `stranded` is the main
 * process saying no run in this session owns the row, so a genuinely
 * live `processing` row reads false here and renders as it always did.
 * That is not cosmetic: the main process's in-flight run removes its own
 * row when it finishes, so a Retry that landed on a live row would have
 * the run delete the row the user just asked to re-run — the re-request
 * swallowed and the task gone from the panel. `retryQueueItem` refuses
 * such a row for the same reason; this is what keeps the button off it in
 * the first place, and the panel is the one place that can be working
 * from a stale picture of which rows are live (it polls every 10s).
 */
function canRetry(item: QueueItemView): boolean {
  return item.status === 'failed' || item.stranded === true
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
          {canRetry(item) && (
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
 * "The queue is waiting on a provider", stated once, above the rows.
 *
 * Before this the only trace of a total provider outage was a per-row
 * error string, so 265 tasks rendered as an ordinary backlog for 20
 * hours (2026-10-02) and nothing told the user the app could not run any
 * of them. This is the one place that says so.
 *
 * Copy comes from src/queueBlocked.ts rather than being written here, so
 * the wording can be asserted on its own and stays clear of model names,
 * HTTP statuses and cooldown plumbing.
 *
 * A warning style rather than `danger`: nothing has failed and nothing is
 * lost — the queue is healthy and idle because its provider is not.
 */
function ProviderBlockedNotice({ lines }: { lines: { headline: string; detail: string } }) {
  return (
    <div
      role="status"
      data-testid="queue-provider-blocked"
      style={{
        border: '1px solid var(--warning, #eab308)',
        background: 'var(--bg-elevated)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{lines.headline}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{lines.detail}</div>
    </div>
  )
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
 *
 * The window moves both ways: "Show N more" grows it a page at a time
 * and "Show fewer" walks it back to the first page. Growth alone would
 * leave a user who paged into a long queue with no way back to the
 * default view short of closing and reopening the panel.
 */
export default function QueuePanel({ items, busyId, blocked, onRetry, onRemove }: QueuePanelProps) {
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

  // One notice for the whole panel, above the rows and above the empty
  // state: "the app cannot reach a provider" is true whether or not
  // anything happens to be queued, and a user about to press Generate is
  // exactly who needs to be told.
  //
  // `items.length` is the panel's own list and it is passed ONLY so the
  // banner can tell an empty queue from a populated one. It is not the
  // banner's count: the number of tasks the provider is holding comes
  // from the blocked state, which is measured in the main process from
  // the rows it has actually parked. This panel rendered "241 queued
  // tasks are waiting" over a 241-row queue for hours while the true
  // waiting count moved between 1 and 176.
  const blockedLines = blockedBannerLines(blocked, items.length)

  if (items.length === 0) {
    return (
      <>
        {blockedLines && <ProviderBlockedNotice lines={blockedLines} />}
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 14 }}>
          No queued tasks.
        </div>
      </>
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
      {blockedLines && <ProviderBlockedNotice lines={blockedLines} />}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {shown.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            position={index + 1}
            // A row parked on the provider clock reads differently from
            // one queued behind other work, so "waiting its turn" and
            // "cannot run at all" stop looking identical.
            statusText={queueRowStatusText(item, blocked, () => queueItemStatusText(item))}
            // A parked-on-the-cap row carries the provider's own message —
            // which provider, how much of its budget is gone, when it frees —
            // and that is the only place the user is told why their work is
            // not moving. `failed` alone hid it, which is what made the cap
            // look like a queue that had simply forgotten the task.
            //
            // A provider BLOCK is deliberately not in this condition: it
            // speaks through `statusText` and the banner above the rows
            // instead, so one outage is stated once rather than repeated on
            // each of the rows it happens to be holding.
            error={
              (item.status === 'failed' || item.parkedReason === 'provider_cap') &&
              item.lastError
                ? item.lastError
                : null
            }
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
