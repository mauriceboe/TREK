/**
 * Unit tests for MCP todo tools:
 * create_todo, update_todo, toggle_todo, delete_todo, reorder_todos,
 * list_todos, get_todo_category_assignees, set_todo_category_assignees.
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
import { createUser, createTrip, createTodoItem } from '../../helpers/factories';
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
// list_todos
// ---------------------------------------------------------------------------

describe('Tool: list_todos', () => {
  it('returns empty list for a new trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_todos', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toEqual([]);
    });
  });

  it('returns todos ordered by sort_order', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createTodoItem(testDb, trip.id, { name: 'First' });
    createTodoItem(testDb, trip.id, { name: 'Second' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_todos', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(2);
      expect(data.items[0].name).toBe('First');
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_todos', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// create_todo
// ---------------------------------------------------------------------------

describe('Tool: create_todo', () => {
  it('creates a todo item with all fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_todo',
        arguments: {
          tripId: trip.id,
          name: 'Book hotel',
          category: 'Booking',
          due_date: '2025-06-01',
          description: 'Find a good deal',
          priority: 2,
        },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.name).toBe('Book hotel');
      expect(data.item.category).toBe('Booking');
      expect(data.item.due_date).toBe('2025-06-01');
      expect(data.item.priority).toBe(2);
      expect(data.item.checked).toBe(0);
    });
  });

  it('creates a minimal todo item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_todo',
        arguments: { tripId: trip.id, name: 'Pack bags' },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.name).toBe('Pack bags');
      expect(data.item.checked).toBe(0);
    });
  });

  it('broadcasts todo:created event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'Test' } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:created', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_todo
// ---------------------------------------------------------------------------

describe('Tool: update_todo', () => {
  it('updates todo name and category', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id, { name: 'Old name', category: 'General' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_todo',
        arguments: { tripId: trip.id, itemId: item.id, name: 'New name', category: 'Booking' },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.name).toBe('New name');
      expect(data.item.category).toBe('Booking');
    });
  });

  it('clears due_date when passed null', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare("INSERT INTO todo_items (trip_id, name, checked, sort_order, due_date) VALUES (?, 'Task', 0, 0, '2025-01-01')").run(trip.id);
    const item = testDb.prepare('SELECT * FROM todo_items WHERE trip_id = ? ORDER BY id DESC LIMIT 1').get(trip.id) as any;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_todo',
        arguments: { tripId: trip.id, itemId: item.id, due_date: null },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.due_date).toBeNull();
    });
  });

  it('broadcasts todo:updated event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'update_todo', arguments: { tripId: trip.id, itemId: item.id, name: 'Updated' } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:updated', expect.any(Object));
    });
  });

  it('returns error for item not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_todo', arguments: { tripId: trip.id, itemId: 99999, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_todo', arguments: { tripId: trip.id, itemId: item.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// toggle_todo
// ---------------------------------------------------------------------------

describe('Tool: toggle_todo', () => {
  it('marks a todo as done', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_todo',
        arguments: { tripId: trip.id, itemId: item.id, checked: true },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.checked).toBe(1);
    });
  });

  it('unchecks a done todo', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id, { checked: 1 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_todo',
        arguments: { tripId: trip.id, itemId: item.id, checked: false },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.checked).toBe(0);
    });
  });

  it('broadcasts todo:updated event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'toggle_todo', arguments: { tripId: trip.id, itemId: item.id, checked: true } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:updated', expect.any(Object));
    });
  });

  it('returns error for item not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_todo', arguments: { tripId: trip.id, itemId: 99999, checked: true } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_todo
// ---------------------------------------------------------------------------

describe('Tool: delete_todo', () => {
  it('deletes an existing todo item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, itemId: item.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM todo_items WHERE id = ?').get(item.id)).toBeUndefined();
    });
  });

  it('broadcasts todo:deleted event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, itemId: item.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:deleted', expect.any(Object));
    });
  });

  it('returns error for item not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, itemId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const item = createTodoItem(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, itemId: item.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// reorder_todos
// ---------------------------------------------------------------------------

describe('Tool: reorder_todos', () => {
  it('reorders todo items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item1 = createTodoItem(testDb, trip.id, { name: 'First' });
    const item2 = createTodoItem(testDb, trip.id, { name: 'Second' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reorder_todos',
        arguments: { tripId: trip.id, orderedIds: [item2.id, item1.id] },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      // item2 should now have sort_order 0
      const updated = testDb.prepare('SELECT sort_order FROM todo_items WHERE id = ?').get(item2.id) as any;
      expect(updated.sort_order).toBe(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'reorder_todos', arguments: { tripId: trip.id, orderedIds: [1] } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// get_todo_category_assignees
// ---------------------------------------------------------------------------

describe('Tool: get_todo_category_assignees', () => {
  it('returns empty object for a new trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_todo_category_assignees', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.assignees).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// set_todo_category_assignees
// ---------------------------------------------------------------------------

describe('Tool: set_todo_category_assignees', () => {
  it('sets category assignees and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_todo_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Booking', userIds: [user.id] },
      });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.assignees)).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:assignees', expect.any(Object));
    });
  });

  it('clears assignees when passed empty array', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Set then clear
    testDb.prepare('INSERT INTO todo_category_assignees (trip_id, category_name, user_id) VALUES (?, ?, ?)').run(trip.id, 'Booking', user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_todo_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Booking', userIds: [] },
      });
      const data = parseToolResult(result) as any;
      expect(data.assignees).toEqual([]);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'set_todo_category_assignees',
        arguments: { tripId: trip.id, categoryName: 'Test', userIds: [] },
      });
      expect(result.isError).toBe(true);
    });
  });
});
