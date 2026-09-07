/**
 * Unit tests for the DI-native MapsService — MAPS-001 through MAPS-110.
 * Moved 1:1 from the legacy tests/unit/services/mapsService.test.ts when the
 * maps domain folded into src/nest/maps/ (case IDs preserved; the wrapper
 * suite's delegation cases died with the delegation itself — the kill-switch,
 * photoBytesPath and bridge cases live at the bottom).
 * Covers parseOpeningHours, buildOsmDetails, getMapsKey, reverseGeocode,
 * resolveGoogleMapsUrl (coordinate extraction + short URL / SSRF),
 * searchNominatim, fetchOverpassDetails, fetchWikimediaPhoto, searchPlaces,
 * getPlaceDetails, and getPlacePhoto (all branches including cache logic).
 * fetch is stubbed; DB and ssrfGuard are mocked.
 */
import {
  parseOpeningHours,
  normalizeOpeningPeriods,
  normalizeSpecialDays,
  buildOsmDetails,
  googleFtidFromMapsUrl,
  isGooglePlaceId,
  buildUserAgent,
  resolveOverpassEndpoints,
  resolveOverpassTimeoutMs,
  stripWikiMarkup,
  parseWikipediaTag,
  rankCommonsCandidates,
  type RankableCommonsCandidate,
} from '../../../src/nest/maps/maps.helpers';

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The seams below stand in for real collaborators, so they are typed from those
// collaborators' signatures rather than from their own default implementations.
// checkSsrf answers with a full SsrfResult; the guard path exercised here reads
// only these two fields, so the stub returns that slice instead of inventing a
// resolved IP and a privacy verdict no assertion looks at.
type SsrfCheckStub = Pick<SsrfResult, 'allowed' | 'error'>;

const {
  mockDbGet,
  mockDbRun,
  mockInstanceGet,
  preparedSql,
  mockCheckSsrf,
  mockCacheGet,
  mockCacheGetErrored,
  mockCacheMarkError,
  mockCachePut,
  mockCacheGetInFlight,
  mockCacheSetInFlight,
  mockServeFilePath,
  mockProviderGet,
} = vi.hoisted(() => ({
  mockDbGet: vi.fn((..._args: unknown[]) => undefined as any),
  mockDbRun: vi.fn(),
  // The instance-wide key row (#1939) is read before the caller's own row, so it
  // gets its own seam: every case below that stubs mockDbGet means "this user's
  // row holds a key", and would otherwise have its stub eaten by the
  // app_settings lookup.
  mockInstanceGet: vi.fn((..._args: unknown[]) => undefined as any),
  // The places_provider row is read before the key chain, so it needs a seam of
  // its own: routed through mockInstanceGet it would eat the mockReturnValueOnce
  // that a case meant for the instance-wide KEY, and the service would resolve a
  // key value as a provider name. Default undefined = the 'auto' choice, which is
  // what every install that predates Amap has.
  mockProviderGet: vi.fn((..._args: unknown[]) => undefined as any),
  preparedSql: [] as string[],
  mockCheckSsrf: vi.fn(async (_url: string, _bypassInternalIpAllowed?: boolean): Promise<SsrfCheckStub> => ({
    allowed: true,
  })),
  mockCacheGet: vi.fn((_placeId: string) => null as ReturnType<PlacePhotoCacheService['get']>),
  mockCacheGetErrored: vi.fn((_placeId: string) => false),
  mockCacheMarkError: vi.fn(),
  mockCachePut: vi.fn(async (placeId: string, _bytes: Buffer, attribution: string | null) => ({
    photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`,
    filePath: `/tmp/${placeId}.jpg`,
    attribution,
  })),
  mockCacheGetInFlight: vi.fn(
    (_placeId: string) => undefined as ReturnType<PlacePhotoCacheService['getInFlight']>,
  ),
  mockCacheSetInFlight: vi.fn(),
  mockServeFilePath: vi.fn((_placeId: string) => null as string | null),
}));

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: (sql: string) => {
      preparedSql.push(sql);
      return {
        get: (...args: unknown[]) => {
          if (!sql.includes('app_settings')) return mockDbGet(...args);
          // Keyed by the bound parameter, not just by the table: app_settings
          // holds both the instance-wide API keys and the provider choice.
          return args[0] === 'places_provider' ? mockProviderGet(...args) : mockInstanceGet(...args);
        },
        all: vi.fn(() => []),
        run: mockDbRun,
      };
    },
  },
}));

vi.mock('../../../src/utils/ssrfGuard', () => {
  class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SsrfBlockedError';
    }
  }
  return {
    checkSsrf: mockCheckSsrf,
    SsrfBlockedError,
    // Mirror the real per-hop helper closely enough for unit tests: run the
    // (mocked) SSRF check, then fetch through the (stubbed) global fetch. The
    // fetch stubs in these tests already return the final resolved response.
    safeFetchFollow: vi.fn(async (url: string, init?: any) => {
      const ssrf = await mockCheckSsrf(url);
      if (!ssrf.allowed) throw new SsrfBlockedError(ssrf.error ?? 'Request blocked by SSRF guard');
      return (globalThis.fetch as any)(url, init);
    }),
  };
});

vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  // Unused by the read paths here, but instance-api-keys imports it.
  maybe_encrypt_api_key: (v: string | null) => v,
}));

vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: '0'.repeat(64),
}));

// Injected stub since the photo-cache fold (was a path mock of the module).
// Same seven seams, same mock functions behind them.
const photoCacheStub = {
  get: (placeId: string) => mockCacheGet(placeId),
  getErrored: (placeId: string) => mockCacheGetErrored(placeId),
  put: (placeId: string, bytes: Buffer, attribution: string | null) => mockCachePut(placeId, bytes, attribution),
  markError: (placeId: string, kind?: string) => mockCacheMarkError(placeId, kind),
  getInFlight: (placeId: string) => mockCacheGetInFlight(placeId),
  setInFlight: (placeId: string, p: Promise<any>) => mockCacheSetInFlight(placeId, p),
  serveKey: (placeId: string) => mockServeFilePath(placeId),
} as unknown as PlacePhotoCacheService;

import { db } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { MapsService, withPhotoFetchSlot, readWikiIdentity } from '../../../src/nest/maps/maps.service';
import type { PlacePhotoCacheService } from '../../../src/nest/place-photos/place-photo-cache.service';
// Type-only, so the module stays mocked: this import is erased at runtime.
import type { SsrfResult } from '../../../src/utils/ssrfGuard';

// The service under test, constructed over the mocked db stub — DatabaseService
// routes get/run through the stubbed prepare(), so mockDbGet/mockDbRun keep
// flowing exactly as they did for the legacy module.
const svc = new MapsService(new DatabaseService(db as never), photoCacheStub);

afterEach(() => {
  vi.unstubAllGlobals();
  mockDbGet.mockReset();
  mockDbGet.mockReturnValue(undefined);
  mockInstanceGet.mockReset();
  mockInstanceGet.mockReturnValue(undefined);
  mockProviderGet.mockReset();
  mockProviderGet.mockReturnValue(undefined);
  preparedSql.length = 0;
  mockDbRun.mockReset();
  mockCheckSsrf.mockReset();
  mockCheckSsrf.mockResolvedValue({ allowed: true });
  mockCacheGet.mockReset();
  mockCacheGet.mockReturnValue(null);
  mockCacheGetErrored.mockReset();
  mockCacheGetErrored.mockReturnValue(false);
  mockCacheMarkError.mockReset();
  mockCachePut.mockReset();
  mockCachePut.mockImplementation(async (placeId: string, _bytes: Buffer, attribution: string | null) => ({
    photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`,
    filePath: `/tmp/${placeId}.jpg`,
    attribution,
  }));
  mockCacheGetInFlight.mockReset();
  mockCacheGetInFlight.mockReturnValue(undefined);
  mockCacheSetInFlight.mockReset();
  mockServeFilePath.mockReset();
  mockServeFilePath.mockReturnValue(null);
});

// ── parseOpeningHours ─────────────────────────────────────────────────────────

/**
 * CPU milliseconds burned by `fn`.
 *
 * The ReDoS budgets below used to measure wall-clock time, which on a loaded
 * machine reports how long the test waited for a core rather than how long the
 * regex ran — MAPS-024 has gone red at 523 ms on an unchanged file for exactly
 * that reason. Catastrophic backtracking burns CPU, so CPU time is both the
 * honest signal and a STRICTER one: cpu <= wall always, so no budget here got
 * looser. vitest.config.ts uses pool:'forks', so this counts only this file.
 */
function cpuMillis(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const d = process.cpuUsage(before);
  return (d.user + d.system) / 1000;
}

describe('parseOpeningHours', () => {
  it('MAPS-001: returns 7 weekday descriptions and openNow', () => {
    const result = parseOpeningHours('Mo-Fr 09:00-18:00');
    expect(result.weekdayDescriptions).toHaveLength(7);
    expect(result.weekdayDescriptions[0]).toContain('Monday: 09:00-18:00');
    expect(typeof result.openNow === 'boolean' || result.openNow === null).toBe(true);
  });

  it('MAPS-002: marks unknown days with ?', () => {
    const result = parseOpeningHours('Mo 10:00-12:00');
    expect(result.weekdayDescriptions[1]).toContain('?');
  });

  it('MAPS-003: handles multiple segments separated by semicolons', () => {
    const result = parseOpeningHours('Mo-Fr 09:00-18:00; Sa 10:00-14:00');
    expect(result.weekdayDescriptions[5]).toContain('Saturday: 10:00-14:00');
    expect(result.weekdayDescriptions[0]).toContain('Monday: 09:00-18:00');
  });

  it('MAPS-004: reads 24/7 as open around the clock, every day', () => {
    // This case used to assert only that nothing crashed, and nothing did: all
    // seven lines came back as "?", buildOsmDetails then dropped the hours
    // entirely, and airports, main stations and petrol stations — the places
    // most likely to be tagged this way — showed no opening hours at all.
    const result = parseOpeningHours('24/7');

    expect(result.weekdayDescriptions).toHaveLength(7);
    expect(result.weekdayDescriptions[0]).toBe('Monday: 00:00-24:00');
    expect(result.weekdayDescriptions[6]).toBe('Sunday: 00:00-24:00');
    expect(result.openNow).toBe(true);
    // A single period with no close is how "never closes" is spelled.
    expect(result.periods).toEqual([{ open: { day: 0, hour: 0, minute: 0 }, close: null }]);
  });

  it('MAPS-004b: reads a bare "open" the same way, and leaves other strings alone', () => {
    expect(parseOpeningHours('open').openNow).toBe(true);
    // Only a bare "24/7" short-circuits. Anything with weekdays in front of it
    // is an ordinary segment and keeps going through the normal parser.
    expect(parseOpeningHours('Mo-Fr 24/7').weekdayDescriptions[0]).toBe('Monday: 24/7');
    expect(parseOpeningHours('Mo-Fr 24/7').weekdayDescriptions[6]).toBe('Sunday: ?');
  });

  it('MAPS-005: returns openNow null for unparseable format', () => {
    const result = parseOpeningHours('invalid-hours-string');
    expect(result.openNow).toBeNull();
  });

  it('MAPS-005b: a weekday range that wraps the whole week covers all seven days', () => {
    // "Mo-Su" is how a place open daily is usually tagged, and it produced
    // exactly ONE day: the loop's exit condition was already true on entry, so
    // the body never ran and only the closing day was added.
    const daily = parseOpeningHours('Mo-Su 11:30-23:00');
    expect(daily.weekdayDescriptions.filter((l) => !l.endsWith('?'))).toHaveLength(7);
    expect(daily.weekdayDescriptions[0]).toBe('Monday: 11:30-23:00');
    expect(daily.weekdayDescriptions[6]).toBe('Sunday: 11:30-23:00');

    // Same shape starting anywhere else in the week.
    expect(parseOpeningHours('Tu-Mo 08:00-20:00').weekdayDescriptions.filter((l) => !l.endsWith('?'))).toHaveLength(7);

    // Ranges that do not wrap are unchanged.
    expect(parseOpeningHours('Mo-Fr 09:00-18:00').weekdayDescriptions.filter((l) => !l.endsWith('?'))).toHaveLength(5);
    expect(parseOpeningHours('Sa-Su 10:00-14:00').weekdayDescriptions.filter((l) => !l.endsWith('?'))).toHaveLength(2);
    expect(parseOpeningHours('Mo 09:00-12:00').weekdayDescriptions.filter((l) => !l.endsWith('?'))).toHaveLength(1);
  });

  it('MAPS-006: handles comma-separated days', () => {
    const result = parseOpeningHours('Mo,We,Fr 08:00-17:00');
    expect(result.weekdayDescriptions[0]).toContain('Monday: 08:00-17:00');
    expect(result.weekdayDescriptions[2]).toContain('Wednesday: 08:00-17:00');
    expect(result.weekdayDescriptions[4]).toContain('Friday: 08:00-17:00');
    expect(result.weekdayDescriptions[1]).toContain('?');
  });

  it('MAPS-007 (ReDoS): opening hours regex on adversarial input < 100ms of CPU', () => {
    const adversarial = 'Mo' + ',Mo'.repeat(500) + ' closed';
    expect(cpuMillis(() => { parseOpeningHours(adversarial); })).toBeLessThan(100);
  });

  it('MAPS-007b: emits machine-readable periods in Google day numbering (Sunday = 0)', () => {
    const result = parseOpeningHours('Mo 09:00-18:00; Su 10:00-14:00');
    expect(result.periods).toEqual([
      { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
      { open: { day: 0, hour: 10, minute: 0 }, close: { day: 0, hour: 14, minute: 0 } },
    ]);
  });

  it('MAPS-007c: a period past midnight closes on the following day', () => {
    const result = parseOpeningHours('Sa 20:00-02:00');
    expect(result.periods).toEqual([
      { open: { day: 6, hour: 20, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } },
    ]);
  });

  it('MAPS-007d: the OSM 24:00 spelling becomes midnight of the next day', () => {
    // Google's clock has no hour 24, so "00:00-24:00" is a full day, not a rejected range.
    const result = parseOpeningHours('Mo 00:00-24:00');
    expect(result.periods).toEqual([
      { open: { day: 1, hour: 0, minute: 0 }, close: { day: 2, hour: 0, minute: 0 } },
    ]);
  });

  it('MAPS-007e: unusable clock values produce no period', () => {
    expect(parseOpeningHours('Mo 09:75-18:00').periods).toEqual([]);
    expect(parseOpeningHours('Mo 09:00-24:30').periods).toEqual([]);
    expect(parseOpeningHours('Mo closed').periods).toEqual([]);
  });
});

// ── normalizeOpeningPeriods / normalizeSpecialDays ────────────────────────────

describe('normalizeOpeningPeriods', () => {
  it('MAPS-007f: keeps well-formed periods and fills the zeroes proto3 JSON omits', () => {
    expect(
      normalizeOpeningPeriods([{ open: { day: 3, hour: 9, minute: 30 }, close: { day: 3, hour: 17 } }]),
    ).toEqual([{ open: { day: 3, hour: 9, minute: 30 }, close: { day: 3, hour: 17, minute: 0 } }]);
    // Sunday midnight arrives as an empty object.
    expect(normalizeOpeningPeriods([{ open: {} }])).toEqual([{ open: { day: 0, hour: 0, minute: 0 }, close: null }]);
  });

  it('MAPS-007g: a period without a close survives as the round-the-clock marker', () => {
    expect(normalizeOpeningPeriods([{ open: { day: 0, hour: 0, minute: 0 } }])).toEqual([
      { open: { day: 0, hour: 0, minute: 0 }, close: null },
    ]);
  });

  it('MAPS-007h: drops out-of-range points and periods with an unusable close', () => {
    expect(normalizeOpeningPeriods([{ open: { day: 7, hour: 9, minute: 0 } }])).toBeNull();
    expect(normalizeOpeningPeriods([{ open: { day: 1, hour: 24, minute: 0 } }])).toBeNull();
    // A broken close must not be mistaken for "never closes".
    expect(
      normalizeOpeningPeriods([{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 9, minute: 90 } }]),
    ).toBeNull();
  });

  it('MAPS-007i: returns null when there is nothing to normalise', () => {
    expect(normalizeOpeningPeriods(undefined)).toBeNull();
    expect(normalizeOpeningPeriods([])).toBeNull();
  });
});

describe('normalizeSpecialDays', () => {
  it('MAPS-007j: turns Google date parts into ISO dates without duplicates', () => {
    expect(
      normalizeSpecialDays([
        { date: { year: 2026, month: 12, day: 25 } },
        { date: { year: 2026, month: 1, day: 1 } },
        { date: { year: 2026, month: 12, day: 25 } },
      ]),
    ).toEqual(['2026-12-25', '2026-01-01']);
  });

  it('MAPS-007k: skips incomplete or impossible dates and returns null when none are left', () => {
    expect(normalizeSpecialDays([{}, { date: { year: 2026, month: 13, day: 1 } }, { date: { year: 2026, day: 5 } }])).toBeNull();
    expect(normalizeSpecialDays(undefined)).toBeNull();
  });
});

// ── buildOsmDetails ───────────────────────────────────────────────────────────

describe('buildOsmDetails', () => {
  it('MAPS-008: returns website from tags', () => {
    const result = buildOsmDetails({ website: 'https://example.com' }, 'way', '123');
    expect(result.website).toBe('https://example.com');
  });

  it('MAPS-009: prefers contact:website over website', () => {
    const result = buildOsmDetails(
      { 'contact:website': 'https://contact.example.com', website: 'https://other.com' },
      'node',
      '1',
    );
    expect(result.website).toBe('https://contact.example.com');
  });

  it('MAPS-010: returns null website when no tag', () => {
    const result = buildOsmDetails({}, 'node', '1');
    expect(result.website).toBeNull();
  });

  it('MAPS-011: builds correct osm_url', () => {
    const result = buildOsmDetails({}, 'way', '99999');
    expect(result.osm_url).toBe('https://www.openstreetmap.org/way/99999');
  });

  it('MAPS-012: includes parsed opening_hours when valid', () => {
    const result = buildOsmDetails({ opening_hours: 'Mo-Fr 09:00-18:00' }, 'node', '1');
    expect(result.opening_hours).not.toBeNull();
    expect(Array.isArray(result.opening_hours)).toBe(true);
  });

  it('MAPS-013: opening_hours is null when tag is missing', () => {
    const result = buildOsmDetails({}, 'node', '1');
    expect(result.opening_hours).toBeNull();
    expect(result.open_now).toBeNull();
  });

  it('MAPS-014: source is always openstreetmap', () => {
    expect(buildOsmDetails({}, 'node', '1').source).toBe('openstreetmap');
  });

  it('MAPS-012b: carries the structured periods next to the weekday lines', () => {
    const result = buildOsmDetails({ opening_hours: 'Mo-Tu 09:00-18:00' }, 'node', '1');
    expect(result.opening_periods).toEqual([
      { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
      { open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 18, minute: 0 } },
    ]);
  });

  it('MAPS-012c: opening_periods is null when the day lines carry no usable times', () => {
    expect(buildOsmDetails({}, 'node', '1').opening_periods).toBeNull();
    expect(buildOsmDetails({ opening_hours: 'Mo closed' }, 'node', '1').opening_periods).toBeNull();
  });

  it('MAPS-014b: opening_hours is null when all days have unknown times (all "?")', () => {
    // "closed" does not match the day+time pattern so all days remain "?"
    const result = buildOsmDetails({ opening_hours: 'closed' }, 'node', '1');
    expect(result.opening_hours).toBeNull();
    expect(result.open_now).toBeNull();
  });
});

// ── resolveMapsKey / getMapsKey ───────────────────────────────────────────────

describe('resolveMapsKey', () => {
  const ORIGINAL_PLACES_KEY = process.env.PLACES_API_KEY;
  afterEach(() => {
    if (ORIGINAL_PLACES_KEY === undefined) delete process.env.PLACES_API_KEY;
    else process.env.PLACES_API_KEY = ORIGINAL_PLACES_KEY;
  });

  it('MAPS-015: returns the caller own row key when nothing above it is set', () => {
    mockDbGet.mockReturnValue({ maps_api_key: 'user-api-key' });
    expect(svc.resolveMapsKey(1)).toEqual({ key: 'user-api-key', source: 'user-row' });
    expect(svc.getMapsKey(1)).toBe('user-api-key'); // the wrapper reads the same chain
  });

  it('MAPS-016: the instance-wide key wins over the caller own row (#1939)', () => {
    mockInstanceGet.mockReturnValueOnce({ value: 'instance-api-key' });
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'user-api-key' });
    expect(svc.resolveMapsKey(1)).toEqual({ key: 'instance-api-key', source: 'instance' });
  });

  it('MAPS-017: returns null with no source when nothing is set anywhere', () => {
    expect(svc.resolveMapsKey(1)).toEqual({ key: null, source: null });
    expect(svc.getMapsKey(1)).toBeNull();
  });

  it('MAPS-017b: the operator env key wins and the database is never asked', () => {
    process.env.PLACES_API_KEY = 'operator-key';
    expect(svc.resolveMapsKey(1)).toEqual({ key: 'operator-key', source: 'operator-env' });
    expect(mockInstanceGet).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it("MAPS-017c: never reads another user's row — the admin fallback is gone (#1939)", () => {
    svc.resolveMapsKey(1);
    // Two statements, both scoped: the instance row and this caller's own row.
    // The old chain ended in "WHERE role = 'admin' ... LIMIT 1", which handed a
    // stranger's credential to every non-admin.
    expect(preparedSql).toHaveLength(2);
    expect(preparedSql.join(' ')).not.toContain("role = 'admin'");
    expect(preparedSql.some((sql) => sql.includes('WHERE id = ?'))).toBe(true);
  });
});

// ── reverseGeocode ────────────────────────────────────────────────────────────

describe('reverseGeocode (fetch stubbed)', () => {
  it('MAPS-018: returns name and address from nominatim response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'Eiffel Tower',
          display_name: 'Eiffel Tower, Paris, France',
          address: {},
        }),
      }),
    );
    const result = await svc.reverseGeocode('48.8584', '2.2945');
    expect(result.name).toBe('Eiffel Tower');
    expect(result.address).toBe('Eiffel Tower, Paris, France');
  });

  it('MAPS-019: returns nulls when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const result = await svc.reverseGeocode('0', '0');
    expect(result.name).toBeNull();
    expect(result.address).toBeNull();
  });

  it('MAPS-019b: falls back to address.tourism when name is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          display_name: 'Some Museum, Paris',
          address: { tourism: 'Some Museum' },
        }),
      }),
    );
    const result = await svc.reverseGeocode('48.85', '2.35');
    expect(result.name).toBe('Some Museum');
  });

  it('MAPS-019c: falls back to address.amenity when name and tourism are absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          display_name: 'A Cafe, Paris',
          address: { amenity: 'A Cafe' },
        }),
      }),
    );
    const result = await svc.reverseGeocode('48.85', '2.35');
    expect(result.name).toBe('A Cafe');
  });

  it('MAPS-019d: falls back to address.road when no higher-priority field exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          display_name: 'Rue de Rivoli, Paris',
          address: { road: 'Rue de Rivoli' },
        }),
      }),
    );
    const result = await svc.reverseGeocode('48.85', '2.35');
    expect(result.name).toBe('Rue de Rivoli');
  });

  it('MAPS-019e: returns null name when address has no recognized fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          display_name: 'Somewhere',
          address: {},
        }),
      }),
    );
    const result = await svc.reverseGeocode('0', '0');
    expect(result.name).toBeNull();
    expect(result.address).toBe('Somewhere');
  });
});

