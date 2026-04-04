import type { RouteResult, RouteSegment, Waypoint } from '../../types'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'
const OSRM_TABLE_BASE = 'https://router.project-osrm.org/table/v1'
type RouteProfile = 'driving' | 'walking' | 'cycling'

interface RouteOptimizationResult<T extends Waypoint> {
  waypoints: T[]
  beforeCost: number
  afterCost: number
  changed: boolean
}

/** Fetches a full route via OSRM and returns coordinates, distance, and duration estimates for driving/walking. */
export async function calculateRoute(
  waypoints: Waypoint[],
  profile: RouteProfile = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteResult> {
  if (!waypoints || waypoints.length < 2) {
    throw new Error('At least 2 waypoints required')
  }

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/${profile}/${coords}?overview=full&geometries=geojson&steps=false`

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error('Route could not be calculated')
  }

  const data = await response.json()

  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error('No route found')
  }

  const route = data.routes[0]
  const coordinates: [number, number][] = route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])

  const distance: number = route.distance
  const duration = profile === 'driving'
    ? route.duration
    : estimateDurationFromDistance(distance, profile)

  const walkingDuration = distance / (5000 / 3600)
  const drivingDuration: number = route.duration

  return {
    coordinates,
    distance,
    duration,
    profile,
    distanceText: formatDistance(distance),
    durationText: formatDuration(duration),
    walkingText: formatDuration(walkingDuration),
    drivingText: formatDuration(drivingDuration),
  }
}

export function generateGoogleMapsUrl(places: Waypoint[]): string | null {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length === 0) return null
  if (valid.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${valid[0].lat},${valid[0].lng}`
  }
  const stops = valid.map((p) => `${p.lat},${p.lng}`).join('/')
  return `https://www.google.com/maps/dir/${stops}`
}

/** Reorders waypoints using routing cost when available and falls back to straight-line distance. */
export async function optimizeRoute<T extends Waypoint>(
  places: T[],
  profile: RouteProfile = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteOptimizationResult<T>> {
  if (!places || places.length <= 2) {
    return { waypoints: places, beforeCost: 0, afterCost: 0, changed: false }
  }

  const matrix = await buildCostMatrix(places, profile, signal)
  const initialOrder = places.map((_, index) => index)
  const nearestNeighborOrder = buildNearestNeighborOrder(matrix)
  const improvedOrder = improveOrderWithTwoOpt(nearestNeighborOrder, matrix)
  const beforeCost = totalRouteCost(initialOrder, matrix)
  const afterCost = totalRouteCost(improvedOrder, matrix)
  const changed = !ordersEqual(initialOrder, improvedOrder) && afterCost + 1e-6 < beforeCost

  return {
    waypoints: changed ? improvedOrder.map(index => places[index]) : places,
    beforeCost,
    afterCost: changed ? afterCost : beforeCost,
    changed,
  }
}

/** Fetches per-leg distance/duration from OSRM and returns segment metadata (midpoints, walking/driving times). */
export async function calculateSegments(
  waypoints: Waypoint[],
  profile: RouteProfile = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteSegment[]> {
  if (!waypoints || waypoints.length < 2) return []

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/${profile}/${coords}?overview=false&geometries=geojson&steps=false&annotations=distance,duration`

  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('Route could not be calculated')

  const data = await response.json()
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route found')

  const legs = data.routes[0].legs
  return legs.map((leg: { distance: number; duration: number }, i: number): RouteSegment => {
    const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
    const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
    const walkingDuration = leg.distance / (5000 / 3600)
    const cyclingDuration = leg.distance / (15000 / 3600)
    const duration = profile === 'driving'
      ? leg.duration
      : profile === 'cycling'
        ? cyclingDuration
        : walkingDuration
    return {
      mid, from, to,
      durationText: formatDuration(duration),
      profile,
      walkingText: formatDuration(walkingDuration),
      drivingText: formatDuration(leg.duration),
    }
  })
}

export function normalizeTransportProfile(mode?: string | null): RouteProfile {
  if (mode === 'driving' || mode === 'cycling') return mode
  return 'walking'
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`
  }
  return `${(meters / 1000).toFixed(1)} km`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) {
    return `${h} h ${m} min`
  }
  return `${m} min`
}

