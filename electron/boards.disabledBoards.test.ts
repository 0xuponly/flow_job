import { describe, it, expect } from 'vitest'
import { BOARDS, DEFAULT_DISABLED_BOARDS, unionDisabledBoards } from './boards'

describe('DEFAULT_DISABLED_BOARDS', () => {
  // These 5 boards were Cloudflare-walled in every scan (per-listing 403s
  // stalled runs for hours). The names must match `BOARDS[].name` exactly —
  // a rename here without a matching rename in BOARDS would silently
  // re-enable the board and reintroduce the stalls.
  it('names exactly the 5 walled boards, each matching a BOARDS entry', () => {
    expect(DEFAULT_DISABLED_BOARDS).toEqual([
      'Startup.jobs',
      'Monster',
      'Crypto.jobs',
      'CryptoJobsList',
      'Contra'
    ])
    const names = new Set(BOARDS.map((b) => b.name))
    for (const name of DEFAULT_DISABLED_BOARDS) {
      expect(names.has(name)).toBe(true)
    }
  })
})

describe('unionDisabledBoards', () => {
  it('adds all 5 defaults to an empty (pre-1ca07d9 install) list', () => {
    expect(unionDisabledBoards([], DEFAULT_DISABLED_BOARDS)).toEqual(DEFAULT_DISABLED_BOARDS)
  })

  it('preserves user-disabled extras and adds missing defaults without dupes', () => {
    const existing = ['Indeed (RSS)', 'Monster']
    const next = unionDisabledBoards(existing, DEFAULT_DISABLED_BOARDS)
    expect(next).toContain('Indeed (RSS)')
    for (const d of DEFAULT_DISABLED_BOARDS) expect(next).toContain(d)
    expect(next.filter((n) => n === 'Monster')).toHaveLength(1)
  })

  it('is idempotent: a list already containing all defaults is unchanged', () => {
    const existing = ['Contra', 'Monster', 'Crypto.jobs', 'CryptoJobsList', 'Startup.jobs']
    expect(unionDisabledBoards(existing, DEFAULT_DISABLED_BOARDS)).toEqual(existing)
  })

  it('does not mutate the input array', () => {
    const existing: string[] = []
    unionDisabledBoards(existing, DEFAULT_DISABLED_BOARDS)
    expect(existing).toEqual([])
  })
})
