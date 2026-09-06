import Dexie, { type Table } from 'dexie';
import type { Trip, Day, Place, PackingItem, TodoItem, BudgetItem, Reservation, TripFile, Accommodation, TripMember, Tag, Category } from '../types';

/** TripMember enriched with tripId so we can index by trip. */
export interface CachedTripMember extends TripMember {
  tripId: number;
}

// ── Queue + sync types ────────────────────────────────────────────────────────

// 'conflict' is terminal-until-resolved: the server rejected the replay because
// the entity changed underneath the offline edit (#1135 ask 3). It is surfaced
// to the user for a keep-mine / keep-theirs decision rather than dropped.
export type MutationStatus = 'pending' | 'syncing' | 'failed' | 'conflict';

export interface QueuedMutation {
  /** UUID — also used as X-Idempotency-Key sent to the server */
  id: string;
  tripId: number;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body: unknown;
  createdAt: number;
  status: MutationStatus;
  attempts: number;
  lastError: string | null;
  /** Dexie table name to write the server response into after flush (e.g. 'places') */
  resource?: string;
  /** For CREATE mutations enqueued offline: the temporary negative id written to Dexie */
  tempId?: number;
  /** For DELETE mutations: the entity id to remove from Dexie on flush */
  entityId?: number;
  /**
   * For PUT/DELETE enqueued offline against a still-unsynced (negative-id) entity:
   * the temp id of the target. The url carries an `{id}` placeholder that the
   * mutation queue rewrites to the real server id once the dependent CREATE flushes.
   */
  tempEntityId?: number;
  /**
   * Optimistic-concurrency token: the entity's `updated_at` at the moment the
   * offline edit was made. Sent as `X-Base-Updated-At` on replay so the server
   * can reject the write (409) if someone else changed the entity in the
   * meantime. Absent for creates and for resources without a token.
   */
  baseUpdatedAt?: string | null;
  /**
   * Set when the replay came back 409: the server's current version of the
   * entity, kept so the conflict resolver can show "theirs" beside "mine"
   * (which is reconstructed from `body`). Only present while status==='conflict'.
   */
  conflictServer?: unknown;
  /** When the conflict was detected (for ordering / display). */
  conflictAt?: number;
  /**
   * When the row was marked 'syncing'. Only meaningful while it is — the flush
   * that set it clears the row on success or moves it off 'syncing' on failure.
   * A stamp that outlives its flush is how a killed tab is recognised on the
   * next one (see mutationQueue's STUCK_SYNCING_MS).
   */
  syncingSince?: number;
}

export interface SyncMeta {
  tripId: number;
  lastSyncedAt: number | null;
  status: 'idle' | 'syncing' | 'error';
  /** Bounding box [minLng, minLat, maxLng, maxLat] of pre-downloaded map tiles */
  tilesBbox: [number, number, number, number] | null;
  /** Non-photo files available offline for this trip after the last sync. */
  filesCachedCount: number;
  /**
   * The rounded bbox the cached area places were fetched for. Compared rather
   * than a timestamp: adding a place inside the area the trip already covers
   * should not re-download it, and moving the trip should.
   *
   * Optional so a row written before this landed still reads.
   */
  areaPlacesKey?: string;
}

export interface BlobCacheEntry {
  /** Relative URL, e.g. "/api/files/42/download" */
  url: string;
  /**
   * Trip this blob belongs to, so it is evicted together with the trip in
   * clearTripData. Legacy rows cached before v3 carry the sentinel -1.
   */
  tripId: number;
  blob: Blob;
  /** Byte size captured at insert time — Blob.size is not reliably preserved
   *  across IndexedDB round-trips, so the LRU budget reads this instead. */
  bytes: number;
  mime: string;
  cachedAt: number;
}

/**
 * A place from the TREK Places index, cached for the area of one trip.
 *
 * NOT a trip place — those are in `places` and belong to the user. These are
 * candidates: the shops, restaurants and stations that happen to be near where
 * the trip goes, taken once so search still answers on a plane. They are
 * disposable and are re-fetched whenever the trip's area changes.
 *
 * The key is the GERS id, which is stable across index rebuilds; `tripId` is
 * indexed so the whole set can be dropped with the trip.
 */
export interface CachedAreaPlace {
  /** GERS id, without the `gers:` prefix the server puts on `osm_id`. */
  gers: string;
  tripId: number;
  name: string;
  /** Lowercased, diacritics folded — what an offline search actually matches on. */
  searchName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  cachedAt: number;
}

