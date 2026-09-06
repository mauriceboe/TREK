/**
 * MAPS-GEOCODE-001..009 — turning one string into one coordinate.
 *
 * The lookup behind booking-import: a confirmation mail names a hotel, a
 * station, an airport, and this is what puts it on the map. It runs up to
 * thirty times in a single import, so both halves matter — whether the query
 * leaves the instance at all (the index is asked first, and only while the
 * admin leaves it on), and that a failure on either side ends as a coordinate
 * or a null rather than a half-answer the importer would store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSearch, mockNominatim } = vi.hoisted(() => ({
  mockSearch: vi.fn(async (_query: string, _opts?: { limit?: number }): Promise<unknown> => []),
  mockNominatim: vi.fn(
    async (_endpoint: string, _params: URLSearchParams, _opts?: { lane?: string }): Promise<unknown> => ({
      ok: true,
      json: async () => [],
    }),
  ),
}));
vi.mock('../../../src/nest/maps/trek-places.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/maps/trek-places.client')>()),
  trekPlacesSearch: mockSearch,
}));
vi.mock('../../../src/nest/geo/nominatim.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/geo/nominatim.client')>()),
  nominatimFetch: mockNominatim,
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

import { MapsService } from '../../../src/nest/maps/maps.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const QUERY = 'Hotel Adlon Kempinski, Unter den Linden 77, Berlin';

const indexHit = (lat: unknown, lng: unknown) => [
  { gers: 'abc-123', name: 'Hotel Adlon Kempinski', lat, lng, source: 'overture' },
];

const OSM_ROW = {
  osm_type: 'way',
  osm_id: 24838110,
  lat: '52.5162746',
  lon: '13.3796780',
  name: 'Hotel Adlon Kempinski',
  display_name: 'Hotel Adlon Kempinski, Unter den Linden, Mitte, Berlin, Deutschland',
};

const osmAnswer = (rows: unknown[]) => ({ ok: true, json: async () => rows });

function make(enabled = true) {
  const database = {
    get: vi.fn(() => (enabled ? undefined : { value: 'false' })),
  } as unknown as DatabaseService;
  return new MapsService(database, {} as PlacePhotoCacheService);
}

beforeEach(() => {
  mockSearch.mockReset();
  mockSearch.mockResolvedValue([]);
  mockNominatim.mockReset();
  mockNominatim.mockResolvedValue(osmAnswer([OSM_ROW]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('MapsService.geocodeQuery', () => {
  it('MAPS-GEOCODE-001: an index hit answers on its own, without a second lookup', async () => {
    mockSearch.mockResolvedValue(indexHit(52.5162746, 13.379678));
    expect(await make().geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    // One result is all the caller can use; asking for ten would only cost the
    // index work.
    expect(mockSearch).toHaveBeenCalledWith(QUERY, { limit: 1 });
    expect(mockNominatim).not.toHaveBeenCalled();
  });

  it('MAPS-GEOCODE-002: a zero coordinate is a place, not a missing value', async () => {
    // Pontianak sits on the equator. A truthiness check would drop it and send
    // the query on to Nominatim for no reason.
    mockSearch.mockResolvedValue(indexHit(0, 109.3333));
    expect(await make().geocodeQuery('Tugu Khatulistiwa, Pontianak')).toEqual({ lat: 0, lng: 109.3333 });
    expect(mockNominatim).not.toHaveBeenCalled();
  });

  it('MAPS-GEOCODE-003: a hit with one unusable coordinate falls through instead of being returned', async () => {
    // Half a coordinate lands the booking in the Gulf of Guinea. Both halves
    // are driven, so neither finiteness check can be dropped unnoticed.
    mockSearch.mockResolvedValue(indexHit(48.8583701, Number.NaN));
    expect(await make().geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    mockSearch.mockResolvedValue(indexHit(undefined, 2.2944813));
    expect(await make().geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    expect(mockNominatim).toHaveBeenCalledTimes(2);
  });

  it('MAPS-GEOCODE-004: an index that found nothing falls through to OpenStreetMap', async () => {
    mockSearch.mockResolvedValue([]);
    expect(await make().geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    expect(mockNominatim).toHaveBeenCalledTimes(1);
  });

  it('MAPS-GEOCODE-005: an index failure is a warning and a fallback, not a lost booking', async () => {
    mockSearch.mockRejectedValue(new Error('places api down'));
    expect(await make().geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    expect(console.warn).toHaveBeenCalledWith('TREK Places geocode failed, falling back:', 'places api down');
  });

  it('MAPS-GEOCODE-006: the query never leaves for the index while the admin has it off', async () => {
    // The index has an answer, and a different one: the OSM coordinate coming
    // back is what proves the gate held rather than the call merely being made.
    mockSearch.mockResolvedValue(indexHit(1.2345, 2.3456));
    expect(await make(false).geocodeQuery(QUERY)).toEqual({ lat: 52.5162746, lng: 13.379678 });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('MAPS-GEOCODE-007: the fallback goes out on the background lane', async () => {
    // Thirty of these run inside one import. On the interactive lane they take
    // every slot and somebody typing in the place search waits behind them.
    await make().geocodeQuery(QUERY);
    const [endpoint, params, opts] = mockNominatim.mock.calls[0];
    expect(endpoint).toBe('search');
    expect(params.get('q')).toBe(QUERY);
    expect(opts?.lane).toBe('background');
  });

  it('MAPS-GEOCODE-008: a Nominatim row with an unparseable coordinate is null, not NaN', async () => {
    // searchNominatim turns the failed parse into null, and half a coordinate
    // is no coordinate — asserted per side, so neither null check is free.
    mockNominatim.mockResolvedValue(osmAnswer([{ ...OSM_ROW, lon: 'unknown' }]));
    expect(await make().geocodeQuery(QUERY)).toBeNull();
    mockNominatim.mockResolvedValue(osmAnswer([{ ...OSM_ROW, lat: 'unknown' }]));
    expect(await make().geocodeQuery(QUERY)).toBeNull();
  });

  it('MAPS-GEOCODE-009: neither source knowing the place is a null, not a guess', async () => {
    mockNominatim.mockResolvedValue(osmAnswer([]));
    expect(await make().geocodeQuery('Zzz Hotel, Nowhere')).toBeNull();
  });
});
