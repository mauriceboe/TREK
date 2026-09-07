/**
 * Unit tests for the Amap (高德) places provider and the provider selection it
 * plugs into — AMAP-001 onwards.
 *
 * What these are really about is the two things that make Amap different from
 * Google and that no amount of care at the call site can fix: the datum (GCJ-02
 * in, WGS-84 out, in BOTH directions) and the fact that Amap reports failure in
 * a 200 response body. Everything else is field mapping, which is checked
 * against the shapes Amap actually sends — including `address: []` for a missing
 * string, which is the one that bites.
 *
 * fetch is stubbed; the SSRF guard and the database are mocked, the same way
 * maps.service.test.ts does it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared';

const { mockDbGet, mockDbRun, mockInstanceGet, mockProviderGet } = vi.hoisted(() => ({
  mockDbGet: vi.fn((..._args: unknown[]) => undefined as any),
  mockDbRun: vi.fn(),
  mockInstanceGet: vi.fn((..._args: unknown[]) => undefined as any),
  mockProviderGet: vi.fn((..._args: unknown[]) => undefined as any),
}));

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (!sql.includes('app_settings')) return mockDbGet(...args);
        return args[0] === 'places_provider' ? mockProviderGet(...args) : mockInstanceGet(...args);
      },
      all: vi.fn(() => []),
      run: mockDbRun,
    }),
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => {
  class SsrfBlockedError extends Error {}
  return {
    SsrfBlockedError,
    checkSsrf: vi.fn(async () => ({ allowed: true })),
    safeFetchFollow: vi.fn(async (url: string, init?: any) => (globalThis.fetch as any)(url, init)),
  };
});

vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string | null) => v,
}));

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { MapsService } from '../../../src/nest/maps/maps.service';
import {
  AmapPlacesProvider,
  amapPoiId,
  isAmapHost,
  isAmapPlaceId,
  parseAmapUrl,
} from '../../../src/nest/maps/providers/amap.provider';
import { GooglePlacesProvider } from '../../../src/nest/maps/providers/google.provider';
import { isGooglePlaceId } from '../../../src/nest/maps/maps.helpers';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';

const photoCacheStub = {
  get: vi.fn(() => null),
  getErrored: vi.fn(() => false),
  put: vi.fn(),
  markError: vi.fn(),
  getInFlight: vi.fn(() => undefined),
  setInFlight: vi.fn(),
  serveKey: vi.fn(() => null),
} as unknown as PlacePhotoCacheService;

const svc = new MapsService(new DatabaseService(db as never), photoCacheStub);

/** A provider over a fixed key, which is all these cases need. */
function provider(): AmapPlacesProvider {
  return new AmapPlacesProvider({ key: 'amap-test-key', source: 'instance', userId: 3 });
}

/** Amap's success envelope. */
function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ status: '1', info: 'OK', infocode: '10000', ...body }) };
}

/** Amap's failure envelope — note the HTTP 200. */
function amapError(infocode: string, info = 'SOMETHING_WRONG') {
  return { ok: true, status: 200, json: async () => ({ status: '0', info, infocode }) };
}

/** The URL the single stubbed call was made with. */
function calledUrl(): string {
  return String((globalThis.fetch as any).mock.calls[0][0]);
}

