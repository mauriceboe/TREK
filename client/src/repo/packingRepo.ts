import { packingApi } from '../api/client'
import { offlineDb, upsertPackingItems } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { PackingItem } from '../types'

export const packingRepo = {
  async list(tripId: number | string): Promise<{ items: PackingItem[] }> {
    if (!navigator.onLine) {
      const cached = await offlineDb.packingItems
        .where('trip_id')
        .equals(Number(tripId))
        .toArray()
      return { items: cached }
    }
    const result = await packingApi.list(tripId)
    upsertPackingItems(result.items)
    return result
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    if (!navigator.onLine) {
      const tempId = -(Date.now())
      const tempItem: PackingItem = {
        category: null,
        category_id: null,
        category_type: null,
        category_owner_id: null,
        ...(data as Partial<PackingItem>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New item',
        checked: 0,
      } as PackingItem
      await offlineDb.packingItems.put(tempItem)
      const id = generateUUID()
      await mutationQueue.enqueue({
        id,
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/packing`,
        body: data,
        resource: 'packingItems',
        tempId,
      })
      return { item: tempItem }
    }
    const result = await packingApi.create(tripId, data)
    offlineDb.packingItems.put(result.item)
    return result
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    if (!navigator.onLine) {
      const existing = await offlineDb.packingItems.get(id)
      const optimistic: PackingItem = { ...(existing ?? {} as PackingItem), ...(data as Partial<PackingItem>), id }
      await offlineDb.packingItems.put(optimistic)
      const mutId = generateUUID()
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'PUT',
        url: `/trips/${tripId}/packing/${id}`,
        body: data,
        resource: 'packingItems',
      })
      return { item: optimistic }
    }
    const result = await packingApi.update(tripId, id, data)
    offlineDb.packingItems.put(result.item)
    return result
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    if (!navigator.onLine) {
      await offlineDb.packingItems.delete(id)
      const mutId = generateUUID()
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'DELETE',
        url: `/trips/${tripId}/packing/${id}`,
        body: undefined,
        resource: 'packingItems',
        entityId: id,
      })
      return { success: true }
    }
    const result = await packingApi.delete(tripId, id)
    offlineDb.packingItems.delete(id)
    return result
  },
}
