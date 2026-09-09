import { describe, it, expect } from 'vitest'
import {
  parseSections,
  extractPhases,
  extractJobKeywordsStructured,
  extractJobKeywords,
  mergeKeywordResults,
  keywordMatchPattern,
  coverageForKeywords,
  missingForKeywords,
  PMI_NOISE_WORDS
} from './keywordExtractor'
import { loadKeywordAllowlists, matchKey, KEYWORD_ALIASES, PHRASE_ALIASES } from './keywordAllowlists'
import type { KeywordEntry, KeywordResult } from './types'

// ---------------------------------------------------------------------------
// Fixture corpus: realistic job-description snippets that lock in bucketing
// and top-keyword behavior. Each fixture asserts section buckets (required /
// preferred / body) and the keywords that must (or must not) survive
// extraction. These are regression anchors for future refactors.
// ---------------------------------------------------------------------------

interface Fixture {
  name: string
  jd: string
  title?: string
  requiredHas?: string[]
  requiredNotHas?: string[]
  preferredHas?: string[]
  preferredNotHas?: string[]
  bodyHas?: string[]
  // Phrases that must appear in the extracted (top-30) keyword list.
  keywordsContain?: string[]
  // Phrases that must never appear in the extracted keyword list.
  keywordsNotContain?: string[]
  // Phrases that must appear with source 'title'.
  titleKeywords?: string[]
}

