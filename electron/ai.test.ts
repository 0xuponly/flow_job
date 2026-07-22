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

import * as database from './database'
import { callAI, extractJobKeywordsV3, KeywordExtractionError, RateLimitError } from './ai'

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
