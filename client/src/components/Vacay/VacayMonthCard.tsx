import { useMemo } from 'react'
import { useTranslation } from '../../i18n'
import { isWeekend } from './holidays'
import type { HolidaysMap, VacayEntry } from '../../types'

const WEEKDAY_KEYS = ['vacay.mon', 'vacay.tue', 'vacay.wed', 'vacay.thu', 'vacay.fri', 'vacay.sat', 'vacay.sun'] as const

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

interface VacayMonthCardProps {
  year: number
  month: number
  holidays: HolidaysMap
  companyHolidaySet: Set<string>
  companyHolidaysEnabled?: boolean
  entryMap: Record<string, VacayEntry[]>
  onCellClick: (date: string) => void
  companyMode: boolean
  blockWeekends: boolean
  weekendDays?: number[]
  tripDates?: Set<string>
  weekStart?: number
}

export default function VacayMonthCard({
  year, month, holidays, companyHolidaySet, companyHolidaysEnabled = true, entryMap,
  onCellClick, companyMode, blockWeekends, weekendDays = [0, 6], tripDates, weekStart = 1
}: VacayMonthCardProps) {
  const { t, locale } = useTranslation()

  const WEEKDAY_KEYS_SUNDAY = ['vacay.sun', 'vacay.mon', 'vacay.tue', 'vacay.wed', 'vacay.thu', 'vacay.fri', 'vacay.sat'] as const
  const orderedKeys = weekStart === 0 ? WEEKDAY_KEYS_SUNDAY : WEEKDAY_KEYS
  const weekdays = orderedKeys.map(k => t(k))
  const monthName = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(year, month, 1)), [locale, year, month])

  const weeks = useMemo(() => {
    const firstDay = new Date(year, month, 1)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    let startDow = firstDay.getDay() - weekStart
    if (startDow < 0) startDow += 7
    const cells = []
    for (let i = 0; i < startDow; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    const w = []
    for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7))
    return w
  }, [year, month])

  const pad = (n) => String(n).padStart(2, '0')

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{monthName}</span>
      </div>

      <div className="grid grid-cols-7 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
        {weekdays.map((wd, i) => {
          // Map column index back to JS day (0=Sun..6=Sat) to check if it's a weekend column
          const jsDay = (i + weekStart) % 7
          const isWeekendCol = weekendDays.includes(jsDay)
          return (
            <div key={`${wd}-${i}`} className="text-center text-[10px] font-medium py-1" style={{ color: isWeekendCol ? 'var(--text-faint)' : 'var(--text-muted)' }}>
              {wd}
            </div>
          )
        })}
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
              const isCompany = companyHolidaysEnabled && companyHolidaySet.has(dateStr)
              const dayEntries = entryMap[dateStr] || []
              const isBlocked = !!holiday || (weekend && blockWeekends) || (isCompany && !companyMode)
              // When company holiday and person entries coexist, treat company holiday as a virtual first entry
              const COMPANY_COLOR = '#f59e0b'
              const displayEntries = isCompany && dayEntries.length > 0
                ? [{ person_color: COMPANY_COLOR, user_id: -1, date: dateStr }, ...dayEntries]
                : dayEntries

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
                  {isCompany && dayEntries.length === 0 && <div className="absolute inset-0.5 rounded" style={{ background: 'rgba(245,158,11,0.15)' }} />}

                  {displayEntries.length === 1 && (
                    <div className="absolute inset-0.5 rounded" style={{ backgroundColor: displayEntries[0].person_color, opacity: 0.4 }} />
                  )}
                  {displayEntries.length === 2 && (
                    <div className="absolute inset-0.5 rounded" style={{
                      background: `linear-gradient(135deg, ${displayEntries[0].person_color} 50%, ${displayEntries[1].person_color} 50%)`,
                      opacity: 0.4,
                    }} />
                  )}
                  {displayEntries.length === 3 && (
                    <div className="absolute inset-0.5 rounded overflow-hidden" style={{ opacity: 0.4 }}>
                      <div className="absolute top-0 left-0 w-1/2 h-full" style={{ backgroundColor: displayEntries[0].person_color }} />
                      <div className="absolute top-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[1].person_color }} />
                      <div className="absolute bottom-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[2].person_color }} />
                    </div>
                  )}
                  {displayEntries.length >= 4 && (
                    <div className="absolute inset-0.5 rounded overflow-hidden" style={{ opacity: 0.4 }}>
                      <div className="absolute top-0 left-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[0].person_color }} />
                      <div className="absolute top-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[1].person_color }} />
                      <div className="absolute bottom-0 left-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[2].person_color }} />
                      <div className="absolute bottom-0 right-0 w-1/2 h-1/2" style={{ backgroundColor: displayEntries[3].person_color }} />
                    </div>
                  )}

                  {tripDates?.has(dateStr) && (
                    <span className="absolute top-[3px] right-[3px] w-[5px] h-[5px] rounded-full z-[2]" style={{ background: '#3b82f6' }} />
                  )}

                  <span className="relative z-[1] text-[11px] font-medium" style={{
                    color: holiday ? holiday.color : weekend ? 'var(--text-faint)' : 'var(--text-primary)',
                    fontWeight: displayEntries.length > 0 ? 700 : 500,
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
