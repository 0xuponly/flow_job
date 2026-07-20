import { describe, it, expect } from 'vitest'
import { matchGradeFor } from './matchGrade'

describe('matchGradeFor', () => {
  it('returns null for null score', () => {
    expect(matchGradeFor(null)).toBeNull()
  })
  it('returns S for 0.9+', () => {
    expect(matchGradeFor(0.9)).toBe('S')
    expect(matchGradeFor(1.0)).toBe('S')
  })
  it('returns A for 0.75 to 0.8999', () => {
    expect(matchGradeFor(0.75)).toBe('A')
    expect(matchGradeFor(0.89)).toBe('A')
  })
  it('returns B for 0.6 to 0.7499', () => {
    expect(matchGradeFor(0.6)).toBe('B')
    expect(matchGradeFor(0.74)).toBe('B')
  })
  it('returns C for 0.45 to 0.5999', () => {
    expect(matchGradeFor(0.45)).toBe('C')
    expect(matchGradeFor(0.59)).toBe('C')
  })
  it('returns D for 0.3 to 0.4499', () => {
    expect(matchGradeFor(0.3)).toBe('D')
    expect(matchGradeFor(0.44)).toBe('D')
  })
  it('returns F for below 0.3', () => {
    expect(matchGradeFor(0.29)).toBe('F')
    expect(matchGradeFor(0.0)).toBe('F')
  })
})
