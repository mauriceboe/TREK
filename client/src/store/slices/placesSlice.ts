import { convexCreatePlace, convexUpdatePlace, convexDeletePlace } from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Place, Assignment } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface PlacesSlice {
  refreshPlaces: (tripId: number | string) => Promise<void>
  addPlace: (tripId: number | string, placeData: Partial<Place>) => Promise<Place>
  updatePlace: (tripId: number | string, placeId: number | string, placeData: Partial<Place>) => Promise<Place>
  deletePlace: (tripId: number | string, placeId: number | string) => Promise<void>
}

export const createPlacesSlice = (set: SetState, get: GetState): PlacesSlice => ({
  refreshPlaces: async (_tripId) => {
    // Convex reactivity handles refreshes automatically
  },

  addPlace: async (_tripId, placeData) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    const result = await convexCreatePlace(convexTripId as any, placeData as any)
    // Convex reactivity will update the store via the bridge hook
    return result as any as Place
  },

  updatePlace: async (_tripId, placeId, placeData) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    const result = await convexUpdatePlace(convexTripId as any, placeId as any, placeData as any)
    return result as any as Place
  },

  deletePlace: async (_tripId, placeId) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
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
    await convexDeletePlace(convexTripId as any, placeId as any)
  },
})
