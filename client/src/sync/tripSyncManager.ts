/**
 * Trip sync manager — seeds Dexie with trip data for offline use.
 *
 * Cache scope: trips where end_date >= today OR end_date is null/empty.
 * Eviction: trips where end_date < today - 7 days.
 * File blobs: all non-photo files (MIME type != image/*) for cached trips.
 *
 * Call syncAll() on:
 *   - login success
 *   - trip list refresh (DashboardPage)
 *   - WS reconnect (phase 7)
 */
import { tripsApi, tagsApi, categoriesApi } from '../api/client'
import {
  offlineDb,
  upsertTrip,
  upsertDays,
  upsertPlaces,
  upsertPackingItems,
  upsertTodoItems,
  upsertBudgetItems,
  upsertReservations,
  upsertTripFiles,
  upsertAccommodations,
  upsertTripMembers,
  upsertTags,
  upsertCategories,
  upsertSyncMeta,
  clearTripData,
  clearBlobCache,
  clearAll,
} from '../db/offlineDb'
import { prefetchTilesForTrip } from './tilePrefetcher'
import { useSettingsStore } from '../store/settingsStore'
import type { Trip, Day, Place, PackingItem, TodoItem, BudgetItem, Reservation, TripFile, Accommodation, TripMember } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TripBundle {
  trip: Trip
  days: Day[]
  places: Place[]
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  budgetItems: BudgetItem[]
  reservations: Reservation[]
  files: TripFile[]
  accommodations: Accommodation[]
  members: TripMember[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function shouldCache(trip: Trip): boolean {
  if (!trip.end_date) return true            // no end date → cache forever
  return trip.end_date >= todayStr()          // ongoing or future
}

function isStale(trip: Trip): boolean {
  if (!trip.end_date) return false
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  return trip.end_date < cutoff.toISOString().slice(0, 10)
}

function isPhoto(file: TripFile): boolean {
  return file.mime_type.startsWith('image/')
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'QuotaExceededError') return true
  // Dexie wraps IDB errors: AbortError with inner QuotaExceededError
  const inner = (err as { inner?: unknown }).inner
  return inner instanceof Error && inner.name === 'QuotaExceededError'
}

// ── Core logic ────────────────────────────────────────────────────────────────

/** Fetch bundle + write all entities for one trip into Dexie. */
async function syncTrip(tripId: number): Promise<void> {
  const bundle = await tripsApi.bundle(tripId) as TripBundle

  await upsertTrip(bundle.trip)
  await upsertDays(bundle.days)
  await upsertPlaces(bundle.places)
  await upsertPackingItems(bundle.packingItems)
  await upsertTodoItems(bundle.todoItems)
  await upsertBudgetItems(bundle.budgetItems)
  await upsertReservations(bundle.reservations)
  await upsertTripFiles(bundle.files)
  await upsertAccommodations(bundle.accommodations || [])
  await upsertTripMembers(tripId, bundle.members || [])
  await upsertSyncMeta({
    tripId,
    lastSyncedAt: Date.now(),
    status: 'idle',
    tilesBbox: null,
    filesCachedCount: 0,
  })
}

/** Cache non-photo file blobs for a trip. Fire-and-forget safe. */
async function cacheFilesForTrip(files: TripFile[]): Promise<void> {
  const nonPhotos = files.filter(f => f.url && !isPhoto(f))
  let cached = 0

  for (const file of nonPhotos) {
    // Skip if already cached
    const existing = await offlineDb.blobCache.get(file.url!)
    if (existing) { cached++; continue }

    try {
      const resp = await fetch(file.url!, { credentials: 'include' })
      if (!resp.ok) continue
      const blob = await resp.blob()
      await offlineDb.blobCache.put({ url: file.url!, blob, mime: file.mime_type, cachedAt: Date.now() })
      cached++
    } catch {
      // Network failure — skip this file, will retry next sync
    }
  }

  // Update filesCachedCount in syncMeta
  const tripId = files[0]?.trip_id
  if (tripId) {
    const meta = await offlineDb.syncMeta.get(tripId)
    if (meta) await upsertSyncMeta({ ...meta, filesCachedCount: cached })
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let _syncing = false
let _interrupted = false

export const tripSyncManager = {
  /**
   * Sync all cache-eligible trips.
   * Evicts stale trips. Caches file blobs in the background.
   * No-ops when offline.
   */
  async syncAll(): Promise<void> {
    if (_syncing || !navigator.onLine) return
    _syncing = true
    _interrupted = false
    try {
      const { trips } = await tripsApi.list() as { trips: Trip[] }

      // Evict stale trips first
      const stale = trips.filter(isStale)
      await Promise.all(stale.map(t => clearTripData(t.id).catch(console.error)))

      // Sync eligible trips — stop early if interrupted (e.g. user navigated to a trip page)
      const toSync = trips.filter(shouldCache)
      for (const trip of toSync) {
        if (_interrupted) break
        try {
          await syncTrip(trip.id)
        } catch (err) {
          if (isQuotaError(err)) {
            console.warn(`[tripSync] quota exceeded for trip ${trip.id}, clearing trip data and retrying`)
            try {
              await clearTripData(trip.id)
              await syncTrip(trip.id)
            } catch (retryErr) {
              if (isQuotaError(retryErr)) {
                // Trip data + blob cache — free largest storage first before nuking everything
                console.warn('[tripSync] quota still exceeded — clearing blob cache and retrying')
                await clearBlobCache()
                try {
                  await syncTrip(trip.id)
                } catch {
                  console.warn('[tripSync] quota still exceeded after blob eviction — clearing all IDB data')
                  await clearAll()
                  return
                }
              } else {
                console.error(`[tripSync] failed for trip ${trip.id} after eviction:`, retryErr)
              }
            }
          } else {
            console.error(`[tripSync] failed for trip ${trip.id}:`, err)
          }
        }
      }

      if (_interrupted) return

      // Cache global user data (tags + categories) — fire-and-forget
      tagsApi.list().then(d => upsertTags(d.tags)).catch(() => {})
      categoriesApi.list().then(d => upsertCategories(d.categories)).catch(() => {})

      // Cache file blobs + map tiles in background (don't block syncAll)
      const tileUrl = useSettingsStore.getState().settings.map_tile_url || undefined
      for (const trip of toSync) {
        if (_interrupted) break
        const files = await offlineDb.tripFiles.where('trip_id').equals(trip.id).toArray()
        cacheFilesForTrip(files).catch(console.error)

        const places = await offlineDb.places.where('trip_id').equals(trip.id).toArray()
        prefetchTilesForTrip(trip.id, places, tileUrl).catch(console.error)
      }
    } finally {
      _syncing = false
    }
  },

  /**
   * Signal syncAll to stop after the current in-flight bundle request.
   * Call when the user navigates to a trip page so loadTrip gets priority.
   */
  interrupt(): void {
    _interrupted = true
  },

  /** Reset syncing flag — useful in tests. */
  _resetSyncing(): void {
    _syncing = false
    _interrupted = false
  },
}
