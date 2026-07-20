// Comprehensive HTML entity table. Covers the named entities that actually
// appear in scraped job-board HTML (curly quotes, dashes, bullets, etc.)
// plus the basic XML/HTML core. Numeric entities (&#NNN; / &#xHH;) are
// handled by the decoder function, not by this table.
const ENTITY_MAP: Record<string, string> = {
  // Core XML/HTML
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  // Apostrophe / quotes
  '&#39;': "'",
  '&#x27;': "'",
  '&lsquo;': '\u2018',  // '
  '&rsquo;': '\u2019',  // '
  '&ldquo;': '\u201C',  // "
  '&rdquo;': '\u201D',  // "
  '&sbquo;': '\u201A',  // ‚
  '&bdquo;': '\u201E',  // „
  '&laquo;': '\u00AB',  // «
  '&raquo;': '\u00BB',  // »
  // Dashes
  '&ndash;': '\u2013',  // –
  '&mdash;': '\u2014',  // —
  '&minus;': '\u2212',  // −
  // Spaces
  '&nbsp;': ' ',
  '&thinsp;': '\u2009',
  '&ensp;': '\u2002',
  '&emsp;': '\u2003',
  // Ellipsis
  '&hellip;': '\u2026', // …
  '&mldr;': '\u2026',
  // Bullets / markers
  '&bull;': '\u2022',   // •
  '&middot;': '\u00B7', // ·
  '&bullets;': '\u2022',
  '&bullet;': '\u2022',
  // Misc punctuation
  '&copy;': '\u00A9',   // ©
  '&reg;': '\u00AE',    // ®
  '&trade;': '\u2122',  // ™
  '&deg;': '\u00B0',    // °
  '&para;': '\u00B6',   // ¶
  '&sect;': '\u00A7',   // §
  '&times;': '\u00D7',  // ×
  '&divide;': '\u00F7', // ÷
  '&plusmn;': '\u00B1', // ±
  '&micro;': '\u00B5',  // µ
  '&euro;': '\u20AC',   // €
  '&pound;': '\u00A3',  // £
  '&cent;': '\u00A2',   // ¢
  '&yen;': '\u00A5',    // ¥
  // Arrows
  '&larr;': '\u2190',
  '&rarr;': '\u2192',
  '&uarr;': '\u2191',
  '&darr;': '\u2193',
  '&harr;': '\u2194'
}

export function decodeEntities(s: string): string {
  return s.replace(/&[#\w]+;/g, (m) => {
    // Numeric decimal entity: &#NNN;
    if (m.startsWith('&#') && !m.startsWith('&#x') && !m.startsWith('&#X')) {
      const code = parseInt(m.slice(2, -1), 10)
      if (!isNaN(code) && code > 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code) } catch { return m }
      }
      return m
    }
    // Hex entity: &#xHH; or &#XHH;
    if (m.startsWith('&#x') || m.startsWith('&#X')) {
      const code = parseInt(m.slice(3, -1), 16)
      if (!isNaN(code) && code > 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code) } catch { return m }
      }
      return m
    }
    return ENTITY_MAP[m] ?? m
  })
}

// ---------------------------------------------------------------------------
// Location formatting
// ---------------------------------------------------------------------------
// Target shape: "City, REGION, CC" (region and country as 2-letter codes).
// US states + DC, Canadian provinces/territories, and ~30 common countries are
// mapped from full names to codes. Anything we don't recognize is preserved
// as-is so we never lose data.

const US_STATES: Record<string, string> = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
}

const CA_PROVINCES: Record<string, string> = {
  'alberta': 'AB', 'british columbia': 'BC', 'manitoba': 'MB',
  'new brunswick': 'NB', 'newfoundland and labrador': 'NL', 'nova scotia': 'NS',
  'ontario': 'ON', 'prince edward island': 'PE', 'quebec': 'QC',
  'saskatchewan': 'SK', 'northwest territories': 'NT', 'nunavut': 'NU',
  'yukon': 'YT'
}

const COUNTRIES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'canada': 'CA',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB',
  'germany': 'DE', 'france': 'FR', 'spain': 'ES', 'italy': 'IT', 'netherlands': 'NL',
  'ireland': 'IE', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'switzerland': 'CH', 'austria': 'AT', 'belgium': 'BE', 'portugal': 'PT', 'poland': 'PL',
  'czech republic': 'CZ', 'czechia': 'CZ', 'romania': 'RO', 'hungary': 'HU', 'greece': 'GR',
  'australia': 'AU', 'new zealand': 'NZ',
  'india': 'IN', 'china': 'CN', 'japan': 'JP', 'south korea': 'KR', 'korea': 'KR',
  'singapore': 'SG', 'hong kong': 'HK', 'taiwan': 'TW',
  'brazil': 'BR', 'mexico': 'MX', 'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO',
  'united arab emirates': 'AE', 'uae': 'AE',
  'south africa': 'ZA', 'nigeria': 'NG', 'egypt': 'EG', 'kenya': 'KE',
  'turkey': 'TR', 'russia': 'RU', 'ukraine': 'UA'
}

