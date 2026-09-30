// Pure, deterministic Fit heuristic used both as a fast path and as a fallback
// when the LLM scorer is rate-limited or otherwise unavailable. No I/O, no
// external state, safe to import from anywhere.
//
// It runs on every listing of every scan (thousands of calls), so the shape is
// fixed: a few bounded pure passes, no I/O, no LLM, no unbounded cache.
//
// ---------------------------------------------------------------------------
// Design (why the score is built this way)
// ---------------------------------------------------------------------------
// This number is the only relevance signal the scan path has (see the
// HEURISTIC_FLOOR gate in jobSearch.ts), so it has to mean "this job matches
// this person's background" rather than "these two texts share some words".
// Four principles drive the shape:
//
// 1. EVIDENCE, NOT PRIORS. Every signal returns a value plus a `measured`
//    flag, and only measured signals take part in the weighted mean. A signal
//    we cannot read (no years in the posting, no sector markers, no profession
//    in the title) contributes nothing instead of a neutral 0.5. A weighted
//    average padded with neutral priors is exactly what let a warehouse-ops
//    posting (0.79) out-score a real FP&A match (0.21): weak signal defaulted
//    to neutral, and neutral beat weak-positive.
//
// 2. A REQUIREMENT IS SOMETHING THE POSTING ASSERTS. The keyword extractor
//    puts three kinds of phrase into `keywords`: phrases the posting literally
//    contains, phrases it synthesised from the title by head matching
//    ("Business Intelligence Analyst" -> "business loans", "business law"), and
//    PMI co-occurrence artifacts mined out of prose. Only the first kind is a
//    requirement. Counting the other two under-scores real matches (no CV can
//    satisfy "business loans") and rewards jobs whose prose happens to overlap
//    the CV's vocabulary. See `assertedInPosting` / `isNamedRequirement`.
//
// 3. ABSENCE OF A SIGNAL IS A MISMATCH, NOT A NEUTRAL. The sector (domain)
//    term is the negative half of the model: a posting whose requirements sit
//    in a sector the CV shows no evidence of scores 0 on that term. A
//    mandatory professional licence the CV cannot evidence is a score CAP,
//    not a discount that keyword overlap can out-earn.
//
// 4. A PREFERENCE CANNOT INCREASE RELEVANCE. Years of experience and title
//    rank produce a bounded multiplier in [0.55, 1] applied to the relevance
//    term: a stretch role stays a good lead, being over-qualified gains
//    nothing, and no unrelated job is ever made more relevant by the
//    candidate's seniority.
//
//   relevance = SUM(weight * signal) / SUM(weight)   over measured signals
//   score     = clamp(relevance * seniorityFactor, 0, 1)
//               capped when a mandatory licence is demanded and unmet
//
// Each weight below is justified against one of those principles. None of them
// is fitted to a fixture set; changing one to move a fixture number would
// invalidate the reason it exists.

import { extractJobKeywordsStructured } from '../src/keywordExtractor'
import { KEYWORD_ALIASES, loadKeywordAllowlists, matchKey } from '../src/keywordAllowlists'
import type { KeywordEntry } from '../src/keywordExtractor'

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

/**
 * Every non-stopword token and adjacent token pair of `text`.
 *
 * Kept for API compatibility; no longer part of scoring. Its single-token
 * prefix rule ("analyst" satisfies the requirement "analytics") and its
 * "every token appears somewhere in the document" rule for multi-word phrases
 * ("warehouse operations" satisfied by a CV that says "operations" in one role
 * and "warehouse" in another) are precisely the accidental-satisfaction
 * failure mode the scorer no longer tolerates. Scoring matches contiguous
 * canonical n-grams instead — see `CvIndex.grams`.
 */
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
  /**
   * Accepted and deliberately not scored. Location is not relevance: the scan
   * applies a hard location filter of its own (matchesLocation in jobSearch.ts)
   * before scoring, and the scan path does not even pass a location — so the
   * old 0.10 term was a constant +0.05 on every listing. Kept in the type so
   * no call site has to change.
   */
  location: string | null
  baseCv: string
}

// ---------------------------------------------------------------------------
// Relevance weights
// ---------------------------------------------------------------------------
// The three relevance terms sum to 1.0.
//
// Location is deliberately NOT a term. The scan path calls the compatibility
// wrapper, which passes location=null (jobSearch.ts calls
// scoreCompatibility(title, desc, baseCv)), so the old 0.10 term was a
// constant +0.05 on every listing of every scan: it could not change the
// ordering of any two jobs, i.e. it could not do the only thing a weight in a
// relevance score is for. The scan also already applies a hard location filter
// (matchesLocation) before scoring, so the term was redundant there too. On
// the one path that does pass a location (the LLM-failure fallback in ai.ts)
// it moved scores by at most 0.05, and being additive it pushed the top of
// the scale into the min(score, 1) cap — flattening exactly the clear matches
// the cap should not be touching.

// Skills are the most numerous and most specific evidence of what the person
// can actually do, so they lead.
const W_SKILLS = 0.4
// The complaint is jobs irrelevant to the candidate's *industries*, and a
// posting dominated by a sector the CV shows no trace of is the clearest
// negative evidence available, so the sector term carries real weight.
const W_SECTOR = 0.35
// The profession check is the coarsest signal (2-4 words of title) and the
// other two terms already cover most of what it detects, so it is the
// smallest. It stays because it is the only term that can say "a nurse is not
// a data analyst" in one step.
const W_ROLE = 0.25

// How much each section of the posting contributes to the skill term:
// - required 0.50: the must-have list is the closest thing a posting has to a
//   specification; missing one is a real gap.
// - body 0.25: unstructured prose. Supporting context, and the section where
//   extraction artifacts are most likely.
// - title 0.15: a 2-4 word hint the role term already reads, and the section
//   the extractor's head matching over-expands.
// - preferred 0.10: a nice-to-have you do not have is nearly free.
const SKILL_SOURCE_WEIGHTS: Record<KeywordEntry['source'], number> = {
  required: 0.5,
  body: 0.25,
  title: 0.15,
  preferred: 0.1
}

