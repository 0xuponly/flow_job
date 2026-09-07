// Pure, deterministic Fit heuristic used both as a fast path and as a fallback
// when the LLM scorer is rate-limited or otherwise unavailable. No I/O, no
// external state, safe to import from anywhere.

import { extractJobKeywordsStructured } from '../src/keywordExtractor'

const TECH_SKILLS = new Set([
  'python', 'javascript', 'typescript', 'java', 'go', 'golang', 'rust', 'c++', 'c#', 'ruby', 'swift', 'kotlin',
  'react', 'angular', 'vue', 'svelte', 'node', 'nodejs', 'express', 'django', 'flask', 'spring', 'rails',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'jenkins', 'ci/cd',
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'rabbitmq',
  'graphql', 'rest', 'grpc', 'api', 'microservices',
  'machine learning', 'deep learning', 'ai', 'nlp', 'computer vision', 'data science',
  'blockchain', 'solidity', 'web3', 'ethereum', 'smart contract', 'defi',
  'linux', 'git', 'agile', 'scrum', 'jira', 'figma',
  'product management', 'project management', 'leadership', 'strategy',
  'finance', 'accounting', 'audit', 'compliance', 'risk management',
  'marketing', 'sales', 'business development', 'operations'
])

// Canonical form -> additional forms we accept when scanning text.
const SKILL_ALIASES: Record<string, string[]> = {
  'kubernetes': ['k8s'],
  'postgresql': ['postgres'],
  'postgres': ['postgresql'],
  'node': ['node.js', 'nodejs'],
  'node.js': ['node', 'nodejs'],
  'react': ['reactjs'],
  'reactjs': ['react'],
  'angular': ['angularjs'],
  'vue': ['vue.js', 'vuejs'],
  'javascript': ['js'],
  'typescript': ['ts'],
  'machine learning': ['ml'],
  'natural language processing': ['nlp'],
  'computer vision': ['cv'],
  'continuous integration': ['ci/cd'],
  'continuous deployment': ['cd']
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
  'has', 'have', 'with', 'this', 'that', 'from', 'they', 'been', 'were', 'will', 'would', 'could', 'should',
  'their', 'there', 'which', 'when', 'what', 'about', 'into', 'than', 'then', 'some', 'very', 'also', 'such',
  'make', 'made', 'like', 'time', 'just', 'know', 'take', 'year', 'good', 'come', 'use', 'work', 'well',
  'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'other', 'many', 'only',
  'over', 'think', 'also', 'after', 'back', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even',
  'being', 'looking', 'seeking', 'responsible', 'experience', 'experienced', 'skilled', 'qualified'
])

const ROLE_INDICATORS = [
  'engineer', 'developer', 'architect', 'manager', 'director', 'lead', 'head', 'chief',
  'scientist', 'analyst', 'specialist', 'consultant', 'coordinator', 'administrator',
  'designer', 'researcher', 'associate', 'president', 'vp', 'vice president',
  'intern', 'fellow', 'principal', 'staff', 'senior', 'junior', 'mid-level', 'entry'
]

const EDUCATION_ORDER: Record<string, number> = {
  'phd': 5, 'ph.d.': 5, 'doctorate': 5, 'doctoral': 5,
  'master': 4, "master's": 4, 'masters': 4, 'ma': 4, 'ms': 4, 'mba': 4, 'm.s.': 4, 'm.a.': 4,
  'bachelor': 3, "bachelor's": 3, 'bachelors': 3, 'ba': 3, 'bs': 3, 'b.s.': 3, 'b.a.': 3,
  'associate': 2, "associate's": 2, 'associates': 2, 'a.s.': 2, 'a.a.': 2
}

function expandTerm(term: string): string[] {
  const expanded = new Set<string>([term])
  if (SKILL_ALIASES[term]) {
    for (const alias of SKILL_ALIASES[term]) expanded.add(alias)
  }
  return [...expanded]
}

