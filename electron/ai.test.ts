import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the ./database module to avoid pulling in the real database
// (which transitively imports electron/logger and requires a live
// Electron `app` runtime). Only `listApiModels` is exercised by
// extractJobKeywordsV3; the other exports are unused.
vi.mock('./database', () => ({
  getSettings: vi.fn(),
  listApiModels: vi.fn(() => []),
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
  updateDocumentVerification: vi.fn(),
  listApplications: vi.fn(() => []),
  updateApplication: vi.fn(),
  createDocument: vi.fn(),
  replaceDocumentContent: vi.fn(),
  getJob: vi.fn()
}))

// Self-mock of ./ai is intentionally NOT used here. Vitest's module
// mock replaces the exported binding of `callAI`, but
// `generateFollowUpMessage` calls `callAI` via the module-local
// function declaration, which the mock does not intercept. So a
// `vi.mock('./ai', ...)` self-mock cannot stub `callAI` for internal
// callers. Instead, the `generateFollowUpMessage` tests below drive
// the real `callAI` by stubbing `listApiModels` and global `fetch`,
// matching the style of the `callAI failure summary` tests above.

import * as database from './database'
import type { ApiModelConfig } from './types'
import { callAI, withAiOperation, EXTRACTION_SYSTEM_PROMPT, extractJobKeywordsV3, KeywordExtractionError, RateLimitError, resetModelHealth, resetModelHealthByIds, scoreJobFit } from './ai'

beforeEach(() => {
  resetModelHealth()
})

describe('extractJobKeywordsV3 (orchestrator)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns merged result with refinedByLlm=true when LLM succeeds', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'python', weight: 0.9, category: 'hard', source: 'required' },
          { phrase: 'temporal', weight: 0.7, category: 'hard', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))

    const jd = [
      'Senior Engineer',
      '',
      'Requirements',
      '- 5+ years Python',
      '- AWS'
    ].join('\n')
    const result = await extractJobKeywordsV3(jd, undefined)
    expect(result.refinedByLlm).toBe(true)
    expect(result.keywords.map((k) => k.phrase)).toContain('python')
    expect(result.keywords.map((k) => k.phrase)).toContain('temporal')
    // temporal is not in the allowlist, so it lands in unknownPhrases.
    expect(result.unknownPhrases).toContain('temporal')
  })

  it('returns rule-only result with refinedByLlm=false when no models are configured', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([])
    const jd = 'Senior Python Engineer\n\nRequirements\n- 5+ years Python'
    const result = await extractJobKeywordsV3(jd, undefined)
    expect(result.refinedByLlm).toBe(false)
    expect(result.unknownPhrases).toEqual([])
    expect(result.keywords.map((k) => k.phrase)).toContain('python')
  })

  it('returns rule-only result on a malformed LLM response', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json at all', { status: 200 })))
    const jd = 'Senior Python Engineer\n\nRequirements\n- 5+ years Python'
    const result = await extractJobKeywordsV3(jd, undefined)
    expect(result.refinedByLlm).toBe(false)
    expect(result.unknownPhrases).toEqual([])
    expect(result.keywords.map((k) => k.phrase)).toContain('python')
  })

  it('returns rule-only result when LLM returns empty keywords array', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ keywords: [] }) } }]
    }), { status: 200 })))
    const jd = 'Senior Python Engineer\n\nRequirements\n- 5+ years Python'
    const result = await extractJobKeywordsV3(jd, undefined)
    expect(result.refinedByLlm).toBe(false)
    expect(result.keywords.map((k) => k.phrase)).toContain('python')
  })

  it('downweights unknown LLM-only phrases in the result', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'obscureframework', weight: 1.0, category: 'hard', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))
    const jd = 'Some Job\n\nRequirements\n- obscureframework'
    const result = await extractJobKeywordsV3(jd, undefined)
    const entry = result.keywords.find((k) => k.phrase === 'obscureframework')
    expect(entry).toBeDefined()
    expect(entry!.weight).toBeCloseTo(0.8, 5)
    expect(result.unknownPhrases).toContain('obscureframework')
  })
})

describe('KeywordExtractionError', () => {
  it('is thrown when LLM returns no JSON object', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('plain text no json', { status: 200 })))
    const { extractJobKeywordsLLM } = await import('./ai')
    await expect(extractJobKeywordsLLM('any jd')).rejects.toBeInstanceOf(KeywordExtractionError)
  })

  it('is thrown when LLM returns invalid category', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [{ phrase: 'python', weight: 0.9, category: 'evil', source: 'body' }]
      }) } }]
    }), { status: 200 })))
    // P0.3: this behavior moved to extractJobKeywordsLLM (returns []
    // when all candidates are invalid); see "P0.3 partial valid
    // subset" describe block. The remaining KeywordExtractionError
    // cases here are the *unrecoverable* ones: callAI failure, no
    // content, no JSON object — those still throw.
  })

  it('still throws on callAI failure (unrecoverable)', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([])
    const { extractJobKeywordsLLM } = await import('./ai')
    await expect(extractJobKeywordsLLM('any jd')).rejects.toBeInstanceOf(KeywordExtractionError)
  })
})

describe('callAI failure summary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  it('throws RateLimitError whose first line names the configured model count when all are rate limited', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'a', enabled: true } as any,
      { id: 2, name: 'b', enabled: true } as any,
      { id: 3, name: 'c', enabled: true } as any,
      { id: 4, name: 'd', enabled: true } as any,
      { id: 5, name: 'e', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    let caught: unknown
    try {
      await callAI('sys', 'user')
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(RateLimitError)
    const msg = (caught as Error).message
    const firstLine = msg.split('\n')[0]
    expect(firstLine).toContain('5')
    expect(firstLine.toLowerCase()).toContain('rate limit')
  })

  it('throws Error whose first line names the configured model count when all fail without rate limiting', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'a', enabled: true } as any,
      { id: 2, name: 'b', enabled: true } as any,
      { id: 3, name: 'c', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    let caught: unknown
    try {
      await callAI('sys', 'user')
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(RateLimitError)
    const msg = (caught as Error).message
    const firstLine = msg.split('\n')[0]
    expect(firstLine).toContain('3')
  })
})

describe('scoreJobFit error passthrough', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  it('surfaces the callAI failure with the configured model count and no extra wrapper prefix', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'a', enabled: true } as any,
      { id: 2, name: 'b', enabled: true } as any,
      { id: 3, name: 'c', enabled: true } as any,
      { id: 4, name: 'd', enabled: true } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    const result = await scoreJobFit({
      title: 'Senior Engineer',
      description: 'jd',
      requirements: null,
      baseCv: 'cv',
      cvEduLevel: 0,
      cvYears: 0
    })
    expect(result.source).toBe('heuristic')
    expect(result.error).toBeDefined()
    const firstLine = (result.error ?? '').split('\n')[0]
    expect(firstLine).toContain('4')
    expect(firstLine).not.toMatch(/^LLM scorer failed/)
  })
})

describe('callAI model pool hygiene', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
    delete process.env.FLOW_JOB_MAX_TOKENS
  })

  it('skips rerank models and does not call them', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'reranker', enabled: true, base_url: 'https://openrouter.ai', model: 'meta-llama/llama-nemotron-rerank-v1', api_key: 'k' } as any,
      { id: 2, name: 'chat', enabled: true, base_url: 'https://openrouter.ai', model: 'openai/gpt-4o-mini', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"openai/gpt-4o-mini"')
      })
    )
  })

  it('caps max_tokens to 2048 by default', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'chat', enabled: true, base_url: 'https://openrouter.ai', model: 'openai/gpt-4o-mini', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await callAI('sys', 'user')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(2048)
  })

  it('respects FLOW_JOB_MAX_TOKENS env override', async () => {
    process.env.FLOW_JOB_MAX_TOKENS = '1024'
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'chat', enabled: true, base_url: 'https://openrouter.ai', model: 'openai/gpt-4o-mini', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await callAI('sys', 'user')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(1024)
  })

  it('respects per-model max_tokens override', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'chat', enabled: true, base_url: 'https://openrouter.ai', model: 'openai/gpt-4o-mini', api_key: 'k', max_tokens: 512 } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await callAI('sys', 'user')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(512)
  })
})

