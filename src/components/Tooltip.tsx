import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react'

type Placement = 'right' | 'left' | 'top' | 'bottom'

interface TooltipProps {
  label: string
  children: React.ReactElement
  placement?: Placement
  delayMs?: number
  disabled?: boolean
}

const VIEWPORT_PAD = 4
const GAP = 8

interface Anchor {
  left: number
  top: number
  transform: string
}

function anchorFor(placement: Placement, r: DOMRect): Anchor {
  switch (placement) {
    case 'right':
      return { left: r.right + GAP, top: r.top + r.height / 2, transform: 'translate(0, -50%)' }
    case 'left':
      return { left: r.left - GAP, top: r.top + r.height / 2, transform: 'translate(-100%, -50%)' }
    case 'top':
      return { left: r.left + r.width / 2, top: r.top - GAP, transform: 'translate(-50%, -100%)' }
    case 'bottom':
      return { left: r.left + r.width / 2, top: r.bottom + GAP, transform: 'translate(-50%, 0)' }
  }
}

// Compute the tooltip's on-screen rect given its anchor (left/top) and the
// anchor's CSS transform. The CSS transform shifts the tooltip relative to
// the (left, top) corner; we replicate that here so we can compare against
// the viewport.
function rectAtAnchor(anchor: Anchor, mr: DOMRect): { left: number; top: number; right: number; bottom: number } {
  let left = anchor.left
  let top = anchor.top
  if (anchor.transform.includes('translate(-100%')) left -= mr.width
  if (anchor.transform.includes('translate(-50%')) left -= mr.width / 2
  // The vertical component is one of:
  //   translate(0, -50%)           → shift up by half
  //   translate(-100%, -50%)       → shift up by half
  //   translate(-50%, -100%)       → shift up by full
  //   translate(-50%, 0)           → no shift
  if (anchor.transform.includes('-100%')) top -= mr.height
  else if (anchor.transform.includes('-50%')) top -= mr.height / 2
  return { left, top, right: left + mr.width, bottom: top + mr.height }
}

interface ResolvedPos {
  left: number
  top: number
  transform: string
}

function resolvePosition(
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  requested: Placement,
  vw: number,
  vh: number
): ResolvedPos {
  let placement: Placement = requested
  let anchor = anchorFor(placement, triggerRect)
  let r = rectAtAnchor(anchor, tooltipRect)

  // Horizontal flip
  if (placement === 'right' && r.right > vw - VIEWPORT_PAD) {
    placement = 'left'
    anchor = anchorFor(placement, triggerRect)
    r = rectAtAnchor(anchor, tooltipRect)
  } else if (placement === 'left' && r.left < VIEWPORT_PAD) {
    placement = 'right'
    anchor = anchorFor(placement, triggerRect)
    r = rectAtAnchor(anchor, tooltipRect)
  }

  // Vertical flip
  if (placement === 'bottom' && r.bottom > vh - VIEWPORT_PAD) {
    placement = 'top'
    anchor = anchorFor(placement, triggerRect)
    r = rectAtAnchor(anchor, tooltipRect)
  } else if (placement === 'top' && r.top < VIEWPORT_PAD) {
    placement = 'bottom'
    anchor = anchorFor(placement, triggerRect)
    r = rectAtAnchor(anchor, tooltipRect)
  }

  // Final clamp into the viewport.
  let dx = 0
  let dy = 0
  if (r.left < VIEWPORT_PAD) dx = VIEWPORT_PAD - r.left
  else if (r.right > vw - VIEWPORT_PAD) dx = vw - VIEWPORT_PAD - r.right
  if (r.top < VIEWPORT_PAD) dy = VIEWPORT_PAD - r.top
  else if (r.bottom > vh - VIEWPORT_PAD) dy = vh - VIEWPORT_PAD - r.bottom

  return {
    left: anchor.left,
    top: anchor.top,
    transform: `${anchor.transform} translate(${dx}px, ${dy}px)`,
  }
}

export default function Tooltip({
  label,
  children,
  placement = 'right',
  delayMs = 80,
  disabled = false,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<ResolvedPos | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    if (disabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const trigger = wrapRef.current
      if (!trigger) return
      const tr = trigger.getBoundingClientRect()
      // Render at the default anchor first; the layout effect below will
      // re-measure and apply the final resolved position (flip + clamp).
      setPos(anchorFor(placement, tr))
      setVisible(true)
    }, delayMs)
  }, [disabled, delayMs, placement])

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
  }, [])

  // After the tooltip mounts (or placement changes), measure it and resolve
  // the final position. Runs synchronously before paint so the user never
  // sees the tooltip at the wrong spot.
  useLayoutEffect(() => {
    if (!visible) return
    const trigger = wrapRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const tr = trigger.getBoundingClientRect()
    const mr = tip.getBoundingClientRect()
    setPos(resolvePosition(tr, mr, placement, window.innerWidth, window.innerHeight))
  }, [visible, placement])

  // Re-measure on window resize while visible.
  useEffect(() => {
    if (!visible) return
    const onResize = () => {
      const trigger = wrapRef.current
      const tip = tipRef.current
      if (!trigger || !tip) return
      const tr = trigger.getBoundingClientRect()
      const mr = tip.getBoundingClientRect()
      setPos(resolvePosition(tr, mr, placement, window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [visible, placement])

  // Clear the pending show timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  if (disabled) return children

  return (
    <span
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ display: 'inline-block' }}
    >
      {children}
      {visible && (
        <span
          ref={tipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            transform: pos?.transform ?? '',
            padding: '4px 8px',
            borderRadius: 6,
            background: 'rgba(15, 17, 23, 0.95)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.2,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 9999,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
            animation: 'fit-tooltip-in 0.12s ease-out',
          }}
        >
          {label}
        </span>
      )}
    </span>
  )
}
