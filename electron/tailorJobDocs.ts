import { tailorDocument } from './ai'
import {
  enforceAllCvCeilings,
  enforceParagraphCeilings,
  runDocumentRuleChecks,
  type RuleCheck
} from '../src/documentRules'
import {
  getJob,
  writeDocuments,
  writeTailorTimingFields
} from './database'
import { log } from './logger'

export interface TailorJobDocsResult {
  cvId: number
  clId: number
  ms_cv: number
  ms_cl: number
}

function noopLog() {
  // intentionally empty — logging is opt-in via FLOW_JOB_VERBOSE
}


function pickErrorMessage(
  cvFailed: boolean,
  cvError: string | undefined,
  clFailed: boolean,
  clError: string | undefined
): string | null {
  if (cvFailed) return cvError ?? 'cv_failed'
  if (clFailed) return clError ?? 'cl_failed'
  return null
}

function sanitizeDocument(
  content: string,
  docType: 'cv' | 'cover_letter',
  jobDescription: string
): { content: string; rules: RuleCheck[] } {
  const verboseLog = process.env.FLOW_JOB_VERBOSE ? console.info : noopLog
  const sanitized = docType === 'cover_letter'
    ? enforceParagraphCeilings(content, { max: 4, log: verboseLog })
    : enforceAllCvCeilings(content, { jobDescription, log: verboseLog })

  const rules = runDocumentRuleChecks({
    document: sanitized,
    jobDescription,
    docType
  })
  const failed = rules.filter((r) => !r.passed)
  if (failed.length > 0) {
    verboseLog(
      `[tailor] ${docType} failed rule checks after sanitization: ${failed.map((r) => r.rule).join(', ')}`
    )
  }
  return { content: sanitized, rules }
}

export async function tailorJobDocsForJob(jobId: number): Promise<TailorJobDocsResult> {
  const job = getJob(jobId)
  if (!job) {
    log.tailor.warn('dropped_missing_job', { jobId })
    throw new Error(`Job ${jobId} not found`)
  }

  const [cv, cl] = await Promise.all([
    timed(() => tailorDocument({ job_id: jobId, document_type: 'cv' }), 'cv', jobId),
    timed(() => tailorDocument({ job_id: jobId, document_type: 'cover_letter' }), 'cl', jobId)
  ])

  const cvFailed = cv.result == null
  const clFailed = cl.result == null

  if (cvFailed || clFailed) {
    log.tailor.error(cvFailed ? 'cv_failed' : 'cl_failed', { jobId })
  }

  const jobDescription = job.description ?? ''
  const cvContent = cv.result
    ? sanitizeDocument(cv.result.content, 'cv', jobDescription).content
    : null
  const clContent = cl.result
    ? sanitizeDocument(cl.result.content, 'cover_letter', jobDescription).content
    : null

  // Atomic: write whatever docs succeeded + the timing fields + status.
  // If both failed, write neither doc and only the error fields.
  const ids = cvFailed && clFailed
    ? { cvId: 0, clId: 0 }
    : await writeDocuments({
        jobId,
        cvContent,
        clContent
      })

  await writeTailorTimingFields({
    jobId,
    ms_cv: cv.ms,
    ms_cl: cl.ms,
    generatedAt: !cvFailed && !clFailed ? Date.now() : null,
    lastError: pickErrorMessage(cvFailed, cv.error, clFailed, cl.error)
  })

  // Status is intentionally NOT set here. Generation no longer promotes
  // jobs to 'ready' (or any other status): the doc-derived recompute in
  // database.ts moves sourced -> reviewing once both docs exist, and
  // 'ready' is reserved for the user's own decision. main.ts triggers
  // recompute after the tailor IPC completes.

  return { cvId: ids.cvId, clId: ids.clId, ms_cv: cv.ms, ms_cl: cl.ms }
}

async function timed<T>(
  fn: () => Promise<T>,
  _kind: 'cv' | 'cl',
  _jobId: number
): Promise<{ result: T | null; ms: number; error?: string }> {
  const t0 = Date.now()
  try {
    const result = await fn()
    return { result, ms: Date.now() - t0 }
  } catch (err) {
    return {
      result: null,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
