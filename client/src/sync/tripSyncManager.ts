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
  enforceBlobBudget,
} from '../db/offlineDb'
import { prefetchPlacesForTrip } from './placePrefetcher'
import { prefetchTilesForTrip } from './tilePrefetcher'
import { isAuthed } from './authGate'
import { getOfflinePrefs, isTripOfflineEnabled, isTripPinned } from './offlinePrefs'
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

// Trip dates are plain local calendar dates, so format ours the same way.
// toISOString() would hand back the UTC day and drop an ongoing trip a day
// early west of UTC (and keep a finished one a day too long east of it).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayStr(): string {
  return ymd(new Date())
}

/**
 * Run work once the browser has nothing better to do, with a ceiling so it
 * still happens on browsers without requestIdleCallback (Safari) or in a tab
 * that never goes idle.
 */
function whenIdle(fn: () => void | Promise<void>): void {
  const run = () => { void Promise.resolve(fn()).catch(console.error) }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 2_000)
}

/**
 * Would the date rule keep this trip on its own? Exported so the offline
 * settings screen can show the honest state of a trip's switch: a finished trip
 * is not stored unless the user pins it, and a switch that reads "on" while
 * nothing is stored is what made "Download for offline use" look broken (#2228).
 */
export function isDateEligible(trip: Trip): boolean {
  if (!trip.end_date) return true            // no end date → cache forever
  return trip.end_date >= todayStr()          // ongoing or future
}

function shouldCache(trip: Trip): boolean {
  return isTripPinned(trip.id) || isDateEligible(trip)
}

function isStale(trip: Trip): boolean {
  if (!trip.end_date) return false
  if (isTripPinned(trip.id)) return false     // the user asked for it, keep it
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  return trip.end_date < ymd(cutoff)
}

function isPhoto(file: TripFile): boolean {
  return file.mime_type.startsWith('image/')
}