/** An uploaded booking-import source file, kept so the review flow can attach it to the
 *  created bookings even after a page reload during the (background) parse. Keyed by job. */
export interface ImportSourceFile {
  jobId: string;
  fileName: string;
  blob: Blob;
  createdAt: number;
}

// ── Dexie class ────────────────────────────────────────────────────────────────

/**
 * The offline DB is scoped per user so that one account can never read another
 * account's cached data on a shared device. Anonymous (logged-out) state uses
 * the base name; a logged-in user uses `trek-offline-u<userId>`.
 */
const ANON_DB_NAME = 'trek-offline';

function userDbName(userId: number | string): string {
  return `trek-offline-u${userId}`;
}

/**
 * Best-effort read of the persisted auth snapshot so the very first DB opened on
 * app load (before loadUser resolves) is already the correct per-user one — the
 * PWA can render cached data offline without leaking across users.
 */
function initialDbName(): string {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('trek_auth_snapshot') : null;
    if (!raw) return ANON_DB_NAME;
    const id = JSON.parse(raw)?.state?.user?.id;
    return id != null ? userDbName(id) : ANON_DB_NAME;
  } catch {
    return ANON_DB_NAME;
  }
}

class TrekOfflineDb extends Dexie {
  trips!: Table<Trip, number>;
  days!: Table<Day, number>;
  places!: Table<Place, number>;
  packingItems!: Table<PackingItem, number>;
  todoItems!: Table<TodoItem, number>;
  budgetItems!: Table<BudgetItem, number>;
  reservations!: Table<Reservation, number>;
  tripFiles!: Table<TripFile, number>;
  accommodations!: Table<Accommodation, number>;
  tripMembers!: Table<CachedTripMember, [number, number]>;
  tags!: Table<Tag, number>;
  categories!: Table<Category, number>;
  mutationQueue!: Table<QueuedMutation, string>;
  syncMeta!: Table<SyncMeta, number>;
  blobCache!: Table<BlobCacheEntry, string>;
  importFiles!: Table<ImportSourceFile, [string, string]>;
  areaPlaces!: Table<CachedAreaPlace, string>;

  constructor(name: string = ANON_DB_NAME) {
    super(name);

    this.version(1).stores({
      trips:        'id',
      days:         'id, trip_id',
      places:       'id, trip_id',
      packingItems: 'id, trip_id',
      todoItems:    'id, trip_id',
      budgetItems:  'id, trip_id',
      reservations: 'id, trip_id',
      tripFiles:    'id, trip_id',
      mutationQueue:'id, tripId, status, createdAt',
      syncMeta:     'tripId',
      blobCache:    'url, cachedAt',
    });

    this.version(2).stores({
      accommodations: 'id, trip_id',
      tripMembers:    '[tripId+id], tripId',
      tags:           'id',
      categories:     'id',
    });

    // v3: scope the blob cache by trip so it can be evicted with the trip and
    // bounded by an LRU budget (see enforceBlobBudget).
    this.version(3).stores({
      blobCache: 'url, cachedAt, tripId',
    }).upgrade(async (tx) => {
      await tx.table('blobCache').toCollection().modify((row: Partial<BlobCacheEntry>) => {
        if (row.tripId == null) row.tripId = -1;
        if (row.bytes == null) row.bytes = row.blob?.size ?? 0;
      });
    });

    // v4: durable store for booking-import source files (survives a reload mid-parse).
    this.version(4).stores({
      importFiles: '[jobId+fileName], jobId, createdAt',
    });

    // v5: places from the TREK Places index for the trip's area, so search
    // answers offline. `searchName` is indexed because that is what an offline
    // query filters on; `tripId` so the set drops with its trip.
    this.version(5).stores({
      areaPlaces: 'gers, tripId, searchName',
    });
  }
}

// The live instance is swapped on login/logout via reopenForUser/reopenAnonymous.
// A Proxy keeps the exported `offlineDb` binding stable for the ~19 modules that
// import it directly, while every access forwards to the current connection.
let _db = new TrekOfflineDb(initialDbName());