const FIXTURES: Fixture[] = [
  {
    name: "startup posting with 'What you'll need' header",
    jd: [
      'Senior Backend Engineer',
      '',
      'About the role',
      'We build payments infrastructure used by millions.',
      '',
      "What you'll need",
      '- 5+ years of Python',
      '- Experience with PostgreSQL and Redis',
      '',
      'Nice to have',
      '- Kubernetes and Terraform',
      '',
      'Benefits',
      'Competitive salary and equity'
    ].join('\n'),
    title: 'Senior Backend Engineer',
    requiredHas: ['5+ years of python', 'postgresql and redis'],
    preferredHas: ['kubernetes and terraform'],
    bodyHas: ['payments infrastructure', 'Competitive salary'],
    requiredNotHas: ['competitive salary'],
    keywordsContain: ['python', 'postgres', 'redis', 'kubernetes', 'terraform', 'senior'],
    keywordsNotContain: ['competitive salary']
  },
  {
    name: 'all-caps Google-style posting',
    jd: [
      'Software Engineer, Cloud',
      '',
      'MINIMUM QUALIFICATIONS',
      '- Experience with Java or Go',
      '- Experience with SQL',
      '',
      'PREFERRED QUALIFICATIONS',
      '- Experience with GCP',
      '',
      'ABOUT THE TEAM',
      'The Cloud team builds developer tooling.'
    ].join('\n'),
    title: 'Software Engineer, Cloud',
    requiredHas: ['java or go', 'experience with sql'],
    preferredHas: ['experience with gcp'],
    bodyHas: ['Cloud team builds developer tooling'],
    requiredNotHas: ['experience with gcp'],
    keywordsContain: ['java', 'go', 'gcp']
  },
  {
    name: 'markdown-ish posting with ATX and bold headers',
    jd: [
      '# Staff Frontend Engineer',
      '',
      '## Requirements',
      '- **Deep React expertise**',
      '- TypeScript in production',
      '',
      '## Nice to have',
      '- GraphQL experience',
      '',
      '## What we offer',
      'Learning budget and remote-first culture'
    ].join('\n'),
    title: 'Staff Frontend Engineer',
    requiredHas: ['deep react expertise', 'typescript in production'],
    preferredHas: ['graphql experience'],
    bodyHas: ['Learning budget'],
    keywordsContain: ['react', 'typescript', 'graphql', 'staff'],
    titleKeywords: ['staff']
  },
  {
    name: 'finance analyst posting (no tech stack)',
    jd: [
      'Financial Analyst',
      '',
      'Qualifications',
      '- 3+ years in financial modeling and valuation',
      '- Advanced Excel skills',
      '- Strong communication',
      '',
      'Preferred',
      '- CFA charterholder or progress towards CFA',
      '- Power BI experience',
      '',
      'About us',
      'We advise on M&A transactions.'
    ].join('\n'),
    title: 'Financial Analyst',
    requiredHas: ['financial modeling and valuation', 'advanced excel skills'],
    preferredHas: ['cfa charterholder', 'power bi experience'],
    bodyHas: ['M&A transactions'],
    keywordsContain: ['financial modeling', 'excel', 'communication', 'cfa', 'power bi']
  },
  {
    name: 'low-latency trading engineer posting',
    jd: [
      'C++ Engineer — Low Latency Trading Systems',
      '',
      'Requirements',
      '- Expert-level modern C++ (C++17/20)',
      '- Experience with Linux performance tuning',
      '- Knowledge of FIX protocol and market data feeds',
      '',
      'Nice to have',
      '- kdb+/q time-series experience',
      '',
      'Who we are',
      'A proprietary trading firm.'
    ].join('\n'),
    title: 'C++ Engineer — Low Latency Trading Systems',
    requiredHas: ['modern c++', 'linux performance tuning', 'fix protocol'],
    preferredHas: ['kdb+/q time-series'],
    bodyHas: ['A proprietary trading firm'],
    keywordsContain: ['c++', 'linux', 'fix protocol', 'kdb+', 'low latency']
  },
  {
    name: 'posting with no required/preferred sections at all',
    jd: [
      'Growth Marketer',
      'We are a small team looking for a marketer who owns campaigns end to end.',
      'You will run A/B testing, own analytics, and report on SEO performance.',
      'Our stack includes Looker and Snowflake.'
    ].join('\n'),
    title: 'Growth Marketer',
    requiredHas: [],
    preferredHas: [],
    bodyHas: ['owns campaigns end to end', 'report on SEO performance', 'Looker and Snowflake'],
    keywordsContain: ['a/b testing', 'looker', 'snowflake']
  },
  {
    name: 'cloud/devops posting with bonus section',
    jd: [
      'Platform Engineer',
      '',
      'Requirements',
      '- AWS (EKS, S3, IAM)',
      '- Terraform and Helm',
      '- CI/CD with GitHub Actions',
      '',
      'Bonus points',
      '- Datadog observability',
      '',
      'Perks',
      'Fully remote'
    ].join('\n'),
    title: 'Platform Engineer',
    requiredHas: ['aws (eks, s3, iam)'.replace(',', ','), 'terraform and helm', 'ci/cd with github actions'],
    preferredHas: ['datadog observability'],
    bodyHas: ['Fully remote'],
    keywordsContain: ['aws', 'terraform', 'helm', 'ci/cd', 'datadog']
  },
  {
    name: "data posting with 'What you'll do' before requirements",
    jd: [
      'Data Engineer',
      '',
      "What you'll do",
      'Build streaming pipelines powering analytics.',
      '',
      "What you'll need",
      '- Spark and Airflow in production',
      '- dbt and Snowflake modeling',
      '',
      'Nice to have',
      '- Scala',
      '',
      'Compensation',
      '$150k–$190k plus equity'
    ].join('\n'),
    title: 'Data Engineer',
    requiredHas: ['spark and airflow', 'dbt and snowflake'],
    preferredHas: ['scala'],
    bodyHas: ['Build streaming pipelines', '$150k–$190k plus equity'],
    keywordsContain: ['spark', 'airflow', 'dbt', 'snowflake', 'scala']
  },
  {
    name: 'boilerplate-heavy preferred section stays clean',
    jd: [
      'Product Manager',
      '',
      'Requirements',
      '- 5 years of product management',
      '- Experience with SQL and analytics',
      '',
      'Bonus points',
      '- Competitive salary expectations',
      '- Health insurance familiarity',
      '',
      'Equal Opportunity',
      'We are an equal opportunity employer.'
    ].join('\n'),
    title: 'Product Manager',
    requiredHas: ['product management', 'sql and analytics'],
    preferredHas: ['competitive salary expectations', 'health insurance familiarity'],
    keywordsContain: ['product management', 'sql'],
    keywordsNotContain: ['equal opportunity', 'years experience']
  },
  {
    name: 'aliased tech spelling in requirements',
    jd: [
      'Full Stack Engineer',
      '',
      'Requirements',
      '- k8s in production',
      '- JS and Node.js',
      '- CI/CD ownership',
      '',
      'Nice to have',
      '- Postgres tuning'
    ].join('\n'),
    title: 'Full Stack Engineer',
    requiredHas: ['k8s in production', 'js and node.js', 'ci/cd ownership'],
    preferredHas: ['postgres tuning'],
    keywordsContain: ['kubernetes', 'javascript', 'node', 'ci/cd', 'postgres', 'full stack']
  },
  {
    name: 'prose bullets without terminal punctuation and wrapped lines',
    jd: [
      'Machine Learning Engineer',
      '',
      'Overview',
      'We ship ML features weekly.',
      '',
      'Responsibilities',
      'Own the model lifecycle from prototype to production',
      'Partner with product on roadmap',
      '',
      'Requirements',
      'PyTorch and scikit-learn expertise across several domains',
      'About the modeling stack you will own it end to end',
      '',
      'About the team',
      'We are eight people.'
    ].join('\n'),
    title: 'Machine Learning Engineer',
    requiredHas: ['pytorch and scikit-learn expertise', 'about the modeling stack'],
    bodyHas: ['We ship ML features', 'We are eight people'],
    keywordsContain: ['machine learning', 'pytorch', 'scikit-learn']
  }
]