// Videos can be hundreds of MB — never prefetch them into the bounded offline
// blob cache, or a single clip would evict the trip's real documents (#823).
function isVideo(file: TripFile): boolean {
  return file.mime_type.startsWith('video/')
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
async function cacheFilesForTrip(tripId: number, files: TripFile[]): Promise<void> {
  const nonPhotos = files.filter(f => f.url && !isPhoto(f) && !isVideo(f))
  // `present` is what syncMeta.filesCachedCount reports (files available
  // offline afterwards); `downloaded` only counts what this run actually wrote.
  let present = 0
  let downloaded = 0

  for (const file of nonPhotos) {
    // A logout mid-loop repoints offlineDb at the anonymous database, so anything
    // written after it would leave the previous account's documents on the device.
    if (!isAuthed()) return
    // Skip if already cached
    const existing = await offlineDb.blobCache.get(file.url!)
    if (existing) { present++; continue }

    try {
      const resp = await fetch(file.url!, { credentials: 'include' })
      if (!resp.ok) continue
      const blob = await resp.blob()
      await offlineDb.blobCache.put({ url: file.url!, tripId: file.trip_id, blob, bytes: blob.size, mime: file.mime_type, cachedAt: Date.now() })
      present++
      downloaded++
    } catch {
      // Network failure — skip this file, will retry next sync
    }
  }

  // Keep the blob cache within its size/count budget after adding new files.
  if (downloaded > 0) await enforceBlobBudget().catch(() => {})

  const meta = await offlineDb.syncMeta.get(tripId)
  if (meta) await upsertSyncMeta({ ...meta, filesCachedCount: present })
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Progress callback payload for a {@link tripSyncManager.prepareForOffline} run. */
export interface PrepareProgress {
  /** Current stage. 'done' fires once at the end. */
  phase: 'trips' | 'files' | 'tiles' | 'done'
  /** 1-based index of the trip currently processed in this phase. */
  current: number
  /** Total trips to process in this phase. */
  total: number
  /** Name of the trip currently processed (for the UI). */
  label?: string
}

let _syncing = false

/**
 * Decide which trips to cache and which to drop, honouring both the date rule
 * and the user's per-trip offline choices (#1135 ask 2). Returns the trips to
 * sync; clears Dexie for stale or user-disabled trips as a side effect.
 */
async function reconcileTrips(trips: Trip[]): Promise<Trip[]> {
  const stale = trips.filter(isStale)
  // Trips the user turned off explicitly are evicted regardless of date.
  const disabled = trips.filter(t => !isTripOfflineEnabled(t.id))
  await Promise.all([...stale, ...disabled].map(t => clearTripData(t.id).catch(console.error)))
  return trips.filter(t => shouldCache(t) && isTripOfflineEnabled(t.id))
}

/**
 * Why a sync did nothing. The settings screen shows these: a run that never
 * started used to be indistinguishable from a run that stored everything, so
 * "Download for offline use" reported success while the cache stayed at zero
 * and the user had no way to tell (#2228).
 */
export type SyncOutcome =
  | { status: 'done'; trips: number }
  | { status: 'skipped'; reason: 'busy' | 'offline' | 'signed-out' }

function skipReason(): SyncOutcome | null {
  if (_syncing) return { status: 'skipped', reason: 'busy' }
  if (!navigator.onLine) return { status: 'skipped', reason: 'offline' }
  if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
  return null
}

export const tripSyncManager = {
  /**
   * Sync all cache-eligible trips.
   * Evicts stale and user-disabled trips. Caches file blobs + map tiles in the
   * background. No-ops when offline.
   */
  async syncAll(): Promise<SyncOutcome> {
    const skipped = skipReason()
    if (skipped) return skipped
    _syncing = true
    try {
      const { trips } = await tripsApi.list() as { trips: Trip[] }
      const toSync = await reconcileTrips(trips)

      for (const trip of toSync) {
        // The gate is re-read per trip: a logout halfway through must not keep
        // writing the old account's rows into the (now anonymous) offline DB.
        if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
        try {
          await syncTrip(trip.id)
        } catch (err) {
          console.error(`[tripSync] failed for trip ${trip.id}:`, err)
        }
      }

      // Cache global user data (tags + categories) — fire-and-forget, so the
      // gate has to be re-read when the response lands, not when it was issued:
      // a logout in between would put these rows in the anonymous database.
      tagsApi.list().then(d => { if (isAuthed()) upsertTags(d.tags) }).catch(() => {})
      categoriesApi.list().then(d => { if (isAuthed()) upsertCategories(d.categories) }).catch(() => {})

      // Cache file blobs + map tiles in background (don't block syncAll)
      const cacheTiles = getOfflinePrefs().cacheTiles
      const tileUrl = useSettingsStore.getState().settings.map_tile_url || undefined
      const cartoKey = useSettingsStore.getState().settings.carto_api_key || undefined
      for (const trip of toSync) {
        if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
        const files = await offlineDb.tripFiles.where('trip_id').equals(trip.id).toArray()
        cacheFilesForTrip(trip.id, files).catch(console.error)
      }

      // Map tiles last, and only once the browser goes idle. syncAll runs right
      // after login, where the app is still mounting the first screen — starting
      // a bulk tile download into that leaves the UI waiting behind our own
      // background traffic.
      if (cacheTiles) {
        whenIdle(async () => {
          for (const trip of toSync) {
            if (!isAuthed() || !navigator.onLine) return
            const places = await offlineDb.places.where('trip_id').equals(trip.id).toArray()
            await prefetchTilesForTrip(trip.id, places, tileUrl, undefined, cartoKey).catch(console.error)
            // The places around the trip, so search answers with no network.
            // Sequential rather than parallel: the tiles are the bigger win and
            // should not be competing with this for the connection.
            await prefetchPlacesForTrip(trip.id, places).catch(console.error)
          }
        })
      }
      return { status: 'done', trips: toSync.length }
    } finally {
      _syncing = false
    }
  },

  /**
   * "Prepare for offline" (#1135 ask 1): a fully-awaited sync the user runs while
   * still online so everything they need is guaranteed on-device before they go
   * offline. Unlike syncAll it awaits the file-blob and map-tile downloads up
   * front instead of deferring them to idle time, reports progress, and forces
   * the tile prefetch to run even for a bbox we believe is already cached.
   *
   * Returns how many trips were prepared, or why the run never started.
   */
  async prepareForOffline(onProgress?: (p: PrepareProgress) => void): Promise<SyncOutcome> {
    const skipped = skipReason()
    if (skipped) return skipped
    _syncing = true
    try {
      const { trips } = await tripsApi.list() as { trips: Trip[] }
      const toSync = await reconcileTrips(trips)
      const total = toSync.length

      // 1) Trip bundles (structured data).
      let i = 0
      for (const trip of toSync) {
        if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
        onProgress?.({ phase: 'trips', current: ++i, total, label: trip.title })
        try {
          await syncTrip(trip.id)
        } catch (err) {
          console.error(`[tripSync] prepare failed for trip ${trip.id}:`, err)
        }
      }

      // Global user data (tags + categories) — awaited here.
      await Promise.all([
        tagsApi.list().then(d => upsertTags(d.tags)).catch(() => {}),
        categoriesApi.list().then(d => upsertCategories(d.categories)).catch(() => {}),
      ])

      // 2) File blobs — awaited so "prepared" really means downloaded.
      i = 0
      for (const trip of toSync) {
        if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
        onProgress?.({ phase: 'files', current: ++i, total, label: trip.title })
        const files = await offlineDb.tripFiles.where('trip_id').equals(trip.id).toArray()
        await cacheFilesForTrip(trip.id, files).catch(console.error)
      }

      // 3) Map tiles — awaited, and only when the user opted to store them.
      if (getOfflinePrefs().cacheTiles) {
        const tileUrl = useSettingsStore.getState().settings.map_tile_url || undefined
        const cartoKey = useSettingsStore.getState().settings.carto_api_key || undefined
        i = 0
        for (const trip of toSync) {
          if (!isAuthed()) return { status: 'skipped', reason: 'signed-out' }
          onProgress?.({ phase: 'tiles', current: ++i, total, label: trip.title })
          const places = await offlineDb.places.where('trip_id').equals(trip.id).toArray()
          await prefetchTilesForTrip(trip.id, places, tileUrl, true, cartoKey).catch(console.error)
          await prefetchPlacesForTrip(trip.id, places, true).catch(console.error)
        }
      }

      onProgress?.({ phase: 'done', current: total, total })
      return { status: 'done', trips: total }
    } finally {
      _syncing = false
    }
  },

  /** Reset syncing flag — useful in tests. */
  _resetSyncing(): void {
    _syncing = false
  },
}
