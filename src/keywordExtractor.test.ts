import { describe, it, expect } from 'vitest'
import {
  parseSections,
  extractPhases,
  extractJobKeywordsStructured,
  extractJobKeywords,
  mergeKeywordResults
} from './keywordExtractor'
import { loadKeywordAllowlists } from './keywordAllowlists'
import type { KeywordEntry } from './types'

describe('parseSections', () => {
  it('returns the first non-empty line as title', () => {
    const jd = 'Senior Software Engineer\n\nWe are looking for a great engineer.\n'
    expect(parseSections(jd).title).toBe('Senior Software Engineer')
  })

  it('treats empty input as empty title and empty body', () => {
    const s = parseSections('')
    expect(s.title).toBe('')
    expect(s.required).toBe('')
    expect(s.preferred).toBe('')
    expect(s.body).toBe('')
  })

  it('buckets lines under a "Requirements" header into required', () => {
    const jd = [
      'Staff Backend Engineer',
      '',
      'Requirements',
      '- 5+ years Python',
      '- AWS experience',
      '',
      'About the role',
      'You will work on...'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/5\+ years python/)
    expect(s.required).toMatch(/aws experience/)
    expect(s.body).toMatch(/you will work on/i)
    expect(s.required).not.toMatch(/about the role/i)
  })

  it('buckets lines under a "Nice to have" header into preferred', () => {
    const jd = [
      'Senior Engineer',
      '',
      'Nice to have',
      '- Kubernetes',
      '- GraphQL',
      '',
      'About',
      'A small team'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.preferred).toMatch(/kubernetes/)
    expect(s.preferred).toMatch(/graphql/)
    expect(s.body).toMatch(/a small team/i)
  })

  it('treats the whole description as body when no headers are present', () => {
    const jd = 'Just a wall of text.\nWith no headers.\nAbout the role and the company.'
    const s = parseSections(jd)
    expect(s.title).toBe('Just a wall of text.')
    expect(s.required).toBe('')
    expect(s.preferred).toBe('')
    expect(s.body).toMatch(/with no headers/i)
  })

  it('handles interleaved required/preferred sections', () => {
    const jd = [
      'Title',
      '',
      'Requirements',
      '- python',
      '',
      'Nice to have',
      '- rust',
      '',
      'Requirements',
      '- postgres'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/python/)
    expect(s.required).toMatch(/postgres/)
    expect(s.preferred).toMatch(/rust/)
  })

  it('matches a wide set of header spellings case-insensitively', () => {
    const jd = [
      'Job Title',
      '',
      'MINIMUM QUALIFICATIONS',
      '- go',
      '',
      'WHAT YOU\'LL NEED',
      '- rust',
      '',
      'DESIRED',
      '- haskell'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/go/)
    expect(s.required).toMatch(/rust/)
    expect(s.preferred).toMatch(/haskell/)
  })
})