// Seniority is a bounded multiplier, never a bonus. Meeting the bar is 1.0;
// no relevant experience at all is 0.55 — a stretch lead is still a lead.
const SENIORITY_FLOOR = 0.55
const SENIORITY_YEARS_SPAN = 1 - SENIORITY_FLOOR
// Title ladder: 0.12 per step above the CV's, and a penalty only from two
// steps up, because a one-step difference ("Senior" vs a CV that states no
// level) is noise, not evidence of being unqualified.
const SENIORITY_TITLE_STEP = 0.12
const SENIORITY_TITLE_STEPS_BEFORE_PENALTY = 2
const SENIORITY_TITLE_FLOOR = 0.7

// A mandatory licence / registration / charter the CV cannot evidence caps the
// score. A cap rather than a subtraction, on purpose: keyword overlap must not
// be able to buy a place in a profession the candidate may not practise.
export const LICENCE_GATED_SCORE_CAP = 0.15

/**
 * The score returned when there is no base CV.
 *
 * A neutral prior, not a measurement: nothing was compared, so no threshold
 * can act on it. Callers must keep guarding on "is there a CV" before
 * comparing this against a floor (the scan path does: `if (baseCv && ...)`
 * around HEURISTIC_FLOOR in jobSearch.ts), and anything that persists the
 * number should treat it as unknown rather than as "50% relevant". Named and
 * exported so it is a decision instead of a literal in a return statement, and
 * so the no-CV decision has one owner-visible constant.
 */
export const NO_BASE_CV_SCORE = 0.5

// ---------------------------------------------------------------------------
// Profession (what the job IS) and qualifier (which branch of it)
// ---------------------------------------------------------------------------
// Two levels on purpose. "Financial Analyst" and "Data Analyst" are the same
// profession in different branches; the old word-overlap role score gave both
// 1.0, and a "Registered Nurse" posting scored 1.0 for a CV that merely
// mentioned data. Splitting the title lets a same-profession /
// different-branch posting land in the middle (adjacent, worth a look) and a
// different-profession posting land at 0.
const PROFESSION_TOKENS: Readonly<Record<string, string>> = {
  analyst: 'analysis', analytics: 'analysis', 'business intelligence': 'analysis',
  engineer: 'engineering', developer: 'engineering', programmer: 'engineering',
  architect: 'engineering', devops: 'engineering', sre: 'engineering', qa: 'engineering',
  frontend: 'engineering', backend: 'engineering', fullstack: 'engineering',
  'site reliability': 'engineering',
  scientist: 'science', researcher: 'science',
  accountant: 'accounting', auditor: 'accounting', bookkeeper: 'accounting',
  trader: 'trading', broker: 'trading', 'portfolio manager': 'trading',
  attorney: 'legal', lawyer: 'legal', counsel: 'legal', barrister: 'legal',
  solicitor: 'legal', paralegal: 'legal',
  nurse: 'clinical', physician: 'clinical', doctor: 'clinical', therapist: 'clinical',
  pharmacist: 'clinical', psychologist: 'clinical', paramedic: 'clinical',
  dentist: 'clinical', 'clinical psychologist': 'clinical',
  teacher: 'education', tutor: 'education', lecturer: 'education', professor: 'education',
  marketer: 'marketing', copywriter: 'marketing',
  recruiter: 'people', 'human resources': 'people',
  chef: 'hospitality', cook: 'hospitality', barista: 'hospitality', waiter: 'hospitality',
  waitress: 'hospitality', cashier: 'hospitality', housekeeper: 'hospitality',
  electrician: 'trades', plumber: 'trades', welder: 'trades', carpenter: 'trades',
  mechanic: 'trades', hvac: 'trades', surveyor: 'trades', technician: 'trades'
}

// Engineering specialisms (frontend, backend, devops) are professions, not
// branches: they do not change what kind of work the person does, and treating
// them as branches penalized every engineering posting whose CV spelled the
// specialism differently. Branches are sectors and functions.
const QUALIFIER_ALIASES: Readonly<Record<string, string>> = {
  financial: 'finance', fiscal: 'finance', fp: 'finance', fpa: 'finance',
  accounting: 'finance', audit: 'finance', tax: 'finance', treasury: 'finance',
  valuation: 'finance', actuarial: 'finance',
  credit: 'risk', market: 'markets', investment: 'markets', quant: 'quant',
  quantitative: 'quant', data: 'data', business: 'business', product: 'product',
  customer: 'customer', digital: 'digital', technical: 'technical', web: 'web',
  mobile: 'mobile', cloud: 'cloud', security: 'security', clinical: 'clinical',
  care: 'care', legal: 'legal', research: 'research', people: 'people',
  operations: 'operations', logistics: 'logistics', supply: 'logistics',
  warehouse: 'logistics', trading: 'trading', software: 'software',
  healthcare: 'clinical', medical: 'clinical', nursing: 'clinical'
}

const QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(QUALIFIER_ALIASES),
  'finance', 'risk', 'markets', 'quant', 'commercial', 'pricing', 'revenue',
  'sales', 'marketing', 'hr', 'it'
])

// Title-level seniority ladder. 2 ("mid") is the default when a text states
// no level, so the penalty only ever fires on a stated ladder difference.
const SENIORITY_RANK: Readonly<Record<string, number>> = {
  intern: 0, internship: 0, trainee: 0, graduate: 0, junior: 0, entry: 0,
  'entry level': 0, apprentice: 0, associate: 1, assistant: 1,
  'mid level': 2, 'mid-level': 2, mid: 2, regular: 2,
  senior: 3, 'senior level': 3, principal: 4, staff: 4,
  lead: 4, 'team lead': 4, manager: 4, 'engineering manager': 4,
  head: 5, 'head of': 5, director: 5, vp: 5, 'vice president': 5, chief: 5
}
const SENIORITY_DEFAULT_RANK = 2

