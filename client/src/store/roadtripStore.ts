import { create } from 'zustand'
import { roadtripApi } from '../api/client'
import { useSettingsStore } from './settingsStore'
import { calculateVehicleRange } from '../utils/roadtripFormatters'
import type { RouteLeg } from '../types'

interface RoadtripState {
  routeLegs: Record<string, RouteLeg[]>
  loading: boolean
  error: string | null
  batchProgress: { current: number; total: number } | null
  _batchCancelled: boolean
  findingStopsLegIds: Set<number>

  loadRouteLegs: (tripId: string) => Promise<void>
  toggleRoadTrip: (tripId: string, legId: number, isRoadTrip: boolean, dayIndex?: number, fromPlaceId?: string, toPlaceId?: string) => Promise<void>
  toggleAllTrip: (tripId: string, days: { id: number; assignments: { id: number; place: { id: number; lat: number | null; lng: number | null } | null }[] }[]) => Promise<void>
  cancelBatch: () => void
  calculateRoute: (tripId: string, dayIndex: number, fromPlaceId: string, toPlaceId: string) => Promise<RouteLeg | null>
  deleteRouteLeg: (tripId: string, legId: number) => Promise<void>
  recalculateDay: (tripId: string, dayIndex: number, placePairs: { from: string; to: string }[]) => Promise<void>
  recalculate: (tripId: string) => Promise<void>
  findStops: (tripId: string, legId: number, stopType: string, searchPoints: { lat: number; lng: number; distance_along_route_meters: number }[], corridor?: boolean) => Promise<void>
  autoFindStops: (tripId: string, leg: RouteLeg) => Promise<void>
  clearTrip: (tripId: string) => void

  getLegsForDay: (tripId: string, dayIndex: number) => RouteLeg[]
  getLegBetween: (tripId: string, dayIndex: number, fromPlaceId: string, toPlaceId: string) => RouteLeg | undefined
  getTripTotals: (tripId: string, restIntervalHours?: number | null, restDurationMinutes?: number | null) => { totalDistanceMeters: number; totalDurationSeconds: number; totalFuelCost: number; totalRestBreaks: number; totalRestTimeSeconds: number; totalTravelTimeWithBreaks: number }
  getDayTotals: (tripId: string, dayIndex: number) => { distanceMeters: number; durationSeconds: number; fuelCost: number }
}

