/**
 * Simple sunrise/sunset calculator using the standard solar position algorithm.
 * Accuracy: ±15 minutes, sufficient for driving time estimation.
 */

interface SolarResult {
  sunrise: Date
  sunset: Date
  daylightHours: number
}

export function calculateSunriseSunset(lat: number, lng: number, date: Date): SolarResult {
  const rad = Math.PI / 180
  const deg = 180 / Math.PI

  // Day of year
  const start = new Date(date.getFullYear(), 0, 0)
  const diff = date.getTime() - start.getTime()
  const dayOfYear = Math.floor(diff / 86400000)

  // Solar declination (simplified)
  const declination = -23.45 * Math.cos(rad * (360 / 365) * (dayOfYear + 10))

  // Hour angle for sunrise/sunset
  const latRad = lat * rad
  const declRad = declination * rad
  const cosHourAngle = (-Math.sin(-0.833 * rad) - Math.sin(latRad) * Math.sin(declRad)) /
    (Math.cos(latRad) * Math.cos(declRad))

  // Handle polar regions
  if (cosHourAngle > 1) {
    // Sun never rises (polar night)
    const noon = new Date(date)
    noon.setHours(12, 0, 0, 0)
    return { sunrise: noon, sunset: noon, daylightHours: 0 }
  }
  if (cosHourAngle < -1) {
    // Sun never sets (midnight sun)
    const dayStart = new Date(date)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(date)
    dayEnd.setHours(23, 59, 59, 0)
    return { sunrise: dayStart, sunset: dayEnd, daylightHours: 24 }
  }

  const hourAngle = Math.acos(cosHourAngle) * deg

  // Equation of time (minutes) — simplified
  const B = (360 / 365) * (dayOfYear - 81) * rad
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)

  // Solar noon in minutes from midnight UTC
  const solarNoonMinutes = 720 - 4 * lng - eot

  // Sunrise and sunset in minutes from midnight UTC
  const sunriseMinutes = solarNoonMinutes - 4 * hourAngle
  const sunsetMinutes = solarNoonMinutes + 4 * hourAngle

  // Convert to local Date objects (using the date's timezone offset)
  const baseDate = new Date(date)
  baseDate.setHours(0, 0, 0, 0)
  const tzOffset = baseDate.getTimezoneOffset() // minutes behind UTC

  const sunrise = new Date(baseDate.getTime() + (sunriseMinutes + tzOffset) * 60000)
  const sunset = new Date(baseDate.getTime() + (sunsetMinutes + tzOffset) * 60000)
  const daylightHours = (sunsetMinutes - sunriseMinutes) / 60

  return { sunrise, sunset, daylightHours: Math.max(0, daylightHours) }
}

/** Format sunrise/sunset time for display */
export function formatSolarTime(date: Date, timeFormat: string): string {
  if (timeFormat === '12h') {
    let h = date.getHours()
    const m = date.getMinutes()
    const period = h >= 12 ? 'PM' : 'AM'
    h = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h}:${String(m).padStart(2, '0')} ${period}`
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
