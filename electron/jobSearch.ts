import { createJob, findDuplicateJob, getSeenUrls, getSettings, listJobs } from './database'
import { decodeEntities } from './utils'
import { scrapeJobFromUrl } from './jobScraper'
import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'
import type { Job, ScanFilters, WorkType } from './types'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface BoardConfig {
  name: string
  searchUrl: (keywords: string, location: string) => string
  useBrowser: boolean
}

const BOARDS: BoardConfig[] = [
  {
    name: 'LinkedIn',
    searchUrl: (k, l) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Indeed',
    searchUrl: (k, l) => `https://www.indeed.com/q-${encodeURIComponent(k)}-l-${encodeURIComponent(l || '')}-jobs.html`,
    useBrowser: true
  },
  {
    name: 'Indeed Canada',
    searchUrl: (k, l) => `https://ca.indeed.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Monster',
    searchUrl: (k, l) => `https://www.monster.com/jobs/search?q=${encodeURIComponent(k)}${l ? `&where=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'ZipRecruiter',
    searchUrl: (k, l) => `https://www.ziprecruiter.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'SimplyHired',
    searchUrl: (k, l) => `https://www.simplyhired.com/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Adzuna',
    searchUrl: (k, l) => `https://www.adzuna.com/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Talent.com',
    searchUrl: (k, l) => `https://www.talent.com/jobs?k=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Jora',
    searchUrl: (k, l) => `https://jora.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Remote OK',
    searchUrl: (k) => `https://remoteok.com/remote-${encodeURIComponent(k)}-jobs`,
    useBrowser: false
  },
  {
    name: 'We Work Remotely',
    searchUrl: (k) => `https://weworkremotely.com/categories/remote-${encodeURIComponent(k)}-jobs`,
    useBrowser: true
  },
  {
    name: 'Remotive',
    searchUrl: (k) => `https://remotive.com/?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Remote.co',
    searchUrl: (k) => `https://remote.co/remote-jobs/search/?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Working Nomads',
    searchUrl: (k) => `https://www.workingnomads.com/jobs?keywords=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'JustRemote',
    searchUrl: (k) => `https://justremote.co/search?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Job Bank (GC)',
    searchUrl: (k, l) => `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=${encodeURIComponent(k)}${l ? `&locationstring=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Eluta.ca',
    searchUrl: (k, l) => `https://www.eluta.ca/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Workopolis',
    searchUrl: (k, l) => `https://www.workopolis.com/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Jobboom',
    searchUrl: (k) => `https://www.jobboom.com/en/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'WorkBC',
    searchUrl: (k) => `https://www.workbc.ca/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'CareerBeacon',
    searchUrl: (k, l) => `https://www.careerbeacon.com/en/search?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'CharityVillage',
    searchUrl: (k, l) => `https://www.charityvillage.com/jobs/?keywords=${encodeURIComponent(k)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Crypto Careers',
    searchUrl: (k) => `https://www.crypto-careers.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Cryptorecruit',
    searchUrl: (k) => `https://www.cryptorecruit.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Remote3',
    searchUrl: (k) => `https://remote3.co/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Cryptocurrency Jobs',
    searchUrl: (k) => `https://cryptocurrencyjobs.co/?search=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'CryptoJobsList',
    searchUrl: (k) => `https://cryptojobslist.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'cryptojobs.com',
    searchUrl: (k) => `https://www.cryptojobs.com/jobs?query=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Crypto.jobs',
    searchUrl: (k) => `https://crypto.jobs/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Web3.career',
    searchUrl: () => `https://web3.career/`,
    useBrowser: false
  },
  {
    name: 'Startup.jobs',
    searchUrl: (k) => `https://startup.jobs/${encodeURIComponent(k)}-jobs`,
    useBrowser: true
  },
  {
    name: 'Selby Jennings',
    searchUrl: (k, l) => `https://www.selbyjennings.com/jobs?q=${encodeURIComponent(k)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
    useBrowser: false
  },
  {
    name: 'Idealist',
    searchUrl: (k) => `https://www.idealist.org/en/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Built In',
    searchUrl: (k, l) => `https://builtin.com/jobs?search=${encodeURIComponent(k)}${l ? `&city=${encodeURIComponent(l)}` : ''}`,
    useBrowser: true
  },
  {
    name: 'Vancouver Jobs',
    searchUrl: (k) => `https://jobs.vancouver.ca/search/?q=${encodeURIComponent(k)}`,
    useBrowser: false
  },
  {
    name: 'Built In Toronto',
    searchUrl: (k) => `https://builtintoronto.com/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Wellfound',
    searchUrl: (k) => `https://wellfound.com/search/jobs?q=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'UToronto',
    searchUrl: (k) => `https://jobs.entrepreneurs.utoronto.ca/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Y Combinator',
    searchUrl: (k) => `https://www.ycombinator.com/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'CVCA',
    searchUrl: (k) => `https://www.cvca.ca/professional-development/job-board/?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Top Startups',
    searchUrl: (k) => `https://topstartups.io/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  },
  {
    name: 'Rocketships',
    searchUrl: (k) => `https://rocketships.io/jobs?search=${encodeURIComponent(k)}`,
    useBrowser: true
  }
]

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  boards: ScanBoardResult[]
  errors: string[]
}

