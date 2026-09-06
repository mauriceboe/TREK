/**
 * Transit backend switch e2e (#1699) — the whole path a self-hoster actually
 * walks, through the real Nest stack: an admin flips Admin → Settings → Transit
 * Provider, and the next /api/transit/plan leaves for a different upstream.
 *
 * Unlike transit.e2e.test.ts, TransitService is NOT stubbed here — only the
 * outbound `fetch` is, so what is asserted is the URL the install would really
 * have called and the setting/key state that decided it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { seedUser, sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  tmp.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0,
    maps_api_key TEXT, unsplash_api_key TEXT);`);
  tmp.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);');
  return { db: tmp };
});
vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

import { TransitModule } from '../../src/nest/transit/transit.module';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { RealtimeModule } from '../../src/nest/realtime/realtime.module';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';
import { clearGoogleTransitCache } from '../../src/nest/transit/google-transit.provider';

const ADMIN = 1;

// TransitService's Transitous cache is module-scoped with no reset hook, so
// each case plans between its own pair of Osaka coordinates rather than being
// answered by the previous one.
let planNo = 0;
const nextPlanUrl = () => `/api/transit/plan?from=34.69${planNo},135.4900&to=34.68${planNo++},135.5155`;

describe('Transit backend switch e2e (#1699)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;
  const fetchMock = vi.fn();

  async function build() {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, RealtimeModule, TransitModule],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    seedUser(db as never, { id: ADMIN, role: 'admin' });
    app = await build();
    server = app.getHttpServer();
  });
  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // MOTIS and Routes shapes both parse as "no itineraries", which is all this
    // suite needs — it asserts where the request went, not how it mapped.
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
    });
    db.prepare('DELETE FROM app_settings').run();
    db.prepare('UPDATE users SET maps_api_key = NULL WHERE id = ?').run(ADMIN);
    clearGoogleTransitCache();
  });

  let lastBody: Record<string, unknown> = {};

  async function planUpstream(): Promise<string> {
    const res = await request(server).get(nextPlanUrl()).set('Cookie', sessionCookie(ADMIN));
    expect(res.status).toBe(200);
    lastBody = res.body;
    return String(fetchMock.mock.calls[0][0]);
  }

  it('TRANSIT-PROV-E2E-001: an untouched install plans through Transitous', async () => {
    expect(await planUpstream()).toContain('transitous.org');
    expect(lastBody.provider).toBe('transitous');
  });

  it('TRANSIT-PROV-E2E-002: selecting Google without a key still plans through Transitous', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'google')").run();
    expect(await planUpstream()).toContain('transitous.org');
    // The response says who really answered, so the empty state cannot blame
    // Google for a Transitous result.
    expect(lastBody.provider).toBe('transitous');
  });

  it('TRANSIT-PROV-E2E-003: with the switch on and a key set, the plan leaves for the Routes API', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'google')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('maps_api_key', 'instance-key')").run();
    expect(await planUpstream()).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(lastBody.provider).toBe('google');
  });

  it('TRANSIT-PROV-E2E-004: the picker follows the switch to Google Places', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'google')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('maps_api_key', 'instance-key')").run();

    const res = await request(server)
      .get('/api/transit/geocode?q=Nakanoshima&lang=ja')
      .set('Cookie', sessionCookie(ADMIN));
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://places.googleapis.com/v1/places:searchText');
  });

  it("TRANSIT-PROV-E2E-005: a member's own key is used when the instance has none", async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'google')").run();
    db.prepare('UPDATE users SET maps_api_key = ? WHERE id = ?').run('personal-key', ADMIN);

    expect(await planUpstream()).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-Api-Key']).toBe('personal-key');
  });
});
