/**
 * Unit tests for MCP trip member, copy, ICS, and share-link tools:
 * list_trip_members, add_trip_member, remove_trip_member,
 * copy_trip, export_trip_ics, get_share_link, create_share_link, delete_share_link.
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
import { createUser, createTrip, addTripMember } from '../../helpers/factories';
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
// list_trip_members
// ---------------------------------------------------------------------------

describe('Tool: list_trip_members', () => {
  it('returns owner and empty members list for own trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.owner.id).toBe(user.id);
      expect(data.owner.role).toBe('owner');
      expect(Array.isArray(data.members)).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// add_trip_member
// ---------------------------------------------------------------------------

describe('Tool: add_trip_member', () => {
  it('adds a member by username', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    await withHarness(owner.id, async (h) => {
      const result = await h.client.callTool({
        name: 'add_trip_member',
        arguments: { tripId: trip.id, identifier: member.username },
      });
      const data = parseToolResult(result) as any;
      expect(data.member.username).toBe(member.username);
      expect(data.member.role).toBe('member');
    });
  });

  it('broadcasts member:added event', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    await withHarness(owner.id, async (h) => {
      await h.client.callTool({
        name: 'add_trip_member',
        arguments: { tripId: trip.id, identifier: member.email },
      });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'member:added', expect.any(Object));
    });
  });

  it('returns error when user not found', async () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    await withHarness(owner.id, async (h) => {
      const result = await h.client.callTool({
        name: 'add_trip_member',
        arguments: { tripId: trip.id, identifier: 'nonexistent@example.com' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns error when non-owner tries to add', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const { user: outsider } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(member.id, async (h) => {
      const result = await h.client.callTool({
        name: 'add_trip_member',
        arguments: { tripId: trip.id, identifier: outsider.username },
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
        name: 'add_trip_member',
        arguments: { tripId: trip.id, identifier: 'someone@example.com' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// remove_trip_member
// ---------------------------------------------------------------------------

describe('Tool: remove_trip_member', () => {
  it('removes a member', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(owner.id, async (h) => {
      const result = await h.client.callTool({
        name: 'remove_trip_member',
        arguments: { tripId: trip.id, memberId: member.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const row = testDb.prepare('SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?').get(trip.id, member.id);
      expect(row).toBeUndefined();
    });
  });

  it('broadcasts member:removed event', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'remove_trip_member', arguments: { tripId: trip.id, memberId: member.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'member:removed', expect.any(Object));
    });
  });

  it('returns error when non-owner tries to remove', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await withHarness(member.id, async (h) => {
      const result = await h.client.callTool({
        name: 'remove_trip_member',
        arguments: { tripId: trip.id, memberId: owner.id },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// copy_trip
// ---------------------------------------------------------------------------

describe('Tool: copy_trip', () => {
  it('duplicates a trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Original', start_date: '2025-01-01', end_date: '2025-01-03' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'copy_trip', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.trip).toBeTruthy();
      // New trip should be a different row
      const count = testDb.prepare('SELECT COUNT(*) as cnt FROM trips').get() as any;
      expect(count.cnt).toBe(2);
    });
  });

  it('uses custom title when provided', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Original' });
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'copy_trip', arguments: { tripId: trip.id, title: 'My Copy' } });
      const newTrip = testDb.prepare("SELECT * FROM trips WHERE title = 'My Copy'").get() as any;
      expect(newTrip).toBeTruthy();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'copy_trip', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'copy_trip', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// export_trip_ics
// ---------------------------------------------------------------------------

describe('Tool: export_trip_ics', () => {
  it('returns ICS content for a trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Paris Trip', start_date: '2025-06-01', end_date: '2025-06-05' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'export_trip_ics', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.ics).toContain('BEGIN:VCALENDAR');
      expect(data.ics).toContain('Paris Trip');
      expect(data.filename).toMatch(/\.ics$/);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'export_trip_ics', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// get_share_link / create_share_link / delete_share_link
// ---------------------------------------------------------------------------

describe('Tool: get_share_link', () => {
  it('returns null when no share link exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_share_link', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.link).toBeNull();
    });
  });

  it('returns share link info when it exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Create a share link directly
    testDb.prepare(
      'INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab) VALUES (?, ?, ?, 1, 1, 0, 0, 0)'
    ).run(trip.id, 'test-token-123', user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_share_link', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.link.token).toBe('test-token-123');
      expect(data.link.share_map).toBe(true);
    });
  });
});

describe('Tool: create_share_link', () => {
  it('creates a new share link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_share_link',
        arguments: { tripId: trip.id, share_map: true, share_bookings: false, share_packing: false },
      });
      const data = parseToolResult(result) as any;
      expect(data.token).toBeTruthy();
      expect(data.created).toBe(true);
    });
  });

  it('updates existing share link permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare(
      'INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab) VALUES (?, ?, ?, 1, 1, 0, 0, 0)'
    ).run(trip.id, 'existing-token', user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_share_link',
        arguments: { tripId: trip.id, share_packing: true },
      });
      const data = parseToolResult(result) as any;
      expect(data.created).toBe(false); // updated, not created
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_share_link', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Tool: delete_share_link', () => {
  it('revokes the share link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare(
      'INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab) VALUES (?, ?, ?, 1, 1, 0, 0, 0)'
    ).run(trip.id, 'to-delete', user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_share_link', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const row = testDb.prepare('SELECT token FROM share_tokens WHERE trip_id = ?').get(trip.id);
      expect(row).toBeUndefined();
    });
  });
});
