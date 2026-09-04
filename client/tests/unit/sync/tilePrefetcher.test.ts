/**
 * tilePrefetcher unit tests.
 *
 * Covers: bbox computation, tile math, URL building, size guard,
 * offline/no-SW guard, syncMeta update.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  computeBbox,
  lngToTileX,
  latToTileY,
  buildTileUrl,
  countTiles,
  prefetchTiles,
  prefetchTilesForTrip,
  UNPERSISTED_MAX_ZOOM,
  clearTileCache,
  MAX_TILES,
  TILE_CONCURRENCY,
  type TileBbox,
} from '../../../src/sync/tilePrefetcher';
import { offlineDb, clearAll, upsertSyncMeta } from '../../../src/db/offlineDb';
import { requestPersistentStorage, _resetPersistentStorage } from '../../../src/sync/persistentStorage';
import { setAuthed } from '../../../src/sync/authGate';
import { buildPlace } from '../../helpers/factories';

beforeEach(async () => {
  await clearAll();
  setAuthed(true);
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
  // Stub fetch + serviceWorker so prefetch path is exercised
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { controller: {} },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  setAuthed(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── bbox computation ──────────────────────────────────────────────────────────

describe('computeBbox', () => {
  it('returns null when no places have coordinates', () => {
    const places = [buildPlace({ lat: null, lng: null })];
    expect(computeBbox(places)).toBeNull();
  });

  it('expands single-point bbox to at least 0.1° span', () => {
    const place = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const bbox = computeBbox([place])!;
    expect(bbox.maxLat - bbox.minLat).toBeGreaterThan(0.09);
    expect(bbox.maxLng - bbox.minLng).toBeGreaterThan(0.09);
  });

  it('computes multi-point bbox with padding', () => {
    const places = [
      buildPlace({ lat: 48.8566, lng: 2.3522 }),  // Paris
      buildPlace({ lat: 51.5074, lng: -0.1278 }),  // London
    ];
    const bbox = computeBbox(places, 0.1)!;
    // Padded bbox should extend beyond raw points
    expect(bbox.minLat).toBeLessThan(48.8566);
    expect(bbox.maxLat).toBeGreaterThan(51.5074);
    expect(bbox.minLng).toBeLessThan(-0.1278);
    expect(bbox.maxLng).toBeGreaterThan(2.3522);
  });

  it('clamps to valid Mercator lat bounds', () => {
    const places = [buildPlace({ lat: 85.0, lng: 0 })];
    const bbox = computeBbox(places, 0.5)!;
    expect(bbox.maxLat).toBeLessThanOrEqual(85.0511);
  });
});

// ── tile math ─────────────────────────────────────────────────────────────────

describe('lngToTileX', () => {
  it('returns 0 for lng=-180 at any zoom', () => {
    expect(lngToTileX(-180, 10)).toBe(0);
  });

  it('returns max tile for lng=180 at zoom 1', () => {
    // At zoom 1: 2^1 = 2 tiles, lng=180 → x = floor(360/360 * 2) = floor(2) = 2
    // But tile range is 0..1, so this is the "overflow" edge — that's fine
    expect(lngToTileX(180, 1)).toBe(2);
  });

  it('increases with more easterly longitude', () => {
    const x1 = lngToTileX(0, 10);
    const x2 = lngToTileX(10, 10);
    expect(x2).toBeGreaterThan(x1);
  });
});

describe('latToTileY', () => {
  it('returns smaller y for higher latitude (north = top)', () => {
    const yNorth = latToTileY(60, 10);
    const ySouth = latToTileY(10, 10);
    expect(yNorth).toBeLessThan(ySouth);
  });

  it('equator is roughly half the tile grid', () => {
    const yEq = latToTileY(0, 1);
    // zoom 1 → 2 rows, equator ≈ row 1
    expect(yEq).toBe(1);
  });
});

// ── URL building ───────────────────────────────────────────────────────────────

describe('buildTileUrl', () => {
  it('replaces {z}, {x}, {y}, {r} correctly', () => {
    const tmpl = 'https://tile.example.com/{z}/{x}/{y}.png';
    const url = buildTileUrl(tmpl, 10, 500, 300);
    expect(url).toBe('https://tile.example.com/10/500/300.png');
  });

  it('replaces {s} with a subdomain character', () => {
    const tmpl = 'https://{s}.tiles.example.com/{z}/{x}/{y}.png';
    const url = buildTileUrl(tmpl, 10, 0, 0);
    expect(url).toMatch(/^https:\/\/[abc]\.tiles\.example\.com\/10\/0\/0\.png$/);
  });

  it('picks the subdomain deterministically so a tile keeps one URL', () => {
    const tmpl = 'https://{s}.tiles.example.com/{z}/{x}/{y}.png';
    // A rotating counter would hand out a different host on each call, which
    // both breaks the cache lookup and stores the tile once per host.
    const first = buildTileUrl(tmpl, 10, 479, 329);
    buildTileUrl(tmpl, 10, 480, 330);
    expect(buildTileUrl(tmpl, 10, 479, 329)).toBe(first);
  });

  it('spreads neighbouring tiles across subdomains', () => {
    const tmpl = 'https://{s}.tiles.example.com/{z}/{x}/{y}.png';
    const hosts = new Set(
      [0, 1, 2].map(dy => buildTileUrl(tmpl, 10, 479, 329 + dy).slice(8, 9)),
    );
    expect(hosts.size).toBe(3);
  });

  it('uses the same subdomain rotation as Leaflet', () => {
    // Leaflet's TileLayer defaults to subdomains 'abc' and indexes it with
    // Math.abs(x + y) % length. A different list length here would cache each
    // tile under a host the map never asks for.
    const tmpl = 'https://{s}.tiles.example.com/{z}/{x}/{y}.png';
    const leaflet = 'abc';
    for (const [x, y] of [[479, 329], [480, 330], [12, 7], [0, 0], [5, 4]]) {
      const expected = leaflet[Math.abs(x + y) % leaflet.length];
      expect(buildTileUrl(tmpl, 10, x, y)).toBe(
        `https://${expected}.tiles.example.com/10/${x}/${y}.png`,
      );
    }
  });

  it('collapses the retired OSM subdomain sharding onto the single host', () => {
    // d.tile.openstreetmap.org stopped resolving after OSM dropped sharding, so
    // a template saved before that must not reach the network as-is (#1733).
    const url = buildTileUrl('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', 13, 4091, 2722);
    expect(url).toBe('https://tile.openstreetmap.org/13/4091/2722.png');
  });

  it('removes {r} (retina placeholder)', () => {
    const tmpl = 'https://tiles.example.com/{z}/{x}/{y}{r}.png';
    const url = buildTileUrl(tmpl, 10, 0, 0);
    expect(url).toBe('https://tiles.example.com/10/0/0.png');
  });
});

// ── countTiles ────────────────────────────────────────────────────────────────

describe('countTiles', () => {
  it('returns more tiles at higher zoom levels', () => {
    const bbox: TileBbox = { minLat: 48.7, maxLat: 49.0, minLng: 2.2, maxLng: 2.5 };
    const low = countTiles(bbox, 10, 10);
    const high = countTiles(bbox, 12, 12);
    expect(high).toBeGreaterThan(low);
  });

  it('stops counting after exceeding MAX_TILES', () => {
    // Very large bbox — should hit cap quickly at high zooms
    const bbox: TileBbox = { minLat: -60, maxLat: 60, minLng: -180, maxLng: 180 };
    const count = countTiles(bbox, 10, 16);
    expect(count).toBeGreaterThan(MAX_TILES);
  });
});

// ── prefetchTiles guards ───────────────────────────────────────────────────────

describe('prefetchTiles — offline guard', () => {
  it('returns 0 and does not fetch when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });
    const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };
    const count = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 10);
    expect(count).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns 0 when no service worker controller', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { controller: null },
      configurable: true,
    });
    const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };
    const count = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 10);
    expect(count).toBe(0);
  });
});

describe('prefetchTiles — normal operation', () => {
  it('fetches tiles and returns count', async () => {
    const bbox: TileBbox = { minLat: 48.84, maxLat: 48.87, minLng: 2.33, maxLng: 2.37 };
    const count = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 11);
    expect(count).toBeGreaterThan(0);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('stops at zoom level where cap is exceeded', async () => {
    // Use a very small MAX_TILES override by using a huge bbox
    const bbox: TileBbox = { minLat: -80, maxLat: 80, minLng: -170, maxLng: 170 };
    // This bbox at zoom 10 alone has thousands of tiles — should trigger early stop
    const count = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 16);
    expect(count).toBeLessThanOrEqual(MAX_TILES);
  });
});

// ── throttling ────────────────────────────────────────────────────────────────

describe('prefetchTiles — throttling', () => {
  /** fetch stub that resolves on the next macrotask and tracks concurrency. */
  function trackingFetch() {
    const state = { inFlight: 0, peak: 0, calls: 0 };
    vi.stubGlobal('fetch', vi.fn(() => {
      state.calls++;
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      return new Promise(resolve => setTimeout(() => {
        state.inFlight--;
        resolve({ ok: true });
      }, 0));
    }));
    return state;
  }

  it('never exceeds TILE_CONCURRENCY requests in flight', async () => {
    const state = trackingFetch();
    const bbox: TileBbox = { minLat: 48.0, maxLat: 49.0, minLng: 2.0, maxLng: 3.0 };

    await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 12);

    expect(state.calls).toBeGreaterThan(TILE_CONCURRENCY);
    expect(state.peak).toBeLessThanOrEqual(TILE_CONCURRENCY);
  });

  it('resolves only once every tile has been dealt with', async () => {
    const state = trackingFetch();
    const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };

    const fetched = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 11);

    expect(fetched).toBe(state.calls);
    expect(state.inFlight).toBe(0);
  });

  it('stops fetching when the user logs out mid-run', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      if (++calls === TILE_CONCURRENCY) setAuthed(false);
      return Promise.resolve({ ok: true });
    }));
    const bbox: TileBbox = { minLat: 48.0, maxLat: 49.0, minLng: 2.0, maxLng: 3.0 };

    await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 12);

    // The workers finish their current tile, then bail — nowhere near the ~336
    // tiles this bbox enumerates.
    expect(calls).toBeLessThan(2 * TILE_CONCURRENCY);
  });

  it('goes quiet when the connection drops mid-run', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      if (++calls === TILE_CONCURRENCY) {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      }
      return Promise.resolve({ ok: true });
    }));
    const bbox: TileBbox = { minLat: 48.0, maxLat: 49.0, minLng: 2.0, maxLng: 3.0 };

    await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 12);

    expect(calls).toBeLessThan(2 * TILE_CONCURRENCY);
  });
});

