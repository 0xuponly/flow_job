// Pure, deterministic status rule for how documents drive a job's status.
// No I/O, no Electron imports — safe to import from vitest and anywhere.
//
// Rule (as of the manual-status change):
//   - Never overwrite a protected status: anything the user (or an
//     applied-flow) has moved past the doc pipeline — applied,
//     interviewing, offer, rejected, withdrawn — and also 'ready':
//     once a job is Ready, regenerating or re-verifying documents must
//     never yank it back down. Doc recompute only ever moves jobs
//     between 'sourced' and 'reviewing'.
//   - Both a CV and a cover letter exist -> 'reviewing'. Verification
//     scores NO LONGER promote to 'ready' automatically: 'ready' means
//     the USER reviewed the documents and moved the job forward. A job
//     becomes 'ready' only via an explicit user action (Pipeline drag,
//     JobDetail status select), which sets the manual_status flag.
//   - No docs (or only one of the two) -> 'sourced'.
//
// Manual statuses: database.updateJob sets manual_status=1 whenever the
// user (or a user-driven flow) sets a status explicitly. recompute skips
// jobs with manual_status set entirely — a later doc regeneration or
// re-verification must never yank the user's chosen status back.

export const DOC_PROTECTED_STATUSES = [
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  // 'ready' is user-owned: verification must never promote INTO it, and
  // doc recompute must never demote OUT of it.
  'ready'
] as const

export interface DocPresence {
  hasCv: boolean
  hasCl: boolean
  /** verification_score >= 70 for each doc (ignored by the rule now,
   * kept in the shape so callers can pass what they have). */
  cvVerified: boolean
  clVerified: boolean
}

export function isDocProtected(status: string): boolean {
  return (DOC_PROTECTED_STATUSES as readonly string[]).includes(status)
}

/**
 * Returns the status a job should move to based on its documents, or
 * null when the current status should be left alone (protected, or the
 * rule produces the same status).
 */
export function nextStatusFromDocs(
  current: string,
  docs: DocPresence
): 'sourced' | 'reviewing' | 'ready' | null {
  if (isDocProtected(current)) return null
  if (!docs.hasCv || !docs.hasCl) {
    // No docs yet, or only one of CV/cover letter exists. Stay in
    // Sourced — Reviewing only kicks in once BOTH documents have been
    // generated, even before verification passes.
    return 'sourced'
  }
  // Both documents exist. Verification quality is surfaced via the
  // per-document rule checks and score badge — not by auto-promoting
  // the pipeline status. The user promotes to Ready themselves.
  return 'reviewing'
}
