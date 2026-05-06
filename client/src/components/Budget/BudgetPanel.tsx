import ReactDOM from 'react-dom'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import DOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTranslation } from '../../i18n'
import { Plus, Trash2, Calculator, Wallet, Pencil, Users, Check, Info, ChevronDown, ChevronRight, Download, GripVertical, TrendingUp, TrendingDown, PieChart as PieChartIcon } from 'lucide-react'

function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  useEffect(() => {
    if (typeof document === 'undefined') return
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

function widgetTheme(dark: boolean) {
  if (dark) return {
    bg: 'linear-gradient(180deg, #17171d 0%, #0d0d12 100%)',
    border: 'rgba(255,255,255,0.07)',
    text: '#ffffff',
    sub: 'rgba(255,255,255,0.6)',
    faint: 'rgba(255,255,255,0.4)',
    track: 'rgba(255,255,255,0.04)',
    divider: 'rgba(255,255,255,0.07)',
    iconBg: 'rgba(255,255,255,0.08)',
    iconBorder: 'rgba(255,255,255,0.12)',
    iconColor: 'rgba(255,255,255,0.9)',
    centerBg: '#17171d',
    flowBg: 'rgba(255,255,255,0.05)',
    flowBorder: 'rgba(255,255,255,0.07)',
    flowHoverBg: 'rgba(255,255,255,0.08)',
    flowHoverBorder: 'rgba(255,255,255,0.12)',
    rowHover: 'rgba(255,255,255,0.03)',
    shadow: '0 20px 50px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
    donutShadow: 'drop-shadow(0 0 20px rgba(0,0,0,0.3))',
  }
  return {
    bg: 'linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)',
    border: 'rgba(15,23,42,0.08)',
    text: '#111827',
    sub: 'rgba(17,24,39,0.6)',
    faint: 'rgba(17,24,39,0.4)',
    track: 'rgba(15,23,42,0.05)',
    divider: 'rgba(15,23,42,0.08)',
    iconBg: 'rgba(15,23,42,0.05)',
    iconBorder: 'rgba(15,23,42,0.1)',
    iconColor: 'rgba(17,24,39,0.75)',
    centerBg: '#ffffff',
    flowBg: 'rgba(15,23,42,0.03)',
    flowBorder: 'rgba(15,23,42,0.08)',
    flowHoverBg: 'rgba(15,23,42,0.06)',
    flowHoverBorder: 'rgba(15,23,42,0.14)',
    rowHover: 'rgba(15,23,42,0.04)',
    shadow: '0 12px 32px rgba(15,23,42,0.08), 0 2px 6px rgba(0,0,0,0.04)',
    donutShadow: 'drop-shadow(0 4px 18px rgba(15,23,42,0.12))',
  }
}

function hexLighten(hex: string, amount: number): string {
  const m = hex.replace('#', '').match(/.{2}/g)
  if (!m || m.length !== 3) return hex
  const mix = (c: number) => Math.min(255, Math.round(c + (255 - c) * amount))
  const [r, g, b] = m.map(x => parseInt(x, 16))
  return `#${[mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
import CustomSelect from '../shared/CustomSelect'
import { budgetApi } from '../../api/client'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import type { BudgetItem, BudgetMember } from '../../types'
import { currencyDecimals } from '../../utils/formatters'

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface PieSegment {
  label: string
  value: number
  color: string
}

interface PerPersonSummaryEntry {
  user_id: number
  username: string
  avatar_url: string | null
  total_assigned: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CZK', 'PLN', 'SEK', 'NOK', 'DKK',
  'TRY', 'THB', 'AUD', 'CAD', 'NZD', 'BRL', 'MXN', 'INR', 'IDR', 'MYR',
  'PHP', 'SGD', 'KRW', 'CNY', 'HKD', 'TWD', 'ZAR', 'AED', 'SAR', 'ILS',
  'EGP', 'MAD', 'HUF', 'RON', 'BGN', 'HRK', 'ISK', 'RUB', 'UAH', 'BDT',
  'LKR', 'VND', 'CLP', 'COP', 'PEN', 'ARS',
]
const SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', CHF: 'CHF', CZK: 'Kč', PLN: 'zł',
  SEK: 'kr', NOK: 'kr', DKK: 'kr', TRY: '₺', THB: '฿', AUD: 'A$', CAD: 'C$',
  NZD: 'NZ$', BRL: 'R$', MXN: 'MX$', INR: '₹', IDR: 'Rp', MYR: 'RM',
  PHP: '₱', SGD: 'S$', KRW: '₩', CNY: '¥', HKD: 'HK$', TWD: 'NT$',
  ZAR: 'R', AED: 'د.إ', SAR: '﷼', ILS: '₪', EGP: 'E£', MAD: 'MAD',
  HUF: 'Ft', RON: 'lei', BGN: 'лв', HRK: 'kn', ISK: 'kr', RUB: '₽',
  UAH: '₴', BDT: '৳', LKR: 'Rs', VND: '₫', CLP: 'CL$', COP: 'CO$',
  PEN: 'S/.', ARS: 'AR$',
}
const PIE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#a855f7']

const fmtNum = (v, locale, cur) => {
  if (v == null || isNaN(v)) return '-'
  const d = currencyDecimals(cur)
  return Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + (SYMBOLS[cur] || cur)
}

const calcPP = (p, n) => (n > 0 ? p / n : null)
const calcPD = (p, d) => (d > 0 ? p / d : null)
const calcPPD = (p, n, d) => (n > 0 && d > 0 ? p / (n * d) : null)

// ── Inline Edit Cell ─────────────────────────────────────────────────────────
function InlineEditCell({ value, onSave, type = 'text', style = {}, placeholder = '', decimals = 2, locale, editTooltip, readOnly = false }) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value ?? '')
  const inputRef = useRef(null)

  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select() } }, [editing])

  const save = () => {
    setEditing(false)
    let v = editValue
    if (type === 'number') { const p = parseFloat(String(editValue).replace(',', '.')); v = isNaN(p) ? null : p }
    if (v !== value) onSave(v)
  }

  const handlePaste = (e) => {
    if (type !== 'number') return
    e.preventDefault()
    let text = e.clipboardData.getData('text').trim()
    // Strip everything except digits, dots, commas, minus
    text = text.replace(/[^\d.,-]/g, '')
    // Remove all thousand separators (dots or commas before 3-digit groups), keep last separator as decimal
    const lastComma = text.lastIndexOf(',')
    const lastDot = text.lastIndexOf('.')
    const decimalPos = Math.max(lastComma, lastDot)
    if (decimalPos > -1) {
      const intPart = text.substring(0, decimalPos).replace(/[.,]/g, '')
      const decPart = text.substring(decimalPos + 1)
      text = intPart + '.' + decPart
    } else {
      text = text.replace(/[.,]/g, '')
    }
    setEditValue(text)
  }

  if (editing) {
    return <input ref={inputRef} type="text" inputMode={type === 'number' ? 'decimal' : 'text'} value={editValue}
      onChange={e => setEditValue(e.target.value)} onBlur={save} onPaste={handlePaste}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditValue(value ?? ''); setEditing(false) } }}
      style={{ width: '100%', border: '1px solid var(--accent)', borderRadius: 4, padding: '4px 6px', fontSize: 13, outline: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', ...style }}
      placeholder={placeholder} />
  }

  const display = type === 'number' && value != null
    ? Number(value).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : (value || '')

  return (
    <div onClick={() => { if (readOnly) return; setEditValue(value ?? ''); setEditing(true) }} title={readOnly ? undefined : editTooltip}
      style={{ cursor: readOnly ? 'default' : 'pointer', padding: '2px 4px', borderRadius: 4, minHeight: 22, display: 'flex', alignItems: 'center',
        justifyContent: style?.textAlign === 'center' ? 'center' : 'flex-start', transition: 'background 0.15s',
        color: display ? 'var(--text-primary)' : 'var(--text-faint)', fontSize: 13, ...style }}
      onMouseEnter={e => { if (!readOnly) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!readOnly) e.currentTarget.style.background = 'transparent' }}>
      {display || placeholder || '-'}
    </div>
  )
}

// ── Add Item Row ─────────────────────────────────────────────────────────────
interface AddItemRowProps {
  onAdd: (data: { name: string; total_price: number; persons: number | null; days: number | null; note: string | null; expense_date: string | null }) => void
  t: (key: string) => string
}

function AddItemRow({ onAdd, t }: AddItemRowProps) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [persons, setPersons] = useState('')
  const [days, setDays] = useState('')
  const [note, setNote] = useState('')
  const [expenseDate, setExpenseDate] = useState('')
  const nameRef = useRef(null)

  const handleAdd = () => {
    if (!name.trim()) return
    onAdd({ name: name.trim(), total_price: parseFloat(String(price).replace(',', '.')) || 0, persons: parseInt(persons) || null, days: parseInt(days) || null, note: note.trim() || null, expense_date: expenseDate || null })
    setName(''); setPrice(''); setPersons(''); setDays(''); setNote(''); setExpenseDate('')
    setTimeout(() => nameRef.current?.focus(), 50)
  }

  const inp = { border: '1px solid var(--border-primary)', borderRadius: 4, padding: '4px 6px', fontSize: 13, outline: 'none', fontFamily: 'inherit', width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)' }

  return (
    <tr style={{ background: 'var(--bg-secondary)' }}>
      <td style={{ padding: '4px 6px' }}>
        <input ref={nameRef} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder={t('budget.newEntry')} style={inp} />
      </td>
      <td style={{ padding: '4px 6px' }}>
        <input value={price} onChange={e => setPrice(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
          onPaste={e => { e.preventDefault(); let t = e.clipboardData.getData('text').trim().replace(/[^\d.,-]/g, ''); const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.'), dp = Math.max(lc, ld); if (dp > -1) { t = t.substring(0, dp).replace(/[.,]/g, '') + '.' + t.substring(dp + 1) } else { t = t.replace(/[.,]/g, '') } setPrice(t) }}
          placeholder="0,00" inputMode="decimal" style={{ ...inp, textAlign: 'center' }} />
      </td>
      <td className="hidden sm:table-cell" style={{ padding: '4px 6px', textAlign: 'center' }}>
        <input value={persons} onChange={e => setPersons(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="-" inputMode="numeric" style={{ ...inp, textAlign: 'center', maxWidth: 60, margin: '0 auto' }} />
      </td>
      <td className="hidden sm:table-cell" style={{ padding: '4px 6px', textAlign: 'center' }}>
        <input value={days} onChange={e => setDays(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="-" inputMode="numeric" style={{ ...inp, textAlign: 'center', maxWidth: 60, margin: '0 auto' }} />
      </td>
      <td className="hidden md:table-cell" style={{ padding: '4px 6px', color: 'var(--text-faint)', fontSize: 12, textAlign: 'center' }}>-</td>
      <td className="hidden md:table-cell" style={{ padding: '4px 6px', color: 'var(--text-faint)', fontSize: 12, textAlign: 'center' }}>-</td>
      <td className="hidden lg:table-cell" style={{ padding: '4px 6px', color: 'var(--text-faint)', fontSize: 12, textAlign: 'center' }}>-</td>
      <td className="hidden sm:table-cell" style={{ padding: '4px 6px', textAlign: 'center' }}>
        <div style={{ maxWidth: 90, margin: '0 auto' }}>
          <CustomDatePicker value={expenseDate} onChange={setExpenseDate} placeholder="-" compact />
        </div>
      </td>
      <td className="hidden sm:table-cell" style={{ padding: '4px 6px' }}>
        <input value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder={t('budget.table.note')} style={inp} />
      </td>
      <td style={{ padding: '4px 6px', textAlign: 'center' }}>
        <button onClick={handleAdd} disabled={!name.trim()} title={t('reservations.add')}
          style={{ background: name.trim() ? 'var(--text-primary)' : 'var(--border-primary)', border: 'none', borderRadius: 4, color: 'var(--bg-primary)',
            cursor: name.trim() ? 'pointer' : 'default', padding: '4px 8px', display: 'inline-flex', alignItems: 'center' }}>
          <Plus size={14} />
        </button>
      </td>
    </tr>
  )
}

// ── Chip with custom tooltip ─────────────────────────────────────────────────
interface ChipWithTooltipProps {
  label: string
  avatarUrl: string | null
  size?: number
  paid?: boolean
  onClick?: () => void
}

function ChipWithTooltip({ label, avatarUrl, size = 20, paid, onClick }: ChipWithTooltipProps) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef(null)

  const onEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  const borderColor = paid ? '#22c55e' : 'var(--border-primary)'
  const bg = paid ? 'rgba(34,197,94,0.15)' : 'var(--bg-tertiary)'

  return (
    <>
      <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHover(false)}
        onClick={onClick}
        style={{
          width: size, height: size, borderRadius: '50%', border: `2px solid ${borderColor}`,
          background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.4, fontWeight: 700, color: paid ? '#16a34a' : 'var(--text-muted)',
          overflow: 'hidden', flexShrink: 0, cursor: onClick ? 'pointer' : 'default',
          transition: 'border-color 0.15s, background 0.15s',
        }}>
        {avatarUrl
          ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : label?.[0]?.toUpperCase()
        }
      </div>
      {hover && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)',
          pointerEvents: 'none', zIndex: 10000, whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center', gap: 5,
          background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
          fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint, #e5e7eb)',
        }}>
          {label}
          {paid && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
              background: 'rgba(34,197,94,0.15)', color: '#16a34a',
              textTransform: 'uppercase', letterSpacing: '0.03em',
            }}>Paid</span>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Budget Member Chips (for Persons column) ────────────────────────────────
interface BudgetMemberChipsProps {
  members?: BudgetMember[]
  tripMembers?: TripMember[]
  onSetMembers: (memberIds: number[]) => void
  onTogglePaid?: (userId: number, paid: boolean) => void
  compact?: boolean
  readOnly?: boolean
}

function BudgetMemberChips({ members = [], tripMembers = [], onSetMembers, onTogglePaid, compact = true, readOnly = false }: BudgetMemberChipsProps) {
  const chipSize = compact ? 20 : 30
  const btnSize = compact ? 18 : 28
  const iconSize = compact ? (members.length > 0 ? 8 : 9) : (members.length > 0 ? 12 : 14)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const dropRef = useRef(null)

  const openDropdown = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setDropPos({ top: rect.bottom + 4, left: rect.left + rect.width / 2 })
    }
    setShowDropdown(v => !v)
  }, [])

  useEffect(() => {
    if (!showDropdown) return
    const close = (e) => {
      if (dropRef.current && dropRef.current.contains(e.target)) return
      if (btnRef.current && btnRef.current.contains(e.target)) return
      setShowDropdown(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showDropdown])

  const memberIds = members.map(m => m.user_id)

  const toggleMember = (userId) => {
    const newIds = memberIds.includes(userId)
      ? memberIds.filter(id => id !== userId)
      : [...memberIds, userId]
    onSetMembers(newIds)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
      {members.map(m => (
        <ChipWithTooltip key={m.user_id} label={m.username} avatarUrl={m.avatar_url} size={chipSize}
          paid={!!m.paid}
          onClick={!readOnly && onTogglePaid ? () => onTogglePaid(m.user_id, !m.paid) : undefined}
        />
      ))}
      {!readOnly && (
        <button ref={btnRef} onClick={openDropdown}
          style={{
            width: btnSize, height: btnSize, borderRadius: '50%', border: '1.5px dashed var(--border-primary)',
            background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-faint)', padding: 0, flexShrink: 0,
          }}>
          {members.length > 0 ? <Pencil size={iconSize} /> : <Users size={iconSize} />}
        </button>
      )}
      {showDropdown && ReactDOM.createPortal(
        <div ref={dropRef} style={{
          position: 'fixed', top: dropPos.top, left: dropPos.left, transform: 'translateX(-50%)', zIndex: 10000,
          background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 150,
        }}>
          {tripMembers.map(tm => {
            const isActive = memberIds.includes(tm.id)
            return (
              <button key={tm.id} onClick={() => toggleMember(tm.id)} style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '5px 8px',
                borderRadius: 6, border: 'none', background: isActive ? 'var(--bg-hover)' : 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11, color: 'var(--text-primary)', textAlign: 'left',
              }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'none' }}
              >
                <div style={{
                  width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-tertiary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700,
                  color: 'var(--text-muted)', overflow: 'hidden', flexShrink: 0,
                }}>
                  {tm.avatar_url
                    ? <img src={tm.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : tm.username?.[0]?.toUpperCase()
                  }
                </div>
                <span style={{ flex: 1 }}>{tm.username}</span>
                {isActive && <Check size={12} color="var(--text-primary)" />}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Per-Person Inline (inside total card) ────────────────────────────────────
interface PerPersonInlineProps {
  tripId: number
  budgetItems: BudgetItem[]
  currency: string
  locale: string
}

const SPLIT_COLORS = [
  { solid: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)' },
  { solid: '#ec4899', gradient: 'linear-gradient(135deg, #ec4899, #f43f5e)' },
  { solid: '#10b981', gradient: 'linear-gradient(135deg, #10b981, #22c55e)' },
  { solid: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b, #f97316)' },
  { solid: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d4, #3b82f6)' },
  { solid: '#a855f7', gradient: 'linear-gradient(135deg, #a855f7, #d946ef)' },
]

export function splitColorFor(userId: number, order: number) {
  return SPLIT_COLORS[order % SPLIT_COLORS.length]
}

function colorForUserId(userId: number) {
  return SPLIT_COLORS[((userId | 0) - 1 + SPLIT_COLORS.length * 1000) % SPLIT_COLORS.length]
}

function RingAvatar({ userId, username, avatarUrl, size = 34, innerBg = '#17171d', textColor = '#fff' }: { userId: number; username?: string; avatarUrl?: string | null; size?: number; innerBg?: string; textColor?: string }) {
  const color = colorForUserId(userId)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      padding: 2, background: color.gradient,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', height: '100%', borderRadius: '50%',
        background: innerBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
        fontSize: size < 28 ? 10 : 12, fontWeight: 600, color: textColor,
      }}>
        {avatarUrl ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : username?.[0]?.toUpperCase()}
      </div>
    </div>
  )
}

function PerPersonInline({ tripId, budgetItems, currency, locale, grandTotal, theme }: PerPersonInlineProps & { grandTotal: number; theme: ReturnType<typeof widgetTheme> }) {
  const [data, setData] = useState<any[] | null>(null)
  const fmt = (v: number) => fmtNum(v, locale, currency)

  useEffect(() => {
    budgetApi.perPersonSummary(tripId).then(d => setData(d.summary)).catch(() => {})
  }, [tripId, budgetItems])

  if (!data || data.length === 0) return null

  const people = data.map((p: any) => ({ ...p, color: colorForUserId(p.user_id) }))

  return (
    <>
      {grandTotal > 0 && (
        <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', marginTop: 8, marginBottom: 4, gap: 3 }}>
          {people.map(p => (
            <div key={p.user_id} style={{
              height: '100%', borderRadius: 999,
              flex: Math.max(p.total_assigned || 0, 0.01),
              background: p.color.gradient,
            }} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${theme.divider}`, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {people.map(p => {
          const percent = grandTotal > 0 ? Math.round((p.total_assigned / grandTotal) * 100) : 0
          return (
            <div key={p.user_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
              <RingAvatar userId={p.user_id} username={p.username} avatarUrl={p.avatar_url} size={34} innerBg={theme.centerBg} textColor={theme.text} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.01em', color: theme.text }}>{p.username}</div>
                <div style={{ fontSize: 11, color: theme.faint, marginTop: 1 }}>{percent}%</div>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.text, letterSpacing: '-0.01em' }}>{fmt(p.total_assigned)}</div>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Pie Chart (pure CSS conic-gradient) ──────────────────────────────────────
interface PieChartProps {
  segments: PieSegment[]
  size?: number
  totalLabel: string
}

function PieChart({ segments, size = 200, totalLabel }: PieChartProps) {
  if (!segments.length) return null

  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0) return null

  let cumDeg = 0
  const stops = segments.map(seg => {
    const start = cumDeg
    const deg = (seg.value / total) * 360
    cumDeg += deg
    return `${seg.color} ${start}deg ${start + deg}deg`
  }).join(', ')

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
      <div
        className="trek-pie-reveal"
        style={{
          width: size, height: size, borderRadius: '50%',
          background: `conic-gradient(${stops})`,
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        }}
      />
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: size * 0.55, height: size * 0.55,
        borderRadius: '50%', background: 'var(--bg-card)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'inset 0 0 12px rgba(0,0,0,0.04)',
      }}>
        <Wallet size={18} color="var(--text-faint)" style={{ marginBottom: 2 }} />
        <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 500 }}>{totalLabel}</span>
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────
interface BudgetPanelProps {
  tripId: number
  tripMembers?: TripMember[]
}

export default function BudgetPanel({ tripId, tripMembers = [] }: BudgetPanelProps) {
  const { trip, budgetItems, addBudgetItem, updateBudgetItem, deleteBudgetItem, loadBudgetItems, updateTrip, setBudgetItemMembers, toggleBudgetMemberPaid, reorderBudgetItems, reorderBudgetCategories } = useTripStore()
  const can = useCanDo()
  const { t, locale } = useTranslation()
  const isDark = useIsDark()
  const theme = useMemo(() => widgetTheme(isDark), [isDark])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [editingCat, setEditingCat] = useState(null) // { name, value }
  const [settlement, setSettlement] = useState<{ balances: any[]; flows: any[] } | null>(null)
  const [settlementOpen, setSettlementOpen] = useState(false)
  const currency = trip?.currency || 'EUR'
  const canEdit = can('budget_edit', trip)

  const fmt = (v, cur) => fmtNum(v, locale, cur)
  const hasMultipleMembers = tripMembers.length > 1

  // Drag state for categories
  const [dragCat, setDragCat] = useState<string | null>(null)
  const [dragOverCat, setDragOverCat] = useState<string | null>(null)
  // Drag state for items within a category
  const [dragItem, setDragItem] = useState<number | null>(null)
  const [dragOverItem, setDragOverItem] = useState<number | null>(null)
  const [dragItemCat, setDragItemCat] = useState<string | null>(null)

  // Load settlement data whenever budget items change
  useEffect(() => {
    if (!hasMultipleMembers) return
    budgetApi.settlement(tripId).then(setSettlement).catch(() => {})
  }, [tripId, budgetItems, hasMultipleMembers])

  const setCurrency = (cur) => {
    if (tripId) updateTrip(tripId, { currency: cur })
  }

  useEffect(() => { if (tripId) loadBudgetItems(tripId) }, [tripId])

  const grouped = useMemo(() => {
    const map = new Map<string, BudgetItem[]>()
    for (const item of (budgetItems || [])) {
      const cat = item.category || 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(item)
    }
    return map
  }, [budgetItems])

  const categoryNames = Array.from(grouped.keys())

  // Stable color mapping: assign index-based colors once, never reassign on reorder
  const colorMapRef = useRef(new Map<string, string>())
  const categoryColor = useCallback((cat: string) => {
    const map = colorMapRef.current
    if (!map.has(cat)) {
      map.set(cat, PIE_COLORS[map.size % PIE_COLORS.length])
    }
    return map.get(cat)!
  }, [])
  const grandTotal = (budgetItems || []).reduce((s, i) => s + (i.total_price || 0), 0)

  const pieSegments = useMemo(() =>
    categoryNames.map((cat, i) => ({
      name: cat,
      value: (grouped.get(cat) || []).reduce((s, x) => s + (x.total_price || 0), 0),
      color: categoryColor(cat),
    })).filter(s => s.value > 0)
  , [grouped, categoryNames])

  const handleAddItem = async (category, data) => { try { await addBudgetItem(tripId, { ...data, category }) } catch {} }
  const handleUpdateField = async (id, field, value) => { try { await updateBudgetItem(tripId, id, { [field]: value }) } catch {} }
  const handleDeleteItem = async (id) => { try { await deleteBudgetItem(tripId, id) } catch {} }
  const handleDeleteCategory = async (cat) => {
    const items = grouped.get(cat) || []
    for (const item of Array.from(items)) await deleteBudgetItem(tripId, item.id)
  }
  const handleRenameCategory = async (oldName, newName) => {
    if (!newName.trim() || newName.trim() === oldName) return
    const items = grouped.get(oldName) || []
    for (const item of Array.from(items)) await updateBudgetItem(tripId, item.id, { category: newName.trim() })
  }
  const handleAddCategory = () => {
    if (!newCategoryName.trim()) return
    addBudgetItem(tripId, { name: t('budget.defaultEntry'), category: newCategoryName.trim(), total_price: 0 })
    setNewCategoryName('')
  }

  const handleExportCsv = () => {
    const sep = ';'
    const esc = (v: any) => { const s = String(v ?? ''); return s.includes(sep) || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s }
    const d = currencyDecimals(currency)
    const fmtPrice = (v: number | null | undefined) => v != null ? v.toFixed(d) : ''

    const fmtDate = (iso: string) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) }
    const header = ['Category', 'Name', 'Date', 'Total (' + currency + ')', 'Persons', 'Days', 'Per Person', 'Per Day', 'Per Person/Day', 'Note']
    const rows = [header.join(sep)]

    for (const cat of categoryNames) {
      for (const item of (grouped.get(cat) || [])) {
        const pp = calcPP(item.total_price, item.persons)
        const pd = calcPD(item.total_price, item.days)
        const ppd = calcPPD(item.total_price, item.persons, item.days)
        rows.push([
          esc(item.category), esc(item.name), esc(fmtDate(item.expense_date || '')),
          fmtPrice(item.total_price), item.persons ?? '', item.days ?? '',
          fmtPrice(pp), fmtPrice(pd), fmtPrice(ppd),
          esc(item.note || ''),
        ].join(sep))
      }
    }

    const bom = '\uFEFF'
    const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = (trip?.title || 'trip').replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '').trim()
    a.download = `budget-${safeName}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const th = { padding: '6px 8px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-primary)', whiteSpace: 'nowrap', background: 'var(--bg-secondary)' }
  const td = { padding: '2px 6px', borderBottom: '1px solid var(--border-secondary)', fontSize: 13, verticalAlign: 'middle', color: 'var(--text-primary)' }

  // ── Empty State ──────────────────────────────────────────────────────────
  if (!budgetItems || budgetItems.length === 0) {
    return (
      <div style={{ padding: 24, maxWidth: 600, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <Calculator size={28} color="#6b7280" />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>{t('budget.emptyTitle')}</h2>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 24px', lineHeight: 1.5 }}>{t('budget.emptyText')}</p>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'stretch', maxWidth: 320, margin: '0 auto' }}>
            <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
              placeholder={t('budget.emptyPlaceholder')}
              style={{ flex: 1, padding: '9px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', minWidth: 0 }} />
            <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
              style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 10, padding: '0 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', opacity: newCategoryName.trim() ? 1 : 0.5, flexShrink: 0 }}>
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>
    )
  }

  // ── Main Layout ──────────────────────────────────────────────────────────
  const totalBudget = budgetItems.reduce((s, x) => s + (x.total_price || 0), 0)
  return (
    <div>
      <div style={{ padding: '24px 28px 0' }} className="max-md:!px-4 max-md:!pt-4">
        <div style={{
          background: 'var(--bg-tertiary)', borderRadius: 18,
          padding: '14px 16px 14px 22px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', flexShrink: 0 }}>
            {t('budget.title')}
          </h2>
          <div className="flex flex-wrap max-md:!w-full max-md:!mt-2" style={{ alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
            <div className="max-md:!w-full" style={{ width: 150 }}>
              <CustomSelect
                value={currency}
                onChange={setCurrency}
                disabled={!canEdit}
                options={CURRENCIES.map(c => ({ value: c, label: `${c} (${SYMBOLS[c] || c})` }))}
                searchable
              />
            </div>
            {canEdit && (
              <div className="max-md:!w-full" style={{ display: 'flex', gap: 6, width: 260 }}>
                <input
                  value={newCategoryName}
                  onChange={e => setNewCategoryName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddCategory() }}
                  placeholder={t('budget.categoryName')}
                  style={{ flex: 1, minWidth: 0, border: '1px solid var(--border-primary)', borderRadius: 10, padding: '9px 14px', fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                />
                <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
                  title={t('budget.addCategory')}
                  style={{
                    appearance: 'none', border: 'none', cursor: newCategoryName.trim() ? 'pointer' : 'default', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                    background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
                    opacity: newCategoryName.trim() ? 1 : 0.4,
                    transition: 'opacity 0.15s ease',
                  }}>
                  <Plus size={14} strokeWidth={2.5} />
                </button>
              </div>
            )}
            <button onClick={handleExportCsv} title={t('budget.exportCsv')}
              style={{
                appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
                transition: 'opacity 0.15s ease',
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              <Download size={14} strokeWidth={2.5} /> <span className="hidden sm:inline">CSV</span>
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, padding: '24px 28px 40px', alignItems: 'flex-start', flexWrap: 'wrap' }} className="max-md:!px-4">
        <div style={{ flex: 1, minWidth: 0 }}>
          {categoryNames.map((cat, ci) => {
            const items = grouped.get(cat) || []
            const subtotal = items.reduce((s, x) => s + (x.total_price || 0), 0)
            const color = categoryColor(cat)

            return (
              <div key={cat} data-drag-cat={cat} style={{
                  marginBottom: 16, opacity: dragCat === cat ? 0.4 : 1,
                  transition: 'opacity 0.15s',
                  position: 'relative',
                }}
                onDragOver={e => {
                  if (!dragCat || dragCat === cat || dragItem) return
                  e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                  setDragOverCat(cat)
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCat(null)
                }}
                onDrop={e => {
                  e.preventDefault()
                  if (dragCat && dragCat !== cat) {
                    const newOrder = [...categoryNames]
                    const fromIdx = newOrder.indexOf(dragCat)
                    const toIdx = newOrder.indexOf(cat)
                    newOrder.splice(fromIdx, 1)
                    newOrder.splice(toIdx, 0, dragCat)
                    reorderBudgetCategories(tripId, newOrder)
                  }
                  setDragCat(null); setDragOverCat(null)
                }}
              >
                {dragOverCat === cat && <div style={{ position: 'absolute', top: -2, left: 0, right: 0, height: 4, background: 'var(--accent)', borderRadius: 2, zIndex: 10 }} />}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#000000', color: '#fff',
                  borderRadius: '10px 10px 0 0', padding: '9px 14px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                    {canEdit && (
                      <div draggable onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-budget-cat', cat); setDragCat(cat) }}
                        onDragEnd={() => { setDragCat(null); setDragOverCat(null) }}
                        style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
                        <GripVertical size={14} />
                      </div>
                    )}
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
                    {canEdit && editingCat?.name === cat ? (
                      <input
                        autoFocus
                        value={editingCat.value}
                        onChange={e => setEditingCat({ ...editingCat, value: e.target.value })}
                        onBlur={() => { handleRenameCategory(cat, editingCat.value); setEditingCat(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') { handleRenameCategory(cat, editingCat.value); setEditingCat(null) } if (e.key === 'Escape') setEditingCat(null) }}
                        style={{ fontWeight: 600, fontSize: 13, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', padding: '1px 6px', outline: 'none', fontFamily: 'inherit', width: '100%' }}
                      />
                    ) : (
                      <>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{cat}</span>
                        {canEdit && (
                          <button onClick={() => setEditingCat({ name: cat, value: cat })}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', padding: 1 }}
                            onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}>
                            <Pencil size={10} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.9 }}>{fmt(subtotal, currency)}</span>
                    {canEdit && (
                      <button onClick={() => handleDeleteCategory(cat)} title={t('budget.deleteCategory')}
                        style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center', opacity: 0.6 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'} onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ overflowX: 'auto', border: '1px solid var(--border-primary)', borderTop: 'none', borderRadius: '0 0 10px 10px' }}
                  onDragOver={e => { if (dragCat) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left', minWidth: 120 }}>{t('budget.table.name')}</th>
                        <th style={{ ...th, minWidth: 75 }}>{t('budget.table.total')}</th>
                        <th className="hidden sm:table-cell" style={{ ...th, minWidth: 160 }}>{t('budget.table.persons')}</th>
                        <th className="hidden sm:table-cell" style={{ ...th, minWidth: 55 }}>{t('budget.table.days')}</th>
                        <th className="hidden md:table-cell" style={{ ...th, minWidth: 100 }}>{t('budget.table.perPerson')}</th>
                        <th className="hidden md:table-cell" style={{ ...th, minWidth: 90 }}>{t('budget.table.perDay')}</th>
                        <th className="hidden lg:table-cell" style={{ ...th, minWidth: 95 }}>{t('budget.table.perPersonDay')}</th>
                        <th className="hidden sm:table-cell" style={{ ...th, width: 90, maxWidth: 90 }}>{t('budget.table.date')}</th>
                        <th className="hidden sm:table-cell" style={{ ...th, minWidth: 150 }}>{t('budget.table.note')}</th>
                        <th style={{ ...th, width: 36 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(item => {
                        const pp = calcPP(item.total_price, item.persons)
                        const pd = calcPD(item.total_price, item.days)
                        const ppd = calcPPD(item.total_price, item.persons, item.days)
                        const hasMembers = item.members?.length > 0
                        return (
                          <tr key={item.id}
                            style={{
                              transition: 'background 0.1s, opacity 0.15s',
                              opacity: dragItem === item.id ? 0.4 : 1,
                              boxShadow: dragOverItem === item.id ? 'inset 4px 0 0 0 var(--accent)' : 'none',
                            }}
                            onDragOver={e => {
                              if (dragCat && dragCat !== cat) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; return }
                              if (dragItem && dragItemCat === cat && dragItem !== item.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverItem(item.id) }
                            }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverItem(null) }}
                            onDrop={e => {
                              if (dragItem && dragItemCat === cat && dragItem !== item.id) {
                                e.preventDefault(); e.stopPropagation()
                                const ids = items.map(i => i.id)
                                const fromIdx = ids.indexOf(dragItem)
                                const toIdx = ids.indexOf(item.id)
                                ids.splice(fromIdx, 1)
                                ids.splice(toIdx, 0, dragItem)
                                reorderBudgetItems(tripId, ids)
                                setDragItem(null); setDragOverItem(null); setDragItemCat(null)
                              }
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <td style={td}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {canEdit && (
                                  <div draggable onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; setDragItem(item.id); setDragItemCat(cat) }}
                                    onDragEnd={() => { setDragItem(null); setDragOverItem(null); setDragItemCat(null) }}
                                    style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: 'var(--text-faint)', flexShrink: 0 }}>
                                    <GripVertical size={12} />
                                  </div>
                                )}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <InlineEditCell value={item.name} onSave={v => handleUpdateField(item.id, 'name', v)} placeholder={t('budget.table.name')} locale={locale} editTooltip={item.reservation_id ? t('budget.linkedToReservation') : t('budget.editTooltip')} readOnly={!canEdit || !!item.reservation_id} />
                                  {hasMultipleMembers && (
                                    <div className="sm:hidden" style={{ marginTop: 4 }}>
                                      <BudgetMemberChips
                                        members={item.members || []}
                                        tripMembers={tripMembers}
                                        onSetMembers={(userIds) => setBudgetItemMembers(tripId, item.id, userIds)}
                                        onTogglePaid={(userId, paid) => toggleBudgetMemberPaid(tripId, item.id, userId, paid)}
                                        compact={false}
                                        readOnly={!canEdit}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td style={{ ...td, textAlign: 'center' }}>
                              <InlineEditCell value={item.total_price} type="number" decimals={currencyDecimals(currency)} onSave={v => handleUpdateField(item.id, 'total_price', v)} style={{ textAlign: 'center' }} placeholder={currencyDecimals(currency) === 0 ? '0' : '0,00'} locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} />
                            </td>
                            <td className="hidden sm:table-cell" style={{ ...td, textAlign: 'center', position: 'relative' }}>
                              {hasMultipleMembers ? (
                                <BudgetMemberChips
                                  members={item.members || []}
                                  tripMembers={tripMembers}
                                  onSetMembers={(userIds) => setBudgetItemMembers(tripId, item.id, userIds)}
                                  onTogglePaid={(userId, paid) => toggleBudgetMemberPaid(tripId, item.id, userId, paid)}
                                  readOnly={!canEdit}
                                />
                              ) : (
                                <InlineEditCell value={item.persons} type="number" decimals={0} onSave={v => handleUpdateField(item.id, 'persons', v != null ? parseInt(v) || null : null)} style={{ textAlign: 'center' }} placeholder="-" locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} />
                              )}
                            </td>
                            <td className="hidden sm:table-cell" style={{ ...td, textAlign: 'center' }}>
                              <InlineEditCell value={item.days} type="number" decimals={0} onSave={v => handleUpdateField(item.id, 'days', v != null ? parseInt(v) || null : null)} style={{ textAlign: 'center' }} placeholder="-" locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} />
                            </td>
                            <td className="hidden md:table-cell" style={{ ...td, textAlign: 'center', color: pp != null ? 'var(--text-secondary)' : 'var(--text-faint)' }}>{pp != null ? fmt(pp, currency) : '-'}</td>
                            <td className="hidden md:table-cell" style={{ ...td, textAlign: 'center', color: pd != null ? 'var(--text-secondary)' : 'var(--text-faint)' }}>{pd != null ? fmt(pd, currency) : '-'}</td>
                            <td className="hidden lg:table-cell" style={{ ...td, textAlign: 'center', color: ppd != null ? 'var(--text-secondary)' : 'var(--text-faint)' }}>{ppd != null ? fmt(ppd, currency) : '-'}</td>
                            <td className="hidden sm:table-cell" style={{ ...td, padding: '2px 6px', width: 90, maxWidth: 90, textAlign: 'center' }}>
                              {canEdit ? (
                                <div style={{ maxWidth: 90, margin: '0 auto' }}>
                                  <CustomDatePicker value={item.expense_date || ''} onChange={v => handleUpdateField(item.id, 'expense_date', v || null)} placeholder="—" compact borderless />
                                </div>
                              ) : (
                                <span style={{ fontSize: 11, color: item.expense_date ? 'var(--text-secondary)' : 'var(--text-faint)' }}>{item.expense_date || '—'}</span>
                              )}
                            </td>
                            <td className="hidden sm:table-cell" style={td}><InlineEditCell value={item.note} onSave={v => handleUpdateField(item.id, 'note', v)} placeholder={t('budget.table.note')} locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} /></td>
                            <td style={{ ...td, textAlign: 'center' }}>
                              {canEdit && (
                              <button onClick={() => handleDeleteItem(item.id)} title={t('common.delete')}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-faint)', borderRadius: 4, display: 'inline-flex', transition: 'color 0.15s' }}
                                onMouseEnter={e => e.currentTarget.style.color = '#ef4444'} onMouseLeave={e => e.currentTarget.style.color = '#d1d5db'}>
                                <Trash2 size={14} />
                              </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                      {canEdit && <AddItemRow onAdd={data => handleAddItem(cat, data)} t={t} />}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>

        <div className="w-full md:w-[320px]" style={{ flexShrink: 0, position: 'sticky', top: 16, alignSelf: 'flex-start' }}>

          <div style={{
            background: theme.bg,
            borderRadius: 20, padding: 20, color: theme.text, marginBottom: 16,
            border: `1px solid ${theme.border}`,
            boxShadow: theme.shadow,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: theme.iconBg,
                border: `1px solid ${theme.iconBorder}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: theme.iconColor, flexShrink: 0,
              }}>
                <Wallet size={20} strokeWidth={2} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: theme.faint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.09em' }}>{t('budget.totalBudget')}</div>
              </div>
            </div>

            {(() => {
              const decimals = currencyDecimals(currency)
              const full = Number(grandTotal).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
              const sep = (0.1).toLocaleString(locale).replace(/\d/g, '')
              const [integerPart, decimalPart] = decimals > 0 ? full.split(sep) : [full, '']
              return (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, letterSpacing: '-0.03em', lineHeight: 1 }}>
                  <span style={{ fontSize: 38, fontWeight: 700 }}>{integerPart}</span>
                  {decimalPart && <span style={{ fontSize: 22, fontWeight: 500, color: theme.sub }}>{sep}{decimalPart}</span>}
                  <span style={{ fontSize: 22, fontWeight: 500, color: theme.sub, marginLeft: 2 }}>{SYMBOLS[currency] || currency}</span>
                </div>
              )
            })()}
            <div style={{ color: theme.faint, fontSize: 12, marginTop: 8, fontWeight: 500, letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{currency}</span>
            </div>

            {hasMultipleMembers && (budgetItems || []).some(i => i.members?.length > 0) && (
              <PerPersonInline tripId={tripId} budgetItems={budgetItems} currency={currency} locale={locale} grandTotal={grandTotal} theme={theme} />
            )}

            {/* Settlement dropdown inside the total card */}
            {hasMultipleMembers && settlement && settlement.flows.length > 0 && (
              <div style={{ marginTop: 16, borderTop: `1px solid ${theme.divider}`, paddingTop: 12 }}>
                <button onClick={() => setSettlementOpen(v => !v)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit',
                  color: theme.sub, fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                }}>
                  {settlementOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t('budget.settlement')}
                  <span style={{ position: 'relative', display: 'inline-flex', marginLeft: 2 }}>
                    <span style={{ display: 'flex', cursor: 'help' }}
                      onMouseEnter={e => { const tip = e.currentTarget.nextElementSibling as HTMLElement; if (tip) tip.style.display = 'block' }}
                      onMouseLeave={e => { const tip = e.currentTarget.nextElementSibling as HTMLElement; if (tip) tip.style.display = 'none' }}
                      onClick={e => e.stopPropagation()}
                    >
                      <Info size={11} strokeWidth={2} />
                    </span>
                    <div style={{
                      display: 'none', position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                      marginTop: 6, width: 220, padding: '10px 12px', borderRadius: 10, zIndex: 100,
                      background: 'var(--bg-card)', border: '1px solid var(--border-faint)',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                      fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5, textAlign: 'left',
                    }}>
                      {t('budget.settlementInfo')}
                    </div>
                  </span>
                </button>

                {settlementOpen && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {settlement.flows.map((flow, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        padding: '12px 14px', borderRadius: 14,
                        background: theme.flowBg,
                        border: `1px solid ${theme.flowBorder}`,
                        transition: 'all 0.2s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = theme.flowHoverBg; e.currentTarget.style.borderColor = theme.flowHoverBorder }}
                        onMouseLeave={e => { e.currentTarget.style.background = theme.flowBg; e.currentTarget.style.borderColor = theme.flowBorder }}
                      >
                        <RingAvatar userId={flow.from.user_id} username={flow.from.username} avatarUrl={flow.from.avatar_url} size={32} innerBg={theme.centerBg} textColor={theme.text} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', letterSpacing: '-0.01em' }}>
                            {fmt(flow.amount, currency)}
                          </span>
                          <div style={{ width: '100%', height: 2, borderRadius: 2, background: 'linear-gradient(90deg, rgba(239,68,68,0.1), rgba(239,68,68,0.55), rgba(239,68,68,0.3))', position: 'relative' }}>
                            <div style={{ position: 'absolute', right: -1, top: '50%', transform: 'translateY(-50%)', width: 0, height: 0, borderLeft: '6px solid rgba(239,68,68,0.55)', borderTop: '4px solid transparent', borderBottom: '4px solid transparent' }} />
                          </div>
                        </div>
                        <RingAvatar userId={flow.to.user_id} username={flow.to.username} avatarUrl={flow.to.avatar_url} size={32} innerBg={theme.centerBg} textColor={theme.text} />
                      </div>
                    ))}

                    {settlement.balances.filter(b => Math.abs(b.balance) > 0.01).length > 0 && (
                      <div style={{ marginTop: 8, borderTop: `1px solid ${theme.divider}`, paddingTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: theme.faint, textTransform: 'uppercase', letterSpacing: '0.11em', marginBottom: 10 }}>
                          {t('budget.netBalances')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {settlement.balances.filter(b => Math.abs(b.balance) > 0.01).map(b => {
                            const positive = b.balance > 0
                            const Trend = positive ? TrendingUp : TrendingDown
                            return (
                              <div key={b.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                                <RingAvatar userId={b.user_id} username={b.username} avatarUrl={b.avatar_url} size={26} innerBg={theme.centerBg} textColor={theme.text} />
                                <span style={{ flex: 1, fontSize: 13, color: theme.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {b.username}
                                </span>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  padding: '4px 10px', borderRadius: 8,
                                  fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em',
                                  background: positive ? 'rgba(16,185,129,0.13)' : 'rgba(239,68,68,0.13)',
                                  color: positive ? '#10b981' : '#ef4444',
                                }}>
                                  <Trend size={11} strokeWidth={3} />
                                  {positive ? '+' : ''}{fmt(b.balance, currency)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {pieSegments.length > 0 && (() => {
            const decimals = currencyDecimals(currency)
            const total = pieSegments.reduce((s, x) => s + x.value, 0)
            const totalFmt = Number(total).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
            const decimalSep = (0.1).toLocaleString(locale).replace(/\d/g, '')
            const [totalInt, totalDec] = decimals > 0 ? totalFmt.split(decimalSep) : [totalFmt, '']
            const R = 80
            const CIRC = 2 * Math.PI * R
            let dashOffset = 0
            return (
              <div style={{
                background: theme.bg,
                borderRadius: 20, padding: 20, color: theme.text, marginBottom: 16,
                border: `1px solid ${theme.border}`,
                boxShadow: theme.shadow,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 11,
                    background: theme.iconBg,
                    border: `1px solid ${theme.iconBorder}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: theme.iconColor, flexShrink: 0,
                  }}>
                    <PieChartIcon size={18} strokeWidth={2} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: theme.faint, textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 600 }}>{t('budget.byCategory')}</div>
                  </div>
                </div>

                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', margin: '4px 0 16px' }}>
                  <svg width={200} height={200} viewBox="0 0 200 200" style={{ transform: 'rotate(-90deg)', filter: theme.donutShadow }}>
                    <defs>
                      {pieSegments.map((seg, i) => {
                        const c2 = hexLighten(seg.color, 0.2)
                        return (
                          <linearGradient key={`grad-${i}`} id={`cat-grad-${i}`} x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor={seg.color} />
                            <stop offset="100%" stopColor={c2} />
                          </linearGradient>
                        )
                      })}
                    </defs>
                    <circle cx={100} cy={100} r={R} fill="none" stroke={theme.track} strokeWidth={22} />
                    {pieSegments.map((seg, i) => {
                      const segLen = total > 0 ? (seg.value / total) * CIRC : 0
                      const circle = (
                        <circle key={i}
                          cx={100} cy={100} r={R}
                          fill="none" strokeLinecap="round" strokeWidth={22}
                          stroke={`url(#cat-grad-${i})`}
                          strokeDasharray={`${segLen} ${CIRC}`}
                          strokeDashoffset={-dashOffset}
                        />
                      )
                      dashOffset += segLen
                      return circle
                    })}
                  </svg>
                  <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, pointerEvents: 'none' }}>
                    <div style={{ fontSize: 10.5, color: theme.faint, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>{t('budget.total')}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, display: 'flex', alignItems: 'baseline', gap: 2 }}>
                      <span>{totalInt}</span>
                      {totalDec && <span style={{ fontSize: 13, fontWeight: 500, color: theme.sub }}>{decimalSep}{totalDec}</span>}
                    </div>
                    <div style={{ fontSize: 10.5, color: theme.faint, fontWeight: 500, marginTop: 2 }}>{currency}</div>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${theme.divider}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {pieSegments.map((seg, i) => {
                    const pct = total > 0 ? (seg.value / total) * 100 : 0
                    const pctLabel = pct.toFixed(1).replace('.', decimalSep) + '%'
                    const c2 = hexLighten(seg.color, 0.2)
                    const chipColor = isDark ? hexLighten(seg.color, 0.35) : seg.color
                    return (
                      <div key={seg.name} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 8px', borderRadius: 12,
                        transition: 'background 0.15s',
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = theme.rowHover}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{
                          width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                          background: `linear-gradient(135deg, ${seg.color}, ${c2})`,
                          boxShadow: `0 0 12px ${seg.color}80`,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.01em', color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.name}</div>
                          <div style={{ fontSize: 11.5, color: theme.sub, fontWeight: 500, marginTop: 1 }}>{fmt(seg.value, currency)}</div>
                        </div>
                        <span style={{
                          flexShrink: 0,
                          padding: '4px 9px', borderRadius: 7,
                          fontSize: 11, fontWeight: 700, letterSpacing: '-0.01em',
                          background: `${seg.color}26`,
                          border: `1px solid ${seg.color}40`,
                          color: chipColor,
                        }}>{pctLabel}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

        </div>
      </div>
    </div>
  )
}
