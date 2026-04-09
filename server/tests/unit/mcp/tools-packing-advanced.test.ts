/**
 * Unit tests for MCP packing advanced tools:
 * reorder_packing_items, list_packing_bags, create_packing_bag, update_packing_bag,
 * delete_packing_bag, set_bag_members, get_packing_category_assignees,
 * set_packing_category_assignees, apply_packing_template, save_packing_template,
 * bulk_import_packing.
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
import { createUser, createTrip, createPackingItem } from '../../helpers/factories';
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
// reorder_packing_items
// ---------------------------------------------------------------------------

describe('Tool: reorder_packing_items', () => {
  it('reorders packing items and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item1 = createPackingItem(testDb, trip.id, { name: 'Shirt' });
    const item2 = createPackingItem(testDb, trip.id, { name: 'Pants' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reorder_packing_items',
        arguments: { tripId: trip.id, orderedIds: [item2.id, item1.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:reordered', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const item = createPackingItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reorder_packing_items',
        arguments: { tripId: trip.id, orderedIds: [item.id] },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// list_packing_bags
// ---------------------------------------------------------------------------

describe('Tool: list_packing_bags', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'list_packing_bags',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.bags).toEqual([]);
    });
  });

  it('returns bags that exist', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(trip.id, 'Carry-on', '#ff0000');
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'list_packing_bags',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.bags).toHaveLength(1);
      expect(data.bags[0].name).toBe('Carry-on');
    });
  });
});

// ---------------------------------------------------------------------------
// create_packing_bag
// ---------------------------------------------------------------------------

describe('Tool: create_packing_bag', () => {
  it('creates a bag and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_packing_bag',
        arguments: { tripId: trip.id, name: 'Checked bag', color: '#3b82f6' },
      });
      const data = parseToolResult(result) as any;
      expect(data.bag).toBeDefined();
      expect(data.bag.name).toBe('Checked bag');
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:bag-created', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_packing_bag',
        arguments: { tripId: trip.id, name: 'Bag' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_packing_bag',
        arguments: { tripId: trip.id, name: 'Bag' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_packing_bag
// ---------------------------------------------------------------------------

describe('Tool: update_packing_bag', () => {
  it('updates bag name and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const r = testDb.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(trip.id, 'Old Name', '#aabbcc');
    const bag = testDb.prepare('SELECT * FROM packing_bags WHERE id = ?').get(r.lastInsertRowid) as any;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_packing_bag',
        arguments: { tripId: trip.id, bagId: bag.id, name: 'New Name' },
      });
      const data = parseToolResult(result) as any;
      expect(data.bag).toBeDefined();
      expect(data.bag.name).toBe('New Name');
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:bag-updated', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_packing_bag',
        arguments: { tripId: trip.id, bagId: 1, name: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_packing_bag
// ---------------------------------------------------------------------------

describe('Tool: delete_packing_bag', () => {
  it('deletes a bag and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const r = testDb.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(trip.id, 'Delete Me', '#000000');
    const bagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_packing_bag',
        arguments: { tripId: trip.id, bagId },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:bag-deleted', expect.any(Object));
      expect(testDb.prepare('SELECT id FROM packing_bags WHERE id = ?').get(bagId)).toBeUndefined();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_packing_bag',
        arguments: { tripId: trip.id, bagId: 1 },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// set_bag_members
// ---------------------------------------------------------------------------

describe('Tool: set_bag_members', () => {
  it('sets bag members and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const r = testDb.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(trip.id, 'My Bag', '#123456');
    const bagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_bag_members',
        arguments: { tripId: trip.id, bagId, userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:bag-members-updated', expect.any(Object));
    });
  });

  it('clears bag members when passed empty array', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const r = testDb.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(trip.id, 'My Bag', '#123456');
    const bagId = r.lastInsertRowid as number;
    testDb.prepare('INSERT OR IGNORE INTO packing_bag_members (bag_id, user_id) VALUES (?, ?)').run(bagId, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_bag_members',
        arguments: { tripId: trip.id, bagId, userIds: [] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// get_packing_category_assignees
// ---------------------------------------------------------------------------

describe('Tool: get_packing_category_assignees', () => {
  it('returns empty object initially', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_packing_category_assignees',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.assignees).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// set_packing_category_assignees
// ---------------------------------------------------------------------------

describe('Tool: set_packing_category_assignees', () => {
  it('sets category assignees and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_packing_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Clothing', userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:assignees', expect.any(Object));
    });
  });

  it('clears assignees when passed empty array', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare('INSERT INTO packing_category_assignees (trip_id, category_name, user_id) VALUES (?, ?, ?)').run(trip.id, 'Clothing', user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_packing_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Clothing', userIds: [] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_packing_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Electronics', userIds: [] },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// apply_packing_template
// ---------------------------------------------------------------------------

describe('Tool: apply_packing_template', () => {
  it('returns error for non-existent template', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'apply_packing_template',
        arguments: { tripId: trip.id, templateId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// save_packing_template
// ---------------------------------------------------------------------------

describe('Tool: save_packing_template', () => {
  it('saves the current packing list as a template', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createPackingItem(testDb, trip.id, { name: 'Toothbrush', category: 'Toiletries' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'save_packing_template',
        arguments: { tripId: trip.id, templateName: 'Weekend Trip' },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'save_packing_template',
        arguments: { tripId: trip.id, templateName: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// bulk_import_packing
// ---------------------------------------------------------------------------

describe('Tool: bulk_import_packing', () => {
  it('imports multiple packing items and count matches', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const items = [
      { name: 'Passport', category: 'Documents' },
      { name: 'Charger', category: 'Electronics' },
      { name: 'Sunscreen', category: 'Toiletries' },
    ];
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'bulk_import_packing',
        arguments: { tripId: trip.id, items },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(items.length);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'packing:updated', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'bulk_import_packing',
        arguments: { tripId: trip.id, items: [{ name: 'Item' }] },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'bulk_import_packing',
        arguments: { tripId: trip.id, items: [{ name: 'Item' }] },
      });
      expect(result.isError).toBe(true);
    });
  });
});
