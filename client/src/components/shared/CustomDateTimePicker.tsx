import React, { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

function daysInMonth(year: number, month: number): number { return new Date(year, month + 1, 0).getDate() }
function getWeekday(year: number, month: number, day: number): number { return new Date(year, month, day).getDay() }

interface CustomDatePickerProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  style?: React.CSSProperties
  compact?: boolean
  borderless?: boolean
}

export function CustomDatePicker({ value, onChange, placeholder, style = {}, compact = false, borderless = false }: CustomDatePickerProps) {
  const { locale, t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [panelMode, setPanelMode] = useState<'days' | 'months' | 'years'>('days')
  const ref = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const parsedValue = value ? value.slice(0, 10) : ''
  const parsed = parsedValue ? new Date(parsedValue + 'T00:00:00Z') : null
  const [viewYear, setViewYear] = useState(parsed?.getUTCFullYear() || new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(parsed?.getUTCMonth() ?? new Date().getMonth())
  const [textInput, setTextInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    setPanelMode('days')
    if (parsed) {
      setViewYear(parsed.getUTCFullYear())
      setViewMonth(parsed.getUTCMonth())
    }
  }, [open, parsedValue])

  const monthOptions = Array.from({ length: 12 }, (_, month) => ({
    value: month,
    label: new Date(2024, month, 1).toLocaleDateString(locale, { month: 'long' }),
    shortLabel: new Date(2024, month, 1).toLocaleDateString(locale, { month: 'short' }),
  }))

  const yearGridStart = Math.floor((viewYear - 6) / 12) * 12 + 1
  const yearOptions = Array.from({ length: 12 }, (_, index) => yearGridStart + index)
  const days = daysInMonth(viewYear, viewMonth)
  const startDay = (getWeekday(viewYear, viewMonth, 1) + 6) % 7
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, i + 1).toLocaleDateString(locale, { weekday: 'narrow' }))

  const displayValue = parsed
    ? parsed.toLocaleDateString(
        locale,
        compact
          ? { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' }
          : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      )
    : null

  const selectedDay = parsed && parsed.getUTCFullYear() === viewYear && parsed.getUTCMonth() === viewMonth ? parsed.getUTCDate() : null
  const today = new Date()
  const isToday = (d: number) => today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === d
  const isSlateMode = !compact && !borderless

  const shiftBackward = () => {
    if (panelMode === 'years') {
      setViewYear(y => y - 12)
      return
    }
    if (panelMode === 'months') {
      setViewYear(y => y - 1)
      return
    }
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear(y => y - 1)
    } else {
      setViewMonth(m => m - 1)
    }
  }

  const shiftForward = () => {
    if (panelMode === 'years') {
      setViewYear(y => y + 12)
      return
    }
    if (panelMode === 'months') {
      setViewYear(y => y + 1)
      return
    }
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear(y => y + 1)
    } else {
      setViewMonth(m => m + 1)
    }
  }

  const selectDay = (day: number) => {
    const y = String(viewYear)
    const m = String(viewMonth + 1).padStart(2, '0')
    const d = String(day).padStart(2, '0')
    onChange(`${y}-${m}-${d}`)
    setOpen(false)
  }

  const handleTextSubmit = () => {
    setIsTyping(false)
    if (!textInput.trim()) return
    const input = textInput.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) { onChange(input); return }
    const euMatch = input.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/)
    if (euMatch) {
      const y = euMatch[3].length === 2 ? 2000 + parseInt(euMatch[3]) : parseInt(euMatch[3])
      onChange(`${y}-${String(euMatch[2]).padStart(2, '0')}-${String(euMatch[1]).padStart(2, '0')}`)
      return
    }
    const d = new Date(input)
    if (!isNaN(d.getTime())) {
      onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
  }

  const triggerButtonStyle: React.CSSProperties = {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: isSlateMode ? '7px 12px' : '6px 10px',
    borderRadius: isSlateMode ? 10 : 9,
    border: isSlateMode ? '1px solid #e2e8f0' : '1px solid var(--border-primary)',
    background: isSlateMode ? '#f8fafc' : 'var(--bg-input)',
    color: isSlateMode ? '#0f172a' : 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  }

  const navButtonStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    background: isSlateMode ? '#f8fafc' : 'none',
    border: isSlateMode ? '1px solid #e2e8f0' : 'none',
    cursor: 'pointer',
    padding: 0,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: isSlateMode ? '#64748b' : 'var(--text-faint)',
    transition: 'all 0.15s ease',
  }

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      {isTyping ? (
        <input
          autoFocus
          type="text"
          value={textInput}
          onChange={e => setTextInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleTextSubmit(); if (e.key === 'Escape') setIsTyping(false) }}
          onBlur={handleTextSubmit}
          placeholder="DD.MM.YYYY"
          style={{
            width: '100%', padding: '8px 14px', borderRadius: compact ? 4 : 10,
            border: isSlateMode ? '1px solid #cbd5e1' : '1px solid var(--text-faint)',
            background: isSlateMode ? '#fff' : 'var(--bg-input)',
            color: isSlateMode ? '#0f172a' : 'var(--text-primary)',
            fontSize: 13, fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          onDoubleClick={() => { setTextInput(value || ''); setIsTyping(true) }}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: compact ? 4 : 8,
            padding: compact ? '4px 6px' : '8px 14px', borderRadius: compact ? 4 : 10,
            border: borderless ? 'none' : isSlateMode ? '1px solid #e2e8f0' : '1px solid var(--border-primary)',
            background: borderless ? 'transparent' : isSlateMode ? '#fff' : 'var(--bg-input)',
            color: isSlateMode ? (displayValue ? '#0f172a' : '#94a3b8') : (displayValue ? 'var(--text-primary)' : 'var(--text-faint)'),
            fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
            transition: 'all 0.15s ease',
            boxSizing: 'border-box',
            boxShadow: open && isSlateMode ? '0 0 0 3px rgba(203,213,225,0.35)' : 'none',
          }}
          onMouseEnter={e => {
            if (borderless) return
            e.currentTarget.style.borderColor = isSlateMode ? '#cbd5e1' : 'var(--text-faint)'
            if (isSlateMode) e.currentTarget.style.background = '#f8fafc'
          }}
          onMouseLeave={e => {
            if (borderless) return
            if (!open) e.currentTarget.style.borderColor = isSlateMode ? '#e2e8f0' : 'var(--border-primary)'
            if (isSlateMode) e.currentTarget.style.background = '#fff'
          }}
        >
          {!compact && <Calendar size={14} style={{ color: isSlateMode ? '#94a3b8' : 'var(--text-faint)', flexShrink: 0 }} />}
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayValue || placeholder || t('common.date')}</span>
        </button>
      )}

      {open && ReactDOM.createPortal(
        <div
          ref={dropRef}
          style={{
            position: 'fixed',
            ...(() => {
              const r = ref.current?.getBoundingClientRect()
              if (!r) return { top: 0, left: 0 }
              const w = 272
              const h = 332
              const pad = 8
              const vw = window.innerWidth
              const vh = window.innerHeight
              let left = r.left
              let top = r.bottom + 4
              if (left + w > vw - pad) left = Math.max(pad, vw - w - pad)
              if (top + h > vh) top = Math.max(pad, r.top - h)
              if (vw < 360) left = Math.max(pad, (vw - w) / 2)
              return { top, left }
            })(),
            zIndex: 99999,
            background: isSlateMode ? '#ffffff' : 'var(--bg-card)',
            border: isSlateMode ? '1px solid #e2e8f0' : '1px solid var(--border-primary)',
            borderRadius: 16,
            boxShadow: isSlateMode ? '0 20px 40px rgba(15, 23, 42, 0.14)' : '0 8px 32px rgba(0,0,0,0.12)',
            padding: 14,
            width: 272,
            maxWidth: 'calc(100vw - 16px)',
            animation: 'selectIn 0.15s ease-out',
            backdropFilter: isSlateMode ? 'none' : 'blur(24px)',
            WebkitBackdropFilter: isSlateMode ? 'none' : 'blur(24px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <button
              type="button"
              onClick={shiftBackward}
              style={navButtonStyle}
              onMouseEnter={e => {
                e.currentTarget.style.color = isSlateMode ? '#0f172a' : 'var(--text-primary)'
                if (isSlateMode) {
                  e.currentTarget.style.background = '#f1f5f9'
                  e.currentTarget.style.borderColor = '#cbd5e1'
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = isSlateMode ? '#64748b' : 'var(--text-faint)'
                if (isSlateMode) {
                  e.currentTarget.style.background = '#f8fafc'
                  e.currentTarget.style.borderColor = '#e2e8f0'
                }
              }}
            >
              <ChevronLeft size={16} />
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => setPanelMode(mode => mode === 'months' ? 'days' : 'months')}
                style={{
                  ...triggerButtonStyle,
                  flex: 1,
                  background: panelMode === 'months'
                    ? isSlateMode ? '#e2e8f0' : 'var(--bg-hover)'
                    : isSlateMode ? '#f8fafc' : 'var(--bg-input)'
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {monthOptions[viewMonth].label}
                </span>
                <ChevronDown size={12} style={{ color: isSlateMode ? '#64748b' : 'var(--text-faint)', transform: panelMode === 'months' ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
              </button>

              <button
                type="button"
                onClick={() => setPanelMode(mode => mode === 'years' ? 'days' : 'years')}
                style={{
                  ...triggerButtonStyle,
                  width: 86,
                  flexShrink: 0,
                  background: panelMode === 'years'
                    ? isSlateMode ? '#e2e8f0' : 'var(--bg-hover)'
                    : isSlateMode ? '#f8fafc' : 'var(--bg-input)'
                }}
              >
                <span>{viewYear}</span>
                <ChevronDown size={12} style={{ color: isSlateMode ? '#64748b' : 'var(--text-faint)', transform: panelMode === 'years' ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
              </button>
            </div>

            <button
              type="button"
              onClick={shiftForward}
              style={navButtonStyle}
              onMouseEnter={e => {
                e.currentTarget.style.color = isSlateMode ? '#0f172a' : 'var(--text-primary)'
                if (isSlateMode) {
                  e.currentTarget.style.background = '#f1f5f9'
                  e.currentTarget.style.borderColor = '#cbd5e1'
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = isSlateMode ? '#64748b' : 'var(--text-faint)'
                if (isSlateMode) {
                  e.currentTarget.style.background = '#f8fafc'
                  e.currentTarget.style.borderColor = '#e2e8f0'
                }
              }}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {panelMode === 'months' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, minHeight: 246 }}>
              {monthOptions.map((option, index) => {
                const active = index === viewMonth
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setViewMonth(index)
                      setPanelMode('days')
                    }}
                    style={{
                      padding: '12px 8px',
                      borderRadius: 10,
                      border: isSlateMode ? `1px solid ${active ? '#0f172a' : '#e2e8f0'}` : 'none',
                      background: active ? (isSlateMode ? '#0f172a' : 'var(--accent)') : (isSlateMode ? '#fff' : 'var(--bg-input)'),
                      color: active ? (isSlateMode ? '#fff' : 'var(--accent-text)') : (isSlateMode ? '#334155' : 'var(--text-primary)'),
                      fontSize: 12,
                      fontWeight: active ? 700 : 600,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      transition: 'all 0.12s ease',
                    }}
                    onMouseEnter={e => {
                      if (!active && isSlateMode) e.currentTarget.style.background = '#f8fafc'
                    }}
                    onMouseLeave={e => {
                      if (!active && isSlateMode) e.currentTarget.style.background = '#fff'
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          ) : panelMode === 'years' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, minHeight: 246 }}>
              {yearOptions.map((year) => {
                const active = year === viewYear
                return (
                  <button
                    key={year}
                    type="button"
                    onClick={() => {
                      setViewYear(year)
                      setPanelMode('days')
                    }}
                    style={{
                      padding: '12px 8px',
                      borderRadius: 10,
                      border: isSlateMode ? `1px solid ${active ? '#0f172a' : '#e2e8f0'}` : 'none',
                      background: active ? (isSlateMode ? '#0f172a' : 'var(--accent)') : (isSlateMode ? '#fff' : 'var(--bg-input)'),
                      color: active ? (isSlateMode ? '#fff' : 'var(--accent-text)') : (isSlateMode ? '#334155' : 'var(--text-primary)'),
                      fontSize: 12,
                      fontWeight: active ? 700 : 600,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      transition: 'all 0.12s ease',
                    }}
                    onMouseEnter={e => {
                      if (!active && isSlateMode) e.currentTarget.style.background = '#f8fafc'
                    }}
                    onMouseLeave={e => {
                      if (!active && isSlateMode) e.currentTarget.style.background = '#fff'
                    }}
                  >
                    {year}
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
                {weekdays.map((d, i) => (
                  <div key={i} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: isSlateMode ? '#94a3b8' : 'var(--text-faint)', padding: '2px 0' }}>{d}</div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, minHeight: 246 }}>
                {Array.from({ length: startDay }, (_, i) => <div key={`e-${i}`} />)}
                {Array.from({ length: days }, (_, i) => {
                  const d = i + 1
                  const sel = d === selectedDay
                  const td = isToday(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => selectDay(d)}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 9,
                        border: isSlateMode && !sel ? '1px solid transparent' : 'none',
                        background: sel ? (isSlateMode ? '#0f172a' : 'var(--accent)') : 'transparent',
                        color: sel ? (isSlateMode ? '#fff' : 'var(--accent-text)') : (isSlateMode ? '#0f172a' : 'var(--text-primary)'),
                        fontSize: 12,
                        fontWeight: sel ? 700 : td ? 600 : 400,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        outline: td && !sel ? (isSlateMode ? '2px solid #cbd5e1' : '2px solid var(--border-primary)') : 'none',
                        outlineOffset: -2,
                        transition: 'all 0.12s ease',
                      }}
                      onMouseEnter={e => {
                        if (!sel) {
                          e.currentTarget.style.background = isSlateMode ? '#f1f5f9' : 'var(--bg-hover)'
                          if (isSlateMode) e.currentTarget.style.borderColor = '#e2e8f0'
                        }
                      }}
                      onMouseLeave={e => {
                        if (!sel) {
                          e.currentTarget.style.background = 'transparent'
                          if (isSlateMode) e.currentTarget.style.borderColor = 'transparent'
                        }
                      }}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {value && (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => { onChange(''); setOpen(false) }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: isSlateMode ? '#94a3b8' : 'var(--text-faint)',
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontWeight: 600,
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = '#ef4444'
                  if (isSlateMode) e.currentTarget.style.background = '#fef2f2'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = isSlateMode ? '#94a3b8' : 'var(--text-faint)'
                  if (isSlateMode) e.currentTarget.style.background = 'transparent'
                }}
              >
                <X size={12} />
              </button>
            </div>
          )}
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

interface CustomDateTimePickerProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  style?: React.CSSProperties
}

export function CustomDateTimePicker({ value, onChange, placeholder, style = {} }: CustomDateTimePickerProps) {
  const [datePart, timePart] = (value || '').split('T')

  const handleDateChange = (d: string) => {
    onChange(d ? `${d}T${timePart || '12:00'}` : '')
  }

  const handleTimeChange = (t: string) => {
    const d = datePart || new Date().toISOString().split('T')[0]
    onChange(t ? `${d}T${t}` : d)
  }

  return (
    <div style={{ display: 'flex', gap: 8, ...style }}>
      <CustomDatePicker value={datePart || ''} onChange={handleDateChange} style={{ flex: 1, minWidth: 0 }} placeholder={placeholder} />
      <div style={{ width: 110, flexShrink: 0 }}>
        <CustomTimePicker value={timePart || ''} onChange={handleTimeChange} />
      </div>
    </div>
  )
}

import CustomTimePicker from './CustomTimePicker'
