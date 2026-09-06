/**
 * Unit tests for the optional Google transit backend (#1699) — the Routes API
 * plan and the Places Text Search picker that answer /api/transit when an admin
 * switches the instance over.
 *
 * Coverage centres on the three things that are easy to get wrong and expensive
 * to get wrong: the activation chain (setting AND key, else Transitous), the
 * mapping from Google's step list onto TREK's compact itinerary — Google gives
 * no journey-level clock, so start/end are derived from the scheduled legs —
 * and the request shape, whose field masks are what the install is billed for.
 *
 * The response cache is module-scoped, so each case uses its own coordinates
 * and clearGoogleTransitCache() runs between tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleTransitProvider, clearGoogleTransitCache } from '../../../src/nest/transit/google-transit.provider';
import { decodePolyline, encodePolyline } from '../../../src/nest/transit/transit.helpers';
import { TransitService } from '../../../src/nest/transit/transit.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';

vi.mock('../../../src/app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/app-config')>();
  return {
    ...actual,
    getAppUrl: () => 'https://trek.example.com',
    // No operator-env key, so resolveApiKey falls through to the stub DB below.
    readEnv: () => ({ ...actual.readEnv(), maps: { ...actual.readEnv().maps, placesApiKey: undefined } }),
  };
});

const fetchMock = vi.fn();

/** app_settings reads only — the transit provider name and the instance Places key. */
function stubDb(settings: Record<string, string | undefined>): DatabaseService {
  return {
    get: (_sql: string, ...params: unknown[]) => {
      const value = settings[String(params[0])];
      return value === undefined ? undefined : { value };
    },
    run: () => undefined,
  } as unknown as DatabaseService;
}

const googleDb = () => stubDb({ transit_provider: 'google', maps_api_key: 'test-key' });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearGoogleTransitCache();
});
afterEach(() => vi.unstubAllGlobals());

function okJson(data: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
}

function lastHeaders(): Record<string, string> {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].headers;
}

/**
 * The fixture's own shape, spelled out rather than inferred: cases below drop a
 * stop name or a whole stopDetails to exercise the fallbacks, which an inferred
 * literal type forbids.
 */
type FixtureLatLng = { latLng: { latitude: number; longitude: number } };
type FixtureStop = { name?: string; location?: FixtureLatLng };
interface FixtureRoutes {
  routes: Array<{
    legs: Array<{
      steps: Array<{
        travelMode: string;
        staticDuration?: string;
        distanceMeters?: number;
        startLocation?: FixtureLatLng;
        endLocation?: FixtureLatLng;
        polyline?: { encodedPolyline: string };
        transitDetails?: {
          stopDetails: {
            departureStop?: FixtureStop;
            departureTime?: string;
            arrivalStop?: FixtureStop;
            arrivalTime?: string;
          };
          headsign?: string;
          stopCount?: number;
          transitLine: {
            name?: string;
            nameShort?: string;
            color?: string;
            textColor?: string;
            agencies?: Array<{ name: string }>;
            vehicle: { type: string };
          };
        };
      }>;
    }>;
  }>;
}

// Nakanoshima → Temmabashi, the Osaka pair the request was filed about.
const FROM = '34.6937,135.4900';
const TO = '34.6875,135.5155';