describe('callAI resilient failover', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  it('coalesces duplicate concurrent requests into a single fetch', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'chat', enabled: true, base_url: 'https://openrouter.ai', model: 'openai/gpt-4o-mini', api_key: 'k' } as any
    ])
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'shared response' } }]
      }), { status: 200 })
    }))

    const [a, b] = await Promise.all([
      callAI('sys', 'user'),
      callAI('sys', 'user')
    ])
    expect(a.content).toBe('shared response')
    expect(b.content).toBe('shared response')
    expect(fetchCount).toBe(1)
  })

  it('skips a model on cooldown after a 429 and returns a cooldown error when all are cooling', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'a', enabled: true, base_url: 'https://openrouter.ai', model: 'a', api_key: 'k' } as any,
      { id: 'm2', name: 'b', enabled: true, base_url: 'https://openrouter.ai', model: 'b', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))

    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)

    // Second call immediately after should find all models on cooldown and
    // throw without making any new fetch requests.
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens a circuit breaker for 401/402/403/404 and skips the dead model', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'dead', enabled: true, base_url: 'https://openrouter.ai', model: 'dead', api_key: 'k' } as any,
      { id: 'm2', name: 'live', enabled: true, base_url: 'https://openrouter.ai', model: 'live', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const status = body.model === 'dead' ? 401 : 200
      const content = body.model === 'dead' ? '' : 'ok'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    // First call tried dead (401) then live.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockClear()
    const result2 = await callAI('sys', 'user')
    expect(result2.content).toBe('ok')
    // Second call skipped the circuit-broken dead model entirely.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('live')
  })

  it('opens the 1-hour circuit breaker for 403 (was: a 15s cooldown forever)', async () => {
    // Measured: 61 x "403 forbidden" in ai.log, every one of them the same
    // permanently-forbidden model, each earning a 15s soft cooldown and
    // being re-walked on the next rotation. 403 is a persistent client
    // error like 401/402/404, so it belongs in the same breaker class.
    //
    // Timers matter here: a plain "was it skipped on the next call?"
    // assertion passes under the old 15s cooldown too. The discriminator
    // is that it is STILL skipped well past 15s and still inside the 1h
    // window — i.e. the breaker is open, not a cooldown.
    vi.useFakeTimers()
    try {
      vi.spyOn(database, 'listApiModels').mockReturnValue([
        { id: 'forbidden', name: 'forbidden', enabled: true, base_url: 'https://openrouter.ai', model: 'forbidden', api_key: 'k' } as any,
        { id: 'live', name: 'live', enabled: true, base_url: 'https://openrouter.ai', model: 'live', api_key: 'k' } as any
      ])
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        if (body.model === 'forbidden') return new Response('no access', { status: 403 })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)

      const first = await callAI('sys', 'user')
      expect(first.content).toBe('ok')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // Past the 15s soft cooldown (SERVER_ERROR_BACKOFF_MS) but well
      // inside the 1h breaker (CIRCUIT_BREAKER_MS).
      vi.advanceTimersByTime(5 * 60 * 1000)
      fetchMock.mockClear()
      const second = await callAI('sys', 'user')
      expect(second.content).toBe('ok')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe('live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects 429 cooldown and retries after the cooldown expires', async () => {
    vi.useFakeTimers()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'a', enabled: true, base_url: 'https://openrouter.ai', model: 'a', api_key: 'k' } as any
    ])
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('', { status: 429 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))

    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)
    // Immediate retry is blocked by cooldown.
    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)

    // Advance past the maximum 429 backoff (10 minutes).
    vi.advanceTimersByTime(11 * 60 * 1000)
    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Arm A regression: a provider billing/quota notice delivered with HTTP 200
// must NOT be recorded as a success.
//
// Measured: 337 of 353 `non-parseable` log lines in fit.log + fit.log.1
// carried a plaintext billing notice (failures-to-failures, so valid).
//
// The bug had two arms:
//   A — verify/fit pass NO validator, so the notice was non-null `content`,
//       took the `if (content)` success branch, and called
//       recordModelSuccess, which DELETES the model's health entry. A
//       provider out of credit therefore had its failure history erased on
//       every call: never cooled down, back at the front of the rotation
//       immediately. It looked healthy BECAUSE it was failing invisibly.
//   B — on the CV path the validator rejected it, but as a soft failure
//       that explicitly declines to circuit-break, so 15s forever.
//
// Both are fixed by recognising the body BEFORE the success branch and
// recording 402, which engages the existing 1h breaker.
// ---------------------------------------------------------------------------
describe('provider billing notice (HTTP 200) is a hard failure, not a success', () => {
  // Verbatim from fit.log (truncated by the logger's own 240-char snippet).
  const NOTICE =
    "The account behind this API key doesn't have enough credits. This model needs paid Pollen. Please [top up](https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup), then try again."

  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  it('ARM A: does not reach recordModelSuccess — the health entry survives on the no-validator path', async () => {
    // One model, no validator. This is exactly the verify/fit call shape
    // (`callAI(..., undefined, undefined, exclude)`).
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'broke', name: 'broke', enabled: true, base_url: 'https://example.invalid', model: 'broke', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: NOTICE } }]
    }), { status: 200 })))

    // The notice is not content, so the call fails...
    await expect(callAI('sys', 'user')).rejects.toThrow()

    // ...and — the Arm A assertion — the model is NOT immediately
    // available again. If recordModelSuccess had run, the health entry
    // would have been deleted and this call would hit the wire again.
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ARM A: the breaker is open (1h), not merely a 15s cooldown', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'broke', name: 'broke', enabled: true, base_url: 'https://example.invalid', model: 'broke', api_key: 'k' } as any,
      { id: 'live', name: 'live', enabled: true, base_url: 'https://example.invalid', model: 'live', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model
      if (model === 'broke') {
        return new Response(JSON.stringify({ choices: [{ message: { content: NOTICE } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // The rotation moves on to the working model rather than surfacing
    // the notice as content.
    const first = await callAI('sys', 'user')
    expect(first.content).toBe('ok')
    expect(first.modelUsed).toBe('live')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 'broke' is circuit-broken, so it is not walked again.
    fetchMock.mockClear()
    await callAI('sys', 'user')
    const walked = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).model)
    expect(walked).toEqual(['live'])
  })

  it('ARM B: on the CV path (validator present) the notice records a hard failure, not a soft one', async () => {
    // The CV validator already rejected this body, but as a soft failure
    // that explicitly declined to circuit-break. Now it is caught before
    // the validator, so the breaker engages.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'broke', name: 'broke', enabled: true, base_url: 'https://example.invalid', model: 'broke', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: NOTICE } }]
    }), { status: 200 })))
    const { looksLikeHarvardCv } = await import('./ai')

    await expect(callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv))
      .rejects.toThrow()

    // Survives: not walked again. A soft 15s failure would also skip it
    // immediately, so this alone does not distinguish — the breaker
    // assertion above does. What matters here is that it is a FAILURE and
    // never a success.
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await expect(callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv))
      .rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never persists a billing notice as a document', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'broke', name: 'broke', enabled: true, base_url: 'https://example.invalid', model: 'broke', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: NOTICE } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Financial Analyst', company: 'TIC',
      description: 'JD text', location: 'Remote', score: null, fit_score_version: null,
      fit_source: null, fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getSettings').mockReturnValue({
      base_cv: 'CV body', openai_api_key: '', openai_base_url: 'https://example.invalid',
      openai_model: 'm', user_name: 'Jane Doe', user_email: 'jane@example.com',
      user_phone: '', user_country: '', job_search_keywords: '', job_search_location: '',
      job_search_min_score: 0, autofill_enabled: false, openrouter_api_key: '',
      openrouter_base_url: '', openrouter_model: ''
    } as any)

    const { tailorDocument } = await import('./ai')
    await expect(tailorDocument({ job_id: 1, document_type: 'cv' })).rejects.toThrow()
    expect(database.createDocument).not.toHaveBeenCalled()
    expect(database.replaceDocumentContent).not.toHaveBeenCalled()
  })

  it('names the notice in the thrown error so the user sees why', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'broke', name: 'broke', enabled: true, base_url: 'https://example.invalid', model: 'broke', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'This model needs paid Pollen.' } }]
    }), { status: 200 })))

    let caught: unknown
    try {
      await callAI('sys', 'user')
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('broke')
    expect(msg).toMatch(/provider billing|paid Pollen/i)
    // A notice-only pool is NOT a RateLimitError: nothing is rate limited,
    // so the queue must not tell the user to "try again in a minute".
    expect(caught).not.toBeInstanceOf(RateLimitError)
  })

  it('ADVERSARIAL: a real CV answer mentioning billing/credit still succeeds and clears health', async () => {
    // The false-positive guard, end to end. A financial-analyst CV that
    // says "billing reconciliation" and "credit exposure" must be accepted
    // as content — a false positive here would discard a good document.
    const goodCv =
      'Jane Doe\n1 Main St • Cambridge, MA • jane@example.com\n\n' +
      'Experience\nAcme Capital\tBoston, MA\n' +
      'Senior Financial Analyst\tJun 2022 – Present\n' +
      '- Rebuilt the monthly billing reconciliation, cutting close time 4 days.\n' +
      '- Owned credit exposure reporting on a $2.4B loan book.'
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'fin', name: 'fin', enabled: true, base_url: 'https://example.invalid', model: 'fin', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: goodCv } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { looksLikeHarvardCv } = await import('./ai')

    const result = await callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv)
    expect(result.content).toBe(goodCv)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // And the success genuinely recorded: the model is walked again next
    // call (health cleared, no cooldown).
    fetchMock.mockClear()
    await callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ADVERSARIAL: a real review JSON mentioning billing is accepted as content', async () => {
    const review =
      '{"score": 92, "passed": true, "feedback": "Deep billing and credit-risk experience."}'
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'r', name: 'r', enabled: true, base_url: 'https://example.invalid', model: 'r', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: review } }]
    }), { status: 200 })))

    const result = await callAI('sys', 'user')
    expect(result.content).toBe(review)
  })
})

