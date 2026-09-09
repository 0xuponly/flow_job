// Pure, deterministic keyword extraction pipeline. No I/O, no Electron
// imports — safe to import from anywhere, including vitest and the
// renderer.

import { loadKeywordAllowlists, KEYWORD_ALIASES, matchKey } from './keywordAllowlists'
import type { KeywordAllowlists } from './keywordAllowlists'
import type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult, YearsOfExperience } from './types'
export type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult, YearsOfExperience }

const REQUIRED_RE = /\b(requirements?|required|must[- ]?haves?|basic qualifications|minimum qualifications|qualifications|essential|what you(?:'|’)ll need|what you will need|what we(?:'|’)re looking for|what we are looking for|who you are|what you bring)\b/i
// Tested before REQUIRED_RE so a heading like "Preferred Qualifications"
// (which contains both words) lands in the preferred bucket.
const PREFERRED_RE = /\b(preferred|nice[- ]?to[- ]?haves?|bonus|plus(?:es)?|good to have|desired|extras?|differentiators?)\b/i
// Section-noun phrases that signal "we are now back in body" — these are
// the typical headings that follow a required/preferred block.
const RESET_RE = /^(about|overview|company|role|responsibilities|duties|benefits|perks|equal opportunity|what we|who we|why|how we|how to apply|apply now|join|our team|mission|vision|summary|what you'll do|what you will do|compensation|salary|interview process|working at|life at)\b/i

// Canonical trailing-section headings, matched exactly (after markdown
// stripping + lowercasing) before the prose gates apply: phrases like
// "Who we are" or "What you'll do" contain be/modal verbs ("are", "do")
// that the prose gate rightly rejects in longer lines, but as exact
// heading forms they are unambiguous reset points.
const RESET_EXACT = new Set([
  'who we are',
  'who we',
  'what we do',
  'what we offer',
  "what you'll do",
  'what you will do',
  'about us',
  'about the role',
  'about the team',
  'about the company',
  'our story',
  'why join us',
  'how to apply',
  'benefits',
  'perks'
])

// Lines that start like prose, not like a heading. Guards every header
// classification so body/bullet text never flips the section bucket.
const HEADING_START_BLOCK_RE = /^(we|our|ours|you|your|you're|youre|this|that|these|those|it|its|there|they|their|the|i|me|my)\b/i
const HEADING_MODAL_RE = /\b(is|are|was|were|be|been|being|will|would|can|could|should|shall|do|does|did|include|includes|including)\b/i
const A_PLUS_RE = /\b(?:a|an)\s+plus\b/i

function looksLikeHeading(t: string): boolean {
  if (t.split(/\s+/).length > 8) return false
  if (/[,:;]/.test(t)) return false
  if (HEADING_START_BLOCK_RE.test(t)) return false
  if (HEADING_MODAL_RE.test(t)) return false
  if (A_PLUS_RE.test(t)) return false
  return true
}

// Strips markdown dressing (ATX hashes, full-line bold, trailing
// emphasis/colon) so "## Requirements", "**Nice to have**" and
// "Requirements:" classify like their plain forms.
function normalizeHeaderCandidate(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^#{1,6}\s*/, '')
  t = t.replace(/^\*\*(.+?)\*\*\s*$/, '$1')
  t = t.replace(/^__(.+?)__\s*$/, '$1')
  t = t.replace(/\s*[*_`~]+$/, '')
  t = t.replace(/\s*:\s*$/, '')
  return t.trim()
}

function isHeaderLine(line: string): { required: true } | { preferred: true } | { reset: true } | null {
  const t = normalizeHeaderCandidate(line)
  if (t === '') return null
  // Headers are short lines without terminal sentence punctuation.
  if (t.length > 60) return null
  if (/[.!?]$/.test(t)) return null
  // Content lines (bullets, digits, compensation figures) are never
  // headers — even when they contain a section or preference word
  // ("$150k–$190k plus equity" must not flip the bucket).
  if (/^[-*•\d$]/.test(t)) return null
  if (RESET_EXACT.has(t.toLowerCase())) return { reset: true }
  if (PREFERRED_RE.test(t) && looksLikeHeading(t)) return { preferred: true }
  if (REQUIRED_RE.test(t) && looksLikeHeading(t)) return { required: true }
  // Reset headings are gated the same way, so a wrapped content line
  // like "About the platform you will design..." inside a required
  // section does not falsely reset the bucket to body.
  if (RESET_RE.test(t) && looksLikeHeading(t)) return { reset: true }
  return null
}

// Cosmetics for the extracted title: drop markdown dressing and any
// trailing colon ("# Senior Engineer:" → "Senior Engineer").
function normalizeTitle(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^#{1,6}\s*/, '')
  t = t.replace(/^\*\*(.+?)\*\*\s*$/, '$1')
  t = t.replace(/^__(.+?)__\s*$/, '$1')
  t = t.replace(/\s*:\s*$/, '')
  return t.trim()
}

export function parseSections(description: string): {
  title: string
  required: string
  preferred: string
  body: string
} {
  const lines = description.split('\n')
  let title = ''
  let bucket: 'body' | 'required' | 'preferred' = 'body'
  const requiredLines: string[] = []
  const preferredLines: string[] = []
  const bodyLines: string[] = []
  let titleSeen = false

  for (const raw of lines) {
    const t = raw.trim()
    // The first non-empty line is always the title; never treat it as a header.
    if (!titleSeen) {
      if (t === '') continue
      title = normalizeTitle(t)
      titleSeen = true
      continue
    }
    const header = isHeaderLine(raw)
    if (header) {
      if ('required' in header) bucket = 'required'
      else if ('preferred' in header) bucket = 'preferred'
      else bucket = 'body'
      continue
    }
    if (t === '') continue
    if (bucket === 'required') requiredLines.push(raw.toLowerCase())
    else if (bucket === 'preferred') preferredLines.push(raw.toLowerCase())
    else bodyLines.push(raw)
  }

  return {
    title,
    required: requiredLines.join('\n'),
    preferred: preferredLines.join('\n'),
    body: bodyLines.join('\n')
  }
}

function sectionBoost(source: KeywordSource): number {
  switch (source) {
    case 'title': return 3.0
    case 'required': return 2.0
    case 'preferred': return 1.0
    case 'body': return 1.5
  }
}

function categoryBoost(cat: KeywordCategory): number {
  switch (cat) {
    case 'hard': return 1.0
    case 'cert': return 1.0
    case 'seniority': return 0.9
    case 'soft': return 0.7
  }
}

function phraseLengthBoost(phrase: string): number {
  const tokens = phrase.split(' ').length
  return Math.min(1.5, 1.0 + 0.15 * (tokens - 1))
}

const PRE_LLM_CAP = 40
const POST_RANK_CAP = 30

function computeWeight(entry: KeywordEntry): number {
  const s = (0.5 * sectionBoost(entry.source) / 3.0)
         + (0.3 * categoryBoost(entry.category))
         + (0.2 * phraseLengthBoost(entry.phrase) / 1.5)
  return Math.max(0, Math.min(1, s))
}

export function extractJobKeywordsStructured(description: string): KeywordResult {
  const sections = parseSections(description)
  const allowlists = loadKeywordAllowlists()

  // P1.3: per-section negation detector. Phrases that only appear
  // in negated contexts within a section are dropped from that
  // section's keyword bucket before dedupe.
  const negatedBySection = {
    title: detectFullyNegatedPhrases(sections.title, allowlists),
    required: detectFullyNegatedPhrases(sections.required, allowlists),
    preferred: detectFullyNegatedPhrases(sections.preferred, allowlists),
    body: detectFullyNegatedPhrases(sections.body, allowlists)
  }

  const collected: KeywordEntry[] = []
  // Title is one line; parseSections already extracted it. Run extractPhases on it
  // as a single line so allowlist matches inside the title are captured.
  if (sections.title) {
    collected.push(...extractPhases(sections.title, 'title', negatedBySection.title))
  }
  if (sections.required) collected.push(...extractPhases(sections.required, 'required', negatedBySection.required))
  if (sections.preferred) collected.push(...extractPhases(sections.preferred, 'preferred', negatedBySection.preferred))
  if (sections.body) collected.push(...extractPhases(sections.body, 'body', negatedBySection.body))

  // Dedupe by (phrase, source) — same phrase in title and body stays as 2 entries.
  const seen = new Set<string>()
  const deduped: KeywordEntry[] = []
  for (const e of collected) {
    const key = `${e.source}::${e.phrase}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(e)
  }

  // extractPhases prefers hard/soft/cert over seniority; "senior" can collide
  // with the seniority allowlist. The category is set from the allowlist, not
  // from the text, so the first match wins for a given (phrase, source).

  // Compute weights.
  const weighted = deduped.map((e) => ({ ...e, weight: computeWeight(e) }))

  // Sort by weight desc, then alphabetically for stable order.
  weighted.sort((a, b) => b.weight - a.weight || a.phrase.localeCompare(b.phrase))

  // Pre-LLM cap is 40; final cap is 30.
  const capped = weighted.slice(0, PRE_LLM_CAP)

  // P1.3: structured years-of-experience metadata. Additive — always
  // present on the result so consumers don't have to defend against
  // undefined. Empty array when no years mentions are found.
  const yearsOfExperience = extractYearsOfExperience(sections, allowlists)

  return {
    keywords: capped.slice(0, POST_RANK_CAP),
    refinedByLlm: false,
    unknownPhrases: [],
    yearsOfExperience
  }
}

const UNKNOWN_DOWNWEIGHT = 0.8

// Single-token alias canonicalization for merge dedupe: LLM shorthand
// ("k8s", "js") and rule/allowlist spellings ("kubernetes",
// "javascript") collapse onto one canonical phrase instead of
// appearing as two duplicate keywords. Multi-word phrases pass through
// untouched.
function canonicalPhrase(s: string): string {
  const t = s.toLowerCase().trim()
  return KEYWORD_ALIASES[t] ?? t
}

// P0.2 deny-list: noise terms from the LLM extraction logs (§3.3) that
// pollute the refined top-30 list and push real skills out of the cap.
// Applied ONLY to LLM-unknown phrases — when the rule pipeline or
// allowlist already surfaced a term, it is preserved as the safety net.
// Matching is by match-key form (lowercase, token-joined) so "M&A" and
// "m & a" both resolve to the same entry as "m&a".
//
// P0.3 §3.3 additive extension (owner: docswright, landed in 6345d30;
// see P0.3 commit body for the coordination note): country names that
// the LLM surfaces as keywords. "canada" was already present; added
// the two full forms observed in the production logs. Ambiguous short
// forms ("us", "uk") are intentionally NOT included because they collide
// with too many legitimate tokens.
export const LLM_DENY_LIST: ReadonlySet<string> = new Set([
  'canada',
  'united states',
  'united kingdom',
  'years experience',
  'university degree',
  'remote',
  'full-time',
  'full time'
])

function isDeniedUnknownPhrase(phrase: string): boolean {
  return LLM_DENY_LIST.has(matchKeyForDeny(phrase))
}

function matchKeyForDeny(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .join(' ')
}

function isInAllowlist(phrase: string, lists: KeywordAllowlists): boolean {
  if (lists.hard.has(phrase)) return true
  if (lists.soft.has(phrase)) return true
  if (lists.cert.has(phrase)) return true
  if (lists.seniority.has(phrase)) return true
  if (lists.phraseBoost.has(phrase)) return true
  return false
}

function isPhraseSubstring(longer: string, shorter: string): boolean {
  return longer !== shorter && longer.includes(shorter)
}

/**
 * Merge LLM-extracted candidates with rule-pipeline candidates.
 *
 * - Phrase in both (after alias canonicalization): LLM wins
 *   category+weight; rule wins source.
 * - LLM-only:
 *   - In allowlist: accept as-is.
 *   - Unknown: accept with weight *= 0.8, add to unknownPhrases.
 * - Rule-only: accept as-is (safety net for LLM omissions / failure).
 *
 * Pure function: no I/O, no Electron imports. Safe to unit-test.
 */
export function mergeKeywordResults(
  llm: KeywordEntry[],
  rule: KeywordEntry[],
  lists: KeywordAllowlists
): KeywordResult {
  const ruleByPhrase = new Map<string, KeywordEntry>()
  for (const e of rule) ruleByPhrase.set(canonicalPhrase(e.phrase), e)

  const merged: KeywordEntry[] = []
  const unknownPhrases = new Set<string>()
  const seen = new Set<string>()

  // 1. Process LLM candidates.
  for (const llmEntry of llm) {
    const phraseNorm = canonicalPhrase(llmEntry.phrase)
    if (!phraseNorm) continue
    if (seen.has(phraseNorm)) continue
    seen.add(phraseNorm)

    const ruleEntry = ruleByPhrase.get(phraseNorm)
    if (ruleEntry) {
      // LLM wins category+weight, rule wins source.
      merged.push({
        phrase: phraseNorm,
        weight: llmEntry.weight,
        category: llmEntry.category,
        source: ruleEntry.source
      })
    } else {
      const isKnown = isInAllowlist(phraseNorm, lists)
      if (isKnown) {
        merged.push({ ...llmEntry, phrase: phraseNorm })
      } else {
        // P0.2 deny-list: drop LLM-unknown noise phrases (locations,
        // years-of-experience boilerplate, degree mentions, employment
        // types) before they can push real skills out of the top-30
        // cap. Only applies to LLM-unknown entries — a phrase the rule
        // pipeline or allowlist already surfaced is preserved.
        if (isDeniedUnknownPhrase(phraseNorm)) continue
        merged.push({
          phrase: phraseNorm,
          weight: Math.max(0, Math.min(1, llmEntry.weight * UNKNOWN_DOWNWEIGHT)),
          category: llmEntry.category,
          source: llmEntry.source
        })
        unknownPhrases.add(phraseNorm)
      }
    }
  }

  // 2. Append rule-only candidates (safety net).
  for (const ruleEntry of rule) {
    const phraseNorm = canonicalPhrase(ruleEntry.phrase)
    if (!phraseNorm) continue
    if (seen.has(phraseNorm)) continue
    seen.add(phraseNorm)
    merged.push({ ...ruleEntry, phrase: phraseNorm })
  }

  // 3. Substring collision: longer phrase wins.
  const sortedByLength = [...merged].sort((a, b) => b.phrase.length - a.phrase.length)
  const deduped: KeywordEntry[] = []
  for (const entry of sortedByLength) {
    if (deduped.some((kept) => isPhraseSubstring(kept.phrase, entry.phrase))) continue
    deduped.push(entry)
  }

  // 4. Sort by weight desc, then alphabetically.
  deduped.sort((a, b) => b.weight - a.weight || a.phrase.localeCompare(b.phrase))

  return {
    keywords: deduped.slice(0, POST_RANK_CAP),
    refinedByLlm: llm.length > 0,
    unknownPhrases: [...unknownPhrases]
  }
}

export function extractJobKeywords(description: string): string[] {
  return extractJobKeywordsStructured(description).keywords.map((k) => k.phrase)
}

/**
 * Case-insensitive match pattern for a keyword phrase, with boundaries
 * that tolerate tech punctuation. `\b` only works against word
 * characters, so the plain `\\b${kw}\\b` used by simple consumers never
 * matches phrases whose edge is a non-word char: "c++", "c#", or a
 * hypothetical ".net" can never be found in a document. Here the
 * standard boundary is kept for word edges and replaced by a
 * lookaround over tech-token chars (+/#/.) for punctuation edges.
 * Additive helper — consumers can adopt it without changing call-site
 * signatures.
 */
export function keywordMatchPattern(phrase: string): RegExp {
  const esc = phrase.replace(/[.*+?${}()|[\]\\]/g, '\\$&')
  const left = /^[a-z0-9]/i.test(phrase) ? '\\b' : '(?<![a-z0-9+#])'
  const right = /[a-z0-9]$/i.test(phrase) ? '\\b' : '(?![a-z0-9+#])'
  return new RegExp(`${left}${esc}${right}`, 'i')
}

/**
 * Coverage over `document` for `keywords`, identical in semantics to
 * the documentRules helper but with boundary-tolerant matching so tech
 * tokens like "c++" or "c#" count as present when written in the
 * document. Additive; no existing signature changes.
 */
export function coverageForKeywords(document: string, keywords: string[]): number {
  if (keywords.length === 0) return 0
  let present = 0
  for (const kw of keywords) {
    if (keywordMatchPattern(kw).test(document)) present++
  }
  return present / keywords.length
}

/**
 * Missing-keyword list companion to coverageForKeywords.
 */
export function missingForKeywords(document: string, keywords: string[]): string[] {
  return keywords.filter((kw) => !keywordMatchPattern(kw).test(document))
}

// ---------------------------------------------------------------------------
// P1.3 contextual rules. See docs/keyword-detection-improvement-plan.md
// §P1.3. Two deterministic, unit-test-covered rules added to the rule
// pipeline:
//
//   1. Negation detector — if a skill appears ONLY in negated
//      contexts inside a section, drop it from that section's keyword
//      bucket. A non-negated mention of the same skill in the same
//      section "rescues" it. Cross-section behavior is natural:
//      a body-section negation does not affect a required-section
//      mention.
//
//   2. Years-of-experience metadata — parse "5+ years of Python",
//      "3-5 years experience with Kubernetes", and similar patterns
//      into structured {phrase, minYears} pairs, exposed additively
//      on KeywordResult. Negated years mentions are dropped.
//
// Both rules are per-section and per-line so they fit the existing
// parseSections → extractPhases flow without a second pass over the
// whole JD. Performance is O(n) on the section text.
// ---------------------------------------------------------------------------

// P1.3 negation cues. Each is the smallest substring whose presence in
// a line signals that an allowlist skill in that line is being
// explicitly NOT-required / NOT-needed. Tested via the line-level scan
// in isNegatedLine.
const NEGATION_CUE_PATTERNS: readonly RegExp[] = [
  // "Kubernetes is not required" / "Go not required" / "is not needed"
  /\b(?:is\s+|are\s+)?not\s+(?:strictly\s+)?(?:required|needed|necessary)\b/i,
  // "Go is a plus, not a requirement" / "TypeScript is a plus, not required"
  /\b(?:is\s+|are\s+)?a\s+plus\s*,?\s+not\s+(?:a\s+)?requirement\b/i,
  // "No experience with React needed" / "no GraphQL experience required"
  /\bno\s+(?:\w+\s+){0,3}experience\s+(?:with\s+|in\s+)?\w/i,
  // "experience with X is not required"
  /\bexperience\s+with\s+\w[\w+#./ -]*\s+(?:is\s+)?not\s+(?:required|needed)\b/i,
  // "X is optional" — also counts as a negation for the required bucket
  /\b(?:is\s+|are\s+)?optional\b/i
]

function isNegatedLine(line: string): boolean {
  const t = normalizeHeaderCandidate(line)
  if (t === '') return false
  for (const re of NEGATION_CUE_PATTERNS) {
    if (re.test(t)) return true
  }
  return false
}

// P1.3: collect the allowlist-matching phrases in a line. Returns
// matchKey forms so the caller can dedupe across unigram/bigram/
// trigram matches of the same phrase.
function findAllowlistMatchesInTokens(
  tokens: string[],
  allowlists: KeywordAllowlists
): Set<string> {
  const out = new Set<string>()
  // Try longer n-grams first so "go to market" beats "go" in a
  // negation context; extractPhases' own length-desc sort then
  // doesn't matter — the negation set is per-phrase, not per-token.
  for (const gram of [...trigrams(tokens), ...bigrams(tokens)]) {
    const hit = allowlists.byKey.get(gram)
    if (hit) {
      out.add(matchKey(hit.phrase))
      continue
    }
    const boost = allowlists.phraseBoostByKey.get(gram)
    if (boost) out.add(matchKey(boost.phrase))
  }
  for (const t of tokens) {
    const hit = allowlists.byKey.get(t) ?? allowlists.phraseBoostByKey.get(t)
    if (hit) out.add(matchKey(hit.phrase))
  }
  return out
}

// P1.3: per-section scan, returns matchKey forms of phrases whose
// EVERY mention in this section is negated. Phrases with at least
// one non-negated mention in this section are NOT in the set (so
// they survive to the keyword bucket).
function detectFullyNegatedPhrases(
  section: string,
  allowlists: KeywordAllowlists
): Set<string> {
  const occurrences = new Map<string, { negated: boolean; nonNegated: boolean }>()
  if (!section) return new Set()
  const lines = section.split('\n')
  for (const raw of lines) {
    const negated = isNegatedLine(raw)
    const tokens = tokenize(raw).map(canonicalToken)
    const matches = findAllowlistMatchesInTokens(tokens, allowlists)
    for (const key of matches) {
      const occ = occurrences.get(key) ?? { negated: false, nonNegated: false }
      if (negated) occ.negated = true
      else occ.nonNegated = true
      occurrences.set(key, occ)
    }
  }
  const fullyNegated = new Set<string>()
  for (const [key, occ] of occurrences) {
    if (occ.negated && !occ.nonNegated) fullyNegated.add(key)
  }
  return fullyNegated
}

// P1.3: years-of-experience extraction. Per-line scan, returns one
// entry per (years-mention, allowlist-skill) pair where the skill is
// in the same line as the years mention. Negated lines are skipped
// entirely — "5+ years of Python not required" must not surface as
// years metadata. A skill mentioned across multiple lines keeps the
// maximum minYears so the fit heuristic has the strictest signal.
//
// Ranges ("3-5 years") and single numbers ("5+ years") are matched in
// a range-first pass: a range yields one entry (its lower bound),
// and any single-year regex match whose span falls inside a range
// is suppressed so "3-5 years" doesn't double-count as both 3 and 5.
const YEARS_RANGE_RE = /(\d+)\s*[-–]\s*(\d+)\+?\s*(?:years?|yrs?)\b/gi
const YEARS_SINGLE_RE = /(\d+)\+?\s*(?:years?|yrs?)\b/gi

function extractYearsOfExperience(
  sections: { title: string; required: string; preferred: string; body: string },
  allowlists: KeywordAllowlists
): YearsOfExperience[] {
  // phrase -> max(minYears) so repeated mentions keep the strictest signal.
  const out = new Map<string, number>()
  for (const [, text] of [
    ['', sections.title],
    ['', sections.required],
    ['', sections.preferred],
    ['', sections.body]
  ] as const) {
    if (!text) continue
    for (const raw of text.split('\n')) {
      // Skip negated lines (e.g., "5+ years of Python not required").
      if (isNegatedLine(raw)) continue

      // 1) Find all range matches on this line so we can suppress
      //    their inner single-year matches. A range yields one
      //    entry: minYears = lower bound (3 in "3-5 years").
      const rangeSpans: Array<{ start: number; end: number; minYears: number }> = []
      for (const m of raw.matchAll(YEARS_RANGE_RE)) {
        const start = m.index ?? 0
        const end = start + m[0].length
        const lower = parseInt(m[1], 10)
        const upper = parseInt(m[2], 10)
        const minYears = Math.min(lower, upper)
        rangeSpans.push({ start, end, minYears })
        const skill = findClosestAllowlistSkill(raw, start, allowlists)
        if (!skill) continue
        const existing = out.get(skill)
        if (existing === undefined || minYears > existing) {
          out.set(skill, minYears)
        }
      }

      // 2) Find all single-year matches, skipping any that fall
      //    inside a range span (avoids double-counting 3 in "3-5").
      for (const m of raw.matchAll(YEARS_SINGLE_RE)) {
        const start = m.index ?? 0
        const end = start + m[0].length
        if (rangeSpans.some((r) => start >= r.start && end <= r.end)) continue
        const minYears = parseInt(m[1], 10)
        const skill = findClosestAllowlistSkill(raw, start, allowlists)
        if (!skill) continue
        const existing = out.get(skill)
        if (existing === undefined || minYears > existing) {
          out.set(skill, minYears)
        }
      }
    }
  }
  return [...out.entries()].map(([phrase, minYears]) => ({ phrase, minYears }))
}

// P1.3: scan the line around the years-mention offset for the
// closest allowlist skill. Considers unigrams, bigrams, and trigrams
// centered on the years mention.
function findClosestAllowlistSkill(
  line: string,
  yearOffset: number,
  allowlists: KeywordAllowlists
): string | null {
  const tokens = tokenize(line).map(canonicalToken)
  if (tokens.length === 0) return null
  // The years tokens are digit/word-pieces; re-tokenize without
  // them and look at the surviving token indices to find the closest
  // n-gram to the years mention.
  const lower = line.toLowerCase()
  const yearsMatch = lower.slice(yearOffset).match(/(\d+)\+?\s*(?:years?|yrs?)\b/)
  if (!yearsMatch) return null
  const yearsEnd = yearOffset + yearsMatch[0].length
  // Try bigrams and trigrams of the tokenized line; pick the one
  // whose character span is nearest the years mention.
  type Candidate = { phrase: string; dist: number }
  const candidates: Candidate[] = []
  // n-gram index ranges
  let pos = 0
  const tokenRanges: Array<{ start: number; end: number; token: string }> = []
  for (const t of tokens) {
    // Find the next occurrence of the token after `pos`.
    const idx = lower.indexOf(t, pos)
    if (idx >= 0) {
      tokenRanges.push({ start: idx, end: idx + t.length, token: t })
      pos = idx + t.length
    }
  }
  function consider(startIdx: number, endIdx: number, gram: string[]) {
    const start = tokenRanges[startIdx]?.start ?? 0
    const end = tokenRanges[endIdx - 1]?.end ?? 0
    const text = gram.join(' ')
    const hit = allowlists.byKey.get(text) ?? allowlists.phraseBoostByKey.get(text)
    if (!hit) return
    // distance to years mention: prefer tokens AFTER the years (the
    // "5+ years OF python" form); tokens BEFORE are penalized
    // slightly so "experience with python, 5+ years" still works
    // but the post-years token wins ties.
    const dist = end <= yearOffset
      ? (yearOffset - end) + 5  // before: small penalty
      : Math.max(0, start - yearsEnd)  // after: true distance
    candidates.push({ phrase: hit.phrase, dist })
  }
  for (let i = 0; i < tokens.length; i++) {
    consider(i, i + 1, [tokens[i]])
    if (i + 2 <= tokens.length) consider(i, i + 2, [tokens[i], tokens[i + 1]])
    if (i + 3 <= tokens.length) consider(i, i + 3, [tokens[i], tokens[i + 1], tokens[i + 2]])
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.dist - b.dist)
  return candidates[0].phrase
}

function tokenize(section: string): string[] {
  return section
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/\.+$/, ''))
    .filter((t) => t.length > 0)
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return out
}

function trigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length - 2; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`)
  }
  return out
}

// Precomputed count index for PMI discovery. Building it once per
// section keeps the whole pipeline O(n): the naive alternative (rescan
// the token stream per candidate bigram, rebuilding unigram counts each
// time) is O(n²) and blows up on 10k+ word postings.
interface PmiIndex {
  total: number
  wordCounts: Map<string, number>
  bigramCounts: Map<string, number>
}

function buildPmiIndex(tokens: string[]): PmiIndex {
  const wordCounts = new Map<string, number>()
  for (const t of tokens) wordCounts.set(t, (wordCounts.get(t) ?? 0) + 1)
  const bigramCounts = new Map<string, number>()
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = `${tokens[i]} ${tokens[i + 1]}`
    bigramCounts.set(key, (bigramCounts.get(key) ?? 0) + 1)
  }
  return { total: tokens.length, wordCounts, bigramCounts }
}

function pmiFromIndex(bigram: string, index: PmiIndex): number {
  const phraseCount = index.bigramCounts.get(bigram) ?? 0
  if (phraseCount < 2) return 0
  const words = bigram.split(' ')
  const phraseProb = phraseCount / Math.max(index.total - words.length + 1, 1)
  let denom = 1
  for (const w of words) {
    const p = (index.wordCounts.get(w) ?? 0) / index.total
    if (p === 0) return 0
    denom *= p
  }
  if (denom === 0) return 0
  return Math.log2(phraseProb / denom)
}

const PMI_THRESHOLD = 2.0

// Boilerplate/generic words whose tight co-occurrence carries no skill
// signal ("years experience", "equal opportunity", "competitive
// salary"). A PMI-discovered bigram is discarded when either word is
// listed here, so they never surface as keywords — which also keeps
// them out of coverage checks, where they could never realistically be
// matched in a tailored CV or cover letter.
//
// Exported for tests: the false-negative guard asserts that no genuine
// allowlisted skill containing one of these words can be suppressed
// (allowlisted phrases bypass the filter entirely — the found-check
// short-circuits before the noise check).
export const PMI_NOISE_WORDS: ReadonlySet<string> = new Set([
  // function words (≥3 chars — shorter tokens are already skipped)
  'the', 'and', 'with', 'for', 'you', 'your', 'our', 'are', 'will', 'that',
  'this', 'from', 'have', 'has', 'had', 'not', 'but', 'all', 'any', 'can',
  'who', 'what', 'when', 'how', 'why', 'its', 'they', 'them', 'their',
  'was', 'were', 'been', 'being', 'also', 'more', 'most', 'other', 'others',
  'new', 'use', 'used', 'using', 'etc', 'include', 'includes', 'including',
  // recruitment boilerplate
  'years', 'year', 'experience', 'ability', 'abilities', 'opportunity',
  'opportunities', 'candidate', 'candidates', 'ideal', 'strong', 'excellent',
  'exceptional', 'proven', 'demonstrated', 'extensive', 'relevant', 'related',
  'solid', 'deep', 'good', 'great', 'plus', 'bonus', 'required', 'preferred',
  'minimum', 'maximum', 'essential', 'qualified', 'skills', 'skill',
  // benefits/compensation boilerplate
  'salary', 'insurance', 'benefits', 'benefit', 'vacation', 'pto', 'remote',
  'hybrid', 'onsite', 'office', 'flexible', 'hours', 'paid', 'compensation',
  'equity', 'stock', '401k',
  // generic workplace nouns
  'team', 'teams', 'company', 'role', 'roles', 'position', 'positions',
  'job', 'jobs', 'work', 'working', 'workplace', 'environment', 'culture',
  'full', 'part', 'time', 'day', 'daily', 'week', 'weekly', 'month',
  'monthly'
])

// Maps a single token through the alias table ("k8s" → "kubernetes",
// "js" → "javascript", "golang" → "go"). Multi-token phrases are left
// alone so emitted keywords stay coverage-matchable word sequences.
function canonicalToken(t: string): string {
  return KEYWORD_ALIASES[t] ?? t
}

export function extractPhases(
  section: string,
  source: KeywordSource,
  negated: ReadonlySet<string> = new Set()
): KeywordEntry[] {
  const allowlists = loadKeywordAllowlists()
  const tokens = tokenize(section).map(canonicalToken)
  // matchKey → matched entry. Allowlist entries are indexed by their
  // match keys, so punctuation-bearing entries ("next.js", "ci/cd",
  // "scikit-learn") are reachable from the token stream ("next js",
  // "ci cd") while the emitted phrase stays the allowlist form.
  const found = new Map<string, { phrase: string; category: KeywordCategory }>()
  const add = (key: string, phrase: string, category: KeywordCategory) => {
    if (!found.has(key)) found.set(key, { phrase, category })
  }

  // 1. Unigram allowlist matches (hard, soft, cert, seniority). Aliases
  //    resolve here: "k8s" matches the "kubernetes" entry.
  //
  //    P0.2: also check phraseBoostByKey so single-token aliasKeys
  //    (PHRASE_ALIASES targets like "gtm" → "go-to-market",
  //    "sla" → "service level objectives") are reachable as unigrams
  //    too. Without this the unigram loop would only find entries
  //    whose canonical phrase is in hard/soft/cert/seniority.
  for (const t of tokens) {
    const hit = allowlists.byKey.get(t) ?? allowlists.phraseBoostByKey.get(t)
    if (hit) add(t, hit.phrase, hit.category)
  }

  // 2. Bigram + trigram allowlist matches. Seniority phrases ("senior
  //    manager", "entry level", "head of") and phrase_boost entries
  //    ("a/b testing") are only reachable as n-grams.
  for (const gram of [...bigrams(tokens), ...trigrams(tokens)]) {
    const hit = allowlists.byKey.get(gram)
    if (hit) {
      add(gram, hit.phrase, hit.category)
      continue
    }
    const boost = allowlists.phraseBoostByKey.get(gram)
    if (boost) add(gram, boost.phrase, boost.category)
  }

  // 3. PMI n-gram discovery for bigrams not in any list, count >= 2, PMI >= threshold.
  //    Pairs containing a noise word are skipped: high PMI alone does not
  //    make boilerplate ("years experience") a keyword. Counts come from a
  //    single-pass index so discovery stays O(n) on huge postings.
  const pmiIndex = buildPmiIndex(tokens)
  for (const [bg] of pmiIndex.bigramCounts) {
    if (found.has(bg)) continue
    if (bg.split(' ').some((w) => w.length < 3)) continue
    if (bg.split(' ').some((w) => PMI_NOISE_WORDS.has(w))) continue
    if (pmiFromIndex(bg, pmiIndex) >= PMI_THRESHOLD) {
      add(bg, bg, 'hard')
    }
  }

  // 4. Longer phrase wins over sub-phrase: drop "aws" if "aws solutions
  //    architect" exists. Sort by length desc so the longer phrase is
  //    always kept first, then drop any phrase contained in (or equal to)
  //    an already-kept phrase.
  //
  //    P1.4: phrase-boost head matching for title sections. For each
  //    multi-token phrase_boost entry, if the first N-1 tokens appear
  //    consecutively in the title, emit the entry. This lets
  //    role-titled JDs (e.g. "Platform Engineer") surface their
  //    phrase_boost skill ("platform engineering") without requiring
  //    the exact trigram match. Restricted to phrase_boost entries
  //    — applying this to hard or seniority entries would
  //    over-generalize (e.g. "manager" → "management").
  if (source === 'title') {
    for (const phrase of allowlists.phraseBoost) {
      const keyTokens = matchKey(phrase).split(' ')
      if (keyTokens.length < 2) continue
      const headLen = keyTokens.length - 1
      const head = keyTokens.slice(0, headLen)
      let matched = false
      outer: for (let i = 0; i <= tokens.length - headLen; i++) {
        for (let j = 0; j < headLen; j++) {
          if (tokens[i + j] !== head[j]) continue outer
        }
        matched = true
        break
      }
      if (matched) {
        const category = allowlists.phraseBoostByCategory.get(phrase) ?? 'hard'
        add(phrase, phrase, category)
      }
    }
  }

  const entries = [...found.values()]
  entries.sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase))
  const kept: KeywordEntry[] = []
  for (const e of entries) {
    if (kept.some((k) => k.phrase.includes(e.phrase) || e.phrase.includes(k.phrase))) continue
    // P1.3 negation: a phrase whose every mention in this section
    // is negated is dropped from the section's keyword bucket. The
    // matchKey form is used so alias keys and canonical phrases
    // compare equal ("k8s" and "kubernetes" both match the same
    // "kubernetes" entry).
    if (negated.has(matchKey(e.phrase))) continue
    kept.push({ phrase: e.phrase, weight: 0, category: e.category, source })
  }
  return kept
}
