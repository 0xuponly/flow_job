import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, renderHook } from '@testing-library/react'
import { ThemeProvider, useTheme } from './ThemeProvider'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('ThemeProvider', () => {
  it('defaults to dark when localStorage is empty', () => {
    render(<ThemeProvider><div /></ThemeProvider>)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('reads light from localStorage on mount', () => {
    localStorage.setItem('theme', 'light')
    render(<ThemeProvider><div /></ThemeProvider>)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('falls back to dark for invalid stored value', () => {
    localStorage.setItem('theme', 'system')
    render(<ThemeProvider><div /></ThemeProvider>)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('toggle() flips state, writes storage, updates data-theme', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider })
    expect(result.current.theme).toBe('dark')
    act(() => result.current.toggle())
    expect(result.current.theme).toBe('light')
    expect(localStorage.getItem('theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('falls back to in-memory when getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota')
    })
    render(<ThemeProvider><div /></ThemeProvider>)
    expect(document.documentElement.dataset.theme).toBe('dark')
    spy.mockRestore()
  })
})
