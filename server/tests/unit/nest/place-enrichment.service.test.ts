/**
 * Unit tests for PlaceEnrichmentService — ENRICH-001 through ENRICH-030.
 *
 * The service is a fan-out over MapsService primitives plus the shared photo
 * cache, so both are injected as stubs and every provider branch is driven from
 * the test. The SSRF guard is mocked the same way maps.service.test.ts mocks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Whatever the statement under test selects: a settings row, a cache row, or nothing. */
type DbRow = Record<string, unknown> | undefined;

const { mockDbGet, mockDbRun, mockSafeFetchFollow } = vi.hoisted(() => ({
  // Signature taken from the seam below rather than from this default: the
  // statement text is folded in ahead of the params, so a no-argument spy
  // would reject both the call site and every mockImplementation here.
  mockDbGet: vi.fn((_sql: string, ..._params: unknown[]): DbRow => undefined),
  mockDbRun: vi.fn((_sql: string, ..._params: unknown[]) => {}),
  mockSafeFetchFollow: vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
}));

// prepare() takes the SQL and the statement takes the params, so the spies get
// the statement text folded back in as their first argument — the assertions
// below distinguish the settings read from the cache read by exactly that.
vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => mockDbGet(sql, ...params),
      run: (...params: unknown[]) => mockDbRun(sql, ...params),
      all: () => [],
    }),
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => ({
  safeFetchFollow: mockSafeFetchFollow,
  checkSsrf: vi.fn(async () => ({ allowed: true })),
  SsrfBlockedError: class extends Error {},
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

// Reached for any `gers:` place id, where the real one is an outbound request
// to the TREK Places API. Only this export is replaced; the record shaping the
// rest of the module provides stays as it is.
const { mockTrekPlacesById } = vi.hoisted(() => ({
  mockTrekPlacesById: vi.fn(async (_gers: string): Promise<unknown> => null),
}));
vi.mock('../../../src/nest/maps/trek-places.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/maps/trek-places.client')>()),
  trekPlacesById: mockTrekPlacesById,
}));

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import {
  candidateKey,
  PlaceEnrichmentService,
  creditLine,
  collectFacts,
  collectHours,
  collectRating,
  nearbyWouldMislead,
} from '../../../src/nest/place-enrichment/place-enrichment.service';
import type { MapsService } from '../../../src/nest/maps/maps.service';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const REQ = { lat: 50.9, lng: 6.96, name: 'Museum Ludwig', placeId: 'ChIJmuseum' };
const OSM_REQ = { ...REQ, placeId: 'way:12345' };

