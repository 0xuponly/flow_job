import { describe, it, expect, vi } from 'vitest'
import {
  paragraphCount,
  enforceParagraphCeilings,
  extractJobKeywords,
  coverageFor,
  missingKeywords,
  skillCount,
  runDocumentRuleChecks,
  selectTechnicalSkills,
  enforceSkillsCeilings,
  enforceAllCvCeilings
} from './documentRules'

describe('paragraphCount', () => {
  it('returns 0 for empty text', () => {
    expect(paragraphCount('')).toBe(0)
  })
  it('returns 1 for a single paragraph', () => {
    expect(paragraphCount('Hello world.')).toBe(1)
  })
  it('returns 4 for 4 paragraphs separated by blank lines', () => {
    const text = 'Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.'
    expect(paragraphCount(text)).toBe(4)
  })
  it('does not split on single newlines', () => {
    const text = 'Line 1.\nLine 2.\nLine 3.'
    expect(paragraphCount(text)).toBe(1)
  })
  it('ignores empty paragraphs between blank lines', () => {
    const text = 'Para 1.\n\n\n\nPara 2.'
    expect(paragraphCount(text)).toBe(2)
  })
})

describe('enforceParagraphCeilings', () => {
  it('returns text unchanged when under max', () => {
    const text = 'A.\n\nB.\n\nC.'
    expect(enforceParagraphCeilings(text)).toBe(text)
  })
  it('keeps exactly max paragraphs', () => {
    const text = 'A.\n\nB.\n\nC.\n\nD.'
    expect(enforceParagraphCeilings(text, { max: 4 })).toBe(text)
  })
  it('drops trailing paragraphs past max (default 4)', () => {
    const text = 'A.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.'
    const out = enforceParagraphCeilings(text)
    expect(out).toBe('A.\n\nB.\n\nC.\n\nD.')
  })
  it('respects a custom max', () => {
    const text = 'A.\n\nB.\n\nC.\n\nD.'
    const out = enforceParagraphCeilings(text, { max: 2 })
    expect(out).toBe('A.\n\nB.')
  })
  it('emits a log when culling occurs', () => {
    const log = vi.fn()
    const text = 'A.\n\nB.\n\nC.\n\nD.\n\nE.'
    enforceParagraphCeilings(text, { log })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/paragraph/))
  })
  it('does not log when nothing is culled', () => {
    const log = vi.fn()
    enforceParagraphCeilings('A.\n\nB.', { log })
    expect(log).not.toHaveBeenCalled()
  })
})

describe('extractJobKeywords', () => {
  it('returns tech keywords that appear at least twice', () => {
    const desc = 'We use React, TypeScript, and Node. Our team builds React apps with TypeScript on Node. AWS and Kubernetes run our infrastructure.'
    const kws = extractJobKeywords(desc)
    expect(kws).toContain('react')
    expect(kws).toContain('typescript')
    expect(kws).toContain('node')
  })
  it('filters stop words', () => {
    const desc = 'The the the and and with for to of in on at is are be as by this that we you our your their they will have has had from it.'
    const kws = extractJobKeywords(desc)
    expect(kws).toEqual([])
  })
  it('keeps single-occurrence tech keywords in the allowlist', () => {
    const desc = 'Looking for a Python developer with AWS experience.'
    const kws = extractJobKeywords(desc)
    expect(kws).toContain('python')
    expect(kws).toContain('aws')
  })
  it('drops tokens shorter than 3 chars', () => {
    const desc = 'a b c to of in on.'
    expect(extractJobKeywords(desc)).toEqual([])
  })
  it('caps at 30 keywords', () => {
    const words = Array.from({ length: 60 }, (_, i) => `keyword${i}`).join(' ')
    const kws = extractJobKeywords(words)
    expect(kws.length).toBeLessThanOrEqual(30)
  })
  it('returns lowercase tokens', () => {
    const desc = 'React React React TypeScript TypeScript Python.'
    const kws = extractJobKeywords(desc)
    for (const k of kws) expect(k).toBe(k.toLowerCase())
  })
})