// Nominatim stub used by resolveGoogleMapsUrl after coordinate extraction
const nominatimStub = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ display_name: 'Paris, France', name: null, address: {} }),
});

// ── resolveGoogleMapsUrl coordinate extraction ────────────────────────────────

describe('resolveGoogleMapsUrl coordinate extraction (ReDoS guards)', () => {
  it('MAPS-020: extracts lat/lng from @lat,lng pattern', async () => {
    vi.stubGlobal('fetch', nominatimStub);
    const result = await svc.resolveGoogleMapsUrl('https://www.google.com/maps/@48.8566,2.3522,15z');
    expect(result.lat).toBeCloseTo(48.8566, 3);
    expect(result.lng).toBeCloseTo(2.3522, 3);
  });

  it('MAPS-021: extracts lat/lng from !3d!4d data pattern', async () => {
    vi.stubGlobal('fetch', nominatimStub);
    const result = await svc.resolveGoogleMapsUrl(
      'https://www.google.com/maps/place/Eiffel+Tower/data=!3d48.8584!4d2.2945',
    );
    expect(result.lat).toBeCloseTo(48.8584, 3);
    expect(result.lng).toBeCloseTo(2.2945, 3);
  });

  it('MAPS-022: extracts lat/lng from ?q=lat,lng pattern', async () => {
    vi.stubGlobal('fetch', nominatimStub);
    const result = await svc.resolveGoogleMapsUrl('https://www.google.com/maps?q=48.8566,2.3522');
    expect(result.lat).toBeCloseTo(48.8566, 3);
    expect(result.lng).toBeCloseTo(2.3522, 3);
  });

  it('MAPS-023: extracts place name from /place/ path', async () => {
    vi.stubGlobal('fetch', nominatimStub);
    const result = await svc.resolveGoogleMapsUrl('https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,15z');
    expect(result.name).toBe('Eiffel Tower');
  });

  it('MAPS-CID-001: resolves a cid= URL by following the redirect to a coordinate URL', async () => {
    // cid URLs (what get_place_details returns, and Google "Share" links) carry no
    // inline coords; the redirect target carries the !3d!4d data param.
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('nominatim')) {
        return { ok: true, json: async () => ({ display_name: 'Paris, France', name: 'Eiffel Tower', address: {} }) };
      }
      return { url: 'https://www.google.com/maps/place/Eiffel+Tower/data=!3d48.8584!4d2.2945', text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.resolveGoogleMapsUrl('https://maps.google.com/?cid=1234567890');
    expect(result.lat).toBeCloseTo(48.8584, 3);
    expect(result.lng).toBeCloseTo(2.2945, 3);
  });

  it('MAPS-CID-002: falls back to parsing coordinates from the page body', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('nominatim')) {
        return { ok: true, json: async () => ({ display_name: 'NYC, USA', name: null, address: {} }) };
      }
      if (u.includes('cid=')) {
        // Redirect target has no inline coords.
        return { url: 'https://www.google.com/maps/place/Somewhere', text: async () => '' };
      }
      // Body fetch of the resolved URL embeds coords in the map data.
      return { url: 'https://www.google.com/maps/place/Somewhere', text: async () => 'x!3d40.6892!4d-74.0445y' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.resolveGoogleMapsUrl('https://www.google.com/maps?cid=999');
    expect(result.lat).toBeCloseTo(40.6892, 3);
    expect(result.lng).toBeCloseTo(-74.0445, 3);
  });

  it('MAPS-CID-003: does not read the page body of a non-Google resolved URL', async () => {
    // The body branch used to run for any host, turning resolve-url into an
    // authenticated outbound GET primitive.
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('nominatim')) {
        return { ok: true, json: async () => ({ display_name: 'x', name: null, address: {} }) };
      }
      if (u.includes('goo.gl')) return { url: 'https://internal.example.com/status' };
      return { url: 'https://internal.example.com/status', text: async () => 'x!3d40.6892!4d-74.0445y' };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(svc.resolveGoogleMapsUrl('https://goo.gl/maps/abc123')).rejects.toMatchObject({ status: 400 });
    // Only the redirect-following call went out; the page body was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://www.google.de/maps?cid=999',
    'https://maps.google.co.uk/?cid=999',
    'https://google.com.au/maps?cid=999',
  ])('MAPS-CID-003b: still reads the page body of a country domain (%s)', async (link) => {
    // Google Maps answers on every ccTLD, and those links carry no coordinates
    // to fall back on — a host allow-list of .com spellings drops them.
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('nominatim')) {
        return { ok: true, json: async () => ({ display_name: 'Berlin, DE', name: null, address: {} }) };
      }
      return { url: link, text: async () => 'x!3d52.5163!4d13.3777y' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await svc.resolveGoogleMapsUrl(link);
    expect(result.lat).toBeCloseTo(52.5163, 3);
    expect(result.lng).toBeCloseTo(13.3777, 3);
  });

  it('MAPS-CID-003c: a host that only looks like Google is still not read', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('nominatim')) {
        return { ok: true, json: async () => ({ display_name: 'x', name: null, address: {} }) };
      }
      return { url: 'https://google.evil.com/maps', text: async () => 'x!3d40.6892!4d-74.0445y' };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(svc.resolveGoogleMapsUrl('https://google.evil.com/maps?cid=999')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-CID-004: skips a page body that declares more than the size cap', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('cid=')) return { url: 'https://www.google.com/maps/place/Somewhere' };
      return {
        url: 'https://www.google.com/maps/place/Somewhere',
        headers: { get: (h: string) => (h === 'content-length' ? String(50_000_000) : null) },
        text: async () => 'x!3d40.6892!4d-74.0445y',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc.resolveGoogleMapsUrl('https://www.google.com/maps?cid=999')).rejects.toMatchObject({ status: 400 });
  });

  it('MAPS-024 (ReDoS): /@(-?\\d+\\.?\\d*),(-?\\d+\\.?\\d*)/ on adversarial input < 500ms of CPU', () => {
    const adversarial = '/@' + '1'.repeat(10000) + '.';
    expect(cpuMillis(() => { adversarial.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/); })).toBeLessThan(500);
  });

  it('MAPS-025 (ReDoS): /!3d(-?\\d+\\.?\\d*)!4d/ on adversarial input < 500ms of CPU', () => {
    const adversarial = '!3d' + '1'.repeat(10000) + '.';
    expect(cpuMillis(() => { adversarial.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/); })).toBeLessThan(500);
  });

  it('MAPS-026 (ReDoS): /[?&]q=(-?\\d+\\.?\\d*)/ on adversarial input < 500ms of CPU', () => {
    const adversarial = '?q=' + '1'.repeat(10000) + '.';
    expect(cpuMillis(() => { adversarial.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/); })).toBeLessThan(500);
  });

  it('MAPS-027 (ReDoS): /<[^>]+>/ HTML strip on adversarial input < 100ms of CPU', () => {
    const adversarial = '<' + 'a'.repeat(10000);
    expect(cpuMillis(() => { adversarial.replace(/<[^>]+>/g, ''); })).toBeLessThan(100);
  });

  it('MAPS-028: throws when no coordinates found in URL', async () => {
    vi.stubGlobal('fetch', nominatimStub);
    await expect(svc.resolveGoogleMapsUrl('https://www.google.com/maps')).rejects.toThrow();
  });

  it('MAPS-028b: throws 403 when short URL is blocked by SSRF check', async () => {
    mockCheckSsrf.mockResolvedValueOnce({ allowed: false });
    await expect(svc.resolveGoogleMapsUrl('https://goo.gl/maps/abc123')).rejects.toMatchObject({ status: 403 });
  });

  it('MAPS-028c: follows redirect for short goo.gl URL and extracts coordinates', async () => {
    const redirectFetch = vi
      .fn()
      // First call: the redirect (goo.gl), returns resolved URL in .url
      .mockResolvedValueOnce({
        url: 'https://www.google.com/maps/@48.8566,2.3522,15z',
      })
      // Second call: the Nominatim reverse geocode
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ display_name: 'Paris, France', name: 'Paris', address: {} }),
      });
    vi.stubGlobal('fetch', redirectFetch);
    const result = await svc.resolveGoogleMapsUrl('https://goo.gl/maps/abc123');
    expect(result.lat).toBeCloseTo(48.8566, 3);
    expect(result.lng).toBeCloseTo(2.3522, 3);
  });

  it('MAPS-028d: falls back to nominatim address fields when no placeName in URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        display_name: 'Louvre Museum, Paris',
        name: null,
        address: { tourism: 'Louvre Museum' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    // URL with coordinates but no /place/ path segment
    const result = await svc.resolveGoogleMapsUrl('https://www.google.com/maps/@48.8606,2.3376,15z');
    expect(result.name).toBe('Louvre Museum');
  });

  it('MAPS-110: a non-ok reverse-geocode answer degrades to URL-derived values instead of failing', async () => {
    // The coordinates are already extracted from the URL — a Nominatim 5xx must
    // not turn the resolution into a 400.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const result = await svc.resolveGoogleMapsUrl(
      'https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,15z',
    );
    expect(result.lat).toBeCloseTo(48.8584, 3);
    expect(result.lng).toBeCloseTo(2.2945, 3);
    expect(result.name).toBe('Eiffel Tower');
    expect(result.address).toBeNull();
  });
});

