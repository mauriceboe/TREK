import { filesApi } from '../api/client'
import { offlineDb, upsertTripFiles } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { TripFile } from '../types'

export const fileRepo = {
  async list(tripId: number | string): Promise<{ files: TripFile[]; refresh: Promise<{ files: TripFile[] } | null> }> {
    const cached = await offlineDb.tripFiles
      .where('trip_id')
      .equals(Number(tripId))
      .toArray()

    const refresh = (async () => {
      if (!navigator.onLine) return null
      try {
        const result = await filesApi.list(tripId)
        upsertTripFiles(result.files)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { files: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { files: [], refresh: Promise.resolve(null) }
    return { files: fresh.files, refresh: Promise.resolve(fresh) }
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ file: TripFile }> {
    const existing = await offlineDb.tripFiles.get(id)
    const optimistic: TripFile = { ...(existing ?? {} as TripFile), ...(data as Partial<TripFile>), id: Number(id) }
    await offlineDb.tripFiles.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/files/${id}`,
      body: data,
      resource: 'tripFiles',
    })
    mutationQueue.flush().catch(() => {})
    return { file: optimistic }
  },

  async toggleStar(tripId: number | string, id: number): Promise<unknown> {
    const existing = await offlineDb.tripFiles.get(id)
    if (existing) {
      await offlineDb.tripFiles.put({ ...existing, starred: existing.starred ? 0 : 1 })
    }
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PATCH',
      url: `/trips/${tripId}/files/${id}/star`,
      body: undefined,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    await offlineDb.tripFiles.delete(id)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'DELETE',
      url: `/trips/${tripId}/files/${id}`,
      body: undefined,
      resource: 'tripFiles',
      entityId: id,
    })
    mutationQueue.flush().catch(() => {})
    return { success: true }
  },
}