export function extractTechnicalTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const lower = text.toLowerCase()

  for (const skill of TECH_SKILLS) {
    if (lower.includes(skill)) {
      for (const t of expandTerm(skill)) terms.add(t)
    }
  }

  // Capture multi-word phrases (2-3 tokens) that look like technical terms:
  // contain digits, symbols, or are title-cased in the original text.
  const words = lower.split(/[^a-z0-9+#.]+/)
  for (const w of words) {
    if (!w || w.length <= 3 || STOPWORDS.has(w)) continue
    // Keep words that look technical: contain digits, +, #, ., or are in the
    // allowlist above (already added). Skip plain dictionary-looking words.
    if (/\d|[+#.]/.test(w)) {
      terms.add(w)
      continue
    }
    // Add unigrams only if they are not common stopwords.
    terms.add(w)
  }

  // Bigrams and trigrams of technical-looking tokens.
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]
    const b = words[i + 1]
    if (a && b && a.length > 2 && b.length > 2 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
      terms.add(`${a} ${b}`)
    }
  }

  return terms
}

export function extractRoleTitles(text: string): string[] {
  const roles: string[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const lower = line.toLowerCase().trim()
    const hasIndicator = ROLE_INDICATORS.some(r => lower.includes(r))
    if (hasIndicator && lower.length < 120) {
      roles.push(lower)
    }
  }
  return roles
}

export function extractEducationLevel(text: string): number {
  const lower = text.toLowerCase()
  let maxLevel = 0
  for (const [keyword, level] of Object.entries(EDUCATION_ORDER)) {
    if (lower.includes(keyword) && level > maxLevel) maxLevel = level
  }
  return maxLevel
}

export function extractYearsExperience(text: string): number {
  const lower = text.toLowerCase()
  let maxYears = 0
  const patterns = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?experience/g,
    /(\d+)\s*[-–to]+\s*(\d+)\s*(?:years?|yrs?)/g,
    /(\d+)\+?\s*(?:years?|yrs?)\b/g
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(lower)) !== null) {
      const years = Math.max(...match.slice(1).filter(Boolean).map(Number))
      if (years > maxYears) maxYears = years
    }
  }
  return maxYears
}

export interface StructuredHeuristicInput {
  title: string
  description: string | null
  requirements: string | null
  location: string | null
  baseCv: string
}

