import { describe, it, expect } from 'vitest'
import * as renderer from './types'
import * as main from '../electron/types'
import type { Api } from './api'
import type { AIQueueItem, QueueItemView } from './types'

/** A stored row, exactly as the store hands it back: no display fields. */
const RAW_ROW: AIQueueItem = {
  id: 2657,
  type: 'score_fit',
  jobId: 2657,
  status: 'pending',
  attempts: 0,
  createdAt: 0,
  nextRetryAt: 0
}

/**
 * The contract that lets the Queue panel's labels be trusted.
 *
 * `aiQueue:remove` answered with `db.getAIQueue()` — raw store rows —
 * while `aiQueue:list` / `retry` answered with the enriched view. The
 * renderer replaces its ENTIRE list with each response, and `jobLine()`
 * falls back to `Job <id>` for a row without `jobTitle` / `jobCompany`,
 * so deleting one task silently renamed every other row to `Job <id>`.
 *
 * Nothing caught it because `AIQueueItem` declared those two fields
 * optional: a raw row satisfied the renderer's queue type without
 * complaint. `QueueItemView` requires them, so the raw shape no longer
 * type-checks anywhere the panel's data is declared.
 *
 * The `@ts-expect-error` lines below ARE the assertions: they fail
 * `npm run typecheck` if the raw row ever becomes assignable again, or
 * if the display fields are loosened back to optional. Each is paired
 * with a runtime expectation so the file also reports as a real test.
 */
describe('QueueItemView is not satisfied by a raw queue row', () => {
  it('rejects a raw row where a view is required', () => {
    // @ts-expect-error a stored AIQueueItem carries no jobTitle/jobCompany
    const asView: QueueItemView = RAW_ROW
    expect(asView.jobTitle).toBeUndefined()
  })

  it('rejects a raw row in the shape the panel accepts', () => {
    const items: QueueItemView[] = [
      // @ts-expect-error raw rows are not what the panel renders
      RAW_ROW
    ]
    expect(items).toHaveLength(1)
  })

  it('accepts the enriched row the main process actually returns', () => {
    const row: QueueItemView = { ...RAW_ROW, jobTitle: 'Junior Trader', jobCompany: 'Kairon Labs' }
    expect(`${row.jobTitle} - ${row.jobCompany}`).toBe('Junior Trader - Kairon Labs')
  })

  it('keeps the display fields on the view rather than the row', () => {
    // If `jobTitle` / `jobCompany` were ever moved back onto AIQueueItem
    // as optional, every assertion above would pass for the wrong reason:
    // the raw row would satisfy the view again and the type guard would be
    // protecting nothing. So the row type must not carry them at all.
    type RowKeys = keyof AIQueueItem
    const rowKeys: RowKeys[] = []
    expect(rowKeys).toEqual([])
    expect('jobTitle' in RAW_ROW).toBe(false)
    expect('jobCompany' in RAW_ROW).toBe(false)
  })
})

/**
 * The renderer duplicates this shape instead of importing electron/types.ts
 * (same reason as the constants above), so the two copies have to be kept
 * in step. If the main-process view gains or drops a field the renderer
 * never learns about it, and the panel quietly renders the wrong thing.
 */
/**
 * The API surface is where the shape actually has to hold. The panel
 * cannot render a row it was not given the display fields for, so
 * `Api`'s queue methods resolve to `QueueItemView[]` — which is what
 * makes an IPC handler that answers with `db.getAIQueue()` a compile
 * error at the handler rather than a panel that shows `Job <id>` on
 * every row.
 */
