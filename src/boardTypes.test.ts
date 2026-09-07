import { describe, it, expect } from 'vitest'
import { groupOf, groupSelection, expandFailingToGroups, isFrequentErrorBoard } from './boardTypes'

describe('groupOf', () => {
  it('maps variants to their canonical group', () => {
    expect(groupOf('Indeed (RSS)')).toBe('Indeed')
    expect(groupOf('Indeed Canada (RSS)')).toBe('Indeed Canada')
    expect(groupOf('ZipRecruiter (RSS)')).toBe('ZipRecruiter')
    expect(groupOf('We Work Remotely (RSS)')).toBe('We Work Remotely')
    expect(groupOf('Remotive (API)')).toBe('Remotive')
    expect(groupOf('WorkBC (API)')).toBe('WorkBC')
    expect(groupOf('Job Bank GC (API)')).toBe('Job Bank (GC)')
  })

  it('keeps canonical names in their own group', () => {
    expect(groupOf('Indeed')).toBe('Indeed')
    expect(groupOf('WorkBC')).toBe('WorkBC')
  })

  it('returns the name itself for boards without a variant', () => {
    expect(groupOf('LinkedIn')).toBe('LinkedIn')
    expect(groupOf('Monster')).toBe('Monster')
  })
})

describe('groupSelection', () => {
  const boards = [
    { name: 'Indeed' },
    { name: 'Indeed (RSS)' },
    { name: 'LinkedIn' },
    { name: 'Monster' }
  ]

  it('counts one checkbox per group', () => {
    expect(groupSelection(boards, new Set<string>())).toEqual({ selected: 0, total: 3 })
  })

  it('counts a group selected only when every member is selected', () => {
    // Only the RSS variant selected → the group reads as unselected
    // (the picker shows it unchecked; one click completes it).
    expect(groupSelection(boards, new Set(['Indeed (RSS)']))).toEqual({ selected: 0, total: 3 })
    expect(groupSelection(boards, new Set(['Indeed', 'Indeed (RSS)']))).toEqual({ selected: 1, total: 3 })
  })

  it('counts single-member groups normally', () => {
    expect(groupSelection(boards, new Set(['LinkedIn', 'Monster']))).toEqual({ selected: 2, total: 3 })
    expect(groupSelection(boards, new Set(['Indeed', 'Indeed (RSS)', 'LinkedIn', 'Monster']))).toEqual({ selected: 3, total: 3 })
  })

  it('ignores names not in the board list', () => {
    expect(groupSelection(boards, new Set(['Nope']))).toEqual({ selected: 0, total: 3 })
  })
})

describe('expandFailingToGroups', () => {
  const boards = [
    { name: 'Indeed' },
    { name: 'Indeed (RSS)' },
    { name: 'LinkedIn' },
    { name: 'Monster' }
  ]

  it('expands a failing variant to every member of its group', () => {
    // The red flag is group-level (any member failing makes the
    // checkbox red), so the +/- Errors button must toggle the whole
    // checkbox unit — otherwise the group stays partially selected
    // and reads as unchecked.
    expect(expandFailingToGroups(['Indeed (RSS)'], boards)).toEqual(['Indeed', 'Indeed (RSS)'])
  })

  it('keeps single-member failing boards as themselves', () => {
    expect(expandFailingToGroups(['Monster'], boards)).toEqual(['Monster'])
  })

  it('expands multiple failing boards, deduped and sorted', () => {
    expect(expandFailingToGroups(['Monster', 'Indeed (RSS)'], boards))
      .toEqual(['Indeed', 'Indeed (RSS)', 'Monster'])
  })

  it('drops failing names that are not in the picker list (disabled/settings-off)', () => {
    expect(expandFailingToGroups(['Monster', 'GhostBoard'], boards)).toEqual(['Monster'])
    expect(expandFailingToGroups(['Indeed (RSS)'], [{ name: 'Monster' }])).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(expandFailingToGroups([], boards)).toEqual([])
  })
})

describe('isFrequentErrorBoard (red flag = 2+ consecutive errored scans)', () => {
  // Red means "errored on the last 2 or more consecutive scans" —
  // strictly negative entries, newest at the END of the array
  // (recordBoardResults pushes). A 0 entry (scan ran fine, found no
  // jobs) breaks the streak and must NOT keep the board red
  // (regression 2026-09-06: zero-find boards stayed red forever under
  // the old "last 3 all <= 0" rule).
  it('red after 2 consecutive errored scans (newest last)', () => {
    expect(isFrequentErrorBoard([-1, -1])).toBe(true)
    expect(isFrequentErrorBoard([-1, 5, -1, -1])).toBe(true)
    expect(isFrequentErrorBoard([-1, -1, 4, -1, -1])).toBe(true)
  })

  it('not red for 0 or 1 errored scan', () => {
    expect(isFrequentErrorBoard([])).toBe(false)
    expect(isFrequentErrorBoard([-1])).toBe(false)
  })

  it('zero-find scan breaks the streak (finding no jobs is not an error)', () => {
    // oldest → newest: errored, errored, then a clean zero-find scan
    expect(isFrequentErrorBoard([-1, -1, 0])).toBe(false)
    expect(isFrequentErrorBoard([-1, -1, 0, -1, -1])).toBe(true)
    expect(isFrequentErrorBoard([0, -1, -1])).toBe(true)
  })

  it('positive entry breaks the streak', () => {
    expect(isFrequentErrorBoard([-1, -1, 3])).toBe(false)
    expect(isFrequentErrorBoard([-1, 3, -1])).toBe(false)
  })
})
