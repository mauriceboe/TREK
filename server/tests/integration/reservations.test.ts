/**
 * Reservations integration tests.
 * Covers RESV-001 to RESV-007.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

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
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip, createDay, createPlace, createReservation, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Create reservation
// ─────────────────────────────────────────────────────────────────────────────

describe('Create reservation', () => {
  it('RESV-001 — POST /api/trips/:tripId/reservations creates a reservation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Hotel Check-in', type: 'hotel' });
    expect(res.status).toBe(201);
    expect(res.body.reservation.title).toBe('Hotel Check-in');
    expect(res.body.reservation.type).toBe('hotel');
  });

  it('RESV-001 — POST without title returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({ type: 'hotel' });
    expect(res.status).toBe(400);
  });

  it('RESV-001 — non-member cannot create reservation', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(other.id))
      .send({ title: 'Hotel', type: 'hotel' });
    expect(res.status).toBe(404);
  });

  it('RESV-002 — POST with create_accommodation creates an accommodation record', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2025-06-01' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Grand Hotel', type: 'hotel', day_id: day.id, create_accommodation: true });
    expect(res.status).toBe(201);
    expect(res.body.reservation).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List reservations
// ─────────────────────────────────────────────────────────────────────────────

describe('List reservations', () => {
  it('RESV-003 — GET /api/trips/:tripId/reservations returns all reservations', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createReservation(testDb, trip.id, { title: 'Flight Out', type: 'flight' });
    createReservation(testDb, trip.id, { title: 'Hotel Stay', type: 'hotel' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.reservations).toHaveLength(2);
  });

  it('RESV-003 — returns empty array when no reservations exist', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.reservations).toHaveLength(0);
  });

  it('RESV-007 — non-member cannot list reservations', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(other.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update reservation
// ─────────────────────────────────────────────────────────────────────────────

describe('Update reservation', () => {
  it('RESV-004 — PUT updates reservation fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const resv = createReservation(testDb, trip.id, { title: 'Old Flight', type: 'flight' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'New Flight', confirmation_number: 'ABC123' });
    expect(res.status).toBe(200);
    expect(res.body.reservation.title).toBe('New Flight');
    expect(res.body.reservation.confirmation_number).toBe('ABC123');
  });

  it('RESV-004 — PUT on non-existent reservation returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/reservations/99999`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('RESV-010 — PUT syncs check-in/out times to linked accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day1 = createDay(testDb, trip.id, { date: '2025-08-01' });
    const day2 = createDay(testDb, trip.id, { date: '2025-08-03' });
    const place = createPlace(testDb, trip.id, { name: 'Sync Hotel' });

    // Create reservation with linked accommodation
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Hotel Booking',
        type: 'hotel',
        day_id: day1.id,
        create_accommodation: { place_id: place.id, start_day_id: day1.id, end_day_id: day2.id },
      });
    expect(createRes.status).toBe(201);
    const resvId = createRes.body.reservation.id;

    // Update with metadata containing check-in/out times and confirmation_number
    const updateRes = await request(app)
      .put(`/api/trips/${trip.id}/reservations/${resvId}`)
      .set('Cookie', authCookie(user.id))
      .send({
        metadata: { check_in_time: '15:00', check_out_time: '11:00' },
        confirmation_number: 'HTL-XYZ-999',
      });
    expect(updateRes.status).toBe(200);

    // Verify accommodation was updated with check-in/out
    const accom = testDb.prepare('SELECT * FROM day_accommodations WHERE trip_id = ?').get(trip.id) as any;
    expect(accom.check_in).toBe('15:00');
    expect(accom.check_out).toBe('11:00');
    expect(accom.confirmation).toBe('HTL-XYZ-999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete reservation
// ─────────────────────────────────────────────────────────────────────────────

describe('Delete reservation', () => {
  it('RESV-005 — DELETE removes reservation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const resv = createReservation(testDb, trip.id, { title: 'Flight', type: 'flight' });

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.reservations).toHaveLength(0);
  });

  it('RESV-005 — DELETE non-existent reservation returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/reservations/99999`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch update positions
// ─────────────────────────────────────────────────────────────────────────────

describe('Batch update positions', () => {
  it('RESV-006 — PUT /positions updates reservation sort order', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const r1 = createReservation(testDb, trip.id, { title: 'First', type: 'flight' });
    const r2 = createReservation(testDb, trip.id, { title: 'Second', type: 'hotel' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/reservations/positions`)
      .set('Cookie', authCookie(user.id))
      .send({ positions: [{ id: r2.id, position: 0 }, { id: r1.id, position: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget entry auto-create / auto-update
// ─────────────────────────────────────────────────────────────────────────────

describe('Reservation budget entry integration', () => {
  it('RESV-011 — POST with create_budget_entry auto-creates a linked budget item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Flight to Paris',
        type: 'flight',
        create_budget_entry: { total_price: 250, category: 'Transport' },
      });
    expect(res.status).toBe(201);

    const budgetItem = testDb
      .prepare('SELECT * FROM budget_items WHERE trip_id = ? AND reservation_id = ?')
      .get(trip.id, res.body.reservation.id) as any;
    expect(budgetItem).toBeDefined();
    expect(budgetItem.total_price).toBe(250);
    expect(budgetItem.name).toBe('Flight to Paris');
  });

  it('RESV-011b — POST with create_budget_entry.total_price = 0 skips budget creation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Free Entry',
        type: 'activity',
        create_budget_entry: { total_price: 0 },
      });
    expect(res.status).toBe(201);

    const budgetItems = testDb
      .prepare('SELECT * FROM budget_items WHERE trip_id = ?')
      .all(trip.id) as any[];
    expect(budgetItems).toHaveLength(0);
  });

  it('RESV-012 — PUT with create_budget_entry creates a new budget item when none exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const resv = createReservation(testDb, trip.id, { title: 'Hotel Stay', type: 'hotel' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ create_budget_entry: { total_price: 300, category: 'Accommodation' } });
    expect(res.status).toBe(200);

    const budgetItem = testDb
      .prepare('SELECT * FROM budget_items WHERE trip_id = ? AND reservation_id = ?')
      .get(trip.id, resv.id) as any;
    expect(budgetItem).toBeDefined();
    expect(budgetItem.total_price).toBe(300);
  });

  it('RESV-013 — PUT with create_budget_entry updates existing linked budget item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Create reservation with budget entry via POST
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Car Rental',
        type: 'transport',
        create_budget_entry: { total_price: 100, category: 'Transport' },
      });
    expect(createRes.status).toBe(201);
    const resvId = createRes.body.reservation.id;

    // Update with a new price — should update the existing budget item
    const updateRes = await request(app)
      .put(`/api/trips/${trip.id}/reservations/${resvId}`)
      .set('Cookie', authCookie(user.id))
      .send({ create_budget_entry: { total_price: 150, category: 'Transport' } });
    expect(updateRes.status).toBe(200);

    const items = testDb
      .prepare('SELECT * FROM budget_items WHERE trip_id = ? AND reservation_id = ?')
      .all(trip.id, resvId) as any[];
    expect(items).toHaveLength(1);
    expect(items[0].total_price).toBe(150);
  });

  it('RESV-014 — PUT without create_budget_entry removes existing linked budget item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Create with budget entry
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Taxi',
        type: 'transport',
        create_budget_entry: { total_price: 50, category: 'Transport' },
      });
    expect(createRes.status).toBe(201);
    const resvId = createRes.body.reservation.id;

    // Verify budget item exists
    const before = testDb
      .prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?')
      .get(trip.id, resvId);
    expect(before).toBeDefined();

    // Update without create_budget_entry — should delete the linked budget item
    const updateRes = await request(app)
      .put(`/api/trips/${trip.id}/reservations/${resvId}`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Taxi Updated' });
    expect(updateRes.status).toBe(200);

    const after = testDb
      .prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?')
      .get(trip.id, resvId);
    expect(after).toBeUndefined();
  });
});

describe('Reservation accommodation delete', () => {
  it('RESV-009 — DELETE reservation linked to accommodation also removes the accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day1 = createDay(testDb, trip.id, { date: '2025-07-01' });
    const day2 = createDay(testDb, trip.id, { date: '2025-07-03' });
    const place = createPlace(testDb, trip.id, { name: 'Hotel Belle' });

    // Create a reservation via API with create_accommodation as an object
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Hotel Belle Stay',
        type: 'hotel',
        day_id: day1.id,
        create_accommodation: {
          place_id: place.id,
          start_day_id: day1.id,
          end_day_id: day2.id,
        },
      });
    expect(createRes.status).toBe(201);
    const reservationId = createRes.body.reservation.id;

    // Verify accommodation was created
    const accom = testDb.prepare(
      'SELECT id FROM day_accommodations WHERE trip_id = ?'
    ).get(trip.id) as any;
    expect(accom).toBeDefined();

    // Delete reservation — should also remove the accommodation
    const delRes = await request(app)
      .delete(`/api/trips/${trip.id}/reservations/${reservationId}`)
      .set('Cookie', authCookie(user.id));
    expect(delRes.status).toBe(200);

    const accomAfter = testDb.prepare(
      'SELECT id FROM day_accommodations WHERE id = ?'
    ).get(accom.id);
    expect(accomAfter).toBeUndefined();
  });

  it('RESV-009b — DELETE reservation linked to accommodation also removes its linked budget item (issue #933)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day1 = createDay(testDb, trip.id, { date: '2025-08-01' });
    const day2 = createDay(testDb, trip.id, { date: '2025-08-03' });
    const place = createPlace(testDb, trip.id, { name: 'Seaside Resort' });

    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Seaside Resort Stay',
        type: 'hotel',
        day_id: day1.id,
        create_accommodation: { place_id: place.id, start_day_id: day1.id, end_day_id: day2.id },
        create_budget_entry: { total_price: 320, category: 'Accommodation' },
      });
    expect(createRes.status).toBe(201);
    const reservationId = createRes.body.reservation.id;

    const budgetBefore = testDb.prepare(
      'SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?'
    ).get(trip.id, reservationId);
    expect(budgetBefore).toBeDefined();

    // Delete via the reservation endpoint
    const delRes = await request(app)
      .delete(`/api/trips/${trip.id}/reservations/${reservationId}`)
      .set('Cookie', authCookie(user.id));
    expect(delRes.status).toBe(200);

    const budgetAfter = testDb.prepare(
      'SELECT id FROM budget_items WHERE trip_id = ?'
    ).get(trip.id);
    expect(budgetAfter).toBeUndefined();
  });
});
