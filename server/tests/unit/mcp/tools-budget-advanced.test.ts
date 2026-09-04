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
import { createUser, createTrip, createBudgetItem, addTripMember } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, parseResourceResult, type McpHarness } from '../../helpers/mcp-harness';
import { BudgetController } from '../../../src/nest/budget/budget.controller';
import { BudgetService } from '../../../src/nest/budget/budget.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { ExchangeRatesService } from '../../../src/nest/budget/exchange-rates.service';
import { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import type { TripAccess } from '../../../src/nest/database/database.service';
import type { User } from '../../../src/types';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
  // get_settlement_summary calls getRates(), which is a real fetch to
  // api.frankfurter.dev with a 10 s abort. One case used to stub this inline;
  // hoisted so a second settlement case cannot quietly reintroduce the call.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});

afterAll(() => {
  vi.unstubAllGlobals();
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
  it('sets members and returns a hydrated item with members/payers', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id, { name: 'Flights', total_price: 500 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: item.id, userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      // Regression: returns a hydrated item, not the raw row from updateMembers.
      expect(data.item.members.map((m: any) => m.user_id)).toEqual([user.id]);
      expect(Array.isArray(data.item.payers)).toBe(true);
      // Quirk fix: the broadcast carries the REST payload shape (the legacy
      // MCP-specific { item } shape was a silent no-op in the client handler).
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:members-updated', expect.objectContaining({
        itemId: item.id,
        members: expect.arrayContaining([expect.objectContaining({ user_id: user.id })]),
        persons: 1,
      }));
    });
  });

  it('returns an error for an item not in the trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_budget_item_members',
        arguments: { tripId: trip.id, itemId: 99999, userIds: [user.id] },
      });
      expect(result.isError).toBe(true);
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
// create_budget_item_with_members
// ---------------------------------------------------------------------------