// ── searchNominatim (fetch-dependent) ────────────────────────────────────────

describe('searchNominatim (fetch stubbed)', () => {
  it('MAPS-029: returns mapped nominatim results on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { osm_type: 'way', osm_id: '1', lat: '48.8', lon: '2.3', name: 'Paris', display_name: 'Paris, France' },
        ],
      }),
    );
    const results = await svc.searchNominatim('Paris');
    expect(results).toHaveLength(1);
    expect((results[0] as any).address).toBe('Paris, France');
    expect((results[0] as any).source).toBe('openstreetmap');
  });

  it('MAPS-030: throws on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await expect(svc.searchNominatim('fail')).rejects.toThrow();
  });

  it('MAPS-030b: throws when nominatim response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => '',
      }),
    );
    await expect(svc.searchNominatim('fail')).rejects.toThrow('Nominatim API error');
  });

  it('MAPS-030c: falls back to display_name split when name is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ osm_type: 'node', osm_id: '2', lat: '51.5', lon: '-0.1', display_name: 'London, UK' }],
      }),
    );
    const results = await svc.searchNominatim('London');
    expect((results[0] as any).name).toBe('London');
  });

  it('MAPS-108: keeps "0" coordinates and nulls only unparseable ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { osm_type: 'node', osm_id: '3', lat: '0', lon: '0', name: 'Null Island' },
          { osm_type: 'node', osm_id: '4', lat: 'not-a-number', lon: '', name: 'Broken' },
        ],
      }),
    );
    const results = await svc.searchNominatim('null island');
    expect((results[0] as any).lat).toBe(0);
    expect((results[0] as any).lng).toBe(0);
    expect((results[1] as any).lat).toBeNull();
    expect((results[1] as any).lng).toBeNull();
  });
});

// ── fetchOverpassDetails (fetch stubbed) ─────────────────────────────────────

describe('fetchOverpassDetails (fetch stubbed)', () => {
  it('MAPS-031: returns element tags on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: [{ tags: { name: 'Eiffel Tower', website: 'https://eiffel.com' } }] }),
      }),
    );
    const result = await svc.fetchOverpassDetails('way', '12345');
    expect(result).toBeDefined();
    expect((result as any).tags.name).toBe('Eiffel Tower');
  });

  it('MAPS-032: returns null for unknown osmType', async () => {
    const result = await svc.fetchOverpassDetails('unknown', '12345');
    expect(result).toBeNull();
  });

  it('MAPS-033: returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await svc.fetchOverpassDetails('node', '99999');
    expect(result).toBeNull();
  });

  it('MAPS-034: returns null when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const result = await svc.fetchOverpassDetails('node', '99999');
    expect(result).toBeNull();
  });

  it('MAPS-034b: returns null when elements array is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: [] }),
      }),
    );
    const result = await svc.fetchOverpassDetails('node', '1');
    expect(result).toBeNull();
  });
});

// ── searchOverpassPois localized names (#1655) ───────────────────────────────

describe('searchOverpassPois localized names (#1655)', () => {
  // Elephant and Obelisk in Rome: OSM ships the native name plus localized tags.
  const tags = {
    name: 'Obelisco della Minerva',
    'name:en': 'Elephant and Obelisk',
    'name:de': 'Minerva-Obelisk',
    int_name: 'Elephant Obelisk',
    tourism: 'attraction',
  };
  const stubOverpass = (elementTags: Record<string, string>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: [{ type: 'node', id: 1, lat: 41.9, lon: 12.48, tags: elementTags }] }),
      }),
    );
  // Distinct bboxes per case so the module-level POI_CACHE (keyed by lang+bbox)
  // never serves one case's names to another.
  const bbox = (n: number) => ({ south: 41 + n / 100, west: 12, north: 42 + n / 100, east: 13 });

  it('prefers name:<lang> for the user language over the native name', async () => {
    stubOverpass(tags);
    const { pois } = await svc.searchOverpassPois('sights', bbox(1), 'en-US');
    expect(pois[0].name).toBe('Elephant and Obelisk');
  });

  it('localizes to a non-English language too', async () => {
    stubOverpass(tags);
    const { pois } = await svc.searchOverpassPois('sights', bbox(2), 'de-DE');
    expect(pois[0].name).toBe('Minerva-Obelisk');
  });

  it('falls back to int_name when the language tag is absent', async () => {
    stubOverpass({ name: tags.name, int_name: tags.int_name, tourism: 'attraction' });
    const { pois } = await svc.searchOverpassPois('sights', bbox(3), 'fr-FR');
    expect(pois[0].name).toBe('Elephant Obelisk');
  });

  it('skips POIs tagged as closed for good (#1341)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          elements: [
            { type: 'node', id: 1, lat: 41.9, lon: 12.48, tags: { name: 'Gone Forever', tourism: 'attraction', disused: 'yes' } },
            { type: 'node', id: 2, lat: 41.9, lon: 12.49, tags: { name: 'Ruin', tourism: 'attraction', abandoned: 'yes' } },
            { type: 'node', id: 3, lat: 41.9, lon: 12.5, tags: { name: 'Shut', tourism: 'attraction', opening_hours: 'closed' } },
            { type: 'node', id: 4, lat: 41.9, lon: 12.51, tags: { name: 'Open For Business', tourism: 'attraction' } },
          ],
        }),
      }),
    );
    const { pois } = await svc.searchOverpassPois('sights', bbox(5), 'en-US');
    expect(pois.map((p: any) => p.name)).toEqual(['Open For Business']);
  });

  it('falls back to the native name when no localized tag exists', async () => {
    stubOverpass({ name: tags.name, tourism: 'attraction' });
    const { pois } = await svc.searchOverpassPois('sights', bbox(4), 'fr-FR');
    expect(pois[0].name).toBe('Obelisco della Minerva');
  });
});

// ── fetchWikimediaPhoto (fetch stubbed) ───────────────────────────────────────

describe('fetchWikimediaPhoto (fetch stubbed)', () => {
  it('MAPS-035: returns photo from Wikipedia article image (strategy 1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: { pages: { '1': { thumbnail: { source: 'https://example.com/thumb.jpg' } } } },
        }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3, 'Eiffel Tower');
    expect(result).toBeDefined();
    expect(result!.photoUrl).toBe('https://example.com/thumb.jpg');
    expect(result!.attribution).toBe('Wikipedia');
  });

  it('MAPS-036: falls through to geosearch when Wikipedia has no thumbnail', async () => {
    const wikiResponse = { ok: true, json: async () => ({ query: { pages: { '-1': {} } } }) };
    const commonsResponse = {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [
                { url: 'https://commons.org/img.jpg', mime: 'image/jpeg', extmetadata: { Artist: { value: 'Alice' } } },
              ],
            },
          },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(wikiResponse).mockResolvedValueOnce(commonsResponse));
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3, 'Some Place');
    expect(result).toBeDefined();
    expect(result!.photoUrl).toBe('https://commons.org/img.jpg');
    expect(result!.attribution).toBe('Alice');
  });

  it('MAPS-036b: geosearch prefers the scaled thumburl over the full-res original', async () => {
    const wikiResponse = { ok: true, json: async () => ({ query: { pages: { '-1': {} } } }) };
    const commonsResponse = {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [
                {
                  url: 'https://commons.org/original-16mb.jpg',
                  thumburl: 'https://commons.org/thumb-400.jpg',
                  mime: 'image/jpeg',
                  extmetadata: { Artist: { value: 'Alice' } },
                },
              ],
            },
          },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(wikiResponse).mockResolvedValueOnce(commonsResponse));
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3, 'Some Place');
    expect(result).toBeDefined();
    expect(result!.photoUrl).toBe('https://commons.org/thumb-400.jpg');
    expect(result!.attribution).toBe('Alice');
  });

  it('MAPS-037: returns null when both strategies find nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: { pages: {} } }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result).toBeNull();
  });

  it('MAPS-037b: skips strategy 1 entirely when name is undefined', async () => {
    // Only one fetch call is made (the Commons geosearch), not two
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { pages: {} } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('MAPS-037c: falls through to geosearch when Wikipedia fetch throws', async () => {
    const commonsResponse = {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [{ url: 'https://commons.org/fallback.jpg', mime: 'image/png', extmetadata: {} }],
            },
          },
        },
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('Wikipedia network error')).mockResolvedValueOnce(commonsResponse),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3, 'Some Place');
    expect(result).toBeDefined();
    expect(result!.photoUrl).toBe('https://commons.org/fallback.jpg');
    // no Artist in extmetadata -> attribution null
    expect(result!.attribution).toBeNull();
  });

  it('MAPS-037d: falls through to geosearch when Wikipedia response is not ok', async () => {
    const wikiNotOk = { ok: false };
    const commonsResponse = {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [
                {
                  url: 'https://commons.org/photo.jpg',
                  mime: 'image/jpeg',
                  extmetadata: { Artist: { value: '<b>Bob</b>' } },
                },
              ],
            },
          },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(wikiNotOk).mockResolvedValueOnce(commonsResponse));
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3, 'Some Place');
    expect(result).toBeDefined();
    // HTML tags stripped from attribution
    expect(result!.attribution).toBe('Bob');
  });

  it('MAPS-037e: returns null when Commons geosearch returns not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result).toBeNull();
  });

  it('MAPS-037f: returns null when Commons geosearch returns no query.pages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: {} }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result).toBeNull();
  });

  it('MAPS-037g: returns null when Commons fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Commons network error')));
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result).toBeNull();
  });

  it('MAPS-037h: skips Commons page entries with non-photo MIME type (SVG)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                imageinfo: [{ url: 'https://commons.org/diagram.svg', mime: 'image/svg+xml' }],
              },
            },
          },
        }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result).toBeNull();
  });

  it('MAPS-037i: accepts PNG mime type as valid photo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                imageinfo: [
                  {
                    url: 'https://commons.org/photo.png',
                    mime: 'image/png',
                    extmetadata: { Artist: { value: 'Carol' } },
                  },
                ],
              },
            },
          },
        }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result!.photoUrl).toBe('https://commons.org/photo.png');
    expect(result!.attribution).toBe('Carol');
  });

  it('MAPS-037j: returns null attribution when Artist extmetadata is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                imageinfo: [{ url: 'https://commons.org/noattr.jpg', mime: 'image/jpeg', extmetadata: {} }],
              },
            },
          },
        }),
      }),
    );
    const result = await svc.fetchWikimediaPhoto(48.8, 2.3);
    expect(result!.attribution).toBeNull();
  });
});