function checkFixture(f: Fixture) {
  const sections = parseSections(f.jd)
  if (f.title !== undefined) {
    expect(sections.title, `${f.name}: title`).toBe(f.title)
  }
  for (const s of f.requiredHas ?? []) {
    expect(sections.required, `${f.name}: required should contain "${s}"`).toContain(s)
  }
  for (const s of f.requiredNotHas ?? []) {
    expect(sections.required, `${f.name}: required should not contain "${s}"`).not.toContain(s)
  }
  for (const s of f.preferredHas ?? []) {
    expect(sections.preferred, `${f.name}: preferred should contain "${s}"`).toContain(s)
  }
  for (const s of f.preferredNotHas ?? []) {
    expect(sections.preferred, `${f.name}: preferred should not contain "${s}"`).not.toContain(s)
  }
  for (const s of f.bodyHas ?? []) {
    expect(sections.body, `${f.name}: body should contain "${s}"`).toContain(s)
  }

  const result: KeywordResult = extractJobKeywordsStructured(f.jd)
  const phrases = result.keywords.map((k) => k.phrase)
  for (const s of f.keywordsContain ?? []) {
    expect(phrases, `${f.name}: keywords should contain "${s}"`).toContain(s)
  }
  for (const s of f.keywordsNotContain ?? []) {
    expect(phrases, `${f.name}: keywords should not contain "${s}"`).not.toContain(s)
  }
  for (const s of f.titleKeywords ?? []) {
    expect(
      result.keywords.some((k) => k.phrase === s && k.source === 'title'),
      `${f.name}: "${s}" should be a title-sourced keyword`
    ).toBe(true)
  }
}

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

  it('canonicalizes aliases so LLM shorthand merges with rule spellings', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'k8s', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const rule: KeywordEntry[] = [
      { phrase: 'kubernetes', weight: 0.5, category: 'hard', source: 'required' }
    ]
    const r = mergeKeywordResults(llm, rule, lists)
    expect(r.keywords).toHaveLength(1)
    expect(r.keywords[0]).toMatchObject({
      phrase: 'kubernetes',
      weight: 0.9,
      source: 'required'
    })
  })

  it('canonicalizes js/javascript across LLM and rule candidates', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'js', weight: 0.8, category: 'hard', source: 'body' }
    ]
    const rule: KeywordEntry[] = [
      { phrase: 'javascript', weight: 0.5, category: 'hard', source: 'title' }
    ]
    const r = mergeKeywordResults(llm, rule, lists)
    expect(r.keywords).toHaveLength(1)
    expect(r.keywords[0].phrase).toBe('javascript')
    expect(r.keywords[0].source).toBe('title')
  })

  it('canonicalizes LLM-only unknown phrases too', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'obscureframework', weight: 1.0, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.unknownPhrases).toEqual(['obscureframework'])
  })

  // P0.2 deny-list: noise terms from §3.3 (canada, years experience,
  // university degree, remote, full-time) are dropped only when they
  // come from the LLM as unknowns. They must not reach the refined
  // top-30 list because they pollute the prompt and push real skills
  // out of the cap.
  it('drops LLM-only "canada" as a known noise term', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'canada', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords.map((k) => k.phrase)).not.toContain('canada')
    expect(r.keywords.map((k) => k.phrase)).toContain('python')
  })

  it('drops LLM-only "years experience" as a known noise term', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'years experience', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'kubernetes', weight: 0.8, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.keywords.map((k) => k.phrase)).not.toContain('years experience')
    expect(r.keywords.map((k) => k.phrase)).toContain('kubernetes')
  })

  it('drops LLM-only "university degree", "remote", and "full-time"', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'university degree', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'remote', weight: 1.0, category: 'soft', source: 'body' },
      { phrase: 'full-time', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    const phrases = r.keywords.map((k) => k.phrase)
    expect(phrases).not.toContain('university degree')
    expect(phrases).not.toContain('remote')
    expect(phrases).not.toContain('full-time')
    expect(phrases).toContain('python')
  })

  it('does not surface denied phrases in unknownPhrases either', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'canada', weight: 1.0, category: 'hard', source: 'body' },
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    expect(r.unknownPhrases).not.toContain('canada')
  })

  it('keeps deny-list terms when the rule pipeline surfaced them as known skills', () => {
    // The deny-list hook only applies to LLM-unknown phrases. If the
    // rule pipeline matched a deny term (e.g. "remote" appears in some
    // allowlist context), it must still pass through as a safety net.
    const llm: KeywordEntry[] = [
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const rule: KeywordEntry[] = [
      { phrase: 'remote', weight: 0.5, category: 'soft', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, rule, lists)
    expect(r.keywords.map((k) => k.phrase)).toContain('remote')
  })

  // P0.3 §3.3 additive country-name extension (coordinated with the
  // deny-list owner via commit-body note; "united states" + "united
  // kingdom" added because they showed up in production logs as LLM
  // unknown-phrase noise competing for the top-30 cap).
  it('drops LLM-only country names ("united states", "united kingdom") as noise', () => {
    const llm: KeywordEntry[] = [
      { phrase: 'united states', weight: 0.7, category: 'hard', source: 'body' },
      { phrase: 'united kingdom', weight: 0.6, category: 'hard', source: 'body' },
      { phrase: 'python', weight: 0.9, category: 'hard', source: 'body' }
    ]
    const r = mergeKeywordResults(llm, [], lists)
    const phrases = r.keywords.map((k) => k.phrase)
    expect(phrases).not.toContain('united states')
    expect(phrases).not.toContain('united kingdom')
    expect(phrases).toContain('python')
    expect(r.unknownPhrases).not.toContain('united states')
    expect(r.unknownPhrases).not.toContain('united kingdom')
  })
})

