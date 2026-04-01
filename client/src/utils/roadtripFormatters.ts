import { calculateSunriseSunset } from './solarCalculation'

export function formatDistance(meters: number, unitSystem: string): string {
  if (unitSystem === 'imperial') {
    const miles = meters / 1609.344
    return miles < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${miles.toFixed(1)} mi`
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  return h > 0 ? `${h}h ${m}m` : `${m} min`
}

export function calculateVehicleRange(tankSize: number, fuelConsumption: number, unitSystem: 'metric' | 'imperial'): number {
  if (unitSystem === 'imperial') {
    // Imperial: range_miles = tank_size_gallons * mpg
    return tankSize * fuelConsumption
  }
  // Metric: range_km = (tank_size_litres / consumption_l_per_100km) * 100
  return (tankSize / fuelConsumption) * 100
}

export interface DaylightDrivingResult {
  sunrise: Date
  sunset: Date
  recommendedDeparture: Date
  latestArrival: Date
  latestDepartureForArrival: Date
  availableHours: number
  hasSufficientDaylight: boolean
}

export function calculateDaylightDriving(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  date: Date,
  totalDrivingSeconds: number,
  totalRestSeconds: number,
  safetyMarginMinutes: number = 30
): DaylightDrivingResult {
  const originSolar = calculateSunriseSunset(originLat, originLng, date)
  const destSolar = calculateSunriseSunset(destLat, destLng, date)

  const marginMs = safetyMarginMinutes * 60000
  const recommendedDeparture = new Date(originSolar.sunrise.getTime() + marginMs)
  const latestArrival = new Date(destSolar.sunset.getTime() - marginMs)
  const totalTravelMs = (totalDrivingSeconds + totalRestSeconds) * 1000
  const latestDepartureForArrival = new Date(latestArrival.getTime() - totalTravelMs)
  const availableHours = (latestArrival.getTime() - recommendedDeparture.getTime()) / 3600000
  const totalTravelHours = (totalDrivingSeconds + totalRestSeconds) / 3600

  return {
    sunrise: originSolar.sunrise,
    sunset: destSolar.sunset,
    recommendedDeparture,
    latestArrival,
    latestDepartureForArrival,
    availableHours: Math.max(0, availableHours),
    hasSufficientDaylight: totalTravelHours <= availableHours,
  }
}

export interface DaylightBookingCheck {
  originSafe: boolean | null  // null = no booking
  destSafe: boolean | null    // null = no booking
  allSafe: boolean            // true only if both exist and are safe
  originCheckout: string | null
  destCheckin: string | null
}

/** Check if existing booking times are within the safe daylight window */
export function checkDaylightBookings(
  daylight: DaylightDrivingResult,
  originCheckout: string | null | undefined,
  destCheckin: string | null | undefined,
): DaylightBookingCheck {
  const parseTime = (t: string | null | undefined): Date | null => {
    if (!t) return null
    const match = t.match(/^(\d{1,2}):(\d{2})/)
    if (!match) return null
    const d = new Date(daylight.recommendedDeparture)
    d.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0)
    return d
  }

  const checkoutTime = parseTime(originCheckout)
  const checkinTime = parseTime(destCheckin)

  // Check-out should be AT or AFTER recommended departure (sunrise + margin)
  const originSafe = checkoutTime
    ? checkoutTime.getTime() >= daylight.recommendedDeparture.getTime()
    : null

  // Check-in should be AT or BEFORE latest arrival (sunset - margin)
  const destSafe = checkinTime
    ? checkinTime.getTime() <= daylight.latestArrival.getTime()
    : null

  const allSafe = originSafe === true && destSafe === true

  return {
    originSafe,
    destSafe,
    allSafe,
    originCheckout: originCheckout || null,
    destCheckin: destCheckin || null,
  }
}

export function formatFuelCost(cost: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cost)
  } catch {
    return `${cost.toFixed(2)} ${currency || 'USD'}`
  }
}