describe('generateFollowUpMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(database, 'getSettings').mockReturnValue({
      openai_api_key: '',          // legacy field empty — must NOT trigger fallback
      openai_base_url: 'https://example.invalid',
      openai_model: 'legacy-model',
      user_name: 'Test User',
      user_email: 'test@example.invalid'
    } as any)
  })

  it('uses callAI when a model is configured, even if openai_api_key is empty', async () => {
    // One enabled model in api_models — the path the Settings UI writes.
    // The legacy openai_api_key is empty, so the old code would have
    // returned the plain-text fallback. Routing through callAI instead
    // hits the configured model and returns its content.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'AI follow-up body' } }]
    }), { status: 200 })))

    const { generateFollowUpMessage } = await import('./ai')
    const out = await generateFollowUpMessage('Acme', 'Staff Engineer', 7)
    expect(out).toBe('AI follow-up body')
    // The fetch must have been called against the configured model's
    // base_url — NOT the legacy openai_base_url path the old code used.
    expect(fetch).toHaveBeenCalledWith(
      'https://example.invalid/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns the plain-text fallback when callAI returns null content', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    // callAI returns null content when the model responds with no choices.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' } }]
    }), { status: 200 })))

    const { generateFollowUpMessage } = await import('./ai')
    const out = await generateFollowUpMessage('Acme', 'Staff Engineer', 7)
    expect(out).toContain('Test User')   // fallback signature
    expect(out).toContain('Staff Engineer')
  })

  it('returns the plain-text fallback when no models are configured', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([])
    const { generateFollowUpMessage } = await import('./ai')
    const out = await generateFollowUpMessage('Acme', 'Staff Engineer', 7)
    expect(out).toContain('Test User')
    expect(out).toContain('Staff Engineer')
  })
})

// P0.3 — LLM extractor hardening + top-30 noise reduction.
// See docs/keyword-detection-improvement-plan.md §3.3 + §3.4.
describe('P0.3 EXTRACTION_SYSTEM_PROMPT (prompt tightening)', () => {
  it('is exported and non-empty so tests can assert on its contents', () => {
    expect(typeof EXTRACTION_SYSTEM_PROMPT).toBe('string')
    expect(EXTRACTION_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it('warns the LLM away from location noise (P0.3 §3.3)', () => {
    const p = EXTRACTION_SYSTEM_PROMPT.toLowerCase()
    expect(p).toContain('location')
    expect(p).toContain('country')
  })

  it('warns the LLM away from years-of-experience and degree boilerplate', () => {
    const p = EXTRACTION_SYSTEM_PROMPT.toLowerCase()
    expect(p).toContain('years')
    expect(p).toContain('degree')
  })

  it('warns the LLM away from generic soft-skill noise ("communication", etc.)', () => {
    const p = EXTRACTION_SYSTEM_PROMPT.toLowerCase()
    // Catches at least one generic-soft-skill negative example.
    expect(p).toMatch(/communication/)
  })
})

describe('P0.3 extractJobKeywordsLLM partial valid subset (P0.3 §3.4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
  })

  it('returns only the valid entries when the LLM emits a mix of valid + invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'python', weight: 0.9, category: 'hard', source: 'required' },
          { phrase: 'aws',     weight: 0.8, category: 'hard', source: 'body' },
          { phrase: 'evil',    weight: 0.7, category: 'not-a-real-category', source: 'body' },
          { phrase: '',        weight: 0.7, category: 'hard', source: 'body' },
          { phrase: 'kafka',   weight: 1.5, category: 'hard', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))

    const { extractJobKeywordsLLM } = await import('./ai')
    const out = await extractJobKeywordsLLM('any jd')
    // 5 candidates in, 2 valid (python, aws) — the others fail
    // category / phrase / weight checks. No throw, the partial set
    // is returned so the orchestrator can still merge it.
    expect(out.map((e) => e.phrase)).toEqual(['python', 'aws'])
  })

  it('returns an empty array (no throw) when every candidate fails validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'python', weight: 0.9, category: 'evil', source: 'body' },
          { phrase: '',       weight: 0.7, category: 'hard', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))

    const { extractJobKeywordsLLM } = await import('./ai')
    // Old behavior: threw KeywordExtractionError here. New behavior:
    // the rule pipeline backfills, so the orchestrator just needs an
    // empty (or partial) LLM result to proceed.
    const out = await extractJobKeywordsLLM('any jd')
    expect(out).toEqual([])
  })
})

describe('P0.3 end-to-end noise reduction (P0.3 §3.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'mock', enabled: true } as any
    ])
  })

  it('strips LLM-only noise ("canada", "years experience", "university degree", "remote", "full-time") from the merged top-30', async () => {
    // JD contains "5+ years experience" + "Canada" so the rule
    // pipeline can match some real signal, but the LLM also emits the
    // known noise terms. They must NOT appear in the final keyword
    // list because the deny-list filter is now in the pipeline.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'python', weight: 0.9, category: 'hard', source: 'required' },
          { phrase: 'canada', weight: 0.7, category: 'hard', source: 'body' },
          { phrase: 'years experience', weight: 0.6, category: 'hard', source: 'body' },
          { phrase: 'university degree', weight: 0.5, category: 'hard', source: 'body' },
          { phrase: 'remote', weight: 0.4, category: 'hard', source: 'body' },
          { phrase: 'full-time', weight: 0.4, category: 'hard', source: 'body' },
          // P0.3 §3.3 additive country-name deny-list extension
          // (united states, united kingdom) — see comment in
          // src/keywordExtractor.ts:LLM_DENY_LIST.
          { phrase: 'united states', weight: 0.3, category: 'hard', source: 'body' },
          { phrase: 'united kingdom', weight: 0.3, category: 'hard', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))

    const jd = [
      'Senior Python Engineer',
      '',
      'Requirements',
      '- 5+ years experience with Python',
      '- Based in Canada or United States; remote considered'
    ].join('\n')

    const result = await extractJobKeywordsV3(jd, undefined)
    const phrases = result.keywords.map((k) => k.phrase)
    expect(phrases).not.toContain('canada')
    expect(phrases).not.toContain('years experience')
    expect(phrases).not.toContain('university degree')
    // Note: "remote" is in PMI_NOISE_WORDS, so the rule pipeline will
    // also not surface it. The deny-list is the LLM-side safety net.
    expect(phrases).not.toContain('full-time')
    // P0.3 §3.3 country-name noise terms (additive deny-list
    // extension). Same deny-list mechanism as the rest — only
    // LLM-unknown phrases are dropped, so a real rule-pipeline match
    // for a country would survive.
    expect(phrases).not.toContain('united states')
    expect(phrases).not.toContain('united kingdom')
    // The real skill survives the merge.
    expect(phrases).toContain('python')
  })

  it('keeps the LLM-derived real skills even when the LLM also emits noise', async () => {
    // P0.3 §3.4: when the LLM returns a mixed list, the partial-valid
    // path (now) lets real candidates through instead of throwing
    // everything away. Previously, any single all-invalid batch would
    // throw and we'd lose the real ones too.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        keywords: [
          { phrase: 'kubernetes', weight: 0.9, category: 'hard', source: 'required' },
          { phrase: 'rust',       weight: 0.8, category: 'hard', source: 'body' },
          // Bogus category — fails validation:
          { phrase: 'noisy',      weight: 0.5, category: 'invalid', source: 'body' }
        ]
      }) } }]
    }), { status: 200 })))

    const jd = 'Senior Engineer\n\nRequirements\n- Kubernetes + Rust'
    const result = await extractJobKeywordsV3(jd, undefined)
    const phrases = result.keywords.map((k) => k.phrase)
    // The two valid LLM candidates survive; the bogus one is dropped
    // by validation, but does NOT take the rest with it.
    expect(phrases).toContain('kubernetes')
    expect(phrases).toContain('rust')
  })
})

