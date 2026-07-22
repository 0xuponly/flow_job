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
  const lines = raw.split('\n')
  const entries: ErrorBucket[] = []
  for (const line of lines) {
    const bucket = classifyLine(line)
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
  // first line with any trailing colon stripped, ending in a period.
  return raw.split('\n')[0].replace(/:+\s*$/, '') + '.'
}