// ---------------------------------------------------------------------------
// Sector (domain) markers — the negative signal
// ---------------------------------------------------------------------------
// Deliberately coarse, and every marker is a phrase specific enough that it
// cannot be satisfied by shared office vocabulary ("partner with commercial
// teams", "governance reviews", "measurable outcomes" — the words that got a
// warehouse-ops posting a 0.79 under the old keyword ratio). A posting's
// sectors are matched against the CV and the term is the share the CV can
// evidence: a CV with no evidence of the posting's sector scores 0, which is
// the behaviour the old model had no way to express, because absence of a
// signal used to be neutral.
const DOMAINS: readonly (readonly string[])[] = [
  // finance — corporate reporting / FP&A
  ['financial statements', 'ifrs', 'gaap', 'revenue recognition', 'monthly close', 'month end close',
   'statutory reporting', 'group reporting', 'management accounts', 'consolidation', 'general ledger',
   'accounts payable', 'accounts receivable', 'accrual', 'audit support', 'internal audit',
   'audit', 'accounting', 'budgeting', 'budget', 'forecasting', 'variance analysis', 'financial modelling',
   'financial model', 'financial planning', 'cost accounting', 'statutory accounts', 'fp&a', 'fpa',
   'monthly pack', 'commercial finance', 'revenue', 'arr', 'nrr', 'revenue metrics',
   'profitability', 'contribution margin', 'cost centre', 'cost allocation', 'opex', 'capex',
   'cash flow', 'working capital', 'billing', 'invoicing', 'banking', 'retail banking', 'audit firm',
   'audit engagement', 'monthly reporting', 'group finance', 'corporate finance'],
  // finance — markets / trading
  ['equity research', 'investment banking', 'asset management', 'portfolio management', 'market making',
   'order book', 'trading desk', 'trading floor', 'derivatives', 'futures', 'options trading',
   'equities', 'fixed income', 'sell-side', 'buy-side', 'hedge fund', 'bloomberg', 'refinitiv',
   'performance attribution', 'algorithmic trading', 'kdb+', 'trader', 'trading', 'equity',
   'market risk', 'front office', 'back office', 'trade capture', 'earnings', 'sell side',
   'buy side', 'listed companies', 'sector research'],
  // data / analytics
  ['data analysis', 'data analyst', 'analytics', 'business intelligence', 'data warehouse', 'etl',
   'data pipeline', 'data model', 'data modelling', 'data quality', 'data storage', 'data protection',
   'reporting layer', 'reporting warehouse', 'reporting', 'kpi', 'kpis', 'key performance indicator',
   'a/b test', 'experimentation', 'statistics', 'statistical', 'statistical model', 'insights',
   'dashboards', 'dashboard', 'metrics', 'data governance', 'sql', 'tableau', 'power bi', 'spark',
   'airflow', 'snowflake', 'dbt'],
  // software engineering / infrastructure
  ['software', 'microservice', 'microservices', 'codebase', 'code review', 'pull request', 'refactoring',
   'technical debt', 'release train', 'unit test', 'infrastructure', 'services team', 'backend',
   'frontend', 'devops', 'full stack', 'distributed systems', 'systems design', 'coding', 'developer',
   'programming', 'ci/cd', 'continuous integration', 'repository', 'incident', 'on-call', 'stack',
   'orchestration', 'transformation layer', 'kubernetes', 'terraform', 'docker', 'aws', 'typescript',
   'postgresql', 'graphql', 'node.js', 'node', 'react', 'kafka', 'microservice architecture'],
  // clinical / care
  ['nurse', 'nursing', 'patient', 'ward', 'bedside', 'intensive care', 'icu', 'emergency department',
   'triage', 'vital signs', 'ventilator', 'clinical', 'physician', 'therapy', 'physiotherapy', 'pharmacy',
   'pharmacist', 'mental health', 'counselling', 'counseling', 'dental', 'oncology', 'radiology',
   'care home', 'social care', 'surgery', 'veterinary', 'hospital', 'clinic', 'ward round', 'outpatient',
   'handovers', 'medication', 'residents'],
  // legal practice
  ['attorney', 'lawyer', 'legal counsel', 'litigation', 'barrister', 'solicitor', 'paralegal',
   'contract law', 'due diligence', 'dispute resolution', 'tribunal', 'legal department', 'law firm',
   'trademark', 'patents', 'compliance officer', 'law degree', 'shareholder agreements', 'legal practice',
   'research notes'],
  // people / HR
  ['human resources', 'employee relations', 'recruitment', 'recruiter', 'payroll', 'performance review',
   'headcount', 'works council', 'onboarding', 'talent acquisition', 'learning and development',
   'hr business partner', 'staff retention', 'employee', 'people matters', 'policy'],
  // marketing / growth
  ['marketing', 'campaign', 'brand', 'seo', 'content marketing', 'social media', 'paid acquisition',
   'marketing automation', 'email marketing', 'lifecycle', 'demand generation', 'copywriting',
   'creative brief', 'market sizing', 'customer acquisition', 'google ads', 'newsletter', 'landing page',
   'awareness', 'agency'],
  // sales
  ['sales', 'selling', 'quota', 'quota attainment', 'pipeline management', 'prospecting', 'closing deals',
   'account executive', 'commission', 'cold calling', 'crm', 'renewals', 'renewal', 'deal desk',
   'mid-market accounts', 'new business', 'upsell', 'cross-sell', 'bdr', 'sdr', 'outbound sales',
   'outbound prospecting', 'outbound sequences', 'outbound leads', 'full sales cycle', 'negotiation'],
  // operations / supply chain / site
  ['logistics', 'supply chain', 'procurement', 'inventory', 'fulfilment', 'fulfillment', 'fleet',
   'forklift', 'shift', 'lean', 'manufacturing', 'production line', 'quality control', 'maintenance',
   'site supervision', 'health and safety', 'distribution centre', 'distribution center', 'stock accuracy',
   'wms', 'warehouse operations', 'operations manager', 'reactive maintenance', 'preventive maintenance',
   'distribution site', 'shift planning', 'fault finding'],
  // teaching
  ['teacher', 'teaching', 'classroom', 'curriculum', 'lesson', 'pupil', 'student', 'school year',
   'student assessment', 'safeguarding', 'paraprofessional', 'subject teaching', 'parent conferences',
   'lesson plans', 'school', 'national curriculum', 'teaching'],
  // trades / construction
  ['electrician', 'plumbing', 'hvac', 'welding', 'carpentry', 'carpenter', 'certified electrician',
   '18th edition', 'autocad', 'construction', 'civil engineering', 'structural', 'building control',
   'site works', 'installation', 'architect', 'urban infrastructure', 'contractor management',
   'technical drawings', 'maintenance contractor', 'public procurement'],
  // hospitality
  ['chef', 'kitchen', 'barista', 'waiter', 'waitress', 'cashier', 'front desk', 'housekeeping',
   'guest services', 'restaurant', 'bar shift', 'hospitality', 'menu planning', 'banquet', 'guest']
]