describe('coverageFor', () => {
  it('returns 0 for empty keywords', () => {
    expect(coverageFor('any document', [])).toBe(0)
  })
  it('returns 1 when all keywords are present', () => {
    expect(coverageFor('react typescript python', ['react', 'typescript', 'python'])).toBe(1)
  })
  it('returns the fraction present', () => {
    expect(coverageFor('react and typescript', ['react', 'typescript', 'python'])).toBeCloseTo(2 / 3)
  })
  it('is case-insensitive', () => {
    expect(coverageFor('React and TypeScript', ['react', 'typescript'])).toBe(1)
  })
  it('matches on word boundaries, not substrings', () => {
    // "go" should not match "google"
    expect(coverageFor('we use google cloud', ['go'])).toBe(0)
  })
})

describe('missingKeywords', () => {
  it('returns the keywords not present in the document', () => {
    expect(missingKeywords('react and typescript', ['react', 'typescript', 'python'])).toEqual(['python'])
  })
  it('returns empty array when all present', () => {
    expect(missingKeywords('react typescript python', ['react', 'typescript', 'python'])).toEqual([])
  })
})

describe('skillCount', () => {
  it('returns 0 for a document with no Skills section', () => {
    expect(skillCount('Name\nemail\n\nExperience\nRole A\n')).toBe(0)
  })
  it('counts skills across all labels in the Skills section', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b, c\nLanguage: x, y\nInterests: foo, bar\n'
    expect(skillCount(md)).toBe(7)
  })
  it('stops counting at the next section', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b\n\nEXPERIENCE\nRole A\n- bullet\n- bullet\n'
    expect(skillCount(md)).toBe(2)
  })
})

