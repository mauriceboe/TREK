import { packingApi } from '../api/client'
import { offlineDb, upsertPackingItems } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { PackingItem } from '../types'

export const packingRepo = {
  async list(tripId: number | string): Promise<{ items: PackingItem[]; refresh: Promise<{ items: PackingItem[] } | null> }> {
    const cached = await offlineDb.packingItems
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      if (!navigator.onLine) return null
      try {
        const result = await packingApi.list(tripId)
        upsertPackingItems(result.items)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { items: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { items: [], refresh: Promise.resolve(null) }
    return { items: fresh.items, refresh: Promise.resolve(fresh) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    const tempId = -(Date.now())
    const tempItem: PackingItem = {
      ...(data as Partial<PackingItem>),
      id: tempId,
      trip_id: Number(tripId),
      name: (data.name as string) ?? 'New item',
      checked: 0,
    } as PackingItem
    await offlineDb.packingItems.put(tempItem)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'POST',
      url: `/trips/${tripId}/packing`,
      body: data,
      resource: 'packingItems',
      tempId,
    })
    mutationQueue.flush().catch(() => {})
    return { item: tempItem }
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    const existing = await offlineDb.packingItems.get(id)
    const optimistic: PackingItem = { ...(existing ?? {} as PackingItem), ...(data as Partial<PackingItem>), id }
    await offlineDb.packingItems.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/packing/${id}`,
      body: data,
      resource: 'packingItems',
    })
    mutationQueue.flush().catch(() => {})
    return { item: optimistic }
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    await offlineDb.packingItems.delete(id)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/packing/${id}`,
      body: undefined,
      resource: 'packingItems',
      entityId: id,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },
}