export const useRoadtripStore = create<RoadtripState>((set, get) => ({
  routeLegs: {},
  loading: false,
  error: null,
  batchProgress: null,
  _batchCancelled: false,
  findingStopsLegIds: new Set(),

  loadRouteLegs: async (tripId) => {
    set({ loading: true, error: null })
    try {
      const data = await roadtripApi.listLegs(tripId)
      const legs = (data.legs || []).map((l: RouteLeg) => ({ ...l, is_road_trip: !!l.is_road_trip }))
      set(s => ({ routeLegs: { ...s.routeLegs, [tripId]: legs }, loading: false }))
    } catch (err) {
      console.error('Failed to load route legs:', err)
      set({ loading: false })
    }
  },

  toggleRoadTrip: async (tripId, legId, isRoadTrip, dayIndex, fromPlaceId, toPlaceId) => {
    if (isRoadTrip && dayIndex !== undefined && fromPlaceId && toPlaceId) {
      // Enabling — if no leg exists, calculate one; otherwise update existing
      let leg: RouteLeg | null = null
      if (legId <= 0) {
        leg = await get().calculateRoute(tripId, dayIndex, fromPlaceId, toPlaceId)
      } else {
        try {
          await roadtripApi.updateLeg(tripId, legId, { is_road_trip: true })
          leg = await get().calculateRoute(tripId, dayIndex, fromPlaceId, toPlaceId)
        } catch (err) { console.error('Failed to enable road trip leg:', err) }
      }
      // Auto-find stops after route calculation
      if (leg?.route_geometry && leg.distance_meters) {
        get().autoFindStops(tripId, leg)
      }
      return
    } else if (!isRoadTrip && legId > 0) {
      // Disabling
      try {
        await roadtripApi.updateLeg(tripId, legId, { is_road_trip: false })
        set(s => ({
          routeLegs: {
            ...s.routeLegs,
            [tripId]: (s.routeLegs[tripId] || []).map(l =>
              l.id === legId ? { ...l, is_road_trip: false } : l
            ),
          }
        }))
      } catch (err) { console.error('Failed to disable road trip leg:', err) }
    }
  },

  toggleAllTrip: async (tripId, days) => {
    const tripIdStr = String(tripId)
    const allLegs = get().routeLegs[tripIdStr] || []

    // Build all place pairs across all days
    const allPairs: { dayIndex: number; from: string; to: string }[] = []
    for (let di = 0; di < days.length; di++) {
      const places = days[di].assignments
        .filter(a => a.place?.lat && a.place?.lng)
        .map(a => a.place!)
      for (let i = 0; i < places.length - 1; i++) {
        allPairs.push({ dayIndex: di, from: String(places[i].id), to: String(places[i + 1].id) })
      }
    }
    if (allPairs.length === 0) return

    // Determine if all are active → toggle off, else toggle on
    const allActive = allPairs.every(p => {
      const leg = allLegs.find(l => l.day_index === p.dayIndex && String(l.from_place_id) === p.from && String(l.to_place_id) === p.to)
      return leg?.is_road_trip
    })

    set({ _batchCancelled: false, batchProgress: { current: 0, total: allPairs.length } })

    if (allActive) {
      // Disable all — no OSRM calls needed, fast
      for (const p of allPairs) {
        const leg = allLegs.find(l => l.day_index === p.dayIndex && String(l.from_place_id) === p.from && String(l.to_place_id) === p.to)
        if (leg) {
          await get().toggleRoadTrip(tripIdStr, leg.id, false)
        }
      }
      set({ batchProgress: null })
    } else {
      // Enable all — sequential OSRM calls (rate limited server-side)
      for (let i = 0; i < allPairs.length; i++) {
        if (get()._batchCancelled) break
        const p = allPairs[i]
        const leg = allLegs.find(l => l.day_index === p.dayIndex && String(l.from_place_id) === p.from && String(l.to_place_id) === p.to)
        await get().toggleRoadTrip(tripIdStr, leg?.id ?? -1, true, p.dayIndex, p.from, p.to)
        set({ batchProgress: { current: i + 1, total: allPairs.length } })
      }
      set({ batchProgress: null, _batchCancelled: false })
    }
  },

  cancelBatch: () => {
    set({ _batchCancelled: true })
  },

  calculateRoute: async (tripId, dayIndex, fromPlaceId, toPlaceId) => {
    try {
      const data = await roadtripApi.calculateLeg(tripId, { day_index: dayIndex, from_place_id: fromPlaceId, to_place_id: toPlaceId })
      const leg = { ...data.leg, is_road_trip: !!data.leg.is_road_trip }
      set(s => {
        const existing = s.routeLegs[tripId] || []
        const idx = existing.findIndex(l => l.id === leg.id)
        const updated = idx >= 0
          ? existing.map(l => l.id === leg.id ? leg : l)
          : [...existing, leg]
        return { routeLegs: { ...s.routeLegs, [tripId]: updated } }
      })
      return leg
    } catch (err) {
      console.error('Failed to calculate route:', err)
      return null
    }
  },

  deleteRouteLeg: async (tripId, legId) => {
    try {
      await roadtripApi.deleteLeg(tripId, legId)
      set(s => ({
        routeLegs: {
          ...s.routeLegs,
          [tripId]: (s.routeLegs[tripId] || []).filter(l => l.id !== legId),
        }
      }))
    } catch (err) { console.error('Failed to delete route leg:', err) }
  },

  recalculateDay: async (tripId, dayIndex, placePairs) => {
    const legs = get().getLegsForDay(tripId, dayIndex)
    const roadTripFromIds = new Set(legs.filter(l => l.is_road_trip).map(l => `${l.from_place_id}-${l.to_place_id}`))

    for (const pair of placePairs) {
      const key = `${pair.from}-${pair.to}`
      if (roadTripFromIds.has(key)) {
        await get().calculateRoute(tripId, dayIndex, pair.from, pair.to)
      }
    }
  },

  recalculate: async (tripId) => {
    try {
      const data = await roadtripApi.recalculate(tripId)
      const legs = (data.legs || []).map((l: RouteLeg) => ({ ...l, is_road_trip: !!l.is_road_trip }))
      set(s => ({ routeLegs: { ...s.routeLegs, [tripId]: legs } }))
    } catch (err) { console.error('Failed to recalculate routes:', err) }
  },

  findStops: async (tripId, legId, stopType, searchPoints, corridor) => {
    try {
      set(s => ({ findingStopsLegIds: new Set([...s.findingStopsLegIds, legId]) }))
      await roadtripApi.findStops(tripId, legId, { stop_type: stopType, search_points: searchPoints, corridor })
      await get().loadRouteLegs(tripId)
    } catch (err) { console.error('Failed to find stops:', err) } finally {
      set(s => {
        const next = new Set(s.findingStopsLegIds)
        next.delete(legId)
        return { findingStopsLegIds: next }
      })
    }
  },

  autoFindStops: async (tripId, leg) => {
    if (!leg.route_geometry || !leg.distance_meters || !leg.duration_seconds) return
    try {
      const { decodePolyline, getRefuelPoints, haversine } = await import('../components/Map/RoadTripRoute')
      const settings = useSettingsStore.getState().settings
      const unitSystem = (settings.roadtrip_unit_system || 'metric') as 'metric' | 'imperial'
      const tankSize = parseFloat(settings.roadtrip_tank_size || '0')
      const fuelConsumption = parseFloat(settings.roadtrip_fuel_consumption || '0')
      const restIntervalHours = parseFloat(settings.roadtrip_rest_interval_hours || '0') || null
      const restDurationMinutes = parseFloat(settings.roadtrip_rest_duration_minutes || '0') || null

      const vehicleRangeMeters = tankSize && fuelConsumption
        ? calculateVehicleRange(tankSize, fuelConsumption, unitSystem) * (unitSystem === 'imperial' ? 1609.344 : 1000)
        : null

      const positions = decodePolyline(leg.route_geometry!)
      const totalDist = leg.distance_meters
      const exceedsRange = vehicleRangeMeters ? totalDist > vehicleRangeMeters : false
      const legHours = leg.duration_seconds / 3600
      const restBreaks = restIntervalHours && restDurationMinutes && legHours > restIntervalHours
        ? Math.floor(legHours / restIntervalHours) : 0

      const needsFuel = exceedsRange && vehicleRangeMeters
      const needsRest = restBreaks > 0 && restIntervalHours

      if (!needsFuel && !needsRest) return

      // Fuel: corridor search — sample every ~80km along the route to find ALL fuel stations
      if (needsFuel) {
        const corridorInterval = 150000 // 150km between sample points
        const corridorPts = getRefuelPoints(positions, corridorInterval)
        // Also add start and end points for coverage
        const corridorPoints: { lat: number; lng: number; distance_along_route_meters: number }[] = [
          { lat: positions[0][0], lng: positions[0][1], distance_along_route_meters: 0 },
        ]
        let cumDist = corridorInterval
        for (const pt of corridorPts) {
          corridorPoints.push({ lat: pt[0], lng: pt[1], distance_along_route_meters: cumDist })
          cumDist += corridorInterval
        }
        corridorPoints.push({ lat: positions[positions.length - 1][0], lng: positions[positions.length - 1][1], distance_along_route_meters: totalDist })
        await get().findStops(tripId, leg.id, 'fuel', corridorPoints, true)
      }

      // Rest: point search at rest intervals (unchanged — rest stops are needed at specific intervals)
      if (needsRest) {
        const avgSpeedMs = totalDist / leg.duration_seconds
        const restIntervalMeters = restIntervalHours! * 3600 * avgSpeedMs
        if (restIntervalMeters > 0 && totalDist > restIntervalMeters) {
          const restPts = getRefuelPoints(positions, restIntervalMeters)
          const restSearchPoints: { lat: number; lng: number; distance_along_route_meters: number }[] = []
          let cumDist = restIntervalMeters
          for (const pt of restPts) {
            restSearchPoints.push({ lat: pt[0], lng: pt[1], distance_along_route_meters: cumDist })
            cumDist += restIntervalMeters
          }
          if (restSearchPoints.length > 0) {
            await get().findStops(tripId, leg.id, 'rest', restSearchPoints)
          }
        }
      }
    } catch (err) { console.error('Failed to auto-find stops:', err) }
  },

  clearTrip: (tripId) => {
    set(s => {
      const next = { ...s.routeLegs }
      delete next[tripId]
      return { routeLegs: next }
    })
  },

  getLegsForDay: (tripId, dayIndex) => {
    return (get().routeLegs[tripId] || []).filter(l => l.day_index === dayIndex)
  },

  getLegBetween: (tripId, dayIndex, fromPlaceId, toPlaceId) => {
    return (get().routeLegs[tripId] || []).find(
      l => l.day_index === dayIndex && String(l.from_place_id) === String(fromPlaceId) && String(l.to_place_id) === String(toPlaceId)
    )
  },

  getTripTotals: (tripId, restIntervalHours, restDurationMinutes) => {
    const legs = (get().routeLegs[tripId] || []).filter(l => l.is_road_trip)
    const totalDistanceMeters = legs.reduce((sum, l) => sum + (l.distance_meters || 0), 0)
    const totalDurationSeconds = legs.reduce((sum, l) => sum + (l.duration_seconds || 0), 0)
    const totalFuelCost = legs.reduce((sum, l) => sum + (l.fuel_cost || 0), 0)

    let totalRestBreaks = 0
    if (restIntervalHours && restDurationMinutes) {
      for (const leg of legs) {
        const legHours = (leg.duration_seconds || 0) / 3600
        if (legHours > restIntervalHours) {
          totalRestBreaks += Math.floor(legHours / restIntervalHours)
        }
      }
    }
    const totalRestTimeSeconds = totalRestBreaks * (restDurationMinutes || 0) * 60

    return {
      totalDistanceMeters,
      totalDurationSeconds,
      totalFuelCost,
      totalRestBreaks,
      totalRestTimeSeconds,
      totalTravelTimeWithBreaks: totalDurationSeconds + totalRestTimeSeconds,
    }
  },

  getDayTotals: (tripId, dayIndex) => {
    const legs = (get().routeLegs[tripId] || []).filter(l => l.is_road_trip && l.day_index === dayIndex)
    return {
      distanceMeters: legs.reduce((sum, l) => sum + (l.distance_meters || 0), 0),
      durationSeconds: legs.reduce((sum, l) => sum + (l.duration_seconds || 0), 0),
      fuelCost: legs.reduce((sum, l) => sum + (l.fuel_cost || 0), 0),
    }
  },
}))