function extractJsonLdListings(html: string, baseUrl: string): { url: string; title?: string; company?: string }[] {
  const results: { url: string; title?: string; company?: string }[] = []
  const seen = new Set<string>()
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      const items = parsed['@graph'] || (parsed['@type'] === 'ItemList' ? parsed.itemListElement : [parsed])
      for (const item of Array.isArray(items) ? items : [items]) {
        const data = item['@type'] === 'JobPosting' ? item : null
        if (!data) continue
        const jp = data
        const url = jp.url
        if (!url) continue
        const fullUrl = new URL(url, baseUrl).href
        if (seen.has(fullUrl)) continue
        seen.add(fullUrl)
        results.push({
          url: fullUrl,
          title: jp.title ? String(jp.title).trim() : undefined,
          company: jp.hiringOrganization
            ? typeof jp.hiringOrganization === 'string'
              ? jp.hiringOrganization
              : jp.hiringOrganization.name
            : undefined
        })
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return results
}

function isNonListingPage(html: string, title: string | undefined): boolean {
  const lower = html.toLowerCase()
  const loginIndicators = [
    'sign in to see this job', 'sign in to apply', 'create an account to apply',
    'sign in with google', 'sign in with linkedin', 'sign in with email',
    'forgot your password', 'reset your password',
    'already have an account? sign in', 'dont have an account? sign up',
    'please sign in to continue'
  ]
  const matches = loginIndicators.filter(t => lower.includes(t)).length
  if (title) {
    const t = title.toLowerCase()
    if (t.includes('sign in') || t.includes('log in') || t.includes('log in') || t.includes('sign up')) return true
  }
  return matches >= 3
}

const NAV_PATHS = /^\/(privacy|terms(-of-service)?|cookie(-policy)?|legal\/?$|login|sign(in|up)|register\/?$|forgot(-password)?|logout|auth|help\/?$|contact\/?$|about\/?$|blog\/?$|faq\/?$|pricing\/?$|status\/?$|developers\/?$|security\/?$|trust\/?$|safety\/?$)/i

/** Normalize a URL for dedup comparison: lowercase, strip trailing slash, strip common tracking params */
function dedupKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    // Remove common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'src', 'tracking', 'spm', 'ta', 'trk']
    trackingParams.forEach(p => u.searchParams.delete(p))
    let key = u.origin + u.pathname.replace(/\/$/, '').toLowerCase() + u.search
    return key
  } catch {
    return url.toLowerCase().replace(/\/$/, '')
  }
}

