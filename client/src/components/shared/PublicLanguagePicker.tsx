import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import { useAnchoredPosition } from '../../hooks/useAnchoredPosition'

/** Wide enough for the longest label ("Português (Brasil)") at the default text size. */
const MENU_MIN_WIDTH = 190
const MENU_MAX_HEIGHT = 320

interface PublicLanguagePickerProps {
  /** Current UI locale, e.g. `de` or `pt-BR`. */
  locale?: string | null
  open: boolean
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
}

/**
 * The language pill both anonymous share pages carry in their top-right corner (#2248).
 *
 * Each page used to inline the same absolutely-positioned menu. On the journey
 * page that menu sits inside a hero with `overflow: hidden` — the clip that keeps
 * the hero's decorative circles from widening the document — so the list of 23
 * languages was amputated at the hero's bottom edge and most of it could never be
 * picked. The menu is portalled to `document.body` and positioned against the
 * trigger now, which no ancestor can clip, and it caps its own height at the room
 * the viewport actually has: the treatment `CustomSelect` already gets.
 */
export default function PublicLanguagePicker({ locale, open, onOpenChange }: PublicLanguagePickerProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // matchWidth stays on: the anchored box's `width` is the trigger's own width,
  // which is what the right-edge alignment below needs.
  const anchored = useAnchoredPosition(wrapRef, open, { estimatedHeight: MENU_MAX_HEIGHT, offset: 6 })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      onOpenChange(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  // The two pages hand in different shapes: the journey page passes the stored
  // setting (`br`, `zh-TW`), the trip page the resolved locale (`de-DE`). Try the
  // whole string before its prefix, or `zh-TW` would label itself 简体中文.
  const raw = locale || 'en'
  const current = SUPPORTED_LANGUAGES.some(l => l.value === raw) ? raw : raw.split('-')[0]
  // Pinned by its RIGHT edge, the way `right: 0` did inside the trigger's box. That
  // also lets the panel size to its content: a reader on the largest text setting
  // gets a wider menu instead of "Português (Brasil)" wrapping to two lines.
  const right = anchored
    ? Math.max(8, (typeof window === 'undefined' ? 0 : window.innerWidth) - anchored.left - anchored.width)
    : 8

  return (
    <div ref={wrapRef} style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => onOpenChange(v => !v)}
        className="bg-[rgba(255,255,255,0.1)] text-[rgba(255,255,255,0.7)]"
        style={{
          padding: '5px 12px',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.15)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {SUPPORTED_LANGUAGES.find(l => l.value === current)?.label || 'Language'}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          data-testid="public-language-menu"
          className="bg-surface-card border border-edge"
          style={{
            position: 'fixed',
            ...(anchored?.flipped ? { bottom: anchored.bottom } : { top: anchored?.top ?? 0 }),
            right,
            minWidth: MENU_MIN_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            // 23 languages do not fit beside a short viewport; scroll them there
            // rather than letting the list run past the bottom of the screen.
            maxHeight: Math.min(MENU_MAX_HEIGHT, anchored?.maxHeight ?? MENU_MAX_HEIGHT),
            overflowY: 'auto',
            // Portalled and fixed, so the scroll chain runs to the viewport: without
            // this a flick past either end scrolls the page behind it instead (#2078).
            overscrollBehavior: 'contain',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            padding: 4,
            zIndex: 99999,
          }}
        >
          {SUPPORTED_LANGUAGES.map(lang => (
            <button
              type="button"
              key={lang.value}
              aria-current={lang.value === current}
              onClick={() => {
                // No API call: a share-link visitor has no account to save it to.
                useSettingsStore.setState(s => ({ settings: { ...s.settings, language: lang.value } }))
                onOpenChange(false)
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              className="text-content-secondary"
              style={{
                display: 'block',
                width: '100%',
                padding: '7px 12px',
                border: 'none',
                background: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                fontWeight: lang.value === current ? 600 : 400,
                borderRadius: 6,
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {lang.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