/** One POI in Beijing, at a GCJ-02 coordinate. */
const TIANANMEN_GCJ = wgs84ToGcj02(39.90869, 116.39124);
const TIANANMEN_LOCATION = `${TIANANMEN_GCJ.lng.toFixed(6)},${TIANANMEN_GCJ.lat.toFixed(6)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  mockDbGet.mockReset();
  mockDbGet.mockReturnValue(undefined);
  mockDbRun.mockReset();
  mockInstanceGet.mockReset();
  mockInstanceGet.mockReturnValue(undefined);
  mockProviderGet.mockReset();
  mockProviderGet.mockReturnValue(undefined);
});

// ── Place id namespace ───────────────────────────────────────────────────────

describe('Amap place ids', () => {
  it('AMAP-001: namespaces an Amap id so it can never be sent to Google', () => {
    expect(isAmapPlaceId('amap:B000A83M61')).toBe(true);
    expect(amapPoiId('amap:B000A83M61')).toBe('B000A83M61');
    // The whole point: Google's own id check must reject it, because Google
    // answers a foreign id with a BILLABLE 400 INVALID_ARGUMENT.
    expect(isGooglePlaceId('amap:B000A83M61')).toBe(false);
    // And a bare Amap id, which is what we would have had without the prefix,
    // is indistinguishable from a Google one — hence the prefix.
    expect(isGooglePlaceId('B000A83M61')).toBe(true);
  });

  it('AMAP-002: is not confused with an OSM id or a coordinate pseudo-id', () => {
    expect(isAmapPlaceId('node:240109189')).toBe(false);
    expect(isAmapPlaceId('coords:39.9,116.4')).toBe(false);
    expect(isAmapPlaceId('ChIJ_____')).toBe(false);
  });
});

// ── searchText ───────────────────────────────────────────────────────────────

describe('AmapPlacesProvider.searchText', () => {
  it('AMAP-010: converts the returned GCJ-02 coordinate back to WGS-84', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          pois: [
            {
              id: 'B000A83M61',
              name: '天安门',
              address: '东长安街',
              location: TIANANMEN_LOCATION,
              pname: '北京市',
              cityname: '北京市',
              adname: '东城区',
              type: '风景名胜;风景名胜相关;旅游景点',
            },
          ],
        }),
      ),
    );

    const [place] = await provider().searchText('天安门');

    // Back within a metre of where it started, i.e. the datum round-tripped.
    expect(place.lat as number).toBeCloseTo(39.90869, 4);
    expect(place.lng as number).toBeCloseTo(116.39124, 4);
    expect(place.amap_poi_id).toBe('amap:B000A83M61');
    expect(place.source).toBe('amap');
    expect(place.types).toEqual(['风景名胜', '风景名胜相关', '旅游景点']);
  });

  it('AMAP-011: assembles a full address without repeating a municipality', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          pois: [
            {
              id: 'B1',
              name: '故宫',
              address: '景山前街4号',
              location: TIANANMEN_LOCATION,
              pname: '北京市',
              cityname: '北京市',
              adname: '东城区',
            },
          ],
        }),
      ),
    );
    const [place] = await provider().searchText('故宫');
    expect(place.address).toBe('北京市东城区景山前街4号');
  });

  it('AMAP-012: survives the empty arrays Amap sends for absent string fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          pois: [
            {
              id: 'B2',
              name: '某小店',
              // These are what Amap really returns when the field has no value —
              // not undefined, and not '': an empty ARRAY.
              address: [],
              tel: [],
              website: [],
              location: TIANANMEN_LOCATION,
              pname: [],
              cityname: [],
              adname: [],
            },
          ],
        }),
      ),
    );
    const [place] = await provider().searchText('某小店');
    // Not "[]" and not "[object Object]" — the failure this coercion prevents.
    expect(place.address).toBe('');
    expect(place.phone).toBeNull();
    expect(place.website).toBeNull();
  });

  it('AMAP-013: uses place/around with a bias, because text search cannot be biased', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ pois: [] })));
    await provider().searchText('咖啡', 'zh', { lat: 31.2304, lng: 121.4737, radius: 3000 });

    const url = calledUrl();
    expect(url).toContain('/v3/place/around');
    expect(url).toContain('radius=3000');
    // The outbound coordinate is GCJ-02, i.e. NOT the WGS-84 value we passed in.
    const location = new URL(url).searchParams.get('location')!;
    const [lng, lat] = location.split(',').map(Number);
    const back = gcj02ToWgs84(lat, lng);
    expect(back.lat).toBeCloseTo(31.2304, 4);
    expect(back.lng).toBeCloseTo(121.4737, 4);
    expect(lat).not.toBeCloseTo(31.2304, 4);
  });

  it('AMAP-014: clamps the radius to the 50 km Amap accepts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ pois: [] })));
    await provider().searchText('x', undefined, { lat: 31.2304, lng: 121.4737, radius: 900000 });
    expect(calledUrl()).toContain('radius=50000');
  });

  it('AMAP-015: uses place/text without a bias', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ pois: [] })));
    await provider().searchText('外滩');
    expect(calledUrl()).toContain('/v3/place/text');
  });

  it('AMAP-016: keeps a POI that has no geometry rather than dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ pois: [{ id: 'B3', name: '无坐标', location: [] }] })));
    const [place] = await provider().searchText('无坐标');
    expect(place.lat).toBeNull();
    expect(place.lng).toBeNull();
    expect(place.name).toBe('无坐标');
  });
});

// ── Error translation ────────────────────────────────────────────────────────

describe('Amap error handling', () => {
  it('AMAP-020: turns an invalid-key body into a 403, despite the HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(amapError('10001', 'INVALID_USER_KEY')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider().searchText('x')).rejects.toMatchObject({ status: 403 });
    // The hint has to name what an admin can change; Amap's own wording does not.
    await expect(provider().searchText('x')).rejects.toThrow(/Web 服务/);
    errorSpy.mockRestore();
  });

  it('AMAP-021: turns quota exhaustion into a 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(amapError('10003')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider().searchText('x')).rejects.toMatchObject({ status: 429 });
    errorSpy.mockRestore();
  });

  it('AMAP-022: reports the key source and the user, never the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(amapError('10009')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider().searchText('x')).rejects.toMatchObject({ status: 403 });
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('keySource=instance');
    expect(logged).toContain('userId=3');
    expect(logged).not.toContain('amap-test-key');
    errorSpy.mockRestore();
  });

  it('AMAP-023: an unknown infocode is a 502 and keeps Amap\u2019s own wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(amapError('20800', 'OUT_OF_SERVICE')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider().searchText('x')).rejects.toMatchObject({ status: 502, message: /OUT_OF_SERVICE/ });
    errorSpy.mockRestore();
  });
});

// ── autocomplete ─────────────────────────────────────────────────────────────

describe('AmapPlacesProvider.autocomplete', () => {
  it('AMAP-030: namespaces every suggestion id and caps the list at five', async () => {
    const tips = Array.from({ length: 8 }, (_, i) => ({
      id: `T${i}`,
      name: `候选${i}`,
      district: '北京市东城区',
      address: '某路',
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ tips })));

    const suggestions = await provider().autocomplete('候选');
    expect(suggestions).toHaveLength(5);
    expect(suggestions[0].placeId).toBe('amap:T0');
    expect(suggestions[0].mainText).toBe('候选0');
    expect(suggestions[0].secondaryText).toBe('北京市东城区 某路');
    expect(calledUrl()).toContain('/v3/assistant/inputtips');
  });

  it('AMAP-031: drops a tip with no id, which cannot be looked up afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ tips: [{ name: '一条路', id: [] }, { id: 'T9', name: '有效的' }] })),
    );
    const suggestions = await provider().autocomplete('路');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].placeId).toBe('amap:T9');
  });

  it('AMAP-032: biases around the centre of the viewport, in GCJ-02', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ tips: [] })));
    await provider().autocomplete('咖啡', 'zh', {
      low: { lat: 31.2, lng: 121.4 },
      high: { lat: 31.3, lng: 121.5 },
    });
    const location = new URL(calledUrl()).searchParams.get('location')!;
    const [lng, lat] = location.split(',').map(Number);
    const back = gcj02ToWgs84(lat, lng);
    expect(back.lat).toBeCloseTo(31.25, 3);
    expect(back.lng).toBeCloseTo(121.45, 3);
  });
});

// ── placeDetails ─────────────────────────────────────────────────────────────

describe('AmapPlacesProvider.placeDetails', () => {
  it('AMAP-040: looks up the bare poi id via v5 and returns WGS-84', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          pois: [
            {
              id: 'B000A83M61',
              name: '天安门',
              address: '东长安街',
              location: TIANANMEN_LOCATION,
              business: { rating: '4.8', tel: '010-12345678' },
            },
          ],
        }),
      ),
    );

    const place = await provider().placeDetails('amap:B000A83M61');
    const url = calledUrl();
    expect(url).toContain('/v5/place/detail');
    // The prefix is ours, not Amap's — it must not reach the API.
    expect(new URL(url).searchParams.get('id')).toBe('B000A83M61');
    expect(place!.rating).toBe(4.8);
    expect(place!.phone).toBe('010-12345678');
    expect(place!.lat as number).toBeCloseTo(39.90869, 4);
  });

  it('AMAP-041: returns null for an id that is not an Amap id, without calling out', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await provider().placeDetails('ChIJsomething')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AMAP-042: returns null when Amap knows the id but has no POI for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ pois: [] })));
    expect(await provider().placeDetails('amap:B000A83M61')).toBeNull();
  });
});

// ── reverse ──────────────────────────────────────────────────────────────────

describe('AmapPlacesProvider.reverse', () => {
  it('AMAP-050: sends GCJ-02 and prefers the AOI the click landed inside', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          regeocode: {
            formatted_address: '北京市东城区天安门广场',
            aois: [{ name: '天安门广场' }],
            pois: [{ name: '国旗杆' }],
            addressComponent: { building: { name: '某楼' } },
          },
        }),
      ),
    );

    const answer = await provider().reverse(39.90869, 116.39124);
    expect(answer).toEqual({ name: '天安门广场', address: '北京市东城区天安门广场' });
    const location = new URL(calledUrl()).searchParams.get('location')!;
    const [lng, lat] = location.split(',').map(Number);
    expect(gcj02ToWgs84(lat, lng).lat).toBeCloseTo(39.90869, 4);
  });

  it('AMAP-051: falls through the name candidates when there is no AOI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({ regeocode: { formatted_address: '某地址', aois: [], pois: [], addressComponent: { neighborhood: { name: '某社区' } } } }),
      ),
    );
    expect((await provider().reverse(39.9, 116.4))!.name).toBe('某社区');
  });
});

// ── Shared-link parsing ──────────────────────────────────────────────────────

describe('parseAmapUrl', () => {
  it('AMAP-060: reads uri.amap.com marker links as lng,lat in GCJ-02', () => {
    const parsed = parseAmapUrl(`https://uri.amap.com/marker?position=${TIANANMEN_LOCATION}&name=%E5%A4%A9%E5%AE%89%E9%97%A8`);
    expect(parsed).not.toBeNull();
    // Longitude first AND a datum shift: reading this link the Google way would
    // put a Beijing landmark in the Indian Ocean.
    expect(parsed!.lat).toBeCloseTo(39.90869, 4);
    expect(parsed!.lng).toBeCloseTo(116.39124, 4);
    expect(parsed!.name).toBe('天安门');
  });

  it('AMAP-061: picks the poi id out of a place page', () => {
    const parsed = parseAmapUrl('https://www.amap.com/place/B000A83M61');
    expect(parsed!.poiId).toBe('B000A83M61');
    expect(Number.isNaN(parsed!.lat)).toBe(true);
  });

  it('AMAP-062: refuses a host that is not Amap', () => {
    expect(parseAmapUrl('https://amap.com.evil.example/marker?position=116,39')).toBeNull();
    expect(parseAmapUrl('not a url')).toBeNull();
  });

  it('AMAP-063: recognises only Amap\u2019s own hosts', () => {
    expect(isAmapHost('uri.amap.com')).toBe(true);
    expect(isAmapHost('www.amap.com')).toBe(true);
    expect(isAmapHost('surl.amap.com')).toBe(true);
    expect(isAmapHost('amap.com.attacker.net')).toBe(false);
    expect(isAmapHost('notamap.com')).toBe(false);
  });
});

