// FE-SYNC-PREP-001 to FE-SYNC-PREP-021
// prepareForOffline, the idle tile pass and the file-blob caching branches that
// tests/unit/sync/tripSyncManager.test.ts leaves untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { tripSyncManager, type PrepareProgress } from './tripSyncManager'
import { prefetchTilesForTrip } from './tilePrefetcher'
import { setAuthed } from './authGate'
import { setCacheTiles, setTripOfflineEnabled, _resetOfflinePrefs } from './offlinePrefs'
import { offlineDb, clearAll, upsertTrip } from '../db/offlineDb'
import { buildTrip, buildDay, buildPlace, buildTripFile } from '../../tests/helpers/factories'
import type { Trip, TripFile } from '../types'

vi.mock('./tilePrefetcher', () => ({
  prefetchTilesForTrip: vi.fn(async () => {}),
}))

const prefetchMock = vi.mocked(prefetchTilesForTrip)

function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function bundleFor(trip: Trip, files: TripFile[] = []) {
  return {
    trip,
    days: [buildDay({ trip_id: trip.id })],
    places: [buildPlace({ trip_id: trip.id, lat: 48.1, lng: 11.5 })],
    packingItems: [],
    todoItems: [],
    budgetItems: [],
    reservations: [],
    files,
    accommodations: [],
    members: [{ id: 1, username: 'ana', role: 'owner' }],
  }
}

function serveTrips(trips: Trip[], bundles: Record<number, unknown>): void {
  server.use(
    http.get('/api/trips', () => HttpResponse.json({ trips })),
    http.get('/api/trips/:id/bundle', ({ params }) => {
      const bundle = bundles[Number(params.id)]
      return bundle ? HttpResponse.json(bundle) : HttpResponse.json({ error: 'nope' }, { status: 500 })
    }),
  )
}

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, writable: true, configurable: true })
}

beforeEach(async () => {
  await clearAll()
  tripSyncManager._resetSyncing()
  _resetOfflinePrefs()
  setAuthed(true)
  setOnline(true)
  prefetchMock.mockClear()
  prefetchMock.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['pdf-bytes'], { type: 'application/pdf' }),
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  _resetOfflinePrefs()
  setAuthed(false)
})

describe('tripSyncManager.prepareForOffline — guards', () => {
  it('FE-SYNC-PREP-001: reports why it stopped and hits no endpoint when logged out', async () => {
    setAuthed(false)
    let called = false
    server.use(http.get('/api/trips', () => { called = true; return HttpResponse.json({ trips: [] }) }))

    expect(await tripSyncManager.prepareForOffline()).toEqual({ status: 'skipped', reason: 'signed-out' })
    expect(called).toBe(false)
  })

  it('FE-SYNC-PREP-002: reports that it stopped because the browser is offline', async () => {
    setOnline(false)
    expect(await tripSyncManager.prepareForOffline()).toEqual({ status: 'skipped', reason: 'offline' })
  })

  it('FE-SYNC-PREP-003: a second concurrent run is refused by the syncing flag', async () => {
    const trip = buildTrip({ id: 600, end_date: dateOffset(4) })
    serveTrips([trip], { 600: bundleFor(trip) })

    const [first, second] = await Promise.all([
      tripSyncManager.prepareForOffline(),
      tripSyncManager.prepareForOffline(),
    ])
    // The loser says so rather than reporting a successful run of nothing: the
    // settings screen paints that answer instead of a finished progress bar
    // (#2228).
    expect(first).toEqual({ status: 'done', trips: 1 })
    expect(second).toEqual({ status: 'skipped', reason: 'busy' })
  })
})

