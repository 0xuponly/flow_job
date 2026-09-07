import { describe, expect, it } from 'vitest'
import {
  extractEducationLevel,
  extractRoleTitles,
  extractTechnicalTerms,
  extractYearsExperience,
  scoreCompatibility,
  scoreCompatibilityStructured
} from './fitHeuristic'

describe('fitHeuristic', () => {
  describe('extractTechnicalTerms', () => {
    it('finds known technical skills', () => {
      const terms = extractTechnicalTerms('Looking for React, TypeScript, AWS, and Kubernetes')
      expect(terms.has('react')).toBe(true)
      expect(terms.has('typescript')).toBe(true)
      expect(terms.has('aws')).toBe(true)
      expect(terms.has('kubernetes')).toBe(true)
      expect(terms.has('k8s')).toBe(true)
    })

    it('captures tokens with technical symbols', () => {
      const terms = extractTechnicalTerms('C++, C#, node.js, web3')
      expect(terms.has('c++')).toBe(true)
      expect(terms.has('c#')).toBe(true)
      expect(terms.has('node.js')).toBe(true)
      expect(terms.has('web3')).toBe(true)
    })

    it('ignores common stopwords', () => {
      const terms = extractTechnicalTerms('the and for are but not you all can')
      for (const t of terms) {
        expect(t.length).toBeGreaterThan(3)
      }
    })
  })

  describe('extractRoleTitles', () => {
    it('extracts role-looking lines', () => {
      const roles = extractRoleTitles('Senior Software Engineer\nI like pancakes\nProduct Manager')
      expect(roles).toHaveLength(2)
      expect(roles[0]).toContain('engineer')
      expect(roles[1]).toContain('manager')
    })
  })

  describe('extractYearsExperience', () => {
    it('extracts required years', () => {
      expect(extractYearsExperience('5+ years of experience')).toBe(5)
      expect(extractYearsExperience('Requires 3-5 years experience')).toBe(5)
      expect(extractYearsExperience('2 yrs of relevant work')).toBe(2)
    })

    it('returns 0 when no years are present', () => {
      expect(extractYearsExperience('Entry level position')).toBe(0)
    })
  })

  describe('extractEducationLevel', () => {
    it('orders education correctly', () => {
      expect(extractEducationLevel('Bachelor degree required')).toBe(3)
      expect(extractEducationLevel('Masters in CS')).toBe(4)
      expect(extractEducationLevel('PhD in Machine Learning')).toBe(5)
      expect(extractEducationLevel('No education requirement')).toBe(0)
    })
  })

  describe('scoreCompatibility (legacy wrapper)', () => {
    const baseCv = `
      Senior Software Engineer with 6 years of experience.
      Skills: React, TypeScript, Node.js, AWS, PostgreSQL.
      Interested in remote senior engineer roles.
    `

    it('returns a strong score for a matching senior engineer role', () => {
      const title = 'Senior Software Engineer'
      const desc = 'React, TypeScript, Node.js, AWS. 5+ years experience. Remote.'
      const score = scoreCompatibility(title, desc, baseCv)
      expect(score).toBeGreaterThanOrEqual(0.7)
    })

    it('returns a lower score for an unrelated job', () => {
      const title = 'Veterinary Technician'
      const desc = 'Animal care, surgery assistance, clinic work.'
      const score = scoreCompatibility(title, desc, baseCv)
      expect(score).toBeLessThan(0.5)
    })

    it('returns a neutral score when no CV is provided', () => {
      expect(scoreCompatibility('Engineer', 'React', '')).toBe(0.5)
    })
  })

  describe('scoreCompatibilityStructured', () => {
    const baseCv = `
      Staff Software Engineer with 8 years of experience.
      Expert in TypeScript, React, Node.js, AWS, PostgreSQL, GraphQL.
      Remote worker based in Seattle.
      Education: Bachelor of Science in Computer Science.
    `

    it('boosts score when location matches', () => {
      const title = 'Senior Software Engineer'
      const desc = 'React, TypeScript, AWS. 5+ years experience.'
      const withoutLoc = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: null, baseCv })
      const withLoc = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Seattle, WA', baseCv })
      expect(withLoc).toBeGreaterThanOrEqual(withoutLoc)
    })

    it('gives a high score for a strong full-stack remote role', () => {
      const title = 'Senior Full-Stack Engineer'
      const desc = 'React, TypeScript, Node.js, AWS, PostgreSQL, GraphQL. 5+ years.'
      const score = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Remote', baseCv })
      expect(score).toBeGreaterThanOrEqual(0.75)
    })

    it('penalizes missing hard requirements', () => {
      const title = 'Rust Systems Engineer'
      const desc = 'Rust, Kubernetes, distributed systems. 8+ years required.'
      const score = scoreCompatibilityStructured({ title, description: desc, requirements: null, location: 'Remote', baseCv })
      expect(score).toBeLessThan(0.75)
    })

    it('uses explicit requirements section for stronger signal', () => {
      const title = 'Frontend Engineer'
      const desc = 'Build UI components.'
      const requirements = 'Required: React, TypeScript. Preferred: Tailwind CSS.'
      const score = scoreCompatibilityStructured({
        title,
        description: desc,
        requirements,
        location: null,
        baseCv
      })
      expect(score).toBeGreaterThanOrEqual(0.5)
    })

    it('caps score at 1.0', () => {
      const score = scoreCompatibilityStructured({
        title: 'Senior TypeScript React Node.js AWS PostgreSQL GraphQL Engineer',
        description: 'React TypeScript Node.js AWS PostgreSQL GraphQL. 5+ years. Remote.',
        requirements: null,
        location: 'Seattle, WA',
        baseCv
      })
      expect(score).toBeLessThanOrEqual(1)
      expect(score).toBeGreaterThanOrEqual(0.75)
    })
  })
})
