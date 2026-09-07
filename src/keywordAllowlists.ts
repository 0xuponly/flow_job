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
  py: 'python',
  tf: 'terraform',
  powerbi: 'power bi',
  sr: 'senior',
  jr: 'junior'
}

// Multi-token aliases: spelled-out vendor/cloud names → the canonical
// allowlist phrase. Keys are match-key (token-join) forms, so they are
// indexed straight into the same lookup tables ("Amazon Web Services"
// text yields the trigram "amazon web services" → "aws").
export const PHRASE_ALIASES: Readonly<Record<string, string>> = {
  'amazon web services': 'aws',
  'google cloud platform': 'gcp',
  'google cloud': 'gcp',
  'microsoft azure': 'azure'
}

// Round-2 expansion: cloud/devops/data/finance-fintech terms merged on
// top of the committed JSON bundle at load time. Declared here (not in
// the JSON) so allowlist behavior ships with the code that consumes it.
// No duplicates of JSON entries; prefer phrases that word-boundary
// matching can find in a CV.
const EXTRA_TERMS: RawBundle = {
  hard: [
    // data / databases
    'sql', 'nosql', 'cassandra', 'dynamodb', 'bigquery', 'redshift',
    'hive', 'hbase', 'presto', 'trino', 'databricks', 'kinesis',
    'iceberg', 'clickhouse',
    // analytics / BI
    'tableau', 'looker', 'excel', 'vba', 'power bi',
    // cloud primitives
    's3', 'ec2', 'eks', 'ecs', 'cloudformation', 'cloudwatch',
    // devops tooling
    'jenkins', 'ansible', 'puppet', 'gitlab', 'circleci', 'spinnaker',
    'istio', 'consul', 'vault', 'packer', 'opentelemetry', 'observability',
    // trading / fintech
    'kdb+', 'bloomberg', 'refinitiv', 'p&l', 'pnl', 'alpha',
    'backtesting', 'derivatives', 'equities', 'quantitative', 'gaap',
    'ifrs', 'fintech', 'fix protocol', 'low latency', 'valuation'
  ],
  soft: [],
  cert: ['CFA Level I', 'CFA Level II', 'CFA Level III', 'CAIA', 'CQF', 'Series 7', 'Series 63'],
  seniority: [],
  phrase_boost: [
    'full stack', 'financial modeling', 'financial analysis',
    'portfolio management', 'algorithmic trading', 'high frequency trading',
    'market making', 'market data', 'order management', 'stream processing',
    'event sourcing', 'delta lake', 'github actions', 'risk analytics'
  ]
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

// Effective lists = committed JSON bundle + EXTRA_TERMS (deduped,
// normalized). Computed once; the JSON file itself is never mutated.
function effectiveLists(): RawBundle {
  const merge = (base: string[], extra: string[]): string[] => {
    const seen = new Set(base.map(norm))
    const out = [...base]
    for (const term of extra) {
      const n = norm(term)
      if (n === '' || seen.has(n)) continue
      seen.add(n)
      out.push(n)
    }
    return out
  }
  return {
    hard: merge(validated.hard, EXTRA_TERMS.hard),
    soft: merge(validated.soft, EXTRA_TERMS.soft),
    cert: merge(validated.cert, EXTRA_TERMS.cert),
    seniority: merge(validated.seniority, EXTRA_TERMS.seniority),
    phrase_boost: merge(validated.phrase_boost, EXTRA_TERMS.phrase_boost)
  }
}

export function loadKeywordAllowlists(): KeywordAllowlists {
  if (cached) return cached
  const lists = effectiveLists()
  const phraseBoostByCategory = new Map<string, KeywordCategory>()
  for (const p of lists.phrase_boost) {
    const n = norm(p)
    if (lists.hard.some((h) => norm(h) === n)) {
      phraseBoostByCategory.set(n, 'hard')
      continue
    }
    if (lists.soft.some((s) => norm(s) === n)) {
      phraseBoostByCategory.set(n, 'soft')
      continue
    }
    phraseBoostByCategory.set(n, 'hard')
  }
  // Match-key index over hard/soft/cert/seniority. Insertion priority
  // mirrors the extractor's lookup order (hard → soft → cert →
  // seniority) so a key present in multiple lists resolves like the
  // per-token checks did. Each entry is indexed under its raw match key
  // ("next js" for "next.js"), its alias-canonical variant ("next
  // javascript"), and any PHRASE_ALIASES spellings that resolve to it
  // ("amazon web services" → "aws"), so lookups hit regardless of how
  // the token stream was normalized.
  const byKey = new Map<string, KeywordListEntry>()
  const indexEntry = (map: Map<string, KeywordListEntry>, entry: KeywordListEntry) => {
    const raw = matchKey(entry.phrase).split(' ')
    const canonical = raw.map((t) => KEYWORD_ALIASES[t] ?? t)
    const keys = new Set([raw.join(' '), canonical.join(' ')])
    for (const [aliasKey, target] of Object.entries(PHRASE_ALIASES)) {
      if (target === entry.phrase) keys.add(aliasKey)
    }
    for (const key of keys) {
      if (!map.has(key)) map.set(key, entry)
    }
  }
  const categoryLists: [string[], KeywordCategory][] = [
    [lists.hard, 'hard'],
    [lists.soft, 'soft'],
    [lists.cert, 'cert'],
    [lists.seniority, 'seniority']
  ]
  for (const [list, category] of categoryLists) {
    for (const phrase of list) {
      indexEntry(byKey, { phrase: norm(phrase), category })
    }
  }
  const phraseBoostByKey = new Map<string, KeywordListEntry>()
  for (const p of lists.phrase_boost) {
    const n = norm(p)
    indexEntry(phraseBoostByKey, {
      phrase: n,
      category: phraseBoostByCategory.get(n) ?? 'hard'
    })
  }
  cached = {
    hard: new Set(lists.hard.map(norm)),
    soft: new Set(lists.soft.map(norm)),
    cert: new Set(lists.cert.map(norm)),
    seniority: new Set(lists.seniority.map(norm)),
    phraseBoost: new Set(lists.phrase_boost.map(norm)),
    phraseBoostByCategory,
    byKey,
    phraseBoostByKey
  }
  return cached
}
