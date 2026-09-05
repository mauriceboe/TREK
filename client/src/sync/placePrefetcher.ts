/**
 * Takes the places around a trip and keeps them, so search works with no network.
 *
 * The gap this closes: an offline instance has the trip's own places and
 * nothing else. "Find a pharmacy near the hotel" had nothing to answer from,
 * because every place lookup went to a server. The TREK Places index can hand
 * over an area in one request, so it does, once, next to the map tiles.
 *
 * Deliberately modest. This is not a country download and not a background
 * sweep: one box around the trip, a few thousand rows, refreshed only when the
 * trip's area actually changes. A trip to Rostock costs roughly a megabyte.
 */
import { mapsApi } from '../api/client'
import { offlineDb, type CachedAreaPlace } from '../db/offlineDb'
import type { Place } from '../types'
import { computeBbox } from './tilePrefetcher'

/**
 * Enough to answer "what is around here" for a city, small enough that the
 * write is a blink. The index orders by confidence, so a trimmed area keeps the
 * places most likely to be real rather than an arbitrary slice.
 */
export const AREA_PLACE_LIMIT = 3000

/** Padding around the trip's own places. Wider than the tile bbox: somebody
 *  searching from their hotel is looking at the next street, not the next pin. */
const AREA_PADDING = 0.25

/** The index's own cap. A trip spanning more than this gets its centre, not a refusal. */
const MAX_SPAN_DEG = 1.5

/**
 * Fold a name down to what an offline query can match.
 *
 * NFD then strip the combining marks: "Café" and "Cafe" are the same word to
 * somebody typing on a phone keyboard, and an offline search that disagrees is
 * just broken. Same normalisation on both sides, applied at write time so the
 * query does not pay for it per row.
 */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** Shrink an oversized box towards its centre rather than giving up on it. */
function clampSpan(bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2
  const midLng = (bbox.minLng + bbox.maxLng) / 2
  const half = MAX_SPAN_DEG / 2
  return {
    minLat: Math.max(bbox.minLat, midLat - half),
    maxLat: Math.min(bbox.maxLat, midLat + half),
    minLng: Math.max(bbox.minLng, midLng - half),
    maxLng: Math.min(bbox.maxLng, midLng + half),
  }
}

function bboxKey(b: { minLat: number; minLng: number; maxLat: number; maxLng: number }): string {
  // Three decimals is about 100 m — finer than that and adding one place to a
  // trip would re-download the area for no new coverage.
  return [b.minLat, b.minLng, b.maxLat, b.maxLng].map((n) => n.toFixed(3)).join(',')
}

interface AreaRecord {
  osm_id?: string | null
  name?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  category?: string | null
  website?: string | null
  phone?: string | null
}

function toCached(tripId: number, r: AreaRecord, now: number): CachedAreaPlace | null {
  const id = typeof r.osm_id === 'string' ? r.osm_id.replace(/^gers:/, '') : ''
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!id || !name) return null
  return {
    gers: id,
    tripId,
    name,
    searchName: foldName(name),
    address: typeof r.address === 'string' ? r.address : '',
    lat: typeof r.lat === 'number' ? r.lat : null,
    lng: typeof r.lng === 'number' ? r.lng : null,
    category: r.category ?? null,
    website: r.website ?? null,
    phone: r.phone ?? null,
    cachedAt: now,
  }
}

/**
 * Cache the area around a trip. Safe to call on every sync.
 *
 * Returns the number of places stored, or 0 when there was nothing to do — the
 * trip has no located places, the area is unchanged since last time, or the
 * index is switched off. Never throws: this runs inside a sync, and a place
 * cache that could not be filled must not cost the user their trip data.
 */
export async function prefetchPlacesForTrip(
  tripId: number,
  places: Place[],
  force = false,
): Promise<number> {
  const raw = computeBbox(places, AREA_PADDING)
  if (!raw) return 0
  const bbox = clampSpan(raw)

  const key = bboxKey(bbox)
  const meta = await offlineDb.syncMeta.get(tripId)
  const stored = meta?.areaPlacesKey
  if (!force && stored === key) return 0

  try {
    const area = await mapsApi.area(bbox, AREA_PLACE_LIMIT)
    if (area.unavailable) return 0

    const now = Date.now()
    const rows = (area.results || [])
      .map((r) => toCached(tripId, r as AreaRecord, now))
      .filter((r): r is CachedAreaPlace => r !== null)

    // Replace rather than merge: the area moved, and rows from the old one are
    // places the trip is no longer near. Keeping them would make an offline
    // search answer with the last city.
    await offlineDb.transaction('rw', offlineDb.areaPlaces, async () => {
      await offlineDb.areaPlaces.where('tripId').equals(tripId).delete()
      if (rows.length) await offlineDb.areaPlaces.bulkPut(rows)
    })

    if (meta) await offlineDb.syncMeta.put({ ...meta, areaPlacesKey: key })
    if (rows.length) {
      console.info(
        `[placePrefetch] trip ${tripId}: cached ${rows.length} places${area.truncated ? ' (area trimmed)' : ''}`,
      )
    }
    return rows.length
  } catch (err) {
    console.warn('[placePrefetch] skipped:', (err as Error).message)
    return 0
  }
}

/**
 * Offline place search over everything cached for any trip.
 *
 * Not scoped to a trip on purpose: the `tripId` on a row is how the set is
 * evicted, not who may read it. Somebody offline in Rostock searching from the
 * journal, a collection or the planner is looking for the same places, and
 * making three of those four screens answer "no connection" because the area
 * was fetched under a different trip id would be an arbitrary refusal.
 *
 * Prefix-and-substring on the folded name. Not a ranking engine: it is the
 * difference between a search box that answers and one that does not.
 */
export async function searchCachedPlaces(query: string, limit = 10): Promise<CachedAreaPlace[]> {
  const needle = foldName(query)
  if (needle.length < 2) return []

  // Prefix hits come off the index; the substring pass is the fallback for
  // "osteria" matching "L'Osteria Rostock", which no prefix index can answer.
  const byPrefix = await offlineDb.areaPlaces.where('searchName').startsWith(needle).limit(limit).toArray()
  if (byPrefix.length >= limit) return byPrefix

  const seen = new Set(byPrefix.map((p) => p.gers))
  const rest = await offlineDb.areaPlaces
    .filter((p) => !seen.has(p.gers) && p.searchName.includes(needle))
    .limit(limit - byPrefix.length)
    .toArray()

  return [...byPrefix, ...rest]
}

/** A cached row in the shape every search caller already reads. */
export function cachedToPlaceRecord(p: CachedAreaPlace): Record<string, unknown> {
  return {
    google_place_id: null,
    osm_id: `gers:${p.gers}`,
    name: p.name,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    rating: null,
    website: p.website,
    phone: p.phone,
    category: p.category,
    source: 'offline-cache',
  }
}

/** Drop a trip's cached area. Called when the trip leaves the offline set. */
export async function clearCachedPlaces(tripId: number): Promise<void> {
  await offlineDb.areaPlaces.where('tripId').equals(tripId).delete()
}
