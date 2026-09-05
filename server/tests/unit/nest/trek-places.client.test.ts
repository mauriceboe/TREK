/**
 * The TREK Places client: what it sends, what it refuses, and how it maps an
 * answer onto the record shape the rest of TREK already reads.
 *
 * fetch is stubbed rather than hit: the point is the contract, and a unit test
 * that depends on a live service tells you about the service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/app-config', () => ({
  readEnv: () => ({ maps: { trekPlacesUrl: '' }, app: { appUrl: 'https://trip.example.org' } }),
}));

import {
  DEFAULT_TREK_PLACES_URL,
  POI_CATEGORY_TO_TREK,
  toPlaceRecord,
  trekPlacesBaseUrl,
  trekPlacesById,
  trekPlacesNearby,
  trekPlacesSearch,
  type TrekPlace,
} from '../../../src/nest/maps/trek-places.client';

const PLACE: TrekPlace = {
  gers: 'abc-123',
  name: "L'Osteria",
  lat: 54.0879,
  lng: 12.1408,
  category: 'restaurant',
  categoryPath: 'eat_and_drink>restaurant',
  confidence: 1,
  address: { freeform: 'Steinstrasse 9', locality: 'Rostock', postcode: '18055', region: 'MV', country: 'DE' },
  contact: { website: 'https://losteria.net/', phone: '+49381', email: 'r@losteria.de', socials: null },
  brand: { name: "L'Osteria", wikidata: 'Q123' },
  source: 'overture',
  hours: null,
};

let calls: { url: string; init?: RequestInit }[] = [];

function stubFetch(body: unknown, status = 200) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: null,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => vi.unstubAllGlobals());

describe('trekPlacesBaseUrl', () => {
  it('falls back to the public instance when nothing is configured', () => {
    expect(trekPlacesBaseUrl()).toBe(DEFAULT_TREK_PLACES_URL);
  });
});

describe('trekPlacesSearch', () => {
  it('sends the query, the bias and a limit', async () => {
    stubFetch({ query: 'x', results: [PLACE] });
    const found = await trekPlacesSearch('losteria', { lat: 54.1, lng: 12.1, limit: 5 });
    expect(found).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('q')).toBe('losteria');
    expect(url.searchParams.get('lat')).toBe('54.1');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('identifies the instance without identifying a person', async () => {
    stubFetch({ query: 'x', results: [] });
    await trekPlacesSearch('x');
    const headers = calls[0].init?.headers as Record<string, string>;
    const token = headers['X-TREK-Instance'];
    // Stable, opaque, and derived from the instance URL rather than a user or
    // an install id: it exists so one caller cannot exhaust everyone's limit.
    expect(token).toMatch(/^trek-[a-z0-9]+$/);
    expect(token).not.toContain('example.org');
  });

  it('omits parameters that were not given rather than sending empties', async () => {
    stubFetch({ query: 'x', results: [] });
    await trekPlacesSearch('x');
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('lat')).toBe(false);
    expect(url.searchParams.has('lng')).toBe(false);
  });

  it('throws on an error status so the caller can fall back', async () => {
    stubFetch({}, 503);
    await expect(trekPlacesSearch('x')).rejects.toThrow(/503/);
  });

  it('survives a malformed results field', async () => {
    stubFetch({ query: 'x', results: 'not an array' });
    await expect(trekPlacesSearch('x')).resolves.toEqual([]);
  });
});

describe('trekPlacesById', () => {
  it('returns null for a place that does not exist instead of throwing', async () => {
    stubFetch({}, 404);
    await expect(trekPlacesById('nope')).resolves.toBeNull();
  });

  it('lets other failures through', async () => {
    stubFetch({}, 500);
    await expect(trekPlacesById('x')).rejects.toThrow();
  });

  it('escapes the id into the path', async () => {
    stubFetch({ place: PLACE });
    await trekPlacesById('a/b c');
    expect(calls[0].url).toContain('/v1/place/a%2Fb%20c');
  });
});

describe('trekPlacesNearby', () => {
  it('rounds the radius and passes the category list through', async () => {
    stubFetch({ results: [] });
    await trekPlacesNearby(54.1, 12.1, { radius: 812.7, category: 'cafe,coffee_shop' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('radius')).toBe('813');
    expect(url.searchParams.get('category')).toBe('cafe,coffee_shop');
  });
});

describe('toPlaceRecord', () => {
  it('produces the same shape the other providers do', () => {
    const r = toPlaceRecord(PLACE);
    expect(r).toMatchObject({
      google_place_id: null,
      osm_id: 'gers:abc-123',
      name: "L'Osteria",
      address: 'Steinstrasse 9, 18055, Rostock',
      lat: 54.0879,
      website: 'https://losteria.net/',
      phone: '+49381',
      source: 'trek-places',
    });
  });

  it('reports no rating rather than a made-up one', () => {
    // Ratings exist in no open dataset. Null says so; 0 would be a claim.
    expect(toPlaceRecord(PLACE).rating).toBeNull();
  });

  it('keeps a place on the null island rather than dropping its coordinate', () => {
    const r = toPlaceRecord({ ...PLACE, lat: 0, lng: 0 });
    expect(r.lat).toBe(0);
    expect(r.lng).toBe(0);
  });

  it('leaves the coordinate null when it is not a number', () => {
    const r = toPlaceRecord({ ...PLACE, lat: Number.NaN, lng: Number.NaN });
    expect(r.lat).toBeNull();
  });

  it('builds an address from whatever parts exist', () => {
    const r = toPlaceRecord({
      ...PLACE,
      address: { freeform: null, locality: 'Rostock', postcode: null, region: null, country: 'DE' },
    });
    expect(r.address).toBe('Rostock');
  });
});

describe('POI_CATEGORY_TO_TREK', () => {
  it('covers every pill the planner offers', () => {
    // The keys are the contract with the client's POI_CATEGORIES. A missing one
    // silently drops that pill back to Overpass, which is the slow path.
    expect(Object.keys(POI_CATEGORY_TO_TREK).sort()).toEqual([
      'activity', 'bar', 'cafe', 'hotel', 'museum',
      'nature', 'restaurant', 'shopping', 'sights', 'supermarket',
    ]);
  });

  it('gives every pill at least one category to match on', () => {
    for (const [pill, terms] of Object.entries(POI_CATEGORY_TO_TREK)) {
      expect(terms.length, pill).toBeGreaterThan(0);
    }
  });
});
