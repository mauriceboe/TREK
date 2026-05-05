import { todoApi } from '../api/client'
import { offlineDb, upsertTodoItems } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { TodoItem } from '../types'

export const todoRepo = {
  async list(tripId: number | string): Promise<{ items: TodoItem[]; refresh: Promise<{ items: TodoItem[] } | null> }> {
    const cached = await offlineDb.todoItems
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      try {
        const result = await todoApi.list(tripId)
        await upsertTodoItems(result.items)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { items: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { items: [], refresh: Promise.resolve(null) }
    return { items: fresh.items, refresh: Promise.resolve(null) }
  },

  async create(tripId: number | string, data: Record<string, unknown>): Promise<{ item: TodoItem }> {
    const tempId = -(Date.now())
    const tempItem: TodoItem = {
      ...(data as Partial<TodoItem>),
      id: tempId,
      trip_id: Number(tripId),
      name: (data.name as string) ?? 'New todo',
      checked: 0,
      sort_order: 0,
      due_date: null,
      description: null,
      assigned_user_id: null,
      priority: 0,
    } as TodoItem
    await offlineDb.todoItems.put(tempItem)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'POST',
      url: `/trips/${tripId}/todo`,
      body: data,
      resource: 'todoItems',
      tempId,
    })
    mutationQueue.flush().catch(() => {})
    return { item: tempItem }
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: TodoItem }> {
    const existing = await offlineDb.todoItems.get(id)
    const optimistic: TodoItem = { ...(existing ?? {} as TodoItem), ...(data as Partial<TodoItem>), id }
    await offlineDb.todoItems.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/todo/${id}`,
      body: data,
      resource: 'todoItems',
    })
    mutationQueue.flush().catch(() => {})
    return { item: optimistic }
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    await offlineDb.todoItems.delete(id)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/todo/${id}`,
      body: undefined,
      resource: 'todoItems',
      entityId: id,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },
}
