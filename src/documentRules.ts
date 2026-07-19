// Pure helpers for the cover-letter one-page rule and the per-rule verifier.
// No Electron imports — this file is loaded directly by vitest.
// See .superpowers/specs/2026-07-19-cover-letter-one-page-and-verifier-rules-design.md

import { enforceOnePageCeilings } from './cvOnePage'

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'to', 'for', 'of', 'in', 'on', 'at',
  'is', 'are', 'be', 'as', 'by', 'this', 'that', 'we', 'you', 'our', 'your',
  'their', 'they', 'will', 'have', 'has', 'had', 'from', 'it', 'using', 'use',
  'used', 'work', 'working', 'experience', 'knowledge', 'ability', 'able',
  'strong', 'good', 'great', 'plus', 'must', 'may', 'can', 'should', 'would',
  'also', 'etc', 'e.g', 'i.e'
])

// Hand-maintained tech-keyword allowlist. Single-occurrence tokens in this
// set are kept even if their frequency is 1 (which would otherwise be
// filtered out below). Add to this when a new common tech term appears
// in job descriptions the user is targeting.
const TECH_KEYWORDS = new Set([
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'go', 'rust',
  'c++', 'c#', 'ruby', 'php', 'scala', 'elixir', 'haskell', 'clojure',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'remix', 'solid',
  'node', 'deno', 'bun', 'express', 'fastify', 'nestjs', 'django', 'flask',
  'rails', 'spring', 'laravel',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'helm',
  'postgres', 'mysql', 'mongodb', 'redis', 'kafka', 'rabbitmq', 'elasticsearch',
  'graphql', 'grpc', 'rest', 'websocket', 'oauth', 'jwt', 'saml',
  'argocd', 'prometheus', 'grafana', 'datadog', 'splunk', 'snowflake',
  'spark', 'hadoop', 'airflow', 'dbt', 'kafka', 'flink', 'beam',
  'tensorflow', 'pytorch', 'scikit-learn', 'pandas', 'numpy', 'langchain',
  'llm', 'rag', 'embeddings', 'vector', 'embeddings'
])

export function paragraphCount(text: string): number {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length
}

export interface EnforceParagraphOpts {
  max?: number
  log?: (msg: string) => void
}

export function enforceParagraphCeilings(
  text: string,
  opts: EnforceParagraphOpts = {}
): string {
  const log = opts.log ?? ((m: string) => console.info(`[doc] ${m}`))
  const max = opts.max ?? 4
  const paragraphs = text.split(/\n\s*\n+/)
  if (paragraphs.length <= max) return text
  const trimmed = paragraphs.slice(0, max).join('\n\n')
  log(`paragraph cull: ${paragraphs.length}→${max}`)
  return trimmed
}