// ---------------------------------------------------------------------------
// Mandatory licence / registration / charter gates
// ---------------------------------------------------------------------------
// `demand` phrases are matched against the posting, but only inside a
// requirement-ish line (a requirement cue, or the title, which is itself a
// statement of what the job is) that is not a wish. `evidence` phrases are
// matched against the CV as contiguous canonical n-grams. A gate is unmet
// when the posting demands it and the CV shows no evidence of it.
//
// The table is small on purpose: these are entry requirements whose absence is
// genuinely disqualifying — you cannot practise, sign off, or trade without
// them — not merely missing skills. A missed gate is survivable (the role,
// sector and skill terms still have to add up), but a false one would cap a
// real match, so each gate fires on a specific phrase and stands down on
// preference, negation, sponsorship and "or equivalent" wording.
const REQUIREMENT_CUE_RE =
  /\b(requirements?|required|require[sd]?|must|minimum|essential|qualifications?|licen[cs]e[sd]?|licensing|certificat(?:ion|ed)|registrations?|credentials?|accredit(?:ed|ation))\b/
const NOT_REQUIRED_RE =
  /\b(preferred?|desirable|advantageous|nice[- ]to[- ]have|a plus|bonus|ideally|optional|not required|no requirement|not needed|not essential|would be nice|useful|asset)\b/
const EQUIVALENT_RE = /\b(or (?:an? )?(?:equivalent|comparable)|equivalent combination)\b/
const FUNDED_RE = /\b(sponsor(?:ed|ship|ing)?|fund(?:s|ed|ing)?\b|we (?:will|would) (?:pay|fund|cover)|cover(?:ed|s)? the (?:cost|fee|programme|program))\b/

interface CredentialGate {
  readonly id: string
  readonly demand: readonly string[]
  readonly evidence: readonly string[]
}

const CREDENTIAL_GATES: readonly CredentialGate[] = [
  {
    id: 'nursing',
    demand: ['registered nurse', 'nursing licence', 'nursing license', 'rn licence', 'rn license',
             'nurse practitioner licence', 'nurse practitioner license', 'state licence', 'state license'],
    evidence: ['registered nurse', 'nursing', 'nurse practitioner', 'rn', 'bsn', 'msn']
  },
  {
    id: 'medicine',
    demand: ['medical licence', 'medical license', 'md licence', 'md license', 'physician licence',
             'physician license', 'attending physician', 'board certified', 'residency completion'],
    evidence: ['medical licence', 'medical license', 'md', 'physician', 'doctor', 'doctors', 'surgeon',
               'residency']
  },
  {
    id: 'pharmacy',
    demand: ['pharmacist licence', 'pharmacist license', 'rph registration', 'rph licence', 'rph license',
             'registered pharmacist', 'pharmacy registration'],
    evidence: ['pharmacist', 'pharmd', 'rph', 'pharmacy', 'pharmaceutical']
  },
  {
    id: 'legal-practice',
    demand: ['bar admission', 'bar admitted', 'admitted to the bar', 'solicitor licence', 'solicitor license',
             'attorney licence', 'attorney license'],
    evidence: ['bar admission', 'admitted to the bar', 'attorney', 'solicitor', 'barrister', 'lawyer',
               'juris doctor']
  },
  {
    id: 'accounting-licence',
    demand: ['chartered accountant', 'certified public accountant', 'cpa licence', 'cpa license',
             'registered cpa', 'acca', 'cima', 'icaew', 'aicpa'],
    evidence: ['chartered accountant', 'certified public accountant', 'cpa', 'acca', 'cima', 'icaew', 'aicpa']
  },
  {
    id: 'securities-registration',
    demand: ['series 7', 'series 63', 'series 65', 'series 66', 'series 82', 'series 99', 'series 24',
             'finra', 'broker-dealer registration', 'sec registration', 'sec registered'],
    evidence: ['series 7', 'series 63', 'series 65', 'series 66', 'series 82', 'series 99', 'series 24',
               'finra', 'broker-dealer', 'sec registration', 'sec registered']
  },
  {
    id: 'cfa-charter',
    demand: ['cfa level', 'cfa charter', 'cfa program', 'charterholder', 'charter holder'],
    evidence: ['cfa level', 'cfa', 'caia', 'cqf', 'charterholder', 'charter holder']
  },
  {
    id: 'professional-registration',
    demand: ['certified electrician', 'electrician licence', 'electrician license',
             'professional engineer licence', 'professional engineer license', 'pe licence', 'pe license',
             'chartered engineer', 'chartered surveyor', '18th edition', 'city & guilds'],
    evidence: ['electrician', 'plumber', 'plumbing', 'hvac', 'welder', 'carpenter', 'chartered engineer',
               'chartered surveyor', 'professional engineer', '18th edition', 'city & guilds']
  },
  {
    id: 'clinical-psychology',
    demand: ['psychology licence', 'psychology license', 'licensed psychologist',
             'clinical psychologist licence', 'clinical psychologist license', 'telehealth licence',
             'telehealth license'],
    evidence: ['psychologist', 'psychology', 'clinical psychology', 'licensed psychologist', 'psy.d']
  }
]

