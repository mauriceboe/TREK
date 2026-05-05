/**
 * Mutation queue — offline write queue backed by IndexedDB (Dexie).
 *
 * Flow:
 *   offline create/update/delete → enqueue() → optimistic Dexie write (in repo)
 *   online trigger → flush() → replay REST with X-Idempotency-Key header → update Dexie
 */
import { offlineDb } from '../db/offlineDb'
import { apiClient } from '../api/client'
import type { QueuedMutation } from '../db/offlineDb'
import type { Table } from 'dexie'

// Map Dexie table names used in `resource` field → actual Dexie tables.
function getTable(resource: string): Table | undefined {
  const map: Record<string, Table> = {
    trips:          offlineDb.trips,
    days:           offlineDb.days,
    places:         offlineDb.places,
    packingItems:   offlineDb.packingItems,
    todoItems:      offlineDb.todoItems,
    budgetItems:    offlineDb.budgetItems,
    reservations:   offlineDb.reservations,
    accommodations: offlineDb.accommodations,
    tripFiles:      offlineDb.tripFiles,
  }
  return map[resource]
}

/** Generate a v4-style UUID using the platform crypto API. */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID (e.g. old Node)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

let _flushing = false
// Monotonically increasing timestamp so same-millisecond enqueues
// still get a deterministic FIFO order when sorted by createdAt.
let _lastTs = 0

export const mutationQueue = {
  /**
   * Add a mutation to the queue.
   * Returns the UUID (= idempotency key).
   */
  async enqueue(
    mutation: Omit<QueuedMutation, 'status' | 'attempts' | 'createdAt' | 'lastError'>,
  ): Promise<string> {
    const now = Date.now()
    _lastTs = now > _lastTs ? now : _lastTs + 1
    const item: QueuedMutation = {
      ...mutation,
      status: 'pending',
      attempts: 0,
      createdAt: _lastTs,
      lastError: null,
    }
    await offlineDb.mutationQueue.put(item)
    return item.id
  },

  /**
   * Drain the queue: replay each pending mutation against the server in FIFO order.
   * Stops on first network error (will retry on next trigger).
   * 4xx responses are marked failed and skipped.
   */
  async flush(): Promise<void> {
    if (_flushing || !navigator.onLine) return
    _flushing = true
    try {
      while (true) {
        const pending = await offlineDb.mutationQueue
          .where('status')
          .equals('pending')
          .sortBy('createdAt')
        const mutation = pending[0]
        if (!mutation) break

        // Mark as syncing so UI can show progress
        await offlineDb.mutationQueue.update(mutation.id, { status: 'syncing' })

        try {
          const response = await apiClient.request({
            method: mutation.method,
            url: mutation.url,
            data: mutation.body,
            headers: { 'X-Idempotency-Key': mutation.id },
          })

          // Apply canonical server response to Dexie
          if (mutation.method !== 'DELETE' && mutation.resource) {
            const table = getTable(mutation.resource)
            if (table && response.data && typeof response.data === 'object') {
              // Server returns { place: {...} } or { item: {...} } — grab first value
              const values = Object.values(response.data as Record<string, unknown>)
              const entity = values[0]
              if (entity && typeof entity === 'object' && 'id' in entity) {
                // Remove temp optimistic entry if id changed (CREATE case)
                if (mutation.tempId !== undefined && mutation.tempId !== (entity as { id: number }).id) {
                  await table.delete(mutation.tempId)
                }
                await table.put(entity)
              }
            }
          } else if (mutation.method === 'DELETE' && mutation.resource && mutation.entityId !== undefined) {
            // DELETE was already applied optimistically; ensure it's gone
            const table = getTable(mutation.resource)
            if (table) await table.delete(mutation.entityId)
          }

          await offlineDb.mutationQueue.delete(mutation.id)
        } catch (err: unknown) {
          const httpStatus = (err as { response?: { status: number } })?.response?.status
          if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
            // Permanent client error — mark failed, continue with next
            await offlineDb.mutationQueue.update(mutation.id, {
              status: 'failed',
              attempts: mutation.attempts + 1,
              lastError: String(err),
            })
          } else {
            // Network error — reset to pending, abort flush (retry on next trigger)
            await offlineDb.mutationQueue.update(mutation.id, {
              status: 'pending',
              attempts: mutation.attempts + 1,
              lastError: String(err),
            })
            break
          }
        }
      }
    } finally {
      _flushing = false
    }
  },

  /**
   * Return all pending/syncing mutations, optionally filtered by tripId.
   * Used by the UI to show per-item pending indicators.
   */
  async pending(tripId?: number): Promise<QueuedMutation[]> {
    if (tripId !== undefined) {
      return offlineDb.mutationQueue
        .where('tripId')
        .equals(tripId)
        .filter(m => m.status === 'pending' || m.status === 'syncing')
        .toArray()
    }
    return offlineDb.mutationQueue
      .where('status')
      .anyOf(['pending', 'syncing'])
      .toArray()
  },

  /** Count pending mutations (for banner badge). */
  async pendingCount(): Promise<number> {
    return offlineDb.mutationQueue
      .where('status')
      .anyOf(['pending', 'syncing'])
      .count()
  },

  /** Reset internal flushing flag and timestamp counter — useful in tests. */
  _resetFlushing(): void {
    _flushing = false
    _lastTs = 0
  },
}