describe('tripSyncManager.prepareForOffline — full run', () => {
  it('FE-SYNC-PREP-004: reports every phase in order and returns the trip count', async () => {
    const trip = buildTrip({ id: 601, title: 'Munich', end_date: dateOffset(4) })
    const file = buildTripFile({ id: 900, trip_id: 601, url: '/api/trips/601/files/900/download', mime_type: 'application/pdf' })
    serveTrips([trip], { 601: bundleFor(trip, [file]) })

    const progress: PrepareProgress[] = []
    const count = await tripSyncManager.prepareForOffline(p => progress.push(p))

    expect(count).toEqual({ status: 'done', trips: 1 })
    expect(progress.map(p => p.phase)).toEqual(['trips', 'files', 'tiles', 'done'])
    expect(progress[0]).toMatchObject({ current: 1, total: 1, label: 'Munich' })
    expect(progress[3]).toMatchObject({ phase: 'done', current: 1, total: 1 })
  })

  it('FE-SYNC-PREP-005: awaits the bundle, the blobs and the tiles before resolving', async () => {
    const trip = buildTrip({ id: 602, end_date: dateOffset(4) })
    const file = buildTripFile({ id: 901, trip_id: 602, url: '/api/trips/602/files/901/download', mime_type: 'application/pdf' })
    serveTrips([trip], { 602: bundleFor(trip, [file]) })

    await tripSyncManager.prepareForOffline()

    expect(await offlineDb.trips.get(602)).toBeDefined()
    expect(await offlineDb.places.where('trip_id').equals(602).count()).toBe(1)
    expect((await offlineDb.blobCache.get('/api/trips/602/files/901/download'))!.mime).toBe('application/pdf')
    expect(await offlineDb.tripMembers.where('tripId').equals(602).count()).toBe(1)
  })

  it('FE-SYNC-PREP-006: forces the tile prefetch so an already-cached bbox is refreshed', async () => {
    const trip = buildTrip({ id: 603, end_date: dateOffset(4) })
    serveTrips([trip], { 603: bundleFor(trip) })

    await tripSyncManager.prepareForOffline()

    expect(prefetchMock).toHaveBeenCalledTimes(1)
    const [tripId, places, , force] = prefetchMock.mock.calls[0]
    expect(tripId).toBe(603)
    expect(places).toHaveLength(1)
    expect(force).toBe(true)
  })

  it('FE-SYNC-PREP-007: skips the tile phase when the user turned map tiles off', async () => {
    setCacheTiles(false)
    const trip = buildTrip({ id: 604, end_date: dateOffset(4) })
    serveTrips([trip], { 604: bundleFor(trip) })

    const progress: PrepareProgress[] = []
    await tripSyncManager.prepareForOffline(p => progress.push(p))

    expect(progress.map(p => p.phase)).toEqual(['trips', 'files', 'done'])
    expect(prefetchMock).not.toHaveBeenCalled()
  })

  it('FE-SYNC-PREP-008: caches the global tags and categories', async () => {
    const trip = buildTrip({ id: 605, end_date: dateOffset(4) })
    serveTrips([trip], { 605: bundleFor(trip) })

    await tripSyncManager.prepareForOffline()

    expect(await offlineDb.tags.count()).toBeGreaterThan(0)
    expect(await offlineDb.categories.count()).toBeGreaterThan(0)
  })

  it('FE-SYNC-PREP-009: a failing tag/category fetch does not abort the run', async () => {
    const trip = buildTrip({ id: 606, end_date: dateOffset(4) })
    serveTrips([trip], { 606: bundleFor(trip) })
    server.use(
      http.get('/api/tags', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.get('/api/categories', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    )

    expect(await tripSyncManager.prepareForOffline()).toEqual({ status: 'done', trips: 1 })
    expect(await offlineDb.tags.count()).toBe(0)
  })

  it('FE-SYNC-PREP-010: one broken bundle is logged and the other trips still get prepared', async () => {
    const good = buildTrip({ id: 607, end_date: dateOffset(4) })
    const broken = buildTrip({ id: 608, end_date: dateOffset(4) })
    serveTrips([broken, good], { 607: bundleFor(good) })

    expect(await tripSyncManager.prepareForOffline()).toEqual({ status: 'done', trips: 2 })
    expect(await offlineDb.trips.get(607)).toBeDefined()
    expect(await offlineDb.trips.get(608)).toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })

  it('FE-SYNC-PREP-011: evicts a trip the user excluded from offline storage', async () => {
    const kept = buildTrip({ id: 609, end_date: dateOffset(4) })
    const excluded = buildTrip({ id: 610, end_date: dateOffset(4) })
    await upsertTrip(excluded)
    setTripOfflineEnabled(610, false)
    serveTrips([kept, excluded], { 609: bundleFor(kept), 610: bundleFor(excluded) })

    expect(await tripSyncManager.prepareForOffline()).toEqual({ status: 'done', trips: 1 })
    expect(await offlineDb.trips.get(609)).toBeDefined()
    expect(await offlineDb.trips.get(610)).toBeUndefined()
  })
})

describe('tripSyncManager — file blob caching', () => {
  async function prepareWithFiles(tripId: number, files: TripFile[]): Promise<void> {
    const trip = buildTrip({ id: tripId, end_date: dateOffset(4) })
    serveTrips([trip], { [tripId]: bundleFor(trip, files) })
    await tripSyncManager.prepareForOffline()
  }

  it('FE-SYNC-PREP-012: an already-cached blob is counted but not re-downloaded', async () => {
    const url = '/api/trips/611/files/902/download'
    await offlineDb.blobCache.put({ url, tripId: 611, blob: new Blob(['old']), bytes: 3, mime: 'application/pdf', cachedAt: 1 })

    await prepareWithFiles(611, [buildTripFile({ id: 902, trip_id: 611, url, mime_type: 'application/pdf' })])

    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect((await offlineDb.blobCache.get(url))!.cachedAt).toBe(1)
    expect((await offlineDb.syncMeta.get(611))!.filesCachedCount).toBe(1)
  })

  it('FE-SYNC-PREP-013: a non-ok download is skipped and not counted', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as unknown as Response)

    await prepareWithFiles(612, [buildTripFile({ id: 903, trip_id: 612, url: '/api/trips/612/files/903/download', mime_type: 'application/pdf' })])

    expect(await offlineDb.blobCache.count()).toBe(0)
    expect((await offlineDb.syncMeta.get(612))!.filesCachedCount).toBe(0)
  })

  it('FE-SYNC-PREP-014: a throwing download leaves the rest of the sync intact', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

    await prepareWithFiles(613, [buildTripFile({ id: 904, trip_id: 613, url: '/api/trips/613/files/904/download', mime_type: 'application/pdf' })])

    expect(await offlineDb.blobCache.count()).toBe(0)
    expect(await offlineDb.trips.get(613)).toBeDefined()
  })

  it('FE-SYNC-PREP-015: photos and videos are never pulled into the bounded blob cache', async () => {
    await prepareWithFiles(614, [
      buildTripFile({ id: 905, trip_id: 614, url: '/api/trips/614/files/905/download', mime_type: 'image/jpeg' }),
      buildTripFile({ id: 906, trip_id: 614, url: '/api/trips/614/files/906/download', mime_type: 'video/mp4' }),
      buildTripFile({ id: 907, trip_id: 614, url: '/api/trips/614/files/907/download', mime_type: 'application/pdf' }),
    ])

    const cached = await offlineDb.blobCache.toArray()
    expect(cached.map(e => e.url)).toEqual(['/api/trips/614/files/907/download'])
    expect((await offlineDb.syncMeta.get(614))!.filesCachedCount).toBe(1)
  })

  it('FE-SYNC-PREP-021: a trip that lost all its files has its cached-file count reset', async () => {
    const url = '/api/trips/617/files/908/download'
    await prepareWithFiles(617, [buildTripFile({ id: 908, trip_id: 617, url, mime_type: 'application/pdf' })])
    expect((await offlineDb.syncMeta.get(617))!.filesCachedCount).toBe(1)

    // The count is derived from the trip being synced, not from the first file
    // row, so an empty list still updates the meta.
    tripSyncManager._resetSyncing()
    await offlineDb.tripFiles.clear()
    await prepareWithFiles(617, [])

    expect((await offlineDb.syncMeta.get(617))!.filesCachedCount).toBe(0)
  })

  it('FE-SYNC-PREP-016: a file row without a url is ignored', async () => {
    await prepareWithFiles(615, [
      buildTripFile({ id: 908, trip_id: 615, url: undefined, mime_type: 'application/pdf' }),
    ])

    expect(await offlineDb.blobCache.count()).toBe(0)
  })
})

