import { useEffect, useRef, useState } from 'react'
import { MapPin, X } from 'lucide-react'
import { mapsApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useLocationBias } from '../../hooks/useLocationBias'

export interface LocationPoint {
  name: string
  lat: number
  lng: number
  address?: string | null
}

interface Props {
  value: LocationPoint | null
  onChange: (loc: LocationPoint | null) => void
  placeholder?: string
  style?: React.CSSProperties
}

export default function LocationSelect({ value, onChange, placeholder, style }: Props) {
  const { t, locale } = useTranslation()
  // Ohne Reisekontext ist der Hinweis leer, und die Suche laeuft wie bisher.
  const { point: locationBias } = useLocationBias()
  const [query, setQuery] = useState(value?.name || '')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<any[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setQuery(value?.name || '')
  }, [value])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = query.trim()
    if (trimmed.length < 3 || (value && trimmed === value.name)) {
      setResults([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await mapsApi.search(trimmed, locale, locationBias)
        setResults(data.places || [])
        setHighlight(-1)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 320)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, value, locale])

  const pick = (r: any) => {
    const lat = Number(r.lat)
    const lng = Number(r.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    const loc: LocationPoint = { name: r.name || r.address || 'Location', lat, lng, address: r.address || null }
    onChange(loc)
    setQuery(loc.name)
    setOpen(false)
    setResults([])
  }

  const clear = () => {
    onChange(null)
    setQuery('')
    setResults([])
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); pick(results[highlight]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <div className="bg-surface-tertiary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border-primary)' }}>
        <MapPin size={14} className="text-content-faint" style={{ flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          placeholder={placeholder ?? t('reservations.searchLocation')}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); if (value) onChange(null) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className="bg-transparent text-content"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}
        />
        {value && (
          <button type="button" onClick={clear} className="bg-transparent text-content-faint" style={{ border: 'none', padding: 2, cursor: 'pointer', display: 'flex' }} aria-label="Clear">
            <X size={14} />
          </button>
        )}
      </div>

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
