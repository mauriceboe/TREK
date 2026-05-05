import { tripsApi } from '../api/client'
import { offlineDb, upsertTrip } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { Trip } from '../types'

type TripsRefresh = Promise<{ trips: Trip[]; archivedTrips: Trip[] } | null>
type TripRefresh = Promise<{ trip: Trip } | null>

export const tripRepo = {
  async list(): Promise<{ trips: Trip[]; archivedTrips: Trip[]; refresh: TripsRefresh }> {
    const all = await offlineDb.trips.toArray()

    const refresh: TripsRefresh = (async () => {
      try {
        const [active, archived] = await Promise.all([
          tripsApi.list(),
          tripsApi.list({ archived: 1 }),
        ])
        await Promise.all([
          ...active.trips.map(t => upsertTrip(t)),
          ...archived.trips.map(t => upsertTrip(t)),
        ])
        return { trips: active.trips, archivedTrips: archived.trips }
      } catch {
        return null
      }
    })()

    if (all.length > 0) {
      return {
        trips: all.filter(t => !t.is_archived),
        archivedTrips: all.filter(t => t.is_archived),
        refresh,
      }
    }

    const fresh = await refresh
    if (!fresh) return { trips: [], archivedTrips: [], refresh: Promise.resolve(null) }
    // Data came straight from network — no background re-fetch needed
    return { ...fresh, refresh: Promise.resolve(null) }
  },

  async get(tripId: number | string): Promise<{ trip: Trip; refresh: TripRefresh }> {
    const cached = await offlineDb.trips.get(Number(tripId))

    const refresh: TripRefresh = (async () => {
      try {
        const result = await tripsApi.get(tripId)
        await upsertTrip(result.trip)
        return result
      } catch {
        return null
      }
    })()

    if (cached) return { trip: cached, refresh }

    const fresh = await refresh
    if (!fresh) throw new Error('No cached trip data available offline')
    return { trip: fresh.trip, refresh: Promise.resolve(null) }
  },

  async update(tripId: number | string, data: Partial<Trip>): Promise<{ trip: Trip }> {
    const existing = await offlineDb.trips.get(Number(tripId))
    const optimistic: Trip = { ...(existing ?? {} as Trip), ...(data as Partial<Trip>), id: Number(tripId) }
    await offlineDb.trips.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}`,
      body: data as Record<string, unknown>,
      resource: 'trips',
    })
    mutationQueue.flush().catch(() => {})
    return { trip: optimistic }
  },
}