/** Every MapsService seam the service touches, all inert by default. */
function mapsStub(over: Partial<Record<keyof MapsService, unknown>> = {}) {
  return {
    getMapsKey: vi.fn(() => null as string | null),
    photosDisabled: vi.fn(() => false),
    detailsDisabled: vi.fn(() => false),
    fetchGooglePhotoRefs: vi.fn(async () => [] as { name: string; attribution: string | null }[]),
    fetchGooglePhotoBytes: vi.fn(async () => null as Buffer | null),
    fetchCommonsCandidates: vi.fn(async () => [] as any[]),
    fetchEditorialSummary: vi.fn(async () => null as string | null),
    fetchWikiExtract: vi.fn(async () => null as { text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null),
    fetchCommonsCategoryCandidates: vi.fn(async () => [] as any[]),
    fetchWikidataCandidates: vi.fn(async () => ({ candidates: [] as any[], commonsCategory: null as string | null })),
    fetchCommonsFilesByName: vi.fn(async () => new Map<string, any>()),
    fetchWikiLeadImageName: vi.fn(async () => null as string | null),
    resolveOsmIdentity: vi.fn(async () => null as { tags: Record<string, string>; osmUrl: string | null; matchedName: string } | null),
    fetchWikidataSitelinks: vi.fn(async () => ({}) as Record<string, string>),
    fetchWikiExtractFor: vi.fn(async () => null as { text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null),
    details: vi.fn(async () => ({ place: null })),
    ...over,
  } as unknown as MapsService;
}

function cacheStub(over: Record<string, unknown> = {}) {
  return {
    get: vi.fn(() => null as any),
    put: vi.fn(async (key: string, _bytes: Buffer, attribution: string | null) => ({
      photoUrl: `/api/maps/place-photo/${encodeURIComponent(key)}/bytes`,
      filePath: `/tmp/${key}.jpg`,
      attribution,
    })),
    ...over,
  } as unknown as PlacePhotoCacheService;
}

function make(maps: MapsService, cache: PlacePhotoCacheService) {
  return new PlaceEnrichmentService(new DatabaseService(db as never), maps, cache);
}

let candidateSeq = 0;
const commonsCandidate = (over: Record<string, unknown> = {}) => {
  // Distinct by default: the ranker deduplicates by page id and collapses
  // same-stem titles, so fixtures that share either would silently collapse
  // into one and make a test about ordering pass for the wrong reason.
  const n = ++candidateSeq;
  return {
    photoUrl: 'https://commons.org/thumb.jpg',
    attribution: 'Alice',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    pageId: 1000 + n,
    title: `File:Subject ${String.fromCharCode(96 + n)}.jpg`,
    width: 1600,
    height: 1200,
    descriptors: null,
    ...over,
  };
};

beforeEach(() => {
  // Per test, so a fixture's page id is a property of the case rather than of
  // where the case sits in the file.
  candidateSeq = 0;
  mockDbGet.mockReset();
  mockDbGet.mockReturnValue(undefined);
  mockDbRun.mockReset();
  mockSafeFetchFollow.mockReset();
  mockSafeFetchFollow.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  mockTrekPlacesById.mockReset();
  mockTrekPlacesById.mockResolvedValue(null);
});

// ── Kill switch ──────────────────────────────────────────────────────────────

describe('enrichDisabled', () => {
  it('ENRICH-001: is off only when the setting is literally "false"', () => {
    const svc = make(mapsStub(), cacheStub());

    mockDbGet.mockReturnValue(undefined);
    expect(svc.enrichDisabled()).toBe(false); // never configured — fail open

    mockDbGet.mockReturnValue({ value: 'true' });
    expect(svc.enrichDisabled()).toBe(false);

    mockDbGet.mockReturnValue({ value: 'false' });
    expect(svc.enrichDisabled()).toBe(true);
  });

  it('ENRICH-002: answers the disabled envelope without touching a provider', async () => {
    const maps = mapsStub();
    mockDbGet.mockReturnValue({ value: 'false' });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out).toEqual({ photos: [], description: null, facts: [], disabled: true });
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(maps.details).not.toHaveBeenCalled();
  });
});

// ── Photos ───────────────────────────────────────────────────────────────────

describe('collectPhotos', () => {
  it('ENRICH-003: returns Commons candidates with their licence intact', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    // Keyed by which file it is, not by where it landed in the strip.
    const key = candidateKey('ChIJmuseum', 'commons:1001');
    expect(out.photos).toEqual([
      {
        key,
        url: `/api/maps/place-photo/${encodeURIComponent(key)}/bytes`,
        attribution: 'Alice',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
        source: 'wikimedia',
      },
    ]);
  });

  it('ENRICH-004: works without a Google key, which is the normal instance', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => null),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(maps.fetchGooglePhotoRefs).not.toHaveBeenCalled();
  });

  it('ENRICH-005: puts Google pictures ahead of Commons when a key is configured', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoRefs: vi.fn(async () => [{ name: 'places/p/photos/a', attribution: 'Bob' }]),
      fetchGooglePhotoBytes: vi.fn(async () => Buffer.from([1, 2, 3])),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos.map((p) => p.source)).toEqual(['google', 'wikimedia']);
    expect(out.photos[0]).toMatchObject({
      key: candidateKey('ChIJmuseum', 'google:places/p/photos/a'),
      attribution: 'Bob',
      // Google grants no reusable licence — the fields stay empty rather than invented.
      license: null,
      licenseUrl: null,
      sourceUrl: null,
    });
    expect(out.photos[1].key).toBe(candidateKey('ChIJmuseum', 'commons:1001'));
  });

  it('ENRICH-006: respects the existing photos kill switch for the Google half', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      photosDisabled: vi.fn(() => true),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(maps.fetchGooglePhotoRefs).not.toHaveBeenCalled();
    expect(out.photos.map((p) => p.source)).toEqual(['wikimedia']);
  });

  it('ENRICH-007: never asks Google about an OSM place', async () => {
    const maps = mapsStub({ getMapsKey: vi.fn(() => 'key') });

    await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchGooglePhotoRefs).not.toHaveBeenCalled();
  });

  it('ENRICH-008: reuses a cached candidate instead of downloading it again', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    const cache = cacheStub({
      get: vi.fn(() => ({ photoUrl: '/api/maps/place-photo/ChIJmuseum~p0/bytes', filePath: '/tmp/x', attribution: 'Alice' })),
    });

    const out = await make(maps, cache).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(mockSafeFetchFollow).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('ENRICH-009: skips a candidate whose bytes will not download', async () => {
    const maps = mapsStub({
      fetchCommonsCandidates: vi.fn(async () => [
        commonsCandidate({ photoUrl: 'https://commons.org/gone.jpg', attribution: 'Alice' }),
        commonsCandidate({ attribution: 'Bob' }),
      ]),
    });
    mockSafeFetchFollow
      .mockResolvedValueOnce({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    // The survivor keeps its own key. That used to depend on the failed
    // picture leaving a numbered gap behind it; now the key is derived from
    // which file it is, so nothing in front of it can shift it.
    expect(out.photos).toHaveLength(1);
    expect(out.photos[0].key).toBe(candidateKey('ChIJmuseum', 'commons:1002'));
  });

  it('ENRICH-010: treats an empty body and a throwing download as a miss', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });

    mockSafeFetchFollow.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    expect((await make(maps, cacheStub()).enrich(1, REQ)).photos).toEqual([]);

    mockSafeFetchFollow.mockRejectedValue(new Error('network'));
    expect((await make(maps, cacheStub()).enrich(1, REQ)).photos).toEqual([]);
  });

  it('ENRICH-011: drops a candidate the cache refuses to store', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    const cache = cacheStub({ put: vi.fn(async () => { throw new Error('disk full'); }) });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await make(maps, cache).enrich(1, REQ);

    expect(out.photos).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('ENRICH-012: asks each source only for as many pictures as it may contribute', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoBytes: vi.fn(async () => Buffer.from([1])),
    });

    await make(maps, cacheStub()).enrich(1, REQ);

    expect(maps.fetchGooglePhotoRefs).toHaveBeenCalledWith('ChIJmuseum', 'key', 3);
    expect(maps.fetchCommonsCandidates).toHaveBeenCalledWith(REQ.lat, REQ.lng, 5);
  });

  it('ENRICH-012b: skips a Google reference whose media download comes back empty', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoRefs: vi.fn(async () => [
        { name: 'places/p/photos/gone', attribution: 'Bob' },
        { name: 'places/p/photos/ok', attribution: 'Cara' },
      ]),
      fetchGooglePhotoBytes: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(Buffer.from([1, 2, 3])),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(out.photos[0]).toMatchObject({
      key: candidateKey('ChIJmuseum', 'google:places/p/photos/ok'),
      attribution: 'Cara',
    });
  });

  it('ENRICH-012c: downloads the pictures concurrently, not one after another', async () => {
    // Five sequential round trips plus five decodes pushed the request past the
    // client's timeout, which is what made the column show an error every time.
    let active = 0;
    let peak = 0;
    const maps = mapsStub({
      fetchCommonsCandidates: vi.fn(async () =>
        ['Alice', 'Bob', 'Cara'].map((attribution) => commonsCandidate({ attribution })),
      ),
    });
    mockSafeFetchFollow.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('ENRICH-012d: asks both providers at the same time', async () => {
    const order: string[] = [];
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoRefs: vi.fn(async () => {
        order.push('google:start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('google:end');
        return [];
      }),
      fetchCommonsCandidates: vi.fn(async () => {
        order.push('commons:start');
        return [];
      }),
    });

    await make(maps, cacheStub()).enrich(1, REQ);

    // Commons starts before Google finishes; the listings do not queue.
    expect(order.indexOf('commons:start')).toBeLessThan(order.indexOf('google:end'));
  });

  it('ENRICH-013: falls back to a coordinate pseudo-id when the place has none', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });

    const out = await make(maps, cacheStub()).enrich(1, { lat: 50.9, lng: 6.96, name: 'Bench' });

    expect(out.photos[0].key).toBe(candidateKey('coords:50.9:6.96', 'commons:1001'));
    expect(maps.fetchGooglePhotoRefs).not.toHaveBeenCalled();
  });
});

