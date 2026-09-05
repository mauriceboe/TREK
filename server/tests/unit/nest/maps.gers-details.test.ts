/**
 * MAPS-GERS-001..007 — the details of a place that came from the index.
 *
 * The case that started this: L'Osteria Steinstrasse showed opening hours while
 * it was being added and none on its card afterwards. The index is not the only
 * source for a place it holds, and this is where the rest gets filled in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockById } = vi.hoisted(() => ({
  mockById: vi.fn(async (_gers: string): Promise<unknown> => null),
}));
vi.mock('../../../src/nest/maps/trek-places.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/maps/trek-places.client')>()),
  trekPlacesById: mockById,
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

import { MapsService } from '../../../src/nest/maps/maps.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const PLACE = {
  gers: 'abc-123',
  name: "L'Osteria",
  lat: 54.0879,
  lng: 12.1408,
  category: 'restaurant',
  categoryPath: 'eat_and_drink>restaurant',
  confidence: 1,
  address: { freeform: 'Steinstrasse 9', locality: 'Rostock', postcode: '18055', region: null, country: 'DE' },
  contact: { website: 'https://losteria.net/', phone: null, email: null, socials: null },
  brand: null,
  source: 'overture',
  hours: null as { osm: string } | null,
};

function make(osmTags: Record<string, string> | null) {
  const database = { get: vi.fn(() => undefined) } as unknown as DatabaseService;
  const svc = new MapsService(database, {} as PlacePhotoCacheService);
  vi.spyOn(svc, 'resolveOsmIdentity').mockResolvedValue(
    osmTags ? { tags: osmTags, osmUrl: 'https://www.openstreetmap.org/node/1', matchedName: "L'Osteria" } : null,
  );
  return svc;
}

beforeEach(() => {
  mockById.mockReset();
  mockById.mockResolvedValue({ ...PLACE });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('MapsService.getPlaceDetails for a gers: id', () => {
  it('MAPS-GERS-001: prefers the hours OpenStreetMap has for the same building', async () => {
    // OSM describes this exact object and gets corrected by people who walked
    // past. A chain's website often carries one set of hours for every branch.
    mockById.mockResolvedValue({ ...PLACE, hours: { osm: 'Mo-Su 12:00-22:00' } });
    const out = await make({ opening_hours: 'Mo-Su 11:30-23:00' }).getPlaceDetails(1, 'gers:abc-123');
    // Expanded to weekday lines, which is the shape the card reads.
    expect(out.place?.opening_hours).toEqual(expect.arrayContaining(['Monday: 11:30-23:00']));
  });

  it('MAPS-GERS-002: falls back to the hours the operator publishes', async () => {
    // OpenStreetMap has hours for 27.5 percent of gastronomy, measured across
    // seven countries. This is what covers part of the rest.
    mockById.mockResolvedValue({ ...PLACE, hours: { osm: 'Mo-Su 12:00-22:00' } });
    const out = await make({ cuisine: 'italian' }).getPlaceDetails(1, 'gers:abc-123');
    expect(out.place?.opening_hours).toEqual(expect.arrayContaining(['Monday: 12:00-22:00']));
  });

  it('MAPS-GERS-003: still answers when OpenStreetMap knows nothing about it', async () => {
    mockById.mockResolvedValue({ ...PLACE, hours: { osm: 'Mo-Su 12:00-22:00' } });
    const out = await make(null).getPlaceDetails(1, 'gers:abc-123');
    expect(out.place?.name).toBe("L'Osteria");
    // Same shape whether the hours came from OSM or from the operator's site.
    expect(out.place?.opening_hours).toEqual(expect.arrayContaining(['Monday: 12:00-22:00']));
  });

  it('MAPS-GERS-004: a place nobody has hours for shows none, not an empty string', async () => {
    const out = await make(null).getPlaceDetails(1, 'gers:abc-123');
    expect(out.place?.opening_hours ?? null).toBeNull();
  });

  it('MAPS-GERS-005: the index wins on the fields the user actually picked', async () => {
    const out = await make({ name: 'Etwas anderes', opening_hours: 'Mo-Fr 09:00-17:00' })
      .getPlaceDetails(1, 'gers:abc-123');
    expect(out.place).toMatchObject({ name: "L'Osteria", osm_id: 'gers:abc-123', source: 'trek-places' });
  });

  it('MAPS-GERS-006: an unknown id is null rather than a thrown request', async () => {
    mockById.mockResolvedValue(null);
    expect(await make(null).getPlaceDetails(1, 'gers:nope')).toEqual({ place: null });
  });

  it('MAPS-GERS-007: a failing lookup is a null, not a 500', async () => {
    mockById.mockRejectedValue(new Error('places api down'));
    expect(await make(null).getPlaceDetails(1, 'gers:abc-123')).toEqual({ place: null });
  });
});
