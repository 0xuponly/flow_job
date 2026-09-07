// Loads the committed allowlist bundle. Validates the schema at module load
// so consumers can rely on every key being present. The phrase_boost list
// is projected into per-category Sets so the same phrase can resolve to
// either hard or soft depending on which list the phrase appears in first.

import bundle from './data/keywordAllowlists.json'

export type KeywordCategory = 'hard' | 'soft' | 'cert' | 'seniority'

interface RawBundle {
  hard: string[]
  soft: string[]
  cert: string[]
  seniority: string[]
  phrase_boost: string[]
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function validate(raw: unknown): RawBundle {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('keywordAllowlists: bundle is not an object')
  }
  const r = raw as Record<string, unknown>
  for (const key of ['hard', 'soft', 'cert', 'seniority', 'phrase_boost'] as const) {
    if (!isStringArray(r[key])) {
      throw new Error(`keywordAllowlists: missing or invalid key "${key}"`)
    }
  }
  return r as unknown as RawBundle
}

const validated = validate(bundle)

const norm = (s: string): string => s.toLowerCase().trim()

// Token-level aliases: common JD shorthand → the canonical allowlist
// phrase. Applied to single tokens only, so the emitted keyword stays a
// phrase that word-boundary matching (coverageFor) can find in a CV that
// spells it out ("JS" in the JD, "JavaScript" in the CV → both hit
// "javascript").
export const KEYWORD_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  ts: 'typescript',
  k8s: 'kubernetes',
  golang: 'go',
  nodejs: 'node',
  reactjs: 'react',
  vuejs: 'vue',
  postgresql: 'postgres',
  sr: 'senior',
  jr: 'junior'
}

// Normalizes a phrase into its token-join "match key": allowlist entries
// containing punctuation ("next.js", "ci/cd", "scikit-learn", "a/b
// testing") become keys over the token stream ("next js", "ci cd", ...),
// which is how the extractor's tokenizer sees them. Tech tokens with
// +/# are preserved ("c++", "c#").
export function matchKey(phrase: string): string {
  return norm(phrase)
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 0)
    .join(' ')
}

export interface KeywordListEntry {
  phrase: string
  category: KeywordCategory
}

export interface KeywordAllowlists {
  hard: Set<string>
  soft: Set<string>
  cert: Set<string>
  seniority: Set<string>
  phraseBoost: Set<string>
  phraseBoostByCategory: Map<string, KeywordCategory>
  // Match-key indexes: key → canonical phrase + category. Built from the
  // lists above so punctuation-bearing entries are reachable from the
  // token stream. Additive; the Sets above are unchanged.
  byKey: Map<string, KeywordListEntry>
  phraseBoostByKey: Map<string, KeywordListEntry>
}

let cached: KeywordAllowlists | null = null

export function loadKeywordAllowlists(): KeywordAllowlists {
  if (cached) return cached
  const phraseBoostByCategory = new Map<string, KeywordCategory>()
  for (const p of validated.phrase_boost) {
    const n = norm(p)
    if (validated.hard.some((h) => norm(h) === n)) {
      phraseBoostByCategory.set(n, 'hard')
      continue
    }
    if (validated.soft.some((s) => norm(s) === n)) {
      phraseBoostByCategory.set(n, 'soft')
      continue
    }
    phraseBoostByCategory.set(n, 'hard')
  }
  // Match-key index over hard/soft/cert/seniority. Insertion priority
  // mirrors the extractor's lookup order (hard → soft → cert →
  // seniority) so a key present in multiple lists resolves like the
  // per-token checks did. Each entry is indexed under both its raw
  // match key ("next js" for "next.js") and its alias-canonical
  // variant ("next javascript"), so lookups hit regardless of whether
  // the token stream has been run through KEYWORD_ALIASES.
  const byKey = new Map<string, KeywordListEntry>()
  const indexEntry = (map: Map<string, KeywordListEntry>, entry: KeywordListEntry) => {
    const raw = matchKey(entry.phrase).split(' ')
    const canonical = raw.map((t) => KEYWORD_ALIASES[t] ?? t)
    const keys = new Set([raw.join(' '), canonical.join(' ')])
    for (const key of keys) {
      if (!map.has(key)) map.set(key, entry)
    }
  }
  const categoryLists: [string[], KeywordCategory][] = [    [validated.hard, 'hard'],
    [validated.soft, 'soft'],
    [validated.cert, 'cert'],
    [validated.seniority, 'seniority']
  ]
  for (const [list, category] of categoryLists) {
    for (const phrase of list) {
      indexEntry(byKey, { phrase: norm(phrase), category })
    }
  }
  const phraseBoostByKey = new Map<string, KeywordListEntry>()
  for (const p of validated.phrase_boost) {
    const n = norm(p)
    indexEntry(phraseBoostByKey, {
      phrase: n,
      category: phraseBoostByCategory.get(n) ?? 'hard'
    })
  }
  cached = {
    hard: new Set(validated.hard.map(norm)),
    soft: new Set(validated.soft.map(norm)),
    cert: new Set(validated.cert.map(norm)),
    seniority: new Set(validated.seniority.map(norm)),
    phraseBoost: new Set(validated.phrase_boost.map(norm)),
    phraseBoostByCategory,
    byKey,
    phraseBoostByKey
  }
  return cached
}