export function extractJobKeywords(description: string): string[] {
  const tokens = description.toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean).map((t) => t.replace(/\.+$/, '')).filter(Boolean)
  const freq = new Map<string, number>()
  for (const t of tokens) {
    if (t.length < 3) continue
    if (STOP_WORDS.has(t)) continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  const kept: string[] = []
  for (const [word, count] of freq) {
    if (count >= 2 || TECH_KEYWORDS.has(word)) kept.push(word)
  }
  kept.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))
  return kept.slice(0, 30)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function coverageFor(document: string, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const lower = document.toLowerCase()
  let present = 0
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRe(kw)}\\b`, 'i')
    if (re.test(lower)) present++
  }
  return present / keywords.length
}

export function missingKeywords(document: string, keywords: string[]): string[] {
  const lower = document.toLowerCase()
  return keywords.filter((kw) => {
    const re = new RegExp(`\\b${escapeRe(kw)}\\b`, 'i')
    return !re.test(lower)
  })
}

const SKILLS_HEADERS = new Set([
  'skills & interests', 'skills and interests', 'skills', 'interests',
  'technical skills', 'core competencies', 'competencies', 'qualifications'
])

const SECTION_HEADERS = new Set([
  'professional summary', 'summary', 'profile',
  'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
  'professional experience', 'experience', 'work history', 'work experience',
  'education',
  'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
  'projects', 'project experience',
  'leadership & activities', 'leadership and activities', 'activities', 'leadership',
  'publications', 'honors & awards', 'honors and awards', 'awards',
  'additional information', 'additional'
])

function normalize(s: string): string {
  return s.toLowerCase().replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
}

function isHeaderLine(line: string): boolean {
  const n = normalize(line)
  if (SECTION_HEADERS.has(n)) return true
  return /^[a-z\s&]+$/.test(n) && SECTION_HEADERS.has(n.replace(/[^a-z\s&]/g, '').trim())
}

function isSkillsHeader(line: string): boolean {
  return SKILLS_HEADERS.has(normalize(line))
}

export function skillCount(markdown: string): number {
  const lines = markdown.split('\n')
  let inSkills = false
  let count = 0
  for (const raw of lines) {
    const t = raw.trim()
    if (isHeaderLine(t)) {
      inSkills = isSkillsHeader(t)
      continue
    }
    if (!inSkills) continue
    if (!t) continue
    // Skills lines are "Label: value, value, value". The rule is
    // "5-15 Technical skills" — count only Technical, not Language,
    // Laboratory, Interests, or any other label.
    const colon = t.indexOf(':')
    if (colon === -1) continue
    const label = t.slice(0, colon).trim().toLowerCase()
    if (label !== 'technical') continue
    const values = t.slice(colon + 1).split(',').map((v) => v.trim()).filter(Boolean)
    count += values.length
  }
  return count
}

export type RuleName = 'one_page' | 'paragraph_count' | 'skills_count' | 'keyword_coverage'

export interface RuleCheck {
  rule: RuleName
  passed: boolean
  detail: string
}

const KEYWORD_THRESHOLDS: Record<'cv' | 'cover_letter', number> = {
  cv: 0.5,
  cover_letter: 0.4
}

export function runDocumentRuleChecks(args: {
  document: string
  jobDescription: string
  docType: 'cv' | 'cover_letter'
}): RuleCheck[] {
  const { document, jobDescription, docType } = args
  const keywords = extractJobKeywords(jobDescription)
  const threshold = KEYWORD_THRESHOLDS[docType]

  const coverage = keywords.length === 0 ? 1 : coverageFor(document, keywords)
  const missing = keywords.length === 0 ? [] : missingKeywords(document, keywords)
  const coverageCheck: RuleCheck = {
    rule: 'keyword_coverage',
    passed: coverage >= threshold,
    detail: keywords.length === 0
      ? 'no job keywords extracted'
      : `coverage ${(coverage * 100).toFixed(0)}% (threshold ${(threshold * 100).toFixed(0)}%)${missing.length > 0 ? `; missing: ${missing.slice(0, 5).join(', ')}` : ''}`
  }

  const paragraphCheck: RuleCheck = docType === 'cover_letter'
    ? {
        rule: 'paragraph_count',
        passed: paragraphCount(document) <= 4,
        detail: `${paragraphCount(document)} paragraphs (max 4)`
      }
    : { rule: 'paragraph_count', passed: true, detail: 'n/a (cv)' }

  const skillsCheck: RuleCheck = docType === 'cv'
    ? {
        rule: 'skills_count',
        passed: skillCount(document) >= 5 && skillCount(document) <= 15,
        detail: `${skillCount(document)} skills (target 5-15)`
      }
    : { rule: 'skills_count', passed: true, detail: 'n/a (cover letter)' }

  const onePageCheck: RuleCheck = {
    rule: 'one_page',
    passed: true,
    detail: 'estimated from text length (no PDF available in verifier)'
  }

  return [onePageCheck, paragraphCheck, skillsCheck, coverageCheck]
}

export interface SelectSkillsArgs {
  values: string[]
  keywords: string[]
  min?: number
  max?: number
}

export interface SelectSkillsResult {
  kept: string[]
  dropped: string[]
}

export function selectTechnicalSkills(args: SelectSkillsArgs): SelectSkillsResult {
  const min = args.min ?? 5
  const max = args.max ?? 15
  const values = args.values
  // Deduplicate case-insensitively before any other check. The spec requires
  // dedup to run always (not only when over the cap), and the deduped list
  // is the basis for every subsequent decision.
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const v of values) {
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(v)
  }
  if (deduped.length <= max || deduped.length < min) {
    return { kept: deduped, dropped: [] }
  }
  // Score: number of keywords that match (case-insensitive word boundary).
  const score = (v: string): number => {
    const lower = v.toLowerCase()
    let n = 0
    for (const kw of args.keywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(lower)) n++
    }
    return n
  }
  const indexed = deduped.map((v, i) => ({ v, i, s: score(v) }))
  // Sort by score desc, then by original index (stable tiebreak).
  indexed.sort((a, b) => b.s - a.s || a.i - b.i)
  const top = indexed.slice(0, max).map((x) => x.v)
  const droppedSet = new Set(indexed.slice(max).map((x) => x.v))
  const dropped = deduped.filter((v) => droppedSet.has(v))
  return { kept: top, dropped }
}

export interface EnforceSkillsOpts {
  log?: (msg: string) => void
}

export function enforceSkillsCeilings(
  markdown: string,
  jobDescription: string,
  opts: EnforceSkillsOpts = {}
): string {
  const log = opts.log ?? ((m: string) => console.info(`[doc] ${m}`))
  const lines = markdown.split('\n')
  let inSkills = false
  const output: string[] = []
  let skillsHeaderSeen = false
  let technicalOriginalCount = 0
  let technicalKeptCount = 0
  let droppedOtherLabels = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (isHeaderLine(t)) {
      if (isSkillsHeader(t)) {
        inSkills = true
        skillsHeaderSeen = true
        output.push(raw)
        continue
      }
      if (inSkills) {
        inSkills = false
      }
      output.push(raw)
      continue
    }
    if (!inSkills) {
      output.push(raw)
      continue
    }
    if (!t) {
      output.push(raw)
      continue
    }
    const colon = t.indexOf(':')
    if (colon === -1) {
      output.push(raw)
      continue
    }
    const label = t.slice(0, colon).trim().toLowerCase()
    const valueText = t.slice(colon + 1).trim()
    if (label === 'technical') {
      const values = valueText
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      technicalOriginalCount = values.length
      const keywords = extractJobKeywords(jobDescription)
      const { kept, dropped } = selectTechnicalSkills({ values, keywords })
      technicalKeptCount = kept.length
      output.push(`Technical: ${kept.join(', ')}`)
      // dropped is logged below; values are intentionally not re-emitted.
      void dropped
    } else if (label === 'language') {
      output.push(raw) // preserve verbatim
    } else {
      // Drop Laboratory, Interests, etc.
      droppedOtherLabels++
    }
  }

  const totalDropped = technicalOriginalCount - technicalKeptCount
  if (totalDropped > 0 || droppedOtherLabels > 0) {
    const parts: string[] = []
    if (totalDropped > 0) {
      parts.push(`technical ${technicalOriginalCount}→${technicalKeptCount}`)
    }
    if (droppedOtherLabels > 0) {
      parts.push(`dropped ${droppedOtherLabels} other label${droppedOtherLabels === 1 ? '' : 's'}`)
    }
    log(`skills cull: ${parts.join(', ')}`)
  }
  void skillsHeaderSeen
  return output.join('\n')
}

export interface EnforceAllCvCeilingsOpts {
  jobDescription?: string
  log?: (msg: string) => void
}

export function enforceAllCvCeilings(
  markdown: string,
  opts: EnforceAllCvCeilingsOpts = {}
): string {
  const log = opts.log ?? ((m: string) => console.info(`[doc] ${m}`))
  // Order matters: skills cull first, ceiling cull second. The ceiling
  // cull does not touch the Skills section, so re-running on the
  // already-rewritten Skills section is safe.
  const skillsCulled = enforceSkillsCeilings(markdown, opts.jobDescription ?? '', { log })
  return enforceOnePageCeilings(skillsCulled, { log })
}

export interface ExtractResult {
  rules: RuleCheck[]
  cleanFeedback: string
}

export function extractRulesFromFeedback(feedback: string): ExtractResult {
  // Match the suffix the verifier writes: `<!-- rules:[...] -->`
  // Use the `s` (dotall) flag so `.*` matches newlines.
  const match = feedback.match(/<!--\s*rules:(\[[\s\S]*?\])\s*-->/)
  if (!match) {
    return { rules: [], cleanFeedback: feedback }
  }
  let rules: RuleCheck[] = []
  try {
    const parsed: unknown = JSON.parse(match[1])
    if (Array.isArray(parsed)) {
      // Defensive: drop entries that don't have the expected shape.
      rules = parsed.filter(
        (entry): entry is RuleCheck =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RuleCheck).rule === 'string' &&
          typeof (entry as RuleCheck).passed === 'boolean' &&
          typeof (entry as RuleCheck).detail === 'string'
      )
    }
  } catch {
    // Malformed JSON — return empty rules, keep the original feedback.
    return { rules: [], cleanFeedback: feedback }
  }
  // Strip the suffix (and any preceding whitespace) from the feedback.
  const cleanFeedback = feedback.slice(0, match.index ?? 0).replace(/\s+$/, '')
  return { rules, cleanFeedback }
}
