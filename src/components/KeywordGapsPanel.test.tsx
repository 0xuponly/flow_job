import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KeywordGapsPanel } from './KeywordGapsPanel'
import type { KeywordResult } from '../types'

describe('KeywordGapsPanel', () => {
  it('renders nothing when there are no keywords', () => {
    const { container } = render(
      <KeywordGapsPanel result={{ keywords: [], refinedByLlm: false, unknownPhrases: [] }} documentText="" />
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists missing phrases in weight-desc order, grouped by category', () => {
    const result: KeywordResult = {
      keywords: [
        { phrase: 'python', weight: 0.9, category: 'hard', source: 'required' },
        { phrase: 'aws', weight: 0.7, category: 'hard', source: 'required' },
        { phrase: 'leadership', weight: 0.6, category: 'soft', source: 'body' }
      ],
      refinedByLlm: false,
      unknownPhrases: []
    }
    render(<KeywordGapsPanel result={result} documentText="I have some python experience" />)
    // aws and leadership are missing; python is present.
    expect(screen.getByText('aws')).toBeInTheDocument()
    expect(screen.getByText('leadership')).toBeInTheDocument()
    expect(screen.queryByText('python')).not.toBeInTheDocument()
  })

  it('shows category headings', () => {
    const result: KeywordResult = {
      keywords: [
        { phrase: 'aws', weight: 0.7, category: 'hard', source: 'required' },
        { phrase: 'leadership', weight: 0.6, category: 'soft', source: 'body' }
      ],
      refinedByLlm: false,
      unknownPhrases: []
    }
    render(<KeywordGapsPanel result={result} documentText="" />)
    expect(screen.getByText(/hard/i)).toBeInTheDocument()
    expect(screen.getByText(/soft/i)).toBeInTheDocument()
  })
})
