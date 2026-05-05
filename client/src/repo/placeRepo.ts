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
      try {
        const result = await placesApi.list(tripId, params)
        await upsertPlaces(result.places)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { places: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { places: [], refresh: Promise.resolve(null) }
    return { places: fresh.places, refresh: Promise.resolve(null) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    const tempId = -(Date.now())
    const tempPlace: Place = {
      ...(data as Partial<Place>),
      id: tempId,
      trip_id: Number(tripId),
      name: (data.name as string) ?? 'New place',
    } as Place
    await offlineDb.places.put(tempPlace)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'POST',
      url: `/trips/${tripId}/places`,
      body: data,
      resource: 'places',
      tempId,
    })
    mutationQueue.flush().catch(() => {})
    return { place: tempPlace }
  },

  async update(tripId: number | string, id: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    const existing = await offlineDb.places.get(Number(id))
    const optimistic: Place = { ...(existing ?? {} as Place), ...(data as Partial<Place>), id: Number(id) }
    await offlineDb.places.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/places/${id}`,
      body: data,
      resource: 'places',
    })
    mutationQueue.flush().catch(() => {})
    return { place: optimistic }
  },

  async delete(tripId: number | string, id: number | string): Promise<unknown> {
    await offlineDb.places.delete(Number(id))
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/places/${id}`,
      body: undefined,
      resource: 'places',
      entityId: Number(id),
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },

  async deleteMany(tripId: number | string, ids: number[]): Promise<unknown> {
    await offlineDb.places.bulkDelete(ids)
    for (const id of ids) {
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'DELETE',
        url: `/trips/${tripId}/places/${id}`,
        body: undefined,
        resource: 'places',
        entityId: id,
      })
    }
    mutationQueue.flush().catch(() => {})
    return { deleted: ids, count: ids.length }
  },
}
