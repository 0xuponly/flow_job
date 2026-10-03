// fit_last_error / result.error can be a multi-line dump of the form
//   "All N configured AI models are rate limited — try again in a minute:
//    <model>: <reason>
//    <model>: <reason>
//    ..."
// where <reason> is one of the labels below. The toast should show only a
// short summary so the user knows where to act (Settings → Models, or wait),
// not the full per-model dump. The full text is still on the job for
// inspection.
//
// Single-line error strings (non-AI errors that flow through the same
// notification path) keep the old first-line / trailing-colon behaviour.

type ErrorBucket = 'rate-limited' | 'auth-failed' | 'out-of-credits' | 'other'

const BUCKET_LABEL: Record<ErrorBucket, string> = {
  'rate-limited': 'rate limited',
  'auth-failed': 'auth-failed',
  'out-of-credits': 'out of credits',
  'other': 'other'
}

// Labels emitted by electron/ai.ts in the per-model error strings. Used to
// decide whether a line is part of a multi-model AI error dump; if none of
// these patterns match, the line is treated as a non-AI error and the
// caller falls back to the first-line behaviour.
const AI_ERROR_LABEL = /(?:^|\s)(rate limited \(429\)|payment required \(402\)|unauthorized \(401\)|forbidden \(403\)|not found \(404\)|HTTP [45]\d\d|timeout|empty response)/

function classifyLine(line: string): ErrorBucket | null {
  // The model name itself can contain a colon (e.g. "Cohere: North Mini
  // Code"), so we cannot split on the first ": " and trust the remainder.
  // Instead, scan the line for any of the leading label patterns the
  // AI loop emits in electron/ai.ts.
  if (!AI_ERROR_LABEL.test(line)) return null
  if (/(?:^|\s)rate limited \(429\)/.test(line)) return 'rate-limited'
  if (/(?:^|\s)payment required \(402\)/.test(line)) return 'out-of-credits'
  if (/(?:^|\s)unauthorized \(401\)|(?:^|\s)forbidden \(403\)/.test(line)) return 'auth-failed'
  return 'other'
}

function summarizeAiErrors(raw: string): string | null {
  const entries: ErrorBucket[] = []
  // `ai.ts` joins its per-model reasons two different ways, and the
  // rotation's size is exactly what the user was counting on screen:
  //
  //   newline-joined on the rate-limited branch (ai.ts:725)
  //   ' | '-joined on the all-failed branch    (ai.ts:739)
  //
  // Split on both. Counting per LINE made the ' | ' branch summarise to
  // "1 errors: 1 other" no matter how large the pool was, because the
  // whole rotation is one physical line there — a summary that hides the
  // scale of the failure is worse than no summary.
  for (const segment of raw.split(/\n|\s\|\s/)) {
    const bucket = classifyLine(segment)
    if (bucket !== null) entries.push(bucket)
  }
  if (entries.length === 0) return null

  const counts: Record<ErrorBucket, number> = {
    'rate-limited': 0,
    'auth-failed': 0,
    'out-of-credits': 0,
    'other': 0
  }
  for (const b of entries) counts[b]++

  // Preserve a stable display order: rate-limited, out-of-credits, auth-failed,
  // other — this matches the severity the user can act on (wait vs fix config).
  const order: ErrorBucket[] = ['rate-limited', 'out-of-credits', 'auth-failed', 'other']
  const parts = order
    .filter((b) => counts[b] > 0)
    .map((b) => `${counts[b]} ${BUCKET_LABEL[b]}`)

  return `${entries.length} errors: ${parts.join(', ')}.`
}

export function toastErrorSummary(raw: string): string {
  const ai = summarizeAiErrors(raw)
  if (ai !== null) return ai
  // Fallback: not a recognisable multi-model AI error dump — return the
  // first line with any trailing colon stripped, ending in a period. The
  // period is only added when there isn't one already: "No enabled AI
  // models configured." must not come out as "configured..".
  const first = raw.split('\n')[0].replace(/:+\s*$/, '')
  return /[.!?]$/.test(first) ? first : `${first}.`
}

/**
 * The message of a caught value, for feeding to `toastErrorSummary`.
 *
 * Every caller on the AI paths used to open-code
 * `err instanceof Error ? err.message : 'Unknown error'` inline, which
 * made it easy to forget the summary step: the message is only useful
 * summarised when it came from `tryModels`, and whether it did is not
 * knowable at the call site. Pairing the two here is what keeps the
 * per-model dump out of the toast at every AI call site.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}
