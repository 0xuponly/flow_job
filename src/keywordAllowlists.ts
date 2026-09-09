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
//
// P0.2 + P1.2 acronym/expansion table (folded together per the plan):
// the abbreviation and the spelled-out form both index the same
// canonical phrase. Single-token abbreviations ("gtm", "sla", "slos")
// live here so the alias table is the single source of truth for
// acronym → canonical resolution.
export const PHRASE_ALIASES: Readonly<Record<string, string>> = {
  'amazon web services': 'aws',
  'google cloud platform': 'gcp',
  'google cloud': 'gcp',
  'microsoft azure': 'azure',
  // M&A: matchKey of "m&a" is "m a" (the tokenizer strips the & into
  // a space, so the JD text "M&A" yields the bigram "m a").
  'm a': 'mergers and acquisitions',
  // IAM expansion: 4 tokens, so the trigram loop can't emit it
  // directly, but the alias table records the mapping for any
  // downstream consumer (coverage checks, taxonomy readers).
  'identity and access management': 'iam',
  // GTM expansion + abbreviation.
  'go to market': 'go-to-market',
  'gtm': 'go-to-market',
  // SLO expansion + abbreviations.
  'sla': 'service level objectives',
  'slos': 'service level objectives',
  'slas': 'service level objectives'
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
    'ifrs', 'fintech', 'fix protocol', 'low latency', 'valuation',
    // P0.2 single-token fixture-audit misses from §3.2: domain
    // skills the extractor used to miss because they weren't on any
    // list. The unigram loop only matches `hard`/`soft`/`cert`/
    // `seniority` (not phrase_boost, which the bigram/trigram loop
    // covers), so single-word domains land here.
    'cloud', 'frontend', 'analytics', 'seo',
    // P1.2 acronyms with stable meanings. "iam" is the Identity
    // and Access Management protocol/skill acronym; the expanded
    // form is recorded in PHRASE_ALIASES.
    'iam'
  ],
  soft: [],
  cert: ['CFA Level I', 'CFA Level II', 'CFA Level III', 'CAIA', 'CQF', 'Series 7', 'Series 63'],
  seniority: [],
  phrase_boost: [
    'full stack', 'financial modeling', 'financial analysis',
    'portfolio management', 'algorithmic trading', 'high frequency trading',
    'market making', 'market data', 'order management', 'stream processing',
    'event sourcing', 'delta lake', 'github actions', 'risk analytics',
    // P0.2 + P1.2 multi-token fixture-audit misses and acronym
    // expansions. The bigram/trigram loop scans phraseBoostByKey
    // after byKey, so multi-word canonicals land here.
    'mergers and acquisitions', 'go-to-market',
    'service level objectives', 'search engine optimization',
    'performance tuning', 'trading systems'
  ]
}

