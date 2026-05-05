/**
 * offlineDb unit tests.
 *
 * Uses fake-indexeddb so no real browser IDB is needed.
 * Each test gets a fresh database by using `use-fake-indexeddb` with Dexie.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

// Re-import after fake-indexeddb is set up so Dexie picks up the shim.
// We re-open a clean db in each test to isolate state.
import {
  offlineDb,
  clearTripData,
  clearAll,
  upsertTrip,
  upsertDays,
  upsertPlaces,
  upsertPackingItems,
  upsertTodoItems,
  upsertBudgetItems,
  upsertReservations,
  upsertTripFiles,
  upsertSyncMeta,
  type QueuedMutation,
  type SyncMeta,
  type BlobCacheEntry,
} from '../../../src/db/offlineDb';
import type { Trip, Day, Place, PackingItem, TodoItem, BudgetItem, Reservation, TripFile } from '../../../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeTrip = (id = 1): Trip => ({
  id,
  name: `Trip ${id}`,
  description: null,
  start_date: '2026-07-01',
  end_date: '2026-07-05',
  cover_url: null,
  is_archived: false,
  reminder_days: 3,
  owner_id: 42,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const makeDay = (id: number, tripId = 1): Day => ({
  id,
  trip_id: tripId,
  date: '2026-07-01',
  title: null,
  notes: null,
  assignments: [],
  notes_items: [],
});

const makePlace = (id: number, tripId = 1): Place => ({
  id,
  trip_id: tripId,
  name: `Place ${id}`,
  description: null,
  notes: null,
  lat: 48.8566,
  lng: 2.3522,
  address: null,
  category_id: null,
  icon: null,
  price: null,
  currency: null,
  image_url: null,
  google_place_id: null,
  osm_id: null,
  route_geometry: null,
  place_time: null,
  end_time: null,
  duration_minutes: null,
  transport_mode: null,
  website: null,
  phone: null,
  created_at: '2026-01-01T00:00:00Z',
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Ensure DB is open (fake-indexeddb resets between test files but not between tests).
  if (!offlineDb.isOpen()) await offlineDb.open();
  // Clear all tables before each test.
  await clearAll();
});

afterEach(async () => {
  if (!offlineDb.isOpen()) await offlineDb.open();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('offlineDb — trips', () => {
  it('stores and retrieves a trip via upsertTrip', async () => {
    const trip = makeTrip(10);
    await upsertTrip(trip);
    const stored = await offlineDb.trips.get(10);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('Trip 10');
  });

  it('upsertTrip overwrites an existing trip (put semantics)', async () => {
    await upsertTrip(makeTrip(1));
    await upsertTrip({ ...makeTrip(1), name: 'Updated' });
    const stored = await offlineDb.trips.get(1);
    expect(stored!.name).toBe('Updated');
  });
});

describe('offlineDb — days', () => {
  it('stores days and retrieves by trip_id index', async () => {
    await upsertDays([makeDay(1, 5), makeDay(2, 5), makeDay(3, 9)]);
    const trip5Days = await offlineDb.days.where('trip_id').equals(5).toArray();
    expect(trip5Days).toHaveLength(2);
    expect(trip5Days.map(d => d.id)).toContain(1);
    expect(trip5Days.map(d => d.id)).toContain(2);
  });
});

describe('offlineDb — places', () => {
  it('stores places and retrieves by trip_id', async () => {
    await upsertPlaces([makePlace(10, 1), makePlace(11, 1), makePlace(12, 2)]);
    const places = await offlineDb.places.where('trip_id').equals(1).toArray();
    expect(places).toHaveLength(2);
  });
});

describe('offlineDb — packing / todo / budget / reservations / files', () => {
  it('upserts packing items', async () => {
    const item: PackingItem = { id: 1, trip_id: 1, name: 'Passport', category: null, category_id: null, category_type: null, category_owner_id: null, checked: 0, quantity: 1 };
    await upsertPackingItems([item]);
    expect(await offlineDb.packingItems.count()).toBe(1);
  });

  it('upserts todo items', async () => {
    const item: TodoItem = {
      id: 1, trip_id: 1, name: 'Book hotel', category: null, checked: 0,
      sort_order: 0, due_date: null, description: null, assigned_user_id: null, priority: 0,
    };
    await upsertTodoItems([item]);
    expect(await offlineDb.todoItems.count()).toBe(1);
  });

  it('upserts budget items', async () => {
    const item: BudgetItem = {
      id: 1, trip_id: 1, name: 'Flight', amount: 500, currency: 'EUR',
      category: 'Transport', paid_by: null, persons: 1, members: [], expense_date: null,
    };
    await upsertBudgetItems([item]);
    expect(await offlineDb.budgetItems.count()).toBe(1);
  });

  it('upserts reservations', async () => {
    const item: Reservation = {
      id: 1, trip_id: 1, name: 'Hotel', type: 'hotel', status: 'confirmed',
      date: null, time: null, confirmation_number: null, notes: null, url: null, created_at: '2026-01-01T00:00:00Z',
    };
    await upsertReservations([item]);
    expect(await offlineDb.reservations.count()).toBe(1);
  });

  it('upserts trip files', async () => {
    const file: TripFile = {
      id: 1, trip_id: 1, filename: 'ticket.pdf', original_name: 'Ticket.pdf',
      mime_type: 'application/pdf', created_at: '2026-01-01T00:00:00Z',
    };
    await upsertTripFiles([file]);
    expect(await offlineDb.tripFiles.count()).toBe(1);
  });
});

describe('offlineDb — syncMeta', () => {
  it('stores and retrieves syncMeta by tripId', async () => {
    const meta: SyncMeta = {
      tripId: 7,
      lastSyncedAt: Date.now(),
      status: 'idle',
      tilesBbox: null,
      filesCachedCount: 0,
    };
    await upsertSyncMeta(meta);
    const stored = await offlineDb.syncMeta.get(7);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('idle');
  });
});

describe('offlineDb — mutationQueue', () => {
  it('stores queued mutations queryable by status', async () => {
    const pending: QueuedMutation = {
      id: 'uuid-1', tripId: 1, method: 'POST', url: '/api/trips/1/places',
      body: { name: 'Eiffel Tower' }, createdAt: Date.now(),
      status: 'pending', attempts: 0, lastError: null,
    };
    const failed: QueuedMutation = {
      id: 'uuid-2', tripId: 1, method: 'PUT', url: '/api/trips/1/places/5',
      body: { name: 'Updated' }, createdAt: Date.now(),
      status: 'failed', attempts: 3, lastError: 'Network error',
    };
    await offlineDb.mutationQueue.bulkPut([pending, failed]);

    const pendingRows = await offlineDb.mutationQueue.where('status').equals('pending').toArray();
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].id).toBe('uuid-1');

    const failedRows = await offlineDb.mutationQueue.where('status').equals('failed').toArray();
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].lastError).toBe('Network error');
  });
});

describe('offlineDb — blobCache', () => {
  it('stores and retrieves a Blob entry', async () => {
    const blob = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
    const entry: BlobCacheEntry = {
      url: '/api/files/99/download',
      blob,
      mime: 'application/pdf',
      cachedAt: Date.now(),
    };
    await offlineDb.blobCache.put(entry);

    const stored = await offlineDb.blobCache.get('/api/files/99/download');
    expect(stored).toBeDefined();
    expect(stored!.mime).toBe('application/pdf');
    expect(stored!.blob).toBeDefined();
  });
});

describe('offlineDb — clearTripData', () => {
  it('removes all data for the given trip across all tables', async () => {
    await upsertTrip(makeTrip(1));
    await upsertDays([makeDay(1, 1), makeDay(2, 1)]);
    await upsertPlaces([makePlace(10, 1)]);
    const item: PackingItem = { id: 5, trip_id: 1, name: 'Towel', category: null, category_id: null, category_type: null, category_owner_id: null, checked: 0, quantity: 1 };
    await upsertPackingItems([item]);

    // Also add data for a different trip — should NOT be removed
    await upsertTrip(makeTrip(2));
    await upsertDays([makeDay(99, 2)]);

    await clearTripData(1);

    expect(await offlineDb.trips.get(1)).toBeUndefined();
    expect(await offlineDb.days.where('trip_id').equals(1).count()).toBe(0);
    expect(await offlineDb.places.where('trip_id').equals(1).count()).toBe(0);
    expect(await offlineDb.packingItems.where('trip_id').equals(1).count()).toBe(0);

    // Trip 2 intact
    expect(await offlineDb.trips.get(2)).toBeDefined();
    expect(await offlineDb.days.where('trip_id').equals(2).count()).toBe(1);
  });
});

describe('offlineDb — clearAll', () => {
  it('empties all tables', async () => {
    await upsertTrip(makeTrip(1));
    await upsertDays([makeDay(1, 1), makeDay(2, 1)]);
    await upsertPlaces([makePlace(10, 1)]);

    await clearAll();

    expect(await offlineDb.trips.count()).toBe(0);
    expect(await offlineDb.days.count()).toBe(0);
    expect(await offlineDb.places.count()).toBe(0);
  });
});
