// Pure helpers for the one-page CV rule. No Electron imports — this file
// is loaded directly by vitest. See .superpowers/specs/2026-07-19-one-page-cv-rule-design.md
// for the ceilings and the reasoning behind them.

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

const EXPERIENCE_KEYS = ['experience', 'professional experience', 'work experience', 'work history']
const LEADERSHIP_KEYS = ['leadership & activities', 'leadership and activities', 'leadership', 'activities']
const SKILLS_KEYS = ['skills & interests', 'skills and interests', 'skills', 'interests', 'technical skills', 'core competencies', 'competencies', 'qualifications']
const EDUCATION_KEYS = ['education']

const CEILINGS = {
  experienceEntries: 4,
  bulletsPerEntry: 4,
  leadershipEntries: 2,
  skillsLines: 6,
  // Education content lines: 4 lines max. The spec treats each line in
  // the Education section as a single line, not a school/degree pair.
  educationLines: 4
} as const

function normalize(s: string): string {
  return s.toLowerCase().replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
}

function isHeader(line: string): boolean {
  const n = normalize(line)
  if (SECTION_HEADERS.has(n)) return true
  // The renderer's isHeader() also matches a header line that is *just*
  // a-z + space + & with no digits/punctuation; we mirror that here.
  return /^[a-z\s&]+$/.test(n) && SECTION_HEADERS.has(n.replace(/[^a-z\s&]/g, '').trim())
}

function whichKey(line: string): string | null {
  const n = normalize(line)
  if (EXPERIENCE_KEYS.includes(n)) return 'experience'
  if (LEADERSHIP_KEYS.includes(n)) return 'leadership'
  if (SKILLS_KEYS.includes(n)) return 'skills'
  if (EDUCATION_KEYS.includes(n)) return 'education'
  return null
}

export interface CullOptions {
  log?: (msg: string) => void
}

