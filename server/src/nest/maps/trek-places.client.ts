/**
 * Client for the TREK Places API.
 *
 * The index behind it is Overture Places, built monthly and served from a
 * server the project runs. It replaces the two things TREK used to do badly:
 * searching through Nominatim, which its own usage policy forbids for
 * autocomplete, and paying Google for a text search whose terms then forbid
 * storing what comes back.
 *
 * Everything here is read-only, unauthenticated and cacheable. There is no key
 * to configure and no quota to exhaust, so the failure modes are the network
 * and the service being down, both of which fall back to what TREK did before.
 */
import { readEnv } from '../../app-config';

/** The public instance. An operator may point at their own copy instead. */
export const DEFAULT_TREK_PLACES_URL = 'https://places.liketrek.com';

/**
 * Short on purpose. This sits in front of a keystroke, and a slow answer is
 * worse than no answer: the caller falls back to the old path rather than
 * leaving somebody watching a spinner.
 */
const TIMEOUT_MS = 3500;

/** A search answer is a few kB. A megabyte means something is wrong upstream. */
const MAX_BYTES = 1_000_000;

export interface TrekPlace {
  gers: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  categoryPath: string | null;
  confidence: number | null;
  address: {
    freeform: string | null;
    locality: string | null;
    postcode: string | null;
    region: string | null;
    country: string | null;
  };
  contact: {
    website: string | null;
    phone: string | null;
    email: string | null;
    socials: string[] | null;
  };
  brand: { name: string | null; wikidata: string | null } | null;
  source: string;
  /**
   * Opening hours in OSM syntax, plus where they came from. The index carries
   * them for a small share of places; the rest are read from the schema.org
   * data the operator publishes on their own site, in the same page fetch the
   * description comes from.
   */
  hours: { osm: string; source: string | null; sourceUrl: string | null } | null;
  /** Quoted from the place's own site, when it publishes one for machines. */
  description?: { text: string; source: string | null; sourceUrl: string | null } | null;
  score?: number;
}

export interface TrekPlacesSearchResponse {
  query: string;
  results: TrekPlace[];
}

/**
 * One opaque string per instance, so the service can rate-limit per caller
 * instead of per IP. Derived from the instance URL rather than generated and
 * stored: it must be stable across restarts, and it must not be anything that
 * identifies a person. It is never resolved back to anything on the far side.
 */
function instanceToken(): string {
  const url = readEnv().app.appUrl || 'unconfigured';
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return `trek-${(hash >>> 0).toString(36)}`;
}

export function trekPlacesBaseUrl(): string {
  const configured = (readEnv().maps.trekPlacesUrl || '').trim();
  return (configured || DEFAULT_TREK_PLACES_URL).replace(/\/+$/, '');
}

