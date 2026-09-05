import { useState, useEffect, useRef, useCallback } from 'react'

const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 520
/**
 * The band where the desktop planner renders but two panels leave the map a
 * useless strip. Below 768 the phone shell takes over, so the squeeze lives
 * entirely between there and Tailwind's `lg`: a Pixel 10 Pro Fold unfolded is
 * ~860 CSS px, where 340 + 300 of panel left the map 200 px (#2247).
 */
const NARROW_QUERY = '(min-width: 768px) and (max-width: 1023px)'
/** However wide a panel was dragged on a big screen, the map keeps this much. */
const MIN_MAP = 360

export function useResizablePanels() {
  const [leftWidth, setLeftWidth] = useState<number>(() => Number.parseInt(localStorage.getItem('sidebarLeftWidth') || '') || 340)
  const [rightWidth, setRightWidth] = useState<number>(() => Number.parseInt(localStorage.getItem('sidebarRightWidth') || '') || 300)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const isResizingLeft = useRef(false)
  const isResizingRight = useRef(false)

  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  )
  // Which panel owns the screen while only one of them fits. The day plan is what
  // the Plan tab is about, so it starts open and the places list is one tap away;
  // null is map-only. Deliberately separate from the two collapse flags, which stay
  // the wide-layout state — folding back to a wide window restores what was there.
  const [narrowPanel, setNarrowPanel] = useState<'left' | 'right' | null>('left')
  const [maxPanel, setMaxPanel] = useState(Number.POSITIVE_INFINITY)

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches)
    setNarrow(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Only measured inside the narrow band: that is the only place the clamp can
  // bite, and a resize listener on every planner mount is not worth the rest.
  useEffect(() => {
    if (!narrow) { setMaxPanel(Number.POSITIVE_INFINITY); return }
    const measure = () => setMaxPanel(Math.max(MIN_SIDEBAR, window.innerWidth - MIN_MAP - 20))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [narrow])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isResizingLeft.current) {
        const w = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, e.clientX - 10))
        setLeftWidth(w)
        localStorage.setItem('sidebarLeftWidth', String(w))
      }
      if (isResizingRight.current) {
        const w = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, window.innerWidth - e.clientX - 10))
        setRightWidth(w)
        localStorage.setItem('sidebarRightWidth', String(w))
      }
    }
    const onUp = () => {
      isResizingLeft.current = false
      isResizingRight.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startResizeLeft = () => { isResizingLeft.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' }
  const startResizeRight = () => { isResizingRight.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' }

  // What the layout actually shows. The collapse flags stay the caller's intent —
  // handlePlaceClick reopening "both" must not re-crowd a narrow screen.
  const leftHidden = narrow ? narrowPanel !== 'left' : leftCollapsed
  const rightHidden = narrow ? narrowPanel !== 'right' : rightCollapsed

  const toggleLeft = useCallback(() => {
    if (narrow) setNarrowPanel(p => (p === 'left' ? null : 'left'))
    else setLeftCollapsed(c => !c)
  }, [narrow])
  const toggleRight = useCallback(() => {
    if (narrow) setNarrowPanel(p => (p === 'right' ? null : 'right'))
    else setRightCollapsed(c => !c)
  }, [narrow])

  return {
    // Clamped for the layout; the stored width is left alone, so a 520 px panel
    // dragged on a desktop comes back untouched once there is room for it again.
    leftWidth: Math.min(leftWidth, maxPanel),
    rightWidth: Math.min(rightWidth, maxPanel),
    leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed,
    leftHidden, rightHidden, toggleLeft, toggleRight, narrow,
    startResizeLeft, startResizeRight,
  }
}