// ── searchPlaces (fetch stubbed) ─────────────────────────────────────────────

describe('searchPlaces (fetch stubbed)', () => {
  it('MAPS-038: uses Nominatim when user has no API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { osm_type: 'node', osm_id: '1', lat: '48.8', lon: '2.3', display_name: 'Paris, France', name: 'Paris' },
        ],
      }),
    );
    const result = await svc.searchPlaces(999, 'Paris');
    expect(result.source).toBe('openstreetmap');
    expect(Array.isArray(result.places)).toBe(true);
  });

  // Session tokens: the keystrokes of one search and the details lookup that
  // ends it must reach Google under the same token, or every request is billed
  // on its own. The body field and the query parameter are what Google's
  // reference specifies for each half.
  it('MAPS-039f: sends the session token in the autocomplete body', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'ENCRYPTED' }).mockReturnValueOnce(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestions: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await svc.autocompletePlaces(1, 'eiff', 'en', undefined, 'sess-123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('places:autocomplete');
    expect(JSON.parse((init as { body: string }).body).sessionToken).toBe('sess-123');
  });

  it('MAPS-039g: omits the field entirely when there is no session token', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'ENCRYPTED' }).mockReturnValueOnce(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestions: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await svc.autocompletePlaces(1, 'eiff', 'en');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).not.toHaveProperty('sessionToken');
  });

  it('MAPS-039: uses Google when user has an API key', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'ENCRYPTED' }).mockReturnValueOnce(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          places: [
            {
              id: 'gid1',
              displayName: { text: 'Eiffel Tower' },
              formattedAddress: 'Paris',
              location: { latitude: 48.8, longitude: 2.3 },
              // Real search API returns a cid-style URL with no ftid → google_ftid stays null.
              googleMapsUri: 'https://maps.google.com/?cid=10403719659250533155',
            },
          ],
        }),
      }),
    );
    const result = await svc.searchPlaces(1, 'Eiffel Tower');
    expect(result.source).toBe('google');
    expect((result.places[0] as any).google_place_id).toBe('gid1');
    expect((result.places[0] as any).google_ftid).toBeNull();
  });

  it('MAPS-039b: throws with Google error status when Google API returns non-ok', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'API key invalid' } }),
      }),
    );
    await expect(svc.searchPlaces(1, 'anything')).rejects.toMatchObject({
      message: 'API key invalid',
      status: 403,
    });
  });

  it('MAPS-039h: a Google rejection logs which credential was used, never the credential (#1939)', async () => {
    mockInstanceGet.mockReturnValueOnce({ value: 'instance-secret-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'The caller does not have permission' } }),
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(svc.searchPlaces(7, 'anything')).rejects.toMatchObject({ status: 403 });
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('keySource=instance');
    expect(logged).toContain('userId=7');
    expect(logged).not.toContain('instance-secret-key');
    errorSpy.mockRestore();
  });

  it('MAPS-039c: throws with generic message when Google error has no message', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: {} }),
      }),
    );
    await expect(svc.searchPlaces(1, 'anything')).rejects.toMatchObject({
      message: 'Google Places API error',
      status: 500,
    });
  });

  it('MAPS-039d: returns empty places array when Google returns no results', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ places: [] }),
      }),
    );
    const result = await svc.searchPlaces(1, 'very obscure place');
    expect(result.source).toBe('google');
    expect(result.places).toHaveLength(0);
  });

  it('MAPS-039e: handles Google result with optional fields absent', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          // id only, no displayName, formattedAddress, location, etc.
          places: [{ id: 'gid-sparse' }],
        }),
      }),
    );
    const result = await svc.searchPlaces(1, 'sparse');
    const place = result.places[0] as any;
    expect(place.google_place_id).toBe('gid-sparse');
    expect(place.google_ftid).toBeNull();
    expect(place.name).toBe('');
    expect(place.address).toBe('');
    expect(place.lat).toBeNull();
    expect(place.lng).toBeNull();
    expect(place.rating).toBeNull();
    expect(place.website).toBeNull();
    expect(place.phone).toBeNull();
  });

  it('MAPS-183: drops permanently closed Google results and keeps the rest (#1341)', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        places: [
          { id: 'gone', displayName: { text: 'Shuttered Bistro' }, businessStatus: 'CLOSED_PERMANENTLY' },
          { id: 'holiday', displayName: { text: 'Winter Break Cafe' }, businessStatus: 'CLOSED_TEMPORARILY' },
          { id: 'open', displayName: { text: 'Still Trading' }, businessStatus: 'OPERATIONAL' },
          { id: 'park', displayName: { text: 'City Park' } },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.searchPlaces(1, 'bistro');
    expect(result.places.map((p: any) => p.google_place_id)).toEqual(['holiday', 'open', 'park']);
    // The field has to be requested or it never arrives to filter on.
    const mask = (fetchMock.mock.calls[0][1].headers as Record<string, string>)['X-Goog-FieldMask'];
    expect(mask).toContain('places.businessStatus');
  });

  it('MAPS-107: keeps 0 coordinates (equator / prime meridian) instead of nulling them', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          places: [{ id: 'gid-null-island', displayName: { text: 'Null Island' }, location: { latitude: 0, longitude: 0 } }],
        }),
      }),
    );
    const result = await svc.searchPlaces(1, 'null island');
    const place = result.places[0] as any;
    expect(place.lat).toBe(0);
    expect(place.lng).toBe(0);
  });
});

// ── autocompletePlaces (fetch stubbed) ──────────────────────────────────────

describe('autocompletePlaces (fetch stubbed)', () => {
  it('MAPS-081: uses Nominatim when user has no API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            osm_type: 'node',
            osm_id: '1',
            lat: '48.8',
            lon: '2.3',
            display_name: 'Paris, Île-de-France, France',
            name: 'Paris',
          },
        ],
      }),
    );
    const result = await svc.autocompletePlaces(999, 'Paris');
    expect(result.source).toBe('nominatim');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].mainText).toBe('Paris');
    expect(result.suggestions[0].placeId).toBe('node:1');
  });

  it('MAPS-082: uses Google when user has an API key', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'ENCRYPTED' }).mockReturnValueOnce(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [
            {
              placePrediction: {
                placeId: 'ChIJ1234',
                structuredFormat: {
                  mainText: { text: 'Eiffel Tower' },
                  secondaryText: { text: 'Paris, France' },
                },
              },
            },
          ],
        }),
      }),
    );
    const result = await svc.autocompletePlaces(1, 'Eiffel');
    expect(result.source).toBe('google');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].placeId).toBe('ChIJ1234');
    expect(result.suggestions[0].mainText).toBe('Eiffel Tower');
    expect(result.suggestions[0].secondaryText).toBe('Paris, France');
  });

  it('MAPS-083: throws with Google error status when API returns non-ok', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'API key invalid' } }),
      }),
    );
    await expect(svc.autocompletePlaces(1, 'anything')).rejects.toMatchObject({
      message: 'API key invalid',
      status: 403,
    });
  });

  it('MAPS-083b: the autocomplete rejection logs the key source too (#1939)', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'own-row-secret' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: 'nope' } }) }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(svc.autocompletePlaces(4, 'anything')).rejects.toMatchObject({ status: 403 });
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('keySource=user-row');
    expect(logged).not.toContain('own-row-secret');
    errorSpy.mockRestore();
  });

  it('MAPS-084: throws generic message when Google error has no message', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: {} }),
      }),
    );
    await expect(svc.autocompletePlaces(1, 'anything')).rejects.toMatchObject({
      message: 'Google Places Autocomplete error',
      status: 500,
    });
  });

  it('MAPS-085: returns empty suggestions when Google returns no results', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ suggestions: [] }),
      }),
    );
    const result = await svc.autocompletePlaces(1, 'very obscure place');
    expect(result.source).toBe('google');
    expect(result.suggestions).toHaveLength(0);
  });

  it('MAPS-086: filters out suggestions without placePrediction', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [
            { placePrediction: { placeId: 'A', structuredFormat: { mainText: { text: 'Good' } } } },
            { queryPrediction: { text: 'some query' } },
            { placePrediction: { placeId: 'B', structuredFormat: { mainText: { text: 'Also Good' } } } },
          ],
        }),
      }),
    );
    const result = await svc.autocompletePlaces(1, 'test');
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0].placeId).toBe('A');
    expect(result.suggestions[1].placeId).toBe('B');
  });

  it('MAPS-087: limits results to 5 suggestions', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    const manySuggestions = Array.from({ length: 10 }, (_, i) => ({
      placePrediction: {
        placeId: `id-${i}`,
        structuredFormat: { mainText: { text: `Place ${i}` } },
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ suggestions: manySuggestions }),
      }),
    );
    const result = await svc.autocompletePlaces(1, 'test');
    expect(result.suggestions).toHaveLength(5);
  });

  it('MAPS-088: includes locationBias in Google request when provided', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'test-key' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await svc.autocompletePlaces(1, 'test', 'en', { low: { lat: 48.5, lng: 2.0 }, high: { lat: 49.0, lng: 2.8 } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.locationBias).toEqual({
      rectangle: {
        low: { latitude: 48.5, longitude: 2.0 },
        high: { latitude: 49.0, longitude: 2.8 },
      },
    });
  });

  it('MAPS-089: omits locationBias from Google request when not provided', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'test-key' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await svc.autocompletePlaces(1, 'test', 'en');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.locationBias).toBeUndefined();
  });

  it('MAPS-090: handles missing structuredFormat fields gracefully', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'some-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [{ placePrediction: { placeId: 'sparse-id' } }],
        }),
      }),
    );
    const result = await svc.autocompletePlaces(1, 'sparse');
    expect(result.suggestions[0].placeId).toBe('sparse-id');
    expect(result.suggestions[0].mainText).toBe('');
    expect(result.suggestions[0].secondaryText).toBe('');
  });

  it('MAPS-091: Nominatim fallback returns empty suggestions on searchNominatim error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await svc.autocompletePlaces(999, 'fail');
    expect(result.source).toBe('nominatim');
    expect(result.suggestions).toHaveLength(0);
  });

  it('MAPS-092: Nominatim fallback splits address into mainText and secondaryText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            osm_type: 'way',
            osm_id: '42',
            lat: '51.5',
            lon: '-0.1',
            display_name: 'Big Ben, Westminster, London, UK',
            name: 'Big Ben',
          },
        ],
      }),
    );
    const result = await svc.autocompletePlaces(999, 'Big Ben');
    expect(result.suggestions[0].mainText).toBe('Big Ben');
    expect(result.suggestions[0].secondaryText).toBe('Westminster, London, UK');
  });

  it('MAPS-093: Nominatim fallback filters out results with empty osm_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { osm_type: 'node', osm_id: '1', lat: '48.8', lon: '2.3', display_name: 'Paris, France', name: 'Paris' },
          { osm_type: 'node', osm_id: '', lat: '51.5', lon: '-0.1', display_name: 'London, UK', name: 'London' },
          { osm_type: 'way', osm_id: '3', lat: '52.5', lon: '13.4', display_name: 'Berlin, Germany', name: 'Berlin' },
        ],
      }),
    );
    const result = await svc.autocompletePlaces(999, 'test');
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.map((s) => s.placeId)).toEqual(['node:1', 'way:3']);
  });
});

// ── getPlaceDetails (fetch stubbed) ─────────────────────────────────────────

