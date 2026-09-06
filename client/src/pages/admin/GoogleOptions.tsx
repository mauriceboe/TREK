import React from 'react'
import { ChevronRight } from 'lucide-react'

interface GoogleOptionsProps {
  /** "Google options" — the heading of the fold. */
  title: string
  /** Right-hand summary while folded, e.g. "3 of 4 on". */
  summary: string
  children: React.ReactNode
}

/**
 * The fold that holds what a Google key is allowed to be spent on.
 *
 * Only these switches fold away. The key fields above stay visible: a field you
 * have to go looking for is worse than a long page, and the keys are the reason
 * an admin opens this card at all. The switches are the opposite — set once,
 * then never touched, and there are four of them.
 *
 * A native <details> rather than a state hook: keyboard operable and announced
 * to screen readers without writing any of that, and it survives a re-render
 * without state.
 */
export default function GoogleOptions({ title, summary, children }: GoogleOptionsProps): React.ReactElement {
  return (
    <details className="group rounded-lg border border-edge-secondary bg-surface-secondary/40">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
                   [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          className="h-4 w-4 flex-shrink-0 text-content-faint transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="flex-1 text-sm font-medium text-content-secondary">{title}</span>
        <span className="text-xs text-content-faint">{summary}</span>
      </summary>
      <div className="border-t border-edge-faint px-4">{children}</div>
    </details>
  )
}