// ── Description ──────────────────────────────────────────────────────────────

describe('collectDescription', () => {
  it('ENRICH-014: prefers the OpenStreetMap description, which costs nothing', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({
        place: { summary: '  Ein Museum in Köln.  ', source: 'openstreetmap', osm_url: 'https://osm.org/way/1' },
      })),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(out.description).toEqual({
      text: 'Ein Museum in Köln.',
      source: 'osm',
      sourceUrl: 'https://osm.org/way/1',
      license: 'ODbL 1.0',
    });
    expect(maps.fetchEditorialSummary).not.toHaveBeenCalled();
    expect(maps.fetchWikiExtract).not.toHaveBeenCalled();
  });

  it('ENRICH-014b: leaves the OSM link empty when the details carry no osm_url', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { summary: 'Ein Museum.', source: 'openstreetmap' } })),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(out.description).toEqual({ text: 'Ein Museum.', source: 'osm', sourceUrl: null, license: 'ODbL 1.0' });
  });

  it('ENRICH-015: ignores a summary that came from Google on the OSM branch', async () => {
    // getPlaceDetails returns `summary` for Google places too; only the OSM one
    // is a mapper-written description we may label as such.
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { summary: 'Google blurb', source: 'google' } })),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.description).toBeNull();
  });

  it('ENRICH-016: uses Googles editorial summary when there is no OSM text', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: { google_maps_url: 'https://maps.google.com/x' } })),
      fetchEditorialSummary: vi.fn(async () => 'A museum in Cologne.'),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.description).toEqual({
      text: 'A museum in Cologne.',
      source: 'google',
      sourceUrl: 'https://maps.google.com/x',
      license: null,
    });
  });

  it('ENRICH-016b: leaves the source link empty when the details carry no Maps URL', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      details: vi.fn(async () => ({ place: null })),
      fetchEditorialSummary: vi.fn(async () => 'A museum in Cologne.'),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.description).toMatchObject({ source: 'google', sourceUrl: null });
  });

  it('ENRICH-018b: ignores a non-string wikipedia tag rather than passing it on', async () => {
    // Provider blobs are open records — a numeric or object tag must not reach
    // the wiki lookup as-is.
    const maps = mapsStub({ details: vi.fn(async () => ({ place: { wikipedia: 42 } })) });

    await make(maps, cacheStub()).enrich(1, OSM_REQ);

    // Not a usable tag, so it counts as no identity at all: the lookup that
    // finds one is tried instead, and the wiki itself is never asked.
    expect(maps.resolveOsmIdentity).toHaveBeenCalled();
    expect(maps.fetchWikiExtract).not.toHaveBeenCalled();
  });

  it('ENRICH-017: honours the details kill switch and the missing key', async () => {
    const disabled = mapsStub({ getMapsKey: vi.fn(() => 'key'), detailsDisabled: vi.fn(() => true) });
    await make(disabled, cacheStub()).enrich(1, REQ);
    expect(disabled.fetchEditorialSummary).not.toHaveBeenCalled();

    const keyless = mapsStub({ getMapsKey: vi.fn(() => null) });
    await make(keyless, cacheStub()).enrich(1, REQ);
    expect(keyless.fetchEditorialSummary).not.toHaveBeenCalled();
  });

  it('ENRICH-018: falls back to Wikipedia, resolved from the wiki tag', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { wikipedia: 'de:Museum Ludwig' } })),
      fetchWikiExtract: vi.fn(async () => ({
        text: 'Das Museum Ludwig ist ein Museum.',
        sourceUrl: 'https://de.wikipedia.org/wiki/Museum%20Ludwig',
        source: 'wikipedia' as const,
      })),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchWikiExtract).toHaveBeenCalledWith('de:Museum Ludwig');
    expect(out.description).toEqual({
      text: 'Das Museum Ludwig ist ein Museum.',
      source: 'wikipedia',
      sourceUrl: 'https://de.wikipedia.org/wiki/Museum%20Ludwig',
      license: 'CC BY-SA 4.0',
    });
  });

  it('ENRICH-019: looks the place up when it carries no wiki tag, and gives up quietly when that finds nothing', async () => {
    // The kiosk case. A place with no tag and no OSM match genuinely has no
    // description, and inventing one from a name search is how you confidently
    // describe a different building.
    const maps = mapsStub({ details: vi.fn(async () => ({ place: { name: 'Kiosk' } })) });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.resolveOsmIdentity).toHaveBeenCalledWith('Museum Ludwig', 50.9, 6.96, { lang: undefined });
    expect(maps.fetchWikiExtract).not.toHaveBeenCalled();
    expect(out.description).toBeNull();
  });

  it('ENRICH-020: survives a details lookup that throws', async () => {
    const maps = mapsStub({ details: vi.fn(async () => { throw new Error('overpass down'); }) });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(out.description).toBeNull();
    expect(out.photos).toEqual([]);
  });
});