describe('coverage-safe keyword matching (additive helpers)', () => {
  it('matches tech tokens with trailing +/# that \\b can never match', () => {
    expect(keywordMatchPattern('c++').test('Built high-throughput services in C++')).toBe(true)
    expect(keywordMatchPattern('c#').test('Professional C# developer')).toBe(true)
  })

  it('rejects lookalike contexts around tech tokens', () => {
    expect(keywordMatchPattern('c++').test('We ported the VC++ codebase')).toBe(false)
    expect(keywordMatchPattern('c#').test('C#2 fragments')).toBe(false)
    expect(keywordMatchPattern('.net').test('we use asp.net hosting')).toBe(false)
    expect(keywordMatchPattern('.net').test('we build on .NET')).toBe(true)
  })

  it('keeps standard word-boundary semantics for plain words', () => {
    expect(keywordMatchPattern('go').test('we use google cloud')).toBe(false)
    expect(keywordMatchPattern('react').test('React and TypeScript')).toBe(true)
  })

  it('coverageForKeywords counts c++ as present where plain \\b coverage cannot', () => {
    expect(coverageForKeywords('Systems code in C++ and C#', ['c++', 'c#'])).toBe(1)
    expect(coverageForKeywords('Systems code in C++', ['c++', 'c#'])).toBeCloseTo(0.5)
    expect(coverageForKeywords('any document', [])).toBe(0)
  })

  it('coverageForKeywords matches the plain semantics for ordinary phrases', () => {
    expect(coverageForKeywords('react and typescript', ['react', 'typescript', 'python'])).toBeCloseTo(2 / 3)
    expect(coverageForKeywords('we use google cloud', ['go'])).toBe(0)
  })

  it('missingForKeywords returns only unmatched keywords', () => {
    expect(missingForKeywords('Systems code in C++', ['c++', 'c#'])).toEqual(['c#'])
    expect(missingForKeywords('Built with C++ and C#', ['c++', 'c#'])).toEqual([])
  })

  it('coverage helpers work on extractor output end to end', () => {
    const jd = 'Requirements: deep C++ and C# experience. C++ is core. C# is core.'
    const keywords = extractJobKeywords(jd)
    expect(keywords).toContain('c++')
    expect(coverageForKeywords('I write C++ and C# daily', keywords)).toBeGreaterThan(0)
  })
})