// ---------------------------------------------------------------------------
// CV index — the expensive half of a scan, built once per CV
// ---------------------------------------------------------------------------
// A scan scores thousands of listings against ONE CV, so the CV-side passes
// (tokenize, n-gram index, profession/branch/sector/credential evidence) are
// the part worth caching. The cache is keyed on the exact CV string and
// bounded to CV_INDEX_CACHE_SIZE entries with FIFO eviction, so it cannot grow
// with the number of listings.
const CV_INDEX_CACHE_SIZE = 4
// Longest n-gram indexed, matching the longest allowlist phrase.
const MAX_GRAM = 4
// Above this many CV tokens the index stops growing past bigrams, so a
// pathological (whole-book) CV cannot blow up memory.
const MAX_INDEXED_TOKENS = 20000

interface CvIndex {
  readonly grams: Set<string>
  readonly professions: Set<string>
  readonly qualifiers: Set<string>
  readonly domains: ReadonlySet<number>
  readonly credentials: Set<string>
  readonly years: number
  readonly rank: number
}

const cvIndexCache = new Map<string, CvIndex>()

// Spelling equivalences. The committed allowlist bundle is US-spelled while
// most of the postings this app reads are UK/IE/EU, so without this a UK
// posting loses the requirement and a UK CV fails to satisfy it. An explicit
// list rather than an -ise/-ize suffix rule, because the suffix has too many
// English false friends (advise, promise, precise, rise) to rewrite blindly.
const SPELLING_ALIASES: Readonly<Record<string, string>> = {
  modelling: 'modeling', modelled: 'modeled', modeller: 'modeler',
  organisation: 'organization', organisations: 'organizations',
  organised: 'organized', organising: 'organizing', organisational: 'organizational',
  organisationally: 'organizationally', reorganise: 'reorganize',
  normalisation: 'normalization', normalised: 'normalized', normalising: 'normalizing',
  optimisation: 'optimization', optimised: 'optimized', optimise: 'optimize',
  prioritise: 'prioritize', prioritised: 'prioritized',
  prioritisation: 'prioritization', personalise: 'personalize', personalised: 'personalized',
  summarise: 'summarize', summarised: 'summarized',
  capitalise: 'capitalize', capitalised: 'capitalized', utilise: 'utilize',
  utilised: 'utilized', standardise: 'standardize',
  centralised: 'centralized', decentralised: 'decentralized', harmonise: 'harmonize',
  visualise: 'visualize', visualised: 'visualized', categorise: 'categorize',
  categorised: 'categorized', categorisation: 'categorization',
  specialise: 'specialize', specialised: 'specialized', specialisation: 'specialization',
  generalise: 'generalize', minimise: 'minimize', maximise: 'maximize',
  recognise: 'recognize', recognised: 'recognized', apologise: 'apologize',
  analyse: 'analyze', analysed: 'analyzed', analysing: 'analyzing',
  paralyse: 'paralyze', catalyse: 'catalyze', criticise: 'criticize',
  authorised: 'authorized', authorisation: 'authorization',
  behaviour: 'behavior', favourable: 'favorable', labour: 'labor',
  centre: 'center', centres: 'centers', metre: 'meter', theatre: 'theater',
  licence: 'license', licensed: 'licensed', licences: 'licenses',
  defence: 'defense', offence: 'offense', practise: 'practice', sceptical: 'skeptical'
}

/**
 * Canonical token stream: lowercased, split on non-token characters, with the
 * shared alias table and the spelling table applied ("k8s" -> "kubernetes",
 * "powerbi" -> "power bi", "modelling" -> "modeling"). An alias can expand to
 * several words, so the mapped value is re-split.
 */
function canonicalTokens(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#&]+/)) {
    if (!raw) continue
    const aliased = KEYWORD_ALIASES[raw] ?? SPELLING_ALIASES[raw] ?? raw
    for (const t of aliased.split(/[^a-z0-9+#&]+/)) {
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * The posting as one canonical, space-joined token string.
 *
 * Built once per listing and used for every phrase test against the posting
 * (requirement assertion, sector markers), so those tests compare canonical
 * forms on both sides instead of comparing a US-spelled allowlist entry with a
 * UK-spelled posting.
 */
function canonicalText(text: string): string {
  return canonicalTokens(text).join(' ')
}

/** Sector markers in canonical form, one array per sector, resolved once. */
let canonicalSectorsCache: string[][] | null = null
function canonicalSectors(): string[][] {
  if (canonicalSectorsCache) return canonicalSectorsCache
  canonicalSectorsCache = DOMAINS.map((sector) => sector.map((marker) => canonicalTokens(marker).join(' ')))
  return canonicalSectorsCache
}

/** Canonical n-gram form of a phrase, or null when it is out of range. */
function canonicalPhrase(phrase: string): string | null {
  const tokens = canonicalTokens(phrase)
  if (tokens.length === 0 || tokens.length > MAX_GRAM) return null
  return tokens.join(' ')
}

function professionsOf(tokens: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const one = PROFESSION_TOKENS[tokens[i]]
    if (one) out.add(one)
    if (i + 1 < tokens.length) {
      const two = PROFESSION_TOKENS[`${tokens[i]} ${tokens[i + 1]}`]
      if (two) out.add(two)
    }
  }
  return out
}

function qualifiersOf(tokens: string[]): Set<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    if (!QUALIFIER_TOKENS.has(t)) continue
    out.add(QUALIFIER_ALIASES[t] ?? t)
  }
  return out
}

function rankOf(tokens: string[]): number {
  let rank = SENIORITY_DEFAULT_RANK
  let seen = false
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 2; n >= 1; n--) {
      if (i + n > tokens.length) continue
      const found = SENIORITY_RANK[tokens.slice(i, i + n).join(' ')]
      if (found === undefined) continue
      if (!seen || found > rank) rank = found
      seen = true
    }
  }
  return seen ? rank : SENIORITY_DEFAULT_RANK
}