// ── Result cache ─────────────────────────────────────────────────────────────

describe('result cache', () => {
  // v is the cache format version; an entry written before a release that
  // changes the shape or the sources is discarded rather than served.
  const cachedRow = (photos: unknown[], fetchedAt = Date.now(), v: number | undefined = 4) => ({
    payload_json: JSON.stringify({ photos, description: null, facts: [], v }),
    fetched_at: fetchedAt,
  });

  it('ENRICH-021: serves a fresh entry without calling any provider', async () => {
    const maps = mapsStub();
    const cache = cacheStub({ get: vi.fn(() => ({ photoUrl: '/x', filePath: '/tmp/x', attribution: null })) });
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache')
        ? cachedRow([{ key: 'ChIJmuseum~p0', url: '/x', attribution: null, license: null, licenseUrl: null, sourceUrl: null, source: 'wikimedia' }])
        : undefined,
    );

    const out = await make(maps, cache).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
  });

  it('ENRICH-022: refetches once the entry is older than a week', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache') ? cachedRow([], eightDaysAgo) : undefined,
    );

    await make(maps, cacheStub()).enrich(1, REQ);

    expect(maps.fetchCommonsCandidates).toHaveBeenCalled();
  });

  it('ENRICH-023: rebuilds when the nightly sweep removed a cached candidate', async () => {
    // The sweep deletes every picture nobody picked, so this is the normal state
    // of a cached entry the morning after. Serving the survivors would leave the
    // column empty for the rest of the week for a place that has pictures.
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    let onDisk = false;
    const cache = cacheStub({
      get: vi.fn(() => (onDisk ? { photoUrl: '/x', filePath: '/tmp/x', attribution: null } : null)),
      put: vi.fn(async (key: string) => {
        onDisk = true;
        return { photoUrl: `/api/maps/place-photo/${key}/bytes`, filePath: '/tmp/x', attribution: null };
      }),
    });
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache')
        ? cachedRow([{ key: 'ChIJmuseum~p0', url: '/x', attribution: null, license: null, licenseUrl: null, sourceUrl: null, source: 'wikimedia' }])
        : undefined,
    );

    const out = await make(maps, cache).enrich(1, REQ);

    expect(maps.fetchCommonsCandidates).toHaveBeenCalled();
    expect(out.photos).toHaveLength(1);
  });

  it('ENRICH-023b: keeps serving a cached entry while all its bytes are still there', async () => {
    const maps = mapsStub();
    const cache = cacheStub({ get: vi.fn(() => ({ photoUrl: '/x', filePath: '/tmp/x', attribution: null })) });
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache')
        ? cachedRow([{ key: 'ChIJmuseum~p0', url: '/x', attribution: null, license: null, licenseUrl: null, sourceUrl: null, source: 'wikimedia' }])
        : undefined,
    );

    const out = await make(maps, cache).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
  });

  it('ENRICH-023c: discards an entry written by an older format version', async () => {
    // Otherwise a release that adds a field keeps serving last week's answers.
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache') ? cachedRow([], Date.now(), 1) : undefined,
    );

    await make(maps, cacheStub()).enrich(1, REQ);

    expect(maps.fetchCommonsCandidates).toHaveBeenCalled();
  });

  it('ENRICH-024: ignores an unreadable cache row and rebuilds', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    mockDbGet.mockImplementation((sql: string) =>
      String(sql).includes('place_details_cache') ? { payload_json: '{not json', fetched_at: Date.now() } : undefined,
    );

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
  });

  it('ENRICH-025: stores the result under its own cache kind and language', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });

    await make(maps, cacheStub()).enrich(1, { ...REQ, lang: 'de' });

    const write = mockDbRun.mock.calls.find((c) => String(c[0]).includes('INSERT OR REPLACE INTO place_details_cache'));
    expect(write).toBeDefined();
    expect(write![1]).toBe('ChIJmuseum');
    expect(write![2]).toBe('de');
    // expanded = 2 — the plain (0) and reviews (1) caches keep their rows.
    expect(write![3]).toBe(2);
  });

  it('ENRICH-026: keeps working when the cache write fails', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    mockDbRun.mockImplementation(() => { throw new Error('db locked'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── Credit line ──────────────────────────────────────────────────────────────

describe('creditLine', () => {
  it('ENRICH-027: joins author and licence into the one text column the cache has', () => {
    expect(creditLine('Alice', 'CC BY-SA 4.0')).toBe('Alice · CC BY-SA 4.0');
    expect(creditLine('Alice', null)).toBe('Alice');
    expect(creditLine(null, 'CC BY-SA 4.0')).toBe('CC BY-SA 4.0');
    expect(creditLine(null, null)).toBeNull();
  });

  it('ENRICH-028: stores the joined credit alongside a Commons picture', async () => {
    const maps = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]) });
    const cache = cacheStub();

    await make(maps, cache).enrich(1, REQ);

    expect(cache.put).toHaveBeenCalledWith(
      candidateKey('ChIJmuseum', 'commons:1001'),
      expect.any(Buffer),
      'Alice · CC BY-SA 4.0',
    );
  });

  it('ENRICH-029: reads a stored credit back by cache key', async () => {
    const cache = cacheStub({
      get: vi.fn((key: string) =>
        key === 'ChIJmuseum~p0' ? { photoUrl: '/x', attribution: 'Alice · CC BY-SA 4.0' } : null,
      ),
    });
    const svc = make(mapsStub(), cache);

    expect(await svc.credit('ChIJmuseum~p0')).toEqual({ credit: 'Alice · CC BY-SA 4.0' });
    // An uploaded image or a key that was swept has nothing to name.
    expect(await svc.credit('unknown')).toEqual({ credit: null });
  });
});

