/**
 * Shared state for the offline settings screen (#1135), used by both the desktop
 * `OfflineTab` and its phone twin `MSettingsOffline`. The two shells render very
 * different markup over identical logic, so the logic lives here once, the same
 * arrangement as `useInstanceSettings` / `useRangeBypass`.
 *
 * It also carries the honesty fixes from #2228: a sync that never started is
 * reported as such instead of silently painting a finished progress bar, a
 * failed read of the offline database surfaces instead of rendering as "nothing
 * cached", and a trip the user switches on is pinned so the date rule cannot
 * quietly refuse to store it.
 */
import { useCallback, useEffect, useState } from 'react'
import { offlineDb, clearAll, clearTripData } from '../../db/offlineDb'
import { tripsApi } from '../../api/client'
import { tripSyncManager, isDateEligible, type PrepareProgress, type SyncOutcome } from '../../sync/tripSyncManager'
import { mutationQueue } from '../../sync/mutationQueue'
import { clearTileCache } from '../../sync/tilePrefetcher'
import { isEffectivelyOffline } from '../../sync/networkMode'
import {
  getOfflinePrefs, setCacheTiles, setConflictStrategy,
  setTripOfflineEnabled, setTripPinned, onOfflinePrefsChange,
  type ConflictStrategy,
} from '../../sync/offlinePrefs'
import { useNetworkMode } from '../../hooks/useNetworkMode'
import type { SyncMeta, QueuedMutation } from '../../db/offlineDb'
import type { Trip } from '../../types'

export interface CachedTripRow {
  trip: Trip
  meta: SyncMeta
  placeCount: number
  fileCount: number
}

/** How a trip's storage switch should read, and why. */
export interface TripStorageState {
  /** The switch position: is this trip kept on the device? */
  on: boolean
  /** The user asked for it explicitly, overriding the date rule. */
  pinned: boolean
  /** The date rule would keep it on its own (ongoing, future, or open-ended). */
  dateEligible: boolean
}

/**
 * The last thing a download / re-sync run did. `null` while nothing has been
 * run yet. The screen shows no banner in that state.
 */
export type OfflineNotice =
  | { kind: 'stored'; trips: number }
  | { kind: 'skipped'; reason: 'busy' | 'offline' | 'signed-out' }
  | { kind: 'sync-failed' }
  | { kind: 'load-failed' }

/**
 * The message a notice reads as. Shared so both shells say the same thing and
 * only the chrome around it differs.
 */
export function offlineNoticeKey(notice: OfflineNotice): string {
  if (notice.kind === 'load-failed') return 'settings.offline.notice.loadFailed'
  if (notice.kind === 'sync-failed') return 'settings.offline.notice.failed'
  if (notice.kind === 'skipped') {
    if (notice.reason === 'busy') return 'settings.offline.notice.busy'
    if (notice.reason === 'offline') return 'settings.offline.notice.offline'
    return 'settings.offline.notice.signedOut'
  }
  return notice.trips > 0 ? 'settings.offline.notice.stored' : 'settings.offline.notice.nothing'
}

/** A notice that reports a problem rather than a result. */
export function isOfflineNoticeWarning(notice: OfflineNotice): boolean {
  return notice.kind !== 'stored' || notice.trips === 0
}

function noticeFor(outcome: SyncOutcome): OfflineNotice {
  return outcome.status === 'done'
    ? { kind: 'stored', trips: outcome.trips }
    : { kind: 'skipped', reason: outcome.reason }
}