function buildCvIndex(lower: string): CvIndex {
  const tokens = canonicalTokens(lower)
  const grams = new Set<string>()
  const maxN = tokens.length > MAX_INDEXED_TOKENS ? 2 : MAX_GRAM
  for (let i = 0; i < tokens.length; i++) {
    grams.add(tokens[i])
    if (maxN >= 2 && i + 2 <= tokens.length) grams.add(`${tokens[i]} ${tokens[i + 1]}`)
    for (let n = 3; n <= maxN; n++) {
      if (i + n > tokens.length) break
      grams.add(tokens.slice(i, i + n).join(' '))
    }
  }
  const has = (phrase: string): boolean => {
    const gram = canonicalPhrase(phrase)
    return gram !== null && grams.has(gram)
  }
  const domains = new Set<number>()
  for (let d = 0; d < DOMAINS.length; d++) {
    for (const marker of DOMAINS[d]) {
      if (has(marker)) {
        domains.add(d)
        break
      }
    }
  }
  const credentials = new Set<string>()
  for (const gate of CREDENTIAL_GATES) {
    if (gate.evidence.some((phrase) => has(phrase))) credentials.add(gate.id)
  }
  return {
    grams,
    professions: professionsOf(tokens),
    qualifiers: qualifiersOf(tokens),
    domains,
    credentials,
    years: extractYearsExperience(lower),
    rank: rankOf(tokens)
  }
}

/** Memoised CV index, FIFO-evicted at CV_INDEX_CACHE_SIZE entries. */
function cvIndexFor(baseCv: string): CvIndex {
  const lower = baseCv.toLowerCase()
  const hit = cvIndexCache.get(lower)
  if (hit) return hit
  const built = buildCvIndex(lower)
  if (cvIndexCache.size >= CV_INDEX_CACHE_SIZE) {
    const oldest = cvIndexCache.keys().next()
    if (!oldest.done) cvIndexCache.delete(oldest.value)
  }
  cvIndexCache.set(lower, built)
  return built
}

/** True when the CV contains `phrase` as a contiguous canonical n-gram. */
function cvHas(index: CvIndex, phrase: string): boolean {
  const gram = canonicalPhrase(phrase)
  return gram !== null && index.grams.has(gram)
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function isTokenChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9+#]/.test(ch)
}

/**
 * True when `text` contains `phrase` on token boundaries.
 *
 * Raw substring search is not safe on the vocabulary in these tables: "sem"
 * matches "semantic models", "api" matches "capital", "md" matches "amd", and a
 * sector marker list that quietly matches inside longer words is worse than no
 * marker at all (it manufactures sector evidence). Scanning with indexOf and
 * checking the two neighbouring characters keeps the test allocation-free.
 */
function containsPhrase(text: string, phrase: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(phrase, from)
    if (at < 0) return false
    const end = at + phrase.length
    const before = at > 0 ? text[at - 1] : undefined
    const after = text[end]
    // A trailing plural "s" is part of the word for our purposes: postings
    // say "data warehouses", "patients", "KPIs", and a marker list that only
    // recognises the singular misses most of a real posting.
    const plural = after === 's' && !isTokenChar(text[end + 1])
    if (!isTokenChar(before) && (!isTokenChar(after) || plural)) return true
    from = at + 1
  }
}

/**
 * True when the posting itself states the phrase.
 *
 * Separates a requirement the author wrote from one the extractor
 * synthesised: the allowlist's title head matching turns "Business
 * Intelligence Analyst" into a requirement for "business loans" and "business
 * law", which no CV can satisfy and which therefore crushed every BI posting.
 */
function assertedInPosting(jobCanonical: string, phrase: string): boolean {
  const canonical = canonicalTokens(phrase).join(' ')
  if (canonical === '') return false
  return containsPhrase(jobCanonical, canonical)
}

/**
 * True when the phrase is a requirement we have a name for.
 *
 * The extractor's unnamed phrases are the PMI-discovered bigrams mined out of
 * prose ("quarterly planning", "internal stakeholders"). They are not
 * requirements; matching them measures vocabulary luck. Single tokens are kept
 * as-is: a JD that says "SQL" means SQL even though SQL is not a phrase.
 */
function isNamedRequirement(phrase: string): boolean {
  if (canonicalTokens(phrase).length <= 1) return true
  const lists = loadKeywordAllowlists()
  const key = matchKey(phrase)
  return lists.byKey.has(key) || lists.phraseBoostByKey.has(key)
}

/**
 * Weight a coverage ratio by how much evidence it was estimated from.
 *
 * A ratio over n observations is a noisier measurement than a ratio over many
 * (n=1 is one bit dressed as a fraction), so it carries n/(n+1) of its nominal
 * weight. The discount is toward "no information" — the term loses weight, it
 * does not slide toward a neutral value — so it can only ever refuse to
 * over-claim. Applied to the two ratio terms (skills, sector); the profession
 * term is a categorical judgement, not an estimate, and is not shrunk.
 */