export function enforceOnePageCeilings(markdown: string, opts: CullOptions = {}): string {
  const log = opts.log ?? ((msg: string) => console.info(`[cv] ${msg}`))
  const lines = markdown.split('\n')
  const out: string[] = []

  let currentSection: string | null = null
  let expEntryBulletsKept = 0
  let expEntriesKept = 0
  let expLastWasBullet = false
  let expDroppingEntry = false
  let leadershipEntriesKept = 0
  let leadershipLastWasBullet = false
  let leadershipDroppingEntry = false
  let skillsLinesKept = 0
  let educationLinesKept = 0

  let droppedExpEntries = 0
  let droppedBullets = 0
  let droppedLeadership = 0
  let droppedSkills = 0
  let droppedEducation = 0

  const isBulletStart = (s: string) => /^[•\-*\d+.)\]]/.test(s)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (isHeader(trimmed)) {
      // Count any in-flight dropped entry as a final dropped entry when
      // we cross to a new section.
      if (expDroppingEntry) {
        droppedExpEntries++
        expDroppingEntry = false
      }
      if (leadershipDroppingEntry) {
        droppedLeadership++
        leadershipDroppingEntry = false
      }
      currentSection = whichKey(trimmed)
      expLastWasBullet = false
      expDroppingEntry = false
      leadershipLastWasBullet = false
      leadershipDroppingEntry = false
      out.push(raw)
      continue
    }

    // Blank line ends an entry inside Experience/Leadership.
    if (trimmed === '') {
      if (currentSection === 'experience') {
        if (expDroppingEntry) {
          droppedExpEntries++
          expDroppingEntry = false
        }
        expLastWasBullet = false
      }
      if (currentSection === 'leadership') {
        if (leadershipDroppingEntry) {
          droppedLeadership++
          leadershipDroppingEntry = false
        }
        leadershipLastWasBullet = false
      }
      out.push(raw)
      continue
    }

    if (currentSection === 'experience') {
      // If we're mid-drop, keep dropping the rest of the over-cap entry
      // until we see the first non-bullet line of the NEXT entry, at
      // which point we record one dropped entry, reset, and re-process
      // the current line as the next entry's start.
      if (expDroppingEntry) {
        const isNonBullet = !isBulletStart(trimmed)
        const isNextEntryStart = isNonBullet && (expLastWasBullet || expEntriesKept === 0)
        if (isNextEntryStart) {
          droppedExpEntries++
          expDroppingEntry = false
          // Re-process this line as a normal entry start.
        } else {
          if (isNonBullet) {
            // Title line of the entry currently being dropped.
            expLastWasBullet = false
          } else {
            // Bullet of the entry currently being dropped.
            droppedBullets++
            expLastWasBullet = true
          }
          continue
        }
      }

      if (!isBulletStart(trimmed)) {
        const isNewEntryStart = expLastWasBullet || expEntriesKept === 0
        if (isNewEntryStart) {
          if (expEntriesKept >= CEILINGS.experienceEntries) {
            expDroppingEntry = true
            expLastWasBullet = false
            continue
          }
          expEntriesKept++
          expEntryBulletsKept = 0
          expLastWasBullet = false
          out.push(raw)
          continue
        }
        out.push(raw)
        continue
      }
      if (expEntryBulletsKept >= CEILINGS.bulletsPerEntry) {
        droppedBullets++
        expLastWasBullet = true
        continue
      }
      expEntryBulletsKept++
      expLastWasBullet = true
      out.push(raw)
      continue
    }

    if (currentSection === 'leadership') {
      if (leadershipDroppingEntry) {
        const isNonBullet = !isBulletStart(trimmed)
        const isNextEntryStart = isNonBullet && (leadershipLastWasBullet || leadershipEntriesKept === 0)
        if (isNextEntryStart) {
          droppedLeadership++
          leadershipDroppingEntry = false
        } else {
          if (isNonBullet) {
            leadershipLastWasBullet = false
          } else {
            // Bullet of the entry currently being dropped; do not re-emit.
            leadershipLastWasBullet = true
          }
          continue
        }
      }

      if (!isBulletStart(trimmed)) {
        const isNewEntryStart = leadershipLastWasBullet || leadershipEntriesKept === 0
        if (isNewEntryStart) {
          if (leadershipEntriesKept >= CEILINGS.leadershipEntries) {
            leadershipDroppingEntry = true
            leadershipLastWasBullet = false
            continue
          }
          leadershipEntriesKept++
          leadershipLastWasBullet = false
          out.push(raw)
          continue
        }
        out.push(raw)
        continue
      }
      leadershipLastWasBullet = true
      out.push(raw)
      continue
    }

    if (currentSection === 'skills') {
      if (skillsLinesKept >= CEILINGS.skillsLines) {
        droppedSkills++
        continue
      }
      skillsLinesKept++
      out.push(raw)
      continue
    }

    if (currentSection === 'education') {
      if (educationLinesKept >= CEILINGS.educationLines) {
        droppedEducation++
        continue
      }
      educationLinesKept++
      out.push(raw)
      continue
    }

    out.push(raw)
  }

  // Any entry we were in the middle of dropping at end-of-input.
  if (expDroppingEntry) droppedExpEntries++
  if (leadershipDroppingEntry) droppedLeadership++

  const summary: string[] = []
  if (droppedExpEntries) summary.push(`experience ${droppedExpEntries + CEILINGS.experienceEntries}→${CEILINGS.experienceEntries}`)
  if (droppedBullets) summary.push(`bullets ${droppedBullets}`)
  if (droppedLeadership) summary.push(`leadership ${droppedLeadership + CEILINGS.leadershipEntries}→${CEILINGS.leadershipEntries}`)
  if (droppedSkills) summary.push(`skills ${droppedSkills + CEILINGS.skillsLines}→${CEILINGS.skillsLines}`)
  if (droppedEducation) summary.push(`education ${droppedEducation + CEILINGS.educationLines}→${CEILINGS.educationLines}`)
  if (summary.length > 0) {
    log(`cull: ${summary.join(', ')}`)
  }

  return out.join('\n')
}

// Counts pages in a PDF 1.4 buffer produced by Electron's printToPDF.
// Matches `/Type /Page` and excludes `/Type /Pages` (the tree root).
// Returns 1 on no match (the PDF we produce is always at least one page;
// the worst case of "regex misses" is that we skip the shrink-to-fit
// retry, which matches the pre-feature behavior).
export function countPdfPages(buf: Buffer): number {
  const text = buf.toString('binary')
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches ? matches.length : 1
}