describe('getPlaceDetails (fetch stubbed)', () => {
  it('MAPS-040: handles OSM placeId (way:id) via Overpass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: [{ tags: { website: 'https://eiffel.com' } }] }),
      }),
    );
    const result = await svc.getPlaceDetails(1, 'way:12345');
    expect(result.place).toBeDefined();
    expect((result.place as any).source).toBe('openstreetmap');
    expect((result.place as any).website).toBe('https://eiffel.com');
  });

  it('MAPS-040b: handles OSM placeId when Overpass returns no tags (element missing)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: [] }),
      }),
    );
    const result = await svc.getPlaceDetails(1, 'node:99999');
    expect((result.place as any).source).toBe('openstreetmap');
    expect((result.place as any).website).toBeNull();
  });

  // A Google id has no OpenStreetMap equivalent, so without a key there is
  // nothing to look up. That is an empty result, not a client error: search and
  // autocomplete already answer their keyless case with the OSM stack, and this
  // used to be the one path that threw, so an instance without a key produced a
  // 400 every time an older Google place was opened.
  it('MAPS-041: answers with an empty place when a Google id has no API key', async () => {
    mockDbGet.mockReturnValue(undefined);
    await expect(svc.getPlaceDetails(999, 'ChIJNotAnOsmId')).resolves.toEqual({ place: null });
  });

  it('MAPS-041g: the expanded lookup degrades the same way', async () => {
    mockDbGet.mockReturnValue(undefined);
    await expect(svc.getPlaceDetailsExpanded(999, 'ChIJNotAnOsmId', 'en', false)).resolves.toEqual({ place: null });
  });

  it('MAPS-041b: returns full Google place details on happy path', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJ123',
          displayName: { text: 'Eiffel Tower' },
          formattedAddress: 'Champ de Mars, 5 Av. Anatole France, 75007 Paris',
          location: { latitude: 48.8584, longitude: 2.2945 },
          rating: 4.7,
          userRatingCount: 200000,
          websiteUri: 'https://www.toureiffel.paris',
          nationalPhoneNumber: '+33 892 70 12 39',
          regularOpeningHours: {
            weekdayDescriptions: ['Monday: 9:00 AM – 12:00 AM'],
            openNow: true,
          },
          // The Places API returns a cid-style URL with no ftid, so google_ftid stays null
          // and the precise query_place_id link is used on the client instead.
          googleMapsUri: 'https://maps.google.com/?cid=10403719659250533155',
          editorialSummary: { text: 'Iconic iron tower.' },
          reviews: [
            {
              authorAttribution: { displayName: 'John', photoUri: 'https://photo.url' },
              rating: 5,
              text: { text: 'Amazing!' },
              relativePublishTimeDescription: '2 weeks ago',
            },
          ],
          photos: [{ name: 'places/ChIJ123/photos/photo1', authorAttributions: [{ displayName: 'Jane' }] }],
        }),
      }),
    );
    const result = await svc.getPlaceDetails(1, 'ChIJ123');
    const place = result.place as any;
    expect(place.google_place_id).toBe('ChIJ123');
    expect(place.google_ftid).toBeNull();
    expect(place.name).toBe('Eiffel Tower');
    expect(place.rating).toBe(4.7);
    expect(place.rating_count).toBe(200000);
    expect(place.open_now).toBe(true);
    expect(place.source).toBe('google');
    // Lean mask — reviews/summary not fetched in getPlaceDetails; use getPlaceDetailsExpanded for those
    expect(place.reviews).toHaveLength(0);
    expect(place.summary).toBeNull();
  });

  it('MAPS-041b2: normalises non-standard TREK language codes for Google (br→pt-BR, gr→el)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ChIJ1', displayName: { text: 'X' }, location: { latitude: 0, longitude: 0 } }),
    });
    mockDbGet.mockReturnValue({ maps_api_key: 'gkey' });
    vi.stubGlobal('fetch', fetchMock);

    await svc.getPlaceDetails(1, 'ChIJ-br', 'br');
    expect(String(fetchMock.mock.calls[0][0])).toContain('languageCode=pt-BR');

    await svc.getPlaceDetails(1, 'ChIJ-gr', 'gr');
    expect(String(fetchMock.mock.calls[1][0])).toContain('languageCode=el');

    // A code that is already valid passes through unchanged.
    await svc.getPlaceDetails(1, 'ChIJ-de', 'de');
    expect(String(fetchMock.mock.calls[2][0])).toContain('languageCode=de');
  });

  it('MAPS-109: defaults to English when no language is given (the legacy de default was a leftover)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ChIJ1', displayName: { text: 'X' } }),
    });
    mockDbGet.mockReturnValue({ maps_api_key: 'gkey' });
    vi.stubGlobal('fetch', fetchMock);

    await svc.getPlaceDetails(1, 'ChIJ-nolang');
    expect(String(fetchMock.mock.calls[0][0])).toContain('languageCode=en');

    // refresh=true skips the expanded-cache read (the blanket mockDbGet return
    // would otherwise be mistaken for a cached row).
    await svc.getPlaceDetailsExpanded(1, 'ChIJ-nolang-exp', undefined, true);
    expect(String(fetchMock.mock.calls[1][0])).toContain('languageCode=en');
  });

  it('MAPS-041c: throws with status when Google API returns non-ok response', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Place not found' } }),
      }),
    );
    await expect(svc.getPlaceDetails(1, 'ChIJMissing')).rejects.toMatchObject({
      message: 'Place not found',
      status: 404,
    });
  });

  it('MAPS-041d: getPlaceDetailsExpanded maps reviews with optional fields absent to null', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    // expanded=1 cache miss → return undefined
    mockDbGet.mockReturnValueOnce(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJ456',
          reviews: [
            // All optional fields absent
            {},
          ],
        }),
      }),
    );
    const result = await svc.getPlaceDetailsExpanded(1, 'ChIJ456');
    const review = (result.place as any).reviews[0];
    expect(review.author).toBeNull();
    expect(review.rating).toBeNull();
    expect(review.text).toBeNull();
    expect(review.time).toBeNull();
    expect(review.photo).toBeNull();
  });

  it('MAPS-040c: OSM path enriches name/address/coords from Nominatim (serial fetch)', async () => {
    const fetchMock = vi
      .fn()
      // First call: Overpass (returns element with tags but no coords)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ elements: [{ tags: { website: 'https://example.com' } }] }),
      })
      // Second call: Nominatim /lookup
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            osm_type: 'way',
            osm_id: '5',
            lat: '48.85',
            lon: '2.29',
            display_name: 'Eiffel Tower, Paris, France',
            name: 'Eiffel Tower',
          },
        ],
      });
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.getPlaceDetails(1, 'way:5');
    const place = result.place as any;
    expect(place.name).toBe('Eiffel Tower');
    expect(place.address).toBe('Eiffel Tower, Paris, France');
    expect(place.lat).toBeCloseTo(48.85);
    expect(place.lng).toBeCloseTo(2.29);
    expect(place.source).toBe('openstreetmap');
    // Overpass first, then Nominatim — two total fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const overpassUrl = fetchMock.mock.calls[0][0] as string;
    const nominatimUrl = fetchMock.mock.calls[1][0] as string;
    expect(overpassUrl).toContain('overpass');
    expect(nominatimUrl).toContain('nominatim');
  });

  it('MAPS-041e: open_now is null when regularOpeningHours.openNow is undefined', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJ789',
          regularOpeningHours: {
            weekdayDescriptions: ['Monday: 9:00 AM – 5:00 PM'],
            // openNow intentionally absent
          },
        }),
      }),
    );
    const result = await svc.getPlaceDetails(1, 'ChIJ789');
    expect((result.place as any).open_now).toBeNull();
  });

  it('MAPS-041f: open_now is false when regularOpeningHours.openNow is false', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJClosed',
          regularOpeningHours: {
            weekdayDescriptions: ['Monday: 9:00 AM – 5:00 PM'],
            openNow: false,
          },
        }),
      }),
    );
    const result = await svc.getPlaceDetails(1, 'ChIJClosed');
    // false is preserved (not coerced to null) via the ?? null operator
    expect((result.place as any).open_now).toBe(false);
  });

  it('MAPS-041f2: hands the structured opening periods and special days to the client', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJPeriods',
          regularOpeningHours: {
            // Localised display text — the client shows it but must not parse it.
            weekdayDescriptions: ['月曜日: 9:00～18:00'],
            openNow: true,
            periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } }],
            specialDays: [{ date: { year: 2026, month: 12, day: 25 } }],
          },
        }),
      }),
    );
    const place = (await svc.getPlaceDetails(1, 'ChIJPeriods')).place as any;
    expect(place.opening_periods).toEqual([
      { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
    ]);
    expect(place.opening_special_days).toEqual(['2026-12-25']);
    expect(place.opening_hours).toEqual(['月曜日: 9:00～18:00']);
  });

  it('MAPS-041f3: opening_periods is null when Google sends no periods', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJNoPeriods',
          regularOpeningHours: { weekdayDescriptions: ['Monday: 9:00 AM – 5:00 PM'], openNow: false },
        }),
      }),
    );
    const place = (await svc.getPlaceDetails(1, 'ChIJNoPeriods')).place as any;
    expect(place.opening_periods).toBeNull();
    expect(place.opening_special_days).toBeNull();
  });

  it('MAPS-041f4: getPlaceDetailsExpanded carries the periods too', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    // expanded=1 cache miss
    mockDbGet.mockReturnValueOnce(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJExpandedPeriods',
          // A place that never closes: one period, no close point.
          regularOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
        }),
      }),
    );
    const place = (await svc.getPlaceDetailsExpanded(1, 'ChIJExpandedPeriods')).place as any;
    expect(place.opening_periods).toEqual([{ open: { day: 0, hour: 0, minute: 0 }, close: null }]);
  });

  it('MAPS-041g: getPlaceDetailsExpanded truncates reviews to first 5 entries', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    // expanded=1 cache miss
    mockDbGet.mockReturnValueOnce(undefined);
    const manyReviews = Array.from({ length: 8 }, (_, i) => ({
      authorAttribution: { displayName: `User${i}` },
      rating: 4,
      text: { text: 'Good' },
      relativePublishTimeDescription: '1 day ago',
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ChIJMany', reviews: manyReviews }),
      }),
    );
    const result = await svc.getPlaceDetailsExpanded(1, 'ChIJMany');
    expect((result.place as any).reviews).toHaveLength(5);
  });

  // The client sends whatever id the place carries, and the expanded lookup used to
  // forward all of them — including OSM ids — to Google, which bills the 400
  // INVALID_ARGUMENT it answers with (#1727).
  it('MAPS-041h: getPlaceDetailsExpanded serves an OSM id from Overpass instead of Google', async () => {
    mockDbGet.mockReturnValue({ maps_api_key: 'gkey' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ tags: { website: 'https://nerja.example' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.getPlaceDetailsExpanded(1, 'node:5255005321');
    expect((result.place as any).source).toBe('openstreetmap');
    expect((result.place as any).website).toBe('https://nerja.example');
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('places.googleapis.com')))
      .toBe(false);
  });

  it('MAPS-041i: getPlaceDetailsExpanded answers a coordinate pseudo-id with no place at all', async () => {
    mockDbGet.mockReturnValue({ maps_api_key: 'gkey' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc.getPlaceDetailsExpanded(1, 'coords:48.8,2.3')).resolves.toEqual({ place: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── getPlacePhoto (fetch stubbed) ────────────────────────────────────────────

describe('getPlacePhoto (fetch stubbed)', () => {
  it('MAPS-042: returns proxy URL for coordinate-based lookup via Wikimedia (no API key)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // First call: Wikimedia Commons API
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            query: { pages: { '1': { thumbnail: { source: 'https://wiki.org/photo.jpg' } } } },
          }),
        })
        // Second call: fetch Wikimedia image bytes
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100),
        }),
    );
    const placeId = 'coords:48.8,2.3';
    const result = await svc.getPlacePhoto(999, placeId, 48.8, 2.3, 'Eiffel Tower');
    expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`);
    expect(mockCachePut).toHaveBeenCalledOnce();
  });

  it('MAPS-043: resolves with photoUrl null when Wikimedia returns nothing and no API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: { pages: {} } }),
      }),
    );
    await expect(svc.getPlacePhoto(999, 'coords:0.0,0.0', 0, 0)).resolves.toEqual({
      photoUrl: null,
      attribution: null,
    });
  });

  it('MAPS-043b: returns cached photo when disk cache returns a hit', async () => {
    const placeId = `coords:cache-test-${Date.now()}`;
    const cachedUrl = `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`;
    mockCacheGet.mockResolvedValue({
      photoUrl: cachedUrl,
      attribution: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await svc.getPlacePhoto(999, placeId, 48.8, 2.3, 'Cache Test');
    expect(result.photoUrl).toBe(cachedUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-043c: serves the negative cache with photoUrl null and no network request', async () => {
    mockCacheGetErrored.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const errorId = `coords:error-cache-${Date.now()}`;
    await expect(svc.getPlacePhoto(999, errorId, 0, 0)).resolves.toEqual({ photoUrl: null, attribution: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-043d: resolves with photoUrl null when lat/lng are NaN and no API key', async () => {
    const nanId = `coords:nan-test-${Date.now()}`;
    await expect(svc.getPlacePhoto(999, nanId, NaN, NaN)).resolves.toEqual({ photoUrl: null, attribution: null });
  });

  it('MAPS-043e: falls through to photoUrl null when the Wikimedia fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network fail')));
    const throwId = `coords:throw-test-${Date.now()}`;
    await expect(svc.getPlacePhoto(999, throwId, 48.8, 2.3, 'Place')).resolves.toEqual({
      photoUrl: null,
      attribution: null,
    });
  });

  it('MAPS-043f: an in-flight lookup that found nothing resolves the waiter with photoUrl null', async () => {
    mockCacheGetInFlight.mockReturnValue(Promise.resolve(null));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc.getPlacePhoto(999, 'ChIJInFlight', 48.8, 2.3)).resolves.toEqual({
      photoUrl: null,
      attribution: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-044: returns proxy URL via Google path when API key present and photos exist', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    const fetchMock = vi
      .fn()
      // First call: get place details (with photos)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            photos: [{ name: 'places/ChIJABC/photos/photo1', authorAttributions: [{ displayName: 'Photographer' }] }],
          }),
      })
      // Second call: fetch image bytes
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(200),
      });
    vi.stubGlobal('fetch', fetchMock);
    const uniqueId = `ChIJABC-${Date.now()}`;
    const result = await svc.getPlacePhoto(1, uniqueId, 48.8, 2.3, 'Place');
    expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(uniqueId)}/bytes`);
    expect(result.attribution).toBe('Photographer');
    expect(mockCachePut).toHaveBeenCalledOnce();
  });

  it('MAPS-044b: resolves with photoUrl null when Google details fetch returns non-ok', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'Forbidden' } }),
      }),
    );
    const errId = `ChIJErr-${Date.now()}`;
    await expect(svc.getPlacePhoto(1, errId, 48.8, 2.3)).resolves.toEqual({ photoUrl: null, attribution: null });
    // A rejected provider call says nothing about the place — remember it as a
    // failed attempt (minutes), not as "this place has no photo" (a day).
    expect(mockCacheMarkError).toHaveBeenCalledWith(errId, 'provider-error');
  });

  it('MAPS-044b2: remembers a place both providers came up empty for as a lasting miss', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // Google answers, the place simply has no photos.
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ photos: [] }) })
        // Wikimedia has no article near the coordinates either.
        .mockResolvedValueOnce({ ok: true, json: async () => ({ query: { pages: {} } }) }),
    );
    const emptyId = `ChIJEmpty-${Date.now()}`;
    await expect(svc.getPlacePhoto(1, emptyId, 48.8, 2.3)).resolves.toEqual({ photoUrl: null, attribution: null });
    expect(mockCacheMarkError).toHaveBeenCalledWith(emptyId, 'no-photo');
  });

  it('MAPS-044b3: a failed Wikimedia image download counts as a failed attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ query: { pages: { '1': { thumbnail: { source: 'https://wiki.org/photo.jpg' } } } } }),
        })
        .mockResolvedValueOnce({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    const downId = `coords:down-${Date.now()}`;
    await expect(svc.getPlacePhoto(999, downId, 48.8, 2.3, 'Place')).resolves.toEqual({
      photoUrl: null,
      attribution: null,
    });
    expect(mockCacheMarkError).toHaveBeenCalledWith(downId, 'provider-error');
  });

  it('MAPS-044c: resolves with photoUrl null when the Google place has no photos', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ photos: [] }),
      }),
    );
    const noPhotoId = `ChIJNone-${Date.now()}`;
    await expect(svc.getPlacePhoto(1, noPhotoId, 48.8, 2.3)).resolves.toEqual({ photoUrl: null, attribution: null });
  });

  it('MAPS-044d: resolves with photoUrl null when the media endpoint returns non-ok status', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            photos: [{ name: 'places/ChIJXYZ/photos/photo1', authorAttributions: [] }],
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    vi.stubGlobal('fetch', fetchMock);
    const noUriId = `ChIJXYZ-${Date.now()}`;
    await expect(svc.getPlacePhoto(1, noUriId, 48.8, 2.3)).resolves.toEqual({ photoUrl: null, attribution: null });
  });

  it('MAPS-044e: returns proxy URL with null attribution when authorAttributions is empty', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            photos: [{ name: 'places/ChIJNoAttr/photos/photo1', authorAttributions: [] }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(150),
      });
    vi.stubGlobal('fetch', fetchMock);
    const noAttrId = `ChIJNoAttr-${Date.now()}`;
    const result = await svc.getPlacePhoto(1, noAttrId, 48.8, 2.3);
    expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(noAttrId)}/bytes`);
    expect(result.attribution).toBeNull();
  });

  it('MAPS-044f: uses Wikimedia and returns proxy URL when API key present but placeId is coords: prefix', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            query: { pages: { '1': { thumbnail: { source: 'https://wiki.org/coords-photo.jpg' } } } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(120),
        }),
    );
    const uniqueId = `coords:44f-test-${Date.now()}`;
    const result = await svc.getPlacePhoto(1, uniqueId, 48.8, 2.3, 'Coords Place');
    expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(uniqueId)}/bytes`);
    expect(mockCachePut).toHaveBeenCalledOnce();
  });

  it('MAPS-044g: falls back to Wikipedia/OSM for a Google place_id when the Google photo call fails', async () => {
    // A key is present and the placeId is a Google id, but Google rejects the
    // photo request (e.g. 403). The lookup must still return an image via the
    // coordinate-based Wikipedia fallback instead of giving up with a 404 —
    // matching what right-click (coords:) places already do.
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // 1) Google photo details → 403
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: { message: 'PERMISSION_DENIED' } }),
        })
        // 2) Wikipedia pageimages → thumbnail
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ query: { pages: { '1': { thumbnail: { source: 'https://wiki.org/guinness.jpg' } } } } }),
        })
        // 3) image bytes
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(200),
        }),
    );
    const placeId = `ChIJFallback-${Date.now()}`;
    const result = await svc.getPlacePhoto(1, placeId, 53.34, -6.28, 'Guinness Storehouse');
    expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`);
    expect(result.attribution).toBe('Wikipedia');
    expect(mockCachePut).toHaveBeenCalledOnce();
  });

  // OSM ids are what the client sends whenever a place has no google_place_id.
  // Google rejects them with a billable 400 INVALID_ARGUMENT, so they must go
  // straight to the Wikimedia fallback like coords: ids already do.
  it.each(['node:5255005321', 'way:84527326', 'relation:345407'])(
    'MAPS-044h: skips Google for the OSM id %s even when an API key is configured',
    async (osmId) => {
      mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ query: { pages: { '1': { thumbnail: { source: 'https://wiki.org/osm.jpg' } } } } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(90),
        });
      vi.stubGlobal('fetch', fetchMock);
      const result = await svc.getPlacePhoto(1, osmId, 36.7617, -3.8448, 'Cueva de Nerja');
      expect(result.photoUrl).toBe(`/api/maps/place-photo/${encodeURIComponent(osmId)}/bytes`);
      const requested = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(requested.some((url) => url.includes('places.googleapis.com'))).toBe(false);
    },
  );

  it('MAPS-044i: an OSM id with no Wikimedia hit resolves with photoUrl null instead of a 404', async () => {
    mockDbGet.mockReturnValueOnce({ maps_api_key: 'gkey' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: { pages: {} } }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc.getPlacePhoto(1, 'node:2481346642', 36.76, -3.84, 'Nerja')).resolves.toEqual({
      photoUrl: null,
      attribution: null,
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('places.googleapis.com')))
      .toBe(false);
  });
});

describe('isGooglePlaceId', () => {
  it('MAPS-045: accepts Google place ids and rejects the ids Google cannot resolve', () => {
    expect(isGooglePlaceId('ChIJLU7jZClu5kcR4PcOOO6p3I0')).toBe(true);
    expect(isGooglePlaceId('coords:48.8,2.3')).toBe(false);
    expect(isGooglePlaceId('node:5255005321')).toBe(false);
    expect(isGooglePlaceId('way:84527326')).toBe(false);
    expect(isGooglePlaceId('relation:345407')).toBe(false);
    expect(isGooglePlaceId('https://lh3.googleusercontent.com/photo.jpg')).toBe(false);
    // The collection views send the bare coordinate pair when a place has no ids.
    expect(isGooglePlaceId('36.7617499,-3.8448432')).toBe(false);
  });
});

describe('googleFtidFromMapsUrl', () => {
  it('MAPS-FTID-001: extracts a valid ftid from a /place/?ftid= URL (resolved share link)', () => {
    expect(
      googleFtidFromMapsUrl('https://www.google.com/maps/place/?q=X&ftid=0x882bf179e806d471:0x8591dde29c821a93'),
    ).toBe('0x882bf179e806d471:0x8591dde29c821a93');
  });
  it('MAPS-FTID-002: returns null for a cid-style URL (the usual Places API shape)', () => {
    expect(googleFtidFromMapsUrl('https://maps.google.com/?cid=10403719659250533155')).toBeNull();
  });
  it('MAPS-FTID-003: rejects malformed / hostile ftid values', () => {
    expect(googleFtidFromMapsUrl('https://maps.google.com/?ftid=not-an-ftid')).toBeNull();
    expect(googleFtidFromMapsUrl('https://maps.google.com/?ftid=0xAB%26q%3Devil%3Cscript%3E')).toBeNull();
    expect(googleFtidFromMapsUrl('not a url')).toBeNull();
    expect(googleFtidFromMapsUrl(null)).toBeNull();
  });

  // #1954 — a followed maps.app.goo.gl link keeps the id in the `data=` blob, not
  // in a query parameter, which is why a pasted single link used to lose it.
  it('MAPS-FTID-004: extracts the ftid from the data= path blob of a resolved share link', () => {
    expect(
      googleFtidFromMapsUrl(
        'https://www.google.com/maps/place/Notre-Dame/data=!4m6!3m5!1s0x47e671e23a09b3b1:0x40b82c3688b2f60!8m2!3d48.8529!4d2.3499',
      ),
    ).toBe('0x47e671e23a09b3b1:0x40b82c3688b2f60');
  });

  it('MAPS-FTID-005: the query parameter still wins over the path blob', () => {
    expect(
      googleFtidFromMapsUrl(
        'https://www.google.com/maps/place/X/data=!3m5!1s0x1:0x2!8m2?ftid=0x882bf179e806d471:0x8591dde29c821a93',
      ),
    ).toBe('0x882bf179e806d471:0x8591dde29c821a93');
  });

  it('MAPS-FTID-006: ignores the path blob outside a /place/ URL', () => {
    // A directions link carries one !1s per waypoint and the first is the origin,
    // so reading it would attach the wrong place.
    expect(
      googleFtidFromMapsUrl('https://www.google.com/maps/dir/A/B/data=!4m2!1s0x47e671e23a09b3b1:0x40b82c3688b2f60'),
    ).toBeNull();
  });

  it('MAPS-FTID-007: a place URL without either shape is still null, and case is normalised', () => {
    expect(googleFtidFromMapsUrl('https://www.google.com/maps/place/Notre-Dame/@48.85,2.34,17z')).toBeNull();
    expect(
      googleFtidFromMapsUrl('https://www.google.com/maps/place/X/data=!1s0x47E671E23A09B3B1:0x40B82C3688B2F60'),
    ).toBe('0x47e671e23a09b3b1:0x40b82c3688b2f60');
  });

  it('MAPS-FTID-008: a long hostile path blob resolves in linear time (ReDoS budget)', () => {
    const hostile = `https://www.google.com/maps/place/X/data=${'!1s0x'.repeat(20000)}`;
    const started = Date.now();
    expect(googleFtidFromMapsUrl(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ── buildUserAgent (instance-specific UA, #1309) ──────────────────────────────

describe('buildUserAgent', () => {
  const base = 'TREK Travel Planner (https://github.com/liketrek/TREK)';

  it('MAPS-094: returns the bare base UA when no instance URL is configured', () => {
    expect(buildUserAgent(undefined)).toBe(base);
    expect(buildUserAgent('')).toBe(base);
  });

  it('MAPS-095: appends a configured https instance URL so the deployment is identifiable', () => {
    expect(buildUserAgent('https://trek.example.org')).toBe(`${base}; https://trek.example.org`);
  });

  it('MAPS-096: drops the http://localhost fallback — it is not a unique identifier', () => {
    expect(buildUserAgent('http://localhost:3001')).toBe(base);
  });
});

// ── resolveOverpassEndpoints (OVERPASS_URL override, #1309) ────────────────────

describe('resolveOverpassEndpoints', () => {
  it('MAPS-097: falls back to the public mirrors when OVERPASS_URL is unset/empty', () => {
    expect(resolveOverpassEndpoints(undefined).length).toBeGreaterThan(1);
    expect(resolveOverpassEndpoints('').length).toBeGreaterThan(1);
    expect(resolveOverpassEndpoints(undefined)[0]).toContain('overpass-api.de');
  });

  it('MAPS-098: a single custom endpoint REPLACES the public mirrors (locked-down egress)', () => {
    expect(resolveOverpassEndpoints('https://overpass.internal/api/interpreter')).toEqual([
      'https://overpass.internal/api/interpreter',
    ]);
  });

  it('MAPS-099: parses a comma-separated list and trims whitespace', () => {
    expect(resolveOverpassEndpoints(' https://a.test/api , http://b.test/api ')).toEqual([
      'https://a.test/api',
      'http://b.test/api',
    ]);
  });

  it('MAPS-100: drops non-http(s) / malformed entries, keeping the valid ones', () => {
    expect(resolveOverpassEndpoints('https://ok.test/api, ftp://no.test, not a url')).toEqual(['https://ok.test/api']);
  });

  it('MAPS-101: falls back to the defaults when every custom entry is invalid', () => {
    expect(resolveOverpassEndpoints('not a url, ftp://no.test').length).toBeGreaterThan(1);
  });
});

// ── resolveOverpassTimeoutMs (OVERPASS_TIMEOUT_MS override, #1309) ─────────────

describe('resolveOverpassTimeoutMs', () => {
  it('MAPS-104: falls back to the 12s default for unset / empty / non-numeric values', () => {
    expect(resolveOverpassTimeoutMs(undefined)).toBe(12000);
    expect(resolveOverpassTimeoutMs('')).toBe(12000);
    expect(resolveOverpassTimeoutMs('abc')).toBe(12000);
  });

  it('MAPS-105: honours a positive numeric override', () => {
    expect(resolveOverpassTimeoutMs('30000')).toBe(30000);
  });

  it('MAPS-106: rejects 0, negative and Infinity — a non-positive cap would 502 every search', () => {
    expect(resolveOverpassTimeoutMs('0')).toBe(12000);
    expect(resolveOverpassTimeoutMs('-5')).toBe(12000);
    expect(resolveOverpassTimeoutMs('Infinity')).toBe(12000);
  });
});

// ── searchOverpassPois error path (all endpoints down, #1309) ──────────────────

describe('searchOverpassPois all-endpoints-down', () => {
  const bbox = { south: -41.2, west: 146.31, north: -41.16, east: 146.37 };

  it('MAPS-102: surfaces a 502 with a clear message when every Overpass endpoint fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(svc.searchOverpassPois('restaurant', bbox)).rejects.toMatchObject({
      status: 502,
      message: 'Could not reach any Overpass endpoint',
    });
    errSpy.mockRestore();
  });

  it('MAPS-103: logs each endpoint failure so an operator can diagnose blocked egress', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(svc.searchOverpassPois('bar', bbox)).rejects.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[Overpass] all'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    errSpy.mockRestore();
  });
});

