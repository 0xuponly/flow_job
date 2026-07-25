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
import { callAI, extractJobKeywordsV3, KeywordExtractionError, RateLimitError, scoreJobFit } from './ai'

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
    const { extractJobKeywordsLLM } = await import('./ai')
    await expect(extractJobKeywordsLLM('any jd')).rejects.toBeInstanceOf(KeywordExtractionError)
  })
})

describe('callAI failure summary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
