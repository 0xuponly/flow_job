import { describe, it, expect } from 'vitest'
import { normalizeLocations, BOARDS } from './jobSearch'
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

describe('BOARDS config', () => {
  it('has RareRoles with apiFetcher', () => {
    const board = BOARDS.find((b) => b.name === 'RareRoles')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(false)
    expect(board!.apiFetcher).toBeDefined()
  })

  it('has Flexa with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Flexa')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    expect(board!.apiFetcher).toBeUndefined()
  })

  it('RareRoles searchUrl encodes keywords', () => {
    const board = BOARDS.find((b) => b.name === 'RareRoles')
    const url = board!.searchUrl('data engineer', '')
    expect(url).toContain('q=data%20engineer')
    expect(url).toMatch(/^https:\/\/www\.rareroles\.com\//)
  })

  it('Flexa searchUrl encodes keywords', () => {
    const board = BOARDS.find((b) => b.name === 'Flexa')
    const url = board!.searchUrl('react developer', '')
    expect(url).toContain('q=react%20developer')
    expect(url).toMatch(/^https:\/\/flexa\.careers\//)
  })
})
