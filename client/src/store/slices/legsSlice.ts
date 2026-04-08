import { convexCreateLeg, convexUpdateLeg, convexDeleteLeg } from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { TripLeg } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface LegsSlice {
  addTripLeg: (tripId: number | string, data: Partial<TripLeg>) => Promise<TripLeg>
  updateTripLeg: (tripId: number | string, legId: number | string, data: Partial<TripLeg>) => Promise<TripLeg>
  deleteTripLeg: (tripId: number | string, legId: number | string) => Promise<void>
}

export const createLegsSlice = (set: SetState, get: GetState): LegsSlice => ({
  addTripLeg: async (_tripId, data) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    const result = await convexCreateLeg(convexTripId as any, data as any)
    return result as any as TripLeg
  },

  updateTripLeg: async (_tripId, legId, data) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    const result = await convexUpdateLeg(convexTripId as any, legId as any, data as any)
    return result as any as TripLeg
  },

  deleteTripLeg: async (_tripId, legId) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    set(state => ({ legs: state.legs.filter(l => l.id !== legId) }))
    await convexDeleteLeg(convexTripId as any, legId as any)
  },
})