const REGION_MAP: Record<string, string> = { ...US_STATES, ...CA_PROVINCES }

const REMOTE_TOKENS = new Set([
  'remote', 'anywhere', 'worldwide', 'global', 'wfh', 'work from home',
  'distributed', 'fully remote', '100% remote'
])

function normalizeToken(t: string): string {
  return t.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
}

function canonicalizeRegion(token: string): string | null {
  const cleaned = normalizeToken(token)
  if (!cleaned) return null
  const upper = cleaned.toUpperCase()
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) return upper
  const key = cleaned.toLowerCase()
  if (REGION_MAP[key]) return REGION_MAP[key]
  return null
}

function canonicalizeCountry(token: string): string | null {
  const cleaned = normalizeToken(token)
  if (!cleaned) return null
  const upper = cleaned.toUpperCase()
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) return upper
  const key = cleaned.toLowerCase()
  if (COUNTRIES[key]) return COUNTRIES[key]
  return null
}

function formatSingleLocation(raw: string, defaultCountry: string): string {
  const cleaned = normalizeToken(raw)
  if (!cleaned) return ''

  // Preserve known remote/anywhere tokens verbatim.
  if (REMOTE_TOKENS.has(cleaned.toLowerCase())) return cleaned

  // Split on common separators.
  const parts = cleaned
    .split(/[,;|]/)
    .map(normalizeToken)
    .filter(Boolean)

  if (parts.length === 0) return cleaned
  // If the city half is a remote token (e.g. "Remote, CA, US"), drop the
  // location suffix — remote is country-agnostic.
  if (REMOTE_TOKENS.has(parts[0].toLowerCase())) return parts[0]
  if (parts.length === 1) {
    const city = parts[0]
    const cc = canonicalizeCountry(defaultCountry)
    return cc ? `${city}, ${cc}` : city
  }

  if (parts.length === 2) {
    const [city, regionOrCountry] = parts

    // 2-part inputs NEVER get the default country appended — the user has
    // already specified a second piece (region OR country), so respect it.
    // 2-letter tokens are disambiguated against US_STATES + CA_PROVINCES +
    // COUNTRIES; the "CA" collision (California vs Canada) prefers country.
    const upper = regionOrCountry.toUpperCase()
    if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
      const isCountryCode = !!COUNTRIES[regionOrCountry.toLowerCase()]
      const isRegionCode = !!REGION_MAP[regionOrCountry.toLowerCase()]
      if (isCountryCode || isRegionCode) {
        return `${city}, ${upper}`
      }
      // Unknown 2-letter token: pass through unchanged.
      return `${city}, ${regionOrCountry}`
    }

    // Full-name second token: region or country, never append default.
    const region = canonicalizeRegion(regionOrCountry)
    if (region) return `${city}, ${region}`
    const country = canonicalizeCountry(regionOrCountry)
    if (country) return `${city}, ${country}`
    return `${city}, ${regionOrCountry}`
  }


  // 3+ parts: City, Region, Country[, extras...]
  const [city, regionTok, countryTok] = parts
  const region = canonicalizeRegion(regionTok)
  const country = canonicalizeCountry(countryTok) || canonicalizeCountry(defaultCountry)
  if (region && country) return `${city}, ${region}, ${country}`
  if (country) return `${city}, ${country}`
  if (region) return `${city}, ${region}`
  return cleaned
}

/**
 * Normalize a freeform location string to "City, REGION, CC" when possible.
 * Multi-location strings (joined by `;`) are normalized per piece.
 * Returns null if the input is empty or unparseable.
 */
export function formatLocation(raw: string | null | undefined, defaultCountry?: string | null): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const dc = (defaultCountry || '').trim()

  if (trimmed.includes(';')) {
    const pieces = trimmed
      .split(';')
      .map((p) => formatSingleLocation(p, dc))
      .filter(Boolean)
    if (pieces.length === 0) return null
    return pieces.join('; ')
  }

  return formatSingleLocation(trimmed, dc) || null
}

