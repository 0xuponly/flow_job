import { describe, it, expect } from 'vitest'
import { groupOf, groupSelection, expandFailingToGroups } from './boardTypes'

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
