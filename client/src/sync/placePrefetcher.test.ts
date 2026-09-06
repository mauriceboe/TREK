/**
 * FE-PLACEPRE-001..012 — the places around a trip, kept for offline search.
 *
 * The gap this closes: an offline instance had the trip's own places and
 * nothing else, so "find a pharmacy near the hotel" had nothing to answer from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { offlineDb, clearAll } from '../db/offlineDb'
import {
  AREA_PLACE_LIMIT,
  cachedToPlaceRecord,
  clearCachedPlaces,
  foldName,
  prefetchPlacesForTrip,
  searchCachedPlaces,
} from './placePrefetcher'
import { mapsApi } from '../api/client'
import type { Place } from '../types'

vi.mock('../api/client', () => ({ mapsApi: { area: vi.fn() } }))
const areaMock = vi.mocked(mapsApi.area)

const place = (lat: number, lng: number): Place =>
  ({ id: 1, trip_id: 7, name: 'Hotel', lat, lng }) as unknown as Place

const TRIP_PLACES = [place(54.08, 12.13), place(54.1, 12.16)]

function apiRow(name: string, over: Record<string, unknown> = {}) {
  return {
    osm_id: `gers:${name.toLowerCase().replace(/\W/g, '')}`,
    name,
    address: 'Steinstrasse 9, 18055, Rostock',
    lat: 54.09,
    lng: 12.14,
    category: 'restaurant',
    website: null,
    phone: null,
    ...over,
  }
}

beforeEach(async () => {
  await clearAll()
  areaMock.mockReset()
  areaMock.mockResolvedValue({ results: [apiRow("L'Osteria"), apiRow('Café Central')], truncated: false })
  await offlineDb.syncMeta.put({
    tripId: 7,
    lastSyncedAt: null,
    status: 'idle',
    tilesBbox: null,
    filesCachedCount: 0,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('foldName', () => {
  it('FE-PLACEPRE-001: folds diacritics and case, so "cafe" finds "Café"', () => {
    expect(foldName('Café Central')).toBe('cafe central')
    expect(foldName('  Zürich  ')).toBe('zurich')
  })
})

describe('prefetchPlacesForTrip', () => {
  it('FE-PLACEPRE-002: stores the area under the trip', async () => {
    const n = await prefetchPlacesForTrip(7, TRIP_PLACES)
    expect(n).toBe(2)
    const rows = await offlineDb.areaPlaces.toArray()
    expect(rows.map((r) => r.name).sort()).toEqual(['Café Central', "L'Osteria"])
    expect(rows.every((r) => r.tripId === 7)).toBe(true)
    expect(rows[0].gers.startsWith('gers:')).toBe(false)
  })

  it('FE-PLACEPRE-003: asks for a box around the trip, within the index cap', async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
    const [bbox, limit] = areaMock.mock.calls[0]
    expect(bbox.minLat).toBeLessThan(54.08)
    expect(bbox.maxLat).toBeGreaterThan(54.1)
    expect(bbox.maxLat - bbox.minLat).toBeLessThanOrEqual(1.5)
    expect(limit).toBe(AREA_PLACE_LIMIT)
  })

  it('FE-PLACEPRE-004: does not re-download an area that has not moved', async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
    const again = await prefetchPlacesForTrip(7, TRIP_PLACES)
    expect(again).toBe(0)
    expect(areaMock).toHaveBeenCalledTimes(1)
  })

  it('FE-PLACEPRE-005: re-downloads when the trip moves', async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
    await prefetchPlacesForTrip(7, [place(41.9, 12.5), place(41.92, 12.52)])
    expect(areaMock).toHaveBeenCalledTimes(2)
  })

  it('FE-PLACEPRE-006: replaces the old area rather than merging into it', async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
    areaMock.mockResolvedValue({ results: [apiRow('Trattoria Roma')], truncated: false })
    await prefetchPlacesForTrip(7, [place(41.9, 12.5), place(41.92, 12.52)])
    // Keeping the old rows would make an offline search answer with the last city.
    expect((await offlineDb.areaPlaces.toArray()).map((r) => r.name)).toEqual(['Trattoria Roma'])
  })

  it('FE-PLACEPRE-007: a trip with no located places costs nothing', async () => {
    expect(await prefetchPlacesForTrip(7, [])).toBe(0)
    expect(areaMock).not.toHaveBeenCalled()
  })

  it('FE-PLACEPRE-008: clamps a trip that spans more than the index allows', async () => {
    await prefetchPlacesForTrip(7, [place(35, 5), place(60, 25)])
    const [bbox] = areaMock.mock.calls[0]
    expect(bbox.maxLat - bbox.minLat).toBeLessThanOrEqual(1.5)
    expect(bbox.maxLng - bbox.minLng).toBeLessThanOrEqual(1.5)
  })

  it('FE-PLACEPRE-009: a failure never propagates into the sync', async () => {
    areaMock.mockRejectedValue(new Error('service down'))
    await expect(prefetchPlacesForTrip(7, TRIP_PLACES)).resolves.toBe(0)
  })

  it('FE-PLACEPRE-010: stores nothing when the index is switched off', async () => {
    areaMock.mockResolvedValue({ results: [], truncated: false, unavailable: true })
    expect(await prefetchPlacesForTrip(7, TRIP_PLACES)).toBe(0)
    expect(await offlineDb.areaPlaces.count()).toBe(0)
  })

  it('FE-PLACEPRE-011: skips a row with no id or no name rather than storing a blank', async () => {
    areaMock.mockResolvedValue({
      results: [apiRow('Real Place'), { ...apiRow('x'), name: '   ' }, { ...apiRow('y'), osm_id: null }],
      truncated: false,
    })
    expect(await prefetchPlacesForTrip(7, TRIP_PLACES)).toBe(1)
  })
})

describe('searchCachedPlaces', () => {
  beforeEach(async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
  })

  it('FE-PLACEPRE-012: matches on a prefix and on a word inside the name', async () => {
    expect((await searchCachedPlaces('cafe')).map((p) => p.name)).toEqual(['Café Central'])
    // No prefix index answers this one — "L'Osteria" folds to "l'osteria".
    expect((await searchCachedPlaces('osteria')).map((p) => p.name)).toEqual(["L'Osteria"])
  })

  it('FE-PLACEPRE-013: ignores a query too short to mean anything', async () => {
    expect(await searchCachedPlaces('c')).toEqual([])
  })

  it('FE-PLACEPRE-014: reads across trips, because the area is where you are', async () => {
    // tripId is how a set is evicted, not who may read it. Somebody offline in
    // Rostock searching from the journal wants the same places.
    expect((await searchCachedPlaces('osteria')).length).toBe(1)
    await offlineDb.areaPlaces.toCollection().modify({ tripId: 99 })
    expect((await searchCachedPlaces('osteria')).length).toBe(1)
  })

  it('FE-PLACEPRE-015: hands back the shape every search caller already reads', async () => {
    const [hit] = await searchCachedPlaces('osteria')
    expect(cachedToPlaceRecord(hit)).toMatchObject({
      osm_id: "gers:l'osteria".replace("'", ''),
      name: "L'Osteria",
      // Named rather than passed off as live: several screens show this.
      source: 'offline-cache',
      rating: null,
    })
  })
})

describe('clearCachedPlaces', () => {
  it('FE-PLACEPRE-016: drops one trip and leaves the others', async () => {
    await prefetchPlacesForTrip(7, TRIP_PLACES)
    await offlineDb.areaPlaces.toCollection().modify({ tripId: 8 })
    await prefetchPlacesForTrip(7, TRIP_PLACES, true)
    await clearCachedPlaces(7)
    expect((await offlineDb.areaPlaces.toArray()).every((r) => r.tripId === 8)).toBe(true)
  })
})