// ── cache reuse ───────────────────────────────────────────────────────────────

describe('prefetchTiles — cache reuse', () => {
  it('skips tiles already in Cache Storage instead of hitting the network', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue({}) }),
    });
    const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };

    const fetched = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 11);

    expect(fetched).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('still fetches when Cache Storage has no entry for the tile', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(undefined) }),
    });
    const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };

    const fetched = await prefetchTiles(bbox, 'https://{s}.example.com/{z}/{x}/{y}.png', 10, 11);

    expect(fetched).toBeGreaterThan(0);
  });
});

// ── prefetchTilesForTrip ──────────────────────────────────────────────────────

describe('prefetchTilesForTrip', () => {
  it('no-ops when no places have coordinates', async () => {
    const places = [buildPlace({ lat: null, lng: null })];
    await prefetchTilesForTrip(1, places);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('updates syncMeta tilesBbox after prefetch', async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: Date.now(), status: 'idle', tilesBbox: null, filesCachedCount: 0 });

    const places = [
      buildPlace({ trip_id: 1, lat: 48.8566, lng: 2.3522 }),
    ];
    await prefetchTilesForTrip(1, places, 'https://{s}.example.com/{z}/{x}/{y}.png');

    const meta = await offlineDb.syncMeta.get(1);
    expect(meta!.tilesBbox).not.toBeNull();
    expect(meta!.tilesBbox).toHaveLength(4);
  });

  it('#2228: caps the depth when the browser refused persistent storage', async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: Date.now(), status: 'idle', tilesBbox: null, filesCachedCount: 0 });
    const places = [buildPlace({ trip_id: 1, lat: 48.8566, lng: 2.3522 })];

    // Opaque tiles are billed at ~7 MB each. Without an eviction exemption a
    // full-depth run bills this origin tens of gigabytes, and the browser
    // answers by evicting the whole bucket, the precached app shell included,
    // which Workbox then never refills because sw.js has not changed.
    _resetPersistentStorage();
    await prefetchTilesForTrip(1, places, 'https://{s}.example.com/{z}/{x}/{y}.png');
    const zooms = vi.mocked(fetch).mock.calls.map(c => Number(new URL(String(c[0])).pathname.split('/')[1]));
    expect(Math.max(...zooms)).toBe(UNPERSISTED_MAX_ZOOM);

    vi.mocked(fetch).mockClear();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: async () => true, persisted: async () => true },
    });
    await requestPersistentStorage();
    await prefetchTilesForTrip(1, places, 'https://{s}.example.com/{z}/{x}/{y}.png', true);
    const deepZooms = vi.mocked(fetch).mock.calls.map(c => Number(new URL(String(c[0])).pathname.split('/')[1]));
    expect(Math.max(...deepZooms)).toBe(16);
  });

  it('zoom-clamps instead of skipping when the bbox exceeds MAX_TILES', async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: Date.now(), status: 'idle', tilesBbox: null, filesCachedCount: 0 });

    // ~4° road-trip span: low zooms fit the budget, high zooms (z14+) blow past
    // it. The old guard skipped the whole trip; now we keep what fits.
    const places = [
      buildPlace({ trip_id: 1, lat: 45.0, lng: 0.0 }),
      buildPlace({ trip_id: 1, lat: 49.0, lng: 4.0 }),
    ];
    await prefetchTilesForTrip(1, places, 'https://{s}.example.com/{z}/{x}/{y}.png');

    // Previously this skipped entirely; now it prefetches a clamped subset.
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_TILES);
  });

  it('prefetches a region-sized (0.5°) trip that the old all-or-nothing guard would have skipped', async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: Date.now(), status: 'idle', tilesBbox: null, filesCachedCount: 0 });

    const places = [
      buildPlace({ trip_id: 1, lat: 48.6, lng: 2.1 }),
      buildPlace({ trip_id: 1, lat: 49.1, lng: 2.6 }),
    ];
    await prefetchTilesForTrip(1, places, 'https://{s}.example.com/{z}/{x}/{y}.png');

    const calls = vi.mocked(fetch).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_TILES);
  });
});