// ── Wrapper surface (kept from the pre-fold wrapper suite) ────────────────────

/** A DatabaseService stub whose get() returns the row the test wants. */
function makeSettingsDb(row?: { value: string }) {
  const get = vi.fn(() => row);
  return { db: { get } as unknown as DatabaseService, get };
}

function settingsSvc(row?: { value: string }) {
  return new MapsService(makeSettingsDb(row).db, photoCacheStub);
}

describe('kill-switch settings reads', () => {
  it('reports a switch disabled when the stored value is exactly "false"', () => {
    expect(settingsSvc({ value: 'false' }).autocompleteDisabled()).toBe(true);
    expect(settingsSvc({ value: 'false' }).detailsDisabled()).toBe(true);
    expect(settingsSvc({ value: 'false' }).photosDisabled()).toBe(true);
  });

  it('reports enabled when the value is "true"', () => {
    expect(settingsSvc({ value: 'true' }).autocompleteDisabled()).toBe(false);
    expect(settingsSvc({ value: 'true' }).detailsDisabled()).toBe(false);
    expect(settingsSvc({ value: 'true' }).photosDisabled()).toBe(false);
  });

  it('reports enabled when the setting row is absent', () => {
    expect(settingsSvc(undefined).autocompleteDisabled()).toBe(false);
    expect(settingsSvc(undefined).detailsDisabled()).toBe(false);
    expect(settingsSvc(undefined).photosDisabled()).toBe(false);
  });

  it('queries the matching app_settings key', () => {
    const { db: settingsDb, get } = makeSettingsDb({ value: 'true' });
    const s = new MapsService(settingsDb, photoCacheStub);
    s.autocompleteDisabled();
    expect(get).toHaveBeenCalledWith(expect.stringContaining('app_settings'), 'places_autocomplete_enabled');
    s.detailsDisabled();
    expect(get).toHaveBeenCalledWith(expect.any(String), 'places_details_enabled');
    s.photosDisabled();
    expect(get).toHaveBeenCalledWith(expect.any(String), 'places_photos_enabled');
  });
});