describe('runDocumentRuleChecks', () => {
  it('returns four rule checks for a CV', () => {
    const doc = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b, c, d, e\n\nEXPERIENCE\nRole A\n- bullet\n'
    const job = 'We use React, TypeScript, Node. Our team builds React apps with TypeScript on Node. Looking for 5+ years experience with JavaScript, Python, and AWS.'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: job, docType: 'cv' })
    expect(rules).toHaveLength(4)
    expect(rules.map(r => r.rule).sort()).toEqual(['keyword_coverage', 'one_page', 'paragraph_count', 'skills_count'])
  })
  it('marks skills_count failed when under 5', () => {
    const doc = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b\n\nEXPERIENCE\nRole A\n'
    const job = 'React TypeScript Node Python JavaScript AWS Kubernetes Docker GraphQL'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: job, docType: 'cv' })
    const sc = rules.find(r => r.rule === 'skills_count')!
    expect(sc.passed).toBe(false)
  })
  it('marks skills_count failed when over 15', () => {
    const skills = Array.from({ length: 20 }, (_, i) => `s${i}`).join(', ')
    const doc = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${skills}\n\nEXPERIENCE\nRole A\n`
    const job = 'React TypeScript Node Python JavaScript AWS Kubernetes Docker GraphQL'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: job, docType: 'cv' })
    const sc = rules.find(r => r.rule === 'skills_count')!
    expect(sc.passed).toBe(false)
  })
  it('marks paragraph_count n/a for CV', () => {
    const doc = 'Name\nemail\n\nEXPERIENCE\nRole A\n'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: 'job', docType: 'cv' })
    const pc = rules.find(r => r.rule === 'paragraph_count')!
    expect(pc.passed).toBe(true)
    expect(pc.detail).toMatch(/n\/a/)
  })
  it('marks paragraph_count failed for cover letter over 4', () => {
    const doc = 'A.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: 'job', docType: 'cover_letter' })
    const pc = rules.find(r => r.rule === 'paragraph_count')!
    expect(pc.passed).toBe(false)
  })
  it('marks skills_count n/a for cover letter', () => {
    const doc = 'A.\n\nB.\n\nC.\n\nD.'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: 'job', docType: 'cover_letter' })
    const sc = rules.find(r => r.rule === 'skills_count')!
    expect(sc.passed).toBe(true)
    expect(sc.detail).toMatch(/n\/a/)
  })
  it('marks keyword_coverage failed when document misses the threshold', () => {
    const doc = 'A completely generic letter that mentions nothing technical.'
    const job = 'React TypeScript Node Python JavaScript AWS Kubernetes Docker GraphQL Postgres Redis Kafka Terraform Helm ArgoCD Prometheus Grafana'
    const rules = runDocumentRuleChecks({ document: doc, jobDescription: job, docType: 'cover_letter' })
    const kc = rules.find(r => r.rule === 'keyword_coverage')!
    expect(kc.passed).toBe(false)
    expect(kc.detail).toMatch(/missing/i)
  })
  it('marks one_page as estimated (not a hard pass) for both doc types', () => {
    const doc = 'Name\nemail\n\nEXPERIENCE\nRole A\n'
    const cvRules = runDocumentRuleChecks({ document: doc, jobDescription: 'job', docType: 'cv' })
    const clRules = runDocumentRuleChecks({ document: doc, jobDescription: 'job', docType: 'cover_letter' })
    const cvOne = cvRules.find(r => r.rule === 'one_page')!
    const clOne = clRules.find(r => r.rule === 'one_page')!
    expect(cvOne.detail).toMatch(/estimated/i)
    expect(clOne.detail).toMatch(/estimated/i)
    expect(cvOne.passed).toBe(true)
    expect(clOne.passed).toBe(true)
  })
})

describe('selectTechnicalSkills', () => {
  it('returns all values when under the cap', () => {
    const r = selectTechnicalSkills({ values: ['React', 'TypeScript'], keywords: ['react'] })
    expect(r.kept).toEqual(['React', 'TypeScript'])
    expect(r.dropped).toEqual([])
  })
  it('returns all values when between min and max', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const r = selectTechnicalSkills({ values, keywords: [] })
    expect(r.kept).toEqual(values)
    expect(r.dropped).toEqual([])
  })
  it('returns all values when at the cap exactly', () => {
    const values = Array.from({ length: 15 }, (_, i) => `s${i}`)
    const r = selectTechnicalSkills({ values, keywords: [] })
    expect(r.kept).toHaveLength(15)
    expect(r.dropped).toEqual([])
  })
  it('keeps top 15 by keyword match when over the cap', () => {
    const values = ['Python', 'React', 'Java', 'Go', 'Rust', 'Ruby', 'PHP', 'C++', 'Scala', 'Elixir', 'Clojure', 'Haskell', 'Swift', 'Kotlin', 'Dart', 'Lua', 'Perl', 'R', 'MATLAB', 'Groovy']
    const keywords = ['react', 'python', 'rust', 'go', 'kotlin']
    const r = selectTechnicalSkills({ values, keywords })
    expect(r.kept).toHaveLength(15)
    // All 5 keyword-matched values must be in kept (ranking check).
    expect(r.kept).toEqual(expect.arrayContaining(['Python', 'React', 'Go', 'Rust', 'Kotlin']))
    // 5 dropped
    expect(r.dropped).toHaveLength(5)
  })
  it('deduplicates case-insensitively before scoring', () => {
    const values = ['React', 'react', 'REACT', 'TypeScript']
    const r = selectTechnicalSkills({ values, keywords: ['react'] })
    expect(r.kept).toEqual(['React', 'TypeScript'])
  })
  it('uses stable original order for ties (empty keywords)', () => {
    const values = ['c', 'a', 'b']
    const r = selectTechnicalSkills({ values, keywords: [] })
    expect(r.kept).toEqual(['c', 'a', 'b'])
  })
  it('respects a custom min', () => {
    // values.length < min → keep all (sparse is correct)
    const r = selectTechnicalSkills({ values: ['a', 'b'], keywords: [], min: 5, max: 15 })
    expect(r.kept).toEqual(['a', 'b'])
    expect(r.dropped).toEqual([])
  })
  it('respects a custom max', () => {
    const values = ['a', 'b', 'c', 'd', 'e']
    const r = selectTechnicalSkills({ values, keywords: [], min: 1, max: 3 })
    expect(r.kept).toEqual(['a', 'b', 'c'])
    expect(r.dropped).toEqual(['d', 'e'])
  })
  it('handles empty values', () => {
    const r = selectTechnicalSkills({ values: [], keywords: ['react'] })
    expect(r.kept).toEqual([])
    expect(r.dropped).toEqual([])
  })
})

describe('enforceSkillsCeilings', () => {
  it('returns markdown unchanged when there is no Skills section', () => {
    const md = 'Name\nemail@example.com\n\nEXPERIENCE\nRole A\n- bullet\n'
    expect(enforceSkillsCeilings(md, 'React TypeScript Node')).toBe(md)
  })
  it('preserves the Language label verbatim', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: a, b, c, d, e, f\nLanguage: English, French\nLaboratory: pcr, western blot\n'
    const out = enforceSkillsCeilings(md, 'react typescript')
    expect(out).toMatch(/Language: English, French/)
  })
  it('drops Laboratory, Interests, and other non-Technical/Language labels', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: React, TypeScript\nLanguage: English\nLaboratory: pcr\nInterests: hiking\n'
    const out = enforceSkillsCeilings(md, 'react')
    expect(out).not.toMatch(/Laboratory/)
    expect(out).not.toMatch(/Interests/)
    expect(out).not.toMatch(/pcr/)
    expect(out).not.toMatch(/hiking/)
  })
  it('caps Technical at 15 by keyword match', () => {
    const tech = Array.from({ length: 20 }, (_, i) => `skill${i}`).join(', ')
    const md = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${tech}\nLanguage: English\n`
    const out = enforceSkillsCeilings(md, 'skill0 skill1 skill2')
    const techLine = out.split('\n').find((l) => l.startsWith('Technical:'))!
    const kept = techLine.replace('Technical:', '').split(',').map((s) => s.trim())
    expect(kept).toHaveLength(15)
  })
  it('keeps all Technical values when under the cap', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: React, TypeScript, Node\nLanguage: English\n'
    const out = enforceSkillsCeilings(md, 'react typescript node')
    expect(out).toMatch(/Technical: React, TypeScript, Node/)
  })
  it('preserves the Skills section header and its position', () => {
    const md = 'Name\nemail\n\nEXPERIENCE\nRole A\n- bullet\n\nSKILLS & INTERESTS\nTechnical: React\nLanguage: English\n\nEDUCATION\nSchool\n'
    const out = enforceSkillsCeilings(md, 'react')
    const skillsIdx = out.indexOf('SKILLS & INTERESTS')
    const expIdx = out.indexOf('EXPERIENCE')
    const eduIdx = out.indexOf('EDUCATION')
    expect(skillsIdx).toBeGreaterThan(expIdx)
    expect(skillsIdx).toBeLessThan(eduIdx)
  })
  it('emits a log when culling occurs', () => {
    const log = vi.fn()
    const tech = Array.from({ length: 20 }, (_, i) => `s${i}`).join(', ')
    const md = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${tech}\nLaboratory: pcr\n`
    enforceSkillsCeilings(md, 's0 s1', { log })
    expect(log).toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toMatch(/skills cull/)
  })
  it('does not log when nothing is culled', () => {
    const log = vi.fn()
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: React\nLanguage: English\n'
    enforceSkillsCeilings(md, 'react', { log })
    expect(log).not.toHaveBeenCalled()
  })
  it('emits no Technical line if the original had no Technical label', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nLanguage: English\n'
    const out = enforceSkillsCeilings(md, 'react')
    expect(out).not.toMatch(/Technical:/)
    expect(out).toMatch(/Language: English/)
  })
})

describe('enforceAllCvCeilings', () => {
  it('composes the skills cull and the ceiling cull', () => {
    const exp = (n: number) => `Role ${n}\tCity, ST\nTitle ${n}\tJan 2024 – Present\n- bullet\n`
    const tech = Array.from({ length: 20 }, (_, i) => `s${i}`).join(', ')
    const md = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${tech}\nLanguage: English\n\nEXPERIENCE\n${exp(1)}${exp(2)}${exp(3)}${exp(4)}${exp(5)}${exp(6)}${exp(7)}\n`
    const out = enforceAllCvCeilings(md, { jobDescription: 's0 s1' })
    // Skills capped at 15
    const techLine = out.split('\n').find((l) => l.startsWith('Technical:'))!
    const kept = techLine.replace('Technical:', '').split(',').map((s) => s.trim())
    expect(kept).toHaveLength(15)
    // Experience capped at 4 (only Roles 1-4)
    expect(out).toMatch(/Role 1\b/)
    expect(out).toMatch(/Role 4\b/)
    expect(out).not.toMatch(/Role 5\b/)
  })
  it('handles empty jobDescription without crashing', () => {
    const md = 'Name\nemail\n\nSKILLS & INTERESTS\nTechnical: React, TypeScript\nLanguage: English\n'
    const out = enforceAllCvCeilings(md, { jobDescription: '' })
    expect(out).toMatch(/Technical: React, TypeScript/)
  })
})
