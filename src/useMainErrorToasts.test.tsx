// src/useMainErrorToasts.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen, cleanup } from '@testing-library/react'
import { useMainErrorToasts } from './useMainErrorToasts'
import Notifications from './components/Notifications'

let listeners: ((message: string) => void) | null = null

function Harness() {
  useMainErrorToasts()
  return null
}

describe('useMainErrorToasts', () => {
  beforeEach(() => {
    cleanup()
    listeners = null
    ;(window as unknown as { api: unknown }).api = {
      onMainError: vi.fn((cb: (message: string) => void) => {
        listeners = cb
        return () => { listeners = null }
      })
    }
  })

  it('subscribes and surfaces a main-process error as a toast', () => {
    render(<><Harness /><Notifications /></>)
    expect(listeners).not.toBeNull()
    act(() => { listeners!('Something broke behind the scenes') })
    expect(screen.getByText('Something broke behind the scenes')).toBeInTheDocument()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Harness />)
    expect(listeners).not.toBeNull()
    unmount()
    expect(listeners).toBeNull()
  })
})