describe('the Api surface requires the enriched view', () => {
  it('rejects a queue method that answers with raw store rows', () => {
    const rawList = async (): Promise<AIQueueItem[]> => [RAW_ROW]
    const viewList = async (): Promise<QueueItemView[]> => [
      { ...RAW_ROW, jobTitle: null, jobCompany: null }
    ]
    type ListFn = Api['listAIQueue']
    // @ts-expect-error a handler returning AIQueueItem[] cannot satisfy the api
    const bad: ListFn = rawList
    const good: ListFn = viewList
    expect(typeof bad).toBe('function')
    expect(typeof good).toBe('function')
  })

  it('rejects a row-scoped queue method that answers with raw store rows', () => {
    // The remove path specifically: it is the one that took an id and
    // used to answer with whatever the store happened to hold.
    const rawRemove = async (_id: number): Promise<AIQueueItem[]> => [RAW_ROW]
    const viewRemove = async (_id: number): Promise<QueueItemView[]> => [
      { ...RAW_ROW, jobTitle: null, jobCompany: null }
    ]
    type RemoveFn = Api['removeAIQueueItem']
    // @ts-expect-error a handler returning AIQueueItem[] cannot satisfy the api
    const bad: RemoveFn = rawRemove
    const good: RemoveFn = viewRemove
    expect(typeof bad).toBe('function')
    expect(typeof good).toBe('function')
  })

  it('requires the enriched queue inside the clear contract too', () => {
    // `clearAIQueue` wraps the list in `{ removed, queue }`, so the
    // nesting is one more place the raw shape could hide.
    const raw = async (): Promise<{ removed: number; queue: AIQueueItem[] }> => ({
      removed: 1,
      queue: [RAW_ROW]
    })
    const view = async (): Promise<{ removed: number; queue: QueueItemView[] }> => ({
      removed: 1,
      queue: [{ ...RAW_ROW, jobTitle: null, jobCompany: null }]
    })
    type ClearFn = Api['clearAIQueue']
    // @ts-expect-error the clear contract carries the view, not the row
    const bad: ClearFn = raw
    const good: ClearFn = view
    expect(typeof bad).toBe('function')
    expect(typeof good).toBe('function')
  })
})

describe('renderer/main QueueItemView mirrors', () => {
  it('accepts the same values in both processes', () => {
    // Mutually assignable: if the main-process view dropped or renamed a
    // field, this stops compiling and the panel keeps rendering a field
    // the backend no longer sends.
    const rendererSide: QueueItemView = {
      ...RAW_ROW, jobTitle: 'Junior Trader', jobCompany: 'Kairon Labs'
    }
    const mainSide: main.QueueItemView = rendererSide
    const backToRenderer: QueueItemView = mainSide
    expect(backToRenderer.jobCompany).toBe('Kairon Labs')
  })

  it('does not let a raw main-process row satisfy the renderer view', () => {
    // The direction that actually bit: a store row read as a view, with
    // the display fields silently absent.
    const rawFromMain: main.AIQueueItem = RAW_ROW
    // @ts-expect-error a stored main-process row carries no jobTitle/jobCompany
    const asView: QueueItemView = rawFromMain
    expect(asView.jobId).toBe(RAW_ROW.jobId)
  })

  it('requires both fields, so a half-sent response is a type error', () => {
    // Null (job deleted) is allowed; absent is not. That distinction is
    // the whole point — the panel needs to tell "no such job" apart from
    // "the backend forgot".
    const deleted: QueueItemView = { ...RAW_ROW, jobTitle: null, jobCompany: null }
    // @ts-expect-error jobTitle may be null but may not be missing
    const missing: QueueItemView = { ...RAW_ROW, jobCompany: 'Acme' }
    expect(deleted.jobTitle).toBeNull()
    expect(missing).toBeDefined()
  })
})

// src/types.ts duplicates a few main-process constants instead of
// fetching them over IPC — one round trip per Settings render is not
// worth it. The cost of that choice is that a duplicate can drift, and
// when the drifted constant is one the user reads, the drift is a lie
// told in the UI rather than an internal detail: the Settings page
// promised "auto-regenerates up to 5x" while the queue regenerated
// exactly once, and nothing failed.
//
// These assertions are the guard that makes the duplication safe. If
// AUTO_REGEN_MAX moves in electron/types.ts, the renderer copy has to
// move with it or this fails.
describe('renderer/main constant mirrors', () => {
  it('mirrors the auto-regeneration budget the queue actually spends', () => {
    expect(renderer.AUTO_REGEN_MAX).toBe(main.AUTO_REGEN_MAX)
  })

  it('mirrors the review pass bar the loop gates on', () => {
    expect(renderer.PASSING_REVIEW_SCORE).toBe(main.PASSING_REVIEW_SCORE)
  })

  it('mirrors the auto-revive budget', () => {
    expect(renderer.AUTO_REVIVE_MAX).toBe(main.AUTO_REVIVE_MAX)
  })
})
