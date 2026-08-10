import { describe, it, expect } from 'vitest'
import { normalizeLocations, BOARDS, nextConsecutiveBlocked } from './jobSearch'
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

  // New boards from the 2026-07-28 batch
  it('has FlexJobs with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'FlexJobs')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
  })

  it('has Dice with useBrowser and location param', () => {
    const board = BOARDS.find((b) => b.name === 'Dice')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('python', 'New York')
    expect(url).toContain('q=python')
    expect(url).toContain('location=New%20York')
  })

  it('has Work At A Startup with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Work At A Startup')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('engineer', '')
    expect(url).toContain('query=engineer')
  })

  it('has Virtual Vocations without useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Virtual Vocations')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(false)
    const url = board!.searchUrl('developer', '')
    expect(url).toContain('search=developer')
  })

  it('has PowerToFly with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'PowerToFly')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('sales', '')
    expect(url).toContain('keywords=sales')
  })

  it('has Behance Jobs with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Behance Jobs')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('designer', '')
    expect(url).toContain('search=designer')
  })

  it('has Pangian with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Pangian')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('developer', '')
    expect(url).toContain('q=developer')
  })

  it('has AI Jobs with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'AI Jobs')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('machine learning', '')
    expect(url).toContain('search=machine%20learning')
  })

  it('has Ladders with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Ladders')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('engineer', '')
    expect(url).toContain('q=engineer')
  })

  it('has Crossover with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Crossover')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('developer', '')
    expect(url).toContain('q=developer')
  })

  it('has Remote Rocketship with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Remote Rocketship')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
  })

  it('has Career Vault with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Career Vault')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('devops', '')
    expect(url).toContain('q=devops')
  })

  it('has Dribbble Jobs with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Dribbble Jobs')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('ui designer', '')
    expect(url).toContain('query=ui%20designer')
  })

  it('has Gun.io with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Gun.io')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
    const url = board!.searchUrl('python', '')
    expect(url).toContain('q=python')
  })

  it('has Toptal with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Toptal')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
  })

  it('has Freelancer with useBrowser', () => {
    const board = BOARDS.find((b) => b.name === 'Freelancer')
    expect(board).toBeDefined()
    expect(board!.useBrowser).toBe(true)
  })
})

describe('nextConsecutiveBlocked', () => {
  const err = (reason: string) => ({ status: 'fulfilled' as const, value: { action: 'error' as const, reason } })
  const ok = (action: 'added' | 'skipped' | 'incompatible') => ({ status: 'fulfilled' as const, value: { action } })

  it('advances the counter when a batch is fully errored with mixed blocked reasons', () => {
    // A blocked board fails heterogeneously: timeouts, aborts, empty
    // shells, Cloudflare. All must count.
    const results = [
      err('Scrape failed: TimeoutError: page.goto: Timeout 180000ms exceeded'),
      err('Scrape failed: NS_ERROR_ABORT: Load failed'),
      err('Scrape failed: Blocked by anti-bot protection (empty shell)'),
      err('Scrape failed: This site blocked automated access (Cloudflare). Open the job in your browser and try again later.'),
      err('Scrape failed: Timed out loading the job page.'),
      err('Scrape failed: HTTP 403 (blocked)')
    ]
    expect(nextConsecutiveBlocked(results, 0)).toBe(1)
    expect(nextConsecutiveBlocked(results, 2)).toBe(3)
  })

  it('does not count Create failed DB errors toward the blocked counter', () => {
    // A DB write failure says the board is fine — our database broke.
    const results = [err('Create failed: UNIQUE constraint failed: jobs.url')]
    expect(nextConsecutiveBlocked(results, 2)).toBe(0)
  })

  it('resets the counter when any listing succeeds', () => {
    const results = [
      err('Scrape failed: TimeoutError: page.goto: Timeout 180000ms exceeded'),
      ok('added'),
      err('Scrape failed: NS_ERROR_ABORT: Load failed')
    ]
    expect(nextConsecutiveBlocked(results, 2)).toBe(0)
  })

  it('returns 0 for an empty batch', () => {
    expect(nextConsecutiveBlocked([], 1)).toBe(0)
  })

  it('reaches the bailout threshold after 3 consecutive all-errored batches', () => {
    const batch = [err('Scrape failed: Timeout'), err('Scrape failed: NS_ERROR_ABORT')]
    let counter = 0
    counter = nextConsecutiveBlocked(batch, counter)
    counter = nextConsecutiveBlocked(batch, counter)
    counter = nextConsecutiveBlocked(batch, counter)
    expect(counter).toBe(3)
  })
})