function extractJobUrls(html: string, baseUrl: string, boardName: string): { url: string; title?: string; company?: string }[] {
  const jsonLd = extractJsonLdListings(html, baseUrl)
  if (jsonLd.length > 0) return jsonLd

  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
  if (isNonListingPage(html, pageTitle)) return []

  const results: { url: string; title?: string; company?: string }[] = []
  const seen = new Set<string>()
  const base = new URL(baseUrl)
  const boardLower = boardName.toLowerCase()

  const anchorPattern = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1].trim()
    const inner = match[2].replace(/<[^>]+>/g, '').trim()
    if (!href || href === '#' || href.startsWith('javascript:')) continue

    let fullUrl: string
    try {
      fullUrl = new URL(href, base).href
    } catch {
      continue
    }

    const lowerUrl = fullUrl.toLowerCase()
    if (seen.has(lowerUrl)) continue
    seen.add(lowerUrl)

    const knownBoardDomains = /linkedin\.com|indeed\.com|ca\.indeed\.com|monster\.com|ziprecruiter\.com|simplyhired\.com|adzuna\.com|talent\.com|jora\.com|remoteok\.com|weworkremotely\.com|remotive\.com|remote\.co|workingnomads\.com|justremote\.co|jobbank\.gc\.ca|eluta\.ca|workopolis\.com|jobboom\.com|workbc\.ca|careerbeacon\.com|charityvillage\.com|crypto-careers\.com|cryptorecruit\.com|remote3\.co|cryptocurrencyjobs\.co|cryptojobslist\.com|cryptojobs\.com|crypto\.jobs|web3\.career|startup\.jobs|selbyjennings\.com|idealist\.org|builtin\.com|jobs\.vancouver\.ca/
    if (!knownBoardDomains.test(lowerUrl)) continue

    const pathname = new URL(fullUrl).pathname

    // Only filter URLs whose path is clearly navigation/non-job
    if (NAV_PATHS.test(pathname)) continue

    if (boardLower.includes('linkedin')) {
      if (!pathname.includes('/jobs/')) continue
    } else if (boardLower.includes('indeed')) {
      if (!pathname.includes('/viewjob') && !pathname.includes('/rc/')) continue
    } else if (boardLower.includes('web3.career')) {
      if (pathname === '/' || pathname === '/index.html') continue
      const pathParts = pathname.split('/').filter(Boolean)
      if (pathParts.length < 1) continue
      if (inner.length < 3 || inner.length >= 300) continue
    } else {
      const pathMatch = /^\/(jobs?|careers?|positions?|opportunities?)/i.test(pathname) || pathname.includes('/job/')
      const hasJobKeywords = /job|career|position|opportunity|vacancy/i.test(pathname + ' ' + inner)
      if (!pathMatch && !hasJobKeywords) continue
    }

    if (inner.length > 2 && inner.length < 300) {
      results.push({ url: fullUrl, title: inner })
    }
  }

  return results
}

async function fetchPageHtml(url: string, useBrowser: boolean): Promise<string> {
  if (useBrowser) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error('Blocked by anti-bot protection (Cloudflare/Cloudfront).')
    }
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(30000),
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  if (isChallengePage(html)) {
    try {
      return await fetchHtmlViaBrowser(url)
    } catch {
      throw new Error('HTTP ' + response.status + ' (blocked)')
    }
  }
  return html
}

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

const ROLE_INDICATORS = [
  'engineer', 'developer', 'architect', 'manager', 'director', 'lead', 'head', 'chief',
  'scientist', 'analyst', 'specialist', 'consultant', 'coordinator', 'administrator',
  'designer', 'researcher', 'associate', 'president', 'vp', 'vice president',
  'intern', 'fellow', 'principal', 'staff', 'senior', 'junior', 'mid-level', 'entry'
]

function extractTechnicalTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const lower = text.toLowerCase()

  for (const skill of TECH_SKILLS) {
    if (lower.includes(skill)) terms.add(skill)
  }

  const words = lower.split(/[^a-z0-9+#.]+/)
  for (const w of words) {
    if (w.length > 3 && !/^(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|has|have|with|this|that|from|they|been|were|will|would|could|should|their|there|which|when|what|about|into|than|then|some)$/.test(w)) {
      terms.add(w)
    }
  }

  return terms
}

function extractRoleTitles(text: string): string[] {
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

const EDUCATION_ORDER: Record<string, number> = {
  'phd': 5, 'ph.d.': 5, 'doctorate': 5, 'doctoral': 5,
  'master': 4, "master's": 4, 'masters': 4, 'ma': 4, 'ms': 4, 'mba': 4, 'm.s.': 4, 'm.a.': 4,
  'bachelor': 3, "bachelor's": 3, 'bachelors': 3, 'ba': 3, 'bs': 3, 'b.s.': 3, 'b.a.': 3,
  'associate': 2, "associate's": 2, 'associates': 2, 'a.s.': 2, 'a.a.': 2
}

function extractEducationLevel(text: string): number {
  const lower = text.toLowerCase()
  let maxLevel = 0
  for (const [keyword, level] of Object.entries(EDUCATION_ORDER)) {
    if (lower.includes(keyword) && level > maxLevel) maxLevel = level
  }
  return maxLevel
}

function extractYearsExperience(text: string): number {
  const lower = text.toLowerCase()
  let maxYears = 0
  const patterns = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?experience/g,
    /(\d+)\s*[-–to]+\s*(\d+)\s*(?:years?|yrs?)/g
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

function checkEducationRequirement(jobDesc: string, cvEduLevel: number): { meets: boolean; reason?: string } {
  const lower = jobDesc.toLowerCase()
  let requiredLevel = 0
  let requirementText = ''
  for (const [keyword, level] of Object.entries(EDUCATION_ORDER)) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s']?(?:degree|'?s)?\\b`, 'i')
    if (re.test(lower)) {
      const context = lower.slice(Math.max(0, lower.search(re) - 30), lower.search(re) + 40)
      if (/(?:required|must|need|necessary|preferred|minimum|should have|seeking|looking for|need|require)/i.test(context)) {
        if (level > requiredLevel) {
          requiredLevel = level
          requirementText = keyword
        }
      }
    }
  }
  if (requiredLevel > 0 && cvEduLevel < requiredLevel) {
    return { meets: false, reason: `Requires ${requirementText} degree (user edu level ${cvEduLevel} < ${requiredLevel})` }
  }
  return { meets: true }
}

function checkExperienceRequirement(jobDesc: string, cvYears: number): { meets: boolean; reason?: string } {
  const lower = jobDesc.toLowerCase()
  const minReqPats = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:professional\s+)?experience/i,
    /minimum\s+of\s+(\d+)\s*(?:years?|yrs?)/i,
    /at\s+least\s+(\d+)\s*(?:years?|yrs?)/i,
    /(\d+)\s*[-–]+\s*\d+\s*(?:years?|yrs?)\s*(?:of\s+)?experience/i
  ]
  for (const pat of minReqPats) {
    const m = lower.match(pat)
    if (m) {
      const req = parseInt(m[1], 10)
      if (req > cvYears) {
        return { meets: false, reason: `Requires ${req}+ years experience (user has ${cvYears})` }
      }
    }
  }
  return { meets: true }
}

export function scoreCompatibility(jobTitle: string, jobDesc: string | null, baseCv: string): number {
  if (!baseCv) return 0.5

  const cvLower = baseCv.toLowerCase()
  const descText = (jobTitle + ' ' + (jobDesc || '')).toLowerCase()

  const cvSkills = extractTechnicalTerms(cvLower)
  const jobSkills = extractTechnicalTerms(descText)

  if (cvSkills.size === 0) return 0.3

  let intersect = 0
  for (const s of jobSkills) {
    if (cvSkills.has(s)) intersect++
  }

  const skillScore = cvSkills.size > 0 ? intersect / Math.min(jobSkills.size, cvSkills.size) : 0

  const cvRoles = extractRoleTitles(cvLower)
  const jobTitleLower = jobTitle.toLowerCase()
  let roleScore = 0
  for (const role of cvRoles) {
    const roleWords = role.split(/[^a-z0-9]+/).filter(w => w.length > 2)
    const titleWords = jobTitleLower.split(/[^a-z0-9]+/).filter(w => w.length > 2)
    const matchCount = roleWords.filter(rw => titleWords.some(tw => tw === rw || tw.includes(rw) || rw.includes(tw))).length
    if (matchCount >= Math.min(2, roleWords.length / 2)) {
      roleScore = 1
      break
    }
  }

  const hasRelevantKeywords = /engineer|developer|architect|manager|analyst|scientist|designer|consultant|intern/i.test(jobTitleLower)
  const keywordBonus = hasRelevantKeywords ? 0.15 : 0

  const score = skillScore * 0.6 + roleScore * 0.3 + keywordBonus
  return Math.min(score, 1)
}

function matchesWorkType(text: string, workType: WorkType): boolean {
  if (workType === 'any') return true
  const lower = text.toLowerCase()
  const isRemote = /remote|work from home|wfh|100% remote|fully remote|remote.first|distributed team|anywhere/.test(lower)
  const isHybrid = /hybrid|flexible|mix of remote|remote.office|in.office.and.remote/.test(lower) && !isRemote
  const isInOffice = /on.?site|in.?office|in.person|office.based|at our (headquarters|office|location)/.test(lower)
  if (workType === 'remote') return isRemote
  if (workType === 'hybrid') return isHybrid
  if (workType === 'in_office') return isInOffice || (!isRemote && !isHybrid)
  return true
}

function matchesLocation(jobLocation: string | null, filterLocation: string): boolean {
  if (!filterLocation) return true
  if (!jobLocation) return false
  const jl = jobLocation.toLowerCase()
  const fl = filterLocation.toLowerCase()
  return jl.includes(fl) || fl.includes(jl)
}

async function fetchAndScore(url: string, baseCv: string, seenUrlsSet: Set<string>, scanSeenUrlsSet: Set<string>, workType: WorkType, filterLocation?: string, onJobAdded?: (job: Job) => void): Promise<{ action: 'added' | 'skipped' | 'incompatible' | 'error'; job?: Job; reason?: string }> {
  const dk = dedupKey(url)
  if (seenUrlsSet.has(dk)) return { action: 'skipped', reason: 'Already in database' }

  await new Promise(r => setTimeout(r, 200 + Math.random() * 300))

  let input: { title: string; company: string; location?: string; url?: string; description?: string; salary_range?: string; source?: string; notes?: string; requirements?: string; application_requirements?: string; hiring_manager?: string; employment_type?: string; work_mode?: string }
  try {
    input = await scrapeJobFromUrl(url)
  } catch (err) {
    return { action: 'error', reason: `Scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }

  if (!input.title || !input.company || !input.description) {
    return { action: 'error', reason: 'Missing required fields' }
  }

  // Duplicate check by URL (normalized) and company+title
  if (findDuplicateJob({ ...input, url: input.url || url } as any)) {
    seenUrlsSet.add(dk)
    return { action: 'skipped', reason: 'Duplicate (already exists by URL or company+title)' }
  }

  if (!matchesWorkType(input.title + ' ' + input.description, workType)) {
    return { action: 'incompatible', reason: `Work type filter: ${workType}` }
  }

  if (!matchesLocation(input.location || null, filterLocation || '')) {
    return { action: 'incompatible', reason: `Location filter: ${filterLocation}` }
  }

  const desc = input.description || ''
  const cvEduLevel = extractEducationLevel(baseCv)
  const cvYears = extractYearsExperience(baseCv)

  if (cvEduLevel > 0) {
    const eduCheck = checkEducationRequirement(desc, cvEduLevel)
    if (!eduCheck.meets) {
      return { action: 'incompatible', reason: eduCheck.reason }
    }
  }

  if (cvYears > 0) {
    const expCheck = checkExperienceRequirement(desc, cvYears)
    if (!expCheck.meets) {
      return { action: 'incompatible', reason: expCheck.reason }
    }
  }

  const score = scoreCompatibility(input.title, input.description, baseCv)
  if (score < 0.08) {
    return { action: 'incompatible', reason: `Score ${score.toFixed(2)} < 0.08` }
  }

  try {
    const job = createJob({ ...input, score })
    // Fire-and-forget auto-generation of CV and cover letter
    onJobAdded?.(job)
    // Update in-memory dedup sets so concurrent calls see this URL as already-processed
    seenUrlsSet.add(dk)
    scanSeenUrlsSet.add(dk)
    return { action: 'added', job }
  } catch (err) {
    return { action: 'error', reason: `Create failed: ${err instanceof Error ? err.message : 'Unknown'}` }
  }
}

export async function scanAllBoards(filters?: ScanFilters, onProgress?: (msg: string) => void, onJobAdded?: (job: Job) => void): Promise<ScanResult> {
  const settings = getSettings()
  const keywords = (filters?.keywords || settings.job_search_keywords || '').trim()
  const location = (filters?.location || settings.job_search_location || '').trim()
  const workType = filters?.workType || 'any'
  const baseCv = settings.base_cv || ''

  const existingJobs = listJobs()
  const seenUrls = new Set(getSeenUrls().map(dedupKey))
  const scanSeenUrls = new Set<string>()

  const result: ScanResult = { totalFound: 0, totalAdded: 0, totalSkipped: 0, boards: [], errors: [] }
  const _seenProgress = new Set<string>()
  const progress = (msg: string) => {
    if (_seenProgress.has(msg)) return
    _seenProgress.add(msg)
    ;(onProgress || ((_: string) => {}))(msg)
  }

  const LISTING_CONCURRENCY = 6

  async function processBoard(board: BoardConfig): Promise<ScanBoardResult> {
    const br: ScanBoardResult = { board: board.name, found: 0, added: 0, skipped: 0 }
    try {
      progress(`Scanning ${board.name}...`)
      const searchUrl = board.searchUrl(keywords, location)
      const html = await fetchPageHtml(searchUrl, board.useBrowser)

      progress(`Parsing listings from ${board.name}...`)
      let listings = extractJobUrls(html, searchUrl, board.name)
      br.found = listings.length

      // Dedup listings by normalized URL and by company+title combo
      const seenTitleCompany = new Set<string>()
      listings = listings.filter(l => {
        const dk = dedupKey(l.url)
        if (scanSeenUrls.has(dk)) return false
        scanSeenUrls.add(dk)
        if (seenUrls.has(dk)) {
          br.skipped++
          return false
        }
        // Dedup by company+title within the same board
        if (l.title && l.company) {
          const tcKey = (l.company + '||' + l.title).toLowerCase()
          if (seenTitleCompany.has(tcKey)) return false
          seenTitleCompany.add(tcKey)
        }
        return true
      })

      const batches: typeof listings[] = []
      for (let i = 0; i < listings.length; i += LISTING_CONCURRENCY) {
        batches.push(listings.slice(i, i + LISTING_CONCURRENCY))
      }

      for (const batch of batches) {
        const results = await Promise.allSettled(
            batch.map(async (l) => {
                progress(`Scraping ${board.name} — ${decodeEntities(l.company || l.title || l.url)}`)
              return fetchAndScore(l.url, baseCv, seenUrls, scanSeenUrls, workType, location, onJobAdded)
          })
        )
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value.action === 'added') {
              br.added++
              result.totalAdded++
              if (r.value.job) {
                progress(`✓ Added ${decodeEntities(r.value.job.company)} — ${decodeEntities(r.value.job.title)}`)
              }
            } else if (r.value.action === 'skipped' || r.value.action === 'incompatible') {
              br.skipped++
              result.totalSkipped++
            }
          } else {
            br.skipped++
          }
        }
      }

      result.totalFound += br.found
    } catch (err) {
      br.error = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`${board.name}: ${br.error}`)
    }
    result.boards.push(br)
    return br
  }

  // Process boards with limited concurrency (2 at a time)
  const BOARD_CONCURRENCY = 2
  for (let i = 0; i < BOARDS.length; i += BOARD_CONCURRENCY) {
    const chunk = BOARDS.slice(i, i + BOARD_CONCURRENCY)
    await Promise.allSettled(chunk.map(board => processBoard(board)))
  }

  return result
}
