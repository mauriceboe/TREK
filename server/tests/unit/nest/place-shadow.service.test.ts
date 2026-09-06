/**
 * PlaceShadowService against a real in-memory database.
 *
 * The interesting parts of this service ARE the SQL — the id-paged export, the
 * rank bucketing, the age-based retention — so a mocked DatabaseService would
 * assert that the strings were passed along and prove nothing about what they
 * do. The table is created here rather than by running the migration array, so
 * appending the next migration cannot drag this file along.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PlaceShadowService, RETENTION_DAYS } from '../../../src/nest/place-shadow/place-shadow.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import type { PlaceShadowPickRequest } from '@trek/shared';

const SCHEMA = `
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE place_shadow_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    query TEXT NOT NULL,
    lang TEXT,
    bias_lat REAL,
    bias_lng REAL,
    source TEXT NOT NULL,
    live_rank INTEGER NOT NULL,
    live_count INTEGER NOT NULL,
    picked_name TEXT NOT NULL,
    picked_lat REAL NOT NULL,
    picked_lng REAL NOT NULL,
    picked_place_id TEXT
  );
`;

let conn: Database.Database;
let svc: PlaceShadowService;

/** Just the three methods the service uses, backed by the real connection. */
function dbFacade(c: Database.Database): DatabaseService {
  return {
    get: <T>(sql: string, ...p: unknown[]) => c.prepare(sql).get(...p) as T | undefined,
    all: <T>(sql: string, ...p: unknown[]) => c.prepare(sql).all(...p) as T[],
    run: (sql: string, ...p: unknown[]) => c.prepare(sql).run(...p),
  } as unknown as DatabaseService;
}

const PICK: PlaceShadowPickRequest = {
  query: 'losteria rostock',
  lang: 'de',
  biasLat: 54.0887,
  biasLng: 12.1404,
  source: 'search:nominatim',
  liveRank: 0,
  liveCount: 8,
  pickedName: "L'Osteria",
  pickedLat: 54.0891,
  pickedLng: 12.1372,
  pickedPlaceId: 'osm:node/1',
};

function enable(on = true) {
  conn.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run('place_shadow_enabled', on ? 'true' : 'false');
}

beforeEach(() => {
  conn = new Database(':memory:');
  conn.exec(SCHEMA);
  svc = new PlaceShadowService(dbFacade(conn));
});

