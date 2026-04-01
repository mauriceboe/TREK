import { placesApi } from '../../api/client'
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
}

export const createPlacesSlice = (set: SetState, get: GetState): PlacesSlice => ({
  refreshPlaces: async (tripId) => {
    try {
      const data = await placesApi.list(tripId)
      set({ places: data.places })
    } catch (err: unknown) {
      console.error('Failed to refresh places:', err)
    }
  },

  addPlace: async (tripId, placeData) => {
    try {
      const data = await placesApi.create(tripId, placeData)
      set(state => ({ places: [data.place, ...state.places] }))
      return data.place
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding place'))
    }
  },

  updatePlace: async (tripId, placeId, placeData) => {
    try {
      const data = await placesApi.update(tripId, placeId, placeData)
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
      await placesApi.delete(tripId, placeId)
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
})
