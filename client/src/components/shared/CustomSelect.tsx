import React, { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'

interface SelectOption {
  value: string
  label: string
  icon?: React.ReactNode
  isHeader?: boolean
  searchLabel?: string
  groupLabel?: string
}

interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  placeholder?: string
  searchable?: boolean
  style?: React.CSSProperties
  size?: 'sm' | 'md'
  disabled?: boolean
}

export default function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = '',
  searchable = false,
  style = {},
  size = 'md',
  disabled = false,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && searchable && searchRef.current) searchRef.current.focus()
  }, [open, searchable])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected = options.find(o => o.value === value)
  const filtered = searchable && search
    ? (() => {
        const q = search.toLowerCase()
        const result: SelectOption[] = []
        let currentHeader: SelectOption | null = null
        let headerAdded = false
        for (const o of options) {
          if (o.isHeader) {
            currentHeader = o
            headerAdded = false
            continue
          }
          const haystack = [o.label, o.searchLabel, o.groupLabel].filter(Boolean).join(' ').toLowerCase()
          if (haystack.includes(q)) {
            if (currentHeader && !headerAdded) {
              result.push(currentHeader)
              headerAdded = true
            }
            result.push(o)
          }
        }
        return result
      })()
    : options

  const sm = size === 'sm'

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen(o => !o); setSearch('') } }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: sm ? '8px 12px' : '8px 14px', borderRadius: 10,
          border: '1px solid var(--border-primary)',
          background: 'var(--bg-input)', color: 'var(--text-primary)',
          fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer', outline: 'none', textAlign: 'left',
          transition: 'border-color 0.15s', overflow: 'hidden', minWidth: 0,
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--text-faint)' }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = 'var(--border-primary)' }}
      >
        {selected?.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{selected.icon}</span>}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text-primary)' : 'var(--text-faint)' }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={sm ? 12 : 14} style={{ flexShrink: 0, color: 'var(--text-faint)', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {/* Dropdown */}
      {open && ReactDOM.createPortal(
        <div ref={dropRef} style={{
          position: 'fixed',
          ...(() => {
            const r = ref.current?.getBoundingClientRect()
            if (!r) return { top: 0, left: 0, width: 200 }
            const spaceBelow = window.innerHeight - r.bottom
            const openUp = spaceBelow < 220 && r.top > spaceBelow
            return openUp
              ? { bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width }
              : { top: r.bottom + 4, left: r.left, width: r.width }
          })(),
          zIndex: 99999,
          background: 'var(--bg-card)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          border: '1px solid var(--border-primary)',
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          overflow: 'hidden',
          animation: 'selectIn 0.15s ease-out',
        }}>
          {/* Search */}
          {searchable && (
            <div style={{ padding: '6px 6px 2px' }}>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="..."
                style={{
                  width: '100%', border: '1px solid var(--border-secondary)', borderRadius: 6,
                  padding: '5px 8px', fontSize: 12, outline: 'none', fontFamily: 'inherit',
                  background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          {/* Options */}
          <div style={{ maxHeight: 220, overflowY: 'auto', padding: '4px' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-faint)', textAlign: 'center' }}>—</div>
            ) : (
              filtered.map(option => {
                if (option.isHeader) {
                  return (
                    <div key={option.value} style={{
                      padding: '5px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text-faint)',
                      textTransform: 'uppercase', letterSpacing: '0.03em',
                      background: 'var(--bg-tertiary)', borderRadius: 4, margin: '2px 0',
                    }}>
                      {option.label}
                    </div>
                  )
                }
                const isSelected = option.value === value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => { onChange(option.value); setOpen(false); setSearch('') }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderRadius: 6,
                      border: 'none', background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                      cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = isSelected ? 'var(--bg-hover)' : 'transparent'}
                  >
                    {option.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{option.icon}</span>}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                    {isSelected && <Check size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body
      )}

      <style>{`
        @keyframes selectIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
