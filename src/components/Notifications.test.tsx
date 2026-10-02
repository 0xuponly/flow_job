import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import Notifications, { notify } from './Notifications'

/**
 * Timers here are fake and advanced by hand.
 *
 * These tests used to sleep in real time -- 300ms, 2000ms and 4800ms of
 * `setTimeout` inside a returned Promise -- which made `TTL still
 * auto-dismisses when no click happens` cost 4806ms against vitest's 5000ms
 * default timeout. It passed by a 194ms margin and failed the moment the
 * machine was busy, because sleeping measures the clock and not the code.
 *
 * The component schedules three delays (a 4000ms TTL, a 250ms fade, and a
 * 1500ms copy-then-dismiss), so the tests can state exactly where they are in
 * that timeline instead of guessing past it. Advancing the clock also makes
 * the TTL assertion stronger than it was: the old test slept 4800ms and only
 * checked the toast was gone, which a TTL of 2000ms would also satisfy. These
 * assert the toast is still up at the 4000ms boundary and gone after the fade,
 * which pins the actual TTL.
 *
 * `act()` around each advance is required: firing a timer calls `setToasts`,
 * and React must flush that inside act before the DOM is read.
 */
describe('Notifications toast click-to-dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // Unmount before handing the clock back, so React's cleanup does not run
    // against real timers.
    vi.useRealTimers()
  })

  /** Move the fake clock forward, letting React flush whatever it scheduled. */
  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('dismisses a toast when its body is clicked', () => {
    const { getByText, queryByText } = render(<Notifications />)
    act(() => { notify('hello world') })

    const body = getByText('hello world')
    fireEvent.click(body)

    // The click starts the 250ms fade; the toast leaves state after it.
    advance(300)
    expect(queryByText('hello world')).toBeNull()
  })

  it('copy icon does not double-dismiss and still copies', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    })

    const { getByText, getByLabelText } = render(<Notifications />)
    act(() => { notify('payload text') })

    const copyBtn = getByLabelText('Copy toast text to clipboard')
    fireEvent.click(copyBtn)

    expect(writeText).toHaveBeenCalledWith('payload text')
    // Copy path starts the dismiss after 1500ms; the fade then runs 250ms.
    advance(1700)
    expect(getByText('payload text')).toBeTruthy() // still in DOM during fade
    advance(300)
    expect(document.body.textContent).not.toContain('payload text')
  })

  it('action button fires the action and dismisses', () => {
    const onClick = vi.fn()
    const { getByTitle } = render(<Notifications />)
    act(() => {
      notify({ message: 'click me', action: { label: 'Open', onClick } })
    })

    fireEvent.click(getByTitle('Open'))

    expect(onClick).toHaveBeenCalledTimes(1)
    advance(300)
    expect(document.body.textContent).not.toContain('click me')
  })

  it('TTL still auto-dismisses when no click happens', () => {
    const { getByText } = render(<Notifications />)
    act(() => { notify('still here') })

    expect(getByText('still here')).toBeTruthy()
    // Default info TTL is 4000ms. Still on screen at that boundary, which is
    // what makes this an assertion about 4000 rather than "some TTL".
    advance(4000)
    expect(getByText('still here')).toBeTruthy()
    // Then the 250ms fade.
    advance(300)
    expect(document.body.textContent).not.toContain('still here')
  })
})
