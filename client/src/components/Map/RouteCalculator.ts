import type { RouteResult, RouteSegment, Waypoint } from '../../types'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'

/** Fetches a full route via OSRM and returns coordinates, distance, and duration estimates for driving/walking. */
export async function calculateRoute(
  waypoints: Waypoint[],
  profile: 'driving' | 'walking' | 'cycling' = 'driving',
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
  let duration: number
  if (profile === 'walking') {
    duration = distance / (5000 / 3600)
  } else if (profile === 'cycling') {
    duration = distance / (15000 / 3600)
  } else {
    duration = route.duration
  }

  const walkingDuration = distance / (5000 / 3600)
  const drivingDuration: number = route.duration

  return {
    coordinates,
    distance,
    duration,
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

/** Reorders waypoints using a nearest-neighbor heuristic to minimize total Euclidean distance. */
export function optimizeRoute(places: Waypoint[]): Waypoint[] {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length <= 2) return places

  const visited = new Set<number>()
  const result: Waypoint[] = []
  let current = valid[0]
  visited.add(0)
  result.push(current)

  while (result.length < valid.length) {
    let nearestIdx = -1
    let minDist = Infinity
    for (let i = 0; i < valid.length; i++) {
      if (visited.has(i)) continue
      const d = Math.sqrt(
        Math.pow(valid[i].lat - current.lat, 2) + Math.pow(valid[i].lng - current.lng, 2)
      )
      if (d < minDist) { minDist = d; nearestIdx = i }
    }
    if (nearestIdx === -1) break
    visited.add(nearestIdx)
    current = valid[nearestIdx]
    result.push(current)
  }
  return result
}

/** Fetches per-leg distance/duration from OSRM and returns segment metadata (midpoints, walking/driving times). */
export async function calculateSegments(
  waypoints: Waypoint[],
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteSegment[]> {
  if (!waypoints || waypoints.length < 2) return []

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/driving/${coords}?overview=false&geometries=geojson&steps=false&annotations=distance,duration`

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
    return {
      mid, from, to,
      walkingText: formatDuration(walkingDuration),
      drivingText: formatDuration(leg.duration),
    }
  })
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
