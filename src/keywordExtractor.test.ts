import { describe, it, expect } from 'vitest'
import {
  parseSections,
  extractPhases,
  extractJobKeywordsStructured,
  extractJobKeywords,
  mergeKeywordResults
} from './keywordExtractor'
import { loadKeywordAllowlists, matchKey, KEYWORD_ALIASES } from './keywordAllowlists'
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

  it('buckets "Preferred Qualifications" into preferred, not required', () => {
    const jd = [
      'Engineer',
      '',
      'Minimum qualifications',
      '- python',
      '',
      'Preferred qualifications',
      '- kubernetes'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/python/)
    expect(s.required).not.toMatch(/kubernetes/)
    expect(s.preferred).toMatch(/kubernetes/)
  })

  it('classifies markdown-dressed headings (##, **bold**, trailing colon)', () => {
    const jd = [
      'Engineer',
      '',
      '## Requirements',
      '- python',
      '',
      '**Nice to have**',
      '- rust',
      '',
      'Preferred:',
      '- golang'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/python/)
    expect(s.preferred).toMatch(/rust/)
    expect(s.preferred).toMatch(/golang/)
  })

  it('strips markdown dressing from the title', () => {
    expect(parseSections('# Senior Engineer\n\nBody').title).toBe('Senior Engineer')
    expect(parseSections('**Staff Engineer**\n\nBody').title).toBe('Staff Engineer')
    expect(parseSections('Backend Engineer:\n\nBody').title).toBe('Backend Engineer')
  })

  it('does not flip buckets on prose lines that merely contain header words', () => {
    const jd = [
      'Engineer',
      '',
      'Requirements',
      '- python',
      'Python is a plus for this role',
      'We would love SQL experience',
      'The ideal candidate will include Terraform in their toolkit',
      '',
      'About',
      'Small team'
    ].join('\n')
    const s = parseSections(jd)
    // All the prose lines stay in the required bucket — no preferred/reset flips.
    expect(s.required).toMatch(/python is a plus/i)
    expect(s.required).toMatch(/we would love sql/i)
    expect(s.required).toMatch(/terraform/i)
    expect(s.preferred).toBe('')
    expect(s.body).toMatch(/small team/i)
  })

  it('treats "What we\'re looking for" and "Who you are" as required headings', () => {
    const jd = [
      'Engineer',
      '',
      "What we're looking for",
      '- python',
      '',
      'Who you are',
      '- pragmatic'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/python/)
    expect(s.required).toMatch(/pragmatic/)
  })

  it('classifies more required/preferred heading variants', () => {
    const jd = [
      'Engineer',
      '',
      'Must-haves',
      '- python',
      '',
      'Basic Qualifications',
      '- sql',
      '',
      'Good to have',
      '- rust',
      '',
      'Bonus points',
      '- k8s'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/python/)
    expect(s.required).toMatch(/sql/)
    expect(s.preferred).toMatch(/rust/)
    expect(s.preferred).toMatch(/k8s/)
  })

  it('resets to body on more trailing-section headings', () => {
    const jd = [
      'Engineer',
      '',
      'Requirements',
      '- python',
      '',
      'How to apply',
      'Send us your resume',
      '',
      'Our benefits',
      'Health insurance'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).not.toMatch(/resume/)
    expect(s.body).toMatch(/resume/i)
    expect(s.body).toMatch(/health insurance/i)
  })

  it('does not reset on wrapped content lines inside a required section', () => {
    const jd = [
      'Engineer',
      '',
      'Requirements',
      '- python',
      'About the platform you will design scalable services',
      'Our team, our stack: you own it end to end',
      '',
      'About',
      'Small team'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.required).toMatch(/about the platform/i)
    expect(s.required).toMatch(/our team, our stack/i)
    expect(s.body).not.toMatch(/about the platform/i)
  })

  it('never treats bullet lines as headers, even with section words', () => {
    const jd = [
      'Engineer',
      '',
      'About the role',
      '- required: 3 years of Python',
      '- plus points for Rust'
    ].join('\n')
    const s = parseSections(jd)
    expect(s.body).toMatch(/required: 3 years/i)
    expect(s.body).toMatch(/plus points for rust/i)
    expect(s.required).toBe('')
    expect(s.preferred).toBe('')
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

describe('PMI noise control', () => {
  it('never surfaces "years experience" boilerplate despite high PMI', () => {
    const out = extractPhases(
      'Need 5 years experience. We value years experience with systems.',
      'required'
    )
    expect(out.map((k) => k.phrase)).not.toContain('years experience')
  })

  it('never surfaces "equal opportunity" boilerplate', () => {
    const out = extractPhases(
      'We are an equal opportunity employer. Equal opportunity matters to us.',
      'body'
    )
    expect(out.map((k) => k.phrase)).not.toContain('equal opportunity')
  })

  it('never surfaces benefits/compensation boilerplate pairs', () => {
    const out = extractPhases(
      'Competitive salary offered. Salary competitive with benefits. Salary and insurance provided.',
      'body'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).not.toContain('competitive salary')
    expect(phrases).not.toContain('salary competitive')
  })

  it('noise words do not block allowlisted phrases (found-check wins)', () => {
    // "team" is a noise word but "team building" is allowlisted.
    const out = extractPhases(
      'We invest in team building. Team building offsites happen quarterly.',
      'body'
    )
    expect(out.map((k) => k.phrase)).toContain('team building')
  })

  it('still surfaces genuine repeated non-allowlisted bigrams', () => {
    const out = extractPhases(
      'Our event mesh routes everything. The event mesh scales horizontally.',
      'required'
    )
    expect(out.map((k) => k.phrase)).toContain('event mesh')
  })

  it('keeps noise bigrams out of the final structured result', () => {
    const jd = [
      'Engineer',
      '',
      'Requirements',
      '- 5 years experience with python',
      '- years experience required',
      '- python required'
    ].join('\n')
    const phrases = extractJobKeywordsStructured(jd).keywords.map((k) => k.phrase)
    expect(phrases).not.toContain('years experience')
    expect(phrases).not.toContain('experience python')
  })
})

describe('alias normalization', () => {
  it('maps k8s to the kubernetes allowlist entry', () => {
    const out = extractPhases('Our platform runs on k8s.', 'required')
    expect(out.map((k) => k.phrase)).toContain('kubernetes')
    expect(out.map((k) => k.phrase)).not.toContain('k8s')
  })

  it('maps js/ts shorthand to javascript/typescript', () => {
    const out = extractPhases('Strong JS and TS skills required.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('javascript')
    expect(phrases).toContain('typescript')
    expect(phrases).not.toContain('js')
    expect(phrases).not.toContain('ts')
  })

  it('maps golang and nodejs to go and node', () => {
    const out = extractPhases('Experience with golang and nodejs.', 'body')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('go')
    expect(phrases).toContain('node')
  })

  it('maps Sr./Jr. title tokens to senior/junior', () => {
    const out = extractPhases('Hiring a Sr. Backend Engineer and a Jr. Analyst.', 'title')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('senior')
    expect(phrases).toContain('junior')
  })

  it('does not alias multi-word phrases', () => {
    // "machine learning" must never be rewritten token-by-token.
    const out = extractPhases('We do machine learning.', 'required')
    expect(out.map((k) => k.phrase)).toContain('machine learning')
  })

  it('KEYWORD_ALIASES maps shorthand to allowlist phrases', () => {
    expect(KEYWORD_ALIASES['k8s']).toBe('kubernetes')
    expect(KEYWORD_ALIASES['js']).toBe('javascript')
    expect(KEYWORD_ALIASES['golang']).toBe('go')
  })
})

describe('matchKey', () => {
  it('tokenizes punctuation-bearing allowlist entries into token joins', () => {
    expect(matchKey('next.js')).toBe('next js')
    expect(matchKey('ci/cd')).toBe('ci cd')
    expect(matchKey('scikit-learn')).toBe('scikit learn')
    expect(matchKey('a/b testing')).toBe('a b testing')
    expect(matchKey('mid-level')).toBe('mid level')
  })

  it('preserves tech tokens with + and #', () => {
    expect(matchKey('c++')).toBe('c++')
    expect(matchKey('c#')).toBe('c#')
  })
})

describe('tech token extraction', () => {
  it('finds next.js from "Next.js" text', () => {
    const out = extractPhases('We build with Next.js and Vercel.', 'required')
    expect(out.map((k) => k.phrase)).toContain('next.js')
  })

  it('finds ci/cd from "CI/CD" text', () => {
    const out = extractPhases('You will own our CI/CD pipelines.', 'required')
    expect(out.map((k) => k.phrase)).toContain('ci/cd')
  })

  it('finds scikit-learn from "scikit-learn" text', () => {
    const out = extractPhases('Experience with scikit-learn is a must.', 'required')
    expect(out.map((k) => k.phrase)).toContain('scikit-learn')
  })

  it('still finds c++ and c# tokens', () => {
    const out = extractPhases('Deep knowledge of C++ and C#.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('c++')
    expect(phrases).toContain('c#')
  })

  it('finds multi-word seniority phrases as one entry, dropping the bare unigram', () => {
    const out = extractPhases('You will lead a team as a Senior Manager.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('senior manager')
    expect(phrases).not.toContain('senior')
  })

  it('finds mid-level from hyphenated text', () => {
    const out = extractPhases('This is a mid-level position.', 'body')
    expect(out.map((k) => k.phrase)).toContain('mid-level')
  })

  it('emitted phrases resolve to real allowlist entries', () => {
    const lists = loadKeywordAllowlists()
    const out = extractPhases('Next.js, CI/CD, k8s and Senior Manager experience.', 'required')
    for (const entry of out) {
      const key = matchKey(entry.phrase)
      expect(
        lists.byKey.has(key) || lists.phraseBoostByKey.has(key)
      ).toBe(true)
    }
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

  it('extractJobKeywords flat shape is consistent with the structured result', () => {
    const jd = 'Senior Python Engineer\n\nRequirements\n- 5+ years Python\n- AWS\n- Distributed systems'
    const structured = extractJobKeywordsStructured(jd)
    const flat = extractJobKeywords(jd)
    expect(flat).toEqual(structured.keywords.map((k) => k.phrase))
    expect(flat.length).toBeLessThanOrEqual(30)
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
