import { useEffect, useRef } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useTripStore } from '../store/tripStore'
import type { AssignmentsMap, DayNotesMap } from '../types'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Bridge hook: subscribes to Convex reactive queries for trip data
 * and syncs results into the Zustand store. This replaces all
 * Express API calls AND WebSocket real-time sync.
 *
 * Mount this once inside TripPlannerPage.
 */
export function useConvexTripData(tripParam: string | undefined) {
  const prevTripRef = useRef<string | null>(null)

  // Step 1: Resolve URL param to Convex trip ID
  const convexTripId = useQuery(
    api.trips.resolveTripId,
    tripParam ? { tripParam } : 'skip',
  ) as Id<'plannerTrips'> | null | undefined

  // Step 2: Reactive queries — Convex auto-updates when data changes
  const trip = useQuery(
    api.trips.getTrip,
    convexTripId ? { tripId: convexTripId } : 'skip',
  )
  const daysData = useQuery(
    api.days.listDays,
    convexTripId ? { tripId: convexTripId } : 'skip',
  )
  const placesData = useQuery(
    api.places.listPlaces,
    convexTripId ? { tripId: convexTripId } : 'skip',
  )
  const legsData = useQuery(
    api.legs.listLegs,
    convexTripId ? { tripId: convexTripId } : 'skip',
  )
  const tagsData = useQuery(api.tags.listTags, convexTripId ? {} : 'skip')
  const categoriesData = useQuery(api.categories.listCategories, convexTripId ? {} : 'skip')

  // Sync trip into store
  useEffect(() => {
    if (!trip) return
    useTripStore.setState({ trip: trip as any, tripBackend: 'convex' })
  }, [trip])

  // Sync days + assignments + dayNotes into store
  useEffect(() => {
    if (!daysData) return
    const assignmentsMap: AssignmentsMap = {}
    const dayNotesMap: DayNotesMap = {}
    for (const day of daysData) {
      const dayId = String((day as any).id)
      assignmentsMap[dayId] = (day as any).assignments || []
      dayNotesMap[dayId] = (day as any).notes_items || []
    }
    useTripStore.setState({
      days: daysData as any,
      assignments: assignmentsMap,
      dayNotes: dayNotesMap,
    })
  }, [daysData])

  // Sync places into store
  useEffect(() => {
    if (!placesData) return
    useTripStore.setState({ places: placesData as any })
  }, [placesData])

  // Sync legs into store
  useEffect(() => {
    if (!legsData) return
    useTripStore.setState({ legs: legsData as any })
  }, [legsData])

  // Sync tags
  useEffect(() => {
    if (!tagsData) return
    useTripStore.setState({ tags: tagsData as any })
  }, [tagsData])

  // Sync categories
  useEffect(() => {
    if (!categoriesData) return
    useTripStore.setState({ categories: categoriesData as any })
  }, [categoriesData])

  const status: 'disabled' | 'missing' | 'resolving' | 'convex' =
    !tripParam
      ? 'disabled'
      : convexTripId === null
        ? 'missing'
        : convexTripId === undefined || trip === undefined || daysData === undefined || placesData === undefined
          ? 'resolving'
          : 'convex'

  // Handle loading state
  const isLoading = status === 'resolving'
  useEffect(() => {
    if (tripParam && prevTripRef.current !== tripParam) {
      useTripStore.setState({ isLoading: true, error: null })
      prevTripRef.current = tripParam
    }
    if (!isLoading && status !== 'disabled') {
      useTripStore.setState({ isLoading: false })
    }
  }, [tripParam, isLoading, status])

  // Handle trip not found
  useEffect(() => {
    if (convexTripId === null) {
      useTripStore.setState({ isLoading: false, error: 'Trip not found' })
    }
  }, [convexTripId])

  return { isLoading, convexTripId, status }
}
