import { describe, expect, it } from 'vitest'
import {
  DOC_PROTECTED_STATUSES,
  nextStatusFromDocs,
  type DocPresence
} from './docStatus'

function docs(partial: Partial<DocPresence> = {}): DocPresence {
  return { hasCv: false, hasCl: false, cvVerified: false, clVerified: false, ...partial }
}

describe('nextStatusFromDocs', () => {
  it('returns sourced when no docs exist', () => {
    expect(nextStatusFromDocs('sourced', docs())).toBe('sourced')
  })

  it('returns sourced when only one of CV/cover letter exists', () => {
    expect(nextStatusFromDocs('sourced', docs({ hasCv: true }))).toBe('sourced')
    expect(nextStatusFromDocs('sourced', docs({ hasCl: true }))).toBe('sourced')
  })

  it('moves sourced -> reviewing once both docs exist, regardless of verification', () => {
    expect(nextStatusFromDocs('sourced', docs({ hasCv: true, hasCl: true }))).toBe('reviewing')
    expect(
      nextStatusFromDocs('sourced', docs({ hasCv: true, hasCl: true, cvVerified: true, clVerified: true }))
    ).toBe('reviewing')
  })

  it('NEVER auto-promotes to ready from verification scores', () => {
    // The old behavior: both docs verified >=70 => 'ready'. Verification
    // quality must not auto-promote the pipeline status anymore.
    const bothVerified = docs({ hasCv: true, hasCl: true, cvVerified: true, clVerified: true })
    expect(nextStatusFromDocs('reviewing', bothVerified)).toBe('reviewing')
    expect(nextStatusFromDocs('ready', bothVerified)).toBe(null) // leave alone
  })

  it('returns null for protected statuses (user moved past the pipeline)', () => {
    for (const s of DOC_PROTECTED_STATUSES) {
      expect(nextStatusFromDocs(s, docs({ hasCv: true, hasCl: true }))).toBe(null)
    }
  })

  it('returns null when the rule produces the current status (no-op)', () => {
    expect(nextStatusFromDocs('reviewing', docs({ hasCv: true, hasCl: true }))).toBe('reviewing')
    expect(nextStatusFromDocs('sourced', docs())).toBe('sourced')
  })
})
