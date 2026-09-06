import { useEffect, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { mapsApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useLocationBias } from '../../hooks/useLocationBias'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

// Free-text address input with location autocomplete, backed by the same maps
// search as LocationSelect. Unlike LocationSelect the typed text is
// authoritative: every keystroke reaches the parent so a hand-written address
// is never lost, and picking a suggestion just replaces the text (#1496).
export default function AddressInput({ value, onChange, placeholder, className }: Props) {
  const { t, locale } = useTranslation()
  // Ohne Reisekontext ist der Hinweis leer, und die Suche laeuft wie bisher.
  const { point: locationBias } = useLocationBias()
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<any[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Clearing the timer does nothing to a request that is already out, and
  // mapsApi.search takes no signal, so results are matched by ticket instead.
  const reqIdRef = useRef(0)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // Search on typing only (not on focus or external value changes), so opening
  // a modal with a saved address doesn't fire a request.
  const search = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = text.trim()
    // Same reason as in pick(): a request for the longer text may still land.
    if (trimmed.length < 3) { reqIdRef.current++; setResults([]); setLoading(false); return }
    debounceRef.current = setTimeout(async () => {
      const myReq = ++reqIdRef.current
      setLoading(true)
      try {
        const data = await mapsApi.search(trimmed, locale, locationBias)
        if (myReq !== reqIdRef.current) return
        setResults(data.places || [])
        setHighlight(-1)
      } catch {
        if (myReq === reqIdRef.current) setResults([])
      } finally {
        if (myReq === reqIdRef.current) setLoading(false)
      }
    }, 320)
  }

  const pick = (r: any) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // A response still on its way must not repopulate the list behind the pick.
    reqIdRef.current++
    onChange(r.address || r.name || '')
    setOpen(false)
    setResults([])
    setLoading(false)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); pick(results[highlight]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); search(e.target.value) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className={className}
      />
      {open && (loading || results.length > 0) && (
        <div className="bg-surface-card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, border: '1px solid var(--border-primary)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', maxHeight: 260, overflowY: 'auto', zIndex: 1000 }}>
          {loading && results.length === 0 && (
            <div className="text-content-faint" style={{ padding: 10, fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>{t('common.loading')}</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.osm_id || r.google_place_id || i}`}
              type="button"
              onClick={() => pick(r)}
              onMouseEnter={() => setHighlight(i)}
              className={`text-content ${i === highlight ? 'bg-surface-hover' : 'bg-transparent'}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                padding: '8px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <MapPin size={12} className="text-content-faint" style={{ marginTop: 2, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name || r.address}</div>
                {r.address && r.name && r.name !== r.address && (
                  <div className="text-content-faint" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.address}</div>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