describe('photoBytesKey', () => {
  it('returns the cached storage name from placePhotoCache', () => {
    mockServeFilePath.mockReturnValue('abc.jpg');
    expect(svc.photoBytesKey('p1')).toBe('abc.jpg');
    expect(mockServeFilePath).toHaveBeenCalledWith('p1');
  });

  it('returns null when nothing is cached', () => {
    mockServeFilePath.mockReturnValue(null);
    expect(svc.photoBytesKey('p1')).toBeNull();
  });
});

describe('controller-facing wrappers delegate to the folded methods', () => {
  it('search/autocomplete/details/detailsExpanded/photo/reverse/resolveUrl/pois forward their args', async () => {
    const spies = {
      searchPlaces: vi.spyOn(MapsService.prototype, 'searchPlaces').mockResolvedValue({ places: [], source: 'osm' }),
      autocompletePlaces: vi.spyOn(MapsService.prototype, 'autocompletePlaces').mockResolvedValue({ suggestions: [], source: 'osm' }),
      getPlaceDetails: vi.spyOn(MapsService.prototype, 'getPlaceDetails').mockResolvedValue({ place: {} }),
      getPlaceDetailsExpanded: vi.spyOn(MapsService.prototype, 'getPlaceDetailsExpanded').mockResolvedValue({ place: {} }),
      getPlacePhoto: vi.spyOn(MapsService.prototype, 'getPlacePhoto').mockResolvedValue({ photoUrl: null, attribution: null }),
      reverseGeocode: vi.spyOn(MapsService.prototype, 'reverseGeocode').mockResolvedValue({ name: null, address: null }),
      resolveGoogleMapsUrl: vi.spyOn(MapsService.prototype, 'resolveGoogleMapsUrl').mockResolvedValue({ lat: 1, lng: 2, name: null, address: null, google_ftid: null }),
      searchOverpassPois: vi.spyOn(MapsService.prototype, 'searchOverpassPois').mockResolvedValue({ pois: [], source: 'openstreetmap', truncated: false, clamped: false }),
    };
    try {
      const circleBias = { lat: 1, lng: 2, radius: 5 };
      await svc.search(3, 'berlin', 'de', circleBias);
      expect(spies.searchPlaces).toHaveBeenCalledWith(3, 'berlin', 'de', circleBias);

      const rectBias = { low: { lat: 1, lng: 2 }, high: { lat: 3, lng: 4 } };
      await svc.autocomplete(3, 'be', 'en', rectBias);
      expect(spies.autocompletePlaces).toHaveBeenCalledWith(3, 'be', 'en', rectBias, undefined);

      await svc.details(3, 'p1', 'de');
      expect(spies.getPlaceDetails).toHaveBeenCalledWith(3, 'p1', 'de', undefined);

      await svc.detailsExpanded(3, 'p1', 'de', true);
      expect(spies.getPlaceDetailsExpanded).toHaveBeenCalledWith(3, 'p1', 'de', true);

      await svc.photo(3, 'p1', 1.5, 2.5, 'Spot');
      expect(spies.getPlacePhoto).toHaveBeenCalledWith(3, 'p1', 1.5, 2.5, 'Spot');

      await svc.reverse('1', '2', 'de');
      expect(spies.reverseGeocode).toHaveBeenCalledWith('1', '2', 'de');

      await svc.resolveUrl('https://maps.app.goo.gl/x');
      expect(spies.resolveGoogleMapsUrl).toHaveBeenCalledWith('https://maps.app.goo.gl/x');

      const bbox = { south: 1, west: 2, north: 3, east: 4 };
      await svc.pois('cafe', bbox, 'de');
      expect(spies.searchOverpassPois).toHaveBeenCalledWith('cafe', bbox, 'de');
    } finally {
      Object.values(spies).forEach((s) => s.mockRestore());
    }
  });
});

// The maps.bridge delegation cases (MAPS-104..106) died with the bridge itself:
// its last two consumers — the legacy placeEnrichment helper and the places MCP
// registrar — both folded into the DI-native places domain, which injects
// MapsService directly.

// ── Enrichment primitives (MAPS-111..) ───────────────────────────────────────

describe('stripWikiMarkup', () => {
  it('MAPS-111: reduces a Commons author fragment to plain text', () => {
    expect(stripWikiMarkup('<a href="/wiki/User:Alice" title="User:Alice">Alice</a>')).toBe('Alice');
    expect(stripWikiMarkup('<span class="fn">Bob</span>&nbsp;/&nbsp;<i>Studio</i>')).toBe('Bob / Studio');
  });

  it('MAPS-112: turns empty, absent and markup-only values into null', () => {
    expect(stripWikiMarkup(undefined)).toBeNull();
    expect(stripWikiMarkup(null)).toBeNull();
    expect(stripWikiMarkup('')).toBeNull();
    expect(stripWikiMarkup('  ')).toBeNull();
    expect(stripWikiMarkup('<span></span>')).toBeNull();
  });
});

describe('parseWikipediaTag', () => {
  it('MAPS-113: splits the "lang:Title" spelling', () => {
    expect(parseWikipediaTag('de:Museum Ludwig')).toEqual({ lang: 'de', title: 'Museum Ludwig' });
    expect(parseWikipediaTag('  en:Eiffel Tower  ')).toEqual({ lang: 'en', title: 'Eiffel Tower' });
    // Article titles may themselves contain a colon ("de:Portal:Köln").
    expect(parseWikipediaTag('de:Portal:Köln')).toEqual({ lang: 'de', title: 'Portal:Köln' });
    expect(parseWikipediaTag('zh-yue:香港')).toEqual({ lang: 'zh-yue', title: '香港' });
  });

  it('MAPS-114: refuses spellings that would send us to the wrong wiki', () => {
    // A bare title has no language, and guessing one picks an article at random.
    expect(parseWikipediaTag('Museum Ludwig')).toBeNull();
    expect(parseWikipediaTag('de:')).toBeNull();
    expect(parseWikipediaTag('')).toBeNull();
    expect(parseWikipediaTag(undefined)).toBeNull();
  });
});

describe('buildOsmDetails wiki tags', () => {
  it('MAPS-115: carries wikipedia/wikidata through instead of dropping them', () => {
    const withTags = buildOsmDetails({ wikipedia: 'de:Museum Ludwig', wikidata: 'Q160236' }, 'way', '42');
    expect(withTags.wikipedia).toBe('de:Museum Ludwig');
    expect(withTags.wikidata).toBe('Q160236');

    const without = buildOsmDetails({ name: 'Kiosk' }, 'node', '7');
    expect(without.wikipedia).toBeNull();
    expect(without.wikidata).toBeNull();
  });
});

describe('isGooglePlaceId with enrichment candidate keys', () => {
  it('MAPS-116: rejects "<placeId>~pN" keys so a candidate never reaches Google', () => {
    // Google bills the 400 it answers these with — see NON_GOOGLE_PLACE_ID.
    expect(isGooglePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4~p0')).toBe(false);
    expect(isGooglePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4~p12')).toBe(false);
    // The bare id still resolves, and a tilde that is not a candidate suffix does not disarm it.
    expect(isGooglePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(true);
    expect(isGooglePlaceId('ChIJabc~photo')).toBe(true);
  });
});

describe('fetchCommonsCandidates (fetch stubbed)', () => {
  const page = (over: Record<string, unknown> = {}) => ({
    imageinfo: [
      {
        url: 'https://commons.org/original.jpg',
        thumburl: 'https://commons.org/thumb.jpg',
        mime: 'image/jpeg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
        extmetadata: {
          Artist: { value: '<a href="/wiki/User:Alice">Alice</a>' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
        },
        ...over,
      },
    ],
  });

  it('MAPS-117: returns every usable image with its licence metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: { pages: { '1': page(), '2': page({ thumburl: 'https://commons.org/t2.jpg' }) } } }),
      }),
    );
    const out = await svc.fetchCommonsCandidates(48.8, 2.3, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      photoUrl: 'https://commons.org/thumb.jpg',
      attribution: 'Alice',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    });
    // The page id travels with the candidate: it is what identifies the file
    // across the four routes that can reach it, and what keys its cached bytes.
    expect(out[0].pageId).toBe(1);
  });

  it('MAPS-118: falls back to UsageTerms when there is no short licence name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': page({
                extmetadata: { UsageTerms: { value: '<b>Public domain</b>' } },
              }),
            },
          },
        }),
      }),
    );
    const out = await svc.fetchCommonsCandidates(48.8, 2.3);
    expect(out[0].license).toBe('Public domain');
    expect(out[0].attribution).toBeNull();
    expect(out[0].licenseUrl).toBeNull();
  });

  it('MAPS-119: skips SVGs, PDFs and entries without a URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': page({ mime: 'image/svg+xml' }),
              '2': page({ mime: 'application/pdf' }),
              '3': { imageinfo: [{ mime: 'image/jpeg' }] },
              '4': {},
              '5': page({ mime: 'image/png', thumburl: undefined }),
            },
          },
        }),
      }),
    );
    const out = await svc.fetchCommonsCandidates(48.8, 2.3);
    expect(out).toHaveLength(1);
    expect(out[0].photoUrl).toBe('https://commons.org/original.jpg');
  });

  it('MAPS-120: asks for more than the strip needs and clamps to what Commons accepts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { pages: { '1': page(), '2': page(), '3': page() } } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Overfetch on purpose: the first hits around anything worth visiting are
    // survey tiles and the building next door, and the ranker can only reject
    // from a pool. Geosearch bills the same for one result as for twenty, so
    // the whole pool comes back and gets cut after ranking, not before.
    expect(await svc.fetchCommonsCandidates(48.8, 2.3, 2)).toHaveLength(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain('ggslimit=8');

    await svc.fetchCommonsCandidates(48.8, 2.3, 0);
    expect(String(fetchMock.mock.calls[1][0])).toContain('ggslimit=8');

    await svc.fetchCommonsCandidates(48.8, 2.3, 99);
    expect(String(fetchMock.mock.calls[2][0])).toContain('ggslimit=20');
  });

  it('MAPS-121: returns an empty list on a bad response, missing pages or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await svc.fetchCommonsCandidates(1, 2)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: {} }) }));
    expect(await svc.fetchCommonsCandidates(1, 2)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchCommonsCandidates(1, 2)).toEqual([]);
  });
});

describe('fetchWikiExtract (fetch stubbed)', () => {
  const page = (title: string, extract: string) => ({
    ok: true,
    json: async () => ({ query: { pages: { '1': { title, extract } } } }),
  });
  const noArticle = { ok: true, json: async () => ({ query: { pages: { '-1': { title: 'X' } } } }) };

  it('MAPS-122: asks Wikivoyage first, because it writes for travellers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page('Museum Ludwig', '  Ein Museum in Köln.  '));
    vi.stubGlobal('fetch', fetchMock);

    const out = await svc.fetchWikiExtract('de:Museum Ludwig');
    expect(out).toEqual({
      text: 'Ein Museum in Köln.',
      sourceUrl: 'https://de.wikivoyage.org/wiki/Museum%20Ludwig',
      source: 'wikivoyage',
    });
    // Host follows the tag, and Wikipedia is never asked once Wikivoyage answered.
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://de.wikivoyage.org/w/api.php');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('MAPS-122b: falls through to Wikipedia when Wikivoyage has no article', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noArticle)
      .mockResolvedValueOnce(page('Museum Ludwig', 'Das Museum Ludwig ist ein Museum.'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await svc.fetchWikiExtract('de:Museum Ludwig');
    expect(out).toMatchObject({ source: 'wikipedia' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('https://de.wikipedia.org/w/api.php');
  });

  it('MAPS-122c: asks for two sentences, not a whole lead section', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page('X', 'Kurz.'));
    vi.stubGlobal('fetch', fetchMock);

    await svc.fetchWikiExtract('de:X');
    expect(String(fetchMock.mock.calls[0][0])).toContain('exsentences=2');
  });

  it('MAPS-123: prefers the resolved title so a redirect links to where it landed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page('Eiffel Tower', 'A tower.')));
    const out = await svc.fetchWikiExtract('en:Eiffelturm');
    expect(out!.sourceUrl).toBe('https://en.wikivoyage.org/wiki/Eiffel%20Tower');
  });

  it('MAPS-124: returns null without calling out when the tag has no language', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await svc.fetchWikiExtract('Museum Ludwig')).toBeNull();
    expect(await svc.fetchWikiExtract(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-125: treats a miss on both wikis as no description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noArticle));
    expect(await svc.fetchWikiExtract('de:X')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await svc.fetchWikiExtract('de:X')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await svc.fetchWikiExtract('de:X')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchWikiExtract('de:X')).toBeNull();
  });

  it('MAPS-125b: still tries Wikipedia after Wikivoyage threw', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page('X', 'Ein Ort.'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await svc.fetchWikiExtract('de:X')).toMatchObject({ source: 'wikipedia' });
  });
});