// ── repeat runs ───────────────────────────────────────────────────────────────

describe('prefetchTilesForTrip — repeat runs', () => {
  const places = [buildPlace({ trip_id: 1, lat: 48.8566, lng: 2.3522 })];
  const tmpl = 'https://{s}.example.com/{z}/{x}/{y}.png';

  beforeEach(async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: Date.now(), status: 'idle', tilesBbox: null, filesCachedCount: 0 });
  });

  it('does nothing on a second run with an unchanged bbox', async () => {
    await prefetchTilesForTrip(1, places, tmpl);
    const first = vi.mocked(fetch).mock.calls.length;
    expect(first).toBeGreaterThan(0);

    vi.mocked(fetch).mockClear();
    await prefetchTilesForTrip(1, places, tmpl);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('prefetches again once a place moves the bbox', async () => {
    await prefetchTilesForTrip(1, places, tmpl);
    vi.mocked(fetch).mockClear();

    const moved = [...places, buildPlace({ trip_id: 1, lat: 45.4642, lng: 9.19 })];
    await prefetchTilesForTrip(1, moved, tmpl);

    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('runs anyway when forced (prepare for offline)', async () => {
    await prefetchTilesForTrip(1, places, tmpl);
    vi.mocked(fetch).mockClear();

    await prefetchTilesForTrip(1, places, tmpl, true);

    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('clearTileCache resets the bboxes so the next sync refills the cache', async () => {
    await prefetchTilesForTrip(1, places, tmpl);
    vi.mocked(fetch).mockClear();

    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    await clearTileCache();
    expect((await offlineDb.syncMeta.get(1))!.tilesBbox).toBeNull();

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await prefetchTilesForTrip(1, places, tmpl);

    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});

// ── cap coherence ───────────────────────────────────────────────────────────────

describe('MAX_TILES budget', () => {
  it('matches the Workbox map-tiles maxEntries in vite.config.js (drift guard)', () => {
    expect(MAX_TILES).toBe(12288);
  });
});

// ── service worker rule coherence ───────────────────────────────────────────────

describe('the map-tiles rule for OpenStreetMap (#1733)', () => {
  // Vitest runs with the client package as its root, so cwd is stable here.
  const config = readFileSync(resolve(process.cwd(), 'vite.config.js'), 'utf8');

  // Pull the OSM runtimeCaching pattern back out of the config and exercise it,
  // so this stays a statement about matching behaviour rather than about the
  // exact characters someone typed.
  const osmRule = /urlPattern:\s*(\/\^https[^\n]*openstreetmap[^\n]*\/i),/.exec(config);
  if (!osmRule) throw new Error('no OpenStreetMap runtimeCaching rule found in vite.config.js');
  const literal = osmRule[1];
  const pattern = new RegExp(literal.slice(1, literal.lastIndexOf('/')), 'i');

  it('caches the single-host URLs the prefetcher now builds', () => {
    // Without this the prefetch writes nothing to map-tiles, cache.match() never
    // hits, and the offline tile store stays empty.
    const url = buildTileUrl('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', 13, 4091, 2722);
    expect(url).toBe('https://tile.openstreetmap.org/13/4091/2722.png');
    expect(pattern.test(url)).toBe(true);
  });

  it('still matches the sharded URLs already sitting in existing caches', () => {
    for (const shard of ['a', 'b', 'c']) {
      expect(pattern.test(`https://${shard}.tile.openstreetmap.org/13/4091/2722.png`)).toBe(true);
    }
  });

  it('does not swallow a look-alike host', () => {
    expect(pattern.test('https://tile.openstreetmap.org.example.com/13/4091/2722.png')).toBe(false);
    expect(pattern.test('https://tile.openstreetmap.de/13/4091/2722.png')).toBe(false);
  });
});

describe('the GL style document is not served stale (#1924)', () => {
  const config = readFileSync(resolve(process.cwd(), 'vite.config.js'), 'utf8');

  // Read the rules in file order and exercise them the way Workbox does: the
  // first route whose pattern matches wins, so order is behaviour here, not style.
  const rules = [...config.matchAll(/urlPattern:\s*(\/[^\n]*?\/i),\s*\n\s*handler:\s*'([A-Za-z]+)'/g)].map(m => ({
    pattern: new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i'),
    handler: m[2],
  }));
  const firstMatch = (url: string) => rules.find(r => r.pattern.test(url));

  const MAPBOX_STYLE = 'https://api.mapbox.com/styles/v1/acme/ckabc123?sdk=js-3.25.0&access_token=pk.test';
  const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const MAPBOX_TILE = 'https://a.tiles.mapbox.com/v4/mapbox.mapbox-streets-v8/13/4091/2722.vector.pbf';
  const MAPBOX_GLYPHS = 'https://api.mapbox.com/fonts/v1/mapbox/DIN%20Pro%20Regular/0-255.pbf';

  it('finds the runtime caching rules at all (guards the parser above)', () => {
    expect(rules.length).toBeGreaterThan(4);
  });

  it('takes the Mapbox style from the network first', () => {
    // Under the tile rule's StaleWhileRevalidate the map was built from the
    // previous revision on every load, so a style republished with different
    // label languages kept rendering the old ones.
    expect(firstMatch(MAPBOX_STYLE)?.handler).toBe('NetworkFirst');
  });

  it('takes the OpenFreeMap style from the network first too', () => {
    expect(firstMatch(OPENFREEMAP_STYLE)?.handler).toBe('NetworkFirst');
  });

  it('leaves tiles, glyphs and sprites on the offline-friendly rule', () => {
    // Those are safe to serve stale and are what makes the basemap work offline.
    expect(firstMatch(MAPBOX_TILE)?.handler).toBe('StaleWhileRevalidate');
    expect(firstMatch(MAPBOX_GLYPHS)?.handler).toBe('StaleWhileRevalidate');
  });

  it('keeps the style out of the tile cache, so tile eviction cannot reach it', () => {
    expect(config).toMatch(/cacheName:\s*'gl-map-styles'/);
  });
});

describe('shipped raster presets reach the map-tiles cache (#2180)', () => {
  const config = readFileSync(resolve(process.cwd(), 'vite.config.js'), 'utf8');

  // First-match semantics, like the #1924 harness above, but capturing the
  // cacheName too: a preset whose tiles land in some other cache is as offline-
  // dead as one that matches nothing.
  const rules = [...config.matchAll(/urlPattern:\s*(\/[^\n]*?\/i),\s*\n\s*handler:\s*'([A-Za-z]+)',\s*\n\s*options:\s*\{\s*\n\s*cacheName:\s*'([^']+)'/g)].map(m => ({
    pattern: new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i'),
    handler: m[2],
    cacheName: m[3],
  }));
  const firstMatch = (url: string) => rules.find(r => r.pattern.test(url));

  it('OpenStreetMap DE tiles are cached — the preset used to match no rule at all', () => {
    const rule = firstMatch('https://tile.openstreetmap.de/13/4091/2722.png');
    expect(rule?.handler).toBe('CacheFirst');
    expect(rule?.cacheName).toBe('map-tiles');
  });

  it('Stadia tiles are cached the same way', () => {
    const rule = firstMatch('https://tiles.stadiamaps.com/tiles/alidade_smooth/13/4091/2722.png');
    expect(rule?.handler).toBe('CacheFirst');
    expect(rule?.cacheName).toBe('map-tiles');
  });

  it('still refuses look-alike hosts', () => {
    expect(firstMatch('https://tile.openstreetmap.de.example.com/13/4091/2722.png')).toBeUndefined();
  });
});

describe('prefetch covers the opening zoom (#2180)', () => {
  it('fetches the low zooms too, so a wide trip has tiles at its fitBounds view', async () => {
    // A ~3° multi-city bbox opens around z7 — the old z10 floor left that view
    // completely uncached offline.
    const bbox: TileBbox = { minLat: 47.0, maxLat: 50.0, minLng: 6.0, maxLng: 9.0 };
    await prefetchTiles(bbox, 'https://tile.example.com/{z}/{x}/{y}.png');
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('/0/'))).toBe(true);
    expect(urls.some(u => u.includes('/7/'))).toBe(true);
  });
});

describe('prefetch covers the opening viewport (#2180)', () => {
  const tmpl = 'https://tile.example.com/{z}/{x}/{y}.png';

  const tileCoords = () =>
    vi.mocked(fetch).mock.calls
      .map(call => /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(call[0])))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) }));

  const spanPx = (values: number[]) => (Math.max(...values) - Math.min(...values) + 1) * 256;

  it('reaches as far as the screen the map opens on, not just the places extent', async () => {
    // Berlin + Munich: fitBounds is limited by the north-south span, so the map
    // opens with several times the trip's longitude in view. The places extent
    // is two tile columns wide at that zoom, and everything beside it was grey.
    const bbox = computeBbox([
      buildPlace({ lat: 52.52, lng: 13.405 }),
      buildPlace({ lat: 48.14, lng: 11.58 }),
    ])!;

    await prefetchTiles(bbox, tmpl, 7, 7);

    const opening = tileCoords().filter(t => t.z === 7);
    expect(spanPx(opening.map(t => t.x))).toBeGreaterThanOrEqual(window.innerWidth);
    expect(spanPx(opening.map(t => t.y))).toBeGreaterThanOrEqual(window.innerHeight);
  });

  it('still covers the places extent corner to corner', async () => {
    // The screen is a widening, not a replacement: past the opening zoom the
    // bbox is the larger of the two and stays the thing being prefetched.
    const bbox: TileBbox = { minLat: 48.0, maxLat: 49.0, minLng: 2.0, maxLng: 3.0 };

    await prefetchTiles(bbox, tmpl, 9, 9);

    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain(buildTileUrl(tmpl, 9, lngToTileX(2.0, 9), latToTileY(49.0, 9)));
    expect(urls).toContain(buildTileUrl(tmpl, 9, lngToTileX(3.0, 9), latToTileY(48.0, 9)));
  });

  it('never asks for a tile outside the grid', async () => {
    // Widening a world-spanning bbox at z0 would otherwise run x from -2 to 3,
    // and every one of those URLs is a 404 stored as an opaque cache entry.
    const bbox: TileBbox = { minLat: -60, maxLat: 60, minLng: -180, maxLng: 180 };

    await prefetchTiles(bbox, tmpl, 0, 2);

    // The whole grid at z0..z2 and not one tile more.
    expect(tileCoords()).toHaveLength(1 + 4 + 16);
    for (const { z, x, y } of tileCoords()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(Math.pow(2, z));
      expect(y).toBeLessThan(Math.pow(2, z));
    }
  });
});

describe('prefetchTiles: a refused tile is not a cached tile (#2180)', () => {
  const bbox: TileBbox = { minLat: 48.8, maxLat: 48.9, minLng: 2.3, maxLng: 2.4 };
  const tmpl = 'https://tile.example.com/{z}/{x}/{y}.png';

  it('counts nothing when every request is refused', async () => {
    // What a CSP block looks like from here. Counting these is how a prefetch
    // that stored not one tile still reported "cached N tiles" to the console.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const fetched = await prefetchTiles(bbox, tmpl, 10, 11);

    expect(vi.mocked(fetch)).toHaveBeenCalled();
    expect(fetched).toBe(0);
  });

  it('counts the tiles that did go through', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => (++calls % 2 === 1
      ? Promise.resolve({ ok: true })
      : Promise.reject(new TypeError('Failed to fetch')))));

    const fetched = await prefetchTiles(bbox, tmpl, 10, 11);

    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(calls);
  });
});
