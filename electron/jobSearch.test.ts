import { describe, it, expect } from 'vitest'
import { normalizeLocations } from './jobSearch'
import type { LocationPick } from './types'

describe('normalizeLocations', () => {
  it('returns [] when both sources are empty/undefined', () => {
    expect(normalizeLocations(undefined, undefined)).toEqual([])
    expect(normalizeLocations([], [])).toEqual([])
  })

  it('prefers filters.locations over settings', () => {
    const filters: LocationPick[] = [{ id: 'a', display: 'Vancouver, BC, CA' }]
    const settings: LocationPick[] = [{ id: 'b', display: 'London, UK' }]
    expect(normalizeLocations(filters, settings)).toEqual(filters)
  })

  it('falls back to settings when filters.locations is missing', () => {
    const settings: LocationPick[] = [{ id: 'b', display: 'London, UK' }]
    expect(normalizeLocations(undefined, settings)).toEqual(settings)
  })

  it('trims display and drops empties', () => {
    expect(
      normalizeLocations(
        [
          { id: 'a', display: '  Vancouver, BC, CA  ' },
          { id: undefined, display: '   ' },
        ],
        undefined
      )
    ).toEqual([{ id: 'a', display: 'Vancouver, BC, CA' }])
  })

  it('dedups canonical picks by id', () => {
    const picks: LocationPick[] = [
      { id: 'a', display: 'Vancouver, BC, CA' },
      { id: 'a', display: 'Vancouver, BC, CA' },
    ]
    expect(normalizeLocations(picks, undefined)).toEqual([
      { id: 'a', display: 'Vancouver, BC, CA' },
    ])
  })

  it('dedups free text case-insensitively', () => {
    const picks: LocationPick[] = [
      { id: undefined, display: 'Remote' },
      { id: undefined, display: 'remote' },
      { id: undefined, display: 'REMOTE' },
    ]
    expect(normalizeLocations(picks, undefined)).toEqual([
      { id: undefined, display: 'Remote' },
    ])
  })

  it('keeps a full location with internal commas intact', () => {
    const picks: LocationPick[] = [
      { id: undefined, display: 'Vancouver, British Columbia, Canada' },
    ]
    expect(normalizeLocations(picks, undefined)).toEqual(picks)
  })
})
