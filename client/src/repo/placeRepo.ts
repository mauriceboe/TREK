import { placesApi } from '../api/client'
import { offlineDb, upsertPlaces } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { Place } from '../types'

export const placeRepo = {
  async list(tripId: number | string, params?: Record<string, unknown>): Promise<{ places: Place[]; refresh: Promise<{ places: Place[] } | null> }> {
    const cached = await offlineDb.places
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      if (!navigator.onLine) return null
      try {
        const result = await placesApi.list(tripId, params)
        upsertPlaces(result.places)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { places: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { places: [], refresh: Promise.resolve(null) }
    return { places: fresh.places, refresh: Promise.resolve(fresh) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    if (!navigator.onLine) {
      const tempId = -(Date.now())
      const tempPlace: Place = {
        ...(data as Partial<Place>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New place',
      } as Place
      await offlineDb.places.put(tempPlace)
      const id = generateUUID()
      await mutationQueue.enqueue({
        id,
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/places`,
        body: data,
        resource: 'places',
        tempId,
      })
      return { place: tempPlace }
    }
    const result = await placesApi.create(tripId, data)
    offlineDb.places.put(result.place)
    return result
  },

  async update(tripId: number | string, id: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    if (!navigator.onLine) {
      const existing = await offlineDb.places.get(Number(id))
      const optimistic: Place = { ...(existing ?? {} as Place), ...(data as Partial<Place>), id: Number(id) }
      await offlineDb.places.put(optimistic)
      const mutId = generateUUID()
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'PUT',
        url: `/trips/${tripId}/places/${id}`,
        body: data,
        resource: 'places',
      })
      return { place: optimistic }
    }
    const result = await placesApi.update(tripId, id, data)
    offlineDb.places.put(result.place)
    return result
  },

  async delete(tripId: number | string, id: number | string): Promise<unknown> {
    if (!navigator.onLine) {
      await offlineDb.places.delete(Number(id))
      const mutId = generateUUID()
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'DELETE',
        url: `/trips/${tripId}/places/${id}`,
        body: undefined,
        resource: 'places',
        entityId: Number(id),
      })
      return { success: true }
    }
    const result = await placesApi.delete(tripId, id)
    offlineDb.places.delete(Number(id))
    return result
  },

  async deleteMany(tripId: number | string, ids: number[]): Promise<unknown> {
    if (!navigator.onLine) {
      await offlineDb.places.bulkDelete(ids)
      for (const id of ids) {
        const mutId = generateUUID()
        await mutationQueue.enqueue({
          id: mutId,
          tripId: Number(tripId),
          method: 'DELETE',
          url: `/trips/${tripId}/places/${id}`,
          body: undefined,
          resource: 'places',
          entityId: id,
        })
      }
      return { deleted: ids, count: ids.length }
    }
    const result = await placesApi.bulkDelete(tripId, ids)
    await offlineDb.places.bulkDelete(ids)
    return result
  },
}