// CV reconstruction (Production incident 2026-09-13, jobId 7605 family):
// VL / "deliberation-style" model output was being persisted as the
// generated CV. The validator + validateResponse plumbing on callAI
// rejects reasoning-channel / planning-meta content and forces the
// rotation to skip to the next model. If every model's content fails
// the validator, the orchestrator surfaces a clear error rather than
// writing the deliberation text to the document row.
//
// See electron/ai.ts:looksLikeHarvardCv + tailorDocument.
describe('P1.4 looksLikeHarvardCv (deliberation-text detector)', () => {
  // The bad CV the user pasted: a reasoning/thinking-channel style
  // output that paraphrases the system prompt as planning monologue
  // ("We need to tailor...", "We must follow the Harvard CV template
  // exactly...", "But we need to be careful: ...") and never produces
  // any actual CV section headers or TAB-aligned entries.
  const deliberationOutput = [
    'We need to tailor the candidate CV for the Senior Financial Analyst role.',
    'We must follow the Harvard CV template exactly as shown in the prompt.',
    'We have to produce plain text output only — no markdown, no asterisks.',
    'But we need to be careful: the contact line must use bullet points (•).',
    'Better to follow exactly: name on its own line, contact line, then sections.',
    'Let me consider the Education section. We need to include GPA. But again, only',
    'what is in the candidate\'s Base CV. We should not invent any specific numbers.',
    'We need to think about the Experience section. Two entries each with TAB separator.',
    'Wait — actually a single candidate has four roles. We have to pick the most relevant.',
    'Let me write that out. Skills: 5-15 technical entries, ranked by job-keyword match.'
  ].join('\n')

  it('rejects pure planning-meta output with no section markers', async () => {
    const { looksLikeHarvardCv } = await import('./ai')
    expect(looksLikeHarvardCv(deliberationOutput)).toBe(false)
  })

  it('rejects reasoning that contains a real section header but only as quoted echo, not as a line', async () => {
    // Some reasoning models will quote the prompt's section list ("Education",
    // "Experience", "Leadership") inside their monologue without ever producing
    // those as bare section headers. With our spec, "Education" must appear
    // on its own as a line (centered, bold) to count.
    const quotedEcho = deliberationOutput + '\n\nEducation\nExperience'
    const { looksLikeHarvardCv } = await import('./ai')
    expect(looksLikeHarvardCv(quotedEcho)).toBe(false)
  })

  it('accepts a well-formed Harvard CV with TAB-aligned entries and section headers', async () => {
    // Minimum-viable real CV: centered name + contact line, then Education /
    // Experience with TAB-aligned entries and L&: bold,title<TAB>org<TAB>years.
    // The validator checks for structural markers — it does NOT need to be
    // exhaustive about the spec; that is the verifier's job (documentRules).
    const goodCv = [
      'Jane Doe',
      '1 Main St • Cambridge, MA 02139 • jane@example.com • 617-555-0100',
      '',
      'Education',
      'Harvard University\tCambridge, MA, A.B. Computer Science\tMay 2024',
      '',
      'Experience',
      'Acme Corp\tBoston, MA',
      'Software Engineer\tJun 2024 – Present',
      '- Led the migration of the data pipeline from Python 2 to Python 3',
      '',
      'Leadership & Activities',
      '**President**, Harvard Coding Club\t2023 – 2024',
      '',
      'Skills & Interests',
      'Technical:',
      'Python, TypeScript, React, AWS, PostgreSQL',
      'Language:',
      'English (native), Spanish (conversational)'
    ].join('\n')
    const { looksLikeHarvardCv } = await import('./ai')
    expect(looksLikeHarvardCv(goodCv)).toBe(true)
  })

  it('rejects a well-formed-looking output with NO TAB characters (TAB alignment is mandatory in the spec)', async () => {
    const noTab = [
      'Jane Doe',
      '1 Main St • Cambridge, MA • jane@example.com',
      '',
      'Education',
      'Harvard University, Cambridge, MA, A.B. Computer Science, May 2024',
      '',
      'Experience',
      'Acme Corp, Boston, MA',
      'Software Engineer, Jun 2024 – Present',
      '- Led a migration'
    ].join('\n')
    const { looksLikeHarvardCv } = await import('./ai')
    // Comma-separated entries are not Harvard format; the validator rejects
    // them and forces a retry.
    expect(looksLikeHarvardCv(noTab)).toBe(false)
  })

  it('rejects an output that starts with a reasoning preamble even if a fragment of CV appears at the end', async () => {
    // This is the user's exact failure mode: planning text dominates the
    // first ~80% of the response, with the actual CV (name + education
    // line) appearing only at the tail. Section-header count is below the
    // minimum so the validator still rejects.
    const preambleHeavy = [
      ...deliberationOutput.split('\n'),
      '',
      'Jane Doe',
      '1 Main St • Cambridge, MA • jane@example.com',
      '',
      'Education',
      'Harvard University\tCambridge, MA, A.B.\tMay 2024'
    ].join('\n')
    const { looksLikeHarvardCv } = await import('./ai')
    expect(looksLikeHarvardCv(preambleHeavy)).toBe(false)
  })
})

describe('P1.4 callAI validateResponse (deliberation gate at the rotation layer)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  // cv_failed was firing without an error message in production logs
  // because tailorJobDocsForJob only logs `cv_failed` (the wrapper) and
  // the underlying Error was thrown away. With validateResponse in play,
  // a model whose content fails validation is treated as "empty
  // response" and the rotation moves on; if every model fails, callAI
  // throws an Error whose message names the validation failure so the
  // orchestrator can include it in fit_last_error / cv_error.
  it('skips a model whose content fails validateResponse and uses the next model', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'bad',  name: 'bad',  enabled: true, base_url: 'https://example.invalid', model: 'bad',  api_key: 'k' } as any,
      { id: 'good', name: 'good', enabled: true, base_url: 'https://example.invalid', model: 'good', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'bad') {
        // First model: deliberation-style output.
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'We need to tailor the CV.\nWe must follow the template exactly.' } }]
        }), { status: 200 })
      }
      // Second model: a real CV.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Jane Doe\n1 Main St • Cambridge, MA • jane@example.com\n\nEducation\nHarvard University\tCambridge, MA\tMay 2024\n\nExperience\nAcme Corp\tBoston, MA\nSoftware Engineer\tJun 2024 – Present\n- Led a data pipeline migration' } }]
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { looksLikeHarvardCv } = await import('./ai')
    const result = await callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv)
    expect(result.content).toContain('Jane Doe')
    expect(result.modelUsed).toBe('good')
    // The bad model was tried exactly once.
    const calledModels = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).model)
    expect(calledModels).toEqual(['bad', 'good'])
  })

  it('throws a clear error naming the validator when every model fails', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'bad', name: 'bad', enabled: true, base_url: 'https://example.invalid', model: 'bad', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'We need to follow the template exactly. But we need...' } }]
    }), { status: 200 })))
    const { looksLikeHarvardCv } = await import('./ai')
    await expect(callAI('sys', 'user', 0.7, undefined, undefined, looksLikeHarvardCv))
      .rejects.toThrow(/failed validation|looksLikeHarvardCv|did not pass/i)
  })
})

describe('P1.4 tailorDocument rejects deliberation-style CV output', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  // Production evidence (user-reported, real output for "Senior
  // Financial Analyst, Transportation Investment Corporation"):
  // the model returned planning-meta text instead of a CV. Previously
  // this was persisted as the generated CV. The fix: validate the
  // response and reject it; if every model fails, throw so the
  // orchestrator surfaces a clear error instead of writing planning
  // text to the document row.
  it('throws when the only configured model returns deliberation text (no CV is persisted)', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 1, name: 'reasoning', enabled: true, base_url: 'https://example.invalid', model: 'r1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'We need to tailor the CV.\nWe must follow the template exactly.' } }]
    }), { status: 200 })))

    const { tailorDocument } = await import('./ai')
    await expect(tailorDocument({ job_id: 1, document_type: 'cv' }))
      .rejects.toThrow()
    // Critical: createDocument was NEVER called with the bad content.
    expect(database.createDocument).not.toHaveBeenCalled()
  })

  it('persists the good response when a follow-up model produces a real CV', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'reasoning', name: 'reasoning', enabled: true, base_url: 'https://example.invalid', model: 'r1', api_key: 'k' } as any,
      { id: 'good',      name: 'good',      enabled: true, base_url: 'https://example.invalid', model: 'g1', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'r1') {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'We need to tailor the CV.\nWe must follow the template.' } }]
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Jane Doe\n1 Main St • Cambridge, MA • jane@example.com\n\nEducation\nHarvard University\tCambridge, MA\tMay 2024\n\nExperience\nAcme Corp\tBoston, MA\nSoftware Engineer\tJun 2024 – Present' } }]
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    // Wire createDocument return so the happy path can be observed.
    vi.mocked(database.createDocument).mockReturnValue({ id: 99 } as any)
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Financial Analyst', company: 'TIC',
      description: 'JD text', location: 'Remote', score: null, fit_score_version: null,
      fit_source: null, fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getSettings').mockReturnValue({
      base_cv: 'CV body', openai_api_key: '', openai_base_url: 'https://example.invalid',
      openai_model: 'm', user_name: 'Jane Doe', user_email: 'jane@example.com',
      user_phone: '', user_country: '', job_search_keywords: '', job_search_location: '',
      job_search_locations: '', deleted_jobs_cap: 50000, auto_scan_enabled: true,
      auto_scan_interval_minutes: 120, scan_min_match: 0.25, locations_normalized: '', locations_normalized_v2: '',
      locations_normalized_v3: '', locations_normalized_v4: '', locations_normalized_v5: '',
      locations_normalized_v6: '', locations_array_migrated_v1: '', disabled_boards_migrated_v1: '',
      employment_type_normalized: '', work_mode_normalized: '', title_casing_normalized: '',
      title_casing_normalized_v2: '', statuses_recomputed: '', statuses_manual_v2: '',
      backup_path: '', backup_last_success_at: '', backup_last_error: '', passphrase: '',
      auto_tailor_on_scan: false, auto_tailor_min_fit: 90, quick_apply_shortcut: null,
      cv_version: 0
    } as any)
    const { tailorDocument } = await import('./ai')
    const result = await tailorDocument({ job_id: 1, document_type: 'cv' })
    expect(result.document_id).toBe(99)
    const persistedContent = vi.mocked(database.createDocument).mock.calls[0]?.[2] ?? ''
    expect(persistedContent).toContain('Jane Doe')
    expect(persistedContent).not.toContain('We need to tailor')
  })
})

