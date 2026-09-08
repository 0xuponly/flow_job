import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QuickAddUrlWindow from './QuickAddUrlWindow'

describe('QuickAddUrlWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits a non-empty URL on Enter and clears the input on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ company: 'Acme', title: 'Engineer' })
    const onClose = vi.fn()
    render(<QuickAddUrlWindow onSubmit={onSubmit} onClose={onClose} />)

    const input = screen.getByLabelText('Job URL')
    fireEvent.change(input, { target: { value: 'https://example.com/job' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('https://example.com/job')
    expect(await screen.findByText(/Added Acme — Engineer/i)).toBeTruthy()
    expect(input).toHaveValue('')
  })

  it('is a no-op when Enter is pressed with an empty input', () => {
    const onSubmit = vi.fn()
    render(<QuickAddUrlWindow onSubmit={onSubmit} onClose={vi.fn()} />)

    const input = screen.getByLabelText('Job URL')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('surfaces duplicate and other errors without clearing the input', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Job already exists: Acme — Engineer'))
    render(<QuickAddUrlWindow onSubmit={onSubmit} onClose={vi.fn()} />)

    const input = screen.getByLabelText('Job URL')
    fireEvent.change(input, { target: { value: 'https://example.com/job' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText(/Job already exists/i)).toBeTruthy()
    expect(input).toHaveValue('https://example.com/job')
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<QuickAddUrlWindow onSubmit={() => Promise.resolve({ company: '', title: '' })} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /close window/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
