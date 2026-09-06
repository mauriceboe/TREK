import { runMigrations } from '../../../src/db/migrations';
import { createTables } from '../../../src/db/schema';
import { invalidatePermissionsCache } from '../../../src/nest/permissions/permissions-cache';
import { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { addTripMember, createDay, createTrip, createUser } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';
import { resetTestDb } from '../../helpers/test-db';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: number, userId: number) =>
      db
        .prepare(
          'SELECT t.id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)',
        )
        .get(userId, tripId, userId),
    isOwner: (tripId: number, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

const { broadcastMock } = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
}));

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { ReservationsService } from '../../../src/nest/reservations/reservations.service';
import type { TransitPlace } from '../../../src/nest/transit/transit.helpers';
import { TransitService } from '../../../src/nest/transit/transit.service';

// savePermissions is no longer bridged; write through a service instance — the
// permissions cache is module-scoped, so the MCP _shared checkPermission path
// sees the write immediately.
const permissionsService = new PermissionsService(new DatabaseService(testDb));
const savePermissions = permissionsService.savePermissions.bind(permissionsService);

// The transit tools live on the DI-discovered transit.mcp.ts since the transit
// fold; the test registry builds a real TransitService (and injects a real
// ReservationsService over the mocked db proxy), so stub the provider methods
// on the prototype (no auto-restore in the vitest config — these survive
// across tests, exactly like the old module mocks did).
const geocodeMock = vi.spyOn(TransitService.prototype, 'geocode');
const planMock = vi.spyOn(TransitService.prototype, 'plan');
const notifyBookingChangeMock = vi
  .spyOn(ReservationsService.prototype, 'notifyBookingChange')
  .mockImplementation(() => {});

const from = { name: 'Namba', lat: 34.667, lng: 135.501 };
const to = { name: 'Umeda', lat: 34.702, lng: 135.496 };
const itinerary = {
  startTime: '2026-12-03T00:00:00Z',
  endTime: '2026-12-03T00:30:00Z',
  duration: 1800,
  transfers: 0,
  walkSeconds: 300,
  legs: [
    {
      mode: 'WALK',
      from: { ...from, name: 'START', time: '2026-12-03T00:00:00Z', scheduledTime: null, track: null },
      to: {
        name: 'Namba Station',
        lat: 34.666,
        lng: 135.5,
        time: '2026-12-03T00:05:00Z',
        scheduledTime: null,
        track: null,
      },
      duration: 300,
      distance: 300,
      headsign: null,
      line: null,
      lineColor: null,
      lineTextColor: null,
      agency: null,
      intermediateStops: 0,
      geometry: null,
      geometryPrecision: 6,
    },
    {
      mode: 'SUBWAY',
      from: {
        name: 'Namba Station',
        lat: 34.666,
        lng: 135.5,
        time: '2026-12-03T00:05:00Z',
        scheduledTime: null,
        track: '1',
      },
      to: { ...to, name: 'END', time: '2026-12-03T00:30:00Z', scheduledTime: null, track: '2' },
      duration: 1500,
      distance: 5000,
      headsign: 'Umeda',
      line: 'M',
      lineColor: '#E5171F',
      lineTextColor: '#FFFFFF',
      agency: 'Osaka Metro',
      intermediateStops: 3,
      geometry: 'encoded',
      geometryPrecision: 6,
    },
  ],
};

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  geocodeMock.mockReset();
  planMock.mockReset();
  broadcastMock.mockReset();
  // mockReset would fall back to the real notification write — keep it stubbed.
  notifyBookingChangeMock.mockReset().mockImplementation(() => {});
  delete process.env.DEMO_MODE;
  invalidatePermissionsCache();
});

afterAll(() => testDb.close());

