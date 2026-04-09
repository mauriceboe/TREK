/**
 * Unit tests for MCP file tools:
 * list_files, update_file_metadata, toggle_file_star, trash_file, restore_file,
 * permanent_delete_file, empty_trash, link_file, unlink_file, list_file_links.
 * Note: actual file-system deletion is not tested (files don't exist on disk in tests).
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
import { createUser, createTrip } from '../../helpers/factories';
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

/** Helper: insert a fake file row directly (no actual file on disk needed) */
function createFileRow(tripId: number, overrides: Partial<{
  filename: string; original_name: string; deleted_at: string | null; starred: number
}> = {}) {
  const result = testDb.prepare(`
    INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    tripId,
    overrides.filename ?? `test-${Date.now()}.txt`,
    overrides.original_name ?? 'test.txt',
    1024,
    'text/plain'
  );
  const id = result.lastInsertRowid as number;
  if (overrides.starred !== undefined) {
    testDb.prepare('UPDATE trip_files SET starred = ? WHERE id = ?').run(overrides.starred, id);
  }
  if (overrides.deleted_at !== undefined) {
    testDb.prepare('UPDATE trip_files SET deleted_at = ? WHERE id = ?').run(overrides.deleted_at, id);
  }
  return testDb.prepare('SELECT * FROM trip_files WHERE id = ?').get(id) as any;
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

describe('Tool: list_files', () => {
  it('returns empty list for a new trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.files).toEqual([]);
    });
  });

  it('returns active files', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createFileRow(trip.id, { original_name: 'doc.pdf' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.files).toHaveLength(1);
    });
  });

  it('returns trash when showTrash=true', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id, showTrash: true } });
      const data = parseToolResult(result) as any;
      expect(data.files).toHaveLength(1);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_files', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_file_metadata
// ---------------------------------------------------------------------------

describe('Tool: update_file_metadata', () => {
  it('updates file description', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_file_metadata',
        arguments: { tripId: trip.id, fileId: file.id, description: 'My document' },
      });
      const data = parseToolResult(result) as any;
      expect(data.file.description).toBe('My document');
    });
  });

  it('broadcasts file:updated event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'update_file_metadata',
        arguments: { tripId: trip.id, fileId: file.id, description: 'Updated' },
      });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:updated', expect.any(Object));
    });
  });

  it('returns error for file not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_file_metadata',
        arguments: { tripId: trip.id, fileId: 99999, description: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_file_metadata',
        arguments: { tripId: trip.id, fileId: file.id, description: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// toggle_file_star
// ---------------------------------------------------------------------------

describe('Tool: toggle_file_star', () => {
  it('stars an unstarred file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id, { starred: 0 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_file_star', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.file.starred).toBe(1);
    });
  });

  it('unstars a starred file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id, { starred: 1 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_file_star', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.file.starred).toBe(0);
    });
  });

  it('broadcasts file:updated event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'toggle_file_star', arguments: { tripId: trip.id, fileId: file.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:updated', expect.any(Object));
    });
  });

  it('returns error for file not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_file_star', arguments: { tripId: trip.id, fileId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// trash_file
// ---------------------------------------------------------------------------

describe('Tool: trash_file', () => {
  it('soft-deletes a file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'trash_file', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const dbFile = testDb.prepare('SELECT deleted_at FROM trip_files WHERE id = ?').get(file.id) as any;
      expect(dbFile.deleted_at).toBeTruthy();
    });
  });

  it('broadcasts file:deleted event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'trash_file', arguments: { tripId: trip.id, fileId: file.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:deleted', expect.any(Object));
    });
  });

  it('returns error for file not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'trash_file', arguments: { tripId: trip.id, fileId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// restore_file
// ---------------------------------------------------------------------------

describe('Tool: restore_file', () => {
  it('restores a trashed file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'restore_file', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.file).toBeTruthy();
      const dbFile = testDb.prepare('SELECT deleted_at FROM trip_files WHERE id = ?').get(file.id) as any;
      expect(dbFile.deleted_at).toBeNull();
    });
  });

  it('broadcasts file:created event on restore', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'restore_file', arguments: { tripId: trip.id, fileId: file.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:created', expect.any(Object));
    });
  });

  it('returns error for file not in trash', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id); // not in trash
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'restore_file', arguments: { tripId: trip.id, fileId: file.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// permanent_delete_file
// ---------------------------------------------------------------------------

describe('Tool: permanent_delete_file', () => {
  it('permanently removes a trashed file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'permanent_delete_file', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(file.id)).toBeUndefined();
    });
  });

  it('returns error for file not in trash', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id); // active file
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'permanent_delete_file', arguments: { tripId: trip.id, fileId: file.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// empty_trash
// ---------------------------------------------------------------------------

describe('Tool: empty_trash', () => {
  it('deletes all trashed files', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    createFileRow(trip.id, { deleted_at: new Date().toISOString() });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'empty_trash', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(data.deleted).toBe(2);
    });
  });

  it('returns 0 when trash is already empty', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'empty_trash', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.deleted).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// link_file / unlink_file / list_file_links
// ---------------------------------------------------------------------------

describe('Tool: link_file', () => {
  it('creates a link to a place', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    // Insert a fake place
    const placeResult = testDb.prepare("INSERT INTO places (trip_id, name) VALUES (?, 'Test Place')").run(trip.id);
    const placeId = placeResult.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'link_file',
        arguments: { tripId: trip.id, fileId: file.id, place_id: placeId },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.links)).toBe(true);
    });
  });

  it('returns error for file not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'link_file', arguments: { tripId: trip.id, fileId: 99999, place_id: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Tool: unlink_file', () => {
  it('removes a file link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    // Insert a real place then a link
    const placeRes = testDb.prepare("INSERT INTO places (trip_id, name) VALUES (?, 'P')").run(trip.id);
    const placeId = placeRes.lastInsertRowid as number;
    const linkResult = testDb.prepare(
      'INSERT INTO file_links (file_id, place_id) VALUES (?, ?)'
    ).run(file.id, placeId);
    const linkId = linkResult.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'unlink_file', arguments: { tripId: trip.id, fileId: file.id, linkId } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM file_links WHERE id = ?').get(linkId)).toBeUndefined();
    });
  });
});

describe('Tool: list_file_links', () => {
  it('returns links for a file', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    // Insert a real place then a link
    const placeRes = testDb.prepare("INSERT INTO places (trip_id, name) VALUES (?, 'P')").run(trip.id);
    const placeId = placeRes.lastInsertRowid as number;
    testDb.prepare('INSERT INTO file_links (file_id, place_id) VALUES (?, ?)').run(file.id, placeId);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_file_links', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.links).toHaveLength(1);
    });
  });

  it('returns empty array for file with no links', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const file = createFileRow(trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_file_links', arguments: { tripId: trip.id, fileId: file.id } });
      const data = parseToolResult(result) as any;
      expect(data.links).toHaveLength(0);
    });
  });
});