describe('PlaceShadowService', () => {
  describe('the switch', () => {
    it('is off when the setting row is absent', () => {
      expect(svc.enabled()).toBe(false);
      expect(svc.record(PICK)).toBe(false);
      expect(conn.prepare('SELECT COUNT(*) AS n FROM place_shadow_picks').get()).toEqual({ n: 0 });
    });

    it('is off for any value that is not exactly "true"', () => {
      for (const value of ['false', '1', 'yes', 'TRUE', '']) {
        conn.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
          .run('place_shadow_enabled', value);
        expect(svc.enabled(), `value ${JSON.stringify(value)}`).toBe(false);
      }
    });

    it('writes once switched on', () => {
      enable();
      expect(svc.record(PICK)).toBe(true);
      expect(svc.summary().total).toBe(1);
    });
  });

  describe('record', () => {
    beforeEach(() => enable());

    it('rounds every coordinate to three decimals', () => {
      svc.record({ ...PICK, pickedLat: 54.0891234, pickedLng: 12.1372987, biasLat: 54.08871, biasLng: 12.14049 });
      const row = conn.prepare('SELECT * FROM place_shadow_picks').get() as Record<string, number>;
      expect(row.picked_lat).toBe(54.089);
      expect(row.picked_lng).toBe(12.137);
      expect(row.bias_lat).toBe(54.089);
      expect(row.bias_lng).toBe(12.14);
    });

    it('stores an absent bias and place id as NULL rather than inventing zeroes', () => {
      svc.record({ ...PICK, biasLat: undefined, biasLng: undefined, pickedPlaceId: undefined });
      const row = conn.prepare('SELECT * FROM place_shadow_picks').get() as Record<string, unknown>;
      expect(row.bias_lat).toBeNull();
      expect(row.bias_lng).toBeNull();
      expect(row.picked_place_id).toBeNull();
    });

    it('drops a row whose rank is outside the list it claims to come from', () => {
      expect(svc.record({ ...PICK, liveRank: 8, liveCount: 8 })).toBe(false);
      expect(svc.record({ ...PICK, liveRank: 99, liveCount: 3 })).toBe(false);
      expect(svc.summary().total).toBe(0);
      // The boundary case one below is a legitimate last-result pick.
      expect(svc.record({ ...PICK, liveRank: 7, liveCount: 8 })).toBe(true);
    });
  });

  describe('summary', () => {
    beforeEach(() => {
      enable();
      const ranks = [0, 0, 0, 1, 4, 5, 9, 10, 42];
      ranks.forEach((rank, i) =>
        svc.record({ ...PICK, liveRank: rank, liveCount: 50, source: i % 2 ? 'search:nominatim' : 'autocomplete:google' }),
      );
    });

    it('buckets the live rank instead of averaging it', () => {
      expect(svc.summary().liveRankBuckets).toEqual([
        { bucket: '1', count: 3 },
        { bucket: '2-5', count: 2 },
        { bucket: '6-10', count: 2 },
        { bucket: '11+', count: 2 },
      ]);
    });

    it('reports the top-one and top-five shares over the whole corpus', () => {
      const s = svc.summary();
      expect(s.total).toBe(9);
      expect(s.liveTopOneShare).toBeCloseTo(3 / 9, 6);
      expect(s.liveTopFiveShare).toBeCloseTo(5 / 9, 6);
    });

    it('counts by source, busiest first', () => {
      expect(svc.summary().bySource).toEqual([
        { source: 'autocomplete:google', count: 5 },
        { source: 'search:nominatim', count: 4 },
      ]);
    });

    it('answers on an empty corpus without dividing by zero', () => {
      conn.exec('DELETE FROM place_shadow_picks');
      const s = svc.summary();
      expect(s).toMatchObject({ total: 0, liveTopOneShare: 0, liveTopFiveShare: 0, oldest: null, newest: null });
      expect(s.retentionDays).toBe(RETENTION_DAYS);
    });

    it('reports the switch state it was asked about', () => {
      expect(svc.summary().enabled).toBe(true);
      enable(false);
      expect(svc.summary().enabled).toBe(false);
    });
  });

  describe('export', () => {
    beforeEach(() => {
      enable();
      for (let i = 0; i < 7; i++) svc.record({ ...PICK, query: `q${i}` });
    });

    it('pages by id and hands back the cursor for the next page', () => {
      const first = svc.export(undefined, 3);
      expect(first.rows.map(r => r.query)).toEqual(['q0', 'q1', 'q2']);
      expect(first.nextAfter).toBe(first.rows[2].id);

      const second = svc.export(first.nextAfter ?? undefined, 3);
      expect(second.rows.map(r => r.query)).toEqual(['q3', 'q4', 'q5']);

      const third = svc.export(second.nextAfter ?? undefined, 3);
      expect(third.rows.map(r => r.query)).toEqual(['q6']);
      // Nothing beyond, so no cursor — that is how a reader knows to stop.
      expect(third.nextAfter).toBeNull();
    });

    it('maps snake_case columns onto the camelCase contract', () => {
      const row = svc.export(undefined, 1).rows[0];
      expect(row).toMatchObject({
        query: 'q0',
        lang: 'de',
        source: 'search:nominatim',
        liveRank: 0,
        liveCount: 8,
        pickedName: "L'Osteria",
        pickedPlaceId: 'osm:node/1',
      });
      expect(typeof row.createdAt).toBe('string');
    });

    it('stamps the version so an evaluator can refuse a dump it does not know', () => {
      expect(svc.export().version).toBe(1);
    });
  });

  describe('retention and wipe', () => {
    beforeEach(() => enable());

    it('removes only rows past the window', () => {
      svc.record(PICK);
      svc.record(PICK);
      conn.prepare("UPDATE place_shadow_picks SET created_at = datetime('now', '-200 days') WHERE id = 1").run();
      expect(svc.purgeExpired()).toBe(1);
      expect(svc.summary().total).toBe(1);
    });

    it('keeps a row that is one day short of the window', () => {
      svc.record(PICK);
      conn.prepare("UPDATE place_shadow_picks SET created_at = datetime('now', ?)")
        .run(`-${RETENTION_DAYS - 1} days`);
      expect(svc.purgeExpired()).toBe(0);
    });

    it('runs even while the log is switched off, so old rows still age out', () => {
      svc.record(PICK);
      conn.prepare("UPDATE place_shadow_picks SET created_at = datetime('now', '-200 days')").run();
      enable(false);
      expect(svc.purgeExpired()).toBe(1);
    });

    it('clear() empties the table and reports how many went', () => {
      svc.record(PICK);
      svc.record(PICK);
      expect(svc.clear()).toBe(2);
      expect(svc.summary().total).toBe(0);
    });
  });
});
