/**
 * Transit proxy e2e — /api/transit/geocode + /api/transit/plan through the real
 * JwtAuthGuard against a temp SQLite db. The DI-native TransitService's provider
 * methods are stubbed via instance spies (no outbound HTTP); this focuses on
 * auth (401), param pass-through and error propagation (#1065).
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
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0);`);
  // StorageRegistryService (behind StorageModule, now in this module chain) reads
  // this at onModuleInit.
  tmp.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);');
  return { db: tmp };
});
vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

import { TransitModule } from '../../src/nest/transit/transit.module';
import { TransitService } from '../../src/nest/transit/transit.service';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { RealtimeModule } from '../../src/nest/realtime/realtime.module';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';

describe('Transit proxy e2e (real auth guard + temp SQLite)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;
  let geocodeSpy: ReturnType<typeof vi.spyOn>;
  let planSpy: ReturnType<typeof vi.spyOn>;

  async function build() {
    const moduleRef = await Test.createTestingModule({
      // DatabaseModule + RealtimeModule are @Global in the app graph;
      // TransitModule's DaysModule/ReservationsModule imports need them here.
      imports: [DatabaseModule, RealtimeModule, TransitModule],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    seedUser(db as never, { id: 1 });
    app = await build();
    server = app.getHttpServer();
    const transit = app.get(TransitService);
    geocodeSpy = vi.spyOn(transit, 'geocode') as ReturnType<typeof vi.spyOn>;
    planSpy = vi.spyOn(transit, 'plan') as ReturnType<typeof vi.spyOn>;
  });

  beforeEach(() => {
    geocodeSpy.mockReset();
    planSpy.mockReset();
  });

  afterAll(async () => { await app.close(); });

  it('401 without a session cookie', async () => {
    expect((await request(server).get('/api/transit/geocode?q=alexanderplatz')).status).toBe(401);
    expect((await request(server).get('/api/transit/plan?from=1,2&to=3,4')).status).toBe(401);
  });

  it('geocode passes q/lang/near through and returns the service result', async () => {
    geocodeSpy.mockResolvedValueOnce({ results: [{ name: 'Alexanderplatz' }] });
    const res = await request(server).get('/api/transit/geocode?q=alex&lang=de&near=52.5,13.4').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.results[0].name).toBe('Alexanderplatz');
    // The caller's id trails the query so the Google backend (#1699) can resolve
    // the install's Places key; the Transitous path ignores it.
    expect(geocodeSpy).toHaveBeenCalledWith('alex', 'de', '52.5,13.4', 1);
  });

  it('plan passes all params through (arriveBy + maxTransfers coerced)', async () => {
    planSpy.mockResolvedValueOnce({ itineraries: [] });
    const res = await request(server)
      .get('/api/transit/plan?from=52.5,13.4&to=52.6,13.5&time=2026-07-13T09:00:00Z&arriveBy=true&modes=BUS&maxTransfers=2&lang=de')
      .set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(planSpy).toHaveBeenCalledWith({
      from: '52.5,13.4', to: '52.6,13.5', time: '2026-07-13T09:00:00Z', arriveBy: true, modes: 'BUS', maxTransfers: 2,
    }, 'de', 1);
  });

  it('service validation errors propagate with their status', async () => {
    const err = new Error('from must be "lat,lng"') as Error & { status: number };
    err.status = 400;
    planSpy.mockRejectedValueOnce(err);
    const res = await request(server).get('/api/transit/plan?from=bad&to=1,2').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('lat,lng');
  });

  it('upstream failures surface as 502', async () => {
    const err = new Error('Transit provider error (HTTP 500)') as Error & { status: number };
    err.status = 502;
    planSpy.mockRejectedValueOnce(err);
    const res = await request(server).get('/api/transit/plan?from=1,2&to=3,4').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(502);
  });
});
