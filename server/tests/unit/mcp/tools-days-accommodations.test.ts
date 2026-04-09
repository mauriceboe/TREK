/**
 * Unit tests for MCP day and accommodation tools:
 * create_day, delete_day,
 * create_accommodation, update_accommodation, delete_accommodation.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, createDay, createPlace, createDayAccommodation } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// create_day
// ---------------------------------------------------------------------------

describe('Tool: create_day', () => {
  it('creates a day with a date', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_day',
        arguments: { tripId: trip.id, date: '2025-06-15', notes: 'Arrival day' },
      });
      const data = parseToolResult(result) as any;
      expect(data.day).toBeDefined();
      expect(data.day.date).toBe('2025-06-15');
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'day:created', expect.any(Object));
    });
  });

  it('creates a dateless day', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_day',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.day).toBeDefined();
      expect(data.day.date).toBeNull();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_day', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_day', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_day
// ---------------------------------------------------------------------------

describe('Tool: delete_day', () => {
  it('deletes a day and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_day',
        arguments: { tripId: trip.id, dayId: day.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'day:deleted', { id: day.id });
      expect(testDb.prepare('SELECT id FROM days WHERE id = ?').get(day.id)).toBeUndefined();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_day', arguments: { tripId: trip.id, dayId: day.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// create_accommodation
// ---------------------------------------------------------------------------

describe('Tool: create_accommodation', () => {
  it('creates an accommodation and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id, { name: 'Hotel du Louvre' });
    const day1 = createDay(testDb, trip.id, { date: '2025-06-15' });
    const day2 = createDay(testDb, trip.id, { date: '2025-06-17' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_accommodation',
        arguments: {
          tripId: trip.id,
          place_id: place.id,
          start_day_id: day1.id,
          end_day_id: day2.id,
          check_in: '15:00',
          check_out: '11:00',
          confirmation: 'CONF123',
        },
      });
      const data = parseToolResult(result) as any;
      expect(data.accommodation).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'accommodation:created', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const place = createPlace(testDb, trip.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_accommodation',
        arguments: { tripId: trip.id, place_id: place.id, start_day_id: day.id, end_day_id: day.id },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_accommodation',
        arguments: { tripId: trip.id, place_id: place.id, start_day_id: day.id, end_day_id: day.id },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_accommodation
// ---------------------------------------------------------------------------

describe('Tool: update_accommodation', () => {
  it('updates accommodation fields and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    const day1 = createDay(testDb, trip.id);
    const day2 = createDay(testDb, trip.id);
    const acc = createDayAccommodation(testDb, trip.id, place.id, day1.id, day2.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_accommodation',
        arguments: { tripId: trip.id, accommodationId: acc.id, confirmation: 'NEW-CONF', check_in: '14:00' },
      });
      const data = parseToolResult(result) as any;
      expect(data.accommodation).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'accommodation:updated', expect.any(Object));
    });
  });

  it('returns error for non-existent accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_accommodation',
        arguments: { tripId: trip.id, accommodationId: 99999, confirmation: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_accommodation',
        arguments: { tripId: trip.id, accommodationId: 1, confirmation: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_accommodation
// ---------------------------------------------------------------------------

describe('Tool: delete_accommodation', () => {
  it('deletes accommodation and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    const day1 = createDay(testDb, trip.id);
    const day2 = createDay(testDb, trip.id);
    const acc = createDayAccommodation(testDb, trip.id, place.id, day1.id, day2.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_accommodation',
        arguments: { tripId: trip.id, accommodationId: acc.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'accommodation:deleted', expect.objectContaining({ id: acc.id }));
      expect(testDb.prepare('SELECT id FROM day_accommodations WHERE id = ?').get(acc.id)).toBeUndefined();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_accommodation', arguments: { tripId: trip.id, accommodationId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});
