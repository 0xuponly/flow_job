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
import { callAI, EXTRACTION_SYSTEM_PROMPT, extractJobKeywordsV3, KeywordExtractionError, RateLimitError, resetModelHealth, scoreJobFit } from './ai'

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

  it('opens a circuit breaker for 401/402/404 and skips the dead model', async () => {
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
