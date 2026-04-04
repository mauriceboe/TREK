import { useMemo } from 'react'
import { useTranslation } from '../../i18n'
import { isWeekend } from './holidays'
import type { HolidaysMap, VacayCompanyHoliday, VacayEntry } from '../../types'

const WEEKDAY_KEYS = ['vacay.mon', 'vacay.tue', 'vacay.wed', 'vacay.thu', 'vacay.fri', 'vacay.sat', 'vacay.sun'] as const

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function renderPeopleOverlay(items: Array<{ user_id: number; person_color?: string }>, showBorder = false) {
  if (items.length === 0) return null
  const colors = items.slice(0, 4).map(item => item.person_color || '#6366f1')
  if (colors.length === 1) {
    return <div className="absolute inset-0.5 rounded" style={{ backgroundColor: colors[0], opacity: 0.4, border: showBorder ? '1px solid rgba(245,158,11,0.8)' : undefined }} />
  }
  if (colors.length === 2) {
    return <div className="absolute inset-0.5 rounded" style={{ background: `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`, opacity: 0.4, border: showBorder ? '1px solid rgba(245,158,11,0.8)' : undefined }} />
  }
  if (colors.length === 3) {
    return (
      <div className="absolute inset-0.5 rounded overflow-hidden" style={{ opacity: 0.4, border: showBorder ? '1px solid rgba(245,158,11,0.8)' : undefined }}>
        <div className="absolute top-0 left-0 w-1/2 h-full" style={{ backgroundColor: colors[0] }} />
        <div className="absolute top-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: colors[1] }} />
        <div className="absolute bottom-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: colors[2] }} />
      </div>
    )
  }
  return (
    <div className="absolute inset-0.5 rounded overflow-hidden" style={{ opacity: 0.4, border: showBorder ? '1px solid rgba(245,158,11,0.8)' : undefined }}>
      <div className="absolute top-0 left-0 w-1/2 h-1/2" style={{ backgroundColor: colors[0] }} />
      <div className="absolute top-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: colors[1] }} />
      <div className="absolute bottom-0 left-0 w-1/2 h-1/2" style={{ backgroundColor: colors[2] }} />
      <div className="absolute bottom-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: colors[3] }} />
    </div>
  )
}

interface VacayMonthCardProps {
  year: number
  month: number
  holidays: HolidaysMap
  companyHolidayMap: Record<string, VacayCompanyHoliday[]>
  blockedCompanyHolidaySet: Set<string>
  companyHolidaysEnabled?: boolean
  entryMap: Record<string, VacayEntry[]>
  onCellClick: (date: string) => void
  companyMode: boolean
  blockWeekends: boolean
  weekendDays?: number[]
}

export default function VacayMonthCard({
  year, month, holidays, companyHolidayMap, blockedCompanyHolidaySet, companyHolidaysEnabled = true, entryMap,
  onCellClick, companyMode, blockWeekends, weekendDays = [0, 6],
}: VacayMonthCardProps) {
  const { t, locale } = useTranslation()

  const weekdays = WEEKDAY_KEYS.map(k => t(k))
  const monthName = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(year, month, 1)), [locale, year, month])

  const weeks = useMemo(() => {
    const firstDay = new Date(year, month, 1)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    let startDow = firstDay.getDay() - 1
    if (startDow < 0) startDow = 6
    const cells: Array<number | null> = []
    for (let i = 0; i < startDow; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    const w: Array<Array<number | null>> = []
    for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7))
    return w
  }, [year, month])

  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{monthName}</span>
      </div>

      <div className="grid grid-cols-7 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
        {weekdays.map((wd, i) => (
          <div key={wd} className="text-center text-[10px] font-medium py-1" style={{ color: i >= 5 ? 'var(--text-faint)' : 'var(--text-muted)' }}>
            {wd}
          </div>
        ))}
      </div>

      <div>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7">
            {week.map((day, di) => {
              if (day === null) return <div key={di} style={{ height: 28 }} />

              const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`
              const dayOfWeek = new Date(year, month, day).getDay()
              const weekend = weekendDays.includes(dayOfWeek)
              const holiday = holidays[dateStr]
              const companyEntries = companyHolidaysEnabled ? (companyHolidayMap[dateStr] || []) : []
              const vacationEntries = (entryMap[dateStr] || []).filter(entry => !companyEntries.some(company => company.user_id === entry.user_id))
              const isBlocked = !!holiday || (weekend && blockWeekends) || (blockedCompanyHolidaySet.has(dateStr) && !companyMode)

              return (
                <div
                  key={di}
                  title={holiday ? (holiday.label ? `${holiday.label}: ${holiday.localName}` : holiday.localName) : undefined}
                  className="relative flex items-center justify-center cursor-pointer transition-colors"
                  style={{
                    height: 28,
                    background: weekend ? 'var(--bg-secondary)' : 'transparent',
                    borderTop: '1px solid var(--border-secondary)',
                    borderRight: '1px solid var(--border-secondary)',
                    cursor: isBlocked ? 'default' : 'pointer',
                  }}
                  onClick={() => onCellClick(dateStr)}
                  onMouseEnter={e => { if (!isBlocked) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = weekend ? 'var(--bg-secondary)' : 'transparent' }}
                >
                  {holiday && <div className="absolute inset-0.5 rounded" style={{ background: hexToRgba(holiday.color, 0.12) }} />}
                  {vacationEntries.length > 0 && renderPeopleOverlay(vacationEntries)}
                  {companyEntries.length > 0 && renderPeopleOverlay(companyEntries, true)}
                  {companyEntries.length > 0 && <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full" style={{ background: '#d97706' }} />}

                  <span className="relative z-[1] text-[11px] font-medium" style={{
                    color: companyEntries.length > 0 ? '#b45309' : holiday ? holiday.color : weekend ? 'var(--text-faint)' : 'var(--text-primary)',
                    fontWeight: vacationEntries.length > 0 || companyEntries.length > 0 ? 700 : 500,
                  }}>
                    {day}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