async function getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(trekPlacesBaseUrl() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-TREK-Instance': instanceToken(),
      },
    });
    if (!res.ok) {
      const err = new Error(`TREK Places API ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    // Read with a cap rather than res.json(): a hostile or broken upstream
    // should not be able to hand us an unbounded body to buffer.
    const text = await readCapped(res, MAX_BYTES);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('TREK Places API response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function trekPlacesSearch(
  query: string,
  opts: { lat?: number; lng?: number; limit?: number } = {},
): Promise<TrekPlace[]> {
  const body = await getJson<TrekPlacesSearchResponse>('/v1/search', {
    q: query,
    lat: opts.lat,
    lng: opts.lng,
    limit: opts.limit ?? 10,
  });
  return Array.isArray(body.results) ? body.results : [];
}

/**
 * The planner's category pills, mapped onto Overture categories.
 *
 * Deliberately a hand-written map rather than a guess at runtime: the two
 * taxonomies do not line up, and a pill that quietly returns the wrong kind of
 * place is worse than one that returns none. Each entry is a substring matched
 * against `category` and `category_path`, so `eat_and_drink>cafe` answers the
 * cafe pill without listing every leaf.
 */
export const POI_CATEGORY_TO_TREK: Record<string, string[]> = {
  restaurant: ['restaurant', 'casual_eatery', 'fast_food'],
  cafe: ['cafe', 'coffee_shop'],
  bar: ['bar', 'pub', 'nightclub', 'brewery'],
  hotel: ['hotel', 'lodging', 'hostel', 'motel', 'bed_and_breakfast'],
  sights: ['historic_site', 'landmark_and_historical_building', 'monument', 'castle', 'tourist_attraction'],
  museum: ['museum', 'art_gallery', 'performing_arts', 'theater'],
  nature: ['park', 'garden', 'beach', 'nature_preserve', 'mountain'],
  activity: ['amusement_park', 'zoo', 'aquarium', 'water_park', 'theme_park'],
  shopping: ['shopping', 'shopping_center', 'department_store', 'market'],
  supermarket: ['grocery_store', 'food_and_beverage_store', 'convenience_store', 'supermarket'],
};

export interface TrekNearbyPlace extends TrekPlace {
  distanceMetres: number;
}

/**
 * Places around a coordinate, nearest first. Served from an R-Tree, so it
 * answers in milliseconds where the Overpass mirrors this used to ask are
 * regularly overloaded and answer in seconds or not at all.
 */
export async function trekPlacesNearby(
  lat: number,
  lng: number,
  opts: { radius?: number; limit?: number; category?: string } = {},
): Promise<TrekNearbyPlace[]> {
  const body = await getJson<{ results: TrekNearbyPlace[] }>('/v1/nearby', {
    lat,
    lng,
    radius: Math.round(opts.radius ?? 1500),
    limit: opts.limit ?? 50,
    category: opts.category,
  });
  return Array.isArray(body.results) ? body.results : [];
}

export interface TrekPlacesArea {
  count: number;
  truncated: boolean;
  results: TrekPlace[];
}

/**
 * Every place in a box, best first. What an instance takes once so the trip
 * keeps working with no network.
 *
 * The API caps the box at 1.5 degrees a side and the row count at 20000; both
 * are its call, not ours, and a `truncated` answer is passed through honestly
 * rather than smoothed over. A client that believed it had the whole area would
 * search offline and quietly miss places.
 */
export async function trekPlacesArea(
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  limit = 2000,
): Promise<TrekPlacesArea> {
  const body = await getJson<TrekPlacesArea>('/v1/bbox', { ...bbox, limit });
  return {
    count: Number(body.count) || 0,
    truncated: !!body.truncated,
    results: Array.isArray(body.results) ? body.results : [],
  };
}

export async function trekPlacesById(gers: string): Promise<TrekPlace | null> {
  try {
    const body = await getJson<{ place: TrekPlace }>(`/v1/place/${encodeURIComponent(gers)}`, {});
    return body.place ?? null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/**
 * Map a TREK place onto the record shape the client already reads.
 *
 * Deliberately the same shape Nominatim and Google produce, so nothing on the
 * client had to learn a third format. `osm_id` carries the GERS id prefixed
 * with `gers:`, because that field is where the client already looks for "the
 * provider's id for this place", and the prefix keeps it from being mistaken
 * for an OSM reference by code that parses it.
 */
export function toPlaceRecord(p: TrekPlace): Record<string, unknown> {
  const address = [p.address?.freeform, p.address?.postcode, p.address?.locality]
    .filter(Boolean)
    .join(', ');
  return {
    google_place_id: null,
    google_ftid: null,
    osm_id: `gers:${p.gers}`,
    name: p.name,
    address: address || p.address?.locality || '',
    lat: Number.isFinite(p.lat) ? p.lat : null,
    lng: Number.isFinite(p.lng) ? p.lng : null,
    // Ratings exist nowhere in open data, and saying so with null is honest.
    rating: null,
    website: p.contact?.website ?? null,
    phone: p.contact?.phone ?? null,
    email: p.contact?.email ?? null,
    category: p.category ?? null,
    brand: p.brand?.name ?? null,
    wikidata: p.brand?.wikidata ?? null,
    source: 'trek-places',
  };
}
