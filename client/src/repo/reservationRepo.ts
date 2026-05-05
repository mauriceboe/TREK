import { reservationsApi } from '../api/client'
import { offlineDb, upsertReservations } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { Reservation } from '../types'

export const reservationRepo = {
  async list(tripId: number | string): Promise<{ reservations: Reservation[]; refresh: Promise<{ reservations: Reservation[] } | null> }> {
    const cached = await offlineDb.reservations
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      try {
        const result = await reservationsApi.list(tripId)
        upsertReservations(result.reservations).catch(() => {})
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { reservations: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { reservations: [], refresh: Promise.resolve(null) }
    return { reservations: fresh.reservations, refresh: Promise.resolve(null) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ reservation: Reservation }> {
    const tempId = -(Date.now())
    const tempReservation: Reservation = {
      ...(data as Partial<Reservation>),
      id: tempId,
      trip_id: Number(tripId),
      name: (data.name as string) ?? 'New reservation',
      type: (data.type as string) ?? 'other',
      status: 'pending',
      date: (data.date as string) ?? null,
      time: null,
      confirmation_number: null,
      notes: null,
      url: null,
      created_at: new Date().toISOString(),
    } as Reservation
    await offlineDb.reservations.put(tempReservation)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'POST',
      url: `/trips/${tripId}/reservations`,
      body: data,
      resource: 'reservations',
      tempId,
    })
    mutationQueue.flush().catch(() => {})
    return { reservation: tempReservation }
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ reservation: Reservation }> {
    const existing = await offlineDb.reservations.get(id)
    const optimistic: Reservation = { ...(existing ?? {} as Reservation), ...(data as Partial<Reservation>), id }
    await offlineDb.reservations.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/reservations/${id}`,
      body: data,
      resource: 'reservations',
    })
    mutationQueue.flush().catch(() => {})
    return { reservation: optimistic }
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    await offlineDb.reservations.delete(id)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/reservations/${id}`,
      body: undefined,
      resource: 'reservations',
      entityId: id,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },
}
