import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useRef, useEffect } from 'react';
import Tooltip from './Tooltip';

// We need to control two rects:
//  1. the trigger (the wrapped child) — used for the default anchor
//  2. the tooltip span — used to detect overflow and decide flip
//
// Strategy: provide a Trigger component that sets a stubbed getBoundingClientRect
// on its element on mount. Then the tooltip span's getBoundingClientRect is stubbed
// via a spy on Element.prototype applied only to elements with [role="tooltip"].

function makeRect(o: { left: number; top: number; width: number; height: number }) {
  return {
    left: o.left,
    top: o.top,
    right: o.left + o.width,
    bottom: o.top + o.height,
    width: o.width,
    height: o.height,
    x: o.left,
    y: o.top,
    toJSON() { return {}; }
  } as DOMRect;
}

function stubTooltipRect(rect: DOMRect) {
  const orig = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    if (this.getAttribute && this.getAttribute('role') === 'tooltip') {
      return rect
    }
    return orig.call(this)
  }
  return () => { Element.prototype.getBoundingClientRect = orig }
}

function Trigger({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.getBoundingClientRect = () => rect
    }
  }, [rect])
  return <button ref={ref} data-testid="trigger">{children}</button>
}

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flips to the left side when the tooltip would overflow the right edge', () => {
    // Trigger near the right edge of a 200px-wide viewport. The default
    // right anchor would render the tooltip past the viewport right edge.
    const triggerRect = makeRect({ left: 160, top: 90, width: 20, height: 20 })
    // What the tooltip would measure at the (bad) right anchor: 80x20
    // starting at left=188 → 188..268, which overflows vw=200.
    // After flipping to left: anchor.left = trigger.left - 8 = 152; rect
    // would be 72..152 (since transform is translate(-100%, -50%)).
    const tipRectFlipped = makeRect({ left: 72, top: 100, width: 80, height: 20 })
    const restore = stubTooltipRect(tipRectFlipped)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })

    const { getByTestId, queryByRole, unmount } = render(
      <Tooltip label="A reasonably long tooltip label">
        <Trigger rect={triggerRect}>X</Trigger>
      </Tooltip>
    )

    fireEvent.mouseEnter(getByTestId('trigger'))
    act(() => { vi.advanceTimersByTime(80) })

    const tooltip = queryByRole('tooltip')
    expect(tooltip).not.toBeNull()
    // The actual rendered tooltip's bbox is the FLIPPED rect (it was
    // measured after the flip). We assert the tooltip rect sits to the
    // left of the trigger: tooltip.right <= trigger.left.
    expect(tooltip!.getBoundingClientRect().right).toBeLessThanOrEqual(160)

    restore()
    unmount()
  })
})
