import { daysApi } from '../api/client'
import { offlineDb, upsertDays } from '../db/offlineDb'
import { mutationQueue, generateUUID } from '../sync/mutationQueue'
import type { Day } from '../types'

export const dayRepo = {
  async list(tripId: number | string): Promise<{ days: Day[]; refresh: Promise<{ days: Day[] } | null> }> {
    const cached = (await offlineDb.days
      .where('trip_id')
      .equals(Number(tripId))
      .sortBy('day_number' as keyof Day)) as Day[]

    const refresh = (async () => {
      if (!navigator.onLine) return null
      try {
        const result = await daysApi.list(tripId)
        upsertDays(result.days)
        return result
      } catch {
        return null
      }
    })()

    if (cached.length > 0) return { days: cached, refresh }

    const fresh = await refresh
    if (!fresh) return { days: [], refresh: Promise.resolve(null) }
    return { days: fresh.days, refresh: Promise.resolve(fresh) }
  },

  async update(tripId: number | string, dayId: number | string, data: Record<string, unknown>): Promise<{ day: Day }> {
    const existing = await offlineDb.days.get(Number(dayId))
    const optimistic: Day = { ...(existing ?? {} as Day), ...data, id: Number(dayId) }
    await offlineDb.days.put(optimistic)
    await mutationQueue.enqueue({
      id: generateUUID(),
      tripId: Number(tripId),
      method: 'PUT',
      url: `/trips/${tripId}/days/${dayId}`,
      body: data,
      resource: 'days',
    })
    mutationQueue.flush().catch(() => {})
    return { day: optimistic }
  },
}