function subwayRoute(): FixtureRoutes {
  return {
    routes: [
      {
        legs: [
          {
            steps: [
              {
                travelMode: 'WALK',
                staticDuration: '180s',
                distanceMeters: 210,
                startLocation: { latLng: { latitude: 34.6937, longitude: 135.49 } },
                endLocation: { latLng: { latitude: 34.6939, longitude: 135.4915 } },
                polyline: { encodedPolyline: 'walkpoly' },
              },
              {
                travelMode: 'TRANSIT',
                staticDuration: '480s',
                distanceMeters: 2100,
                polyline: { encodedPolyline: 'railpoly' },
                transitDetails: {
                  stopDetails: {
                    departureStop: { name: 'Nakanoshima', location: { latLng: { latitude: 34.6939, longitude: 135.4915 } } },
                    departureTime: '2026-09-10T09:00:00Z',
                    arrivalStop: { name: 'Temmabashi', location: { latLng: { latitude: 34.6871, longitude: 135.5142 } } },
                    arrivalTime: '2026-09-10T09:08:00Z',
                  },
                  headsign: 'Kadoma-shi',
                  stopCount: 3,
                  transitLine: {
                    name: 'Keihan Nakanoshima Line',
                    nameShort: 'KH',
                    color: '00A0E9',
                    textColor: 'FFFFFF',
                    agencies: [{ name: 'Keihan Electric Railway' }],
                    vehicle: { type: 'SUBWAY' },
                  },
                },
              },
              {
                travelMode: 'WALK',
                staticDuration: '120s',
                distanceMeters: 150,
                startLocation: { latLng: { latitude: 34.6871, longitude: 135.5142 } },
                endLocation: { latLng: { latitude: 34.6875, longitude: 135.5155 } },
                polyline: { encodedPolyline: 'walkpoly2' },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('activation', () => {
  it('GTRANSIT-001: stays off while the instance is on Transitous, even with a key', () => {
    const provider = new GoogleTransitProvider(stubDb({ maps_api_key: 'test-key' }));
    expect(provider.isActive(1)).toBe(false);
  });

  it('GTRANSIT-002: stays off when Google is selected but no key resolves', () => {
    const provider = new GoogleTransitProvider(stubDb({ transit_provider: 'google' }));
    expect(provider.isActive(1)).toBe(false);
  });

  it('GTRANSIT-003: is on only with both the setting and a key', () => {
    expect(new GoogleTransitProvider(googleDb()).isActive(1)).toBe(true);
  });

  it('GTRANSIT-004: an unknown provider value falls back to Transitous', () => {
    const provider = new GoogleTransitProvider(stubDb({ transit_provider: 'someday-maps', maps_api_key: 'test-key' }));
    expect(provider.isActive(1)).toBe(false);
  });

  it('GTRANSIT-005: TransitService routes to Google only when it is active', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const service = new TransitService(new GoogleTransitProvider(googleDb()));
    await service.plan({ from: FROM, to: TO });
    expect(fetchMock.mock.calls[0][0]).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
  });

  it('GTRANSIT-006: TransitService still validates the request before dispatching', async () => {
    const service = new TransitService(new GoogleTransitProvider(googleDb()));
    await expect(service.plan({ from: 'nowhere', to: TO })).rejects.toThrow('from must be "lat,lng"');
    await expect(service.plan({ from: FROM, to: TO, modes: 'ROCKET' })).rejects.toThrow('unsupported transit mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('plan mapping', () => {
  it('GTRANSIT-007: maps a walk/subway/walk route and derives the journey clock', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);

    expect(itineraries).toHaveLength(1);
    const it0 = itineraries[0];
    // Google gives no journey-level clock: the opening walk is 180s before the
    // 09:00 departure and the closing one 120s after the 09:08 arrival.
    expect(it0.startTime).toBe('2026-09-10T08:57:00.000Z');
    expect(it0.endTime).toBe('2026-09-10T09:10:00.000Z');
    expect(it0.duration).toBe(780);
    expect(it0.transfers).toBe(0);
    expect(it0.walkSeconds).toBe(300);

    expect(it0.legs.map((l) => l.mode)).toEqual(['WALK', 'SUBWAY', 'WALK']);
    // START/END are the sentinels the web client and the MCP builder replace
    // with the places the user actually picked.
    expect(it0.legs[0].from.name).toBe('START');
    expect(it0.legs[0].to.name).toBe('Nakanoshima');
    expect(it0.legs[2].from.name).toBe('Temmabashi');
    expect(it0.legs[2].to.name).toBe('END');

    const rail = it0.legs[1];
    expect(rail.line).toBe('KH');
    expect(rail.agency).toBe('Keihan Electric Railway');
    expect(rail.headsign).toBe('Kadoma-shi');
    expect(rail.lineColor).toBe('#00A0E9');
    expect(rail.lineTextColor).toBe('#FFFFFF');
    // stopCount counts the arrival stop; intermediateStops does not.
    expect(rail.intermediateStops).toBe(2);
    expect(rail.geometry).toBe('railpoly');
    // Google encodes at precision 5, MOTIS at 6 — the client reads it per leg.
    expect(rail.geometryPrecision).toBe(5);
  });

  it('GTRANSIT-008: drops a walk-only route rather than offering it as transit', async () => {
    fetchMock.mockResolvedValue(
      okJson({ routes: [{ legs: [{ steps: [{ travelMode: 'WALK', staticDuration: '900s' }] }] }] }),
    );
    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);
    expect(itineraries).toEqual([]);
  });

  it('GTRANSIT-009: maps Google vehicle types onto TREK modes', async () => {
    const withVehicle = (type: string) => {
      const route = subwayRoute();
      const details = route.routes[0].legs[0].steps[1].transitDetails;
      if (details) details.transitLine.vehicle.type = type;
      return route;
    };
    const provider = new GoogleTransitProvider(googleDb());
    for (const [google, trek] of [
      ['HEAVY_RAIL', 'RAIL'],
      ['HIGH_SPEED_TRAIN', 'HIGHSPEED_RAIL'],
      ['COMMUTER_TRAIN', 'SUBURBAN'],
      ['INTERCITY_BUS', 'COACH'],
      ['GONDOLA_LIFT', 'AERIAL_LIFT'],
      ['MONORAIL', 'SUBWAY'],
      ['SOMETHING_NEW', 'RAIL'],
    ]) {
      clearGoogleTransitCache();
      fetchMock.mockResolvedValue(okJson(withVehicle(google)));
      const { itineraries } = await provider.plan({ from: FROM, to: TO }, 'en', 1);
      expect(itineraries[0].legs[1].mode, google).toBe(trek);
    }
  });
});

describe('request shape', () => {
  it('GTRANSIT-010: asks for transit, alternatives and the caller language', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO, time: '2026-09-10T09:00:00Z' }, 'ja', 1);

    const body = lastBody();
    expect(body.travelMode).toBe('TRANSIT');
    // Alternatives ride along inside the one request that is already billed.
    expect(body.computeAlternativeRoutes).toBe(true);
    expect(body.languageCode).toBe('ja');
    expect(body.departureTime).toBe('2026-09-10T09:00:00.000Z');
    expect(body.arrivalTime).toBeUndefined();
    expect(lastHeaders()['X-Goog-Api-Key']).toBe('test-key');
  });

  it('GTRANSIT-011: arriveBy anchors the time at the destination', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    await new GoogleTransitProvider(googleDb()).plan(
      { from: FROM, to: TO, time: '2026-09-10T09:00:00Z', arriveBy: true }, 'en', 1,
    );
    expect(lastBody().arrivalTime).toBe('2026-09-10T09:00:00.000Z');
    expect(lastBody().departureTime).toBeUndefined();
  });

  it('GTRANSIT-012: the field mask stays inside the tier the itinerary needs', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);

    const mask = lastHeaders()['X-Goog-FieldMask'];
    expect(mask).toContain('routes.legs.steps.transitDetails.stopDetails');
    // Enterprise-tier extras are what make a free-tier install pay.
    expect(mask).not.toContain('travelAdvisory');
    expect(mask).not.toContain('localizedValues');
    expect(mask).not.toContain('routes.viewport');
  });

  it('GTRANSIT-013: sends the expressible modes and holds the rest on the response', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const provider = new GoogleTransitProvider(googleDb());

    const subwayOnly = await provider.plan({ from: FROM, to: TO, modes: 'SUBWAY' }, 'en', 1);
    expect(lastBody().transitPreferences).toEqual({ allowedTravelModes: ['SUBWAY'] });
    expect(subwayOnly.itineraries).toHaveLength(1);

    clearGoogleTransitCache();
    // Google cannot express a ferry-only filter, so nothing is sent for it and
    // the subway itinerary it answers with is refused here instead.
    const ferryOnly = await provider.plan({ from: FROM, to: TO, modes: 'FERRY' }, 'en', 1);
    expect(lastBody().transitPreferences).toBeUndefined();
    expect(ferryOnly.itineraries).toEqual([]);
  });

  it('GTRANSIT-014: enforces maxTransfers, which the Routes API has no parameter for', async () => {
    const twoTransfers = subwayRoute();
    const rail = twoTransfers.routes[0].legs[0].steps[1];
    twoTransfers.routes[0].legs[0].steps.splice(2, 0, JSON.parse(JSON.stringify(rail)));
    fetchMock.mockResolvedValue(okJson(twoTransfers));

    const provider = new GoogleTransitProvider(googleDb());
    const capped = await provider.plan({ from: FROM, to: TO, maxTransfers: 0 }, 'en', 1);
    expect(capped.itineraries).toEqual([]);
    // A low cap also nudges Google itself, so the one billed call is likelier
    // to come back with something the filter keeps.
    expect((lastBody().transitPreferences as Record<string, unknown>).routingPreference).toBe('FEWER_TRANSFERS');

    clearGoogleTransitCache();
    const allowed = await provider.plan({ from: FROM, to: TO, maxTransfers: 2 }, 'en', 1);
    expect(allowed.itineraries[0].transfers).toBe(1);
  });

  it('GTRANSIT-015: an identical plan is answered from cache, unbilled', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const provider = new GoogleTransitProvider(googleDb());
    await provider.plan({ from: FROM, to: TO }, 'en', 1);
    await provider.plan({ from: FROM, to: TO }, 'en', 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GTRANSIT-016: a provider error surfaces with Google\'s own message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'Routes API has not been used in project 1' } }),
    });
    await expect(new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1)).rejects.toThrow(
      'Routes API has not been used in project 1',
    );
  });

  it('GTRANSIT-017: upstream rate limiting stays a 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) });
    await expect(
      new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('geocode', () => {
  const places = {
    places: [
      {
        displayName: { text: 'Nakanoshima Station' },
        formattedAddress: '2 Chome Nakanoshima, Kita Ward, Osaka',
        location: { latitude: 34.6939, longitude: 135.4915 },
        types: ['subway_station', 'transit_station'],
      },
      {
        displayName: { text: 'Nakanoshima Park' },
        formattedAddress: '1 Nakanoshima, Kita Ward, Osaka',
        location: { latitude: 34.6921, longitude: 135.5069 },
        types: ['park'],
      },
      { displayName: { text: 'No coordinates' }, types: ['park'] },
    ],
  };

  it('GTRANSIT-018: maps places, marking stations STOP and everything else PLACE', async () => {
    fetchMock.mockResolvedValue(okJson(places));
    const { results } = await new GoogleTransitProvider(googleDb()).geocode('Nakanoshima', 'en', undefined, 1);

    expect(results).toEqual([
      { name: 'Nakanoshima Station', lat: 34.6939, lng: 135.4915, type: 'STOP', area: '2 Chome Nakanoshima, Kita Ward, Osaka' },
      { name: 'Nakanoshima Park', lat: 34.6921, lng: 135.5069, type: 'PLACE', area: '1 Nakanoshima, Kita Ward, Osaka' },
    ]);
  });

  it('GTRANSIT-019: biases on `near` and asks only for the cheap Text Search fields', async () => {
    fetchMock.mockResolvedValue(okJson(places));
    await new GoogleTransitProvider(googleDb()).geocode('Temmabashi', 'ja', '34.6875,135.5155', 1);

    const body = lastBody();
    expect(body.languageCode).toBe('ja');
    expect(body.pageSize).toBe(8);
    expect(body.locationBias).toEqual({ circle: { center: { latitude: 34.6875, longitude: 135.5155 }, radius: 50000 } });

    // Rating/website/phone would bill Text Search at Enterprise, and a station
    // picker shows none of them.
    const mask = lastHeaders()['X-Goog-FieldMask'];
    expect(mask).toBe('places.displayName,places.formattedAddress,places.location,places.types');
  });

  it('GTRANSIT-020: repeat lookups of the same station are answered from cache', async () => {
    fetchMock.mockResolvedValue(okJson(places));
    const service = new TransitService(new GoogleTransitProvider(googleDb()));
    await service.geocode('Kyobashi', 'en', undefined, 1);
    await service.geocode('Kyobashi', 'en', undefined, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GTRANSIT-021: a short query never reaches Google', async () => {
    const service = new TransitService(new GoogleTransitProvider(googleDb()));
    // The provider is still named: the answer comes from the length guard, not
    // from a backend that declined.
    expect(await service.geocode('a', 'en', undefined, 1)).toEqual({ results: [], provider: 'google' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('guards', () => {
  it('GTRANSIT-022: refuses rather than calling Google when no key resolves', async () => {
    const provider = new GoogleTransitProvider(stubDb({ transit_provider: 'google' }));
    await expect(provider.plan({ from: FROM, to: TO }, 'en', 1)).rejects.toThrow('no Google API key configured');
    await expect(provider.geocode('Namba', 'en', undefined, 1)).rejects.toThrow('no Google API key configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GTRANSIT-023: an oversized response is refused before it is parsed', async () => {
    const json = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => '9000000' }, json });
    await expect(new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1)).rejects.toThrow(
      'response too large',
    );
    expect(json).not.toHaveBeenCalled();
  });

  it('GTRANSIT-024: a route with no steps, and one whose transit leg has no clock, are both dropped', async () => {
    const provider = new GoogleTransitProvider(googleDb());

    fetchMock.mockResolvedValue(okJson({ routes: [{ legs: [{ steps: [] }] }] }));
    expect((await provider.plan({ from: FROM, to: TO }, 'en', 1)).itineraries).toEqual([]);

    clearGoogleTransitCache();
    const timeless = subwayRoute();
    const details = timeless.routes[0].legs[0].steps[1].transitDetails;
    if (details) details.stopDetails = { departureStop: { name: 'Nakanoshima' }, arrivalStop: { name: 'Temmabashi' } };
    fetchMock.mockResolvedValue(okJson(timeless));
    expect((await provider.plan({ from: FROM, to: TO, arriveBy: true }, 'en', 1)).itineraries).toEqual([]);
  });

  it('GTRANSIT-025: an unnamed interior walk endpoint falls back to a usable name', async () => {
    const unnamed = subwayRoute();
    const details = unnamed.routes[0].legs[0].steps[1].transitDetails;
    if (details) {
      details.stopDetails.departureStop = { location: { latLng: { latitude: 34.6939, longitude: 135.4915 } } };
      details.stopDetails.arrivalStop = { location: { latLng: { latitude: 34.6871, longitude: 135.5142 } } };
    }
    fetchMock.mockResolvedValue(okJson(unnamed));

    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);
    // Every name is non-empty — transitStopSchema rejects a blank one, which
    // would drop the itinerary at the MCP boundary.
    for (const leg of itineraries[0].legs) {
      expect(leg.from.name).not.toBe('');
      expect(leg.to.name).not.toBe('');
    }
    expect(itineraries[0].legs[1].from.name).toBe('Transfer');
  });

  it('GTRANSIT-026: a missing or malformed step duration counts as zero, never NaN', async () => {
    const noDuration = subwayRoute();
    delete noDuration.routes[0].legs[0].steps[0].staticDuration;
    noDuration.routes[0].legs[0].steps[2].staticDuration = 'not-a-duration';
    fetchMock.mockResolvedValue(okJson(noDuration));

    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);
    expect(itineraries[0].legs[0].duration).toBe(0);
    expect(itineraries[0].legs[2].duration).toBe(0);
    expect(itineraries[0].walkSeconds).toBe(0);
  });

  it('GTRANSIT-027: a cache entry past its TTL is re-fetched, not served stale', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const provider = new GoogleTransitProvider(googleDb());

    await provider.plan({ from: FROM, to: TO }, 'en', 1);
    now.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await provider.plan({ from: FROM, to: TO }, 'en', 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('GTRANSIT-028: the cache evicts rather than growing without bound', async () => {
    fetchMock.mockResolvedValue(okJson({ places: [] }));
    const provider = new GoogleTransitProvider(googleDb());
    for (let i = 0; i < 220; i++) await provider.geocode(`station-${i}`, 'en', undefined, 1);
    expect(fetchMock).toHaveBeenCalledTimes(220);

    // The oldest entry is gone; the newest is still a cache hit.
    await provider.geocode('station-219', 'en', undefined, 1);
    expect(fetchMock).toHaveBeenCalledTimes(220);
    await provider.geocode('station-0', 'en', undefined, 1);
    expect(fetchMock).toHaveBeenCalledTimes(221);
  });
});

/**
 * The Routes API returns walking as turn-by-turn navigation steps, so a single
 * walk to the platform arrives as several. Everything downstream expects MOTIS's
 * one-leg-per-walk shape — including transitItinerarySchema's 20-leg cap, which
 * a finely-sliced walk would blow through, dropping the whole itinerary.
 */
describe('walk coalescing', () => {
  /** A walk step whose polyline runs between the two given points. */
  function walkStep(seconds: number, metres: number, from: [number, number], to: [number, number]) {
    return {
      travelMode: 'WALK',
      staticDuration: `${seconds}s`,
      distanceMeters: metres,
      startLocation: { latLng: { latitude: from[0], longitude: from[1] } },
      endLocation: { latLng: { latitude: to[0], longitude: to[1] } },
      polyline: { encodedPolyline: encodePolyline([from, to], 5) },
    };
  }

  function routeWithSlicedWalks() {
    const route = subwayRoute();
    const steps = route.routes[0].legs[0].steps;
    const rail = steps[1];
    route.routes[0].legs[0].steps = [
      walkStep(60, 70, [34.6937, 135.49], [34.6938, 135.4905]),
      walkStep(60, 70, [34.6938, 135.4905], [34.69385, 135.491]),
      walkStep(60, 70, [34.69385, 135.491], [34.6939, 135.4915]),
      rail,
      walkStep(45, 60, [34.6871, 135.5142], [34.6873, 135.5149]),
      walkStep(75, 90, [34.6873, 135.5149], [34.6875, 135.5155]),
    ];
    return route;
  }

  it('GTRANSIT-029: a walk split across navigation steps becomes one leg', async () => {
    fetchMock.mockResolvedValue(okJson(routeWithSlicedWalks()));
    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);

    const legs = itineraries[0].legs;
    expect(legs.map((l) => l.mode)).toEqual(['WALK', 'SUBWAY', 'WALK']);
    // Durations and distances add up rather than being lost with the extra legs.
    expect(legs[0].duration).toBe(180);
    expect(legs[0].distance).toBe(210);
    expect(legs[2].duration).toBe(120);
    expect(legs[2].distance).toBe(150);
    expect(itineraries[0].walkSeconds).toBe(300);
  });

  it('GTRANSIT-030: the merged walk keeps the endpoints of the whole run', async () => {
    fetchMock.mockResolvedValue(okJson(routeWithSlicedWalks()));
    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);

    const [opening, , closing] = itineraries[0].legs;
    expect(opening.from.name).toBe('START');
    expect(opening.to.name).toBe('Nakanoshima');
    expect(closing.from.name).toBe('Temmabashi');
    expect(closing.to.name).toBe('END');
    // The merged leg starts where the run started and ends where it ended.
    expect(opening.from.lat).toBeCloseTo(34.6937, 4);
    expect(closing.to.lng).toBeCloseTo(135.5155, 4);
  });

  it('GTRANSIT-031: the merged walk draws the whole path, with no doubled seam', async () => {
    fetchMock.mockResolvedValue(okJson(routeWithSlicedWalks()));
    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);

    const points = decodePolyline(itineraries[0].legs[0].geometry ?? '', 5);
    // Three two-point steps sharing their seams — four points, not six.
    expect(points).toHaveLength(4);
    expect(points[0][0]).toBeCloseTo(34.6937, 5);
    expect(points[3][1]).toBeCloseTo(135.4915, 5);
  });

  it('GTRANSIT-032: a walk run keeps its shape when only some steps carry geometry', async () => {
    const partial = routeWithSlicedWalks();
    delete partial.routes[0].legs[0].steps[1].polyline;
    fetchMock.mockResolvedValue(okJson(partial));

    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);
    expect(decodePolyline(itineraries[0].legs[0].geometry ?? '', 5).length).toBeGreaterThan(0);
    expect(itineraries[0].legs[0].duration).toBe(180);
  });

  it('GTRANSIT-033: a heavily sliced walk stays inside the 20-leg itinerary cap', async () => {
    const many = subwayRoute();
    const rail = many.routes[0].legs[0].steps[1];
    const crumbs = Array.from({ length: 15 }, (_, i) =>
      walkStep(20, 25, [34.6937 + i * 0.0001, 135.49], [34.6937 + (i + 1) * 0.0001, 135.49]));
    many.routes[0].legs[0].steps = [...crumbs, rail, ...crumbs];
    fetchMock.mockResolvedValue(okJson(many));

    const { itineraries } = await new GoogleTransitProvider(googleDb()).plan({ from: FROM, to: TO }, 'en', 1);
    expect(itineraries[0].legs).toHaveLength(3);
  });
});

/**
 * The empty state reads "No connections found via <provider>", so an empty
 * result has to carry the name of whichever backend produced it — that is the
 * whole point of the field.
 */
describe('provider reporting', () => {
  it('GTRANSIT-036: names Google when Google answered', async () => {
    fetchMock.mockResolvedValue(okJson(subwayRoute()));
    const service = new TransitService(new GoogleTransitProvider(googleDb()));
    const planned = await service.plan({ from: FROM, to: TO }, 'en', 1);
    expect(planned.provider).toBe('google');

    fetchMock.mockResolvedValue(okJson({ places: [] }));
    expect((await service.geocode('Namba', 'en', undefined, 1)).provider).toBe('google');
  });

  it('GTRANSIT-037: names Transitous when the silent fallback took over', async () => {
    fetchMock.mockResolvedValue(okJson({ itineraries: [] }));
    // Google selected, but no key resolves — the request goes to Transitous and
    // says so, instead of leaving an empty result to be blamed on Google.
    const service = new TransitService(new GoogleTransitProvider(stubDb({ transit_provider: 'google' })));
    const planned = await service.plan({ from: '48.8583,2.3470', to: '48.8809,2.3553' }, 'en', 1);
    expect(planned.provider).toBe('transitous');
    expect(planned.itineraries).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('transitous');
  });

  it('GTRANSIT-038: a cached answer still names its backend', async () => {
    fetchMock.mockResolvedValue(okJson({ itineraries: [] }));
    const service = new TransitService(new GoogleTransitProvider(stubDb({})));
    const first = await service.plan({ from: '48.1,2.1', to: '48.2,2.2' }, 'en', 1);
    const second = await service.plan({ from: '48.1,2.1', to: '48.2,2.2' }, 'en', 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.provider).toBe(first.provider);
    expect(second.provider).toBe('transitous');
  });
});

describe('polyline codec', () => {
  it('GTRANSIT-034: round-trips coordinates at the precision it was given', () => {
    const path: [number, number][] = [[34.6937, 135.49], [34.69385, 135.4915], [-34.6, -135.5155]];
    const back = decodePolyline(encodePolyline(path, 5), 5);
    expect(back).toHaveLength(3);
    for (const [i, [lat, lng]] of path.entries()) {
      expect(back[i][0]).toBeCloseTo(lat, 5);
      expect(back[i][1]).toBeCloseTo(lng, 5);
    }
  });

  it('GTRANSIT-035: a truncated polyline decodes to what it can, without hanging', () => {
    const encoded = encodePolyline([[34.6937, 135.49], [34.7, 135.5]], 5);
    expect(decodePolyline(encoded.slice(0, 3), 5).length).toBeLessThanOrEqual(1);
    expect(decodePolyline('', 5)).toEqual([]);
  });
});
