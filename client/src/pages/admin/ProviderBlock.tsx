import React from 'react'

interface ProviderBlockProps {
  title: string
  /** Optional label sitting on the top border, like the one on the TREK block. */
  badge?: string
  /**
   * `accent` marks the recommended path, `muted` a neutral one, `caution` a
   * provider that costs something other than money. Deliberately not `danger`:
   * using a Google key is a legitimate choice, and a red badge would be the
   * settings page shouting at the person who made it.
   */
  tone?: 'muted' | 'caution'
  children: React.ReactNode
}

/**
 * One provider inside the API card, in the same shape as the TREK block above
 * it, so the page reads as a list of comparable options rather than one
 * highlighted thing and some loose fields underneath.
 */
export default function ProviderBlock({
  title, badge, tone = 'muted', children,
}: ProviderBlockProps): React.ReactElement {
  return (
    <div className="relative">
      {badge && (
        <span
          className={`pointer-events-none absolute -top-2 z-10 select-none rounded-md px-2 py-0.5
                      text-[10px] font-medium uppercase tracking-[0.14em] shadow-sm
                      ltr:left-4 rtl:right-4 ${
            tone === 'caution'
              ? 'bg-warning-soft text-warning border border-warning/30'
              : 'bg-surface-tertiary text-content-faint border border-edge-secondary'
          }`}
        >
          {badge}
        </span>
      )}
      <div className="overflow-hidden rounded-xl border border-edge bg-surface-secondary/30">
        <div className="px-5 pt-6 pb-5">
          <p className="text-sm font-medium text-content-secondary">{title}</p>
          <div className="mt-3 space-y-4">{children}</div>
        </div>
      </div>
    </div>
  )
}