// ── OpenStreetMap facts (ENRICH-050..) ───────────────────────────────────────

describe('collectFacts', () => {
  const osm = (tags: Record<string, unknown>) => ({ source: 'openstreetmap', ...tags });

  it('ENRICH-050: turns the tags a restaurant actually carries into chips', () => {
    const facts = collectFacts(
      osm({
        cuisine: 'regional;german',
        opening_hours: ['Mo-Sa 17:30+'],
        menu_url: 'https://example.org/menu',
        outdoor_seating: 'yes',
        wheelchair: 'limited',
      }),
    );

    expect(facts).toEqual([
      // No hours chip: a week of opening times is its own block now, because
      // seven lines joined with dots truncated to nothing in a 288px column.
      // Semicolons and underscores are OSM syntax, not something to show a reader.
      { kind: 'cuisine', value: 'regional, german', url: null },
      { kind: 'menu', value: null, url: 'https://example.org/menu' },
      { kind: 'outdoorSeating', value: null, url: null },
      { kind: 'wheelchair', value: 'limited', url: null },
    ]);
  });

  it('ENRICH-051: lists only positive facts', () => {
    // "No outdoor seating" is noise, and a missing tag reads the same to a user.
    const facts = collectFacts(
      osm({ outdoor_seating: 'no', takeaway: 'no', wheelchair: 'no', internet_access: 'no', diet_vegan: 'no' }),
    );
    expect(facts).toEqual([]);
  });

  it('ENRICH-052: accepts the "only" spelling for diets', () => {
    const kinds = collectFacts(osm({ diet_vegetarian: 'only', diet_vegan: 'yes' })).map((f) => f.kind);
    expect(kinds).toEqual(['vegetarian', 'vegan']);
  });

  it('ENRICH-052b: covers the remaining yes-tags and a non-string osm_url', () => {
    const facts = collectFacts(osm({ takeaway: 'yes', delivery: 'yes', internet_access: 'wlan', wheelchair: 'yes' }));
    expect(facts.map((f) => f.kind)).toEqual(['takeaway', 'delivery', 'wheelchair', 'internetAccess']);
    // Any internet_access value other than "no" counts as available.
    expect(facts.find((f) => f.kind === 'internetAccess')).toEqual({ kind: 'internetAccess', value: null, url: null });
  });

  it('ENRICH-052c: drops a menu_url that is not http(s)', () => {
    // Anyone can edit the OSM tag and the client turns it into an href.
    for (const menu_url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://host/menu', '']) {
      expect(collectFacts(osm({ menu_url })).map((f) => f.kind)).toEqual([]);
    }
  });

  it('ENRICH-052d: keeps an http menu_url and trims the surrounding whitespace', () => {
    expect(collectFacts(osm({ menu_url: '  http://example.org/menu  ' }))).toEqual([
      { kind: 'menu', value: null, url: 'http://example.org/menu' },
    ]);
  });

  it('ENRICH-053: takes no chips at all from a Google place', () => {
    expect(collectFacts(null)).toEqual([]);
    // cuisine/outdoor_seating are OSM tagging and never appear on a Google blob;
    // rating and hours are fields of their own.
    expect(collectFacts({ source: 'google', cuisine: 'italian', outdoor_seating: 'yes' })).toEqual([]);
    expect(
      collectFacts({ source: 'google', rating: 4.5, rating_count: 1234, opening_hours: ['Mo-Fr 09:00-18:00'] }),
    ).toEqual([]);
  });

  it('ENRICH-053b: reads the rating as a number and a count, not as a sentence', () => {
    expect(collectRating({ source: 'google', rating: 4.5, rating_count: 1234 })).toEqual({ value: 4.5, count: 1234 });
    // Google's search results carry a rating but never a count.
    expect(collectRating({ source: 'google', rating: 4 })).toEqual({ value: 4, count: null });
    expect(collectRating({ source: 'google' })).toBeNull();
    expect(collectRating(null)).toBeNull();
  });

  it('ENRICH-054: hands the week over whole, with the periods that go with it', () => {
    // The lines are localised display text and the periods are what "open now"
    // is computed from — neither substitutes for the other.
    const periods = [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } }];
    expect(
      collectHours(osm({ opening_hours: ['Mo-Fr 09:00-18:00', 'Sa 10:00-14:00'], opening_periods: periods })),
    ).toEqual({
      weekdayDescriptions: ['Mo-Fr 09:00-18:00', 'Sa 10:00-14:00'],
      periods,
      // buildOsmDetails never sets this; only Google reports special days.
      specialDays: null,
    });
    expect(collectHours(osm({}))).toBeNull();
    expect(collectHours(null)).toBeNull();
  });
});