function evidenceConfidence(n: number): number {
  return n / (n + 1)
}

export interface SkillSignal {
  /** Weighted coverage of the posting's asserted requirements, or null when
   *  the posting asserts nothing we can measure. */
  readonly score: number | null
  /** How many asserted requirements the ratio was estimated from. */
  readonly measured: number
  readonly matched: string[]
  readonly missing: string[]
  /** Must-have (required + title) phrases the CV cannot evidence. */
  readonly required: string[]
  readonly preferred: string[]
}

/**
 * Coverage of the requirements the posting actually asserts, section-aware.
 *
 * Required coverage counts for twice what the body does and five times what a
 * nice-to-have does, because the three sections make different promises.
 */
function scoreSkills(jobCanonical: string, normalizedJobText: string, cv: CvIndex): SkillSignal {
  const { keywords } = extractJobKeywordsStructured(normalizedJobText)
  const buckets = new Map<KeywordEntry['source'], { matched: number; total: number; count: number }>()
  const matched: string[] = []
  const missing: string[] = []
  const required: string[] = []
  const preferred: string[] = []

  for (const kw of keywords) {
    // Role words ("manager", "senior", "lead") are role/seniority facts, not
    // skills; the role and seniority terms measure them, so counting them here
    // would double-count them and dilute the real skill evidence.
    if (kw.category === 'seniority') continue
    if (!assertedInPosting(jobCanonical, kw.phrase)) continue
    if (kw.source === 'body' && !isNamedRequirement(kw.phrase)) continue

    const bucket = buckets.get(kw.source) ?? { matched: 0, total: 0, count: 0 }
    bucket.total += kw.weight
    bucket.count++
    if (cvHas(cv, kw.phrase)) {
      bucket.matched += kw.weight
      if (!matched.includes(kw.phrase)) matched.push(kw.phrase)
    } else {
      if (!missing.includes(kw.phrase)) missing.push(kw.phrase)
      if (kw.source === 'preferred') {
        if (!preferred.includes(kw.phrase)) preferred.push(kw.phrase)
      } else if (!required.includes(kw.phrase)) {
        required.push(kw.phrase)
      }
    }
    buckets.set(kw.source, bucket)
  }

  let weighted = 0
  let totalWeight = 0
  let measured = 0
  for (const [source, bucket] of buckets) {
    const weight = SKILL_SOURCE_WEIGHTS[source]
    if (weight === undefined || bucket.total <= 0) continue
    weighted += weight * (bucket.matched / bucket.total)
    totalWeight += weight
  }
  for (const bucket of buckets.values()) measured += bucket.count
  if (totalWeight === 0) {
    return { score: null, measured: 0, matched, missing, required, preferred }
  }
  return {
    score: (weighted / totalWeight) * evidenceConfidence(measured),
    measured,
    matched,
    missing,
    required,
    preferred
  }
}

/**
 * Profession + branch of the posting title against the CV.
 *
 * Same profession and same branch 1.0; same profession, different branch 0.5
 * (adjacent and worth a look, but not this person's function); a different
 * profession 0. Engineering specialisms are professions, so "Full-Stack
 * Engineer" against a "Frontend Engineer" CV is not punished for spelling the
 * specialism differently.
 */
function scoreRole(title: string, cv: CvIndex): number | null {
  const tokens = canonicalTokens(title)
  const professions = professionsOf(tokens)
  const qualifiers = qualifiersOf(tokens)
  const branchMatch =
    qualifiers.size === 0 || [...qualifiers].some((q) => cv.qualifiers.has(q))

  if (professions.size === 0) {
    // A title that names no profession ("Operations Manager", "VP") states no
    // profession at all, so this signal is not measurable — and it is not
    // licence to fall back on a shared function word. The old word-overlap
    // score read a CV line reading "Data Analyst (2018-2019, operations): SQL
    // over the warehouse" as a match for "Operations Manager, Warehouse" and
    // scored that posting 0.79, higher than every real match in the fixture
    // set. An unmeasurable signal is dropped; it is not evidence.
    return null
  }
  let professionMatch = false
  for (const p of professions) {
    if (cv.professions.has(p)) {
      professionMatch = true
      break
    }
  }
  if (!professionMatch) return 0
  return branchMatch ? 1 : 0.5
}

/**
 * Share of the posting's sector evidence the CV can back, or null when the
 * posting asserts no sector at all.
 *
 * Same shape as the skill term — a coverage ratio over what the posting
 * actually says — so an out-of-domain posting is not "not higher", it is near
 * 0 on the strongest single piece of evidence a posting carries about what
 * kind of work the job is. Two properties matter for calibration:
 *
 * - Sectors are counted with their markers, not as one bit each, so a posting
 *   whose text is 20 lines of marketing plus one passing mention of
 *   "analytics reporting" is unevidenced 20:1 rather than 1:1. That is the
 *   difference between dropping a content-marketing posting at 0.05 and
 *   letting it through at 0.23.
 * - A sector may be named by the tool stack that identifies it here (SQL and
 *   Tableau name the data sector, Kubernetes and Terraform the software
 *   sector), because that is genuinely how postings in these sectors present
 *   themselves. The two terms are correlated by construction, which is why the
 *   sector term is capped at W_SECTOR and the skill term is the one that gets
 *   shrunk by its own evidence count.
 */
function scoreSector(jobCanonical: string, cv: CvIndex): { score: number | null; measured: number } {
  const sectors = canonicalSectors()
  let asserted = 0
  let evidenced = 0
  for (let d = 0; d < sectors.length; d++) {
    for (let m = 0; m < sectors[d].length; m++) {
      if (!containsPhrase(jobCanonical, sectors[d][m])) continue
      asserted++
      if (cvHas(cv, DOMAINS[d][m])) evidenced++
    }
  }
  if (asserted === 0) return { score: null, measured: 0 }
  return { score: evidenced / asserted, measured: asserted }
}