// ---------------------------------------------------------------------------
// Title / company normalization
// ---------------------------------------------------------------------------
// Both run at the persistence boundary (createJob / updateJob) so the rest
// of the codebase can treat these fields as display-ready. Scrapers are
// free to pass whatever they scraped; we clean it up here.
//
// Rules:
//   normalizeTitle — Title Case. Small prepositions/articles/conjunctions
//     (of, and, the, etc.) are lowercase unless they're the first word.
//     Tokens with internal uppercase (iOS, GitHub, McDonalds) are preserved
//     verbatim. Pure-digit / mixed-alphanumeric tokens (v2, SQL2008) are
//     preserved verbatim.
//
//   normalizeCompany — Sentence case. The first letter of every word is
//     capitalized; everything else is lowercase. Trailing punctuation is
//     stripped. Tokens with internal uppercase are preserved. Acronyms
//     in the company name (IBM, KPMG, etc.) are NOT special-cased — they
//     become "Ibm", "Kpmg". If a user wants the display form to keep
//     acronyms, that's a future ask.

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of',
  'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with'
])

/**
 * Returns true for tokens that should be passed through unchanged because
 * they have intentional casing or non-letter content. Catches:
 *   - genuine mixed case: "iOS", "GitHub", "McDonalds" (has both upper
 *     and lower letters)
 *   - tokens without any letters: "3M", "v2", "SQL2008" (digits, symbols)
 *
 * All-caps tokens ("SENIOR", "ACME") and all-lower tokens ("senior",
 * "acme") are NOT preserved — they go through the case path so they get
 * normalized.
 */
function shouldPreserveToken(word: string): boolean {
  const hasLower = /[a-z]/.test(word)
  const hasUpper = /[A-Z]/.test(word)
  if (hasLower && hasUpper) return true
  if (!hasLower && !hasUpper) return true
  return false
}