describe('Tool: create_budget_item_with_members', () => {
  it('assigns the given members and returns a hydrated item', async () => {
    const { user } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_budget_item_with_members',
        arguments: { tripId: trip.id, name: 'Villa', total_price: 800, userIds: [user.id, member.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.members.map((m: any) => m.user_id).sort()).toEqual([user.id, member.id].sort());
      expect(data.item.persons).toBe(2);
    });
  });

  // Regression: omitting userIds previously produced an empty-member (unsaveable) entity.
  it('defaults to all trip members when userIds omitted', async () => {
    const { user } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_budget_item_with_members',
        arguments: { tripId: trip.id, name: 'Shared cab', total_price: 50 },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.members.map((m: any) => m.user_id).sort()).toEqual([user.id, member.id].sort());
      expect(data.item.members.length).toBeGreaterThan(0);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_budget_item_with_members',
        arguments: { tripId: trip.id, name: 'X', total_price: 1 },
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
      // Quirk fix: the broadcast carries the REST payload shape (the legacy
      // MCP-specific { itemId, member } shape was a silent no-op in the client).
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:member-paid-updated', expect.objectContaining({ itemId: item.id, userId: user.id, paid: 1 }));
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
// Settlements (settle-up payments)
// ---------------------------------------------------------------------------

describe('Settlement tools', () => {
  function tripWithTwo() {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, other.id);
    return { user, other, trip };
  }

  it('create_settlement records a payment, broadcasts, and is listed', async () => {
    const { user, other, trip } = tripWithTwo();
    await withHarness(user.id, async (h) => {
      const created = await h.client.callTool({
        name: 'create_settlement',
        arguments: { tripId: trip.id, from_user_id: other.id, to_user_id: user.id, amount: 42.5 },
      });
      const cData = parseToolResult(created) as any;
      expect(cData.settlement.from_user_id).toBe(other.id);
      expect(cData.settlement.to_user_id).toBe(user.id);
      expect(cData.settlement.amount).toBe(42.5);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:settlement-created', expect.any(Object));

      const listed = await h.client.callTool({ name: 'list_settlements', arguments: { tripId: trip.id } });
      const lData = parseToolResult(listed) as any;
      expect(lData.settlements).toHaveLength(1);
      expect(lData.settlements[0].id).toBe(cData.settlement.id);
    });
  });

  it('update_settlement changes the amount; delete_settlement removes it', async () => {
    const { user, other, trip } = tripWithTwo();
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(await h.client.callTool({
        name: 'create_settlement',
        arguments: { tripId: trip.id, from_user_id: other.id, to_user_id: user.id, amount: 10 },
      })) as any;
      const id = created.settlement.id;

      const updated = parseToolResult(await h.client.callTool({
        name: 'update_settlement',
        arguments: { tripId: trip.id, settlementId: id, from_user_id: other.id, to_user_id: user.id, amount: 25 },
      })) as any;
      expect(updated.settlement.amount).toBe(25);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:settlement-updated', expect.any(Object));

      const deleted = parseToolResult(await h.client.callTool({
        name: 'delete_settlement',
        arguments: { tripId: trip.id, settlementId: id },
      })) as any;
      expect(deleted.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'budget:settlement-deleted', expect.any(Object));

      const remaining = testDb.prepare('SELECT count(*) as cnt FROM budget_settlements WHERE trip_id = ?').get(trip.id) as any;
      expect(remaining.cnt).toBe(0);
    });
  });

  it('update_settlement returns an error when the settlement is missing', async () => {
    const { user, other, trip } = tripWithTwo();
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_settlement',
        arguments: { tripId: trip.id, settlementId: 99999, from_user_id: other.id, to_user_id: user.id, amount: 5 },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('create_settlement is denied for a non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_settlement',
        arguments: { tripId: trip.id, from_user_id: other.id, to_user_id: other.id, amount: 5 },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('get_settlement_summary agrees with GET /budget/settlement, unpaid expense included (#2225)', async () => {
    // The two surfaces resolve the trip currency and the rates separately before
    // calling calculateSettlement, so the parity that matters is on the payload.
    // The fixture carries the row the fix is about: a total nobody has paid.
    const { user, other, trip } = tripWithTwo();
    const paid = createBudgetItem(testDb, trip.id, { total_price: 100 });
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 0), (?, ?, 0)')
      .run(paid.id, user.id, paid.id, other.id);
    testDb.prepare('INSERT INTO budget_item_payers (budget_item_id, user_id, amount) VALUES (?, ?, ?)')
      .run(paid.id, user.id, 100);
    const unpaid = createBudgetItem(testDb, trip.id, { total_price: 40 });
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 0)')
      .run(unpaid.id, other.id);

    const dbService = new DatabaseService(testDb);
    const controller = new BudgetController(
      new BudgetService(dbService, new PermissionsService(dbService), new ExchangeRatesService(), new RealtimeService()),
    );
    const rest = await controller.settlement(
      { id: user.id } as User,
      { id: trip.id, user_id: user.id } as TripAccess,
      String(trip.id),
    );

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_settlement_summary', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as { summary: typeof rest };
      expect(data.summary.balances).toEqual(rest.balances);
      expect(data.summary.flows).toEqual(rest.flows);
      // Only the paid 100 settles; the 40 nobody paid is outstanding, not owed.
      expect(rest.balances.map(b => b.balance)).toEqual([50, -50]);
    });
  });

  it('get_settlement_summary returns balances and flows', async () => {
    try {
      const { user, other, trip } = tripWithTwo();
      // user paid 100 for an item split between both → other owes user 50.
      const item = createBudgetItem(testDb, trip.id, { total_price: 100 });
      testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 0), (?, ?, 0)')
        .run(item.id, user.id, item.id, other.id);
      testDb.prepare('INSERT INTO budget_item_payers (budget_item_id, user_id, amount) VALUES (?, ?, ?)')
        .run(item.id, user.id, 100);
      await withHarness(user.id, async (h) => {
        const result = await h.client.callTool({ name: 'get_settlement_summary', arguments: { tripId: trip.id } });
        const data = parseToolResult(result) as any;
        expect(data.summary).toBeDefined();
        expect(Array.isArray(data.summary.balances)).toBe(true);
        expect(Array.isArray(data.summary.flows)).toBe(true);
      });
    } finally {
      vi.unstubAllGlobals();
    }
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
      const data = parseResourceResult(result);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/budget/per-person` });
      const data = parseResourceResult(result) as { error?: string };
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
      // The resource may answer with a summary object or a bare array, and the
      // assertion below accepts either, so keep the balances field optional.
      const data = parseResourceResult(result) as { balances?: unknown };
      expect(data).toBeDefined();
      expect(Array.isArray(data.balances) || Array.isArray(data)).toBe(true);
    });
  });
});
