/**
 * The TREK Places client: what it sends, what it refuses, and how it maps an
 * answer onto the record shape the rest of TREK already reads.
 *
 * fetch is stubbed rather than hit: the point is the contract, and a unit test
 * that depends on a live service tells you about the service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable, so the instance URL and the operator's own index can be set per test.
const { env } = vi.hoisted(() => ({
  env: { maps: { trekPlacesUrl: '' }, app: { appUrl: 'https://trip.example.org' } },
}));

vi.mock('../../../src/app-config', () => ({ readEnv: () => env }));

import {
  DEFAULT_TREK_PLACES_URL,
  POI_CATEGORY_TO_TREK,
  toPlaceRecord,
  trekPlacesArea,
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

const BOX = { minLat: 54, minLng: 12, maxLat: 54.2, maxLng: 12.3 };

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

const encoder = new TextEncoder();
let streamCancelled = false;

// The same stub with a real body stream, so the capped reader runs instead of
// res.text(). text() throws here to prove which arm was taken.
function stubStreamingFetch(chunks: (string | Uint8Array)[], status = 200) {
  calls = [];
  streamCancelled = false;
  const queue = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = queue.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
        cancel() { streamCancelled = true; },
      }),
      text: async () => { throw new Error('read the stream, not text()'); },
    } as unknown as Response;
  }));
}

beforeEach(() => {
  calls = [];
  env.maps.trekPlacesUrl = '';
  env.app.appUrl = 'https://trip.example.org';
  // Nothing in this file may reach the real service: a test that forgets to
  // stub gets a thrown request rather than a request.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unstubbed fetch'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('trekPlacesBaseUrl', () => {
  it('falls back to the public instance when nothing is configured', () => {
    expect(trekPlacesBaseUrl()).toBe(DEFAULT_TREK_PLACES_URL);
  });

  it('uses the operator own copy when one is configured', () => {
    env.maps.trekPlacesUrl = 'https://places.example.net';
    expect(trekPlacesBaseUrl()).toBe('https://places.example.net');
  });

  it('strips trailing slashes rather than doubling them into the path', () => {
    env.maps.trekPlacesUrl = 'https://places.example.net//';
    expect(trekPlacesBaseUrl()).toBe('https://places.example.net');
  });

  it('treats a blank setting as unconfigured', () => {
    env.maps.trekPlacesUrl = '   ';
    expect(trekPlacesBaseUrl()).toBe(DEFAULT_TREK_PLACES_URL);
  });

  it('sends the request to the configured host, not the public one', async () => {
    env.maps.trekPlacesUrl = 'https://places.example.net/';
    stubFetch({ query: 'x', results: [] });
    await trekPlacesSearch('x');
    const url = new URL(calls[0].url);
    expect(url.origin).toBe('https://places.example.net');
    expect(url.pathname).toBe('/v1/search');
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

  it('names one instance the same way twice, and another instance differently', async () => {
    const token = async () => {
      stubFetch({ query: 'x', results: [] });
      await trekPlacesSearch('x');
      return (calls[0].init?.headers as Record<string, string>)['X-TREK-Instance'];
    };
    const configured = await token();
    // Derived from the URL, not generated: a token that changed per call would
    // hand the same instance a fresh rate-limit budget on every request.
    expect(await token()).toBe(configured);
    env.app.appUrl = '';
    const unconfigured = await token();
    expect(unconfigured).toMatch(/^trek-[a-z0-9]+$/);
    // Two instances the far side must be able to tell apart for its rate limit.
    expect(unconfigured).not.toBe(configured);
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

describe('reading the body', () => {
  // One buffer, handed out more than once: two of them are already over the cap.
  const BIG = new Uint8Array(600_000);

  it('assembles an answer that arrives in pieces', async () => {
    const payload = JSON.stringify({ query: 'x', results: [{ ...PLACE, name: 'Café Kröpeliner' }] });
    const bytes = encoder.encode(payload);
    // Cut between the two bytes of the é: decoding chunk by chunk would leave a
    // replacement character where the name is.
    const cut = bytes.indexOf(0xc3) + 1;
    stubStreamingFetch([bytes.slice(0, cut), bytes.slice(cut)]);
    const found = await trekPlacesSearch('cafe');
    expect(found[0].name).toBe('Café Kröpeliner');
  });

  it('refuses a body past the megabyte cap instead of buffering it', async () => {
    // The first chunk is under the cap, the second takes it over.
    stubStreamingFetch([BIG, BIG]);
    await expect(trekPlacesSearch('x')).rejects.toThrow('TREK Places API response too large');
  });

  it('drops the connection instead of draining the rest of an oversized body', async () => {
    // A third chunk nobody reads: the cap trips while the body is still running,
    // which is the case that has a connection left to drop. Cancelling a stream
    // that already ended is a no-op and would assert nothing.
    stubStreamingFetch([BIG, BIG, BIG]);
    await expect(trekPlacesSearch('x')).rejects.toThrow('TREK Places API response too large');
    expect(streamCancelled).toBe(true);
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

  it('asks 1500m and 50 rows when the caller says nothing', async () => {
    stubFetch({ results: [] });
    await trekPlacesNearby(54.1, 12.1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/nearby');
    expect(url.searchParams.get('radius')).toBe('1500');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('category')).toBe(false);
  });

  it('lets the caller ask for a smaller circle and fewer rows', async () => {
    stubFetch({ results: [] });
    await trekPlacesNearby(54.1, 12.1, { radius: 300, limit: 5 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('radius')).toBe('300');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('passes the distance the index measured through', async () => {
    stubFetch({ results: [{ ...PLACE, distanceMetres: 12 }] });
    const out = await trekPlacesNearby(54.1, 12.1);
    expect(out).toHaveLength(1);
    expect(out[0].distanceMetres).toBe(12);
  });

  it('survives a malformed results field', async () => {
    stubFetch({ results: { 0: PLACE } });
    await expect(trekPlacesNearby(54.1, 12.1)).resolves.toEqual([]);
  });
});

describe('trekPlacesArea', () => {
  it('sends the whole box and caps the rows at 2000', async () => {
    stubFetch({ count: 1, truncated: false, results: [PLACE] });
    await trekPlacesArea(BOX);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/bbox');
    expect(url.searchParams.get('minLat')).toBe('54');
    expect(url.searchParams.get('minLng')).toBe('12');
    expect(url.searchParams.get('maxLat')).toBe('54.2');
    expect(url.searchParams.get('maxLng')).toBe('12.3');
    expect(url.searchParams.get('limit')).toBe('2000');
  });

  it('sends the caller own cap when one is given', async () => {
    stubFetch({ count: 0, truncated: false, results: [] });
    await trekPlacesArea(BOX, 500);
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('500');
  });

  it('keeps an edge on the equator instead of dropping it', async () => {
    stubFetch({ count: 0, truncated: false, results: [] });
    await trekPlacesArea({ ...BOX, minLat: 0 });
    // 0 is a coordinate, not a missing value; dropping it would widen the box.
    expect(new URL(calls[0].url).searchParams.get('minLat')).toBe('0');
  });

  it('passes truncation through rather than smoothing it over', async () => {
    stubFetch({ count: 20000, truncated: true, results: [PLACE] });
    const area = await trekPlacesArea(BOX);
    // A client that believed it had the whole area would search offline and
    // quietly miss places.
    expect(area.truncated).toBe(true);
    expect(area.count).toBe(20000);
    expect(area.results).toHaveLength(1);
  });

  it('reads a count that arrived as a string, and a truthy truncated flag', async () => {
    stubFetch({ count: '17', truncated: 1, results: [] });
    const area = await trekPlacesArea(BOX);
    expect(area.count).toBe(17);
    expect(area.truncated).toBe(true);
  });

  it('turns a malformed answer into an empty one rather than passing it on', async () => {
    stubFetch({ count: 'lots', truncated: undefined, results: null });
    await expect(trekPlacesArea(BOX)).resolves.toEqual({ count: 0, truncated: false, results: [] });
  });

  it('throws on an error status so the sync can leave the area alone', async () => {
    stubFetch({}, 502);
    await expect(trekPlacesArea(BOX)).rejects.toThrow(/502/);
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

  it('files the chain under brand:wikidata, never under the place own identity', () => {
    // `wikidata` means "the article about this place". Putting the chain's item
    // there is how a branch ends up illustrated with the company logo and
    // described as the franchise operator, which is the whole reason
    // readWikiIdentity refuses to follow brand:* tags.
    const r = toPlaceRecord(PLACE);
    expect(r['brand:wikidata']).toBe('Q123');
    expect(r.wikidata).toBeUndefined();
    expect(r.brand).toBe("L'Osteria");
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
