/**
 * Unit tests for the DI-native TransitService — TRANSIT-SVC-001..011, moved
 * 1:1 from the legacy tests/unit/services/transitService.test.ts when the
 * transit domain went DI-native. The Transitous/MOTIS proxy (#1065): input
 * validation, mode whitelist, response mapping (colors, walk time, wall-clock
 * duration) and caching.
 *
 * The response cache is deliberately MODULE-scoped (shared by every
 * TransitService instance), so it persists across the tests in this file —
 * every case uses its own coordinates/query to stay isolated.
 */
import { deriveTransitStats, type TransitLeg } from '../../../src/nest/transit/transit.helpers';
import { GoogleTransitProvider } from '../../../src/nest/transit/google-transit.provider';
import { TransitService } from '../../../src/nest/transit/transit.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/app-config')>();
  return { ...actual, getAppUrl: () => 'https://trek.example.com' };
});
vi.mock('../../../src/nest/maps/maps.helpers', () => ({ buildUserAgent: () => 'TREK-Test-UA' }));

const fetchMock = vi.fn();
// No `transit_provider` row means Transitous, so every case below keeps
// exercising the MOTIS path — the Google branch has its own suite.
const db = { get: () => undefined, run: () => undefined } as unknown as DatabaseService;
const svc = new TransitService(new GoogleTransitProvider(db));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function okJson(data: unknown, contentLength: number | null = null) {
  return {
    ok: true,
    headers: { get: () => (contentLength === null ? null : String(contentLength)) },
    json: async () => data,
  };
}

