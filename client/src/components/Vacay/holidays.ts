const BUNDESLAENDER: Record<string, string> = {
  BW: 'Baden-Württemberg',
  BY: 'Bayern',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz',
  SL: 'Saarland',
  SN: 'Sachsen',
  ST: 'Sachsen-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
}

function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function fmt(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getHolidays(year: number, bundesland: string = 'NW'): Record<string, string> {
  const easter = easterSunday(year)
  const holidays: Record<string, string> = {}

  holidays[`${year}-01-01`] = 'Neujahr'
  holidays[`${year}-05-01`] = 'Tag der Arbeit'
  holidays[`${year}-10-03`] = 'Tag der Deutschen Einheit'
  holidays[`${year}-12-25`] = '1. Weihnachtsfeiertag'
  holidays[`${year}-12-26`] = '2. Weihnachtsfeiertag'

  holidays[fmt(addDays(easter, -2))] = 'Karfreitag'
  holidays[fmt(addDays(easter, 1))] = 'Ostermontag'
  holidays[fmt(addDays(easter, 39))] = 'Christi Himmelfahrt'
  holidays[fmt(addDays(easter, 50))] = 'Pfingstmontag'

  const bl = bundesland.toUpperCase()

  if (['BW', 'BY', 'ST'].includes(bl)) {
    holidays[`${year}-01-06`] = 'Heilige Drei Könige'
  }

  if (['BE', 'MV'].includes(bl)) {
    holidays[`${year}-03-08`] = 'Internationaler Frauentag'
  }

  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL'].includes(bl)) {
    holidays[fmt(addDays(easter, 60))] = 'Fronleichnam'
  }

  if (['SL'].includes(bl)) {
    holidays[`${year}-08-15`] = 'Mariä Himmelfahrt'
  }

  if (bl === 'TH') {
    holidays[`${year}-09-20`] = 'Weltkindertag'
  }

  if (['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'].includes(bl)) {
    holidays[`${year}-10-31`] = 'Reformationstag'
  }

  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl)) {
    holidays[`${year}-11-01`] = 'Allerheiligen'
  }

  if (bl === 'SN') {
    const nov23 = new Date(year, 10, 23)
    const bbt = new Date(nov23)
    while (bbt.getDay() !== 3) bbt.setDate(bbt.getDate() - 1)
    holidays[fmt(bbt)] = 'Buß- und Bettag'
  }

  return holidays
}

export function isWeekend(dateStr: string, weekendDays: number[] = [0, 6]): boolean {
  const d = new Date(dateStr + 'T00:00:00Z')
  return weekendDays.includes(d.getUTCDay())
}

export function getWeekday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getUTCDay()]
}

export function getWeekdayFull(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][d.getUTCDay()]
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function formatDate(dateStr: string, locale?: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString(locale || undefined, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
}

export { BUNDESLAENDER }