function estimateDurationFromDistance(distance: number, profile: RouteProfile): number {
  if (profile === 'cycling') return distance / (15000 / 3600)
  if (profile === 'walking') return distance / (5000 / 3600)
  return distance / (40000 / 3600)
}

async function buildCostMatrix(
  places: Waypoint[],
  profile: RouteProfile,
  signal?: AbortSignal
): Promise<number[][]> {
  const coords = places.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_TABLE_BASE}/${profile}/${coords}?annotations=duration`

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Table request failed')
    const data = await response.json()
    const durations = Array.isArray(data?.durations) ? data.durations : null
    if (!durations || durations.length !== places.length) throw new Error('Invalid duration matrix')
    return durations.map((row: unknown, rowIndex: number) => {
      if (!Array.isArray(row)) throw new Error('Invalid duration row')
      return row.map((value: unknown, columnIndex: number) => (
        typeof value === 'number' && Number.isFinite(value)
          ? value
          : approximateCost(places[rowIndex], places[columnIndex], profile)
      ))
    })
  } catch {
    return places.map((from, rowIndex) => places.map((to, columnIndex) => (
      rowIndex === columnIndex ? 0 : approximateCost(from, to, profile)
    )))
  }
}

function approximateCost(from: Waypoint, to: Waypoint, profile: RouteProfile): number {
  const distance = haversineDistanceMeters(from, to)
  const roadFactor = profile === 'driving' ? 1.2 : 1.08
  return estimateDurationFromDistance(distance * roadFactor, profile)
}

function haversineDistanceMeters(from: Waypoint, to: Waypoint): number {
  const toRadians = (value: number) => value * (Math.PI / 180)
  const earthRadius = 6371000
  const dLat = toRadians(to.lat - from.lat)
  const dLng = toRadians(to.lng - from.lng)
  const lat1 = toRadians(from.lat)
  const lat2 = toRadians(to.lat)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(a))
}

function buildNearestNeighborOrder(matrix: number[][]): number[] {
  const count = matrix.length
  const visited = new Set<number>([0])
  const order = [0]

  while (order.length < count) {
    const current = order[order.length - 1]
    let bestIndex = -1
    let bestCost = Number.POSITIVE_INFINITY
    for (let candidate = 0; candidate < count; candidate++) {
      if (visited.has(candidate)) continue
      const cost = matrix[current]?.[candidate] ?? Number.POSITIVE_INFINITY
      if (cost < bestCost) {
        bestCost = cost
        bestIndex = candidate
      }
    }
    if (bestIndex === -1) break
    visited.add(bestIndex)
    order.push(bestIndex)
  }

  for (let index = 0; index < count; index++) {
    if (!visited.has(index)) order.push(index)
  }

  return order
}

function improveOrderWithTwoOpt(order: number[], matrix: number[][]): number[] {
  let improved = order.slice()
  let improvedInPass = true

  while (improvedInPass) {
    improvedInPass = false
    for (let start = 1; start < improved.length - 2; start++) {
      for (let end = start + 1; end < improved.length - 1; end++) {
        const candidate = [
          ...improved.slice(0, start),
          ...improved.slice(start, end + 1).reverse(),
          ...improved.slice(end + 1),
        ]
        if (totalRouteCost(candidate, matrix) + 1e-6 < totalRouteCost(improved, matrix)) {
          improved = candidate
          improvedInPass = true
        }
      }
    }
  }

  return improved
}

function totalRouteCost(order: number[], matrix: number[][]): number {
  let total = 0
  for (let index = 0; index < order.length - 1; index++) {
    total += matrix[order[index]]?.[order[index + 1]] ?? Number.POSITIVE_INFINITY
  }
  return total
}

function ordersEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
