// Pure, deterministic keyword extraction pipeline. No I/O, no Electron
// imports — safe to import from anywhere, including vitest and the
// renderer.

import { loadKeywordAllowlists } from './keywordAllowlists'
import type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult } from './types'
export type { KeywordCategory, KeywordSource, KeywordEntry, KeywordResult }

const REQUIRED_RE = /required|must have|requirements|qualifications|what you(?:'| wi)ll need|minimum qualifications|essential/i
const PREFERRED_RE = /preferred|nice to have|bonus|plus|would be great|desired/i
// Section-noun phrases that signal "we are now back in body" — these are
// the typical headings that follow a required/preferred block.
const RESET_RE = /^(about|overview|company|role|benefits|perks|equal opportunity|what we offer|what we|who we|why|how we|mission|vision|summary|responsibilities|what you'll do|what you will do|compensation|salary)\b/i

function isHeaderLine(line: string): { required: true } | { preferred: true } | { reset: true } | null {
  const t = line.trim()
  if (t === '') return null
  // Headers are short, title-cased or all-caps lines without terminal punctuation.
  if (t.length > 60) return null
  if (/[.!?]$/.test(t)) return null
  if (REQUIRED_RE.test(t)) return { required: true }
  if (PREFERRED_RE.test(t)) return { preferred: true }
  // List-item lines (starting with -, *, •, or a digit) are not headers.
  if (/^[-*•\d]/.test(t)) return null
  // A line starting with a known section-noun phrase (About, Overview,
  // Company, Benefits, etc.) resets the bucket back to body.
  if (RESET_RE.test(t)) return { reset: true }
  return null
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
      title = t
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
  return { keywords: capped.slice(0, POST_RANK_CAP), refinedByLlm: false }
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

export function extractPhases(section: string, source: KeywordSource): KeywordEntry[] {
  const allowlists = loadKeywordAllowlists()
  const tokens = tokenize(section)
  const phrases = new Set<string>()
  const phraseCategory = new Map<string, KeywordCategory>()

  // 1. Unigram allowlist matches (hard, soft, cert, seniority).
  for (const t of tokens) {
    if (allowlists.hard.has(t) && !phraseCategory.has(t)) {
      phrases.add(t); phraseCategory.set(t, 'hard')
    } else if (allowlists.soft.has(t) && !phraseCategory.has(t)) {
      phrases.add(t); phraseCategory.set(t, 'soft')
    } else if (allowlists.cert.has(t) && !phraseCategory.has(t)) {
      phrases.add(t); phraseCategory.set(t, 'cert')
    } else if (allowlists.seniority.has(t) && !phraseCategory.has(t)) {
      phrases.add(t); phraseCategory.set(t, 'seniority')
    }
  }

  // 2. Bigram + trigram allowlist matches (hard, soft, cert — skip seniority for phrases).
  for (const bg of [...bigrams(tokens), ...trigrams(tokens)]) {
    if (allowlists.hard.has(bg) && !phraseCategory.has(bg)) {
      phrases.add(bg); phraseCategory.set(bg, 'hard')
    } else if (allowlists.soft.has(bg) && !phraseCategory.has(bg)) {
      phrases.add(bg); phraseCategory.set(bg, 'soft')
    } else if (allowlists.cert.has(bg) && !phraseCategory.has(bg)) {
      phrases.add(bg); phraseCategory.set(bg, 'cert')
    } else if (allowlists.phraseBoost.has(bg)) {
      const cat = allowlists.phraseBoostByCategory.get(bg) ?? 'hard'
      if (!phraseCategory.has(bg)) {
        phrases.add(bg); phraseCategory.set(bg, cat)
      }
    }
  }

  // 3. PMI n-gram discovery for bigrams not in any list, count >= 2, PMI >= threshold.
  for (const bg of bigrams(tokens)) {
    if (phrases.has(bg)) continue
    if (bg.split(' ').some((w) => w.length < 3)) continue
    const pmi = pmiFor(bg, tokens)
    if (pmi >= PMI_THRESHOLD) {
      phrases.add(bg); phraseCategory.set(bg, 'hard')
    }
  }

  // 4. Longer phrase wins over sub-phrase: drop "aws" if "aws solutions architect" exists.
  const phraseList = [...phrases]
  phraseList.sort((a, b) => b.length - a.length)
  const kept: string[] = []
  for (const p of phraseList) {
    if (kept.some((k) => k.includes(p) || p.includes(k))) {
      // longer already kept; skip the shorter
      const longerFirst = kept.find((k) => k.includes(p))
      if (longerFirst && longerFirst !== p) continue
      if (kept.includes(p)) continue
    }
    kept.push(p)
  }

  return kept.map((p) => ({
    phrase: p,
    weight: 0,
    category: phraseCategory.get(p) ?? 'hard',
    source
  }))
}