// ── Provider selection ───────────────────────────────────────────────────────

describe('MapsService.resolvePlacesProvider', () => {
  /** Make the Google key chain answer, the Amap chain answer, or neither. */
  function keys(opts: { google?: string; amap?: string }) {
    mockDbGet.mockImplementation((...args: unknown[]) => {
      // resolveApiKey reads the caller's own row per name; the SQL differs but
      // the stub only sees the bound userId, so answer both columns at once.
      return { maps_api_key: opts.google ?? null, amap_api_key: opts.amap ?? null } as any;
    });
  }

  it('AMAP-070: auto keeps Google when a Google key is configured', () => {
    keys({ google: 'gkey', amap: 'akey' });
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(GooglePlacesProvider);
  });

  it('AMAP-071: auto falls to Amap only when there is no Google key', () => {
    keys({ amap: 'akey' });
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(AmapPlacesProvider);
  });

  it('AMAP-072: auto with no key at all means the OpenStreetMap stack', () => {
    keys({});
    expect(svc.resolvePlacesProvider(1)).toBeNull();
  });

  it('AMAP-073: an explicit amap choice wins over a configured Google key', () => {
    mockProviderGet.mockReturnValue({ value: 'amap' });
    keys({ google: 'gkey', amap: 'akey' });
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(AmapPlacesProvider);
  });

  it('AMAP-074: an explicit google choice never silently uses Amap instead', () => {
    mockProviderGet.mockReturnValue({ value: 'google' });
    keys({ amap: 'akey' });
    // Misconfigured means "answer with OSM", not "bill somebody else's provider".
    expect(svc.resolvePlacesProvider(1)).toBeNull();
  });

  it('AMAP-075: openstreetmap ignores both keys', () => {
    mockProviderGet.mockReturnValue({ value: 'openstreetmap' });
    keys({ google: 'gkey', amap: 'akey' });
    expect(svc.resolvePlacesProvider(1)).toBeNull();
  });

  it('AMAP-076: a hand-edited nonsense value degrades to auto instead of failing', () => {
    mockProviderGet.mockReturnValue({ value: 'not-a-provider' });
    keys({ google: 'gkey' });
    expect(svc.placesProviderChoice()).toBe('auto');
    expect(svc.resolvePlacesProvider(1)).toBeInstanceOf(GooglePlacesProvider);
  });

  it('AMAP-077: an Amap place stays with Amap even while Google is selected', async () => {
    mockProviderGet.mockReturnValue({ value: 'google' });
    keys({ google: 'gkey', amap: 'akey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ pois: [{ id: 'B9', name: '旧地点', location: TIANANMEN_LOCATION }] })),
    );

    const { place } = await svc.getPlaceDetails(1, 'amap:B9');
    // Reached Amap's endpoint, not Google's — an id outlives the setting.
    expect(calledUrl()).toContain('restapi.amap.com');
    expect(place!.name).toBe('旧地点');
  });

  it('AMAP-077b: a Google place still opens after the admin switches to Amap', async () => {
    // The mirror of AMAP-077, and the one that matters on a real migration: an
    // install with a year of google_place_id rows switches provider, and every
    // one of those places has to keep opening against the Google key that is
    // still configured.
    mockProviderGet.mockReturnValue({ value: 'amap' });
    keys({ google: 'gkey', amap: 'akey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'ChIJ123', displayName: { text: 'Old Google place' }, location: { latitude: 48.8, longitude: 2.3 } }),
      }),
    );

    const { place } = await svc.getPlaceDetails(1, 'ChIJ123');
    expect(calledUrl()).toContain('places.googleapis.com');
    expect(place!.name).toBe('Old Google place');
  });

  it('AMAP-078: an Amap id is never mistaken for an OSM type:id pair', async () => {
    // `amap:B9` contains a colon, like `node:123`. Read as OSM it would go to
    // Overpass as element type "amap" and answer every Chinese place with a
    // blank record — so the ordering of those two branches is load-bearing.
    mockProviderGet.mockReturnValue({ value: 'amap' });
    keys({ amap: 'akey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ pois: [{ id: 'B9', name: '天安门', location: TIANANMEN_LOCATION }] })),
    );
    const { place } = await svc.getPlaceDetails(1, 'amap:B9');
    expect(place!.source).toBe('amap');
    expect(calledUrl()).not.toContain('overpass');
  });
});

describe('MapsService.searchPlaces with Amap selected', () => {
  it('AMAP-080: reports amap as the source so the client can credit it', async () => {
    mockProviderGet.mockReturnValue({ value: 'amap' });
    mockDbGet.mockReturnValue({ maps_api_key: null, amap_api_key: 'akey' } as any);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ pois: [{ id: 'B1', name: '外滩', location: TIANANMEN_LOCATION }] })),
    );

    const result = await svc.searchPlaces(1, '外滩');
    expect(result.source).toBe('amap');
    expect(result.places).toHaveLength(1);
  });
});
