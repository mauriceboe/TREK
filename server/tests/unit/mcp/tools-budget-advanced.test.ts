/**
 * Unit tests for MCP budget advanced tools:
 * set_budget_item_members, toggle_budget_member_paid.
 * Resources: trek://trips/{tripId}/budget/per-person, trek://trips/{tripId}/budget/settlement.
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
import { createUser, createTrip, createBudgetItem } from '../../helpers/factories';
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

async function withResourceHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: true });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// set_budget_item_members
// ---------------------------------------------------------------------------

describe('Tool: set_budget_item_members', () => {
  it('sets members and broadcasts budget:members-updated', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id, { name: 'Flights', total_price: 500 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: item.id, userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.item).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:members-updated', expect.any(Object));
    });
  });

  it('empty array clears members', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id);
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id) VALUES (?, ?)').run(item.id, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: item.id, userIds: [] },
      });
      const data = parseToolResult(result) as any;
      expect(data.item).toBeDefined();
      const remaining = testDb.prepare('SELECT count(*) as cnt FROM budget_item_members WHERE budget_item_id = ?').get(item.id) as any;
      expect(remaining.cnt).toBe(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const item = createBudgetItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: item.id, userIds: [] },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: item.id, userIds: [] },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// toggle_budget_member_paid
// ---------------------------------------------------------------------------

describe('Tool: toggle_budget_member_paid', () => {
  it('flips paid flag and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id, { total_price: 200 });
    // Add member first
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 0)').run(item.id, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_budget_member_paid',
        arguments: { tripId: trip.id, itemId: item.id, memberId: user.id, paid: true },
      });
      const data = parseToolResult(result) as any;
      expect(data.member).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:member-paid-updated', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const item = createBudgetItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_budget_member_paid',
        arguments: { tripId: trip.id, itemId: item.id, memberId: user.id, paid: true },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-person resource
// ---------------------------------------------------------------------------

describe('Resource: trek://trips/{tripId}/budget/per-person', () => {
  it('returns array for trip with no items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/budget/per-person` });
      const data = JSON.parse(result.contents[0].text as string);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/budget/per-person` });
      const data = JSON.parse(result.contents[0].text as string);
      expect(data.error).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Settlement resource
// ---------------------------------------------------------------------------

describe('Resource: trek://trips/{tripId}/budget/settlement', () => {
  it('returns settlement object for trip with no items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/budget/settlement` });
      const data = JSON.parse(result.contents[0].text as string);
      expect(data).toBeDefined();
      expect(Array.isArray(data.balances) || Array.isArray(data)).toBe(true);
    });
  });
});
