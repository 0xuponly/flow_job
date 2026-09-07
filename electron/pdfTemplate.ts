import { enforceAllCvCeilings, enforceParagraphCeilings } from '../src/documentRules'
import * as db from './database'

const sectionHeaders = new Set([
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

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
}

function isHeader(s: string): boolean {
  const cleaned = stripMarkdown(s).toLowerCase().trim()
  return sectionHeaders.has(cleaned) || (/^[a-z\s&]+$/.test(cleaned) && sectionHeaders.has(cleaned.replace(/[^a-z\s&]/g, '').trim()))
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const bulletVerbs = /^(accomplished|achieved|led|managed|developed|created|implemented|designed|built|launched|delivered|improved|reduced|increased|generated|established|negotiated|coordinated|directed|spearheaded|introduced|optimized|transformed|piloted|engineered|produced|executed|authored|published|presented|mentored|trained|recruited|hired|fostered|cultivated|prepared|conducted|analyzed|analysed|evaluated|assessed|facilitated|collaborated|organized|supervised|overhauled|streamlined|consolidated|architected|championed|drove|drafted|formulated|identified|integrated|maintained|monitored|performed|pioneered|promoted|recommended|scheduled|secured|solved|standardized|strengthened|taught|wrote)/i
const noBulletSections = new Set(['skills & interests', 'skills and interests', 'skills', 'interests', 'certifications', 'languages', 'additional information', 'additional'])

function splitTab(label: string, rest: string): [string, string] {
  return [label.replace(/^\*+|\*+$/g, '').trim(), rest.trim()]
}

// Detect right-aligned suffix separated by 3+ spaces:
//   "Title    Month Year – Month Year"   (date range)
//   "Org      City, State"               (location)
// Location side: "City, ST" or "City, ST Zip" or "City, Country"
const dateRangeRe = /\s{3,}\b([A-Z][a-z]+\.?\s+\d{4}\s*[–\-—]+\s*(?:[A-Z][a-z]+\.?\s+\d{4}|Present)|[A-Z][a-z]+\.?\s+\d{4})\b$/
const locationSuffixRe = /\s{3,}\b([A-Z][^,]{2,30},\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s+\d{5})?)$/

// Looser date-range check (any whitespace run) used for next-line lookahead.
const dateRangeAnyRe = /\b([A-Z][a-z]+\.?\s+\d{4}\s*[–\-—]+\s*(?:[A-Z][a-z]+\.?\s+\d{4}|Present)|[A-Z][a-z]+\.?\s+\d{4})\b\s*$/
// Loose location suffix on an org line (single space ok): "Org City, ST" / "Org City, Country"
const orgLocationLooseRe = /,\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s+\d{5})?$/

function noopLog() {
  // intentionally empty — silences culling trace logs during PDF export
}

// Cover letters are plain text with a paragraph cap; CVs use the
// Harvard-format ceiling helper. Both run before the markdown parser.
//
// The culling helpers' trace lines default to console.info and would
// print to the terminal during every PDF export. Silence them by
// default; FLOW_JOB_VERBOSE=1 restores the original console output.
function applyDocumentRules(raw: string, kind: string, jobDesc: string): string {
  const log = process.env.FLOW_JOB_VERBOSE ? undefined : noopLog
  if (kind === 'cover_letter') {
    return enforceParagraphCeilings(raw, { max: 4, log })
  }
  return enforceAllCvCeilings(raw, { jobDescription: jobDesc, log })
}

function splitLineHtml(left: string, right: string): string {
  // Flexbox keeps the DOM reading order left-to-right while visually
  // pushing the right side to the margin. This is safer for ATS text
  // extraction than float:right, which can reverse the perceived order.
  return `<div class="split-line"><span class="left">${esc(left)}</span><span class="right">${esc(right)}</span></div>\n`
}

function bulletHtml(text: string): string {
  // Embed the bullet character directly so the text layer is intact even
  // if a CSS parser strips the ::before pseudo-element.
  return `<div class="bullet"><span class="bullet-marker">• </span>${esc(text)}</div>\n`
}

function sectionHeaderHtml(text: string): string {
  // Semantic heading improves ATS parseability and accessibility.
  return `<h2 class="section-header">${esc(text)}</h2>\n`
}

function bodyLineHtml(text: string): string {
  return `<div class="body-line">${esc(text)}</div>\n`
}