function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().replace(/[^a-z0-9+#.]/g, ' ').replace(/\s+/g, ' ').trim()
}

function cvHasPhrase(cvLower: string, phrase: string): boolean {
  const normalized = normalizePhrase(phrase)
  if (!normalized) return false
  // Direct substring match first (cheap).
  if (cvLower.includes(normalized)) return true
  // Token overlap for multi-word phrases.
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.length === 1) {
    // Single token: accept prefix/suffix matches so "postgres" matches "postgresql".
    const needle = tokens[0]
    const cvWords = cvLower.split(/[^a-z0-9+#.]+/)
    return cvWords.some((w) => w.startsWith(needle) || needle.startsWith(w))
  }
  return tokens.every((t) => cvLower.includes(t))
}

function scoreLocation(jobLocation: string | null, cvLower: string): number {
  if (!jobLocation) return 0.5
  const jobLoc = jobLocation.toLowerCase()
  const cvMentionsRemote = /\bremote\b/.test(cvLower)
  const jobIsRemote = /\bremote\b/.test(jobLoc)
  if (jobIsRemote && cvMentionsRemote) return 1
  if (jobIsRemote) return 0.75
  const locParts = jobLoc.split(/[^a-z]+/).filter((w) => w.length > 2)
  if (locParts.length === 0) return 0.5
  const cvMentionsLoc = locParts.some((part) => cvLower.includes(part))
  return cvMentionsLoc ? 1 : 0.5
}

function scoreSeniority(jobText: string, cvLower: string): number {
  const requiredYears = extractYearsExperience(jobText)
  if (requiredYears <= 0) return 0.5
  const cvYears = extractYearsExperience(cvLower)
  if (cvYears >= requiredYears) return 1
  if (cvYears >= requiredYears * 0.7) return 0.75
  return Math.max(0, cvYears / requiredYears)
}

function scoreRole(jobTitle: string, cvLower: string): number {
  const cvRoles = extractRoleTitles(cvLower)
  const jobTitleLower = jobTitle.toLowerCase()
  for (const role of cvRoles) {
    const roleWords = role.split(/[^a-z0-9]+/).filter((w) => w.length > 2)
    const titleWords = jobTitleLower.split(/[^a-z0-9]+/).filter((w) => w.length > 2)
    const matchCount = roleWords.filter((rw) =>
      titleWords.some((tw) => tw === rw || tw.includes(rw) || rw.includes(tw))
    ).length
    if (matchCount >= Math.min(2, roleWords.length / 2)) {
      return 1
    }
  }
  return 0
}

function normalizeJobText(text: string): string {
  // Map common aliases to canonical allowlist terms so structured extraction
  // catches them (e.g. PostgreSQL -> postgres, Node.js -> node).
  return text
    .replace(/\bpostgresql\b/gi, 'postgres')
    .replace(/\bnode\.js\b/gi, 'node')
    .replace(/\bnodejs\b/gi, 'node')
    .replace(/\breactjs\b/gi, 'react')
    .replace(/\bvue\.js\b/gi, 'vue')
    .replace(/\bangularjs\b/gi, 'angular')
    .replace(/\bk8s\b/gi, 'kubernetes')
    .replace(/\bfull[ -]?stack\b/gi, 'fullstack')
}

function scoreKeywords(jobText: string, cvLower: string): { score: number; matched: string[]; missing: string[] } {
  const normalizedJobText = normalizeJobText(jobText)
  const keywordResult = extractJobKeywordsStructured(normalizedJobText)
  const cvTerms = extractTechnicalTerms(cvLower)

  let matchedWeight = 0
  let totalWeight = 0
  const matched: string[] = []
  const missing: string[] = []

  for (const kw of keywordResult.keywords) {
    const phrase = kw.phrase.toLowerCase()
    const present = cvTerms.has(phrase) || cvHasPhrase(cvLower, phrase)
    totalWeight += kw.weight
    if (present) {
      matchedWeight += kw.weight
      if (!matched.includes(kw.phrase)) matched.push(kw.phrase)
    } else if (!missing.includes(kw.phrase)) {
      missing.push(kw.phrase)
    }
  }

  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0
  return { score, matched, missing }
}

/**
 * Structured heuristic scorer. Uses section-aware keyword extraction
 * (required vs preferred), seniority/years matching, role-title overlap,
 * and a location signal. Returns a score in [0, 1].
 */
export function scoreCompatibilityStructured(input: StructuredHeuristicInput): number {
  if (!input.baseCv) return 0.5

  const cvLower = input.baseCv.toLowerCase()
  const jobText = [input.title, input.description ?? '', input.requirements ?? ''].join('\n\n')

  const keywordScore = scoreKeywords(jobText, cvLower).score
  const roleScore = scoreRole(input.title, cvLower)
  const seniorityScore = scoreSeniority(jobText, cvLower)
  const locationScore = scoreLocation(input.location, cvLower)

  // Weights are calibrated to keep existing matchGrade semantics roughly intact.
  const score = keywordScore * 0.55 + roleScore * 0.2 + seniorityScore * 0.15 + locationScore * 0.1
  return Math.min(score, 1)
}

/**
 * Backward-compatible wrapper around the structured heuristic. New code should
 * prefer scoreCompatibilityStructured() so it can pass location/requirements
 * separately for better signal.
 */
export function scoreCompatibility(jobTitle: string, jobDesc: string | null, baseCv: string): number {
  return scoreCompatibilityStructured({
    title: jobTitle,
    description: jobDesc,
    requirements: null,
    location: null,
    baseCv
  })
}