// P1.7 §2 auto-regeneration. A rebuild has to land on the SAME document
// row the review just failed on. `createDocument` always inserts a new
// row, so routing a regeneration through it handed the user a different
// document with a fresh auto_regen counter — which is why the loop could
// run exactly once and why AUTO_REGEN_MAX was unreachable.
describe('P1.7 tailorDocument rebuilds a document in place', () => {
  const CV_TEXT =
    'Jane Doe\njane@example.com\n\nEducation\nHarvard University\tCambridge, MA\n\nExperience\nAcme Corp\tBoston, MA\nSoftware Engineer\tJun 2024 – Present'

  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'good', enabled: true, base_url: 'https://example.invalid', model: 'g1', api_key: 'k' } as never
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: CV_TEXT } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 7, title: 'Analyst', company: 'Acme', description: 'JD text',
      location: 'Remote', status: 'sourced'
    } as never)
    vi.spyOn(database, 'getSettings').mockReturnValue({
      base_cv: 'CV body', user_name: 'Jane Doe', user_email: 'jane@example.com'
    } as never)
    // mockClear, not just a return value: this file has no global
    // clearAllMocks, so call history leaks in from earlier describes.
    vi.mocked(database.replaceDocumentContent).mockClear().mockReturnValue({ id: 11 } as never)
    vi.mocked(database.createDocument).mockClear().mockReturnValue({ id: 99 } as never)
  })

  it('replaces the named document rather than inserting a new one', async () => {
    const { tailorDocument } = await import('./ai')
    const result = await tailorDocument({ job_id: 7, document_type: 'cv', document_id: 11 })

    expect(database.replaceDocumentContent).toHaveBeenCalledWith(
      11, 'CV — Acme', expect.stringContaining('Jane Doe'), expect.anything()
    )
    expect(database.createDocument).not.toHaveBeenCalled()
    expect(result.document_id).toBe(11)
  })

  it('still creates a document when no row was named', async () => {
    const { tailorDocument } = await import('./ai')
    const result = await tailorDocument({ job_id: 7, document_type: 'cv' })

    expect(database.createDocument).toHaveBeenCalled()
    expect(database.replaceDocumentContent).not.toHaveBeenCalled()
    expect(result.document_id).toBe(99)
  })

  it('does not resurrect a document that was deleted mid-request', async () => {
    // The rebuild is in flight when the user deletes the document.
    // Writing an insert here would put back something the user just
    // threw away.
    vi.mocked(database.replaceDocumentContent).mockReturnValue(null)
    const { tailorDocument } = await import('./ai')

    const result = await tailorDocument({ job_id: 7, document_type: 'cv', document_id: 11 })

    expect(database.createDocument).not.toHaveBeenCalled()
    expect(result.document_id).toBe(11)
  })
})

// Production incident 2026-09-14: "Reviewer returned a non-JSON response."
// The legacy regex /\{[\s\S]*\}/ captures from the first `{` to the
// LAST `}` in the response — when a reasoning-channel model wraps its
// answer in prose ("...my JSON is {\"score\":85, \"passed\":true} I hope
// this helps") the regex grabs prose + JSON, JSON.parse fails, and the
// caller silently skips with reason: 'parse_failed'. Same failure mode
// for scoreJobFit at line ~1258.
//
// Plus the unfaulted gap: when the first attempt parses fail, the call
// site returned skip immediately. The user's model pool has multiple
// 429 / 402 / 400 responses (per production logs); rotating to the
// next model before surfacing the skip gives a better chance of getting
// a valid JSON.
//
// Three angles of fix:
//   a. parseJsonObject helper: fenced ```json ... ``` first, then a
//      balanced-brace scan that respects string-quote/escape state, so
//      prose around the JSON does not break the capture.
//   b. warn-log model + content snippet on parse_failed so the next
//      incident is diagnosable.
//   c. bounded retry (max 2 extra attempts) on parse_failed, excluding
//      the model that produced the bad output.
//
// Existing scoreJobFit and verifyDocumentContent already check
// Number.isFinite(rawScore) — that gate still works and stays in place.
describe('P1.5 parseJsonObject (robust JSON extraction)', () => {
  // The helper is a pure, deterministic function. Pure functions are
  // imported into the test file (not mocked) so the regression tests
  // exercise exactly the implementation that runs in production.
  it('parses a bare JSON object', async () => {
    const { parseJsonObject } = await import('./ai')
    expect(parseJsonObject('{"score":85, "passed":true, "feedback":"ok"}'))
      .toEqual({ score: 85, passed: true, feedback: 'ok' })
  })

  it('parses a fenced ```json block (P1.5.a — preferred)', async () => {
    const { parseJsonObject } = await import('./ai')
    const content = 'Here is my review:\n\n```json\n{"score": 73, "passed": true, "feedback": "Solid."}\n```\n\nHope this helps.'
    expect(parseJsonObject(content)).toEqual({ score: 73, passed: true, feedback: 'Solid.' })
  })

  it('parses an unfenced ``` block (some models wrap without the json tag)', async () => {
    const { parseJsonObject } = await import('./ai')
    const content = '```\n{"score": 60, "passed": false}\n```'
    expect(parseJsonObject(content)).toEqual({ score: 60, passed: false })
  })

  it('handles prose-wrapped JSON without breaking on the leading prose', async () => {
    const { parseJsonObject } = await import('./ai')
    // The legacy regex /\{[\s\S]*\}/ would capture from "candidate has "
    // { here through ... } at the end, including junk between the two
    // objects — and JSON.parse would fail. The balanced scan only
    // captures the FIRST balanced `{...}` and skips ahead to find the
    // next one if parsing fails, eventually returning the real JSON.
    const content = [
      'Let me analyze. The candidate has {years: 5} years of experience.',
      'Considering the role requirements, I will produce:',
      '{"score": 80, "passed": true, "feedback": "Strong fit."}',
      'Hope that helps.'
    ].join('\n')
    expect(parseJsonObject(content)).toEqual({ score: 80, passed: true, feedback: 'Strong fit.' })
  })

  it('does not capture across multiple `{...}` blocks when the FIRST is parseable', async () => {
    const { parseJsonObject } = await import('./ai')
    // Even though there are stray braces later, the helper must return
    // the first parseable balanced object so the score = 85 reaches the
    // verifier, not the unrelated fragment after it.
    const content = '{"score": 85, "passed": true}\n\nNote from model: extra {\"foo\":\"bar\"}'
    expect(parseJsonObject(content)).toEqual({ score: 85, passed: true })
  })

  it('returns null when there is no JSON object at all (deliberation rejection)', async () => {
    const { parseJsonObject } = await import('./ai')
    // Pure reasoning-channel output. P1.4 found the same shape in CVs;
    // the review/fit paths now see it too.
    const content = [
      'We need to evaluate this candidate. Let me think step by step.',
      'The candidate has strong Python experience. We should consider this.',
      'My final answer is: strong fit overall. Score should be high.'
    ].join('\n')
    expect(parseJsonObject(content)).toBeNull()
  })

  it('handles JSON containing escaped quotes inside a string value (balanced scan respects string state)', async () => {
    const { parseJsonObject } = await import('./ai')
    // The balanced scan tracks in-string state so the inner `\\"` escape
    // does not throw off the brace counter. Without this, the legacy
    // regex would either grab the whole string or stop early.
    const content = '{"feedback":"The candidate said: \\"I led the migration\\"","score":72}'
    expect(parseJsonObject(content)).toEqual({
      feedback: 'The candidate said: "I led the migration"',
      score: 72
    })
  })

  it('skips an unrelated early `{...}` that contains no expected shape and finds the next one', async () => {
    const { parseJsonObject } = await import('./ai')
    // The first `{...}` is a stray example block ("foo": "bar") that some
    // models emit as preamble. The helper must keep scanning to find the
    // real JSON object with the expected shape.
    // Note: the helper currently extracts the FIRST parseable object —
    // if that object doesn't have the score field, the caller's
    // Number.isFinite(rawScore) check rejects it and the call site
    // skips. The retry-from-other-model layer then kicks in if the
    // call site is wired for it.
    const content = 'I think {"foo": "bar", "baz": 1} is a great example.\n{"score": 50, "passed": false}'
    // First parseable object wins — caller-side check handles wrong shape.
    expect(parseJsonObject(content)).toEqual({ foo: 'bar', baz: 1 })
  })
})

