import { describe, it, expect, vi } from 'vitest'
import { enforceOnePageCeilings } from './cvOnePage'

describe('enforceOnePageCeilings', () => {
  it('caps Experience entries to 4, keeping the first 4', () => {
    const exp = (n: number) => `Role ${n}\tCity, ST\nTitle ${n}\tJan 2024 – Present\n- Did thing ${n}\n- Did other thing ${n}\n- Did another ${n}\n- Did final ${n}\n`
    const md = `Name\nemail@example.com\n\nEXPERIENCE\n${exp(1)}${exp(2)}${exp(3)}${exp(4)}${exp(5)}${exp(6)}${exp(7)}\n`
    const out = enforceOnePageCeilings(md)
    // Roles 1-4 kept
    expect(out).toMatch(/Role 1\b/)
    expect(out).toMatch(/Role 4\b/)
    // Roles 5-7 dropped
    expect(out).not.toMatch(/Role 5\b/)
    expect(out).not.toMatch(/Role 6\b/)
    expect(out).not.toMatch(/Role 7\b/)
  })

  it('caps bullets per Experience entry to 4', () => {
    const md = `Name\nemail\n\nEXPERIENCE\nRole A\tCity\nTitle\tJan 2024 – Present\n- b1\n- b2\n- b3\n- b4\n- b5\n- b6\n\nEDUCATION\nSchool\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toMatch(/- b1/)
    expect(out).toMatch(/- b4/)
    expect(out).not.toMatch(/- b5/)
    expect(out).not.toMatch(/- b6/)
  })

  it('caps Leadership & Activities to 2 entries', () => {
    const entry = (n: number) => `Org ${n}\tCity, ST\nTitle ${n}\tJan 2024 – Present\n- bullet\n`
    const md = `Name\nemail\n\nLEADERSHIP & ACTIVITIES\n${entry(1)}${entry(2)}${entry(3)}${entry(4)}\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toMatch(/Org 1\b/)
    expect(out).toMatch(/Org 2\b/)
    expect(out).not.toMatch(/Org 3\b/)
    expect(out).not.toMatch(/Org 4\b/)
  })

  it('caps Skills & Interests lines to 6', () => {
    const md = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b, c\nLanguage: x, y, z\nLaboratory: p, q, r\nInterests: foo, bar, baz\nExtra: 1, 2, 3\nAnother: 4, 5, 6\nYet: 7, 8, 9\nFinal: 10, 11, 12\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toMatch(/Technical: a, b, c/)
    expect(out).toMatch(/Another: 4, 5, 6/)
    expect(out).not.toMatch(/Yet: 7/)
    expect(out).not.toMatch(/Final: 10/)
  })

  it('truncates Education to at most 4 lines', () => {
    const md = `Name\nemail\n\nEDUCATION\nSchool 1\nDegree 1\nSchool 2\nDegree 2\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toMatch(/School 1/)
    expect(out).toMatch(/Degree 1/)
    expect(out).toMatch(/School 2/)
    expect(out).toMatch(/Degree 2/)
  })

  it('drops Education content beyond the 4-line cap', () => {
    const md = `Name\nemail\n\nEDUCATION\nSchool 1\nDegree 1\nSchool 2\nDegree 2\nSchool 3\nDegree 3\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toMatch(/School 1/)
    expect(out).toMatch(/Degree 2/)
    expect(out).not.toMatch(/School 3/)
    expect(out).not.toMatch(/Degree 3/)
  })

  it('leaves content under all ceilings unchanged', () => {
    const md = `Name\nemail@example.com\n\nEXPERIENCE\nRole A\tCity\nTitle\tJan 2024 – Present\n- bullet\n\nEDUCATION\nSchool A\n`
    const out = enforceOnePageCeilings(md)
    expect(out).toBe(md)
  })

  it('emits a console-style log when culling occurs', () => {
    const log = vi.fn()
    const md = `Name\nemail\n\nEXPERIENCE\n${[1,2,3,4,5,6,7].map(n => `Role ${n}\tCity\nTitle ${n}\tJan 2024 – Present\n- bullet\n`).join('')}\n`
    enforceOnePageCeilings(md, { log })
    expect(log).toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toMatch(/experience/)
    expect(log.mock.calls[0][0]).toMatch(/7/)
    expect(log.mock.calls[0][0]).toMatch(/4/)
  })

  it('does not log when nothing is culled', () => {
    const log = vi.fn()
    const md = `Name\nemail\n\nEDUCATION\nSchool\n`
    enforceOnePageCeilings(md, { log })
    expect(log).not.toHaveBeenCalled()
  })
})
