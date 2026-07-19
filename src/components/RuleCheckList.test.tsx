import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import RuleCheckList from './RuleCheckList'
import type { RuleCheck } from '../documentRules'

const rules: RuleCheck[] = [
  { rule: 'one_page', passed: true, detail: 'estimated from text length' },
  { rule: 'paragraph_count', passed: true, detail: '4 paragraphs (max 4)' },
  { rule: 'skills_count', passed: false, detail: '20 skills (target 5-15)' },
  { rule: 'keyword_coverage', passed: true, detail: 'coverage 60% (threshold 50%)' }
]

describe('RuleCheckList', () => {
  it('renders nothing when given an empty array', () => {
    const { container } = render(<RuleCheckList rules={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one row per rule', () => {
    render(<RuleCheckList rules={rules} />)
    expect(screen.getByText('One page')).toBeInTheDocument()
    expect(screen.getByText('Paragraph count')).toBeInTheDocument()
    expect(screen.getByText('Skills count')).toBeInTheDocument()
    expect(screen.getByText('Keyword coverage')).toBeInTheDocument()
  })

  it('shows ✅ for passed rules and ❌ for failed rules', () => {
    render(<RuleCheckList rules={rules} />)
    expect(screen.getAllByText('✅').length).toBe(3)
    expect(screen.getAllByText('❌').length).toBe(1)
  })

  it('renders the detail text below each rule', () => {
    render(<RuleCheckList rules={rules} />)
    expect(screen.getByText('estimated from text length')).toBeInTheDocument()
    expect(screen.getByText('4 paragraphs (max 4)')).toBeInTheDocument()
    expect(screen.getByText('20 skills (target 5-15)')).toBeInTheDocument()
    expect(screen.getByText(/coverage 60%/)).toBeInTheDocument()
  })

  it('uses a muted indicator for n/a details', () => {
    const naRules: RuleCheck[] = [
      { rule: 'skills_count', passed: true, detail: 'n/a (cover letter)' }
    ]
    render(<RuleCheckList rules={naRules} />)
    expect(screen.getByText('n/a (cover letter)')).toBeInTheDocument()
  })

  it('maps rule names to display names correctly', () => {
    render(<RuleCheckList rules={rules} />)
    expect(screen.getByText('One page')).toBeInTheDocument()
    expect(screen.getByText('Paragraph count')).toBeInTheDocument()
    expect(screen.getByText('Skills count')).toBeInTheDocument()
    expect(screen.getByText('Keyword coverage')).toBeInTheDocument()
  })
})
