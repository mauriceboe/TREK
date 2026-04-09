/**
 * Unit tests for MCP atlas expanded tools (atlas addon-gated):
 * get_atlas_stats, list_visited_regions, mark_region_visited, unmark_region_visited,
 * get_country_atlas_places, update_bucket_list_item.
 * Also covers resources trek://atlas/stats and trek://atlas/regions.
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

vi.mock('../../../src/services/adminService', () => ({
  isAddonEnabled: vi.fn().mockReturnValue(true),
}));

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
  const h = await createMcpHarness({ userId, withTools: false, withResources: true });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// get_atlas_stats
// ---------------------------------------------------------------------------

describe('Tool: get_atlas_stats', () => {
  it('returns stats object without error for empty data', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_atlas_stats', arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result) as any;
      expect(data.stats).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// list_visited_regions
// ---------------------------------------------------------------------------

describe('Tool: list_visited_regions', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_visited_regions', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.regions).toEqual([]);
    });
  });

  it('returns regions after they have been inserted', async () => {
    const { user } = createUser(testDb);
    testDb.prepare(
      'INSERT INTO visited_regions (user_id, region_code, region_name, country_code) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'FR-75', 'Paris', 'FR');
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_visited_regions', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.regions).toHaveLength(1);
      expect(data.regions[0].region_code).toBe('FR-75');
    });
  });
});

// ---------------------------------------------------------------------------
// mark_region_visited
// ---------------------------------------------------------------------------

describe('Tool: mark_region_visited', () => {
  it('inserts region and returns region object', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_region_visited',
        arguments: { regionCode: 'US-CA', regionName: 'California', countryCode: 'US' },
      });
      const data = parseToolResult(result) as any;
      expect(data.region).toBeDefined();
      expect(data.region.region_code).toBe('US-CA');
      expect(data.region.region_name).toBe('California');
      expect(data.region.country_code).toBe('US');
      const row = testDb.prepare('SELECT * FROM visited_regions WHERE user_id = ? AND region_code = ?').get(user.id, 'US-CA');
      expect(row).toBeTruthy();
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'mark_region_visited',
        arguments: { regionCode: 'DE-BY', regionName: 'Bavaria', countryCode: 'DE' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// unmark_region_visited
// ---------------------------------------------------------------------------

describe('Tool: unmark_region_visited', () => {
  it('removes region and returns success', async () => {
    const { user } = createUser(testDb);
    testDb.prepare(
      'INSERT INTO visited_regions (user_id, region_code, region_name, country_code) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'IT-LO', 'Lombardy', 'IT');
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'unmark_region_visited',
        arguments: { regionCode: 'IT-LO' },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      const row = testDb.prepare('SELECT * FROM visited_regions WHERE user_id = ? AND region_code = ?').get(user.id, 'IT-LO');
      expect(row).toBeUndefined();
    });
  });

  it('succeeds even when region was not marked (no-op)', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'unmark_region_visited',
        arguments: { regionCode: 'XX-YY' },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// get_country_atlas_places
// ---------------------------------------------------------------------------

describe('Tool: get_country_atlas_places', () => {
  it('returns empty places array for a new user', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_country_atlas_places',
        arguments: { countryCode: 'JP' },
      });
      const data = parseToolResult(result) as any;
      expect(data.places).toBeDefined();
      expect(Array.isArray(data.places)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_bucket_list_item
// ---------------------------------------------------------------------------

describe('Tool: update_bucket_list_item', () => {
  it('updates notes and returns item', async () => {
    const { user } = createUser(testDb);
    const r = testDb.prepare(
      'INSERT INTO bucket_list (user_id, name, lat, lng) VALUES (?, ?, NULL, NULL)'
    ).run(user.id, 'Visit Tokyo');
    const itemId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_bucket_list_item',
        arguments: { itemId, notes: 'Cherry blossom season preferred' },
      });
      const data = parseToolResult(result) as any;
      expect(data.item).toBeDefined();
      expect(data.item.notes).toBe('Cherry blossom season preferred');
    });
  });

  it('updates name of existing item', async () => {
    const { user } = createUser(testDb);
    const r = testDb.prepare(
      'INSERT INTO bucket_list (user_id, name, lat, lng) VALUES (?, ?, NULL, NULL)'
    ).run(user.id, 'Old Name');
    const itemId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_bucket_list_item',
        arguments: { itemId, name: 'New Name' },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.name).toBe('New Name');
    });
  });

  it('returns isError for non-existent item', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_bucket_list_item',
        arguments: { itemId: 99999, notes: 'Will not work' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const r = testDb.prepare(
      'INSERT INTO bucket_list (user_id, name, lat, lng) VALUES (?, ?, NULL, NULL)'
    ).run(user.id, 'Bucket Item');
    const itemId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_bucket_list_item',
        arguments: { itemId, notes: 'blocked' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Resource: trek://atlas/stats
// ---------------------------------------------------------------------------

describe('Resource: trek://atlas/stats', () => {
  it('returns stats object', async () => {
    const { user } = createUser(testDb);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://atlas/stats' });
      const data = parseResourceResult(result) as any;
      expect(data).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Resource: trek://atlas/regions
// ---------------------------------------------------------------------------

describe('Resource: trek://atlas/regions', () => {
  it('returns regions array', async () => {
    const { user } = createUser(testDb);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://atlas/regions' });
      const data = parseResourceResult(result) as any;
      expect(Array.isArray(data)).toBe(true);
    });
  });

  it('returns inserted regions', async () => {
    const { user } = createUser(testDb);
    testDb.prepare(
      'INSERT INTO visited_regions (user_id, region_code, region_name, country_code) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'ES-CT', 'Catalonia', 'ES');
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://atlas/regions' });
      const data = parseResourceResult(result) as any;
      expect(data).toHaveLength(1);
      expect(data[0].region_code).toBe('ES-CT');
    });
  });
});