describe('extractPhases', () => {
  it('finds exact allowlist hits in the section text', () => {
    const out = extractPhases('We use Python and AWS daily.', 'required')
    const phrases = out.map((k) => k.phrase).sort()
    expect(phrases).toContain('python')
    expect(phrases).toContain('aws')
    out.forEach((k) => expect(k.weight).toBe(0))
  })

  it('finds phrase_boost entries as multi-word units', () => {
    const out = extractPhases('You will work on machine learning and distributed systems.', 'required')
    const phrases = out.map((k) => k.phrase).sort()
    expect(phrases).toContain('machine learning')
    expect(phrases).toContain('distributed systems')
  })

  it('finds seniority cues', () => {
    const out = extractPhases('Looking for a senior engineer with staff-level scope.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('senior')
    expect(phrases).toContain('staff')
  })

  it('classifies a phase_boost overlap with hard as hard, not soft', () => {
    const out = extractPhases('Need experience with product management and stakeholder management.', 'required')
    const product = out.find((k) => k.phrase === 'product management')!
    expect(product.category).toBe('hard')
    const stake = out.find((k) => k.phrase === 'stakeholder management')!
    expect(stake.category).toBe('soft')
  })

  it('drops duplicates case-insensitively; longer phrase wins on overlap', () => {
    const out = extractPhases('We use AWS and need machine learning experience.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases.filter((p) => p === 'aws')).toHaveLength(1)
    expect(phrases).toContain('machine learning')
    expect(phrases).not.toContain('learning')
  })

  it('captures n-gram PMI phrases that occur more than once and are not in any list', () => {
    const out = extractPhases(
      'We use foobar pipeline for foobar pipeline tasks. Foobar pipeline is critical.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('foobar pipeline')
  })
})

describe('extractJobKeywordsStructured', () => {
  it('returns empty result for an empty description', () => {
    const r = extractJobKeywordsStructured('')
    expect(r.keywords).toEqual([])
    expect(r.refinedByLlm).toBe(false)
  })

  it('returns up to 30 entries, sorted by weight desc', () => {
    const jd = Array.from({ length: 50 }, (_, i) => `python skill${i} aws skill${i}`).join(' ')
    const r = extractJobKeywordsStructured(jd)
    expect(r.keywords.length).toBeLessThanOrEqual(30)
    for (let i = 1; i < r.keywords.length; i++) {
      expect(r.keywords[i - 1].weight).toBeGreaterThanOrEqual(r.keywords[i].weight)
    }
  })

  it('weights title matches above body matches', () => {
    const jd = [
      'Staff Python Engineer',
      '',
      'About the role',
      'You will use Python every day. Python Python Python.'
    ].join('\n')
    const r = extractJobKeywordsStructured(jd)
    const titleHit = r.keywords.find((k) => k.phrase === 'python' && k.source === 'title')!
    const bodyHit = r.keywords.find((k) => k.phrase === 'python' && k.source === 'body')!
    expect(titleHit).toBeDefined()
    expect(bodyHit).toBeDefined()
    expect(titleHit.weight).toBeGreaterThan(bodyHit.weight)
  })

  it('down-weights soft skills relative to hard skills with the same source', () => {
    const jd = [
      'Senior Engineer',
      '',
      'About',
      'Need leadership experience. Need python experience.'
    ].join('\n')
    const r = extractJobKeywordsStructured(jd)
    const leadership = r.keywords.find((k) => k.phrase === 'leadership')!
    const python = r.keywords.find((k) => k.phrase === 'python')!
    expect(python.weight).toBeGreaterThan(leadership.weight)
  })

  it('assigns a category for each entry', () => {
    const jd = [
      'Senior AWS Engineer',
      '',
      'Requirements',
      '- 5+ years Python',
      '- PMP certification preferred'
    ].join('\n')
    const r = extractJobKeywordsStructured(jd)
    const cats = new Set(r.keywords.map((k) => k.category))
    expect(cats.has('hard')).toBe(true)
    expect(cats.has('seniority')).toBe(true)
  })

  it('preserves the legacy extractJobKeywords flat shape: phrases, weight-desc, cap 30', () => {
    const jd = 'Looking for a senior python engineer with AWS experience. Python is core. AWS is core.'
    const phrases = extractJobKeywords(jd)
    expect(phrases.length).toBeLessThanOrEqual(30)
    expect(phrases.every((p) => typeof p === 'string')).toBe(true)
  })
})

describe('mergeKeywordResults', () => {
  const lists = loadKeywordAllowlists()

  it('LLM wins category+weight, rule wins source when both have the same phrase', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const rule: KeywordEntry[] = [
      { phrase: 'python', weight: 0.5, category: 'soft', source: 'required' }
    ]
    const r = mergeKeywordResults(llm, rule, lists)
    expect(r.keywords).toHaveLength(1)
    expect(r.keywords[0]).toMatchObject({
      phrase: 'python',
      category: 'hard',
      source: 'required',
      weight: 0.9
    })
    expect(r.refinedByLlm).toBe(true)
    expect(r.unknownPhrases).toEqual([])
  })

  it('downweights LLM-only phrases that are not in any allowlist', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'obscureframework', weight: 1.0, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords).toHaveLength(1)
    expect(r.keywords[0].weight).toBeCloseTo(0.8, 5)
    expect(r.unknownPhrases).toEqual(['obscureframework'])
  })

  it('keeps LLM-only allowlist phrases at full weight', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'python', weight: 1.0, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords[0].weight).toBe(1.0)
    expect(r.unknownPhrases).toEqual([])
  })

  it('includes rule-only phrases as a safety net (LLM missed them)', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'python', weight: 1.0, category: 'hard', source: 'body' }
    ]
    const rule: KeywordEntry[] = [
      { phrase: 'pulumi', weight: 0.5, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, rule, lists)
    expect(r.keywords.map((k) => k.phrase)).toContain('pulumi')
    expect(r.keywords.map((k) => k.phrase)).toContain('python')
  })

  it('longer phrase wins on substring collision', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'learning', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'machine learning', weight: 0.9, category: 'hard', source: 'required' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords.map((k) => k.phrase)).toContain('machine learning')
    expect(r.keywords.find((k) => k.phrase === 'learning')).toBeUndefined()
  })

  it('caps at 30', () => {
    const llm: KeywordEntry[] = Array.from({ length: 50 }, (_, i) => ({
      phrase: `obscure${i}`,
      weight: 1.0 - i * 0.01,
      category: 'hard' as const,
      source: 'body' as const
    }))
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords).toHaveLength(30)
  })

  it('marks refinedByLlm=false when LLM is empty', () => {
    const rule: KeywordEntry[] = [
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'required' }
    ]
    const r = mergeKeywordResults([], rule, lists)
    expect(r.refinedByLlm).toBe(false)
    expect(r.keywords).toHaveLength(1)
  })

  it('unknownPhrases is the full set, not capped at 30', () => {
    const llm: KeywordEntry[] = Array.from({ length: 50 }, (_, i) => ({
      phrase: `obscure${i}`,
      weight: 1.0 - i * 0.01,
      category: 'hard' as const,
      source: 'body' as const
    }))
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.unknownPhrases).toHaveLength(50)
    expect(r.keywords).toHaveLength(30)
  })
})