describe('picture source selection', () => {
  it('ENRICH-055: prefers the Commons category over the coordinate search', async () => {
    // geosearch around a city centre returns statues and passers-by; the
    // category of a place returns the place.
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikimedia_commons: 'Category:Museum Ludwig' } })),
      fetchCommonsCategoryCandidates: vi.fn(async () =>
        ['Alice', 'Bob'].map((attribution) => commonsCandidate({ attribution })),
      ),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchCommonsCategoryCandidates).toHaveBeenCalledWith('Category:Museum Ludwig', 5);
    // Two pictures of the place is a strip; the coordinate search is not asked.
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(out.photos).toHaveLength(2);
  });

  it('ENRICH-056: falls back to the coordinate search when the category is empty', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikimedia_commons: 'Category:Empty' } })),
      fetchCommonsCategoryCandidates: vi.fn(async () => []),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchCommonsCandidates).toHaveBeenCalled();
    expect(out.photos).toHaveLength(1);
  });

  it('ENRICH-057: reports Wikivoyage as the description source when it answered', async () => {
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', wikipedia: 'de:Berlin' } })),
      fetchWikiExtract: vi.fn(async () => ({
        text: 'Berlin ist das politische Zentrum Deutschlands.',
        sourceUrl: 'https://de.wikivoyage.org/wiki/Berlin',
        source: 'wikivoyage' as const,
      })),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(out.description).toMatchObject({ source: 'wikivoyage', license: 'CC BY-SA 4.0' });
  });
});

/**
 * ENRICH-060..069 — the source ladder.
 *
 * The picker used to show aerial survey tiles for Hamburg Airport and the
 * underground station for the Brandenburg Gate, because the only rung that ever
 * ran was "photographed within 300m". These cases pin the order it climbs and
 * when it is allowed to fall back that far.
 */
