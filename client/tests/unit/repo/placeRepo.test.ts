/**
 * placeRepo unit tests.
 *
 * Online path:  calls REST via MSW, writes result to Dexie.
 * Offline path: returns Dexie cache, skips REST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { server } from '../../helpers/msw/server';
import { http, HttpResponse } from 'msw';
import { placeRepo } from '../../../src/repo/placeRepo';
import { offlineDb, clearAll } from '../../../src/db/offlineDb';
import { buildPlace } from '../../helpers/factories';

beforeEach(async () => {
  await clearAll();
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('placeRepo.list', () => {
  it('online — fetches from REST and caches in Dexie', async () => {
    const place = buildPlace({ trip_id: 1 });
    server.use(
      http.get('/api/trips/1/places', () => HttpResponse.json({ places: [place] })),
    );

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);

    // Give fire-and-forget a tick to flush
    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.where('trip_id').equals(1).toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe(place.id);
  });

  it('offline — returns Dexie cache without REST call', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });

    const place = buildPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    let restCalled = false;
    server.use(
      http.get('/api/trips/1/places', () => {
        restCalled = true;
        return HttpResponse.json({ places: [] });
      }),
    );

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);
    expect(restCalled).toBe(false);
  });

  it('offline — returns empty array when nothing cached and network fails', async () => {
    server.use(
      http.get('/api/trips/99/places', () => HttpResponse.error()),
    );
    const result = await placeRepo.list(99);
    expect(result.places).toHaveLength(0);
  });
});

describe('placeRepo.create', () => {
  it('writes place optimistically to Dexie immediately', async () => {
    const result = await placeRepo.create(1, { name: 'Eiffel Tower' });
    expect(result.place.name).toBe('Eiffel Tower');
    // tempId is negative (-(Date.now()))
    expect(result.place.id).toBeLessThan(0);

    const cached = await offlineDb.places.where('trip_id').equals(1).toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].name).toBe('Eiffel Tower');
  });
});

describe('placeRepo.update', () => {
  it('calls REST and updates Dexie cache', async () => {
    const original = buildPlace({ trip_id: 1, name: 'Old Name' });
    await offlineDb.places.put(original);

    const updated = { ...original, name: 'New Name' };
    server.use(
      http.put(`/api/trips/1/places/${original.id}`, () => HttpResponse.json({ place: updated })),
    );

    const result = await placeRepo.update(1, original.id, { name: 'New Name' });
    expect(result.place.name).toBe('New Name');

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.get(original.id);
    expect(cached!.name).toBe('New Name');
  });
});

describe('placeRepo.delete', () => {
  it('calls REST and removes from Dexie', async () => {
    const place = buildPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    server.use(
      http.delete(`/api/trips/1/places/${place.id}`, () => HttpResponse.json({ success: true })),
    );

    await placeRepo.delete(1, place.id);

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.get(place.id);
    expect(cached).toBeUndefined();
  });
});