describe('tripSyncManager.syncAll — per-trip failures', () => {
  it('FE-SYNC-PREP-020: a failing bundle is logged and the remaining trips still sync', async () => {
    setCacheTiles(false)
    const good = buildTrip({ id: 619, end_date: dateOffset(4) })
    const broken = buildTrip({ id: 620, end_date: dateOffset(4) })
    serveTrips([broken, good], { 619: bundleFor(good) })

    await tripSyncManager.syncAll()

    expect(await offlineDb.trips.get(619)).toBeDefined()
    expect(await offlineDb.trips.get(620)).toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('tripSyncManager.syncAll — background tile pass', () => {
  // jsdom has no requestIdleCallback, so whenIdle falls back to a 2s timeout.
  // Stub it with an immediate macrotask to exercise the idle branch.
  function stubIdle(): ReturnType<typeof vi.fn> {
    const idle = vi.fn((cb: IdleRequestCallback) => {
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0)
      return 1
    })
    vi.stubGlobal('requestIdleCallback', idle)
    return idle
  }

  it('FE-SYNC-PREP-017: prefetches tiles once the browser goes idle', async () => {
    const idle = stubIdle()
    const trip = buildTrip({ id: 616, end_date: dateOffset(4) })
    serveTrips([trip], { 616: bundleFor(trip) })

    await tripSyncManager.syncAll()
    await new Promise(r => setTimeout(r, 50))

    expect(idle).toHaveBeenCalled()
    expect(prefetchMock).toHaveBeenCalledTimes(1)
    expect(prefetchMock.mock.calls[0][0]).toBe(616)
    // syncAll must not force — a routine login should skip an unchanged bbox.
    expect(prefetchMock.mock.calls[0][3]).toBeUndefined()
  })

  it('FE-SYNC-PREP-018: a logout between sync and idle time cancels the tile pass', async () => {
    stubIdle()
    const trip = buildTrip({ id: 617, end_date: dateOffset(4) })
    serveTrips([trip], { 617: bundleFor(trip) })

    await tripSyncManager.syncAll()
    setAuthed(false)
    await new Promise(r => setTimeout(r, 50))

    expect(prefetchMock).not.toHaveBeenCalled()
  })

  it('FE-SYNC-PREP-019: going offline between sync and idle time cancels the tile pass', async () => {
    stubIdle()
    const trip = buildTrip({ id: 618, end_date: dateOffset(4) })
    serveTrips([trip], { 618: bundleFor(trip) })

    await tripSyncManager.syncAll()
    setOnline(false)
    await new Promise(r => setTimeout(r, 50))

    expect(prefetchMock).not.toHaveBeenCalled()
  })
})
