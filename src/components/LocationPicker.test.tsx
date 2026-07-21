import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LocationPicker } from './LocationPicker'
import type { LocationPick } from '../locations'

describe('LocationPicker', () => {
  it('renders existing picks as removable pills', () => {
    const onChange = vi.fn()
    const picks: LocationPick[] = [
      { id: 'a', display: 'Vancouver, British Columbia, Canada' },
      { id: undefined, display: 'Remote' },
    ]
    render(<LocationPicker value={picks} onChange={onChange} />)
    expect(screen.getByText('Vancouver, British Columbia, Canada')).toBeInTheDocument()
    expect(screen.getByText('Remote')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove Vancouver, British Columbia, Canada')).toBeInTheDocument()
  })

  it('removes a pick when its × is clicked', () => {
    const onChange = vi.fn()
    const picks: LocationPick[] = [{ id: 'a', display: 'Vancouver, BC' }]
    render(<LocationPicker value={picks} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove Vancouver, BC'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('appends a free-text entry when Enter is pressed in the add input', () => {
    const onChange = vi.fn()
    render(<LocationPicker value={[]} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'Remote' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([{ display: 'Remote' }])
  })

  it('does not append an empty entry', () => {
    const onChange = vi.fn()
    render(<LocationPicker value={[]} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