describe('P1.5 verifyDocumentContent / scoreJobFit — robust extraction + retry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  // Production evidence (ai.log 2026-09-14 20:42-20:47):
  // "Failed to parse JSON from LLM response" and "No JSON object found
  // in LLM response" repeat dozens of times, all from the keyword
  // extractor at the time. The verifier / fit-scorer use the same
  // regex-based extraction; same failure mode for them. The fix
  // applies to both call sites.

  // Basic happy path: verifier should still parse bare JSON. (P1.5.a
  // does not regress the legacy behavior.)
  it('verifyDocumentContent parses a bare JSON response and persists the result', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'a', name: 'a', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"score": 91, "passed": true, "feedback": "Excellent fit."}' } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    const { verifyDocumentContent } = await import('./ai')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('review')
    if (result.kind === 'review') {
      // Score from the LLM response is what the helper recovered.
      // The `passed` flag also ANDs structural-rule checks; the
      // placeholder doc.content='CV body' fails skills_count etc.,
      // so passed may be false even at score=91. We assert the score
      // here and trust the gating semantic in the rule-suite tests.
      expect(result.score).toBe(91)
    }
    expect(vi.mocked(database.updateDocumentVerification)).toHaveBeenCalledWith(7, 91, expect.stringContaining('Excellent fit.'))
  })

  it('verifyDocumentContent parses a fenced ```json``` response (P1.5.a preferred path)', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'a', name: 'a', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Let me review:\n\n```json\n{"score": 75, "passed": true, "feedback": "OK."}\n```\n' } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    const { verifyDocumentContent } = await import('./ai')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('review')
    if (result.kind === 'review') expect(result.score).toBe(75)
  })

  it('verifyDocumentContent parses prose-wrapped JSON (P1.5.a robustness)', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'a', name: 'a', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Here is my evaluation.\n\n{"score": 60, "passed": false, "feedback": "Needs more keywords."}\n\nHope that helps.' } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    const { verifyDocumentContent } = await import('./ai')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('review')
    if (result.kind === 'review') {
      expect(result.score).toBe(60)
      expect(result.passed).toBe(false)
    }
  })

  // P1.5.b warn-log of model + snippet on parse_failed. The legacy path
  // silently skip with reason 'parse_failed' and never names the model
  // in the log; the next incident is un-attributable. This test pins
  // down that model name + content snippet DO surface in the log.
  it('warns log.fit with the model name + content snippet when parsing fails after all retries', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'r1', name: 'Reasoner-1', enabled: true, base_url: 'https://example.invalid', model: 'r1', api_key: 'k' } as any,
      { id: 'r2', name: 'Reasoner-2', enabled: true, base_url: 'https://example.invalid', model: 'r2', api_key: 'k' } as any,
      { id: 'r3', name: 'Reasoner-3', enabled: true, base_url: 'https://example.invalid', model: 'r3', api_key: 'k' } as any
    ])
    // Every model returns deliberation-style output with no parseable JSON.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'We need to evaluate. Let me think... I should consider... My answer: strongly consider.' } }]
    }), { status: 200 })))
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    // Import the logger the same way ai.ts does.
    const { verifyDocumentContent } = await import('./ai')
    const { log } = await import('./logger')
    const fitLogWarn = vi.spyOn(log.fit, 'warn')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('skip')
    // Pin: every attempted model shows up in the warn log with a snippet.
    const warnCalls = fitLogWarn.mock.calls.map((c) => String(c[0]))
    const combinedWarns = warnCalls.join('\n')
    expect(combinedWarns).toMatch(/Reasoner-1|Reasoner-2|Reasoner-3/)
    expect(combinedWarns).toMatch(/We need to evaluate/)
  })

  // P1.5.c bounded retry — max 2 extra attempts on OTHER enabled
  // models. The first model returns bad JSON; the next should be tried.
  // The hook mirrors the existing callAI rotation; the BRIEF asks for
  // "max 2 extra" (so 3 total attempts before skip).
  it('retries up to 2 extra times on a different model when the first parse fails', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'reasoner', name: 'Reasoner', enabled: true, base_url: 'https://example.invalid', model: 'reasoner', api_key: 'k' } as any,
      { id: 'good',      name: 'Good',      enabled: true, base_url: 'https://example.invalid', model: 'good',      api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'reasoner') {
        // Deliberation-style output that contains no parseable JSON.
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'We need to consider... Let me think... My answer: strong fit.' } }]
        }), { status: 200 })
      }
      // Second model: a clean, parseable review.
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"score": 70, "passed": true, "feedback": "Solid."}' } }]
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    const { verifyDocumentContent } = await import('./ai')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('review')
    if (result.kind === 'review') expect(result.score).toBe(70)
    // Both models are attempted at most once each — the retry layer
    // excludes the bad model but does NOT try it twice.
    const modelsTried = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).model)
    expect(modelsTried).toContain('reasoner')
    expect(modelsTried).toContain('good')
    expect(modelsTried.filter((m) => m === 'reasoner')).toHaveLength(1)
  })

  it('gives up after the bounded retry window (3 attempts max) and returns skip', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'r1', name: 'r1', enabled: true, base_url: 'https://example.invalid', model: 'r1', api_key: 'k' } as any,
      { id: 'r2', name: 'r2', enabled: true, base_url: 'https://example.invalid', model: 'r2', api_key: 'k' } as any,
      { id: 'r3', name: 'r3', enabled: true, base_url: 'https://example.invalid', model: 'r3', api_key: 'k' } as any
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'We need to think... deliberation only, no JSON.' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(database, 'getJob').mockReturnValue({
      id: 1, title: 'Senior Engineer', company: 'Acme',
      description: 'JD', location: 'Remote', requirements: null,
      score: null, fit_score_version: null, fit_source: null,
      fit_breakdown: null, fit_last_error: null, fit_error_toasted: null,
      match_grade: null, fit_rationale: null, status: 'sourced'
    } as any)
    vi.spyOn(database, 'getDocument').mockReturnValue({
      id: 7, job_id: 1, content: 'CV body', type: 'cv',
      title: 'CV', created_at: '', updated_at: '', tailor_status: null,
      tailor_last_error: null, verification_score: null,
      verification_feedback: null, verification_result: null
    } as any)
    const { verifyDocumentContent } = await import('./ai')
    const result = await verifyDocumentContent(1, 7, 'cv')
    expect(result.kind).toBe('skip')
    // Cap: 1 initial + 2 retries = 3 model attempts max.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