describe('picture source ladder', () => {
  const withTags = (tags: Record<string, unknown>) =>
    vi.fn(async () => ({ place: { source: 'openstreetmap', ...tags } }));

  it('ENRICH-060: asks Wikidata first when the place carries a wikidata tag', async () => {
    const maps = mapsStub({
      details: withTags({ wikidata: 'Q1097' }),
      fetchWikidataCandidates: vi.fn(async () => ({
        candidates: ['Alice', 'Bob', 'Cara', 'Dana', 'Erin'].map((attribution) => commonsCandidate({ attribution })),
        commonsCategory: 'Berlin Hauptbahnhof',
      })),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchWikidataCandidates).toHaveBeenCalledWith('Q1097', 5);
    // A full strip of pictures somebody attached to this exact object — no rung
    // below it is asked, least of all the coordinate search.
    expect(maps.fetchCommonsCategoryCandidates).not.toHaveBeenCalled();
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(out.photos).toHaveLength(5);
  });

  it('ENRICH-061: takes the Commons category Wikidata names when the tag omits it', async () => {
    // Berlin Hauptbahnhof carries wikidata but no wikimedia_commons in OSM; the
    // item's P373 knows the category anyway.
    const maps = mapsStub({
      details: withTags({ wikidata: 'Q1097' }),
      fetchWikidataCandidates: vi.fn(async () => ({
        candidates: [commonsCandidate()],
        commonsCategory: 'Berlin Hauptbahnhof',
      })),
      fetchCommonsCategoryCandidates: vi.fn(async () => [commonsCandidate({ attribution: 'Bob' })]),
    });

    await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchCommonsCategoryCandidates).toHaveBeenCalledWith('Berlin Hauptbahnhof', 5);
  });

  it('ENRICH-062: reaches for the article lead image when there is no wikidata tag', async () => {
    const maps = mapsStub({
      details: withTags({ wikipedia: 'de:Flughafen Hamburg' }),
      fetchWikiLeadImageName: vi.fn(async () => 'Hamburg airport terminals.jpg'),
      fetchCommonsFilesByName: vi.fn(async () =>
        new Map([['hamburg airport terminals.jpg', commonsCandidate({ attribution: 'Alice' })]]),
      ),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchWikiLeadImageName).toHaveBeenCalledWith('de:Flughafen Hamburg');
    expect(maps.fetchCommonsFilesByName).toHaveBeenCalledWith(['Hamburg airport terminals.jpg']);
    // Reported as a Wikipedia picture, because that is where it was chosen.
    expect(out.photos[0].source).toBe('wikipedia');
  });

  it('ENRICH-063: only falls back to what was photographed nearby when the rest came up thin', async () => {
    const maps = mapsStub({
      details: withTags({ wikidata: 'Q1097' }),
      fetchWikidataCandidates: vi.fn(async () => ({ candidates: [commonsCandidate()], commonsCategory: null })),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate({ attribution: 'Bob' })]),
    });

    await make(maps, cacheStub()).enrich(1, OSM_REQ);

    // One curated picture is not a strip, so the coordinate search tops it up.
    expect(maps.fetchCommonsCandidates).toHaveBeenCalled();
  });

  it('ENRICH-064: does not run the coordinate search behind a full Google strip', async () => {
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoRefs: vi.fn(async () => [
        { name: 'places/p/photos/a', attribution: 'Bob' },
        { name: 'places/p/photos/b', attribution: 'Cara' },
        { name: 'places/p/photos/c', attribution: 'Dana' },
      ]),
      fetchGooglePhotoBytes: vi.fn(async () => Buffer.from([1, 2, 3])),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toHaveLength(3);
    expect(out.photos.every((p) => p.source === 'google')).toBe(true);
  });

  it('ENRICH-065: keeps the coordinate search off the critical path of Google\'s listing', async () => {
    // Waiting for the listing before deciding put two round trips end to end,
    // which is what pushed this endpoint past the client timeout once before.
    const order: string[] = [];
    const maps = mapsStub({
      getMapsKey: vi.fn(() => 'key'),
      fetchGooglePhotoRefs: vi.fn(async () => {
        order.push('google:start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('google:end');
        return [];
      }),
      fetchCommonsCandidates: vi.fn(async () => {
        order.push('commons:start');
        return [];
      }),
    });

    await make(maps, cacheStub()).enrich(1, REQ);

    expect(order.indexOf('commons:start')).toBeLessThan(order.indexOf('google:end'));
  });

  it('ENRICH-066: drops a picture that two rungs both produced', async () => {
    const shared = commonsCandidate({ pageId: 4242, attribution: 'Alice' });
    const maps = mapsStub({
      details: withTags({ wikidata: 'Q1097', wikimedia_commons: 'Category:X' }),
      fetchWikidataCandidates: vi.fn(async () => ({ candidates: [shared], commonsCategory: null })),
      fetchCommonsCategoryCandidates: vi.fn(async () => [{ ...shared, photoUrl: 'https://commons.org/other-url.jpg' }]),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    // Same page id, different thumbnail url — the url alone would let it through.
    expect(out.photos).toHaveLength(1);
  });

  it('ENRICH-067: throws away the survey tiles a geosearch around an airport returns', async () => {
    const maps = mapsStub({
      fetchCommonsCandidates: vi.fn(async () =>
        [2013, 2015, 2016, 2019].map((year) =>
          commonsCandidate({
            title: `File:Dop20rgb 32565 5943 ${year}.jpg`,
            attribution: 'Landesbetrieb Geoinformation Hamburg',
            width: 5000,
            height: 5000,
            descriptors: 'Orthophoto Sommerbefliegung',
          }),
        ),
      ),
    });

    const out = await make(maps, cacheStub()).enrich(1, REQ);

    expect(out.photos).toEqual([]);
  });

  it('ENRICH-068: keys a picture by which file it is, not by where it sat', async () => {
    // The strip length changes with which providers answered. Keyed by position,
    // a slot that held a Wikidata photo one minute held a category photo the
    // next while the cache kept serving the first one's bytes — under CC BY
    // that credits the wrong person, not just the wrong thumbnail.
    const one = mapsStub({ fetchCommonsCandidates: vi.fn(async () => [commonsCandidate({ pageId: 777 })]) });
    const first = (await make(one, cacheStub()).enrich(1, REQ)).photos[0].key;

    const two = mapsStub({
      fetchCommonsCandidates: vi.fn(async () => [
        commonsCandidate({ pageId: 111, attribution: 'Zoe' }),
        commonsCandidate({ pageId: 777 }),
      ]),
    });
    const shifted = (await make(two, cacheStub()).enrich(1, REQ)).photos.find((p) => p.attribution === 'Alice');

    expect(shifted?.key).toBe(first);
  });
});

/**
 * ENRICH-110..116 — the categories cut off from the nearby fallback.
 *
 * The bottom rung is "anything photographed within 300m", and for an ordinary
 * business that is the building opposite. Two percent of them have a picture on
 * Commons against seventy percent of churches, so for a cafe the curated rungs
 * practically never fire and the fallback practically always does — which is
 * how a doner shop ended up illustrated with the town hall across the square.
 */
describe('nearby pictures that would mislead', () => {
  const GERS_REQ = { ...REQ, placeId: 'gers:abc-123' };

  // What the TREK index reports for a place: one `category` string.
  const indexPlace = (category: string) =>
    mapsStub({
      details: vi.fn(async () => ({ place: { source: 'trek-places', category } })),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

  it('ENRICH-110: a business is cut off, whichever field names its trade', () => {
    // Overture reports `category`; the OSM tags the identity lookup brings back
    // report `amenity`, `shop` or `cuisine`. `category_path` is the name the
    // API gives the field — the guard reads it, though toPlaceRecord drops it
    // before a details record is ever shaped.
    expect(nearbyWouldMislead({ category: 'pizza_restaurant' })).toBe(true);
    expect(nearbyWouldMislead({ category_path: 'eat_and_drink>cafe' })).toBe(true);
    expect(nearbyWouldMislead({ amenity: 'fast_food' })).toBe(true);
    expect(nearbyWouldMislead({ shop: 'bakery' })).toBe(true);
    expect(nearbyWouldMislead({ cuisine: 'coffee_shop' })).toBe(true);
  });

  it('ENRICH-111: a monument is not, which is the case the fallback exists for', () => {
    // At 300m from a castle or a church, what was photographed is the castle.
    expect(nearbyWouldMislead({ category: 'landmark_and_historical_building' })).toBe(false);
    expect(nearbyWouldMislead({ category: 'castle' })).toBe(false);
    expect(nearbyWouldMislead({ category: 'museum' })).toBe(false);
    expect(nearbyWouldMislead({ amenity: 'place_of_worship' })).toBe(false);
  });

  it('ENRICH-112: fails open when nothing says what the place is', () => {
    // Unlabelled is not the same as harmless, but there is no telling a
    // cathedral from a kebab shop without a category, and cutting off
    // everything unlabelled would take the fallback from the places it works
    // for. The name is not a category either: "Cafe Central" may well be a
    // listed building.
    expect(nearbyWouldMislead(null)).toBe(false);
    expect(nearbyWouldMislead({})).toBe(false);
    expect(nearbyWouldMislead({ name: 'Cafe Central', category: null })).toBe(false);
  });

  it('ENRICH-113: never asks the coordinate search about a cafe', async () => {
    const maps = indexPlace('coffee_shop');

    const out = await make(maps, cacheStub()).enrich(1, GERS_REQ);

    // Skipped outright rather than fetched and then filtered: the request is
    // the whole cost, and there is nothing in the answer worth looking at.
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(out.photos).toEqual([]);
  });

  it('ENRICH-114: still asks it for a place the fallback was built for', async () => {
    const maps = indexPlace('landmark_and_historical_building');

    const out = await make(maps, cacheStub()).enrich(1, GERS_REQ);

    expect(maps.fetchCommonsCandidates).toHaveBeenCalledWith(REQ.lat, REQ.lng, 5);
    expect(out.photos).toHaveLength(1);
  });

  it('ENRICH-115: reads the OSM tags too, which is where a takeaway says so', async () => {
    // buildOsmDetails carries cuisine but neither amenity nor shop, so for an
    // OSM place — cuisine=kebab, amenity=fast_food — only the tags the identity
    // lookup brought back name the trade.
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'openstreetmap', cuisine: 'kebab' } })),
      resolveOsmIdentity: vi.fn(async () => ({
        tags: { amenity: 'fast_food', cuisine: 'kebab' },
        osmUrl: null,
        matchedName: 'Döner Rostock',
      })),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate()]),
    });

    const out = await make(maps, cacheStub()).enrich(1, OSM_REQ);

    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(out.photos).toEqual([]);
  });

  it('ENRICH-116: cuts only the bottom rung, not the curated ones above it', async () => {
    // A cafe somebody tagged in OpenStreetMap still has pictures attached to
    // that exact object. One of them is below the bar of two that normally lets
    // the coordinate search top the strip up — being a cafe is what stops it.
    // The item comes from the OSM tag and not from the index record, whose
    // `wikidata` holds the chain's item rather than this branch's.
    const maps = mapsStub({
      details: vi.fn(async () => ({ place: { source: 'trek-places', category: 'cafe' } })),
      resolveOsmIdentity: vi.fn(async () => ({
        tags: { wikidata: 'Q1' },
        osmUrl: null,
        matchedName: 'Café Central',
      })),
      fetchWikidataCandidates: vi.fn(async () => ({ candidates: [commonsCandidate()], commonsCategory: null })),
      fetchCommonsCandidates: vi.fn(async () => [commonsCandidate({ attribution: 'Bob' })]),
    });

    const out = await make(maps, cacheStub()).enrich(1, GERS_REQ);

    expect(maps.fetchWikidataCandidates).toHaveBeenCalledWith('Q1', 5);
    expect(maps.fetchCommonsCandidates).not.toHaveBeenCalled();
    expect(out.photos).toHaveLength(1);
  });
});
