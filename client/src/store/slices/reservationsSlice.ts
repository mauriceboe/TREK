import { convexClient } from '../../convex/provider'
import { api } from '../../../convex/_generated/api'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Reservation } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

function getClient() {
  if (!convexClient) throw new Error('Convex not configured')
  return convexClient
}

function getTripId(get: GetState): any {
  const trip = get().trip as any
  return trip?._id || trip?.id
}

export interface ReservationsSlice {
  loadReservations: (tripId: number | string) => Promise<void>
  addReservation: (tripId: number | string, data: Partial<Reservation>) => Promise<Reservation>
  updateReservation: (tripId: number | string, id: number, data: Partial<Reservation>) => Promise<Reservation>
  toggleReservationStatus: (tripId: number | string, id: number) => Promise<void>
  deleteReservation: (tripId: number | string, id: number) => Promise<void>
}

export const createReservationsSlice = (set: SetState, get: GetState): ReservationsSlice => ({
  loadReservations: async (_tripId) => {
    try {
      const convexTripId = getTripId(get)
      if (!convexTripId) return
      const data = await getClient().query(api.reservations.list, { tripId: convexTripId })
      set({ reservations: data.reservations as any[] })
    } catch (err) {
      console.error('Failed to load reservations:', err)
    }
  },

  addReservation: async (_tripId, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.reservations.create, { tripId: convexTripId, data })
    set(state => ({ reservations: [result.reservation as any, ...state.reservations] }))
    return result.reservation as any
  },

  updateReservation: async (_tripId, id, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.reservations.update, { tripId: convexTripId, itemId: String(id), data })
    set(state => ({
      reservations: state.reservations.map(r => String(r.id) === String(id) ? result.reservation as any : r)
    }))
    return result.reservation as any
  },

  toggleReservationStatus: async (_tripId, id) => {
    const convexTripId = getTripId(get)
    const prev = get().reservations
    const current = prev.find(r => String(r.id) === String(id))
    if (!current) return
    const newStatus = current.status === 'confirmed' ? 'pending' : 'confirmed'
    set(state => ({
      reservations: state.reservations.map(r => String(r.id) === String(id) ? { ...r, status: newStatus } as any : r)
    }))
    try {
      await getClient().mutation(api.reservations.update, { tripId: convexTripId, itemId: String(id), data: { status: newStatus } })
    } catch {
      set({ reservations: prev })
    }
  },

  deleteReservation: async (_tripId, id) => {
    const convexTripId = getTripId(get)
    set(state => ({ reservations: state.reservations.filter(r => String(r.id) !== String(id)) }))
    await getClient().mutation(api.reservations.remove, { tripId: convexTripId, itemId: String(id) })
  },
})