describe('fetchCommonsCategoryCandidates (fetch stubbed)', () => {
  it('MAPS-125c: reads a category, which is pictures OF a place rather than near it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [
                {
                  url: 'https://commons.org/o.jpg',
                  thumburl: 'https://commons.org/t.jpg',
                  mime: 'image/jpeg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:T.jpg',
                  extmetadata: { Artist: { value: 'Alice' }, LicenseShortName: { value: 'CC BY 4.0' } },
                },
              ],
            },
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await svc.fetchCommonsCategoryCandidates('Category:Museum Ludwig', 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ photoUrl: 'https://commons.org/t.jpg', attribution: 'Alice', license: 'CC BY 4.0' });
    // Ranked search, not the category listing: `categorymembers` orders by sort
    // key, i.e. alphabetically by file name, and that put an .ogg pronunciation
    // and six near-identical press shots at the head of the Brandenburg Gate
    // category. The search index at least ranks by how well a file matches.
    expect(String(fetchMock.mock.calls[0][0])).toContain('gsrsearch=incategory%3A%22Museum+Ludwig%22');
  });

  it('MAPS-125d: takes the bare category name whether or not the tag is prefixed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: { pages: {} } }) });
    vi.stubGlobal('fetch', fetchMock);

    await svc.fetchCommonsCategoryCandidates('Museum Ludwig');
    expect(String(fetchMock.mock.calls[0][0])).toContain('incategory%3A%22Museum+Ludwig%22');
    // Empty search falls through to the category listing as a second chance.
    expect(String(fetchMock.mock.calls[1][0])).toContain('gcmtitle=Category%3AMuseum+Ludwig');
  });

  it('MAPS-125f: refuses a tag that names a file rather than a category', async () => {
    // Mappers do put `File:…` in wikimedia_commons. Prefixing it blindly asked
    // Commons for `Category:File:X.jpg`, which matches nothing and fell through
    // to the coordinate search without a word.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await svc.fetchCommonsCategoryCandidates('File:Museum Ludwig.jpg')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-125g: strips a localised category prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: { pages: {} } }) });
    vi.stubGlobal('fetch', fetchMock);

    await svc.fetchCommonsCategoryCandidates('Kategorie:Museum Ludwig');
    expect(String(fetchMock.mock.calls[0][0])).toContain('incategory%3A%22Museum+Ludwig%22');
  });

  it('MAPS-125e: yields nothing on an error response or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await svc.fetchCommonsCategoryCandidates('Category:X')).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchCommonsCategoryCandidates('Category:X')).toEqual([]);
  });
});

describe('fetchGooglePhotoRefs (fetch stubbed)', () => {
  it('MAPS-126: returns capped references with their author attribution', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        photos: [
          { name: 'places/p/photos/a', authorAttributions: [{ displayName: 'Alice' }] },
          { name: 'places/p/photos/b', authorAttributions: [] },
          { name: 'places/p/photos/c' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await svc.fetchGooglePhotoRefs('ChIJabc', 'key', 2);
    expect(out).toEqual([
      { name: 'places/p/photos/a', attribution: 'Alice' },
      { name: 'places/p/photos/b', attribution: null },
    ]);
    // One billed Details call for the whole strip, and only the photos field.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-FieldMask']).toBe('photos');
  });

  it('MAPS-127: never calls Google for an id Google cannot resolve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await svc.fetchGooglePhotoRefs('node:123', 'key', 3)).toEqual([]);
    expect(await svc.fetchGooglePhotoRefs('ChIJabc~p1', 'key', 3)).toEqual([]);
    expect(await svc.fetchGooglePhotoRefs('ChIJabc', 'key', 0)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAPS-128: yields nothing on an error response, a photo-less place or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await svc.fetchGooglePhotoRefs('ChIJabc', 'key', 3)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await svc.fetchGooglePhotoRefs('ChIJabc', 'key', 3)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchGooglePhotoRefs('ChIJabc', 'key', 3)).toEqual([]);
  });
});

describe('fetchGooglePhotoBytes (fetch stubbed)', () => {
  it('MAPS-129: downloads the media for one reference at the requested height', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await svc.fetchGooglePhotoBytes('places/p/photos/a', 'key', 600);
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes!.length).toBe(3);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://places.googleapis.com/v1/places/p/photos/a/media?maxHeightPx=600',
    );
  });

  it('MAPS-130: returns null for an error response, an empty body or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }));
    expect(await svc.fetchGooglePhotoBytes('places/p/photos/a', 'key')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    expect(await svc.fetchGooglePhotoBytes('places/p/photos/a', 'key')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchGooglePhotoBytes('places/p/photos/a', 'key')).toBeNull();
  });
});

describe('fetchEditorialSummary (fetch stubbed)', () => {
  it('MAPS-131: asks only for the summary, not for reviews', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ editorialSummary: { text: '  A museum in Cologne.  ' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await svc.fetchEditorialSummary('ChIJabc', 'key', 'de')).toBe('A museum in Cologne.');
    // reviews would move this into the Enterprise SKU — see the method comment.
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-FieldMask']).toBe('editorialSummary');
    expect(String(fetchMock.mock.calls[0][0])).toContain('languageCode=de');
  });

  it('MAPS-132: skips non-Google ids and swallows every miss', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await svc.fetchEditorialSummary('node:1', 'key')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await svc.fetchEditorialSummary('ChIJabc', 'key')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await svc.fetchEditorialSummary('ChIJabc', 'key')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await svc.fetchEditorialSummary('ChIJabc', 'key')).toBeNull();
  });
});

describe('withPhotoFetchSlot', () => {
  it('MAPS-133: caps concurrent fetches at five and lets queued work through', async () => {
    // Settling a release hands the slot to a queued run, which then parks on its
    // own barrier — several microtasks later. Draining needs a real turn of the
    // loop between waves, not a bare `await Promise.resolve()`.
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    let active = 0;
    let peak = 0;
    let started = 0;
    const release: Array<() => void> = [];

    const runs = Array.from({ length: 8 }, () =>
      withPhotoFetchSlot(async () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active--;
        return 'ok';
      }),
    );

    await tick();
    expect(started).toBe(5);
    expect(peak).toBe(5);

    while (release.length) {
      release.shift()!();
      await tick();
    }

    expect(await Promise.all(runs)).toEqual(Array(8).fill('ok'));
    expect(started).toBe(8);
    // The cap held across the whole run, not just the first wave.
    expect(peak).toBe(5);
  });

  it('MAPS-134: releases the slot when the work throws', async () => {
    await expect(
      withPhotoFetchSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The slot came back, so the next caller runs immediately.
    await expect(withPhotoFetchSlot(async () => 'free')).resolves.toBe('free');
  });
});

/**
 * MAPS-135..146 — the Commons ranker and the identity tags.
 *
 * Every fixture here is a real payload recorded while working out why the
 * picker showed runways and train front-ends for Hamburg Airport, Berlin
 * Hauptbahnhof and the Brandenburg Gate.
 */
describe('rankCommonsCandidates', () => {
  const pic = (over: Partial<RankableCommonsCandidate> & { pageId: number }): RankableCommonsCandidate => ({
    title: `File:pic ${over.pageId}.jpg`,
    attribution: 'Someone',
    width: 1600,
    height: 1200,
    descriptors: null,
    photoUrl: `https://commons/thumb/${over.pageId}.jpg`,
    ...over,
  });

  it('MAPS-135: drops a file that reached us twice under different thumbnail urls', () => {
    const first = pic({ pageId: 47529341, photoUrl: 'https://commons/x.jpg?utm_source=commons.wikimedia.org' });
    const again = { ...first, photoUrl: 'https://commons/x.jpg?utm_source=de.wikipedia.org' };
    expect(rankCommonsCandidates([first, again], 5)).toHaveLength(1);
  });

  it('MAPS-136: rejects the aerial survey tiles that fill an airport geosearch', () => {
    const tiles = [2013, 2015, 2016, 2019].map((year, i) =>
      pic({
        pageId: 100 + i,
        title: `File:Dop20rgb 32565 5943 ${year}.jpg`,
        attribution: 'Landesbetrieb Geoinformation Hamburg',
        width: 5000,
        height: 5000,
        descriptors: `Orthophoto Sommerbefliegung ${year}`,
      }),
    );
    expect(rankCommonsCandidates(tiles, 5)).toEqual([]);
  });

  it('MAPS-137: rejects noise maps and terminal layouts from a category', () => {
    const docs = [
      pic({ pageId: 200, title: 'File:Lärmkarte Flughafen Hamburg.png' }),
      pic({ pageId: 201, title: 'File:EDDH HAM Layout.png' }),
      pic({ pageId: 202, title: 'File:Grundriss Terminal 1.jpg' }),
    ];
    expect(rankCommonsCandidates(docs, 5)).toEqual([]);
  });

  it('MAPS-138: keeps one frame of a camera burst, not four', () => {
    // The four shots that filled the Brandenburg Gate picker were one person
    // walking through a station concourse.
    const burst = [807, 808, 809, 810].map((n) =>
      pic({ pageId: 300 + n, title: `File:Hauptbahnhof Berlin interior 0${n}.jpg`, attribution: 'Dosseman' }),
    );
    const kept = rankCommonsCandidates(burst, 5);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('File:Hauptbahnhof Berlin interior 0807.jpg');
  });

  it('MAPS-139: collapses a press set numbered with trailing counters', () => {
    const set = [16, 17, 18, 19, 20, 21].map((n) =>
      pic({ pageId: 400 + n, title: `File:Alexander Schallenberg in Berlin on 7 June 2024 - ${n}.jpg` }),
    );
    expect(rankCommonsCandidates(set, 5)).toHaveLength(1);
  });

  it('MAPS-140: caps how much of the strip one author may supply', () => {
    // Unrelated titles, same photographer — the series rule cannot see these,
    // only the author cap can. On the coordinate rung nothing vouches that the
    // pictures are even of the right subject, so variety is the only defence
    // and one contributor gets one slot; a curated rung gets two.
    const same = ['Rear entrance', 'Platform at dusk', 'Ticket hall'].map((subject, i) =>
      pic({ pageId: 500 + i, title: `File:${subject}.jpg`, attribution: 'Bahnthaler' }),
    );
    expect(rankCommonsCandidates(same, 5, { perAuthor: 1 })).toHaveLength(1);
    expect(rankCommonsCandidates(same, 5, { perAuthor: 2 })).toHaveLength(2);
  });

  it('MAPS-140b: the series rule catches a numbered pair before the author cap does', () => {
    // "Berlin-Hamburg-Express 1/2.JPG", both by Bahnthaler — two files, one
    // subject. This is the pair that filled the Berlin Hauptbahnhof picker.
    const pair = [1, 2].map((n) =>
      pic({ pageId: 510 + n, title: `File:Berlin-Hamburg-Express ${n}.JPG`, attribution: 'Bahnthaler' }),
    );
    expect(rankCommonsCandidates(pair, 5, { perAuthor: 2 })).toHaveLength(1);
  });

  it('MAPS-141: rejects panorama strips that would crop to nothing in a square tile', () => {
    expect(rankCommonsCandidates([pic({ pageId: 600, width: 9000, height: 1200 })], 5)).toEqual([]);
  });

  it('MAPS-142: keeps a large square photo that is not a survey tile', () => {
    const square = pic({ pageId: 601, width: 1200, height: 1200 });
    expect(rankCommonsCandidates([square], 5)).toHaveLength(1);
  });

  it('MAPS-143: falls back to the url when a candidate carries no page id', () => {
    const noId = { ...pic({ pageId: 0 }), pageId: null };
    expect(rankCommonsCandidates([noId, { ...noId }], 5)).toHaveLength(1);
  });

  it('MAPS-144: stops at the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      pic({ pageId: 700 + i, title: `File:Distinct subject ${String.fromCharCode(97 + i)}.jpg`, attribution: `Author ${i}` }),
    );
    expect(rankCommonsCandidates(many, 3)).toHaveLength(3);
  });
});

describe('readWikiIdentity', () => {
  it('MAPS-145: reads the three identity tags and nothing else', () => {
    expect(
      readWikiIdentity({
        wikidata: 'Q82425',
        wikipedia: 'de:Brandenburger Tor',
        wikimedia_commons: 'Category:Brandenburg Gate',
        cuisine: 'italian',
      }),
    ).toEqual({
      wikidata: 'Q82425',
      wikipedia: 'de:Brandenburger Tor',
      wikimedia_commons: 'Category:Brandenburg Gate',
    });
  });

  it('MAPS-146: ignores brand tags, which describe the chain and not the branch', () => {
    // Real payload for "L'Osteria Rostock": following brand:wikidata would
    // describe (and illustrate) L'Osteria the company.
    const identity = readWikiIdentity({
      'brand:wikidata': 'Q17323478',
      'brand:wikipedia': 'de:L’Osteria',
      cuisine: 'pizza',
    });
    expect(identity).toEqual({ wikidata: null, wikipedia: null, wikimedia_commons: null });
  });
});
