import { Polyline, useMap, Popup } from 'react-leaflet'
import { useState, useEffect, useMemo } from 'react'
import L from 'leaflet'
import { Marker } from 'react-leaflet'
import type { RouteLeg, FoundStop } from '../../types'
import { formatDistance, formatDuration, formatFuelCost } from '../../utils/roadtripFormatters'

/**
 * Decode a Google-encoded polyline string into an array of [lat, lng] pairs.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let shift = 0
    let result = 0
    let byte: number
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1

    shift = 0
    result = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1

    points.push([lat / 1e5, lng / 1e5])
  }
  return points
}

/** Haversine distance in meters between two [lat, lng] points */
export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = (b[0] - a[0]) * Math.PI / 180
  const dLng = (b[1] - a[1]) * Math.PI / 180
  const lat1 = a[0] * Math.PI / 180
  const lat2 = b[0] * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/** Walk along polyline and find positions at distance intervals */
export function getRefuelPoints(positions: [number, number][], rangeMeters: number): [number, number][] {
  const points: [number, number][] = []
  let cumulative = 0
  let nextThreshold = rangeMeters // first marker at 1x range

  for (let i = 1; i < positions.length; i++) {
    const segDist = haversine(positions[i - 1], positions[i])
    const prevCumulative = cumulative
    cumulative += segDist

    while (cumulative >= nextThreshold) {
      // Interpolate position on this segment
      const overshoot = nextThreshold - prevCumulative
      const fraction = overshoot / segDist
      const lat = positions[i - 1][0] + fraction * (positions[i][0] - positions[i - 1][0])
      const lng = positions[i - 1][1] + fraction * (positions[i][1] - positions[i - 1][1])
      points.push([lat, lng])
      nextThreshold += rangeMeters
    }
  }
  return points
}

interface RoadTripRouteLabelProps {
  midpoint: [number, number]
  distance: string
  duration: string
  fuelText: string | null
  exceedsRange: boolean
  exceedsRangeText: string
}

