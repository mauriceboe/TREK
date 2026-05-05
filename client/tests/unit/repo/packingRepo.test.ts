/**
 * packingRepo unit tests.
 *
 * Online path:  calls REST via MSW, writes result to Dexie.
 * Offline path: returns Dexie cache, skips REST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { server } from '../../helpers/msw/server';
import { http, HttpResponse } from 'msw';
import { packingRepo } from '../../../src/repo/packingRepo';
import { offlineDb, clearAll } from '../../../src/db/offlineDb';
import { buildPackingItem } from '../../helpers/factories';

beforeEach(async () => {
  await clearAll();
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('packingRepo.list', () => {
  it('online — fetches from REST and caches in Dexie', async () => {
    const item = buildPackingItem({ trip_id: 1 });
    server.use(
      http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [item] })),
    );

    const result = await packingRepo.list(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(item.id);

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.packingItems.where('trip_id').equals(1).toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe(item.id);
  });

  it('offline — returns Dexie cache without REST call', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });

    const item = buildPackingItem({ trip_id: 1 });
    await offlineDb.packingItems.put(item);

    let restCalled = false;
    server.use(
      http.get('/api/trips/1/packing', () => {
        restCalled = true;
        return HttpResponse.json({ items: [] });
      }),
    );

    const result = await packingRepo.list(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(item.id);
    expect(restCalled).toBe(false);
  });

  it('offline — returns empty array when nothing cached', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });
    const result = await packingRepo.list(99);
    expect(result.items).toHaveLength(0);
  });
});

describe('packingRepo.create', () => {
  it('writes item optimistically to Dexie immediately', async () => {
    const result = await packingRepo.create(1, { name: 'Sunscreen' });
    expect(result.item.name).toBe('Sunscreen');
    // tempId is negative (-(Date.now()))
    expect(result.item.id).toBeLessThan(0);

    const cached = await offlineDb.packingItems.where('trip_id').equals(1).toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].name).toBe('Sunscreen');
  });
});

describe('packingRepo.update', () => {
  it('writes optimistic update to Dexie immediately', async () => {
    const original = buildPackingItem({ trip_id: 1, name: 'Jacket', checked: 0 });
    await offlineDb.packingItems.put(original);

    const result = await packingRepo.update(1, original.id, { checked: true });
    expect(result.item.checked).toBeTruthy();

    const cached = await offlineDb.packingItems.get(original.id);
    expect(cached!.checked).toBeTruthy();
  });
});

describe('packingRepo.delete', () => {
  it('calls REST and removes from Dexie', async () => {
    const item = buildPackingItem({ trip_id: 1 });
    await offlineDb.packingItems.put(item);

    server.use(
      http.delete(`/api/trips/1/packing/${item.id}`, () => HttpResponse.json({ success: true })),
    );

    await packingRepo.delete(1, item.id);

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.packingItems.get(item.id);
    expect(cached).toBeUndefined();
  });
});
