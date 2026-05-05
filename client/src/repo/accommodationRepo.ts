import { accommodationsApi } from '../api/client'
import { offlineDb, upsertAccommodations } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { Accommodation } from '../types'

export const accommodationRepo = {
  async list(tripId: number | string): Promise<{ accommodations: Accommodation[]; refresh: Promise<{ accommodations: Accommodation[] } | null> }> {
    const cached = await offlineDb.accommodations
      .where('trip_id').equals(Number(tripId)).toArray()

    const refresh = (async () => {
      if (!navigator.onLine) return null
      try {
        const result = await accommodationsApi.list(tripId)
        upsertAccommodations(result.accommodations || []).catch(() => {})
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { accommodations: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { accommodations: [], refresh: Promise.resolve(null) }
    return { accommodations: fresh.accommodations, refresh: Promise.resolve(fresh) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ accommodation: Accommodation }> {
    const tempId = -(Date.now())
    const tempAccommodation: Accommodation = {
      ...(data as Partial<Accommodation>),
      id: tempId,
      trip_id: Number(tripId),
      name: (data.name as string) ?? 'New accommodation',
      address: null,
      check_in: null,
      check_in_end: null,
      check_out: null,
      confirmation_number: null,
      notes: null,
      url: null,
      created_at: new Date().toISOString(),
    } as Accommodation
    await offlineDb.accommodations.put(tempAccommodation)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'POST',
      url: `/trips/${tripId}/accommodations`,
      body: data,
      resource: 'accommodations',
      tempId,
    })
    mutationQueue.flush().catch(() => {})
    return { accommodation: tempAccommodation }
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ accommodation: Accommodation }> {
    const existing = await offlineDb.accommodations.get(id)
    const optimistic: Accommodation = { ...(existing ?? {} as Accommodation), ...(data as Partial<Accommodation>), id }
    await offlineDb.accommodations.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/accommodations/${id}`,
      body: data,
      resource: 'accommodations',
    })
    mutationQueue.flush().catch(() => {})
    return { accommodation: optimistic }
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    await offlineDb.accommodations.delete(id)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/accommodations/${id}`,
      body: undefined,
      resource: 'accommodations',
      entityId: id,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },
}
