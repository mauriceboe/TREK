/**
 * Unit tests for MCP extra assignment/reservation tools:
 * move_assignment, get_assignment_participants, set_assignment_participants, reorder_reservations.
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
import { createUser, createTrip, createDay, createPlace, createDayAssignment, createReservation } from '../../helpers/factories';
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
// move_assignment
// ---------------------------------------------------------------------------

describe('Tool: move_assignment', () => {
  it('moves assignment to a different day and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day1 = createDay(testDb, trip.id);
    const day2 = createDay(testDb, trip.id);
    const place = createPlace(testDb, trip.id);
    const assignment = createDayAssignment(testDb, day1.id, place.id);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'move_assignment',
        arguments: { tripId: trip.id, assignmentId: assignment.id, newDayId: day2.id, oldDayId: day1.id, orderIndex: 0 },
      });
      const data = parseToolResult(result) as any;
      expect(data.assignment).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'assignment:moved', expect.any(Object));
      // Verify the assignment was moved
      const updated = testDb.prepare('SELECT day_id FROM day_assignments WHERE id = ?').get(assignment.id) as any;
      expect(updated.day_id).toBe(day2.id);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'move_assignment',
        arguments: { tripId: trip.id, assignmentId: 1, newDayId: day.id, oldDayId: day.id },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'move_assignment',
        arguments: { tripId: trip.id, assignmentId: 1, newDayId: day.id, oldDayId: day.id },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// get_assignment_participants
// ---------------------------------------------------------------------------

describe('Tool: get_assignment_participants', () => {
  it('returns empty participants array initially', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    const place = createPlace(testDb, trip.id);
    const assignment = createDayAssignment(testDb, day.id, place.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_assignment_participants',
        arguments: { tripId: trip.id, assignmentId: assignment.id },
      });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.participants)).toBe(true);
      expect(data.participants).toHaveLength(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_assignment_participants', arguments: { tripId: trip.id, assignmentId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// set_assignment_participants
// ---------------------------------------------------------------------------

describe('Tool: set_assignment_participants', () => {
  it('sets participants and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    const place = createPlace(testDb, trip.id);
    const assignment = createDayAssignment(testDb, day.id, place.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_assignment_participants',
        arguments: { tripId: trip.id, assignmentId: assignment.id, userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.participants)).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'assignment:participants', expect.any(Object));
    });
  });

  it('empty array clears participants', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    const place = createPlace(testDb, trip.id);
    const assignment = createDayAssignment(testDb, day.id, place.id);
    // First set
    testDb.prepare('INSERT INTO assignment_participants (assignment_id, user_id) VALUES (?, ?)').run(assignment.id, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_assignment_participants',
        arguments: { tripId: trip.id, assignmentId: assignment.id, userIds: [] },
      });
      const data = parseToolResult(result) as any;
      expect(data.participants).toEqual([]);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_assignment_participants',
        arguments: { tripId: trip.id, assignmentId: 1, userIds: [] },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// reorder_reservations
// ---------------------------------------------------------------------------

describe('Tool: reorder_reservations', () => {
  it('returns success and broadcasts reservation:positions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res1 = createReservation(testDb, trip.id, { title: 'Flight', type: 'flight' });
    const res2 = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reorder_reservations',
        arguments: {
          tripId: trip.id,
          positions: [
            { id: res1.id, day_plan_position: 1 },
            { id: res2.id, day_plan_position: 0 },
          ],
        },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'reservation:positions', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reorder_reservations',
        arguments: { tripId: trip.id, positions: [{ id: 1, day_plan_position: 0 }] },
      });
      expect(result.isError).toBe(true);
    });
  });
});
