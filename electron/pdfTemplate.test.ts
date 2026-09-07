import { describe, it, expect, vi } from 'vitest'
import { buildPdfHtml } from './pdfTemplate'

vi.mock('./database', () => ({
  getDocument: vi.fn(() => null),
  getJob: vi.fn(() => null),
}))

function cvContent() {
  return [
    'Jane Doe',
    'jane@example.com • (555) 123-4567',
    '',
    'EDUCATION',
    'University of Example\tBoston, MA',
    'B.S. Computer Science\tMay 2020',
    '',
    'EXPERIENCE',
    'Acme Corp\tSan Francisco, CA',
    'Software Engineer\tJan 2021 – Present',
    '- Built a TypeScript service handling 1M requests/day',
    '- Improved CI pipeline reducing build times by 30%',
    '',
    'SKILLS & INTERESTS',
    'Technical: TypeScript, React, Node.js, Python',
    'Language: English, Spanish',
  ].join('\n')
}

function coverLetterContent() {
  return [
    'Jane Doe',
    'jane@example.com',
    '',
    'Dear Hiring Manager,',
    '',
    'I am excited to apply for the Software Engineer role at Acme Corp.',
    '',
    'Best,',
    'Jane Doe',
  ].join('\n')
}

describe('buildPdfHtml', () => {
  it('renders section headers as semantic h2 elements for a CV', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    expect(html).toMatch(/<h2 class="section-header">EDUCATION<\/h2>/)
    expect(html).toMatch(/<h2 class="section-header">EXPERIENCE<\/h2>/)
    expect(html).toMatch(/<h2 class="section-header">SKILLS &amp; INTERESTS<\/h2>/)
  })

  it('renders contact info in a parseable header', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    expect(html).toMatch(/<header class="header">/)
    expect(html).toMatch(/<h1 class="name">Jane Doe<\/h1>/)
    expect(html).toMatch(/<div class="contact">jane@example\.com/)
  })

  it('uses flexbox split lines with left-to-right DOM order', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    // No float-based right alignment.
    expect(html).not.toMatch(/float:\s*right/)
    // Flexbox is used instead.
    expect(html).toMatch(/display:\s*flex/)
    // Each split line has left span followed by right span in the DOM.
    expect(html).toMatch(/<div class="split-line"><span class="left">University of Example<\/span><span class="right">Boston, MA<\/span><\/div>/)
  })

  it('embeds real bullet markers in the text layer', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    expect(html).toMatch(/<span class="bullet-marker">• <\/span>/)
    expect(html).toMatch(/<span class="bullet-marker">• <\/span>Built a TypeScript service/)
  })

  it('wraps cover letter body lines in paragraph tags', () => {
    const html = buildPdfHtml(coverLetterContent(), 'cover_letter', null, 1)
    expect(html).toMatch(/<p class="body-paragraph">Dear Hiring Manager,<\/p>/)
    expect(html).toMatch(/<p class="body-paragraph">I am excited to apply/)
    expect(html).toMatch(/<p class="body-paragraph">Best,\s*Jane Doe<\/p>/)
  })

  it('does not use table layouts', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    expect(html).not.toMatch(/<table\b/i)
    expect(html).not.toMatch(/<td\b/i)
    expect(html).not.toMatch(/<tr\b/i)
  })

  it('keeps single-column layout', () => {
    const html = buildPdfHtml(cvContent(), 'cv', null, 1)
    expect(html).not.toMatch(/column-count/)
    expect(html).not.toMatch(/display:\s*grid/)
  })

  it('auto-culls a CV that exceeds one-page ceilings', () => {
    const exp = (n: number) => `Company ${n}\tCity, ST\nRole ${n}\tJan 2024 – Present\n- bullet\n`
    const oversized = `Name\nemail\n\nEXPERIENCE\n${exp(1)}${exp(2)}${exp(3)}${exp(4)}${exp(5)}${exp(6)}\n`
    const html = buildPdfHtml(oversized, 'cv', null, 1)
    expect(html).toMatch(/Role 1/)
    expect(html).toMatch(/Role 4/)
    expect(html).not.toMatch(/Role 5/)
    expect(html).not.toMatch(/Role 6/)
  })

  it('auto-culls a cover letter that exceeds 4 paragraphs', () => {
    const oversized = 'A.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.'
    const html = buildPdfHtml(oversized, 'cover_letter', null, 1)
    expect(html).toMatch(/>A\./)
    expect(html).toMatch(/>D\./)
    expect(html).not.toMatch(/>E\./)
    expect(html).not.toMatch(/>F\./)
  })
})