export function buildPdfHtml(content: string, docType: string, documentId: number | null, scale: number): string {
  let jobDescription = ''
  if (documentId !== null && documentId !== undefined) {
    const docRow = db.getDocument(documentId)
    if (docRow?.job_id) {
      const jobRow = db.getJob(docRow.job_id)
      if (jobRow) jobDescription = jobRow.description ?? ''
    }
  }

  const isCoverLetter = docType === 'cover_letter'
  const culled = applyDocumentRules(content, docType ?? 'cv', jobDescription)
  const lines = culled.split('\n')
  let htmlBody = ''
  let headerCollected = false
  const headerLines: string[] = []
  let noBulletSection = false
  let inParagraph = false

  function closeParagraph() {
    if (inParagraph) {
      htmlBody += '</p>\n'
      inParagraph = false
    }
  }

  function openParagraph() {
    if (!inParagraph) {
      htmlBody += '<p class="body-paragraph">'
      inParagraph = true
    } else {
      htmlBody += ' '
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const cleaned = stripMarkdown(trimmed).trim()
    if (!cleaned) {
      closeParagraph()
      htmlBody += '<div class="spacer"></div>\n'
      continue
    }

    const sect = isHeader(trimmed)
    const hasTab = cleaned.includes('\t')
    const hasMultiSpace = dateRangeRe.test(cleaned) || locationSuffixRe.test(cleaned)
    const isBullet = /^([•-]|\*\s|\d+[.)])/.test(cleaned) || bulletVerbs.test(cleaned)

    // Look-ahead: next non-empty line looks like a date range? Then current is an org line.
    let nextClean = ''
    for (let j = i + 1; j < lines.length && j < i + 4; j++) {
      const nc = stripMarkdown(lines[j].trim()).trim()
      if (!nc) continue
      nextClean = nc
      break
    }
    const nextIsDateLine = nextClean && (dateRangeRe.test(nextClean) || dateRangeAnyRe.test(nextClean))
    const looksLikeOrgLine = !hasTab && !hasMultiSpace && !isBullet && Boolean(nextIsDateLine) && orgLocationLooseRe.test(cleaned)
    const looksLikeTitleLine = !hasTab && !hasMultiSpace && !isBullet && dateRangeAnyRe.test(cleaned) && cleaned !== nextClean

    if (sect) {
      closeParagraph()
      const lower = stripMarkdown(trimmed).toLowerCase().trim()
      noBulletSection = noBulletSections.has(lower)
      if (!headerCollected) headerCollected = true
      htmlBody += sectionHeaderHtml(cleaned)
      continue
    }

    if (!headerCollected) {
      // Cover-letter salutations and dates should not be absorbed into the
      // contact header; cap the header at two lines for cover letters.
      const looksLikeSalutation = /^dear\b/i.test(cleaned)
      const looksLikeDate = /^\w+\s+\d{1,2},?\s+\d{4}$/i.test(cleaned)
      const headerCap = isCoverLetter ? 2 : 3
      if (isBullet || looksLikeSalutation || looksLikeDate) {
        headerCollected = true
      } else if (headerLines.length < headerCap) {
        headerLines.push(cleaned)
        continue
      } else {
        headerCollected = true
      }
    }

    if (isBullet) {
      closeParagraph()
      const text = cleaned.replace(/^[•\-*\d.()\]\s]+/, '')
      htmlBody += bulletHtml(text)
      continue
    }

    if (hasTab) {
      closeParagraph()
      const parts = cleaned.split('\t')
      const [label, rest] = splitTab(parts[0], parts.slice(1).join(' '))
      htmlBody += splitLineHtml(label, rest)
    } else if (hasMultiSpace) {
      closeParagraph()
      const m = cleaned.match(dateRangeRe) || cleaned.match(locationSuffixRe)!
      const label = cleaned.slice(0, m.index).replace(/^\*+|\*+$/g, '').trim()
      const rest = cleaned.slice(m.index).replace(/^\s+/, '').trim()
      htmlBody += splitLineHtml(label, rest)
    } else if (looksLikeOrgLine) {
      closeParagraph()
      // Split off location suffix (last ", XX" chunk) as the right-aligned side.
      const m = cleaned.match(orgLocationLooseRe)!
      const label = cleaned.slice(0, m.index).replace(/,\s*$/, '').trim()
      const rest = cleaned.slice(m.index).replace(/^,\s*/, '').trim()
      htmlBody += splitLineHtml(label, rest)
    } else if (looksLikeTitleLine) {
      closeParagraph()
      // Title line with embedded date range (no wide gap, no tab). Split at date start.
      const m = cleaned.match(dateRangeAnyRe)!
      const label = cleaned.slice(0, m.index).replace(/,\s*$/, '').trim()
      const rest = cleaned.slice(m.index).trim()
      htmlBody += splitLineHtml(label, rest)
    } else if (cleaned.includes('|') && cleaned.length < 120) {
      closeParagraph()
      const parts = cleaned.split('|').map(s => s.replace(/^\*+|\*+$/g, '').trim())
      htmlBody += splitLineHtml(parts[0], parts.slice(1).join(' | '))
    } else if (noBulletSection) {
      closeParagraph()
      htmlBody += bodyLineHtml(cleaned)
    } else if (isCoverLetter) {
      openParagraph()
      htmlBody += esc(cleaned)
    } else {
      closeParagraph()
      htmlBody += bulletHtml(cleaned)
    }
  }

  closeParagraph()

  const headerHtml = headerLines.length > 0
    ? `<header class="header">${headerLines.map((l, j) => j === 0 ? `<h1 class="name">${esc(l)}</h1>` : `<div class="contact">${esc(l)}</div>`).join('\n')}</header>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><style>
  @page { margin: 0.6in 0.7in; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Calibri, 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.2; color: #000; }
  .header { text-align: center; margin-bottom: 10px; }
  .name { font-size: 12pt; font-weight: bold; }
  .contact { font-size: 10pt; color: #222; }
  .section-header { text-align: center; font-weight: bold; font-size: 11pt; margin-top: 12px; margin-bottom: 3px; }
  .split-line { display: flex; justify-content: space-between; margin-bottom: 1px; }
  .split-line .left { font-weight: bold; }
  .split-line .right { text-align: right; }
  .bullet { display: flex; margin-bottom: 1px; padding-left: 10px; }
  .bullet-marker { flex-shrink: 0; width: 10px; }
  .body-line { margin-bottom: 1px; }
  .body-paragraph { margin-bottom: 6px; }
  .spacer { height: 6px; }
  .scale-wrapper { transform: scale(${scale}); transform-origin: top left; width: ${(100 / scale).toFixed(4)}%; }
</style></head>
<body>
<div class="scale-wrapper">
${headerHtml}
${htmlBody}
</div>
</body>
</html>`
}
