import { tripsApi } from '../../api/client'
import { convexCreateLeg, convexUpdateLeg, convexDeleteLeg } from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { TripLeg } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

const LEG_SORT = (a: TripLeg, b: TripLeg): number =>
  a.start_day_number - b.start_day_number || a.end_day_number - b.end_day_number || Number(a.id) - Number(b.id)

export interface LegsSlice {
  addTripLeg: (tripId: number | string, data: Partial<TripLeg>) => Promise<TripLeg>
  updateTripLeg: (tripId: number | string, legId: number | string, data: Partial<TripLeg>) => Promise<TripLeg>
  deleteTripLeg: (tripId: number | string, legId: number | string) => Promise<void>
}

export const createLegsSlice = (set: SetState, _get: GetState): LegsSlice => ({
  addTripLeg: async (tripId, data) => {
    if (_get().tripBackend === 'convex') {
      const result = await convexCreateLeg(tripId as any, data as any)
      // Convex reactivity will update the store
      return result as any as TripLeg
    }
    try {
      const result = await tripsApi.createLeg(tripId, data as Record<string, unknown>)
      set(state => ({ legs: [...state.legs, result.leg].sort(LEG_SORT) }))
      return result.leg
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating trip leg'))
    }
  },

  updateTripLeg: async (tripId, legId, data) => {
    if (_get().tripBackend === 'convex') {
      const result = await convexUpdateLeg(tripId as any, legId as any, data as any)
      return result as any as TripLeg
    }
    try {
      const result = await tripsApi.updateLeg(tripId, legId as number, data as Record<string, unknown>)
      set(state => ({
        legs: state.legs.map(l => l.id === legId ? result.leg : l).sort(LEG_SORT),
      }))
      return result.leg
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating trip leg'))
    }
  },

  deleteTripLeg: async (tripId, legId) => {
    if (_get().tripBackend === 'convex') {
      // Optimistic removal
      set(state => ({ legs: state.legs.filter(l => l.id !== legId) }))
      await convexDeleteLeg(tripId as any, legId as any)
      return
    }
    try {
      await tripsApi.deleteLeg(tripId, legId as number)
      set(state => ({ legs: state.legs.filter(l => l.id !== legId) }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error deleting trip leg'))
    }
  },
})
