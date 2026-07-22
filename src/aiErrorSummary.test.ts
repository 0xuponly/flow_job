import { describe, it, expect } from 'vitest'
import { toastErrorSummary } from './aiErrorSummary'

const MIXED_LIVE_ERROR = `All 13 configured AI models are rate limited — try again in a minute:
DeepSeek Chat: payment required (402) — {"error":{"message":"Insufficient Balance","code":401}}
Big Pickle: rate limited (429)
DeepSeek V4 Flash: payment required (402) — {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 28997. To increase, visit https://openrouter.ai/settings/credits and
MiMo V2.5: rate limited (429)
Nemotron 3 Ultra: rate limited (429)
North Mini Code: rate limited (429)
Poolside: Laguna S 2.1: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
Poolside: Laguna XS 2.1: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
Cohere: North Mini Code: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
NVIDIA: Llama Nemotron Rerank VL 1B V2: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
NVIDIA: Nemotron 3.5 Content Safety: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
NVIDIA: Nemotron 3 Ultra: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}
OpenAI: gpt-oss-20b: unauthorized (401) — {"error":{"message":"Missing Authentication header","code":401}}`

describe('toastErrorSummary', () => {
  it('summarises a mixed-cause RateLimitError into a per-bucket count', () => {
    // 4 rate limited, 2 payment required, 7 unauthorized → all 13.
    const out = toastErrorSummary(MIXED_LIVE_ERROR)
    expect(out).toBe('13 errors: 4 rate limited, 2 out of credits, 7 auth-failed.')
  })

  it('omits buckets with zero count', () => {
    const only429 = `All 5 configured AI models are rate limited — try again in a minute:
a: rate limited (429)
b: rate limited (429)
c: rate limited (429)
d: rate limited (429)
e: rate limited (429)`
    expect(toastErrorSummary(only429)).toBe('5 errors: 5 rate limited.')
  })

  it('counts forbidden (403) and HTTP 5xx as "other" rather than dropping them', () => {
    const mixed = `All 4 configured AI models are rate limited — try again in a minute:
a: rate limited (429)
b: forbidden (403) — {"error":"nope"}
c: HTTP 503
d: HTTP 500`
    expect(toastErrorSummary(mixed)).toBe('4 errors: 1 rate limited, 1 auth-failed, 2 other.')
  })

  it('counts timeout and empty response as "other"', () => {
    const mixed = `All 3 configured AI models are rate limited — try again in a minute:
a: rate limited (429)
b: timeout
c: empty response`
    expect(toastErrorSummary(mixed)).toBe('3 errors: 1 rate limited, 2 other.')
  })

  it('falls back to first-line for non-AI error strings', () => {
    // No "<model>: <reason>" lines — the new parser must not mangle this.
    expect(toastErrorSummary('Network unreachable:')).toBe('Network unreachable.')
  })

  it('handles the single-failure case (1 model, 1 reason)', () => {
    const single = `All 1 configured AI models failed — check Settings → Models:
onlyModel: HTTP 502`
    expect(toastErrorSummary(single)).toBe('1 errors: 1 other.')
  })
})