function RoadTripRouteLabel({ midpoint, distance, duration, fuelText, exceedsRange, exceedsRangeText }: RoadTripRouteLabelProps) {
  const map = useMap()
  const [visible, setVisible] = useState(map ? map.getZoom() >= 12 : false)

  useEffect(() => {
    if (!map) return
    const check = () => setVisible(map.getZoom() >= 12)
    check()
    map.on('zoomend', check)
    return () => { map.off('zoomend', check) }
  }, [map])

  if (!visible || !midpoint) return null

  const extraParts: string[] = []
  if (fuelText) extraParts.push(fuelText)
  if (exceedsRange) extraParts.push(exceedsRangeText)

  const extraHtml = extraParts.length > 0
    ? `<span style="opacity:0.4">|</span><span>${extraParts.join(' ')}</span>`
    : ''

  const icon = L.divIcon({
    className: 'route-info-pill',
    html: `<div style="
      display:flex;align-items:center;gap:5px;
      background:rgba(59,130,246,0.9);backdrop-filter:blur(8px);
      color:#fff;border-radius:99px;padding:3px 9px;
      font-size:9px;font-weight:600;white-space:nowrap;
      font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
      box-shadow:0 2px 12px rgba(59,130,246,0.3);
      pointer-events:none;
      position:relative;left:-50%;top:-50%;
    ">
      <span style="display:flex;align-items:center;gap:2px">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2-4H7L5 10l-2.5 1.1C1.7 11.3 1 12.1 1 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
        ${distance}
      </span>
      <span style="opacity:0.4">|</span>
      <span>${duration}</span>
      ${extraHtml}
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

  return <Marker position={midpoint} icon={icon} interactive={false} zIndexOffset={2000} />
}

function RefuelMarker({ position }: { position: [number, number] }) {
  const icon = useMemo(() => L.divIcon({
    className: '',
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:rgba(217,119,6,0.9);border:2px solid white;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 6px rgba(0,0,0,0.25);
      font-size:12px;line-height:1;
      position:relative;left:-11px;top:-11px;
    ">⛽</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  }), [])

  return <Marker position={position} icon={icon} interactive={false} zIndexOffset={1500} />
}

function RestMarker({ position }: { position: [number, number] }) {
  const icon = useMemo(() => L.divIcon({
    className: '',
    html: `<div style="
      width:18px;height:18px;border-radius:50%;
      background:rgba(59,130,246,0.85);border:2px solid white;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 4px rgba(0,0,0,0.2);
      font-size:10px;line-height:1;
      position:relative;left:-9px;top:-9px;
    ">☕</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  }), [])

  return <Marker position={position} icon={icon} interactive={false} zIndexOffset={1400} />
}

/** Classify fuel stops as critical (must refuel) or optional based on vehicle range */
export function classifyFuelStops(fuelStops: FoundStop[], totalDistMeters: number, vehicleRangeMeters: number): Set<number> {
  // Sort by distance along route
  const sorted = [...fuelStops]
    .map((s, origIdx) => ({ ...s, origIdx }))
    .sort((a, b) => a.distance_along_route_meters - b.distance_along_route_meters)

  const criticalIndices = new Set<number>()
  let lastRefuelAt = 0 // start with full tank at 0

  while (lastRefuelAt + vehicleRangeMeters < totalDistMeters) {
    // Find the last reachable fuel station before running out
    const reachable = sorted.filter(s =>
      s.distance_along_route_meters > lastRefuelAt &&
      s.distance_along_route_meters <= lastRefuelAt + vehicleRangeMeters
    )
    if (reachable.length === 0) break // no fuel reachable — gap too large
    // Pick the furthest reachable station (maximise range per stop)
    const chosen = reachable[reachable.length - 1]
    criticalIndices.add(chosen.origIdx)
    lastRefuelAt = chosen.distance_along_route_meters
  }

  return criticalIndices
}

function FoundStopMarker({ stop, isPreferred }: { stop: FoundStop; isPreferred?: boolean }) {
  const isFuel = stop.type === 'fuel'
  const borderColor = isPreferred ? '#f59e0b' : 'white'
  const borderWidth = isPreferred ? 3 : 2
  const icon = useMemo(() => L.divIcon({
    className: '',
    html: `<div style="
      width:24px;height:24px;border-radius:50%;
      background:${isFuel ? 'rgba(22,163,74,0.9)' : 'rgba(37,99,235,0.9)'};border:${borderWidth}px solid ${borderColor};
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
      font-size:13px;line-height:1;
      position:relative;left:-12px;top:-12px;
      cursor:pointer;
    ">${isFuel ? '⛽' : '☕'}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  }), [isFuel, isPreferred])

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
  const distKm = Math.round(stop.distance_along_route_meters / 1000)

  return (
    <Marker position={[stop.lat, stop.lng]} icon={icon} zIndexOffset={1600}>
      <Popup>
        <div style={{ fontSize: 12, lineHeight: 1.4, minWidth: 140 }}>
          <strong>{stop.brand ? `${stop.brand} — ${stop.name}` : stop.name}</strong>
          {isFuel && distKm > 0 && (
            <div style={{ fontWeight: 600, color: '#16a34a', fontSize: 11 }}>
              ⛽ REFUEL — {distKm}km from start
            </div>
          )}
          {stop.rating != null && <div>{'⭐'.repeat(Math.round(stop.rating))} {stop.rating}</div>}
          {stop.opening_hours && <div style={{ fontSize: 11, color: '#888' }}>{stop.opening_hours}</div>}
          <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>
            {Math.round(stop.distance_from_route_meters)}m from route
          </div>
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', marginTop: 4, fontSize: 11, color: '#2563eb' }}>
            Open in Google Maps ↗
          </a>
        </div>
      </Popup>
    </Marker>
  )
}

/** Parse found_stops from route_metadata JSON */
function getFoundStops(leg: RouteLeg): FoundStop[] {
  if (!leg.route_metadata) return []
  try {
    const meta = JSON.parse(leg.route_metadata)
    return Array.isArray(meta.found_stops) ? meta.found_stops : []
  } catch { return [] }
}

interface RoadTripRouteProps {
  leg: RouteLeg
  unitSystem: string
  vehicleRangeMeters?: number | null
  fuelCurrency?: string
  exceedsRangeText?: string
  restIntervalHours?: number | null
  preferredBrands?: string[]
}

export default function RoadTripRoute({ leg, unitSystem, vehicleRangeMeters, fuelCurrency, exceedsRangeText, restIntervalHours, preferredBrands }: RoadTripRouteProps) {
  if (!leg.route_geometry) {
    // Loading state: thin animated dashed line between endpoints
    if (leg.from_lat != null && leg.from_lng != null && leg.to_lat != null && leg.to_lng != null) {
      return (
        <Polyline
          positions={[[leg.from_lat, leg.from_lng], [leg.to_lat, leg.to_lng]]}
          color="#3b82f6"
          weight={2}
          opacity={0.5}
          dashArray="4, 8"
        />
      )
    }
    return null
  }

  const positions = decodePolyline(leg.route_geometry)
  if (positions.length < 2) return null

  const midIndex = Math.floor(positions.length / 2)
  const midpoint = positions[midIndex]

  const distance = leg.distance_meters ? formatDistance(leg.distance_meters, unitSystem) : ''
  const duration = leg.duration_seconds ? formatDuration(leg.duration_seconds) : ''
  const fuelText = leg.fuel_cost != null && fuelCurrency ? formatFuelCost(leg.fuel_cost, fuelCurrency) : null
  const exceedsRange = !!(vehicleRangeMeters && leg.distance_meters && leg.distance_meters > vehicleRangeMeters)

  // Real found stops from route_metadata
  const foundStops = useMemo(() => getFoundStops(leg), [leg.route_metadata])
  const fuelStops = useMemo(() => foundStops.filter(s => s.type === 'fuel'), [foundStops])
  const restStops = useMemo(() => foundStops.filter(s => s.type === 'rest'), [foundStops])
  const hasRealFuelStops = fuelStops.length > 0
  const hasRealRestStops = restStops.length > 0

  // Classify fuel stops as critical vs optional
  const criticalFuelIndices = useMemo(() => {
    if (!hasRealFuelStops || !vehicleRangeMeters || !leg.distance_meters) return new Set<number>()
    return classifyFuelStops(fuelStops, leg.distance_meters, vehicleRangeMeters)
  }, [fuelStops, vehicleRangeMeters, leg.distance_meters])

  // Only show critical fuel stops + all rest stops
  const visibleStops = useMemo(() => {
    const criticalSet = criticalFuelIndices
    let fuelIdx = 0
    return foundStops.filter(s => {
      if (s.type !== 'fuel') return true
      const isCrit = criticalSet.has(fuelIdx++)
      return isCrit
    })
  }, [foundStops, criticalFuelIndices])

  // Refuel markers — hide approximate ones when real fuel stops exist
  const refuelPoints = useMemo(() => {
    if (hasRealFuelStops) return []
    if (!vehicleRangeMeters || !exceedsRange) return []
    return getRefuelPoints(positions, vehicleRangeMeters)
  }, [leg.route_geometry, vehicleRangeMeters, exceedsRange, hasRealFuelStops])

  // Rest markers — hide approximate ones when real rest stops exist
  const restPoints = useMemo(() => {
    if (hasRealRestStops) return []
    if (!restIntervalHours || !leg.distance_meters || !leg.duration_seconds) return []
    const avgSpeedMs = leg.distance_meters / leg.duration_seconds
    const restIntervalMeters = restIntervalHours * 3600 * avgSpeedMs
    if (leg.distance_meters <= restIntervalMeters) return []
    const raw = getRefuelPoints(positions, restIntervalMeters)
    if (refuelPoints.length === 0) return raw
    return raw.filter(rp => !refuelPoints.some(fp => haversine(rp, fp) < 5000))
  }, [leg.route_geometry, restIntervalHours, leg.distance_meters, leg.duration_seconds, refuelPoints, hasRealRestStops])

  return (
    <>
      <Polyline
        positions={positions}
        color="#3b82f6"
        weight={4}
        opacity={0.85}
      />
      {distance && duration && (
        <RoadTripRouteLabel
          midpoint={midpoint}
          distance={distance}
          duration={duration}
          fuelText={fuelText}
          exceedsRange={exceedsRange}
          exceedsRangeText={exceedsRangeText || '⚠️'}
        />
      )}
      {refuelPoints.map((pos, i) => (
        <RefuelMarker key={`refuel-${i}`} position={pos} />
      ))}
      {restPoints.map((pos, i) => (
        <RestMarker key={`rest-${i}`} position={pos} />
      ))}
      {visibleStops.map((stop, i) => {
        const isPreferred = !!(preferredBrands?.length && stop.type === 'fuel' &&
          preferredBrands.some(b => stop.brand?.toLowerCase().includes(b.toLowerCase()) || stop.name?.toLowerCase().includes(b.toLowerCase())));
        return (
          <FoundStopMarker
            key={`found-${stop.type}-${i}`}
            stop={stop}
            isPreferred={isPreferred}
          />
        );
      })}
    </>
  )
}