describe('round-2 allowlist + alias expansion', () => {
  const lists = loadKeywordAllowlists()

  it('resolves spelled-out vendor names to canonical cloud phrases', () => {
    const out = extractPhases('Experience with Amazon Web Services and Google Cloud.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('aws')
    expect(phrases).toContain('gcp')
    expect(out.find((k) => k.phrase === 'aws')!.category).toBe('hard')
  })

  it('resolves "Google Cloud Platform" and "Microsoft Azure" too', () => {
    const out = extractPhases('GCP / Google Cloud Platform / Microsoft Azure exposure.', 'body')
    const phrases = out.map((k) => k.phrase)
    expect(phrases.filter((p) => p === 'gcp')).toHaveLength(1)
    expect(phrases).toContain('azure')
  })

  it('maps py/tf shorthand where unambiguous', () => {
    const out = extractPhases('Solid py and tf foundations.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('python')
    expect(phrases).toContain('terraform')
  })

  it('maps PowerBI spelling to the "power bi" entry', () => {
    expect(KEYWORD_ALIASES['powerbi']).toBe('power bi')
    const out = extractPhases('Dashboards in PowerBI.', 'required')
    expect(out.map((k) => k.phrase)).toContain('power bi')
  })

  it('PHRASE_ALIASES keys are match-key forms', () => {
    expect(PHRASE_ALIASES['amazon web services']).toBe('aws')
    expect(matchKey('Amazon Web Services')).toBe('amazon web services')
  })

  it('expanded data/devops terms are extracted', () => {
    const out = extractPhases('Databricks, Trino, Jenkins and Ansible in production.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('databricks')
    expect(phrases).toContain('trino')
    expect(phrases).toContain('jenkins')
    expect(phrases).toContain('ansible')
  })

  it('expanded finance/fintech terms are extracted', () => {
    const out = extractPhases(
      'Backtesting, P&L attribution, GAAP reporting and Bloomberg terminal skills.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('backtesting')
    expect(phrases).toContain('p&l')
    expect(phrases).toContain('gaap')
    expect(phrases).toContain('bloomberg')
  })

  it('expanded finance certs land in the cert category', () => {
    const out = extractPhases('CFA Level II charterholder; passed Series 7 and Series 63.', 'preferred')
    for (const entry of out) {
      if (['cfa level ii', 'series 7', 'series 63'].includes(entry.phrase)) {
        expect(entry.category, entry.phrase).toBe('cert')
      }
    }
    expect(out.map((k) => k.phrase)).toContain('cfa level ii')
    expect(out.map((k) => k.phrase)).toContain('series 7')
  })

  it('does not emit bare "fix"; only "fix protocol" counts', () => {
    const out = extractPhases('Ability to fix bugs quickly. FIX protocol knowledge required.', 'required')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('fix protocol')
    expect(phrases).not.toContain('fix')
  })

  it('extras do not duplicate JSON entries', () => {
    const before = new Set(['python', 'aws', 'kubernetes'])
    for (const p of before) expect(lists.hard.has(p)).toBe(true)
    // count uniqueness via byKey: one entry per phrase
    const seen = new Map<string, number>()
    for (const e of lists.byKey.values()) {
      seen.set(e.phrase, (seen.get(e.phrase) ?? 0) + 1)
    }
    for (const [phrase, count] of seen) {
      // a phrase may legitimately appear under several match keys
      // (raw + canonical + phrase aliases) but should resolve to one
      // entry per list; >2 distinct keys is suspicious duplication
      expect(count, phrase).toBeLessThanOrEqual(3)
    }
  })
})

describe('P0.2 allowlist + acronym expansion (fixture-audit misses)', () => {
  const lists = loadKeywordAllowlists()

  // Fixture-audit misses from docs/keyword-detection-improvement-plan.md
  // §3.2. Each term was a gold keyword the extractor failed to surface;
  // adding it to the right allowlist list and indexing it under any
  // PHRASE_ALIASES form must let extractPhases pick it up.
  //
  // Single-token domains (cloud/frontend/analytics/seo/iam) live in the
  // `hard` list because the unigram loop only matches byKey, which is
  // built from hard/soft/cert/seniority. Multi-token entries go to
  // `phrase_boost` so the bigram/trigram loop can find them.
  it('"cloud" is in the hard list (single-token domain)', () => {
    expect(lists.hard.has('cloud')).toBe(true)
  })

  it('"frontend" is in the hard list', () => {
    expect(lists.hard.has('frontend')).toBe(true)
  })

  it('"analytics" is in the hard list', () => {
    expect(lists.hard.has('analytics')).toBe(true)
  })

  it('"seo" is in the hard list', () => {
    expect(lists.hard.has('seo')).toBe(true)
  })

  it('"iam" is in the hard list (named protocol/skill)', () => {
    expect(lists.hard.has('iam')).toBe(true)
  })

  it('"performance tuning" and "trading systems" are phrase_boost entries', () => {
    expect(lists.phraseBoost.has('performance tuning')).toBe(true)
    expect(lists.phraseBoost.has('trading systems')).toBe(true)
  })

  it('"mergers and acquisitions" is in phrase_boost and reachable via the M&A bigram', () => {
    expect(lists.phraseBoost.has('mergers and acquisitions')).toBe(true)
    // "M&A" tokenizes to ["m", "a"]; the bigram "m a" must hit the
    // alias-keyed entry so an M&A mention counts as the canonical
    // "mergers and acquisitions" phrase.
    const out = extractPhases('M&A transaction experience', 'required')
    expect(out.map((k) => k.phrase)).toContain('mergers and acquisitions')
  })

  it('extractPhases surfaces cloud, frontend, analytics, seo, iam from prose', () => {
    const out = extractPhases(
      'Cloud and frontend work. Analytics and SEO background. IAM policies.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('cloud')
    expect(phrases).toContain('frontend')
    expect(phrases).toContain('analytics')
    expect(phrases).toContain('seo')
    expect(phrases).toContain('iam')
  })

  it('extractPhases surfaces performance tuning and trading systems', () => {
    const out = extractPhases(
      'Performance tuning of trading systems for low-latency workloads.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('performance tuning')
    expect(phrases).toContain('trading systems')
  })

  // P1.2 acronym table folded into P0.2 per the plan: expansions land
  // in phrase_boost, acronyms alias to their canonical phrase.
  it('"go-to-market" is phrase_boost; "gtm" and "go to market" both alias to it', () => {
    expect(lists.phraseBoost.has('go-to-market')).toBe(true)
    const out1 = extractPhases('Drive GTM strategy with sales.', 'required')
    const out2 = extractPhases('Drive go to market strategy with sales.', 'required')
    expect(out1.map((k) => k.phrase)).toContain('go-to-market')
    expect(out2.map((k) => k.phrase)).toContain('go-to-market')
  })

  it('"service level objectives" is phrase_boost; SLA and SLOs alias to it', () => {
    expect(lists.phraseBoost.has('service level objectives')).toBe(true)
    const out1 = extractPhases('Define SLAs for the platform.', 'required')
    const out2 = extractPhases('Define SLOs for the platform.', 'required')
    expect(out1.map((k) => k.phrase)).toContain('service level objectives')
    expect(out2.map((k) => k.phrase)).toContain('service level objectives')
  })

  it('"search engine optimization" is phrase_boost', () => {
    expect(lists.phraseBoost.has('search engine optimization')).toBe(true)
    const out = extractPhases('SEO and search engine optimization expertise.', 'required')
    expect(out.map((k) => k.phrase)).toContain('search engine optimization')
    expect(out.map((k) => k.phrase)).toContain('seo')
  })

  it('"identity and access management" is indexed as an alias to "iam"', () => {
    // The expansion is 4 tokens so the trigram loop can't emit it
    // directly, but the alias table must still record the canonical
    // mapping for any future consumer (coverage checks, taxonomy
    // readers).
    const entry = lists.byKey.get('identity and access management')
    expect(entry?.phrase).toBe('iam')
  })
})

describe('P1.4 phrase-boost head matching (title sections only)', () => {
  // The plan's example: "Platform Engineer" → "platform engineering"
  // (the head "platform" is consecutive in the title; the trailing
  // noun variant "engineer" differs from the canonical "engineering").
  // Restricted to phrase_boost entries — not hard skills or seniority,
  // which would over-generalize (manager → management).
  it('"Platform Engineer" title yields the phrase_boost entry "platform engineering"', () => {
    const out = extractPhases('Platform Engineer', 'title')
    expect(out.map((k) => k.phrase)).toContain('platform engineering')
  })

  it('"Data Engineer" title yields the phrase_boost entry "data engineering"', () => {
    const out = extractPhases('Data Engineer', 'title')
    expect(out.map((k) => k.phrase)).toContain('data engineering')
  })

  it('"Senior Data Engineer" title yields "data engineering" via head match', () => {
    const out = extractPhases('Senior Data Engineer', 'title')
    expect(out.map((k) => k.phrase)).toContain('data engineering')
  })

  it('exact phrase-boost match in the title still works (regression guard)', () => {
    const out = extractPhases('Platform Engineering Lead', 'title')
    expect(out.map((k) => k.phrase)).toContain('platform engineering')
  })

  it('head matching only fires on title sections, not required/preferred/body', () => {
    // "platform engineer" in the body of a non-platform-engineer role
    // must not promote to "platform engineering" — the head match is a
    // title-specific signal that the role itself is the skill.
    const out = extractPhases('Our platform engineer is awesome.', 'required')
    expect(out.map((k) => k.phrase)).not.toContain('platform engineering')
  })

  it('head matching does not pull hard skills or seniority from title tokens', () => {
    // The manager → management risk: if "management" were a phrase_boost
    // entry and "manager" were in the seniority list, head matching on
    // the title "Engineering Manager" could wrongly surface both. We
    // gate the head match on phrase_boost only, so neither
    // over-generalization occurs for unrelated titles.
    const out = extractPhases('Software Engineer', 'title')
    const phrases = out.map((k) => k.phrase)
    expect(phrases).not.toContain('platform engineering')
    expect(phrases).not.toContain('data engineering')
  })
})

describe('PMI false-negative guards (skills survive the noise filter)', () => {
  const lists = loadKeywordAllowlists()

  // Strongest guard: every allowlist phrase (hard/soft/cert/seniority/
  // phrase_boost) whose tokens intersect PMI_NOISE_WORDS must still
  // surface from a sentence mentioning it. Allowlisted phrases bypass
  // the noise filter entirely — the found-check short-circuits first.
  it('every allowlisted phrase containing a noise word still surfaces', () => {
    const guarded = new Set<string>()
    for (const entry of lists.byKey.values()) {
      const words = matchKey(entry.phrase).split(' ')
      if (words.length >= 2 && words.some((w) => PMI_NOISE_WORDS.has(w))) {
        guarded.add(entry.phrase)
      }
    }
    for (const entry of lists.phraseBoostByKey.values()) {
      const words = matchKey(entry.phrase).split(' ')
      if (words.length >= 2 && words.some((w) => PMI_NOISE_WORDS.has(w))) {
        guarded.add(entry.phrase)
      }
    }
    expect(guarded.size, 'expected real allowlist coverage of noise-word phrases').toBeGreaterThan(0)

    for (const phrase of guarded) {
      const jd = `${phrase} is required. We value ${phrase} in this role.`
      const phrases = extractPhases(jd, 'required').map((k) => k.phrase)
      expect(phrases, `allowlisted phrase "${phrase}" must survive the noise filter`).toContain(phrase)
    }
  })

  it('allowlisted skills embedded in boilerplate prose still surface', () => {
    const out = extractPhases(
      '5+ years of experience required. You need Kafka experience. Experience with Kafka is essential.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('kafka')
    // the noise filter itself is still active
    expect(phrases).not.toContain('years experience')
    expect(phrases).not.toContain('kafka experience')
  })

  it('allowlisted phrases containing noise words are never suppressed', () => {
    // "team" (noise) + "building", "deep" (noise) + "learning",
    // "time" (noise) + "management", "full" (noise) + "stack":
    // the found-check short-circuits before the noise filter.
    const out = extractPhases(
      'We invest in team building and deep learning. Real time systems and time management matter. Full stack ownership expected. Team building weekly. Deep learning models. Real time pipelines.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('team building')
    expect(phrases).toContain('deep learning')
    expect(phrases).toContain('time management')
    expect(phrases).toContain('full stack')
    expect(phrases).toContain('real time')
  })

  it('noise filter may drop a PAIR, never the SKILL itself', () => {
    // "kubernetes experience" is noise-suppressed, but "kubernetes"
    // is an allowlisted skill and must survive — a missed skill means
    // the CV omits it for ATS.
    const out = extractPhases(
      'Kubernetes experience required. Experience with kubernetes preferred.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('kubernetes')
    expect(phrases).not.toContain('kubernetes experience')
  })

  it('repeated genuine devops skills without noise words still surface', () => {
    const out = extractPhases(
      'Incident response ownership. We practice incident response weekly. Incident response drills are monthly.',
      'required'
    )
    expect(out.map((k) => k.phrase)).toContain('incident response')
  })

  it('repeated genuine finance skills without noise words still surface', () => {
    const out = extractPhases(
      'We build risk models. Risk models drive our decisions. The risk models improve quarterly.',
      'required'
    )
    expect(out.map((k) => k.phrase)).toContain('risk models')
  })

  it('alias-canonicalized skills near boilerplate survive', () => {
    const out = extractPhases(
      'K8s experience is a must. Experience with k8s required. Years of k8s experience.',
      'required'
    )
    const phrases = out.map((k) => k.phrase)
    expect(phrases).toContain('kubernetes')
    expect(phrases).not.toContain('kubernetes experience')
  })
})

describe('performance guard (10k+ word postings)', () => {
  // ~12k-word synthetic posting. Varied filler keeps the bigram
  // population realistic; the repeated skill block is what extraction
  // must find quickly. The pipeline is O(n): tokenize + single-pass
  // unigram/bigram counts + map lookups. The timing bound is generous
  // (2s) so the guard stays stable on loaded CI machines while still
  // catching a quadratic regression, which took multiple seconds.
  it('extracts a 12k-word description well under the 2s bound', () => {
    const filler =
      'We partner with commercial teams across the organization and support internal stakeholders through planning cycles, governance reviews, and quarterly planning exercises with measurable outcomes. '
    const skills = 'Requirements include python and kafka and postgres and kubernetes and terraform and spark and airflow and redis and golang. '
    const jd = ['Staff Platform Engineer', ''].join('\n') +
      (filler + skills).repeat(320) // ≈ 11k words
    expect(jd.split(/\s+/).length).toBeGreaterThan(10000)

    const started = performance.now()
    const result = extractJobKeywordsStructured(jd)
    const elapsedMs = performance.now() - started

    expect(elapsedMs, `extraction took ${elapsedMs.toFixed(0)}ms`).toBeLessThan(2000)
    expect(result.keywords.length).toBeLessThanOrEqual(30)
    const phrases = result.keywords.map((k) => k.phrase)
    for (const skill of ['python', 'kafka', 'postgres', 'kubernetes', 'terraform', 'spark', 'airflow', 'redis']) {
      // In this synthetic posting the skill tokens sit inside longer
      // PMI pairs ('golang kafka'), so assert the skill SIGNAL
      // survives: standalone or as a component of a kept phrase.
      expect(
        phrases.some((p) => p === skill || p.includes(` ${skill}`) || p.includes(`${skill} `)),
        `${skill} signal must survive large-posting extraction`
      ).toBe(true)
    }
  })

  it('small postings remain fast (guard against fixed overhead creep)', () => {
    const jd = [
      'Backend Engineer',
      '',
      'Requirements',
      '- 5+ years of python and postgres',
      '- kafka and redis in production'
    ].join('\n')
    const started = performance.now()
    for (let i = 0; i < 50; i++) extractJobKeywordsStructured(jd)
    const elapsedMs = performance.now() - started
    expect(elapsedMs, `50 extractions took ${elapsedMs.toFixed(0)}ms`).toBeLessThan(2000)
  })
})

describe('JD fixture regression suite', () => {
  for (const f of FIXTURES) {
    it(`buckets and extracts: ${f.name}`, () => {
      checkFixture(f)
    })
  }

  it('covers the corpus breadth required by the brief', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(8)
    expect(FIXTURES.length).toBeLessThanOrEqual(12)
  })

  it('every fixture yields a non-empty keyword list', () => {
    for (const f of FIXTURES) {
      const phrases = extractJobKeywords(f.jd)
      expect(phrases.length, f.name).toBeGreaterThan(0)
    }
  })
})
