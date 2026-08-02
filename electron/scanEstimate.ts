import { BOARDS } from './boards'
import { getBoardScanTimes } from './database'

// Concurrency model for the scan pipeline. Hoisted here from
// scanAllBoards so the estimator and the scheduler share one source
// of truth. HTTP boards run wider (cheap I/O, no Chrome process) than
// browser boards (each opens a fresh BrowserWindow, ~200MB+).
export const BOARD_CONCURRENCY_HTTP = 6
export const BOARD_CONCURRENCY_BROWSER = 3

/**
 * Wall-clock model for one track: boards run in chunks of `concurrency`;
 * all boards in a chunk run in parallel, chunks run sequentially. The
 * slowest board in a chunk gates that chunk, so track time is the sum of
 * per-chunk maxima. Input order is the scan's board order.
 */
export function estimateTrackMs(avgTimesMs: number[], concurrency: number): number {
  let total = 0
  for (let i = 0; i < avgTimesMs.length; i += concurrency) {
    let chunkMax = 0
    const end = Math.min(i + concurrency, avgTimesMs.length)
    for (let j = i; j < end; j++) {
      if (avgTimesMs[j] > chunkMax) chunkMax = avgTimesMs[j]
    }
    total += chunkMax
  }
  return total
}

/**
 * Estimated wall-clock time for scanning `boardNames`, or null when any
 * selected board has no recorded scan time yet (a silent partial sum
 * would understate the estimate). Per-board estimate is the simple mean
 * of its recorded durations. Boards split into http/browser tracks, each
 * modeled by `estimateTrackMs`; the tracks run in parallel, so the
 * estimate is the max of the two track times.
 */
export function computeScanEstimate(boardNames: string[]): number | null {
  const times = getBoardScanTimes()
  const byName = new Map(BOARDS.map((b) => [b.name, b]))
  const selected = boardNames
    .map((n) => byName.get(n))
    .filter((b): b is NonNullable<typeof b> => Boolean(b))

  const avgs: { avgMs: number; useBrowser: boolean }[] = []
  for (const board of selected) {
    const history = times[board.name]
    if (!history || history.length === 0) return null
    const avgMs = history.reduce((a, b) => a + b, 0) / history.length
    avgs.push({ avgMs, useBrowser: board.useBrowser })
  }
  if (avgs.length === 0) return null

  const http = estimateTrackMs(
    avgs.filter((a) => !a.useBrowser).map((a) => a.avgMs),
    BOARD_CONCURRENCY_HTTP
  )
  const browser = estimateTrackMs(
    avgs.filter((a) => a.useBrowser).map((a) => a.avgMs),
    BOARD_CONCURRENCY_BROWSER
  )
  return Math.max(http, browser)
}
