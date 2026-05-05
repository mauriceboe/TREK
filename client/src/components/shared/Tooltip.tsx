import React, { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'

type Placement = 'top' | 'bottom' | 'left' | 'right'
// For top/bottom placement: where the tooltip aligns relative to the trigger
// along the cross-axis. 'center' (default) preserves existing behavior.
// 'start' = aligned to the trigger's left edge; 'end' = right edge.
type Align = 'start' | 'center' | 'end'

interface TooltipProps {
  label: string
  placement?: Placement
  align?: Align
  delay?: number
  disabled?: boolean
  children: React.ReactElement
}

export function Tooltip({ label, placement = 'bottom', align = 'center', delay = 250, disabled, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const show = () => {
    if (disabled || !label) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    setOpen(false)
  }

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current) }, [])

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const tipW = tooltipRef.current?.offsetWidth ?? 0
    const tipH = tooltipRef.current?.offsetHeight ?? 0
    const gap = 6
    let top = 0, left = 0
    // Cross-axis alignment for top/bottom placements. start = trigger.left,
    // center = trigger horizontal centre, end = trigger.right.
    const alignedLeft = align === 'start' ? r.left
                      : align === 'end'   ? r.right - tipW
                      : r.left + r.width / 2 - tipW / 2
    if (placement === 'top') { top = r.top - tipH - gap; left = alignedLeft }
    else if (placement === 'bottom') { top = r.bottom + gap; left = alignedLeft }
    else if (placement === 'left') { top = r.top + r.height / 2 - tipH / 2; left = r.left - tipW - gap }
    else { top = r.top + r.height / 2 - tipH / 2; left = r.right + gap }
    const pad = 6
    left = Math.max(pad, Math.min(left, window.innerWidth - tipW - pad))
    top = Math.max(pad, Math.min(top, window.innerHeight - tipH - pad))
    setCoords({ top, left })
  }, [open, placement, align, label])

  const child = React.Children.only(children)
  const trigger = React.cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const r = (child as any).ref
      if (typeof r === 'function') r(node)
      else if (r && typeof r === 'object') r.current = node
    },
    onMouseEnter: (e: any) => { show(); child.props.onMouseEnter?.(e) },
    onMouseLeave: (e: any) => { hide(); child.props.onMouseLeave?.(e) },
    onFocus: (e: any) => { show(); child.props.onFocus?.(e) },
    onBlur: (e: any) => { hide(); child.props.onBlur?.(e) },
  })

  return (
    <>
      {trigger}
      {open && ReactDOM.createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          className="trek-popover-enter"
          style={{
            position: 'fixed',
            top: coords?.top ?? -9999,
            left: coords?.left ?? -9999,
            visibility: coords ? 'visible' : 'hidden',
            pointerEvents: 'none',
            zIndex: 100000,
            background: 'var(--bg-card, #ffffff)',
            color: 'var(--text-primary, #111827)',
            fontSize: 11,
            fontWeight: 500,
            padding: '5px 10px',
            borderRadius: 8,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            border: '1px solid var(--border-faint, #e5e7eb)',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
            transformOrigin: placement === 'top' ? 'bottom center' : placement === 'bottom' ? 'top center' : placement === 'left' ? 'center right' : 'center left',
          }}
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  )
}

export default Tooltip
