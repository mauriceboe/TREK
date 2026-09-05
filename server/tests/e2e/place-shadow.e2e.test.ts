/**
 * /api/place-shadow e2e — the real JwtAuthGuard, the real AdminGuard and the
 * real Zod pipe against a temp SQLite db.
 *
 * The three things worth booting a server for: that a non-admin cannot read
 * other people's searches, that a switched-off log answers 200 instead of an
 * error the client would log forever, and that the pipe rejects a malformed
 * body before the service ever sees it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { seedUser, sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0);`);
  tmp.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);');
  tmp.exec(`CREATE TABLE place_shadow_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    query TEXT NOT NULL, lang TEXT, bias_lat REAL, bias_lng REAL, source TEXT NOT NULL,
    live_rank INTEGER NOT NULL, live_count INTEGER NOT NULL,
    picked_name TEXT NOT NULL, picked_lat REAL NOT NULL, picked_lng REAL NOT NULL,
    picked_place_id TEXT);`);
  return { db: tmp };
});

vi.mock('../../src/db/database', () => ({
  db, canAccessTrip: vi.fn(), isOwner: vi.fn(), getPlaceWithTags: vi.fn(), closeDb: () => {}, reinitialize: () => {},
}));

import { PlaceShadowModule } from '../../src/nest/place-shadow/place-shadow.module';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';

const PICK = {
  query: 'kaffee bar am dobi',
  lang: 'de',
  source: 'search:nominatim',
  liveRank: 1,
  liveCount: 5,
  pickedName: 'Baltic Brothers Coffee',
  pickedLat: 54.0885,
  pickedLng: 12.1395,
};

const USER = 1;
const ADMIN = 2;

function enable(on: boolean) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run('place_shadow_enabled', on ? 'true' : 'false');
}

describe('/api/place-shadow e2e (real guards + temp SQLite)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;

  async function build() {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, PlaceShadowModule],
      providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    seedUser(db as never, { id: USER });
    seedUser(db as never, { id: ADMIN, email: 'admin@example.com', role: 'admin' });
    app = await build();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM place_shadow_picks').run();
    enable(true);
  });

  describe('POST pick', () => {
    it('401 without a cookie', async () => {
      expect((await request(server).post('/api/place-shadow/pick').send(PICK)).status).toBe(401);
    });

    it('200 { recorded: true } and one row for a signed-in user', async () => {
      const res = await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send(PICK);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recorded: true });
      expect(db.prepare('SELECT COUNT(*) AS n FROM place_shadow_picks').get()).toEqual({ n: 1 });
    });

    it('200 { recorded: false } while the log is off, not an error status', async () => {
      enable(false);
      const res = await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send(PICK);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recorded: false });
      expect(db.prepare('SELECT COUNT(*) AS n FROM place_shadow_picks').get()).toEqual({ n: 0 });
    });

    it('400 from the pipe on a malformed body, and nothing is written', async () => {
      for (const bad of [
        { ...PICK, query: '' },
        { ...PICK, pickedLat: 200 },
        { ...PICK, liveRank: -1 },
        { ...PICK, source: undefined },
        { ...PICK, query: 'x'.repeat(201) },
      ]) {
        const res = await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send(bad);
        expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM place_shadow_picks').get()).toEqual({ n: 0 });
    });
  });

  describe('reading is admin only', () => {
    for (const [method, path] of [['get', '/api/place-shadow/summary'], ['get', '/api/place-shadow/export'], ['delete', '/api/place-shadow']] as const) {
      it(`403 for a non-admin on ${method.toUpperCase()} ${path}`, async () => {
        expect((await request(server)[method](path).set('Cookie', sessionCookie(USER))).status).toBe(403);
      });

      it(`401 without a cookie on ${method.toUpperCase()} ${path}`, async () => {
        expect((await request(server)[method](path)).status).toBe(401);
      });
    }

    it('an admin gets the summary', async () => {
      await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send(PICK);
      await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send({ ...PICK, liveRank: 0 });
      const res = await request(server).get('/api/place-shadow/summary').set('Cookie', sessionCookie(ADMIN));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: true,
        total: 2,
        bySource: [{ source: 'search:nominatim', count: 2 }],
        liveTopOneShare: 0.5,
        liveTopFiveShare: 1,
      });
    });

    it('an admin gets the corpus, and the wipe empties it', async () => {
      await request(server).post('/api/place-shadow/pick').set('Cookie', sessionCookie(USER)).send(PICK);
      const dump = await request(server).get('/api/place-shadow/export').set('Cookie', sessionCookie(ADMIN));
      expect(dump.status).toBe(200);
      expect(dump.body.version).toBe(1);
      expect(dump.body.rows).toHaveLength(1);
      expect(dump.body.rows[0]).toMatchObject({ query: PICK.query, pickedName: PICK.pickedName, liveRank: 1 });

      const wiped = await request(server).delete('/api/place-shadow').set('Cookie', sessionCookie(ADMIN));
      expect(wiped.status).toBe(200);
      expect(wiped.body).toEqual({ removed: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM place_shadow_picks').get()).toEqual({ n: 0 });
    });
  });
});