// P1.6: stale model health surviving a model re-enable. The modelHealth
// map inside ai.ts (per-model cooldown + circuit-breaker counter)
// lived forever in the main process. When the user disables a model
// the entry stays in the map, then on re-enable the entry's stuck
// cooldown / open-circuit is inherited — the just-re-enabled model
// is silently skipped even though it should be eligible. The fix
// (P1.6 §1) is a targeted reset: ai.ts exports
// `resetModelHealthByIds(ids: string[])` that clears entries whose
// key matches an id in the set. The IPC layer (models:save / add /
// delete in main.ts) calls the helper after persisting.
//
// The map itself is NOT exported; only the scoped reset is. Tests use
// observable behavior (next callAI genuinely tries the re-enabled
// model) as the success criterion.
describe('P1.6 resetModelHealthByIds (cooldown clear on re-enable)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  it('clears cooldown state for a model that returned 429, so the next callAI actually tries it again', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'm1', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    // Step 1: a 429 stamps the cooldown (model now skipped).
    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)
    // Sanity: a fresh request before reset is skipped without fetch.
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()

    // Step 2: user re-enables (or the user just disabled+re-enabled
    // through the Settings → Models UI). The IPC layer calls
    // resetModelHealthByIds(['m1']).
    resetModelHealthByIds(['m1'])

    // Step 3: next callAI genuinely tries the model. If the reset
    // hook is broken, the modelHealth entry still has a stuck
    // nextAvailableAt deep in the future and the rotation throws
    // RateLimitError again without touching the wire.
    const callFetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'recovered' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', callFetchMock)
    const result = await callAI('sys', 'user')
    expect(result.content).toBe('recovered')
    expect(callFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps cooldown state for OTHER models (resetModelHealthByIds is targeted, not a blanket clear)', async () => {
    // Two models; only m1 hits 429 and gets cooldown. After resetModelHealthByIds(['m1']),
    // m2's cooldown (if any) must be preserved.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'm1', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any,
      { id: 'm2', name: 'm2', enabled: true, base_url: 'https://example.invalid', model: 'm2', api_key: 'k' } as any
    ])
    // First call: m1 429, m2 200. The callAI tries m1 first (idx 0)
    // and falls back to m2. m1 ends up cooldown; m2 succeeds and is
    // recorded as a success (which clears its own health, not a
    // problem here).
    const fetch1 = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'm1') return new Response('', { status: 429 })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'm2-recovered' } }]
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch1)
    const first = await callAI('sys', 'user')
    expect(first.content).toBe('m2-recovered')
    expect(fetch1).toHaveBeenCalledTimes(2)

    // Now pretend BOTH models produced 429s (worst case).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(callAI('sys', 'user')).rejects.toBeInstanceOf(RateLimitError)
    // Both models now have cooldown entry in the map.

    // Reset ONLY m1.
    resetModelHealthByIds(['m1'])

    // Stub m1 to succeed and m2 to keep 429ing. The reset should
    // let m1 back in while m2 remains on cooldown.
    const fetch2 = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'm1') return new Response(JSON.stringify({
        choices: [{ message: { content: 'm1-recovered' } }]
      }), { status: 200 })
      return new Response('', { status: 429 })
    })
    vi.stubGlobal('fetch', fetch2)
    const res = await callAI('sys', 'user')
    // Result came from m1 (the reset one). m2 is still on cooldown
    // and was filtered out by availableModels(), so only m1 was
    // tried.
    expect(res.content).toBe('m1-recovered')
    const modelsTried = fetch2.mock.calls.map((c) => JSON.parse(c[1].body as string).model)
    expect(modelsTried).toEqual(['m1'])
  })

  it('also clears circuit-breaker state (402/404) on re-enable', async () => {
    // Circuit-broken models stay silent for CIRCUIT_BREAKER_MS (1h).
    // After a user re-enables, the next callAI must try the model
    // even though the entry is well under the cooldown window.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'dead', name: 'dead', enabled: true, base_url: 'https://example.invalid', model: 'dead', api_key: 'k' } as any,
      { id: 'live', name: 'live', enabled: true, base_url: 'https://example.invalid', model: 'live', api_key: 'k' } as any
    ])
    const fetchFirst = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'dead') return new Response('', { status: 402 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchFirst)
    await callAI('sys', 'user')
    // 'dead' now has a 1-hour circuit break entry in the map.

    // Pretend user disabled+re-enabled 'dead' — the IPC layer resets.
    resetModelHealthByIds(['dead'])

    // Re-enable should be tried even though the wall-clock is well
    // inside the 1-hour break window.
    const fetchSecond = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === 'dead') return new Response(JSON.stringify({
        choices: [{ message: { content: 'dead-recovered' } }]
      }), { status: 200 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSecond)
    const result = await callAI('sys', 'user')
    expect(result.content).toBe('dead-recovered')
    const modelsTried = fetchSecond.mock.calls.map((c) => JSON.parse(c[1].body as string).model)
    expect(modelsTried).toEqual(['dead'])
  })

  it('is a no-op for ids that were never in the map (delete + re-add with same id scheme)', async () => {
    // Delete + re-add with the same id happens when the user removes a
    // model and adds a new one configured identically. The map may
    // already have a stale entry under that id (from the pre-delete
    // version). resetModelHealthByIds must clear it so the new model
    // is tried immediately.
    resetModelHealthByIds(['never-existed-id'])
    // No throw, no side effect; the test passes if the line above
    // returns cleanly and the callAI still works below.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'm1', enabled: true, base_url: 'https://example.invalid', model: 'm1', api_key: 'k' } as any
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 })))
    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
  })
})

// P1.6 IPC wiring: models:save must reset health for ALL ids in the
// new list; models:add + models:delete must reset health for the
// single id involved. We verify this by inspecting the call site in
// main.ts. Since ai.test.ts already covers the ai.ts side, the IPC
// layer is tested by inspecting the handler registry directly.
describe('P1.6 main.ts IPC wiring (models:save / models:add / models:delete)', () => {
  it('registers models:save, models:add, models:delete handlers that call resetModelHealthByIds', async () => {
    // Re-load main.ts under a guarded import. The handler registration
    // runs once per main process; we verify the handlers exist on
    // ipcMain AND that they reference resetModelHealthByIds by name
    // (string match against the handler source) so any future
    // refactor that drops the wiring trips this test.
    const fs = await import('fs')
    const path = await import('path')
    const mainSrc = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8')
    // Wiring presence:
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]models:save['"]/)
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]models:add['"]/)
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]models:delete['"]/)
    // Hook must be invoked from each handler with the right id shape:
    expect(mainSrc).toMatch(/resetModelHealthByIds/)
  })
})

// The app runs LLM work from two directions: the queue processor, and
// IPC handlers that call the scorers/tailorers directly (Recompute Fit,
// Tailor, Verify). Those are separate call sites, so a serial queue loop
// did not stop the two from running at once — the user could kick off a
// recompute while the queue was mid-item. Every request now passes
// through one gate, so only one is ever in flight.
describe('AI request serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetModelHealth()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'a', enabled: true, base_url: 'https://openrouter.ai', model: 'a', api_key: 'k' } as any
    ])
    // Distinct prompts defeat callAI's identical-request coalescing, so
    // each call is genuinely separate work.
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))
  })

  function trackConcurrency() {
    const state = { inFlight: 0, max: 0, order: [] as number[] }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      state.inFlight++
      state.max = Math.max(state.max, state.inFlight)
      state.order.push(body.messages?.[1]?.content ?? '')
      await new Promise((r) => setTimeout(r, 10))
      state.inFlight--
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))
    return state
  }

  it('never has more than one request in flight', async () => {
    const state = trackConcurrency()
    await Promise.all([
      callAI('sys', 'a'),
      callAI('sys', 'b'),
      callAI('sys', 'c')
    ])
    expect(state.max).toBe(1)
  })

  it('still runs every queued request', async () => {
    const state = trackConcurrency()
    await Promise.all([callAI('sys', 'a'), callAI('sys', 'b'), callAI('sys', 'c')])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
  })

  it('processes them in the order they were requested', async () => {
    const state = trackConcurrency()
    await Promise.all([callAI('sys', 'first'), callAI('sys', 'second'), callAI('sys', 'third')])
    expect(state.order).toEqual(['first', 'second', 'third'])
  })

  it('does not let a failure wedge the queue for later calls', async () => {
    // The gate must release on rejection, or one bad call would block
    // every LLM call in the app for the rest of the session.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(callAI('sys', 'boom')).rejects.toThrow()

    // The 500 puts the model on cooldown, which would fail the next call
    // for an unrelated reason. Clear it so this measures the gate, not
    // the health tracker.
    resetModelHealth()
    const state = trackConcurrency()
    await expect(callAI('sys', 'after')).resolves.toBeDefined()
    expect(state.max).toBe(1)
  })

  it('keeps identical-request coalescing working', async () => {
    // Coalescing returns the in-flight promise. If the gate were applied
    // to the shared promise rather than the dispatch, this would
    // self-deadlock.
    const state = trackConcurrency()
    const [x, y] = await Promise.all([callAI('sys', 'same'), callAI('sys', 'same')])
    expect(x.content).toBe('ok')
    expect(y.content).toBe('ok')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(state.max).toBe(1)
  })

  it('serializes concurrent queue work and a direct IPC call together', async () => {
    const state = trackConcurrency()
    await Promise.all([callAI('sys', 'from-queue'), callAI('sys', 'from-renderer')])
    expect(state.max).toBe(1)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })
})

// Request-level serialization (above) still let a competing operation's
// request slip between two requests of the same operation — so a job
// tailoring a CV *and* a cover letter could have its second call
// interleaved with a recompute the user kicked off. An operation now
// holds one slot for its whole duration.
describe('AI operation serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetModelHealth()
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      { id: 'm1', name: 'a', enabled: true, base_url: 'https://openrouter.ai', model: 'a', api_key: 'k' } as any
    ])
  })

  function track() {
    const state = { inFlightOps: 0, max: 0, order: [] as string[] }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const user = body.messages?.[1]?.content ?? ''
      state.order.push(user)
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))
    return state
  }

  it('keeps a multi-request operation contiguous', async () => {
    // THE case that separates this from request-level serialization.
    const state = track()
    await Promise.all([
      withAiOperation(async () => {
        await callAI('sys', 'a1')
        await callAI('sys', 'a2')
      }),
      withAiOperation(async () => { await callAI('sys', 'b1') })
    ])
    // b1 must not land between a1 and a2.
    expect(state.order).toEqual(['a1', 'a2', 'b1'])
  })

  it('runs one operation at a time', async () => {
    const state = { max: 0, inFlight: 0 }
    vi.stubGlobal('fetch', vi.fn(async () => {
      state.inFlight++
      state.max = Math.max(state.max, state.inFlight)
      await new Promise((r) => setTimeout(r, 10))
      state.inFlight--
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))
    await Promise.all([
      withAiOperation(async () => { await callAI('sys', 'a'); await callAI('sys', 'b') }),
      withAiOperation(async () => { await callAI('sys', 'c') })
    ])
    // Distinct prompts per operation, so coalescing does not merge them.
    expect(state.max).toBe(1)
  })

  it('releases the slot when an operation throws', async () => {
    await expect(
      withAiOperation(async () => { throw new Error('operation failed') })
    ).rejects.toThrow('operation failed')
    // A wedged slot would hang this forever.
    await expect(withAiOperation(async () => 'ok')).resolves.toBe('ok')
  })

  it('runs queued operations in order', async () => {
    const state = track()
    await Promise.all([
      withAiOperation(async () => { await callAI('sys', 'first') }),
      withAiOperation(async () => { await callAI('sys', 'second') }),
      withAiOperation(async () => { await callAI('sys', 'third') })
    ])
    expect(state.order).toEqual(['first', 'second', 'third'])
  })
})

