import {
  tailorDocument,
  ProviderCapError,
  ProviderCooldownError,
  type AiCallOptions
} from './ai'
import {
  enforceAllCvCeilings,
  enforceParagraphCeilings,
  runDocumentRuleChecks,
  type RuleCheck
} from '../src/documentRules'
import {
  getJob,
  setDocumentContent,
  writeTailorTimingFields
} from './database'
import { log } from './logger'

export interface TailorJobDocsResult {
  cvId: number
  clId: number
  ms_cv: number
  ms_cl: number
  /**
   * The lane the PROVIDER refused — a model cooldown or a spent budget —
   * when it refused one and the other lane still built its document.
   *
   * Null in every other case, including both ordinary failures and the
   * case where a refusal built nothing at all: that one is thrown, not
   * returned (see `tailorJobDocsForJob`), so there is no result for the
   * caller to read a field off.
   *
   * It exists for one decision in `aiQueue.ts`'s `tailor_job_docs` case:
   * a refusal is not a failure, so the lane it refused is still OWED, and
   * the queue hands it to the per-unit row that owns that one document.
   * An ordinary failure is not owed anything — it gets the bounded retry
   * ladder its own row already has, and re-queueing it here would spend
   * tokens on a posting the model has already refused twice.
   */
  refused: 'cv' | 'cover_letter' | null
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

/**
 * The ONE post-generation sanitization step: paragraph ceilings for a cover
 * letter, `enforceAllCvCeilings` for a CV, then `runDocumentRuleChecks` over
 * the sanitized text.
 *
 * It lives here because the both-documents unit was its only caller for the
 * whole of the per-unit era, and moving the fit-landing trigger onto
 * `generate_cv` / `generate_cover_letter` left those lanes storing the raw
 * provider prose — unsanitized content reaching the user's Documents view.
 * The per-unit processor cases now call THIS function, so the ceilings and
 * the rule checks cannot be restated, and drift, in a second place.
 *
 * Exported for that reason only. It is deliberately NOT part of
 * `tailorJobDocsForJob`'s contract, and it performs no I/O: storing the
 * sanitized text onto the row the model call created is the caller's job
 * (`setDocumentContent`).
 */
export function sanitizeDocument(
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

export async function tailorJobDocsForJob(jobId: number, opts?: AiCallOptions): Promise<TailorJobDocsResult> {
  const job = getJob(jobId)
  if (!job) {
    log.tailor.warn('dropped_missing_job', { jobId })
    throw new Error(`Job ${jobId} not found`)
  }

  const [cv, cl] = await Promise.all([
    timed(() => tailorDocument({ job_id: jobId, document_type: 'cv' }, opts), 'cv', jobId),
    timed(() => tailorDocument({ job_id: jobId, document_type: 'cover_letter' }, opts), 'cl', jobId)
  ])

  const cvFailed = cv.result == null
  const clFailed = cl.result == null

  // A lane the app refused to ask is not a failed document, so it is not
  // logged as one. `lane_refused` says the pool said no; `cv_failed` /
  // `cl_failed` say the call happened and produced nothing.
  if (cv.refusal || cl.refusal) {
    log.tailor.warn('lane_refused', {
      jobId,
      lanes: [cv.refusal ? 'cv' : null, cl.refusal ? 'cl' : null].filter(Boolean)
    })
  } else if (cvFailed || clFailed) {
    log.tailor.error(cvFailed ? 'cv_failed' : 'cl_failed', { jobId })
  }

  const jobDescription = job.description ?? ''

  // ONE write per document, and it already happened.
  //
  // `tailorDocument` ends a first generation by calling `createDocument`
  // (ai.ts), which PUSHES the row, and it returns that row's id. This
  // function then called `writeDocuments`, which inserted a SECOND row for
  // the same document: one tailoring call, two `cv` rows, two
  // `cover_letter` rows, one of each orphaned — never in the review chain,
  // never deleted, and `recomputeJobStatusFromDocs` and the Documents view
  // seeing two of everything for one generation.
  //
  // What is left to store is the SANITIZED content (paragraph ceilings and
  // rule checks, which run after the model returns and so cannot have been
  // applied by `tailorDocument`), written back onto the row the model call
  // created. `setDocumentContent` returns null if the user deleted the
  // document in the gap, and that is left as-is: writing a replacement
  // would resurrect it behind their back.
  //
  // A document that FAILED leaves no row at all, because `tailorDocument`
  // throws before `createDocument` — which is what makes "write whatever
  // succeeded" still true, and is what the old `cvFailed && clFailed`
  // branch was for.
  const cvContent =
    cv.result ? sanitizeDocument(cv.result.content, 'cv', jobDescription).content : null
  const clContent =
    cl.result ? sanitizeDocument(cl.result.content, 'cover_letter', jobDescription).content : null
  const cvId = cvContent ? (setDocumentContent(cv.result!.document_id, cvContent)?.id ?? 0) : 0
  const clId = clContent ? (setDocumentContent(cl.result!.document_id, clContent)?.id ?? 0) : 0

  // A REFUSAL, and nothing built. This is the case that used to be
  // swallowed: `timed` returned `{ result: null, error }` like any other
  // failure, this function wrote `generatedAt: null` and returned normally,
  // and `aiQueue`'s `tailor_job_docs` case read that as success —
  // `removeAIQueueItem`, the row gone, the work gone with it, and no
  // `verify` chained. A provider that was asked nothing at all left the
  // queue with nothing to show for it, which is the same bug the
  // generate / review / score_fit lanes had and fixed by letting the
  // refusal out with its TYPE intact.
  //
  // So it is let out, here rather than inside `timed`, because only this
  // function knows whether the pair built anything. Two properties make it
  // safe to leave now, and both are the point:
  //
  //   - Nothing was written to the job. `writeTailorTimingFields` is
  //     skipped ENTIRELY, not called with `generatedAt: null`: a refusal
  //     spent nothing, measured nothing and broke nothing, and this write
  //     is the user's "documents built at" stamp — passing null here is
  //     what erased the real stamp of a perfectly good CV, and it is why
  //     `aiQueue`'s cap branch keeps a cap out of this surface entirely.
  //     The row's own `lastError` is where "no provider available" belongs.
  //   - The consumer is `processItem`'s FIRST branch, which parks the row
  //     on the provider's clock without touching `attempts` or
  //     `autoRevives`. So the work is still owed, it is still on the queue,
  //     and nothing was charged for standing still.
  const refusal = cv.refusal ?? cl.refusal
  if (refusal !== null && cvId === 0 && clId === 0) {
    throw refusal
  }

  // Every other failure, and the refused-lane-but-something-built case
  // below, keep the write this function has always done: the measured
  // milliseconds, `generatedAt: null` because the pair is incomplete, and
  // the reason on the job. A refusal is reported there like any other
  // reason — the document the user is missing is a real gap, and leaving
  // it unmentioned would be the worse of the two.
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

  // The lane that was refused while its sibling built. The caller hands it
  // to the per-unit row that owns that one document: this row is the
  // BOTH-documents unit and it is about to be retired, and a retired pair
  // row with a missing half is work nobody owns — the backlog sweep asks
  // `autoDocQueueEligible` first, and a job whose one landed document goes
  // on to pass its review is `shippable`, so the sweep never asks about
  // the document that is missing. Naming the refused lane is what stops
  // that.
  let refused: 'cv' | 'cover_letter' | null = null
  if (cv.refusal !== null) refused = 'cv'
  else if (cl.refusal !== null) refused = 'cover_letter'

  return { cvId, clId, ms_cv: cv.ms, ms_cl: cl.ms, refused }
}

/**
 * Is this the app declining to ASK, rather than a call that failed?
 *
 * `ProviderCooldownError` (every eligible model is inside its cooldown
 * window) and `ProviderCapError` (the account's budget for this window is
 * spent) both mean the provider was never contacted: no request, no
 * tokens, no quota. Every other throw is a call that happened and did not
 * produce a document.
 *
 * Matched by TYPE, deliberately. `err.name === 'ProviderCooldownError'`
 * would pass the same tests and is the defect this repo has already fixed
 * once — a lane that recognized the refusal by its string spent the retry
 * budget on a map lookup, and the symptom reached the queue as an ordinary
 * `Error` (see the note on `score_fit` in fitScorer.ts).
 */
function isProviderRefusal(err: unknown): ProviderCooldownError | ProviderCapError | null {
  if (err instanceof ProviderCooldownError) return err
  if (err instanceof ProviderCapError) return err
  return null
}

interface LaneOutcome<T> {
  result: T | null
  ms: number
  error?: string
  /**
   * The refusal itself when the lane failed that way, so the caller can
   * rethrow THIS error rather than a string that would no longer be
   * recognizable on the far side.
   */
  refusal: ProviderCooldownError | ProviderCapError | null
}

/**
 * One document lane, timed, and never throwing.
 *
 * The pair is the whole difficulty here. Both lanes start together, and
 * `Promise.all` rejects on the FIRST rejection — so a `timed` that threw
 * would abandon the sibling mid-flight: its `tailorDocument` call would go
 * on to `createDocument` and PUSH a row holding raw, unsanitized provider
 * prose, with nothing left to write the sanitized text onto it and nothing
 * left to enqueue its review. One request billed, one orphaned document,
 * every time the pool rotated between the two lanes.
 *
 * So this catches everything and reports it, and `tailorJobDocsForJob`
 * decides what a refusal means after BOTH lanes have settled. Every other
 * failure keeps the behaviour this function has always had: recorded, and
 * swallowed, so "write whatever succeeded" still holds.
 */
async function timed<T>(
  fn: () => Promise<T>,
  _kind: 'cv' | 'cl',
  _jobId: number
): Promise<LaneOutcome<T>> {
  const t0 = Date.now()
  try {
    const result = await fn()
    return { result, ms: Date.now() - t0, refusal: null }
  } catch (err) {
    return {
      result: null,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      refusal: isProviderRefusal(err)
    }
  }
}
