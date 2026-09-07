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
  // L&A cap raised from 2 → 3: each entry is now a single line
  // (see enforceLeadershipOneLine), so three one-line entries take
  // comparable vertical space to the prior 2-entry multi-line format.
  leadershipEntries: 3,
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
  max?: number
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
  let leadershipDroppingEntry = false
  let skillsLinesKept = 0
  let educationLinesKept = 0

  let droppedExpEntries = 0
  let droppedBullets = 0
  let droppedLeadership = 0
  let droppedSkills = 0
  let droppedEducation = 0

  const isBulletStart = (s: string) => /^[•\-*\d+.)\]]/.test(s)

  for (const raw of lines) {
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
      // The L&A one-line cull is handled by enforceLeadershipOneLine,
      // which we run as a second pass below. For the in-line ceiling
      // pass, we just keep the section content as-is; the second pass
      // will trim it.
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

  // Re-scope the L&A section to one line per entry. The first pass
  // walked the document for section-level ceilings; this pass trims
  // each L&A entry to its title line and caps the entry count.
  return enforceLeadershipOneLine(out.join('\n'), opts)
}

// L&A one-line cull. Scopes to the Leadership section (any of the
// header keys in LEADERSHIP_KEYS) and:
//   1. Keeps only the first non-blank, non-bullet line of each entry
//      (a "title line"). Drops sub-bullets and wrapped continuation
//      lines that follow.
//   2. Caps the total kept entries at `max` (default 3).
//
// "Entry" is delimited by a blank line or the next section header.
// The rest of the document is passed through unchanged.
export function enforceLeadershipOneLine(
  markdown: string,
  opts: CullOptions = {}
): string {
  const log = opts.log ?? ((msg: string) => console.info(`[cv] ${msg}`))
  const max = opts.max ?? CEILINGS.leadershipEntries
  const lines = markdown.split('\n')
  const out: string[] = []
  let currentSection: string | null = null
  let inLeadership = false
  let entriesKept = 0
  let titleLineSeen = false
  let dropping = false
  let droppedContinuation = 0
  let droppedEntries = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (isHeader(trimmed)) {
      // If we were dropping an over-cap entry, count it now.
      if (inLeadership && dropping) {
        droppedEntries++
        dropping = false
      }
      currentSection = whichKey(trimmed)
      inLeadership = currentSection === 'leadership'
      titleLineSeen = false
      out.push(raw)
      continue
    }

    if (!inLeadership) {
      out.push(raw)
      continue
    }

    // Inside the L&A section.
    if (trimmed === '') {
      // Blank line ends the current entry.
      if (dropping) {
        droppedEntries++
        dropping = false
      }
      titleLineSeen = false
      out.push(raw)
      continue
    }

    // A `*` is a bullet only when followed by whitespace, not another
    // `*` (which would be the start of a `**bold**` title line). This
    // matches the L&A title format: `**Title**, Org<tab>Year`.
    const isBullet = /^([•-]|\*\s|\d+[.)])/.test(trimmed)

    if (!titleLineSeen) {
      // We're at the start of a new entry. Title line is the first
      // non-blank, non-bullet line. A bullet at entry start is
      // treated as a continuation of a prior dropped entry and is
      // dropped along with the entry.
      if (isBullet) {
        // A bullet at start of an entry means this is a bullet-only
        // entry or an artifact — drop the whole entry.
        dropping = true
        droppedContinuation++
        continue
      }
      if (entriesKept >= max) {
        dropping = true
        continue
      }
      entriesKept++
      titleLineSeen = true
      out.push(raw)
      continue
    }

    // We saw the title line of an entry already. Anything that
    // follows in the same entry (a bullet or a wrapped prose line)
    // is dropped as a continuation.
    //
    // Exception: if the next non-bullet line LOOKS LIKE another
    // title line (i.e. a bold-prefixed line), treat it as a new
    // entry, not a continuation. The LLM may produce entries back-
    // to-back with no blank line between them; the spec's entry
    // delimiter is "a blank line OR the next bold-prefixed title
    // line," not just a blank line.
    if (!isBullet && trimmed.startsWith('**')) {
      // New entry begins here. If we were dropping a prior over-cap
      // entry, count it now.
      if (dropping) {
        droppedEntries++
        dropping = false
      }
      if (entriesKept >= max) {
        titleLineSeen = true
        dropping = true
        continue
      }
      entriesKept++
      titleLineSeen = true
      out.push(raw)
      continue
    }

    // Past the title line of an entry — everything else in this
    // entry (bullets and wrapped prose) is dropped.
    dropping = true
    droppedContinuation++
  }

  if (inLeadership && dropping) droppedEntries++

  if (droppedEntries > 0 || droppedContinuation > 0) {
    const parts: string[] = []
    if (droppedEntries > 0) {
      parts.push(`entries ${entriesKept + droppedEntries}→${entriesKept}`)
    }
    if (droppedContinuation > 0) {
      parts.push(`continuation ${droppedContinuation}`)
    }
    log(`leadership cull: ${parts.join(', ')}`)
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
