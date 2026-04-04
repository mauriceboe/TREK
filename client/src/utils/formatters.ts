import type { AssignmentsMap } from '../types'

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'])

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

export function formatDate(dateStr: string | null | undefined, locale: string, timeZone?: string): string | null {
  if (!dateStr) return null
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short', day: 'numeric', month: 'short',
    timeZone: timeZone || 'UTC',
  }
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString(locale, opts)
}

export function formatTime(timeStr: string | null | undefined, locale: string, timeFormat: string): string {
  if (!timeStr) return ''
  try {
    const parts = timeStr.split(':')
    const h = Number(parts[0]) || 0
    const m = Number(parts[1]) || 0
    if (isNaN(h)) return timeStr
    if (timeFormat === '12h') {
      const period = h >= 12 ? 'PM' : 'AM'
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      return `${h12}:${String(m).padStart(2, '0')} ${period}`
    }
    const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    return locale?.startsWith('de') ? `${str} Uhr` : str
  } catch { return timeStr }
}

export function dayTotalCost(dayId: number, assignments: AssignmentsMap, currency: string): string | null {
  const da = assignments[String(dayId)] || []
  const total = da.reduce((s, a) => s + (parseFloat(a.place?.price || '') || 0), 0)
  return total > 0 ? `${total.toFixed(0)} ${currency}` : null
}
