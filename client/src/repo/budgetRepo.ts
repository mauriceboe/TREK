import { budgetApi } from '../api/client'
import { offlineDb, upsertBudgetItems } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { BudgetItem } from '../types'

export const budgetRepo = {
  async list(tripId: number | string): Promise<{ items: BudgetItem[]; refresh: Promise<{ items: BudgetItem[] } | null> }> {
    const cached = await offlineDb.budgetItems
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      try {
        const result = await budgetApi.list(tripId)
        upsertBudgetItems(result.items)
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

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ item: BudgetItem }> {
    if (!navigator.onLine) {
      const tempId = -(Date.now())
      const tempItem: BudgetItem = {
        ...(data as Partial<BudgetItem>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New expense',
        amount: (data.amount as number) ?? 0,
        currency: (data.currency as string) ?? 'USD',
        members: [],
      } as BudgetItem
      await offlineDb.budgetItems.put(tempItem)
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/budget`,
        body: data,
        resource: 'budgetItems',
        tempId,
      })
      return { item: tempItem }
    }
    const result = await budgetApi.create(tripId, data)
    offlineDb.budgetItems.put(result.item)
    return result
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: BudgetItem }> {
    if (!navigator.onLine) {
      const existing = await offlineDb.budgetItems.get(id)
      const optimistic: BudgetItem = { ...(existing ?? {} as BudgetItem), ...(data as Partial<BudgetItem>), id }
      await offlineDb.budgetItems.put(optimistic)
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'PUT',
        url: `/trips/${tripId}/budget/${id}`,
        body: data,
        resource: 'budgetItems',
      })
      return { item: optimistic }
    }
    const result = await budgetApi.update(tripId, id, data)
    offlineDb.budgetItems.put(result.item)
    return result
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    if (!navigator.onLine) {
      await offlineDb.budgetItems.delete(id)
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'DELETE',
        url: `/trips/${tripId}/budget/${id}`,
        body: undefined,
        resource: 'budgetItems',
        entityId: id,
      })
      return { success: true }
    }
    const result = await budgetApi.delete(tripId, id)
    offlineDb.budgetItems.delete(id)
    return result
  },
}
