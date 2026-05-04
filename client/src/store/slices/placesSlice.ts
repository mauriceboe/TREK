import { placeRepo } from '../../repo/placeRepo'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Place, Assignment } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface PlacesSlice {
  refreshPlaces: (tripId: number | string) => Promise<void>
  addPlace: (tripId: number | string, placeData: Partial<Place>) => Promise<Place>
  updatePlace: (tripId: number | string, placeId: number, placeData: Partial<Place>) => Promise<Place>
  deletePlace: (tripId: number | string, placeId: number) => Promise<void>
  deletePlacesMany: (tripId: number | string, placeIds: number[]) => Promise<void>
}

export const createPlacesSlice = (set: SetState, get: GetState): PlacesSlice => ({
  refreshPlaces: async (tripId) => {
    try {
      const data = await placeRepo.list(tripId)
      set({ places: data.places })
      data.refresh.then(fresh => {
        if (fresh) set({ places: fresh.places })
      }).catch(() => {})
    } catch (err: unknown) {
      console.error('Failed to refresh places:', err)
    }
  },

  addPlace: async (tripId, placeData) => {
    try {
      const data = await placeRepo.create(tripId, placeData as Record<string, unknown>)
      set(state => ({ places: [data.place, ...state.places] }))
      return data.place
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding place'))
    }
  },

  updatePlace: async (tripId, placeId, placeData) => {
    try {
      const data = await placeRepo.update(tripId, placeId, placeData as Record<string, unknown>)
      set(state => {
        const updatedAssignments = { ...state.assignments }
        let changed = false
        for (const [dayId, items] of Object.entries(state.assignments)) {
          if (items.some((a: Assignment) => a.place?.id === placeId)) {
            updatedAssignments[dayId] = items.map((a: Assignment) =>
              a.place?.id === placeId ? { ...a, place: { ...data.place, place_time: a.place.place_time, end_time: a.place.end_time } } : a
            )
            changed = true
          }
        }
        return {
          places: state.places.map(p => p.id === placeId ? data.place : p),
          ...(changed ? { assignments: updatedAssignments } : {}),
        }
      })
      return data.place
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating place'))
    }
  },

  deletePlace: async (tripId, placeId) => {
    try {
      await placeRepo.delete(tripId, placeId)
      set(state => {
        const updatedAssignments = { ...state.assignments }
        let changed = false
        for (const [dayId, items] of Object.entries(state.assignments)) {
          if (items.some((a: Assignment) => a.place?.id === placeId)) {
            updatedAssignments[dayId] = items.filter((a: Assignment) => a.place?.id !== placeId)
            changed = true
          }
        }
        return {
          places: state.places.filter(p => p.id !== placeId),
          ...(changed ? { assignments: updatedAssignments } : {}),
        }
      })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error deleting place'))
    }
  },

  deletePlacesMany: async (tripId, placeIds) => {
    if (placeIds.length === 0) return
    try {
      await placeRepo.deleteMany(tripId, placeIds)
      const idSet = new Set(placeIds)
      set(state => {
        const updatedAssignments = { ...state.assignments }
        let changed = false
        for (const [dayId, items] of Object.entries(state.assignments)) {
          if (items.some((a: Assignment) => a.place?.id != null && idSet.has(a.place.id))) {
            updatedAssignments[dayId] = items.filter((a: Assignment) => !idSet.has(a.place?.id!))
            changed = true
          }
        }
        return {
          places: state.places.filter(p => !idSet.has(p.id)),
          ...(changed ? { assignments: updatedAssignments } : {}),
        }
      })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error deleting places'))
    }
  },
})