export const offlineDb = new Proxy({} as TrekOfflineDb, {
  get(_target, prop) {
    const value = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(_db) : value;
  },
  set(_target, prop, value) {
    (_db as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
}) as TrekOfflineDb;

async function switchTo(name: string): Promise<void> {
  if (_db.name === name) {
    if (!_db.isOpen()) await _db.open();
    return;
  }
  if (_db.isOpen()) _db.close();
  _db = new TrekOfflineDb(name);
  await _db.open();
}

/** Point the offline DB at a specific user's scoped database (call on login). */
export async function reopenForUser(userId: number | string): Promise<void> {
  await switchTo(userDbName(userId));
}

/** Point the offline DB at the anonymous database (call on logout). */
export async function reopenAnonymous(): Promise<void> {
  await switchTo(ANON_DB_NAME);
}

/**
 * Delete the current user's scoped database entirely and return to the anonymous
 * DB. Used on logout so no trace of the account's data remains on the device.
 */
export async function deleteCurrentUserDb(): Promise<void> {
  // Already anonymous: there is nothing to delete, and opening a second
  // connection to the same name would leak the current handle for the session.
  if (_db.name === ANON_DB_NAME) {
    await switchTo(ANON_DB_NAME);
    return;
  }
  try { await _db.delete(); } catch { /* ignore — fall through to anon */ }
  _db = new TrekOfflineDb(ANON_DB_NAME);
  await _db.open();
}

// ── Bulk upsert helpers ────────────────────────────────────────────────────────

export async function upsertTrip(trip: Trip): Promise<void> {
  await offlineDb.trips.put(trip);
}

export async function upsertDays(days: Day[]): Promise<void> {
  await offlineDb.days.bulkPut(days);
}

export async function upsertPlaces(places: Place[]): Promise<void> {
  await offlineDb.places.bulkPut(places);
}

export async function upsertPackingItems(items: PackingItem[]): Promise<void> {
  await offlineDb.packingItems.bulkPut(items);
}

export async function upsertTodoItems(items: TodoItem[]): Promise<void> {
  await offlineDb.todoItems.bulkPut(items);
}

export async function upsertBudgetItems(items: BudgetItem[]): Promise<void> {
  await offlineDb.budgetItems.bulkPut(items);
}

export async function upsertReservations(items: Reservation[]): Promise<void> {
  await offlineDb.reservations.bulkPut(items);
}

export async function upsertTripFiles(files: TripFile[]): Promise<void> {
  await offlineDb.tripFiles.bulkPut(files);
}

export async function upsertAccommodations(items: Accommodation[]): Promise<void> {
  await offlineDb.accommodations.bulkPut(items);
}

export async function upsertTripMembers(tripId: number, members: TripMember[]): Promise<void> {
  const rows: CachedTripMember[] = members.map(m => ({ ...m, tripId }));
  await offlineDb.tripMembers.bulkPut(rows);
}

export async function upsertTags(tags: Tag[]): Promise<void> {
  await offlineDb.tags.bulkPut(tags);
}

export async function upsertCategories(categories: Category[]): Promise<void> {
  await offlineDb.categories.bulkPut(categories);
}

export async function upsertSyncMeta(meta: SyncMeta): Promise<void> {
  await offlineDb.syncMeta.put(meta);
}

/**
 * Read a pre-downloaded file blob for offline use. Returns null when the file
 * was never cached (or on any read error). The stored MIME is reapplied so the
 * caller's inline-vs-download decision stays correct even if the persisted Blob
 * lost its type.
 */
export async function getCachedBlob(url: string): Promise<Blob | null> {
  try {
    const entry = await offlineDb.blobCache.get(url);
    if (!entry) return null;
    return entry.blob.type
      ? entry.blob
      : new Blob([entry.blob], { type: entry.mime || 'application/octet-stream' });
  } catch {
    return null;
  }
}

// ── Booking-import source files ─────────────────────────────────────────────

/** Abandoned import files (never reviewed) are pruned after this long. */
const IMPORT_FILE_TTL_MS = 60 * 60_000;

/**
 * Persist the uploaded source files for a background import job so the per-item review can
 * attach each document to its booking even if the page reloads during the parse. Best-effort.
 */
export async function saveImportFiles(jobId: string, files: File[]): Promise<void> {
  try {
    const now = Date.now();
    await offlineDb.importFiles.bulkPut(files.map(f => ({ jobId, fileName: f.name, blob: f, createdAt: now })));
    // Prune leftovers from imports that were never reviewed.
    await offlineDb.importFiles.where('createdAt').below(now - IMPORT_FILE_TTL_MS).delete();
  } catch { /* the in-memory copy still serves the no-reload path */ }
}

/** A job's stored source files, rebuilt as File objects (name + type preserved for upload). */
export async function getImportFiles(jobId: string): Promise<File[]> {
  try {
    const rows = await offlineDb.importFiles.where('jobId').equals(jobId).toArray();
    return rows.map(r => new File([r.blob], r.fileName, { type: r.blob.type || 'application/octet-stream' }));
  } catch {
    return [];
  }
}

/** Drop a job's stored source files once they've been handed to the review flow. */
export async function deleteImportFiles(jobId: string): Promise<void> {
  try { await offlineDb.importFiles.where('jobId').equals(jobId).delete(); } catch { /* ignore */ }
}

// ── Blob-cache budget ───────────────────────────────────────────────────────

/**
 * Upper bounds for the offline file-blob cache. Kept conservative so trip
 * documents never starve the map-tile cache (sized at MAX_TILES in
 * tilePrefetcher.ts) for the origin's storage quota.
 */
export const BLOB_CACHE_MAX_ENTRIES = 200;
export const BLOB_CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Evict oldest-by-cachedAt blobs until the cache is under both the entry-count
 * and byte budget. Call after inserting new blobs. LRU on insertion time, which
 * is a reasonable proxy for access for write-once document blobs.
 */
export async function enforceBlobBudget(
  maxCount = BLOB_CACHE_MAX_ENTRIES,
  maxBytes = BLOB_CACHE_MAX_BYTES,
): Promise<void> {
  const entries = await offlineDb.blobCache.orderBy('cachedAt').toArray();
  let count = entries.length;
  let totalBytes = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  if (count <= maxCount && totalBytes <= maxBytes) return;

  const toDelete: string[] = [];
  for (const e of entries) {
    if (count <= maxCount && totalBytes <= maxBytes) break;
    toDelete.push(e.url);
    totalBytes -= e.bytes ?? 0;
    count -= 1;
  }
  if (toDelete.length) await offlineDb.blobCache.bulkDelete(toDelete);
}

// ── Eviction / cleanup ────────────────────────────────────────────────────────

/**
 * Delete one trip's cached READ data (eviction, per-trip opt-out). The offline
 * write queue is deliberately preserved except for already-dropped 'failed' rows:
 * a trip can be evicted for being stale, or turned off in the storage settings,
 * while it still holds unsynced offline edits (pending/syncing) or unresolved
 * conflicts — those must survive so the user's work is not silently lost (#1135).
 * The replay only needs the queued REST request, not the cached entities, and a
 * successful flush re-adds the canonical row. The full "Clear cache" wipe goes
 * through clearAll(), which intentionally drops everything.
 */
export async function clearTripData(tripId: number): Promise<void> {
  await offlineDb.transaction(
    'rw',
    [
      offlineDb.days,
      offlineDb.places,
      offlineDb.packingItems,
      offlineDb.todoItems,
      offlineDb.budgetItems,
      offlineDb.reservations,
      offlineDb.tripFiles,
      offlineDb.accommodations,
      offlineDb.tripMembers,
      offlineDb.mutationQueue,
      offlineDb.syncMeta,
      offlineDb.blobCache,
    ],
    async () => {
      await offlineDb.days.where('trip_id').equals(tripId).delete();
      await offlineDb.places.where('trip_id').equals(tripId).delete();
      await offlineDb.packingItems.where('trip_id').equals(tripId).delete();
      await offlineDb.todoItems.where('trip_id').equals(tripId).delete();
      await offlineDb.budgetItems.where('trip_id').equals(tripId).delete();
      await offlineDb.reservations.where('trip_id').equals(tripId).delete();
      await offlineDb.tripFiles.where('trip_id').equals(tripId).delete();
      await offlineDb.accommodations.where('trip_id').equals(tripId).delete();
      await offlineDb.tripMembers.where('tripId').equals(tripId).delete();
      // Keep pending/syncing/conflict mutations — only purge dead 'failed' rows.
      await offlineDb.mutationQueue.where('tripId').equals(tripId).and(m => m.status === 'failed').delete();
      await offlineDb.syncMeta.where('tripId').equals(tripId).delete();
      await offlineDb.blobCache.where('tripId').equals(tripId).delete();
    },
  );
  // Remove the trip row itself outside the transaction since it's a separate table
  await offlineDb.trips.delete(tripId);
}

/** Wipe the entire offline database (called on logout). */
export async function clearAll(): Promise<void> {
  await offlineDb.delete();
  // Re-open so subsequent operations don't fail
  await offlineDb.open();
}