// ESCO taxonomy seed. Provenance and curation notes:
//   Source: ESCO v1.x (https://ec.europa.eu/esco/, EUPL 1.2 / API EUPL).
//   Retrieved 2026-09-09 via the public search API
//   https://ec.europa.eu/esco/api/search?text=…&type=skill&language=en
//   (no API key required). 211 seed queries across the app's
//   target domains — software engineering, data, cloud/devops,
//   finance/trading, product, sales/ops. Curation rules, in
//   order (see /tmp/keywords_audit/curate_esco.ts):
//     1. Drop verb-form labels (ESCO competency form: "use X",
//        "apply X", "manage X"). Keep noun-form skills.
//     2. Drop paren-disambiguation labels (e.g. "Python
//        (computer programming)") — the base word is already
//        on the allowlist via the JSON bundle or EXTRA_TERMS.
//     3. Keep labels ≤ 4 words.
//     4. Drop labels whose every token is in PMI_NOISE_WORDS.
//     5. Drop labels matching the LLM_DENY_LIST patterns
//        (locations, years-of-experience boilerplate, degree
//        mentions, employment types).
//     6. Drop duplicates of the existing allowlist + alias
//        targets (no signature changes, no removals).
//     7. Categorize: cert-like → cert; 1 token → hard;
//        2-4 tokens → phrase_boost.
//     8. ISCED-F domain filter: keep only 0612-0613 / 0619
//        (ICT), 0411-0416 (business/finance/sales/marketing),
//        0421 (law/compliance), 0541-0542 (math/stats),
//        0311 (economics). Drop 0415 (secretarial), 0417
//        (work skills), 0532 (earth sciences), 0611
//        (computer use — too generic).
//     9. Manual triage of brand-niche tools (LMS platforms,
//        consumer OS, obscure niche tools) and off-domain
//        phrases (railway, e-learning, military, publishing,
//        textile, etc.) to keep the seed focused on the app's
//        target domains per the plan P0.2 §7 anti-
//        recommendation against taxonomy noise.
//   Counts at seed time: hard=37, phrase_boost=178, soft=0,
//   cert=0; dropped=4170 (verb forms, duplicates, off-domain).
//   Authoritative list: /tmp/keywords_audit/esco_curated.json.
//   Authoritative source: ESCO API + curation script.
const ESCO_SEED: RawBundle = {
  hard: [
    'AJAX',
    'Jboss',
    'Objective-C',
    'Drupal',
    'Joomla',
    'CSS',
    'Sass',
    'MDX',
    'MarkLogic',
    'PostgreSQL',
    'statistics',
    'economics',
    'Wireshark',
    'biostatistics',
    'DB2',
    'Xcode',
    'Cisco',
    'Nessus',
    'Metasploit',
    'accounting',
    'depreciation',
    'mathematics',
    'algorithms',
    'COBOL',
    'R',
    'MATLAB',
    'Erlang',
    'Lisp',
    'APL',
    'CoffeeScript',
    'VBScript',
    'ABAP',
    'Groovy',
    'ASP.NET',
    'Perl',
    'pay-per-click',
    'e-procurement'
  ],
  soft: [],
  cert: [],
  seniority: [],
  phrase_boost: [
    'JavaScript Framework',
    'web programming',
    'Apache Tomcat',
    'IBM WebSphere',
    'Oracle WebLogic',
    'computer programming',
    'OWASP ZAP',
    'mobile operating systems',
    'style sheet languages',
    'IBM Informix',
    'SQL Server',
    'CAD software',
    'database management systems',
    'data warehouse',
    'Teradata Database',
    'Oracle Warehouse Builder',
    'warehouse operations',
    'data mining methods',
    'data protection',
    'product data management',
    'unstructured data',
    'data models',
    'online analytical processing',
    'web analytics',
    'audit techniques',
    'automatic meter reading',
    'computer science',
    'data mining',
    'customer insight',
    'conflict management',
    'strategic planning',
    'CAE software',
    'CADD software',
    'distributed computing',
    'CAM software',
    'machine translation',
    'statistical quality control',
    'statistical process control',
    'actuarial science',
    'financial capability',
    'hardware testing methods',
    'debt classification',
    'business intelligence',
    'business processes',
    'business law',
    'business management principles',
    'business model',
    'business requirements techniques',
    'business knowledge',
    'business valuation techniques',
    'business analysis',
    'business loans',
    'business process modelling',
    'marketing management',
    'corporate social responsibility',
    'outsourcing strategy',
    'Informatica PowerCenter',
    'cloud technologies',
    'data storage',
    'task algorithmisation',
    'sales activities',
    'legal department processes',
    'financial department processes',
    'operations department processes',
    'sales department processes',
    'marketing department processes',
    'accounting department processes',
    'management department processes',
    'internal auditing',
    'online job platforms',
    'social media management',
    'publicity code',
    'products coding system',
    'warehousing regulations',
    'information structure',
    'Pentaho Data Integration',
    'systems thinking',
    'Oracle Data Integrator',
    'SAP Data Services',
    'SAS Data Management',
    'QlikView Expressor',
    'hybrid control systems',
    'IBM InfoSphere DataStage',
    'solution deployment',
    'project commissioning',
    'network marketing',
    'internet governance',
    'security panels',
    'social security law',
    'information security strategy',
    'penetration testing tool',
    'risk transfer',
    'financial engineering',
    'financial jurisdiction',
    'financial markets',
    'modern portfolio theory',
    'financial management',
    'financial statements',
    'investment analysis',
    'financial forecasting',
    'market analysis',
    'financial products',
    'market entry planning',
    'accounting entries',
    'funding methods',
    'stock market',
    'database quality standards',
    'trading law',
    'trade sector policies',
    'usability engineering',
    'Lean project management',
    'Process-based management',
    'Agile project management',
    'liquidity management',
    'project management principles',
    'customer relationship management',
    'types of insurance',
    'organisational resilience',
    'credit card payments',
    'credit control processes',
    'market pricing',
    'vertical markets',
    'sales strategies',
    'brand marketing techniques',
    'market participants',
    'marketing mix',
    'digital marketing techniques',
    'content marketing strategy',
    'market entry strategies',
    'market research',
    'product life-cycle',
    'Common Lisp',
    'SAS language',
    'Visual Studio .NET',
    'SAP R3',
    'crowdsourcing strategy',
    'insourcing strategy',
    'marketing principles',
    'mass customisation',
    'product comprehension',
    'sales argumentation',
    'pricing strategies',
    'proofing methods',
    'channel marketing',
    'Agile development',
    'software design methodologies',
    'search engine optimisation',
    'mobile marketing',
    'information extraction',
    'sales promotion techniques',
    'merchandising techniques',
    'customer segmentation',
    'supply chain management',
    'supply chain principles',
    'theory of constraints',
    'inventory management rules',
    'Prince2 project management'
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
    hard: merge(validated.hard, merge(EXTRA_TERMS.hard, ESCO_SEED.hard)),
    soft: merge(validated.soft, merge(EXTRA_TERMS.soft, ESCO_SEED.soft)),
    cert: merge(validated.cert, merge(EXTRA_TERMS.cert, ESCO_SEED.cert)),
    seniority: merge(
      validated.seniority,
      merge(EXTRA_TERMS.seniority, ESCO_SEED.seniority)
    ),
    phrase_boost: merge(
      validated.phrase_boost,
      merge(EXTRA_TERMS.phrase_boost, ESCO_SEED.phrase_boost)
    )
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