async function withHarness(userId: number, scopes: string[] | null, fn: (harness: McpHarness) => Promise<void>) {
  const harness = await createMcpHarness({ userId, scopes, withResources: false });
  try {
    await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

describe('MCP transit tools', () => {
  it('registers search tools for geo scope and create tool for reservations scope', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['geo:read'], async (harness) => {
      const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('search_transit_stops');
      expect(names).toContain('search_transit_routes');
      expect(names).not.toContain('create_transit_journey');
    });
    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const tools = (await harness.client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('create_transit_journey');
      expect(names).not.toContain('search_transit_routes');
      expect(tools.find((tool) => tool.name === 'create_transit_journey')?.annotations?.openWorldHint).toBe(true);
    });
  });

  it('forwards stop and route searches and replaces provider endpoint names', async () => {
    const { user } = createUser(testDb);
    // `from` is a tool-input place (name/lat/lng). A geocode result is a TransitPlace,
    // which also carries `type` and `area`; the stop search only reads the name back out,
    // so the fixture stays as it is instead of growing fields nothing here looks at.
    geocodeMock.mockResolvedValue({ results: [from as TransitPlace], provider: 'transitous' });
    planMock.mockResolvedValue({
      provider: 'transitous',
      itineraries: [
        itinerary,
        { ...itinerary, legs: [itinerary.legs[0]] },
        {
          ...itinerary,
          legs: itinerary.legs.map((leg, index) => (index === 0 ? { ...leg, from: { ...leg.from, lat: 35.5 } } : leg)),
        },
      ],
    });
    await withHarness(user.id, ['geo:read'], async (harness) => {
      const stops = parseToolResult(
        await harness.client.callTool({
          name: 'search_transit_stops',
          arguments: { query: 'Namba', language: 'ja', near: { lat: 34.67, lng: 135.5 } },
        }),
      ) as any;
      expect(stops.results[0].name).toBe('Namba');
      // The caller's id trails the query so the Google backend (#1699) can
      // resolve the install's key; the Transitous path ignores it.
      expect(geocodeMock).toHaveBeenCalledWith('Namba', 'ja', '34.67,135.5', user.id);

      const routes = parseToolResult(
        await harness.client.callTool({
          name: 'search_transit_routes',
          arguments: { from, to, time: '2026-12-03T09:00:00+09:00', modes: ['SUBWAY'] },
        }),
      ) as any;
      expect(routes.itineraries[0].legs[0].from.name).toBe('Namba');
      expect(routes.itineraries[0].legs[1].to.name).toBe('Umeda');
      expect(routes.itineraries).toHaveLength(1);
      expect(planMock).toHaveBeenCalledWith(expect.objectContaining({ modes: 'SUBWAY' }), undefined, user.id);

      const invalidNear = await harness.client.callTool({
        name: 'search_transit_stops',
        arguments: { query: 'Namba', near: { lat: 999, lng: 999 } },
      });
      expect(invalidNear.isError).toBe(true);
    });
  });

  it('persists a selected itinerary with local dates, endpoints, and transit metadata', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { start_date: '2026-12-03', end_date: '2026-12-04' });
    const day = testDb.prepare('SELECT * FROM days WHERE trip_id = ? AND date = ?').get(trip.id, '2026-12-03') as any;
    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const result = parseToolResult(
        await harness.client.callTool({
          name: 'create_transit_journey',
          arguments: {
            tripId: trip.id,
            dayId: day.id,
            from,
            to,
            itinerary: { ...itinerary, duration: 1, walkSeconds: 1 },
          },
        }),
      ) as any;
      expect(result.reservation.type).toBe('transit');
      expect(result.reservation.status).toBe('confirmed');
      expect(result.reservation.reservation_time).toBe('2026-12-03T09:00');
      expect(result.reservation.endpoints).toHaveLength(2);
      expect(result.reservation.endpoints[0].timezone).toBe('Asia/Tokyo');
      const metadata = JSON.parse(result.reservation.metadata);
      expect(metadata.transit.provider).toBe('transitous');
      expect(metadata.transit.duration).toBe(1800);
      expect(metadata.transit.transfers).toBe(0);
      expect(metadata.transit.walk_seconds).toBe(300);
      expect(metadata.transit.legs[1].line_color).toBe('#E5171F');
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'reservation:created', expect.anything());
      expect(notifyBookingChangeMock).toHaveBeenCalledWith(trip.id, user.id, 'Namba → Umeda', 'transit');
    });
  });

  it('rejects dateless, mismatched, and out-of-range journey dates', async () => {
    const { user } = createUser(testDb);
    const datelessTrip = createTrip(testDb, user.id);
    const datelessDay = createDay(testDb, datelessTrip.id);
    const datedTrip = createTrip(testDb, user.id, { start_date: '2026-12-02', end_date: '2026-12-03' });
    const datedDay = testDb
      .prepare('SELECT * FROM days WHERE trip_id = ? AND date = ?')
      .get(datedTrip.id, '2026-12-02') as any;
    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const dateless = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: datelessTrip.id, dayId: datelessDay.id, from, to, itinerary },
      });
      expect(dateless.isError).toBe(true);
      expect((dateless.content[0] as any).text).toContain('dated trip day');

      const mismatch = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: datedTrip.id, dayId: datedDay.id, from, to, itinerary },
      });
      expect(mismatch.isError).toBe(true);
      expect((mismatch.content[0] as any).text).toContain('departs on 2026-12-03');

      const nextDayItinerary = {
        ...itinerary,
        endTime: '2026-12-04T00:30:00Z',
        legs: itinerary.legs.map((leg, index) =>
          index === itinerary.legs.length - 1
            ? { ...leg, duration: 87_900, to: { ...leg.to, time: '2026-12-04T00:30:00Z' } }
            : leg,
        ),
      };
      const startDay = testDb
        .prepare('SELECT * FROM days WHERE trip_id = ? AND date = ?')
        .get(datedTrip.id, '2026-12-03') as any;
      const outside = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: datedTrip.id, dayId: startDay.id, from, to, itinerary: nextDayItinerary },
      });
      expect(outside.isError).toBe(true);
      expect((outside.content[0] as any).text).toContain('No trip day exists');
    });
  });

  it('rejects malformed provider data before persistence', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { start_date: '2026-12-03', end_date: '2026-12-03' });
    const day = testDb.prepare('SELECT * FROM days WHERE trip_id = ?').get(trip.id) as any;
    const allWalk = { ...itinerary, legs: [itinerary.legs[0]] };
    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const result = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: allWalk },
      });
      expect(result.isError).toBe(true);
      expect(testDb.prepare("SELECT COUNT(*) AS count FROM reservations WHERE type = 'transit'").get()).toEqual({
        count: 0,
      });

      const wrongDestination = {
        ...itinerary,
        legs: itinerary.legs.map((leg, index) =>
          index === itinerary.legs.length - 1 ? { ...leg, to: { ...leg.to, lat: 35.0 } } : leg,
        ),
      };
      const mismatch = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: wrongDestination },
      });
      expect(mismatch.isError).toBe(true);
      expect((mismatch.content[0] as any).text).toContain('does not match');
      expect(testDb.prepare("SELECT COUNT(*) AS count FROM reservations WHERE type = 'transit'").get()).toEqual({
        count: 0,
      });

      const invalidTime = {
        ...itinerary,
        legs: itinerary.legs.map((leg, index) =>
          index === 0 ? { ...leg, from: { ...leg.from, time: '09:00' } } : leg,
        ),
      };
      const malformedTime = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: invalidTime },
      });
      expect(malformedTime.isError).toBe(true);

      const excessiveTransfers = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: { ...itinerary, transfers: 9 } },
      });
      expect(excessiveTransfers.isError).toBe(true);

      const unanchored = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: {
          tripId: trip.id,
          dayId: day.id,
          from,
          to,
          itinerary: { ...itinerary, endTime: '2026-12-04T00:30:00Z' },
        },
      });
      expect(unanchored.isError).toBe(true);

      const wrongDuration = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: {
          tripId: trip.id,
          dayId: day.id,
          from,
          to,
          itinerary: {
            ...itinerary,
            legs: itinerary.legs.map((leg, index) => (index === 0 ? { ...leg, duration: 1 } : leg)),
          },
        },
      });
      expect(wrongDuration.isError).toBe(true);

      const overlappingLegs = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: {
          tripId: trip.id,
          dayId: day.id,
          from,
          to,
          itinerary: {
            ...itinerary,
            legs: itinerary.legs.map((leg, index) =>
              index === 0 ? { ...leg, duration: 600, to: { ...leg.to, time: '2026-12-03T00:10:00Z' } } : leg,
            ),
          },
        },
      });
      expect(overlappingLegs.isError).toBe(true);

      const missingTimes = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: {
          tripId: trip.id,
          dayId: day.id,
          from,
          to,
          itinerary: {
            ...itinerary,
            legs: itinerary.legs.map((leg, index) =>
              index === 1 ? { ...leg, from: { ...leg.from, time: null, scheduledTime: null } } : leg,
            ),
          },
        },
      });
      expect(missingTimes.isError).toBe(true);

      const disconnected = {
        ...itinerary,
        legs: itinerary.legs.map((leg, index) => (index === 1 ? { ...leg, from: { ...leg.from, lat: 35.5 } } : leg)),
      };
      const disconnectedResult = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: disconnected },
      });
      expect(disconnectedResult.isError).toBe(true);
      expect(testDb.prepare("SELECT COUNT(*) AS count FROM reservations WHERE type = 'transit'").get()).toEqual({
        count: 0,
      });
    });
  });

  it('enforces demo, trip access, and reservation permissions', async () => {
    const { user: owner } = createUser(testDb);
    const { user: demo } = createUser(testDb, { email: 'demo@trek.app' });
    const { user: stranger } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { start_date: '2026-12-03', end_date: '2026-12-03' });
    const day = testDb.prepare('SELECT * FROM days WHERE trip_id = ?').get(trip.id) as any;
    addTripMember(testDb, trip.id, demo.id);
    addTripMember(testDb, trip.id, member.id);

    process.env.DEMO_MODE = 'true';
    await withHarness(demo.id, ['reservations:write'], async (harness) => {
      const result = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('demo mode');
    });
    delete process.env.DEMO_MODE;

    await withHarness(stranger.id, ['reservations:write'], async (harness) => {
      const result = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('access denied');
    });

    savePermissions({ reservation_edit: 'trip_owner' });
    await withHarness(member.id, ['reservations:write'], async (harness) => {
      const result = await harness.client.callTool({
        name: 'create_transit_journey',
        arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary },
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('permission');
    });

    expect(testDb.prepare("SELECT COUNT(*) AS count FROM reservations WHERE type = 'transit'").get()).toEqual({
      count: 0,
    });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(notifyBookingChangeMock).not.toHaveBeenCalled();
  });

  it('uses scheduled times when realtime stop times are unavailable', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { start_date: '2026-12-03', end_date: '2026-12-03' });
    const day = testDb.prepare('SELECT * FROM days WHERE trip_id = ?').get(trip.id) as any;
    const scheduledOnly = {
      ...itinerary,
      legs: itinerary.legs.map((leg) => ({
        ...leg,
        from: { ...leg.from, time: null, scheduledTime: leg.from.time },
        to: { ...leg.to, time: null, scheduledTime: leg.to.time },
      })),
    };

    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const result = parseToolResult(
        await harness.client.callTool({
          name: 'create_transit_journey',
          arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: scheduledOnly },
        }),
      ) as any;
      expect(result.reservation.reservation_time).toBe('2026-12-03T09:00');
      const metadata = JSON.parse(result.reservation.metadata);
      expect(metadata.transit.legs[1].from.time).toBe('09:05');
    });
  });

  // The provider's response taxonomy is wider than the mode whitelist a caller may request:
  // MOTIS's default TRANSIT expands to include AIRPLANE, ODM, RIDE_SHARING and OTHER. Norway's
  // GTFS, for one, routes Trondheim → Ålesund over AIRPLANE legs. Those itineraries must survive
  // the search and be persistable, exactly as they are in the web app.
  it('accepts provider leg modes outside the requestable mode whitelist', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { start_date: '2026-12-03', end_date: '2026-12-03' });
    const day = testDb.prepare('SELECT * FROM days WHERE trip_id = ?').get(trip.id) as any;
    const flying = {
      ...itinerary,
      legs: itinerary.legs.map((leg) => (leg.mode === 'WALK' ? leg : { ...leg, mode: 'AIRPLANE' })),
    };
    planMock.mockResolvedValue({ itineraries: [flying], provider: 'transitous' });

    await withHarness(user.id, ['geo:read'], async (harness) => {
      const routes = parseToolResult(
        await harness.client.callTool({ name: 'search_transit_routes', arguments: { from, to } }),
      ) as any;
      expect(routes.itineraries).toHaveLength(1);
      expect(routes.itineraries[0].legs[1].mode).toBe('AIRPLANE');
      expect(routes.dropped).toBe(0);
    });

    await withHarness(user.id, ['reservations:write'], async (harness) => {
      const result = parseToolResult(
        await harness.client.callTool({
          name: 'create_transit_journey',
          arguments: { tripId: trip.id, dayId: day.id, from, to, itinerary: flying },
        }),
      ) as any;
      expect(result.reservation.type).toBe('transit');
      const metadata = JSON.parse(result.reservation.metadata);
      expect(metadata.transit.legs[1].mode).toBe('AIRPLANE');
    });
  });

  it('reports how many provider itineraries failed validation', async () => {
    const { user } = createUser(testDb);
    const walkOnly = { ...itinerary, legs: [itinerary.legs[0]] };
    planMock.mockResolvedValue({ itineraries: [itinerary, walkOnly], provider: 'transitous' });

    await withHarness(user.id, ['geo:read'], async (harness) => {
      const routes = parseToolResult(
        await harness.client.callTool({ name: 'search_transit_routes', arguments: { from, to } }),
      ) as any;
      expect(routes.itineraries).toHaveLength(1);
      expect(routes.dropped).toBe(1);
    });
  });
});
