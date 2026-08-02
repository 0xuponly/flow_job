import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./database', () => ({
  getBoardScanTimes: vi.fn()
}))

import { getBoardScanTimes } from './database'
import { estimateTrackMs, computeScanEstimate, BOARD_CONCURRENCY_HTTP, BOARD_CONCURRENCY_BROWSER } from './scanEstimate'

const mockGetBoardScanTimes = getBoardScanTimes as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockGetBoardScanTimes.mockReset()
})

describe('estimateTrackMs', () => {
  it('returns 0 for an empty track', () => {
    expect(estimateTrackMs([], 3)).toBe(0)
  })

  it('single board: returns its own avg', () => {
    expect(estimateTrackMs([1000], 6)).toBe(1000)
  })

  it('balanced boards: max of each chunk, summed', () => {
    // chunks: [1000, 2000] -> 2000, [1500] -> 1500
    expect(estimateTrackMs([1000, 2000, 1500], 2)).toBe(3500)
  })

  it('skewed boards: slow board dominates its chunk', () => {
    // chunks: [5000, 100] -> 5000, [100] -> 100
    expect(estimateTrackMs([5000, 100, 100], 2)).toBe(5100)
  })

  it('exact chunk boundary', () => {
    // chunks: [1, 2] -> 2, [3, 4] -> 4
    expect(estimateTrackMs([1, 2, 3, 4], 2)).toBe(6)
  })
})

describe('computeScanEstimate', () => {
  it('returns null when no board has recorded times', () => {
    mockGetBoardScanTimes.mockReturnValue({})
    expect(computeScanEstimate(['LinkedIn'])).toBeNull()
  })

  it('returns null when any selected board lacks data', () => {
    mockGetBoardScanTimes.mockReturnValue({
      LinkedIn: [60000, 120000]
    })
    expect(computeScanEstimate(['LinkedIn', 'Indeed'])).toBeNull()
  })

  it('combines http and browser tracks with max()', () => {
    // "Indeed (RSS)" is http (useBrowser:false), "LinkedIn" is browser.
    mockGetBoardScanTimes.mockReturnValue({
      'Indeed (RSS)': [120000],
      LinkedIn: [60000]
    })
    // http track: one board -> 120000. browser track: one board -> 60000.
    // estimate = max(120000, 60000) = 120000
    expect(computeScanEstimate(['LinkedIn', 'Indeed (RSS)'])).toBe(120000)
  })

  it('averages multiple times per board', () => {
    mockGetBoardScanTimes.mockReturnValue({
      'Indeed (RSS)': [100000, 140000] // avg 120000
    })
    expect(computeScanEstimate(['Indeed (RSS)'])).toBe(120000)
  })

  it('chunks within a track using the track concurrency', () => {
    // Three http boards (useBrowser:false), all in the registry:
    // "Indeed (RSS)", "Remotive", "Monster".
    mockGetBoardScanTimes.mockReturnValue({
      'Indeed (RSS)': [1000],
      Remotive: [2000],
      Monster: [3000]
    })
    // http track chunks of 6 -> single chunk -> max 3000.
    expect(computeScanEstimate(['Indeed (RSS)', 'Remotive', 'Monster'])).toBe(3000)
  })

  it('exposes the expected concurrency constants', () => {
    expect(BOARD_CONCURRENCY_HTTP).toBe(6)
    expect(BOARD_CONCURRENCY_BROWSER).toBe(3)
  })
})