/** Title ladder position, or null when the text states none. */
function statedRank(tokens: string[]): number | null {
  let rank: number | null = null
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 2; n >= 1; n--) {
      if (i + n > tokens.length) continue
      const found = SENIORITY_RANK[tokens.slice(i, i + n).join(' ')]
      if (found === undefined) continue
      if (rank === null || found > rank) rank = found
    }
  }
  return rank
}

/**
 * Bounded seniority multiplier in [0.55, 1].
 *
 * A preference, so it only ever reduces the score, and only by a bounded
 * amount: a stretch role is still a lead. Over-qualification returns 1.0
 * rather than a bonus — being senior does not make a job more relevant to you.
 */
function seniorityFactor(jobText: string, title: string, cv: CvIndex): number {
  let factor = 1
  const required = extractYearsExperience(jobText)
  if (required > 0) {
    const met = Math.min(1, cv.years / required)
    factor = Math.min(factor, SENIORITY_FLOOR + SENIORITY_YEARS_SPAN * met)
  }
  const jobRank = statedRank(canonicalTokens(title))
  if (jobRank !== null) {
    const steps = jobRank - cv.rank
    if (steps >= SENIORITY_TITLE_STEPS_BEFORE_PENALTY) {
      factor = Math.min(factor, Math.max(SENIORITY_TITLE_FLOOR, 1 - SENIORITY_TITLE_STEP * steps))
    }
  }
  return factor
}

/**
 * Mandatory licences / registrations the posting demands and the CV cannot
 * evidence.
 *
 * The title counts as a requirement line on its own: a job titled "Registered
 * Nurse" is a statement about the licence, not a wish about it.
 */
function unmetCredentialGates(title: string, jobText: string, cv: CvIndex): string[] {
  const unmet = new Set<string>()
  const consider = (line: string, isRequirement: boolean): void => {
    if (!isRequirement) return
    if (NOT_REQUIRED_RE.test(line) || EQUIVALENT_RE.test(line) || FUNDED_RE.test(line)) return
    for (const gate of CREDENTIAL_GATES) {
      if (cv.credentials.has(gate.id)) continue
      if (gate.demand.some((phrase) => containsPhrase(line, phrase))) unmet.add(gate.id)
    }
  }
  consider(title.toLowerCase(), true)
  for (const line of jobText.split('\n')) consider(line.toLowerCase(), REQUIREMENT_CUE_RE.test(line.toLowerCase()))
  return [...unmet]
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

/**
 * The per-signal breakdown behind a fit score.
 *
 * Exported so the score is inspectable: every consumer (and every test) can
 * see WHY a listing scored what it scored instead of inferring it from a
 * single opaque float. `null` on a signal means "not measurable for this
 * posting" (no profession in the title, no years stated, no sector markers),
 * and such a signal takes no part in the composite — it is not evidence of
 * anything, and treating it as neutral is what let unrelated jobs through.
 */
export interface CompatibilitySignals {
  readonly score: number
  readonly skills: number | null
  readonly role: number | null
  readonly sector: number | null
  readonly seniorityFactor: number
  /** Unmet mandatory licence/registration gates (hard incompatibilities). */
  readonly licenceGates: string[]
  readonly matched: string[]
  readonly missing: string[]
  readonly required: string[]
  readonly preferred: string[]
}

/** Full breakdown of the fit score. See `CompatibilitySignals`. */
export function compatibilitySignals(input: StructuredHeuristicInput): CompatibilitySignals {
  if (!input.baseCv) {
    return {
      score: NO_BASE_CV_SCORE,
      skills: null,
      role: null,
      sector: null,
      seniorityFactor: 1,
      licenceGates: [],
      matched: [],
      missing: [],
      required: [],
      preferred: []
    }
  }

  const cv = cvIndexFor(input.baseCv)
  const jobText = [input.title, input.description ?? '', input.requirements ?? ''].join('\n\n')
  const jobCanonical = canonicalText(jobText)

  const skills = scoreSkills(jobCanonical, normalizeJobText(jobText), cv)
  const role = scoreRole(input.title, cv)
  const sector = scoreSector(jobCanonical, cv)
  const factor = seniorityFactor(jobText, input.title, cv)
  const licenceGates = unmetCredentialGates(input.title, jobText, cv)

  let weighted = 0
  let totalWeight = 0
  const contribute = (weight: number, value: number | null): void => {
    if (value === null) return
    weighted += weight * value
    totalWeight += weight
  }
  contribute(W_SKILLS, skills.score)
  contribute(W_SECTOR, sector.score)
  contribute(W_ROLE, role)

  // Nothing measurable at all: the posting states nothing we can compare, so
  // it is not evidence of relevance. Zero, not a neutral 0.5.
  let score = totalWeight > 0 ? (weighted / totalWeight) * factor : 0
  if (licenceGates.length > 0) score = Math.min(score, LICENCE_GATED_SCORE_CAP)
  score = Math.max(0, Math.min(score, 1))

  return {
    score,
    skills: skills.score,
    role,
    sector: sector.score,
    seniorityFactor: factor,
    licenceGates,
    matched: skills.matched,
    missing: skills.missing,
    required: skills.required,
    preferred: skills.preferred
  }
}

/**
 * Structured heuristic scorer. Weighted mean of the signals we can actually
 * measure (asserted skill coverage, sector evidence, profession + branch),
 * discounted by a bounded seniority preference and capped when the posting
 * demands a professional licence the CV cannot evidence. Returns [0, 1].
 */
export function scoreCompatibilityStructured(input: StructuredHeuristicInput): number {
  return compatibilitySignals(input).score
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
