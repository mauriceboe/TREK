/**
 * Unit tests for MCP notification tools:
 * list_notifications, get_unread_notification_count, mark_notification_read,
 * mark_notification_unread, mark_all_notifications_read, delete_notification,
 * delete_all_notifications.
 * Also covers the resource trek://notifications/in-app.
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

vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, parseResourceResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

// ---------------------------------------------------------------------------
// Helper: insert a notification directly into the DB
// ---------------------------------------------------------------------------

function createNotification(db: any, userId: number, overrides: any = {}) {
  const r = db.prepare(
    `INSERT INTO notifications (type, scope, target, recipient_id, title_key, text_key, is_read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(
    overrides.type ?? 'simple',
    overrides.scope ?? 'user',
    overrides.target ?? 0,
    userId,
    overrides.title_key ?? 'notification.test.title',
    overrides.text_key ?? 'notification.test.body'
  );
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(r.lastInsertRowid);
}

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

async function withResourceHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withTools: false, withResources: true });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// list_notifications
// ---------------------------------------------------------------------------

describe('Tool: list_notifications', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.notifications).toEqual([]);
    });
  });

  it('returns notifications when they exist', async () => {
    const { user } = createUser(testDb);
    createNotification(testDb, user.id, { title_key: 'notif.first' });
    createNotification(testDb, user.id, { title_key: 'notif.second' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.notifications).toHaveLength(2);
    });
  });

  it('returns only unread notifications when unread_only is true', async () => {
    const { user } = createUser(testDb);
    createNotification(testDb, user.id);
    const read = createNotification(testDb, user.id) as any;
    testDb.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(read.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: { unread_only: true } });
      const data = parseToolResult(result) as any;
      expect(data.notifications).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// get_unread_notification_count
// ---------------------------------------------------------------------------

describe('Tool: get_unread_notification_count', () => {
  it('returns 0 initially', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_unread_notification_count', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.count).toBe(0);
    });
  });

  it('returns 1 after inserting one unread notification', async () => {
    const { user } = createUser(testDb);
    createNotification(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_unread_notification_count', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.count).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// mark_notification_read
// ---------------------------------------------------------------------------

describe('Tool: mark_notification_read', () => {
  it('flips is_read to 1 and returns success', async () => {
    const { user } = createUser(testDb);
    const notif = createNotification(testDb, user.id) as any;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_notification_read',
        arguments: { notificationId: notif.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const row = testDb.prepare('SELECT is_read FROM notifications WHERE id = ?').get(notif.id) as any;
      expect(row.is_read).toBe(1);
    });
  });

  it('returns isError for non-existent notification', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_notification_read',
        arguments: { notificationId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const notif = createNotification(testDb, user.id) as any;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_notification_read',
        arguments: { notificationId: notif.id },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// mark_notification_unread
// ---------------------------------------------------------------------------

describe('Tool: mark_notification_unread', () => {
  it('flips is_read to 0', async () => {
    const { user } = createUser(testDb);
    const notif = createNotification(testDb, user.id) as any;
    testDb.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notif.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_notification_unread',
        arguments: { notificationId: notif.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const row = testDb.prepare('SELECT is_read FROM notifications WHERE id = ?').get(notif.id) as any;
      expect(row.is_read).toBe(0);
    });
  });

  it('returns isError for non-existent notification', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_notification_unread',
        arguments: { notificationId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// mark_all_notifications_read
// ---------------------------------------------------------------------------

describe('Tool: mark_all_notifications_read', () => {
  it('marks all notifications read and returns count', async () => {
    const { user } = createUser(testDb);
    createNotification(testDb, user.id);
    createNotification(testDb, user.id);
    createNotification(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'mark_all_notifications_read', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(3);
      const unread = (testDb.prepare('SELECT COUNT(*) as c FROM notifications WHERE recipient_id = ? AND is_read = 0').get(user.id) as any).c;
      expect(unread).toBe(0);
    });
  });

  it('returns count 0 when nothing to mark', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'mark_all_notifications_read', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.count).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_notification
// ---------------------------------------------------------------------------

describe('Tool: delete_notification', () => {
  it('removes the notification row and returns success', async () => {
    const { user } = createUser(testDb);
    const notif = createNotification(testDb, user.id) as any;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_notification',
        arguments: { notificationId: notif.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM notifications WHERE id = ?').get(notif.id)).toBeUndefined();
    });
  });

  it('returns isError for non-existent notification', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_notification',
        arguments: { notificationId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_all_notifications
// ---------------------------------------------------------------------------

describe('Tool: delete_all_notifications', () => {
  it('clears all notifications for user and returns count', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    createNotification(testDb, user.id);
    createNotification(testDb, user.id);
    createNotification(testDb, other.id); // should not be deleted
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_all_notifications', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(2);
      const remaining = (testDb.prepare('SELECT COUNT(*) as c FROM notifications WHERE recipient_id = ?').get(user.id) as any).c;
      expect(remaining).toBe(0);
      const otherRemaining = (testDb.prepare('SELECT COUNT(*) as c FROM notifications WHERE recipient_id = ?').get(other.id) as any).c;
      expect(otherRemaining).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Resource: trek://notifications/in-app
// ---------------------------------------------------------------------------

describe('Resource: trek://notifications/in-app', () => {
  it('returns notifications list', async () => {
    const { user } = createUser(testDb);
    createNotification(testDb, user.id, { title_key: 'notif.test' });
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://notifications/in-app' });
      const data = parseResourceResult(result) as any;
      expect(data.notifications).toBeDefined();
      expect(Array.isArray(data.notifications)).toBe(true);
      expect(data.notifications).toHaveLength(1);
    });
  });

  it('returns empty notifications for user with none', async () => {
    const { user } = createUser(testDb);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://notifications/in-app' });
      const data = parseResourceResult(result) as any;
      expect(data.notifications).toEqual([]);
    });
  });
});
