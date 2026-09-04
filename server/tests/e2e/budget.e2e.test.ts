/**
 * Budget module e2e — exercises the migrated /api/trips/:tripId/budget endpoints
 * through the real JwtAuthGuard against a temp SQLite db carrying the full real
 * schema (createTables + runMigrations), so the folded BudgetService runs its
 * real SQL. Only the db singleton (trip access) and the WebSocket broadcast are
 * mocked; the permission check is a spy on the container's PermissionsService.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { RealtimeModule } from '../../src/nest/realtime/realtime.module';
import { Test } from '@nestjs/testing';
import { sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  tmp.exec('PRAGMA foreign_keys = ON');
  return { db: tmp };
});
const { canAccessTrip } = vi.hoisted(() => ({ canAccessTrip: vi.fn() }));

vi.mock('../../src/db/database', () => ({
  db,
  closeDb: () => {},
  reinitialize: () => {},
  canAccessTrip,
  getPlaceWithTags: () => null,
  isOwner: () => false,
}));
vi.mock('../../src/websocket', () => ({ broadcast: vi.fn() }));

import { PermissionsService } from '../../src/nest/permissions/permissions.service';

// Since the permissions DI migration, the check is a spy on the container's
// PermissionsService singleton (created in beforeAll, after build()).
let checkPermission: MockInstance;

import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { BudgetModule } from '../../src/nest/budget/budget.module';
import { ExchangeRatesService } from '../../src/nest/budget/exchange-rates.service';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';
import { ZodValidationPipe } from '../../src/nest/common/zod-validation.pipe';

describe('Budget e2e (real auth guard + temp SQLite, real budget SQL)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;
  let tripId: number;

  async function build() {
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule, RealtimeModule, BudgetModule] })
      // The settlement read awaits live FX rates; the trip here is all-EUR, so a
      // null result is the identity — and the test never touches the network.
      .overrideProvider(ExchangeRatesService)
      .useValue({ getRates: async () => null })
      .compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    nest.useGlobalPipes(new ZodValidationPipe());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    createTables(db);
    runMigrations(db);
    // The temp db carries the real schema (password_hash NOT NULL), so seed the
    // auth users directly instead of via the trimmed-DDL seedUser helper.
    db.prepare(
      "INSERT INTO users (id, username, email, password_hash, role, password_version) VALUES (1, 'e2e-user', 'e2e@example.test', 'x', 'user', 0)",
    ).run();
    db.prepare(
      "INSERT INTO users (id, username, email, password_hash, role, password_version) VALUES (2, 'e2e-peer', 'peer@example.test', 'x', 'user', 0)",
    ).run();
    tripId = Number(db.prepare("INSERT INTO trips (user_id, title, currency) VALUES (1, 'E2E Trip', 'EUR')").run().lastInsertRowid);
    // The peer settles up with the owner below, so they have to be on the trip:
    // a settlement between people who do not share one is refused.
    db.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, 2)').run(tripId);
    app = await build();
    checkPermission = vi.spyOn(app.get(PermissionsService), 'checkPermission');
    server = app.getHttpServer();
  });

  beforeEach(() => {
    canAccessTrip.mockReturnValue({ id: tripId, user_id: 1, currency: 'EUR' });
    checkPermission.mockReturnValue(true);
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 without a session cookie', async () => {
    const res = await request(server).get(`/api/trips/${tripId}/budget`);
    expect(res.status).toBe(401);
  });

  it('404 when the trip is not accessible', async () => {
    canAccessTrip.mockReturnValue(undefined);
    const res = await request(server).get(`/api/trips/${tripId}/budget`).set('Cookie', sessionCookie(1));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Trip not found' });
  });

  it('201 on create with permission, then 200 list returns the stored row', async () => {
    const created = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Hotel', total_price: 200 });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ name: 'Hotel', total_price: 200, category: 'other', members: [], payers: [] });

    const row = db.prepare('SELECT name, total_price FROM budget_items WHERE id = ?').get(created.body.item.id);
    expect(row).toEqual({ name: 'Hotel', total_price: 200 });

    const list = await request(server).get(`/api/trips/${tripId}/budget`).set('Cookie', sessionCookie(1));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: number }) => i.id)).toContain(created.body.item.id);
  });

  it('403 on create without permission', async () => {
    checkPermission.mockReturnValue(false);
    const res = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Hotel' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'No permission' });
  });

  it('400 on member update with a non-array user_ids (Zod pipe envelope)', async () => {
    const res = await request(server)
      .put(`/api/trips/${tripId}/budget/9/members`)
      .set('Cookie', sessionCookie(1))
      .send({ user_ids: 'no' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('user_ids');
  });

  it('400 on create without a name (Zod pipe envelope)', async () => {
    const res = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ total_price: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.toLowerCase()).toContain('name');
  });

  it('201 on a negative expense (partial reimbursement) and the settlement nets it out (#2176)', async () => {
    // The dinner: user 1 fronts 90, split with user 2 → user 2 owes 45.
    const dinner = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Dinner', payers: [{ user_id: 1, amount: 90 }], member_ids: [1, 2] });
    expect(dinner.status).toBe(201);

    // The refund: -30 lands with user 1, shared with user 2 → user 2's debt
    // drops by 15. The write path used to null this to a payer-less 0 € row.
    const refund = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Hotel partial refund', total_price: -30, payers: [{ user_id: 1, amount: -30 }], member_ids: [1, 2] });
    expect(refund.status).toBe(201);
    expect(refund.body.item).toMatchObject({ total_price: -30 });
    expect(refund.body.item.payers).toEqual([expect.objectContaining({ user_id: 1, amount: -30 })]);
    const row = db.prepare('SELECT total_price FROM budget_items WHERE id = ?').get(refund.body.item.id) as { total_price: number };
    expect(row.total_price).toBe(-30);

    const settlement = await request(server)
      .get(`/api/trips/${tripId}/budget/settlement`)
      .set('Cookie', sessionCookie(1));
    expect(settlement.status).toBe(200);
    const balances = settlement.body.balances as { user_id: number; balance: number }[];
    const balance = (uid: number) => balances.find(b => b.user_id === uid)!.balance;
    // 45 owed from the dinner minus the 15 refund share = 30, and Σ balances = 0.
    expect(balance(2)).toBe(-30);
    expect(balance(1)).toBe(30);
    expect(balances.reduce((a, b) => a + Math.round(b.balance * 100), 0)).toBe(0);

    // Clean up so the ledger tests below start from an empty trip.
    for (const id of [dinner.body.item.id, refund.body.item.id]) {
      const del = await request(server).delete(`/api/trips/${tripId}/budget/${id}`).set('Cookie', sessionCookie(1));
      expect(del.status).toBe(200);
    }
  });

  it('an expense with no payer creates no debt and no flow (#2225)', async () => {
    // The shape from the report: one bill user 1 fronted for both, plus a row
    // saved with "No one paid yet" that only user 2 is on. The taxi used to be
    // debited with no credit behind it and its whole 60 offered to user 1.
    const dinner = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Dinner', payers: [{ user_id: 1, amount: 100 }], member_ids: [1, 2] });
    expect(dinner.status).toBe(201);

    const unpaid = await request(server)
      .post(`/api/trips/${tripId}/budget`)
      .set('Cookie', sessionCookie(1))
      .send({ name: 'Taxi', total_price: 60, payers: [], member_ids: [2] });
    expect(unpaid.status).toBe(201);
    expect(unpaid.body.item).toMatchObject({ total_price: 60, payers: [] });

    const settlement = await request(server)
      .get(`/api/trips/${tripId}/budget/settlement`)
      .set('Cookie', sessionCookie(1));
    expect(settlement.status).toBe(200);
    const balances = settlement.body.balances as { user_id: number; balance: number }[];
    const balance = (uid: number) => balances.find(b => b.user_id === uid)!.balance;
    // Only the dinner settles: user 2 owes half of it and not a cent of the taxi.
    expect(balance(1)).toBe(50);
    expect(balance(2)).toBe(-50);
    expect(balances.reduce((a, b) => a + Math.round(b.balance * 100), 0)).toBe(0);
    expect(settlement.body.flows).toEqual([
      expect.objectContaining({ amount: 50, from: expect.objectContaining({ user_id: 2 }), to: expect.objectContaining({ user_id: 1 }) }),
    ]);

    // Clean up so the ledger tests below start from an empty trip.
    for (const id of [dinner.body.item.id, unpaid.body.item.id]) {
      const del = await request(server).delete(`/api/trips/${tripId}/budget/${id}`).set('Cookie', sessionCookie(1));
      expect(del.status).toBe(200);
    }
  });

  it('200 on settlement update with permission, persisting the new amount', async () => {
    const created = await request(server)
      .post(`/api/trips/${tripId}/budget/settlements`)
      .set('Cookie', sessionCookie(1))
      .send({ from_user_id: 2, to_user_id: 1, amount: 10 });
    expect(created.status).toBe(201);

    const res = await request(server)
      .put(`/api/trips/${tripId}/budget/settlements/${created.body.settlement.id}`)
      .set('Cookie', sessionCookie(1))
      .send({ from_user_id: 2, to_user_id: 1, amount: 15 });
    expect(res.status).toBe(200);
    expect(res.body.settlement).toMatchObject({ id: created.body.settlement.id, from_user_id: 2, to_user_id: 1, amount: 15 });

    const row = db.prepare('SELECT amount FROM budget_settlements WHERE id = ?').get(created.body.settlement.id);
    expect(row).toEqual({ amount: 15 });
  });

  it('404 on settlement update when it does not exist', async () => {
    const res = await request(server)
      .put(`/api/trips/${tripId}/budget/settlements/424242`)
      .set('Cookie', sessionCookie(1))
      .send({ from_user_id: 2, to_user_id: 1, amount: 15 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Settlement not found' });
  });
});
