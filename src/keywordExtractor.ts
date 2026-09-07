// Pure, deterministic keyword extraction pipeline. No I/O, no Electron
// imports — safe to import from anywhere, including vitest and the
// renderer.

import { loadKeywordAllowlists, KEYWORD_ALIASES } from './keywordAllowlists'
import type { KeywordAllowlists } from './keywordAllowlists'
import type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult } from './types'
export type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult }

const REQUIRED_RE = /\b(requirements?|required|must[- ]?haves?|basic qualifications|minimum qualifications|qualifications|essential|what you(?:'|’)ll need|what you will need|what we(?:'|’)re looking for|what we are looking for|who you are|what you bring)\b/i
// Tested before REQUIRED_RE so a heading like "Preferred Qualifications"
// (which contains both words) lands in the preferred bucket.
const PREFERRED_RE = /\b(preferred|nice[- ]?to[- ]?haves?|bonus|plus(?:es)?|good to have|desired|extras?|differentiators?)\b/i
// Section-noun phrases that signal "we are now back in body" — these are
// the typical headings that follow a required/preferred block.
const RESET_RE = /^(about|overview|company|role|responsibilities|duties|benefits|perks|equal opportunity|what we|who we|why|how we|how to apply|apply now|join|our team|mission|vision|summary|what you'll do|what you will do|compensation|salary|interview process|working at|life at)\b/i

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
  // List-item lines (starting with -, *, •, or a digit) are content,
  // never headers — even when they contain a section word.
  if (/^[-*•\d]/.test(t)) return null
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
  const collected: KeywordEntry[] = []
  // Title is one line; parseSections already extracted it. Run extractPhases on it
  // as a single line so allowlist matches inside the title are captured.
  if (sections.title) {
    collected.push(...extractPhases(sections.title, 'title'))
  }
  if (sections.required) collected.push(...extractPhases(sections.required, 'required'))
  if (sections.preferred) collected.push(...extractPhases(sections.preferred, 'preferred'))
  if (sections.body) collected.push(...extractPhases(sections.body, 'body'))

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
  return { keywords: capped.slice(0, POST_RANK_CAP), refinedByLlm: false, unknownPhrases: [] }
}

const UNKNOWN_DOWNWEIGHT = 0.8

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
 * - Phrase in both: LLM wins category+weight; rule wins source.
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
  const norm = (s: string) => s.toLowerCase().trim()
  const ruleByPhrase = new Map<string, KeywordEntry>()
  for (const e of rule) ruleByPhrase.set(norm(e.phrase), e)

  const merged: KeywordEntry[] = []
  const unknownPhrases = new Set<string>()
  const seen = new Set<string>()

  // 1. Process LLM candidates.
  for (const llmEntry of llm) {
    const phraseNorm = norm(llmEntry.phrase)
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
    const phraseNorm = norm(ruleEntry.phrase)
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

function pmiFor(phrase: string, tokens: string[]): number {
  const words = phrase.split(' ')
  if (words.length < 2) return 0
  const total = tokens.length
  const wordCounts = new Map<string, number>()
  for (const t of tokens) wordCounts.set(t, (wordCounts.get(t) ?? 0) + 1)
  let phraseCount = 0
  for (let i = 0; i <= tokens.length - words.length; i++) {
    let match = true
    for (let j = 0; j < words.length; j++) {
      if (tokens[i + j] !== words[j]) { match = false; break }
    }
    if (match) phraseCount++
  }
  if (phraseCount < 2) return 0
  const phraseProb = phraseCount / Math.max(total - words.length + 1, 1)
  let denom = 1
  for (const w of words) {
    const p = (wordCounts.get(w) ?? 0) / total
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
const PMI_NOISE_WORDS = new Set([
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

export function extractPhases(section: string, source: KeywordSource): KeywordEntry[] {
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
  for (const t of tokens) {
    const hit = allowlists.byKey.get(t)
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
  //    make boilerplate ("years experience") a keyword.
  for (const bg of bigrams(tokens)) {
    if (found.has(bg)) continue
    if (bg.split(' ').some((w) => w.length < 3)) continue
    if (bg.split(' ').some((w) => PMI_NOISE_WORDS.has(w))) continue
    const pmi = pmiFor(bg, tokens)
    if (pmi >= PMI_THRESHOLD) {
      add(bg, bg, 'hard')
    }
  }

  // 4. Longer phrase wins over sub-phrase: drop "aws" if "aws solutions
  //    architect" exists. Sort by length desc so the longer phrase is
  //    always kept first, then drop any phrase contained in (or equal to)
  //    an already-kept phrase.
  const entries = [...found.values()]
  entries.sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase))
  const kept: KeywordEntry[] = []
  for (const e of entries) {
    if (kept.some((k) => k.phrase.includes(e.phrase) || e.phrase.includes(k.phrase))) continue
    kept.push({ phrase: e.phrase, weight: 0, category: e.category, source })
  }
  return kept
}
