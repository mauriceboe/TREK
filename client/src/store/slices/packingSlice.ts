import { convexClient } from '../../convex/provider'
import { api } from '../../../convex/_generated/api'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { PackingItem } from '../../types'

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

export interface PackingSlice {
  addPackingItem: (tripId: number | string, data: Partial<PackingItem>) => Promise<PackingItem>
  updatePackingItem: (tripId: number | string, id: number, data: Partial<PackingItem>) => Promise<PackingItem>
  deletePackingItem: (tripId: number | string, id: number) => Promise<void>
  togglePackingItem: (tripId: number | string, id: number, checked: boolean) => Promise<void>
}

export const createPackingSlice = (set: SetState, get: GetState): PackingSlice => ({
  addPackingItem: async (_tripId, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.packing.create, { tripId: convexTripId, data })
    set(state => ({ packingItems: [...state.packingItems, result.item as any] }))
    return result.item as any
  },

  updatePackingItem: async (_tripId, id, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.packing.update, { tripId: convexTripId, itemId: String(id), data })
    set(state => ({
      packingItems: state.packingItems.map(item => String(item.id) === String(id) ? result.item as any : item)
    }))
    return result.item as any
  },

  deletePackingItem: async (_tripId, id) => {
    const convexTripId = getTripId(get)
    const prev = get().packingItems
    set(state => ({ packingItems: state.packingItems.filter(item => String(item.id) !== String(id)) }))
    try {
      await getClient().mutation(api.packing.remove, { tripId: convexTripId, itemId: String(id) })
    } catch {
      set({ packingItems: prev })
    }
  },

  togglePackingItem: async (_tripId, id, checked) => {
    const convexTripId = getTripId(get)
    set(state => ({
      packingItems: state.packingItems.map(item =>
        String(item.id) === String(id) ? { ...item, checked: checked ? 1 : 0 } : item
      )
    }))
    try {
      await getClient().mutation(api.packing.update, { tripId: convexTripId, itemId: String(id), data: { checked } })
    } catch {
      set(state => ({
        packingItems: state.packingItems.map(item =>
          String(item.id) === String(id) ? { ...item, checked: checked ? 0 : 1 } : item
        )
      }))
    }
  },
})