function titleCaseWord(word: string, isFirst: boolean): string {
  if (!word) return word
  if (shouldPreserveToken(word)) return word
  const lower = word.toLowerCase()
  if (isFirst) return lower.charAt(0).toUpperCase() + lower.slice(1)
  if (SMALL_WORDS.has(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Normalize a job title to Title Case. Lowercases the whole string, then
 * capitalizes the first letter of every word except small prepositions /
 * articles / conjunctions ("of", "and", "the", etc.). Preserves
 * mixed-case tokens (iOS, GitHub, McDonalds) verbatim. Collapses internal
 * whitespace and trims. Returns null for empty input.
 *
 * Examples:
 *   "software developer"          -> "Software Developer"
 *   "SENIOR SOFTWARE DEVELOPER"   -> "Senior Software Developer"
 *   "manager of engineering"      -> "Manager of Engineering"
 *   "iOS engineer"                -> "iOS Engineer"
 */
export function normalizeTitle(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  const tokens = trimmed.split(' ')
  return tokens
    .map((t, i) => titleCaseWord(t, i === 0))
    .join(' ')
}

/**
 * Normalize a company name to Sentence case. The first letter of every
 * word is capitalized; everything else is lowercase. Trailing punctuation
 * is stripped. Mixed-case tokens (GitHub, McDonalds) are preserved.
 * Returns null for empty input.
 *
 * Examples:
 *   "SUM'S GROCERY CHECK OUT LTD." -> "Sum's Grocery Check Out Ltd"
 *   "ACME corp"                    -> "Acme Corp"
 *   "github"                       -> "Github"
 *   "GitHub"                       -> "GitHub"  (already mixed-case)
 */
export function normalizeCompany(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  const cleaned = trimmed.replace(/[.,;:]+$/g, '').trim()
  if (!cleaned) return null
  const tokens = cleaned.split(' ')
  return tokens
    .map((t, i) => titleCaseWord(t, i === 0))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Salary normalization
// ---------------------------------------------------------------------------
// Salaries land in the database in whatever unit the source page used:
// "$43/hour", "$7,502.25 - $10,788.33 CAD Monthly", "$80,000 - $100,000",
// "Up to $120,000", etc. For the Job Board, the JobDetail card, and any
// salary-aware sort/filter, the user wants everything in annual terms
// (CAD or USD as the source specifies). This util normalizes a free-form
// salary string to its annual equivalent and reformats it as a clean
// range string. Null / unparseable input returns null so callers can
// distinguish "no salary info" from "salary $0".
//
// Conversion rules (industry standard, project policy):
//   hourly   → × hoursPerWeek × 50 weeks (50 = 2 weeks unpaid vacation
//              per accounting convention; 52 would overstate)
//   monthly  → × 12
//   yearly   → as-is
//   weekly   → × 50
//   daily    → × 5 × 50  (5 working days/week, 50 work weeks/year)
//   unknown  → assume yearly
//
// hoursPerWeek is parsed from the job description when present (e.g.
// "37.5 hours per week", "40 hrs/week") and falls back to 40 per
// the project default. This is the same policy as the upstream
// "annualize" request: use the posting's stated hours if available,
// else 40.
//
// The "k" / "K" suffix is expanded ("$100k" → 100000). Currency
// symbols ($ € £ ¥) and 3-letter codes (USD, CAD, EUR, GBP, AUD, NZD)
// are preserved in the output.

const CURRENCY_SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }
const WORK_WEEKS_PER_YEAR = 50
const WORK_DAYS_PER_WEEK = 5
const DEFAULT_HOURS_PER_WEEK = 40

type Period = 'hour' | 'day' | 'week' | 'month' | 'year' | undefined

function detectCurrency(raw: string): string | undefined {
  // 3-letter ISO code first (more specific)
  const code = raw.match(/\b(USD|CAD|EUR|GBP|AUD|NZD)\b/i)
  if (code) return code[1].toUpperCase()
  for (const sym of Object.keys(CURRENCY_SYMBOLS)) {
    if (raw.includes(sym)) return CURRENCY_SYMBOLS[sym]
  }
  return undefined
}

function detectPeriod(raw: string): Period {
  const lc = raw.toLowerCase()
  if (/\bper\s*hour\b|\/hour\b|\/hr\b|\/h\b|\bhourly\b/.test(lc)) return 'hour'
  if (/\bper\s*day\b|\/day\b|\/d\b|\bdaily\b/.test(lc)) return 'day'
  if (/\bper\s*week\b|\/week\b|\/wk\b|\bweekly\b/.test(lc)) return 'week'
  if (/\bper\s*month\b|\/month\b|\/mo\b|\bmonthly\b/.test(lc)) return 'month'
  if (/\bper\s*year\b|\/year\b|\/yr\b|\bannually\b|\byearly\b|\bsalary\b|\bper\s*annum\b|\bannum\b/.test(lc)) return 'year'
  return undefined
}

function parseAmount(token: string): number | null {
  // Strip commas, currency, whitespace
  const t = token.replace(/[,$€£¥\s]/g, '').toLowerCase()
  if (!t) return null
  let n: number
  if (/^\d+(\.\d+)?k$/.test(t)) {
    n = parseFloat(t.slice(0, -1)) * 1000
  } else if (/^\d+(\.\d+)?m$/.test(t)) {
    n = parseFloat(t.slice(0, -1)) * 1_000_000
  } else if (/^\d+(\.\d+)?$/.test(t)) {
    n = parseFloat(t)
  } else {
    return null
  }
  return Number.isFinite(n) ? n : null
}

/**
 * Extract hours-per-week from a job description. Returns the first
 * match of patterns like "37.5 hours per week", "40 hrs/week",
 * "40-hour work week". Returns null if no hours are stated.
 */
export function extractHoursPerWeek(description: string | null | undefined): number | null {
  if (!description) return null
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per|a|each)\s*week/i,
    /(\d+(?:\.\d+)?)\s*[-]?\s*hour\s+work\s+week/i,
    /(\d+(?:\.\d+)?)\s*\/\s*week/i
  ]
  for (const p of patterns) {
    const m = description.match(p)
    if (m) {
      const n = parseFloat(m[1])
      if (Number.isFinite(n) && n > 0 && n <= 80) return n
    }
  }
  return null
}

/**
 * Convert a single salary amount to annual, given a period and
 * hours-per-week. Returns the annual amount, rounded to the nearest
 * integer.
 */
function annualize(amount: number, period: Period, hoursPerWeek: number): number {
  switch (period) {
    case 'hour':  return Math.round(amount * hoursPerWeek * WORK_WEEKS_PER_YEAR)
    case 'day':   return Math.round(amount * WORK_DAYS_PER_WEEK * WORK_WEEKS_PER_YEAR)
    case 'week':  return Math.round(amount * WORK_WEEKS_PER_YEAR)
    case 'month': return Math.round(amount * 12)
    case 'year':  return Math.round(amount)
    default:      return Math.round(amount)  // assume yearly
  }
}

/**
 * Format a number as a clean "$1,234,567"-style string. For annual
 * amounts under $10,000 round to the nearest $100; for $10k+ round
 * to the nearest $1,000. This is the precision the user actually
 * cares about for job comparisons.
 */
function formatAmount(n: number): string {
  const rounded = n >= 10000 ? Math.round(n / 1000) * 1000
                 : n >= 1000  ? Math.round(n / 100) * 100
                              : Math.round(n)
  return rounded.toLocaleString('en-US')
}

/**
 * Pick a display prefix for a currency. Prefer the symbol ($/€/£/¥)
 * for the most common currencies; fall back to the 3-letter code for
 * less common ones (CAD keeps the code "CAD" because Canadian users
 * see lots of mixed CAD/USD postings and the code disambiguates).
 */
function currencyPrefix(currency: string | undefined, withCurrency: boolean): string {
  if (!withCurrency) return ''
  switch (currency) {
    case 'USD': return '$'
    case 'EUR': return '€'
    case 'GBP': return '£'
    case 'JPY': return '¥'
    case 'CAD':
    case 'AUD':
    case 'NZD':
    default:   return currency ? `${currency} ` : '$'
  }
}

function formatSalaryString(amount: number, currency: string | undefined, withCurrency = true): string {
  return `${currencyPrefix(currency, withCurrency)}${formatAmount(amount)}`
}

/**
 * Normalize a free-form salary string to its annual equivalent in
 * the original currency. Handles:
 *   "$43/hour"                                → "$86,000"          (40 hrs × 50 weeks)
 *   "$50/hour"                                → "$100,000"
 *   "$7,502.25 - $10,788.33 CAD Monthly"      → "CAD 90,000 - 129,000"
 *   "$80,000 - $100,000"                      → "$80,000 - $100,000"   (already annual)
 *   "Up to $120,000"                          → "$120,000"
 *   "$100k/year"                              → "$100,000"
 *   "" or null                                → null
 *   unparseable                               → null
 *
 * The `description` argument is used to extract hours-per-week
 * (e.g. "37.5 hours per week") for hourly postings; if not present,
 * DEFAULT_HOURS_PER_WEEK is used.
 */
export function normalizeSalary(
  raw: string | null | undefined,
  description?: string | null | undefined
): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Detect the period from the ORIGINAL string — "per annum" / "per year"
  // / "annually" are period markers and must be visible to detectPeriod.
  // Stripping them BEFORE detection would silently turn an hourly
  // posting like "$60.26 to $75.32 per annum" into "$60.26 to $75.32",
  // and detectPeriod would fall through to the default "yearly" branch,
  // storing the hourly rate as if it were annual.
  const period = detectPeriod(trimmed)

  // Strip the "Up to" / "Starting at" / "From" qualifier prefix and
  // "annually" / "per annum" suffix, and any trailing "(plus bonus)".
  const cleaned = trimmed
    .replace(/^(?:up\s+to|starting\s+at|from|minimum|maximum|min\.?|max\.?)\s*[:]?\s*/i, '')
    .replace(/\s*annually\b/gi, '')
    .replace(/\s*per\s*annum\b/gi, '')
    .replace(/\s*\(.*?\)\s*$/g, '')
    .trim()
  if (!cleaned) return null

  const currency = detectCurrency(cleaned)

  // Pull all numeric tokens. The regex has two alternatives:
  //   1. Comma-grouped: 1-3 digits, then one or more ",NNN" groups —
  //      this captures the full "85,000" / "8,500,000" / "850,000" form
  //      as one token.
  //   2. Bare digits (no commas): just \d+ optionally followed by k/m.
  //      This captures "100k" / "1M" / "43" / "85000" as one token.
  // The key fix vs the prior version: \d{1,3} was greedy and would
  // split "85000" into "850" + "00" because the first alternative
  // required commas to consume the trailing groups. Requiring commas
  // (or a k/m suffix) for the first alternative forces the engine
  // to fall through to the bare-digit alternative for "85000".
  const amountMatches = [...cleaned.matchAll(/(?:\$|€|£|¥)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?[kKmM]?|\d+(?:\.\d+)?[kKmM]?)/g)]
    .map(m => parseAmount(m[1]))
    .filter((n): n is number => n !== null)
  if (amountMatches.length === 0) return null

  const hoursPerWeek = extractHoursPerWeek(description) ?? DEFAULT_HOURS_PER_WEEK
  // Drop zero amounts — a posting of "$0" or "Salary: 0" is almost
  // always a placeholder / unparseable, not a real offer. Better to
  // store null than to remember a $0 in the UI forever.
  const positive = amountMatches.filter(n => n > 0)
  if (positive.length === 0) return null
  const amounts = positive.map(a => annualize(a, period, hoursPerWeek))

  if (amounts.length === 1) return formatSalaryString(amounts[0], currency)
  if (amounts.length >= 2) {
    const [lo, hi] = [Math.min(...amounts), Math.max(...amounts)]
    return `${formatSalaryString(lo, currency)} - ${formatSalaryString(hi, currency, false)}`
  }
  return null
}