describe('geocode', () => {
  it('TRANSIT-SVC-001: returns [] without calling upstream for short queries', async () => {
    const r = await svc.geocode('a');
    expect(r.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TRANSIT-SVC-002: maps matches to compact places and sends the UA', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson([
        { name: 'Alexanderplatz', lat: 52.52, lon: 13.41, type: 'STOP', areas: [{ name: 'Berlin', default: true }] },
        { name: 'no-coords' },
      ]),
    );
    const r = await svc.geocode('alexanderplatz-u1');
    expect(r.results).toEqual([{ name: 'Alexanderplatz', lat: 52.52, lng: 13.41, type: 'STOP', area: 'Berlin' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/geocode?');
    expect(init.headers['User-Agent']).toBe('TREK-Test-UA');
  });

  it('TRANSIT-SVC-003: ignores an invalid near bias instead of forwarding it', async () => {
    fetchMock.mockResolvedValueOnce(okJson([]));
    await svc.geocode('hauptbahnhof-x1', undefined, 'not,coords');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('place=');
  });
});

describe('plan validation', () => {
  it('TRANSIT-SVC-004: rejects malformed coordinates with 400', async () => {
    await expect(svc.plan({ from: 'x', to: '52.5,13.4' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.plan({ from: '95,13.4', to: '52.5,13.4' })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TRANSIT-SVC-005: rejects modes outside the whitelist', async () => {
    await expect(svc.plan({ from: '52.50,13.40', to: '52.51,13.41', modes: 'BUS,CAR' })).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TRANSIT-SVC-006: rejects out-of-range maxTransfers and bad time', async () => {
    await expect(svc.plan({ from: '52.50,13.40', to: '52.51,13.41', maxTransfers: 99 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.plan({ from: '52.50,13.40', to: '52.51,13.41', time: 'not-a-date' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('itinerary statistics', () => {
  it('derives wall-clock duration, walking time, and transfers from canonical legs', () => {
    const leg = (mode: string, duration: number) => ({ mode, duration }) as TransitLeg;
    const stats = deriveTransitStats('2026-07-13T08:00:00Z', '2026-07-13T08:30:00Z', [
      leg('WALK', 300),
      leg('BUS', 600),
      leg('RAIL', 600),
    ]);

    expect(stats).toEqual({ duration: 1800, transfers: 1, walkSeconds: 300 });
    expect(deriveTransitStats('2026-07-13T08:00:00Z', '2026-07-13T08:30:00Z', [leg('BUS', 1800)], 2).transfers).toBe(2);
  });
});

describe('plan mapping', () => {
  const motisResponse = {
    itineraries: [
      {
        duration: 999, // deliberately wrong — mapping must use wall-clock instead
        startTime: '2026-07-13T08:00:00Z',
        endTime: '2026-07-13T08:30:00Z',
        transfers: 1,
        legs: [
          {
            mode: 'WALK',
            duration: 300,
            distance: 250.7,
            from: { name: 'A', lat: 1, lon: 2, departure: '2026-07-13T08:00:00Z' },
            to: { name: 'Stop 1', lat: 1.1, lon: 2.1, arrival: '2026-07-13T08:05:00Z' },
          },
          {
            mode: 'BUS',
            duration: 1200,
            routeShortName: '100',
            routeColor: 'FF0000',
            routeTextColor: '#ffffff',
            headsign: 'Zoo',
            agencyName: 'BVG',
            intermediateStops: [{}, {}],
            from: { name: 'Stop 1', lat: 1.1, lon: 2.1, departure: '2026-07-13T08:07:00Z', track: '2' },
            to: { name: 'Stop 2', lat: 1.2, lon: 2.2, arrival: '2026-07-13T08:27:00Z' },
          },
        ],
      },
    ],
  };

  it('TRANSIT-SVC-007: maps legs compactly, normalises GTFS colors and counts walk seconds', async () => {
    fetchMock.mockResolvedValueOnce(okJson(motisResponse));
    const r = await svc.plan({ from: '52.5000,13.4000', to: '52.5100,13.4100' });
    expect(r.itineraries).toHaveLength(1);
    const it = r.itineraries[0];
    // Wall-clock 08:00→08:30, not the reported 999s.
    expect(it.duration).toBe(1800);
    expect(it.walkSeconds).toBe(300);
    expect(it.transfers).toBe(1);
    const bus = it.legs[1];
    expect(bus.line).toBe('100');
    expect(bus.lineColor).toBe('#FF0000');
    expect(bus.lineTextColor).toBe('#ffffff');
    expect(bus.intermediateStops).toBe(2);
    expect(bus.from.track).toBe('2');
    expect(it.legs[0].distance).toBe(251);
  });

  it('TRANSIT-SVC-011: prefers displayName over routeShortName for the line label', async () => {
    // German long distance publishes "ICE 72" as displayName while routeShortName
    // carries an internal line number (#1715).
    fetchMock.mockResolvedValueOnce(
      okJson({
        itineraries: [
          {
            startTime: '2026-08-21T12:37:00Z',
            endTime: '2026-08-21T13:38:00Z',
            transfers: 1,
            legs: [
              {
                mode: 'HIGHSPEED_RAIL',
                duration: 1800,
                routeShortName: '20',
                displayName: 'ICE 72',
                from: { name: 'Karlsruhe Hbf', lat: 49, lon: 8.4, departure: '2026-08-21T12:37:00Z' },
                to: { name: 'Mannheim Hbf', lat: 49.4, lon: 8.4, arrival: '2026-08-21T13:07:00Z' },
              },
              {
                mode: 'RAIL',
                duration: 1860,
                routeShortName: 'S9',
                from: { name: 'Mannheim Hbf', lat: 49.4, lon: 8.4, departure: '2026-08-21T13:07:00Z' },
                to: { name: 'Frankfurt Flughafen', lat: 50, lon: 8.5, arrival: '2026-08-21T13:38:00Z' },
              },
            ],
          },
        ],
      }),
    );
    const r = await svc.plan({ from: '49.0090,8.4004', to: '50.0510,8.5706' });
    const [longDistance, regional] = r.itineraries[0].legs;
    expect(longDistance.line).toBe('ICE 72');
    // Feeds that only supply routeShortName keep working.
    expect(regional.line).toBe('S9');
  });

  it('TRANSIT-SVC-008: forwards only whitelisted params and pins directModes=WALK', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ itineraries: [] }));
    await svc.plan({
      from: '48.1000,11.5000',
      to: '48.2000,11.6000',
      modes: 'BUS,TRAM',
      maxTransfers: 2,
      arriveBy: true,
      time: '2026-07-13T09:00:00Z',
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v6/plan?');
    expect(url).toContain('transitModes=BUS%2CTRAM');
    expect(url).toContain('maxTransfers=2');
    expect(url).toContain('arriveBy=true');
    expect(url).toContain('directModes=WALK');
  });

  it('TRANSIT-SVC-009: identical plans hit the cache (single upstream call)', async () => {
    fetchMock.mockResolvedValue(okJson({ itineraries: [] }));
    await svc.plan({ from: '40.0000,-3.0000', to: '40.1000,-3.1000' });
    await svc.plan({ from: '40.0000,-3.0000', to: '40.1000,-3.1000' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TRANSIT-SVC-010: upstream failure surfaces as a 502-style error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(svc.plan({ from: '41.0000,2.0000', to: '41.1000,2.1000' })).rejects.toMatchObject({ status: 502 });
  });
});

describe('quirk repairs (DI fold fix pass)', () => {
  it('TRANSIT-SVC-012: upstream requests carry an abort-timeout signal', async () => {
    fetchMock.mockResolvedValueOnce(okJson([]));
    await svc.geocode('timeout-probe-station');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('TRANSIT-SVC-013: unparseable provider timestamps yield duration 0, not NaN', () => {
    const stats = deriveTransitStats('not-a-date', 'also-not-a-date', []);
    expect(stats.duration).toBe(0);
    // Parseable dates keep the wall-clock behaviour.
    expect(deriveTransitStats('2026-07-13T08:00:00Z', '2026-07-13T08:30:00Z', []).duration).toBe(1800);
  });

  it('TRANSIT-SVC-014: an oversized upstream response is refused as a provider error', async () => {
    fetchMock.mockResolvedValueOnce(okJson([], 6_000_000));
    await expect(svc.geocode('oversize-probe-station')).rejects.toMatchObject({
      status: 502,
      message: 'Transit provider error (response too large)',
    });
  });

  it('TRANSIT-SVC-015: the cache is LRU — a re-read entry survives eviction pressure', async () => {
    fetchMock.mockResolvedValue(okJson([]));
    // Flush whatever earlier tests cached: 205 distinct fillers guarantee the
    // 200-entry Map holds only fillers afterwards.
    for (let i = 0; i < 205; i++) await svc.geocode(`lru-fill-${i}`);
    // Insert the probe, then age it to the oldest position with 199 more inserts.
    await svc.geocode('lru-probe-station');
    for (let i = 0; i < 199; i++) await svc.geocode(`lru-age-${i}`);
    const fetchesBeforeTouch = fetchMock.mock.calls.length;
    // Touch the probe (cache hit — no fetch) so LRU moves it off the eviction edge…
    await svc.geocode('lru-probe-station');
    expect(fetchMock.mock.calls.length).toBe(fetchesBeforeTouch);
    // …then trigger one eviction. FIFO would evict the probe; LRU evicts lru-age-0.
    await svc.geocode('lru-evictor-station');
    await svc.geocode('lru-probe-station');
    expect(fetchMock.mock.calls.length).toBe(fetchesBeforeTouch + 1);
  });
});