export function useOfflineSettings() {
  const { offline, forced, setForced } = useNetworkMode()
  const [rows, setRows] = useState<CachedTripRow[]>([])
  const [allTrips, setAllTrips] = useState<Trip[]>([])
  const [storedTripCount, setStoredTripCount] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [conflicts, setConflicts] = useState<QueuedMutation[]>([])
  const [syncing, setSyncing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [progress, setProgress] = useState<PrepareProgress | null>(null)
  const [notice, setNotice] = useState<OfflineNotice | null>(null)
  const [prefs, setPrefs] = useState(getOfflinePrefs())

  useEffect(() => onOfflinePrefsChange(() => setPrefs(getOfflinePrefs())), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [metas, storedTrips, pending, failed, conflictList] = await Promise.all([
        offlineDb.syncMeta.toArray(),
        offlineDb.trips.count(),
        mutationQueue.pendingCount(),
        mutationQueue.failedCount(),
        mutationQueue.conflicts(),
      ])
      setStoredTripCount(storedTrips)
      setPendingCount(pending)
      setFailedCount(failed)
      setConflicts(conflictList)

      const result: CachedTripRow[] = []
      for (const meta of metas) {
        const trip = await offlineDb.trips.get(meta.tripId)
        if (!trip) continue
        const [placeCount, fileCount] = await Promise.all([
          offlineDb.places.where('trip_id').equals(meta.tripId).count(),
          offlineDb.tripFiles.where('trip_id').equals(meta.tripId).count(),
        ])
        result.push({ trip, meta, placeCount, fileCount })
      }
      result.sort((a, b) => (a.trip.start_date ?? '').localeCompare(b.trip.start_date ?? ''))
      setRows(result)

      // The per-trip storage toggles are driven by the FULL trip list, not just
      // the cached ones, so a trip turned off stays visible and re-enableable.
      try {
        const trips = isEffectivelyOffline()
          ? await offlineDb.trips.toArray()
          : await tripsApi.list().then(r => (r as { trips: Trip[] }).trips).catch(() => offlineDb.trips.toArray())
        trips.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
        setAllTrips(trips)
      } catch {
        setAllTrips([])
      }
    } catch (err) {
      // A Dexie read that rejects (a closed handle, a failed upgrade) used to
      // leave every list at its initial empty value, so a broken offline
      // database was indistinguishable from an empty one: the screen read
      // "No trips cached yet" and gave the user nothing to act on (#2228).
      console.error('[offline] could not read the offline database:', err)
      setNotice({ kind: 'load-failed' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runPrepare = useCallback(async () => {
    setPreparing(true)
    setProgress(null)
    setNotice(null)
    try {
      const outcome = await tripSyncManager.prepareForOffline(p => setProgress(p))
      setNotice(noticeFor(outcome))
      // A run that never started never reported progress either; clearing it
      // keeps the bar from painting "finished" over a download that did not
      // happen.
      if (outcome.status !== 'done') setProgress(null)
    } catch (err) {
      // The trip list this starts from is a plain fetch, so a network blip
      // rejects the whole run. Reporting that beats leaving the last progress
      // frame on screen as if the download had completed.
      console.error('[offline] the download could not finish:', err)
      setProgress(null)
      setNotice({ kind: 'sync-failed' })
    } finally {
      setPreparing(false)
    }
    await load()
  }, [load])

  const handleToggleForce = useCallback(async () => {
    if (!forced) {
      // Turning offline mode on: download everything first (while still online),
      // then engage so the app has all it needs before the network drops.
      if (!isEffectivelyOffline()) await runPrepare()
      setForced(true)
    } else {
      // Back online: lifting the switch flushes the queue + re-syncs (syncTriggers).
      setForced(false)
    }
  }, [forced, runPrepare, setForced])

  const handleResync = useCallback(async () => {
    setSyncing(true)
    setNotice(null)
    try {
      setNotice(noticeFor(await tripSyncManager.syncAll()))
    } catch (err) {
      console.error('[offline] the sync could not finish:', err)
      setNotice({ kind: 'sync-failed' })
    } finally {
      setSyncing(false)
    }
    await load()
  }, [load])

  /** Wipes the offline database. Each shell asks for confirmation its own way. */
  const handleClear = useCallback(async () => {
    setClearing(true)
    try {
      await clearAll()
      setNotice(null)
      await load()
    } finally {
      setClearing(false)
    }
  }, [load])

  const handleToggleTiles = useCallback(async () => {
    const next = !prefs.cacheTiles
    setCacheTiles(next)
    // Turning tiles off reclaims the bulk tile storage straight away.
    if (!next) await clearTileCache()
  }, [prefs.cacheTiles])

  /**
   * How a trip's switch should read. A finished trip is only stored when the
   * user pinned it, so reporting the raw opt-out flag would show "on" over a
   * trip the sync deliberately skips, which is what made the whole feature
   * look broken for anyone whose trips are all in the past (#2228).
   */
  const tripStorageState = useCallback((trip: Trip): TripStorageState => {
    const dateEligible = isDateEligible(trip)
    const pinned = prefs.pinnedTripIds.includes(trip.id)
    const allowed = !prefs.disabledTripIds.includes(trip.id)
    return { on: allowed && (pinned || dateEligible), pinned, dateEligible }
  }, [prefs.pinnedTripIds, prefs.disabledTripIds])

  const handleToggleTrip = useCallback(async (trip: Trip) => {
    const next = !tripStorageState(trip).on
    setTripOfflineEnabled(trip.id, next)
    // Switching a finished trip on has to pin it, or the date rule would skip
    // it on the next sync and evict it a week after it ended.
    setTripPinned(trip.id, next && !isDateEligible(trip))
    if (!next) {
      await clearTripData(trip.id)
      await load()
      return
    }
    if (isEffectivelyOffline()) {
      setNotice({ kind: 'skipped', reason: 'offline' })
      return
    }
    try {
      setNotice(noticeFor(await tripSyncManager.syncAll()))
    } catch (err) {
      console.error('[offline] the sync could not finish:', err)
      setNotice({ kind: 'sync-failed' })
    }
    await load()
  }, [load, tripStorageState])

  const resolveConflict = useCallback(async (id: string, keepMine: boolean) => {
    if (keepMine) await mutationQueue.resolveKeepMine(id)
    else await mutationQueue.resolveKeepServer(id)
    await load()
  }, [load])

  const handleConflictStrategy = useCallback((strategy: ConflictStrategy) => {
    setConflictStrategy(strategy)
  }, [])

  return {
    offline, forced,
    rows, allTrips, pendingCount, failedCount, conflicts,
    syncing, clearing, loading, preparing, progress, notice, prefs, storedTripCount,
    // Clearable once the database actually holds something, not only once a
    // sync wrote its bookkeeping row: a download that died between writing the
    // trip and writing its syncMeta left `rows` empty over a non-empty Dexie,
    // and the clear button was disabled on exactly the state that needed it.
    canClear: storedTripCount > 0 || pendingCount > 0,
    load, runPrepare, handleToggleForce, handleResync, handleClear,
    handleToggleTiles, tripStorageState, handleToggleTrip, resolveConflict,
    handleConflictStrategy,
  }
}