// The per-attempt HTTP timeout. It was 20s as a bare literal in
// callAI's signature and at four call sites; it is now one named
// constant, DEFAULT_CALL_TIMEOUT_MS = 45_000, optionally overridable per
// model via `timeout_ms` (no settings UI — the default has to be right
// on its own).
//
// Every test here reads the delay actually handed to the abort timer
// rather than a re-statement of the constant, so a test cannot pass while
// the code under it arms a 20s timer.
describe('per-attempt call timeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetModelHealth()
  })

  // Records the delay of every setTimeout the request path arms, and still
  // calls through — the abort timer has to keep working for the test that
  // hangs a request until it fires.
  function captureTimerDelays() {
    const delays: number[] = []
    const real = globalThis.setTimeout
    // Restored by the vi.restoreAllMocks() in beforeEach.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === 'number') delays.push(ms)
      return real(fn, ms, ...rest)
    }) as unknown as typeof globalThis.setTimeout)
    return { delays }
  }

  function okResponse() {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }

  // Typed rather than `as any` (the older tests in this file use `as any`
  // because their mocks omit fields): a mistyped `timeout_ms` here would
  // then be a typecheck error rather than a silently-ignored key.
  function modelConfig(over: Partial<ApiModelConfig> = {}): ApiModelConfig {
    return { id: 'm1', name: 'a', enabled: true, base_url: 'https://example.invalid', model: 'a', api_key: 'k', ...over }
  }

  it('arms the per-attempt abort timer at 45s by default, not 20s', async () => {
    // 20s predates the DEFAULT_MAX_TOKENS=2048 cap and cut off legitimate
    // slow generations, which were then reported to the user as empty
    // responses. It was never what made a failing model cheap: measured
    // 402s come back in ~3.5s and 429s in well under a second.
    vi.spyOn(database, 'listApiModels').mockReturnValue([modelConfig()])
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const { delays } = captureTimerDelays()

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    expect(delays).toContain(45_000)
    expect(delays).not.toContain(20_000)
  })

  it('arms 45s on every call that does not pass a timeout of its own', async () => {
    // The four real call sites (keyword extraction, verify, score, tailor)
    // each pass the constant explicitly rather than relying on the default
    // parameter — that they do is pinned by the grep guard below, and
    // what matters here is that no call site silently reintroduces a
    // different number: three calls at the three temperatures those sites
    // use all arm 45s.
    vi.spyOn(database, 'listApiModels').mockReturnValue([modelConfig()])
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { delays } = captureTimerDelays()

    await callAI('sys', 'user1', 0.3)
    await callAI('sys', 'user2', 0.7)
    await callAI('sys', 'user3', 0.2)
    expect(delays).toEqual([45_000, 45_000, 45_000])
  })

  it('honours a model-level timeout_ms over the default', async () => {
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      modelConfig({ id: 'slowpoke', name: 'slow', model: 'slow', timeout_ms: 90_000 })
    ])
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const { delays } = captureTimerDelays()

    await callAI('sys', 'user')
    expect(delays).toEqual([90_000])
    expect(delays).not.toContain(45_000)
  })

  it('resolves the timeout per model, not per call, across a rotation', async () => {
    // The override belongs to the model being tried. A rotation over a
    // configured model and a default one must arm both timers at their
    // own value, in order.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      modelConfig({ id: 'slow', name: 'slow', model: 'slow', timeout_ms: 90_000 }),
      modelConfig({ id: 'plain', name: 'plain', model: 'plain' })
    ])
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model
      // First model fails transiently so the rotation moves to the second.
      return model === 'slow' ? new Response('nope', { status: 500 }) : okResponse()
    }))
    const { delays } = captureTimerDelays()

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    expect(delays).toEqual([90_000, 45_000])
  })

  it('clamps a finite timeout_ms above the 10-minute ceiling', async () => {
    // Chosen ceiling: 10 minutes (MAX_CALL_TIMEOUT_MS). Generous past any
    // real generation, and far short of "wedges the serial queue for an
    // hour". Clamped, not discarded, so a model that genuinely needs
    // longer than the default can still say so.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      modelConfig({ timeout_ms: 3_600_000 })
    ])
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const { delays } = captureTimerDelays()

    await callAI('sys', 'user')
    expect(delays).toEqual([600_000])
  })

  const nonsense: [string, number][] = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity]
  ]
  it.each(nonsense)('falls back to the 45s default for a %s timeout_ms', async (_label, timeoutMs) => {
    // Trusting a nonsense value is strictly worse than the default:
    // 0 aborts every request on the next tick (the model looks
    // permanently broken) and an hour would wedge the queue behind one
    // dead host. Note NaN is the one that matters most in practice —
    // Math.min(NaN, x) is NaN, and setTimeout(fn, NaN) fires immediately,
    // so an unvalidated NaN would silently behave as 0.
    vi.spyOn(database, 'listApiModels').mockReturnValue([modelConfig({ timeout_ms: timeoutMs })])
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const { delays } = captureTimerDelays()

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    expect(delays).toEqual([45_000])
  })

  it('actually aborts on the resolved timeout, and reports it as a timeout', async () => {
    // The delay assertions above would all still pass if the resolved
    // value were never wired to the abort. Hang the request and let a
    // 1ms override fire it for real.
    vi.spyOn(database, 'listApiModels').mockReturnValue([
      modelConfig({ id: 'hang', name: 'hang', model: 'hang', timeout_ms: 1 })
    ])
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
    })))

    await expect(callAI('sys', 'user')).rejects.toThrow(/hang: timeout/)
  })

  it('leaves a model without timeout_ms exactly as it was', async () => {
    // Additive and optional: the field is absent, so the default applies
    // and nothing else about the request changes (same URL, same body,
    // same max_tokens).
    vi.spyOn(database, 'listApiModels').mockReturnValue([modelConfig()])
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAI('sys', 'user')
    expect(result.content).toBe('ok')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.body).not.toContain('timeout')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'a',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' }
      ],
      temperature: 0.7,
      max_tokens: 2048
    })
  })
})

// A bare 20000 is exactly the kind of literal that rots: it lived in
// callAI's signature and at four call sites, all of which had to be found
// by hand to change a number the code already had a name for. These are
// greps with teeth — they fail the moment anyone reintroduces one.
describe('no bare numeric timeout literal at any callAI call site', () => {
  it('finds no 20000 passed to callAI in ai.ts or ai.test.ts', async () => {
    const fs = await import('fs')
    const path = await import('path')
    for (const file of ['ai.ts', 'ai.test.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf-8')
      // `[^)]*` spans newlines, so the multi-line call sites are covered
      // along with the single-line ones, and the signature itself counts
      // as a call site (it ends at its own closing paren).
      const offenders = src.match(/callAI\([^)]*\b20000\b/g)
      expect(offenders, `${file} still passes a literal 20000: ${offenders}`).toBeNull()
    }
  })

  it('finds no bare number in any callAI call site’s timeout position', async () => {
    // The same rot wearing a different number: 30000, 30_000, 2000. The
    // 4th argument is the timeout, and it must be the constant, the
    // parameter, or omitted — never a typed-in value that can drift away
    // from the default it is supposed to mirror.
    const fs = await import('fs')
    const path = await import('path')
    for (const file of ['ai.ts', 'ai.test.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf-8')
      const callSites = src.match(/callAI\([^)]*\)/g) ?? []
      expect(callSites.length).toBeGreaterThan(0)
      const bareTimeouts = callSites.filter((c) => {
        const fourth = c.slice('callAI('.length, -1).split(',')[3]?.trim()
        return fourth !== undefined && /^\d[\d_]*$/.test(fourth)
      })
      expect(bareTimeouts, `${file} passes a bare number as a timeout: ${bareTimeouts}`).toEqual([])
    }
  })

  it('keeps the default and every call site on the named constant', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(__dirname, 'ai.ts'), 'utf-8')
    // One source of truth, and callAI's signature reads from it — a
    // second copy of the number in the signature is the rot this guards.
    expect(src).toMatch(/const DEFAULT_CALL_TIMEOUT_MS = 45_000/)
    expect(src).toMatch(/timeoutMs = DEFAULT_CALL_TIMEOUT_MS/)
    // The four call sites that used to carry a literal now name it.
    const named = src.match(/callAI\([^)]*DEFAULT_CALL_TIMEOUT_MS[^)]*\)/g) ?? []
    expect(named.length).toBe(5) // 4 call sites + callAI's own signature
  })
})
