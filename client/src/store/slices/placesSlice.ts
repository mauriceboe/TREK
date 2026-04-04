import { placesApi } from '../../api/client'
import { convexCreatePlace, convexUpdatePlace, convexDeletePlace } from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Place, Assignment } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface PlacesSlice {
  refreshPlaces: (tripId: number | string) => Promise<void>
  addPlace: (tripId: number | string, placeData: Partial<Place>) => Promise<Place>
  updatePlace: (tripId: number | string, placeId: number | string, placeData: Partial<Place>) => Promise<Place>
  deletePlace: (tripId: number | string, placeId: number | string) => Promise<void>
}

export const createPlacesSlice = (set: SetState, get: GetState): PlacesSlice => ({
  refreshPlaces: async (tripId) => {
    // With Convex, the bridge hook handles reactive refreshes
    if (get().tripBackend === 'convex') return
    try {
      const data = await placesApi.list(tripId)
      set({ places: data.places })
    } catch (err: unknown) {
      console.error('Failed to refresh places:', err)
    }
  },

  addPlace: async (tripId, placeData) => {
    if (get().tripBackend === 'convex') {
      const result = await convexCreatePlace(tripId as any, placeData as any)
      // Convex reactivity will update the store, but return immediately
      return result as any as Place
    }
    try {
      const data = await placesApi.create(tripId, placeData)
      set(state => ({ places: [data.place, ...state.places] }))
      return data.place
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding place'))
    }
  },

  updatePlace: async (tripId, placeId, placeData) => {
    if (get().tripBackend === 'convex') {
      const result = await convexUpdatePlace(tripId as any, placeId as any, placeData as any)
      return result as any as Place
    }
    try {
      const data = await placesApi.update(tripId, placeId as number, placeData)
      set(state => ({
        places: state.places.map(p => p.id === placeId ? data.place : p),
        assignments: Object.fromEntries(
          Object.entries(state.assignments).map(([dayId, items]) => [
            dayId,
            items.map((a: Assignment) => a.place?.id === placeId ? { ...a, place: { ...data.place, place_time: a.place.place_time, end_time: a.place.end_time } } : a)
          ])
        ),
      }))
      return data.place
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating place'))
    }
  },

  deletePlace: async (tripId, placeId) => {
    if (get().tripBackend === 'convex') {
      // Optimistic removal
      set(state => ({
        places: state.places.filter(p => p.id !== placeId),
        assignments: Object.fromEntries(
          Object.entries(state.assignments).map(([dayId, items]) => [
            dayId,
            items.filter((a: Assignment) => a.place?.id !== placeId)
          ])
        ),
      }))
      await convexDeletePlace(tripId as any, placeId as any)
      return
    }
    try {
      await placesApi.delete(tripId, placeId as number)
      set(state => ({
        places: state.places.filter(p => p.id !== placeId),
        assignments: Object.fromEntries(
          Object.entries(state.assignments).map(([dayId, items]) => [
            dayId,
            items.filter((a: Assignment) => a.place?.id !== placeId)
          ])
        ),
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error deleting place'))
    }
  },
})
