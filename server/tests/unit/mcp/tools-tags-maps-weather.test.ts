/**
 * Unit tests for MCP tag, maps extras, and weather tools:
 * list_tags, create_tag, update_tag, delete_tag,
 * get_place_details, search_pois, reverse_geocode, resolve_maps_url,
 * get_weather, get_detailed_weather.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

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

vi.mock('../../../src/nest/weather/weather.impl', () => ({
  getWeather: vi.fn().mockResolvedValue({ temp: 20, condition: 'sunny' }),
  getDetailedWeather: vi.fn().mockResolvedValue({ hourly: [] }),
}));

// MapsService.pois() asks the TREK Places index before Overpass, and the real
// client would send that request from a unit test. The gate above it is left
// alone on purpose: it fails open, so these cases run on the shipping default
// with the index answering nothing, which is the drop-through they are about.
const { trekNearbyMock } = vi.hoisted(() => ({
  trekNearbyMock: vi.fn(async (
    _lat: number,
    _lng: number,
    _opts?: { radius?: number; limit?: number; category?: string },
  ): Promise<unknown[]> => []),
}));
vi.mock('../../../src/nest/maps/trek-places.client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/nest/maps/trek-places.client')>()),
  trekPlacesNearby: trekNearbyMock,
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';
import { MapsService } from '../../../src/nest/maps/maps.service';
import { getWeather, getDetailedWeather } from '../../../src/nest/weather/weather.impl';

// The geo tools live on the DI-discovered maps.mcp.ts since the maps fold; the
// test registry builds a real MapsService over the mocked db proxy, so stub the
// provider methods on the prototype (no auto-restore in the vitest config —
// these survive across tests, exactly like the old module mock did).
vi.spyOn(MapsService.prototype, 'getPlaceDetails').mockResolvedValue({
  name: 'Eiffel Tower',
  address: 'Paris',
} as never);
vi.spyOn(MapsService.prototype, 'getPlaceDetailsExpanded').mockResolvedValue({
  name: 'Eiffel Tower',
  summary: 'Wrought-iron lattice tower.',
  reviews: [{ author: 'Someone', rating: 5, text: 'Tall.', time: 'a month ago', photo: null }],
} as never);
// Overpass is stubbed one level below the facade so MapsService.pois() itself
// still runs, the way the geo tools reach it.
vi.spyOn(MapsService.prototype, 'searchOverpassPois').mockResolvedValue({
  pois: [{ osm_id: 'node:1', name: 'Chez Nous', lat: 48.86, lng: 2.34, category: 'restaurant' }],
  source: 'openstreetmap',
  truncated: false,
  clamped: false,
} as never);
// Off by default, so the existing cases exercise the lookup rather than the gate.
vi.spyOn(MapsService.prototype, 'detailsDisabled').mockReturnValue(false);
vi.spyOn(MapsService.prototype, 'reverseGeocode').mockResolvedValue({ name: 'Paris', address: 'France' });
vi.spyOn(MapsService.prototype, 'resolveGoogleMapsUrl').mockResolvedValue({
  lat: 48.8566,
  lng: 2.3522,
  name: 'Paris',
} as never);

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
// list_tags
// ---------------------------------------------------------------------------

describe('Tool: list_tags', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_tags', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.tags).toEqual([]);
    });
  });

  it('returns only tags belonging to the current user', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'My Tag', '#ff0000');
    testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(other.id, 'Other Tag', '#00ff00');
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_tags', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.tags).toHaveLength(1);
      expect(data.tags[0].name).toBe('My Tag');
    });
  });
});

// ---------------------------------------------------------------------------
// create_tag
// ---------------------------------------------------------------------------

describe('Tool: create_tag', () => {
  it('creates a tag and returns the tag object', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_tag',
        arguments: { name: 'Adventure', color: '#ff5500' },
      });
      const data = parseToolResult(result) as any;
      expect(data.tag).toBeDefined();
      expect(data.tag.name).toBe('Adventure');
      expect(data.tag.color).toBe('#ff5500');
      expect(data.tag.user_id).toBe(user.id);
    });
  });

  it('creates a tag with only a name', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_tag',
        arguments: { name: 'Food' },
      });
      const data = parseToolResult(result) as any;
      expect(data.tag.name).toBe('Food');
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_tag',
        arguments: { name: 'Blocked' },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_tag
// ---------------------------------------------------------------------------

describe('Tool: update_tag', () => {
  it('updates tag name and color', async () => {
    const { user } = createUser(testDb);
    const r = testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'Old Name', '#aaaaaa');
    const tagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_tag',
        arguments: { tagId, name: 'New Name', color: '#bbbbbb' },
      });
      const data = parseToolResult(result) as any;
      expect(data.tag).toBeDefined();
      expect(data.tag.name).toBe('New Name');
      expect(data.tag.color).toBe('#bbbbbb');
    });
  });

  it('returns isError for non-existent tagId', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_tag',
        arguments: { tagId: 99999, name: 'X' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const r = testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'Demo Tag', '#aaaaaa');
    const tagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_tag',
        arguments: { tagId, name: 'Blocked' },
      });
      expect(result.isError).toBe(true);
      expect(testDb.prepare('SELECT name FROM tags WHERE id = ?').get(tagId)).toEqual({ name: 'Demo Tag' });
    });
  });
});

// ---------------------------------------------------------------------------
// delete_tag
// ---------------------------------------------------------------------------

describe('Tool: delete_tag', () => {
  it('removes the tag row', async () => {
    const { user } = createUser(testDb);
    const r = testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'To Delete', '#cccccc');
    const tagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_tag',
        arguments: { tagId },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)).toBeUndefined();
    });
  });

  it('returns isError for non-existent tagId', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_tag',
        arguments: { tagId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const r = testDb.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'Demo Tag', '#aaaaaa');
    const tagId = r.lastInsertRowid as number;
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_tag',
        arguments: { tagId },
      });
      expect(result.isError).toBe(true);
      expect(testDb.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// tags scope gating (places:read / places:write, registration-time)
// ---------------------------------------------------------------------------

describe('Tags tools: scope gating', () => {
  const TAG_TOOLS = ['list_tags', 'create_tag', 'update_tag', 'delete_tag'];

  async function listToolNames(userId: number, scopes: string[] | null): Promise<string[]> {
    const h = await createMcpHarness({ userId, withResources: false, scopes });
    try {
      return (await h.client.listTools()).tools.map((t) => t.name);
    } finally {
      await h.cleanup();
    }
  }

  it('registers all four tag tools with null scopes (full access)', async () => {
    const { user } = createUser(testDb);
    const names = await listToolNames(user.id, null);
    for (const tool of TAG_TOOLS) expect(names).toContain(tool);
  });

  it('registers only list_tags with places:read', async () => {
    const { user } = createUser(testDb);
    const names = await listToolNames(user.id, ['places:read']);
    expect(names).toContain('list_tags');
    expect(names).not.toContain('create_tag');
    expect(names).not.toContain('update_tag');
    expect(names).not.toContain('delete_tag');
  });

  it('registers all four tag tools with places:write (write implies read)', async () => {
    const { user } = createUser(testDb);
    const names = await listToolNames(user.id, ['places:write']);
    for (const tool of TAG_TOOLS) expect(names).toContain(tool);
  });

  it('registers no tag tools for an unrelated scope', async () => {
    const { user } = createUser(testDb);
    const names = await listToolNames(user.id, ['budget:read']);
    for (const tool of TAG_TOOLS) expect(names).not.toContain(tool);
  });
});

// ---------------------------------------------------------------------------
// get_place_details
// ---------------------------------------------------------------------------

describe('Tool: get_place_details', () => {
  it('returns details from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ' },
      });
      const data = parseToolResult(result) as any;
      expect(data.details).toBeDefined();
      expect(data.details.name).toBe('Eiffel Tower');
    });
  });

  // The former "isError when service returns null" case pinned a dead branch —
  // MapsService.getPlaceDetails throws or returns an object, never null — and
  // died with the guard in the fix(maps) quirk pass.

  // The expanded field mask bills as a Google Enterprise SKU, so the default has
  // to stay on the lean lookup: nothing an existing caller does may start costing
  // more (#31).
  it('takes the lean path when expand is not asked for', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.getPlaceDetails).mockClear();
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'get_place_details', arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ' } });
      expect(MapsService.prototype.getPlaceDetails).toHaveBeenCalledWith(user.id, 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', 'en');
      expect(MapsService.prototype.getPlaceDetailsExpanded).not.toHaveBeenCalled();
    });
  });

  it('explicitly passing expand: false also stays on the lean path', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', expand: false, refresh: true },
      });
      expect(MapsService.prototype.getPlaceDetailsExpanded).not.toHaveBeenCalled();
    });
  });

  it('expand routes to the expanded lookup and returns reviews and the summary', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.getPlaceDetails).mockClear();
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', expand: true, lang: 'de' },
      });
      const data = parseToolResult(result) as any;
      expect(data.details.summary).toBe('Wrought-iron lattice tower.');
      expect(data.details.reviews).toHaveLength(1);
      expect(MapsService.prototype.getPlaceDetailsExpanded).toHaveBeenCalledWith(user.id, 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', 'de', false);
      expect(MapsService.prototype.getPlaceDetails).not.toHaveBeenCalled();
    });
  });

  it('forwards refresh so a stale expanded payload can be re-fetched', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', expand: true, refresh: true },
      });
      expect(MapsService.prototype.getPlaceDetailsExpanded).toHaveBeenCalledWith(user.id, 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', 'en', true);
    });
  });

  it('refuses a non-boolean expand', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', expand: 'yes' },
      });
      expect(result.isError).toBe(true);
      expect(MapsService.prototype.getPlaceDetailsExpanded).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// search_pois (#30)
// ---------------------------------------------------------------------------

describe('Tool: search_pois', () => {
  const BBOX = { south: 48.85, west: 2.33, north: 48.87, east: 2.36 };

  // The index is asked first and answers nothing here, so this case also pins
  // the drop-through: an empty index page must reach Overpass rather than come
  // back as an empty POI list.
  it('returns the POIs of a category inside the bbox', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockClear();
    trekNearbyMock.mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'search_pois',
        arguments: { category: 'restaurant', bbox: BBOX, lang: 'fr' },
      });
      const data = parseToolResult(result) as any;
      expect(data.pois).toHaveLength(1);
      expect(data.pois[0].name).toBe('Chez Nous');
      expect(data.source).toBe('openstreetmap');
      expect(trekNearbyMock).toHaveBeenCalled();
      expect(MapsService.prototype.searchOverpassPois).toHaveBeenCalledWith('restaurant', BBOX, 'fr');
    });
  });

  // Overpass is the fallback now, not the first stop. `source` stays
  // 'openstreetmap' because the client switches on it and these are the same
  // places; where they were read is this method's business, not the pill's.
  it('answers from the TREK Places index and leaves Overpass alone', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockClear();
    trekNearbyMock.mockClear();
    trekNearbyMock.mockResolvedValueOnce([
      {
        gers: 'abc-123',
        name: 'Le Comptoir',
        lat: 48.861,
        lng: 2.341,
        category: 'restaurant',
        address: { freeform: '9 Rue de Rivoli' },
        contact: { website: 'https://example.test/', phone: null },
        hours: { osm: 'Mo-Fr 09:00-17:00', source: null, sourceUrl: null },
      },
    ]);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'search_pois',
        arguments: { category: 'restaurant', bbox: BBOX },
      });
      const data = parseToolResult(result) as any;
      expect(data.pois).toHaveLength(1);
      expect(data.pois[0].osm_id).toBe('gers:abc-123');
      expect(data.pois[0].name).toBe('Le Comptoir');
      // The index carries opening hours; dropping them would leave the tool
      // description promising something the answer never has.
      expect(data.pois[0].opening_hours).toBe('Mo-Fr 09:00-17:00');
      expect(data.source).toBe('openstreetmap');
      expect(data.clamped).toBe(false);
      expect(MapsService.prototype.searchOverpassPois).not.toHaveBeenCalled();

      // The bbox becomes a centre plus half its diagonal, and the category
      // becomes the Overture terms it maps to.
      const [lat, lng, opts] = trekNearbyMock.mock.calls[0];
      expect(lat).toBeCloseTo(48.86, 5);
      expect(lng).toBeCloseTo(2.345, 5);
      expect(opts?.category).toBe('restaurant,casual_eatery,fast_food');
      expect(opts?.limit).toBe(50);
      expect(opts?.radius).toBeGreaterThan(300);
      expect(opts?.radius).toBeLessThanOrEqual(20000);
    });
  });

  // The index searches a disc, so a viewport wider than 40km is narrowed there
  // as well — and says so, the same way the Overpass path does.
  it('reports a viewport the index had to narrow as clamped', async () => {
    const { user } = createUser(testDb);
    trekNearbyMock.mockClear();
    trekNearbyMock.mockResolvedValueOnce([
      { gers: 'wide-1', name: 'Far Away', lat: 48.9, lng: 2.4, category: null, address: null, contact: null, hours: null },
    ]);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'search_pois',
        arguments: { category: 'restaurant', bbox: { south: 48.4, west: 2.0, north: 48.9, east: 2.5 } },
      });
      const data = parseToolResult(result) as any;
      expect(data.clamped).toBe(true);
      expect(data.pois[0].poi_type).toBe('restaurant');
      expect(data.pois[0].address).toBeNull();
      expect(trekNearbyMock.mock.calls[0][2]?.radius).toBe(20000);
    });
  });

  it('passes no language through when none is given', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockClear();
    trekNearbyMock.mockClear();

    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'search_pois', arguments: { category: 'museum', bbox: BBOX } });
      expect(MapsService.prototype.searchOverpassPois).toHaveBeenCalledWith('museum', BBOX, undefined);
    });
  });

  // The enum is built from CATEGORY_OSM_FILTERS, so a category with no OSM tag
  // mapping never reaches Overpass in the first place.
  it('refuses a category that has no OSM mapping', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'search_pois',
        arguments: { category: 'dentist', bbox: BBOX },
      });
      expect(result.isError).toBe(true);
      expect(MapsService.prototype.searchOverpassPois).not.toHaveBeenCalled();
    });
  });

  it('refuses a bbox edge outside the coordinate range', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'search_pois',
        arguments: { category: 'cafe', bbox: { ...BBOX, north: 118 } },
      });
      expect(result.isError).toBe(true);
      expect(MapsService.prototype.searchOverpassPois).not.toHaveBeenCalled();
    });
  });

  it('answers isError when every Overpass mirror is unreachable', async () => {
    const { user } = createUser(testDb);
    vi.mocked(MapsService.prototype.searchOverpassPois).mockRejectedValueOnce(new Error('all mirrors failed'));

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_pois', arguments: { category: 'bar', bbox: BBOX } });
      expect(result.isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('POI search failed.');
    });
  });

  // Dropping through must not turn an outage into an empty answer: the index
  // failure is logged and Overpass failing under it is still what reaches the
  // caller.
  it('answers isError when the index fails and every Overpass mirror is unreachable', async () => {
    const { user } = createUser(testDb);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    trekNearbyMock.mockRejectedValueOnce(new Error('index down'));
    vi.mocked(MapsService.prototype.searchOverpassPois).mockRejectedValueOnce(new Error('all mirrors failed'));

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_pois', arguments: { category: 'bar', bbox: BBOX } });
      expect(result.isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('POI search failed.');
    });
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// reverse_geocode
// ---------------------------------------------------------------------------

describe('Tool: reverse_geocode', () => {
  it('returns result from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'reverse_geocode',
        arguments: { lat: 48.8566, lng: 2.3522 },
      });
      const data = parseToolResult(result) as any;
      expect(data.name).toBe('Paris');
      expect(data.address).toBe('France');
    });
  });
});

// ---------------------------------------------------------------------------
// resolve_maps_url
// ---------------------------------------------------------------------------

describe('Tool: resolve_maps_url', () => {
  it('returns result from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'resolve_maps_url',
        arguments: { url: 'https://maps.app.goo.gl/example' },
      });
      const data = parseToolResult(result) as any;
      expect(data.lat).toBe(48.8566);
      expect(data.lng).toBe(2.3522);
      expect(data.name).toBe('Paris');
    });
  });
});

// ---------------------------------------------------------------------------
// get_weather
// ---------------------------------------------------------------------------

describe('Tool: get_weather', () => {
  it('returns weather from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_weather',
        arguments: { lat: 48.8566, lng: 2.3522, date: '2025-07-01' },
      });
      const data = parseToolResult(result) as any;
      expect(data.weather).toBeDefined();
      expect(data.weather.temp).toBe(20);
      expect(data.weather.condition).toBe('sunny');
    });
  });
});

// ---------------------------------------------------------------------------
// get_detailed_weather
// ---------------------------------------------------------------------------

describe('Tool: get_detailed_weather', () => {
  it('returns detailed weather from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_detailed_weather',
        arguments: { lat: 48.8566, lng: 2.3522, date: '2025-07-01' },
      });
      const data = parseToolResult(result) as any;
      expect(data.weather).toBeDefined();
      expect(Array.isArray(data.weather.hourly)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Weather failure path
//
// Both weather tools swallow a provider failure and answer with isError plus
// the upstream message, rather than letting it surface as a transport-level
// error. That branch never had a case: the tools lived in src/mcp/, which the
// coverage gate does not measure, and the move into src/nest/ exposed it.
// ---------------------------------------------------------------------------

describe('Weather tools: provider failure', () => {
  it('get_weather answers isError with the upstream message', async () => {
    const { user } = createUser(testDb);
    vi.mocked(getWeather).mockRejectedValueOnce(new Error('Open-Meteo unreachable'));
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_weather',
        arguments: { lat: 48.8566, lng: 2.3522, date: '2025-07-01' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('Open-Meteo unreachable');
    });
  });

  it('get_weather falls back to a generic message when the rejection is not an Error', async () => {
    const { user } = createUser(testDb);
    // A non-Error rejection has no .message, which is the only way the ?? fallback
    // fires — `new Error('')` still carries an (empty) message and passes through.
    vi.mocked(getWeather).mockRejectedValueOnce('boom' as unknown as Error);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_weather',
        arguments: { lat: 48.8566, lng: 2.3522, date: '2025-07-01' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('Weather service not available.');
    });
  });

  it('get_detailed_weather answers isError with the upstream message', async () => {
    const { user } = createUser(testDb);
    vi.mocked(getDetailedWeather).mockRejectedValueOnce(new Error('rate limited'));
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_detailed_weather',
        arguments: { lat: 48.8566, lng: 2.3522, date: '2025-07-01' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('rate limited');
    });
  });
});

// ---------------------------------------------------------------------------
// Airports
//
// The airport lookups had no coverage at all before they moved out of the
// legacy registrar — the same blind spot as the weather catch above.
// ---------------------------------------------------------------------------

describe('Tool: search_airports', () => {
  it('returns matches for a city name, capped by limit', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_airports', arguments: { query: 'zurich', limit: 5 } });
      const data = parseToolResult(result) as { airports: { iata: string }[] };
      expect(Array.isArray(data.airports)).toBe(true);
      expect(data.airports.length).toBeGreaterThan(0);
      expect(data.airports.length).toBeLessThanOrEqual(5);
      expect(data.airports.some(a => a.iata === 'ZRH')).toBe(true);
    });
  });

  it('applies the default limit of 10 when none is given', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_airports', arguments: { query: 'a' } });
      const data = parseToolResult(result) as { airports: unknown[] };
      expect(data.airports.length).toBeLessThanOrEqual(10);
    });
  });

  it('returns an empty list for a query that matches nothing', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_airports', arguments: { query: 'zzzzzznotanairport' } });
      const data = parseToolResult(result) as { airports: unknown[] };
      expect(data.airports).toEqual([]);
    });
  });
});

describe('Tool: get_airport', () => {
  it('returns the airport for a known IATA code, lowercase input included', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_airport', arguments: { iata: 'zrh' } });
      const data = parseToolResult(result) as { airport: { iata: string; tz: string } };
      expect(data.airport.iata).toBe('ZRH');
      expect(typeof data.airport.tz).toBe('string');
    });
  });

  it('answers isError for an unknown code rather than a null airport', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_airport', arguments: { iata: 'QQQ' } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result as { content: { text: string }[] }).content[0].text).toBe('Airport not found.');
    });
  });
});

// ---------------------------------------------------------------------------
// The admin kill switch
//
// An instance owner turns Place Details off to stop Google billing them. REST
// checks detailsDisabled() before it can reach either lookup; a tool that did
// not would bill them from the one surface the switch does not cover, and the
// expanded mask would do it at Enterprise-SKU rates.
// ---------------------------------------------------------------------------

describe('Tool: get_place_details (admin kill switch)', () => {
  afterEach(() => {
    vi.mocked(MapsService.prototype.detailsDisabled).mockReturnValue(false);
  });

  it('fetches nothing when an admin has turned Place Details off', async () => {
    const { user } = createUser(testDb);
    vi.spyOn(MapsService.prototype, 'detailsDisabled').mockReturnValue(true);
    vi.mocked(MapsService.prototype.getPlaceDetails).mockClear();
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ' },
      });
      const data = parseToolResult(result) as any;
      expect(data.disabled).toBe(true);
      expect(data.details).toBeNull();
      expect(MapsService.prototype.getPlaceDetails).not.toHaveBeenCalled();
      expect(MapsService.prototype.getPlaceDetailsExpanded).not.toHaveBeenCalled();
    });
  });

  it('the switch also stops the expensive expanded path', async () => {
    const { user } = createUser(testDb);
    vi.spyOn(MapsService.prototype, 'detailsDisabled').mockReturnValue(true);
    vi.mocked(MapsService.prototype.getPlaceDetailsExpanded).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ', expand: true },
      });
      expect((parseToolResult(result) as any).disabled).toBe(true);
      expect(MapsService.prototype.getPlaceDetailsExpanded).not.toHaveBeenCalled();
    });
  });

  it('leaves the lookup alone while the switch is on', async () => {
    const { user } = createUser(testDb);
    vi.spyOn(MapsService.prototype, 'detailsDisabled').mockReturnValue(false);
    vi.mocked(MapsService.prototype.getPlaceDetails).mockClear();

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'get_place_details',
        arguments: { placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ' },
      });
      expect((parseToolResult(result) as any).details.name).toBe('Eiffel Tower');
      expect(MapsService.prototype.getPlaceDetails).toHaveBeenCalled();
    });
  });
});
