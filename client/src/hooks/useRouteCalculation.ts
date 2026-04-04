import { useState, useCallback, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { calculateRoute, calculateSegments, normalizeTransportProfile } from '../components/Map/RouteCalculator'
import type { TripStoreState } from '../store/tripStore'
import type { RouteSegment, RouteResult } from '../types'

/**
 * Manages route calculation state for a selected day. Extracts geo-coded waypoints from
 * day assignments, draws a routed path, and fetches per-segment durations via OSRM.
 * Aborts in-flight requests when the day changes.
 */
export function useRouteCalculation(tripStore: TripStoreState, selectedDayId: number | null) {
  const [route, setRoute] = useState<[number, number][] | null>(null)
  const [routeInfo, setRouteInfo] = useState<RouteResult | null>(null)
  const [routeSegments, setRouteSegments] = useState<RouteSegment[]>([])
  const routeCalcEnabled = useSettingsStore((s) => s.settings.route_calculation) !== false
  const routeAbortRef = useRef<AbortController | null>(null)
  // Keep a ref to the latest tripStore so updateRouteForDay never has a stale closure
  const tripStoreRef = useRef(tripStore)
  tripStoreRef.current = tripStore

  const getRouteProfile = useCallback((waypoints: Array<{ transport_mode?: string | null }>) => {
    const counts = { walking: 0, driving: 0, cycling: 0 }
    waypoints.forEach((waypoint) => {
      const profile = normalizeTransportProfile(waypoint.transport_mode)
      counts[profile] += 1
    })
    if (counts.driving >= counts.walking && counts.driving >= counts.cycling && counts.driving > 0) return 'driving' as const
    if (counts.cycling >= counts.walking && counts.cycling > 0) return 'cycling' as const
    return 'walking' as const
  }, [])

  const updateRouteForDay = useCallback(async (dayId: number | null) => {
    if (routeAbortRef.current) routeAbortRef.current.abort()
    if (!dayId) { setRoute(null); setRouteInfo(null); setRouteSegments([]); return }
    const currentAssignments = tripStoreRef.current.assignments || {}
    const da = (currentAssignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    const waypoints = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
    if (waypoints.length < 2) { setRoute(null); setRouteInfo(null); setRouteSegments([]); return }
    const profile = getRouteProfile(waypoints)
    if (!routeCalcEnabled) {
      setRoute(waypoints.map((p) => [p.lat!, p.lng!]))
      setRouteInfo(null)
      setRouteSegments([])
      return
    }
    const controller = new AbortController()
    routeAbortRef.current = controller
    try {
      const [routeResult, segments] = await Promise.all([
        calculateRoute(waypoints as { lat: number; lng: number }[], profile, { signal: controller.signal }),
        calculateSegments(waypoints as { lat: number; lng: number }[], profile, { signal: controller.signal }),
      ])
      if (!controller.signal.aborted) {
        setRoute(routeResult.coordinates)
        setRouteInfo(routeResult)
        setRouteSegments(segments)
      }
    } catch (err: unknown) {
      if ((err instanceof Error && err.name !== 'AbortError') || !(err instanceof Error)) {
        setRoute(waypoints.map((p) => [p.lat!, p.lng!]))
        setRouteInfo(null)
        setRouteSegments([])
      }
    }
  }, [getRouteProfile, routeCalcEnabled])

  // Only recalculate when assignments for the SELECTED day change
  const selectedDayAssignments = selectedDayId ? tripStore.assignments?.[String(selectedDayId)] : null
  useEffect(() => {
    if (!selectedDayId) { setRoute(null); setRouteInfo(null); setRouteSegments([]); return }
    updateRouteForDay(selectedDayId)
  }, [selectedDayId, selectedDayAssignments])

  return { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay }
}
