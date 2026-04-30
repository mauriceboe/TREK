/**
 * Days & Accommodations API integration tests.
 * Covers DAY-001 through DAY-006 and ACCOM-001 through ACCOM-003.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory DB — schema applied in beforeAll after mocks register
// ─────────────────────────────────────────────────────────────────────────────
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
import { createUser, createTrip, createDay, createPlace, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();
beforeAll(() => { createTables(testDb); runMigrations(testDb); });
beforeEach(() => { resetTestDb(testDb); loginAttempts.clear(); mfaAttempts.clear(); });
afterAll(() => { testDb.close(); });

// ─────────────────────────────────────────────────────────────────────────────
// List days (DAY-001, DAY-002)
// ─────────────────────────────────────────────────────────────────────────────

describe('List days', () => {
  it('DAY-001 — GET /api/trips/:tripId/days returns days for a trip the user can access', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Paris Trip', start_date: '2026-06-01', end_date: '2026-06-03' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.days).toBeDefined();
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days).toHaveLength(3);
  });

  it('DAY-001 — Member can list days for a shared trip', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { title: 'Shared Trip', start_date: '2026-07-01', end_date: '2026-07-02' });
    addTripMember(testDb, trip.id, member.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(2);
  });

  it('DAY-002 — Non-member cannot list days (404)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { title: 'Private Trip' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(stranger.id));

    expect(res.status).toBe(404);
  });

  it('DAY-002 — Unauthenticated request returns 401', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });

    const res = await request(app).get(`/api/trips/${trip.id}/days`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create day (DAY-006)
// ─────────────────────────────────────────────────────────────────────────────

describe('Create day', () => {
  it('DAY-006 — POST /api/trips/:tripId/days creates a standalone day with no date', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Open Trip' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(user.id))
      .send({ notes: 'A free day' });

    expect(res.status).toBe(201);
    expect(res.body.day).toBeDefined();
    expect(res.body.day.trip_id).toBe(trip.id);
    expect(res.body.day.date).toBeNull();
    expect(res.body.day.notes).toBe('A free day');
  });

  it('DAY-006 — POST /api/trips/:tripId/days creates a day with a date', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Dated Trip' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(user.id))
      .send({ date: '2026-08-15' });

    expect(res.status).toBe(201);
    expect(res.body.day.date).toBe('2026-08-15');
  });

  it('DAY-006 — Non-member cannot create a day (404)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { title: 'Private' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(stranger.id))
      .send({ notes: 'Infiltration' });

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update day (DAY-003, DAY-004)
// ─────────────────────────────────────────────────────────────────────────────

describe('Update day', () => {
  it('DAY-003 — PUT /api/trips/:tripId/days/:dayId updates the day title', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'My Trip' });
    const day = createDay(testDb, trip.id, { title: 'Old Title' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'New Title' });

    expect(res.status).toBe(200);
    expect(res.body.day).toBeDefined();
    expect(res.body.day.title).toBe('New Title');
  });

  it('DAY-004 — PUT /api/trips/:tripId/days/:dayId updates the day notes', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'My Trip' });
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ notes: 'Visit the Louvre' });

    expect(res.status).toBe(200);
    expect(res.body.day.notes).toBe('Visit the Louvre');
  });

  it('DAY-003 — PUT returns 404 for a day that does not belong to the trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'My Trip' });
    createDay(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/999999`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('DAY-003 — Non-member cannot update a day (404)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { title: 'Private' });
    const day = createDay(testDb, trip.id, { title: 'Original' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(stranger.id))
      .send({ title: 'Hacked' });

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reorder days (DAY-005)
// ─────────────────────────────────────────────────────────────────────────────

describe('Reorder days', () => {
  it('DAY-005 — Reorder: GET days returns them in day_number order', async () => {
    const { user } = createUser(testDb);
    // Create trip with 3 days auto-generated
    const trip = createTrip(testDb, user.id, {
      title: 'Trip',
      start_date: '2026-09-01',
      end_date: '2026-09-03',
    });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(3);
    // Days should be ordered by day_number ascending (the service sorts by day_number ASC)
    expect(res.body.days[0].date).toBe('2026-09-01');
    expect(res.body.days[2].date).toBe('2026-09-03');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete day
// ─────────────────────────────────────────────────────────────────────────────

describe('Delete day', () => {
  it('DELETE /api/trips/:tripId/days/:dayId removes the day', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deleted = testDb.prepare('SELECT id FROM days WHERE id = ?').get(day.id);
    expect(deleted).toBeUndefined();
  });

  it('DELETE /api/trips/:tripId/days/:dayId returns 404 for unknown day', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/days/999999`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Accommodations (ACCOM-001, ACCOM-002, ACCOM-003)
// ─────────────────────────────────────────────────────────────────────────────

describe('Accommodations', () => {
  it('ACCOM-001 — POST /api/trips/:tripId/accommodations creates an accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-10-01' });
    const day2 = createDay(testDb, trip.id, { date: '2026-10-03' });
    const place = createPlace(testDb, trip.id, { name: 'Grand Hotel' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({
        place_id: place.id,
        start_day_id: day1.id,
        end_day_id: day2.id,
        check_in: '15:00',
        check_out: '11:00',
        confirmation: 'ABC123',
        notes: 'Breakfast included',
      });

    expect(res.status).toBe(201);
    expect(res.body.accommodation).toBeDefined();
    expect(res.body.accommodation.place_id).toBe(place.id);
    expect(res.body.accommodation.start_day_id).toBe(day1.id);
    expect(res.body.accommodation.end_day_id).toBe(day2.id);
    expect(res.body.accommodation.confirmation).toBe('ABC123');
  });

  it('ACCOM-001 — POST missing required fields returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ notes: 'no ids' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('ACCOM-001 — POST with invalid place_id returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: 999999, start_day_id: day.id, end_day_id: day.id });

    expect(res.status).toBe(404);
  });

  it('ACCOM-002 — GET /api/trips/:tripId/accommodations returns accommodations for the trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-11-01' });
    const day2 = createDay(testDb, trip.id, { date: '2026-11-03' });
    const place = createPlace(testDb, trip.id, { name: 'Boutique Inn' });

    // Seed accommodation directly
    testDb.prepare(
      'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id) VALUES (?, ?, ?, ?)'
    ).run(trip.id, place.id, day1.id, day2.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.accommodations).toBeDefined();
    expect(Array.isArray(res.body.accommodations)).toBe(true);
    expect(res.body.accommodations).toHaveLength(1);
    expect(res.body.accommodations[0].place_name).toBe('Boutique Inn');
  });

  it('ACCOM-002 — Non-member cannot get accommodations (404)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id, { title: 'Private Trip' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(stranger.id));

    expect(res.status).toBe(404);
  });

  it('ACCOM-003 — DELETE /api/trips/:tripId/accommodations/:id removes accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-12-01' });
    const day2 = createDay(testDb, trip.id, { date: '2026-12-03' });
    const place = createPlace(testDb, trip.id, { name: 'Budget Hostel' });

    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: place.id, start_day_id: day1.id, end_day_id: day2.id });

    expect(createRes.status).toBe(201);
    const accommodationId = createRes.body.accommodation.id;

    const deleteRes = await request(app)
      .delete(`/api/trips/${trip.id}/accommodations/${accommodationId}`)
      .set('Cookie', authCookie(user.id));

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    // Verify removed from DB
    const row = testDb.prepare('SELECT id FROM day_accommodations WHERE id = ?').get(accommodationId);
    expect(row).toBeUndefined();
  });

  it('ACCOM-003 — DELETE non-existent accommodation returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/accommodations/999999`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('ACCOM-001 — Creating accommodation also creates a linked reservation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-10-10' });
    const day2 = createDay(testDb, trip.id, { date: '2026-10-12' });
    const place = createPlace(testDb, trip.id, { name: 'Luxury Resort' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: place.id, start_day_id: day1.id, end_day_id: day2.id, confirmation: 'CONF-XYZ' });

    expect(res.status).toBe(201);

    // Linked reservation should exist
    const reservation = testDb.prepare(
      'SELECT * FROM reservations WHERE accommodation_id = ?'
    ).get(res.body.accommodation.id) as any;
    expect(reservation).toBeDefined();
    expect(reservation.type).toBe('hotel');
    expect(reservation.confirmation_number).toBe('CONF-XYZ');
  });

  it('ACCOM-004 — PUT /api/trips/:tripId/accommodations/:id updates the accommodation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-10-20' });
    const day2 = createDay(testDb, trip.id, { date: '2026-10-22' });
    const day3 = createDay(testDb, trip.id, { date: '2026-10-25' });
    const place = createPlace(testDb, trip.id, { name: 'City Inn' });

    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: place.id, start_day_id: day1.id, end_day_id: day2.id, notes: 'Original' });

    expect(createRes.status).toBe(201);
    const accommodationId = createRes.body.accommodation.id;

    const updateRes = await request(app)
      .put(`/api/trips/${trip.id}/accommodations/${accommodationId}`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: place.id, start_day_id: day1.id, end_day_id: day3.id, notes: 'Extended stay' });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.accommodation).toBeDefined();
    expect(updateRes.body.accommodation.end_day_id).toBe(day3.id);
    expect(updateRes.body.accommodation.notes).toBe('Extended stay');
  });

  it('ACCOM-004 — PUT non-existent accommodation returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/accommodations/999999`)
      .set('Cookie', authCookie(user.id))
      .send({ notes: 'Ghost update' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('ACCOM-003 — Deleting accommodation also removes the linked reservation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-10-15' });
    const day2 = createDay(testDb, trip.id, { date: '2026-10-17' });
    const place = createPlace(testDb, trip.id, { name: 'Mountain Lodge' });

    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/accommodations`)
      .set('Cookie', authCookie(user.id))
      .send({ place_id: place.id, start_day_id: day1.id, end_day_id: day2.id });

    const accommodationId = createRes.body.accommodation.id;
    const reservationBefore = testDb.prepare(
      'SELECT id FROM reservations WHERE accommodation_id = ?'
    ).get(accommodationId) as any;
    expect(reservationBefore).toBeDefined();

    const deleteRes = await request(app)
      .delete(`/api/trips/${trip.id}/accommodations/${accommodationId}`)
      .set('Cookie', authCookie(user.id));
    expect(deleteRes.status).toBe(200);

    const reservationAfter = testDb.prepare(
      'SELECT id FROM reservations WHERE id = ?'
    ).get(reservationBefore.id);
    expect(reservationAfter).toBeUndefined();
  });

  it('ACCOM-006 — DELETE accommodation also removes its linked budget item (issue #933)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel Budget Trip' });
    const day1 = createDay(testDb, trip.id, { date: '2026-11-01' });
    const day2 = createDay(testDb, trip.id, { date: '2026-11-03' });
    const place = createPlace(testDb, trip.id, { name: 'Grand Hotel' });

    // Create a hotel reservation that creates an accommodation and a linked budget item
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/reservations`)
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Grand Hotel Stay',
        type: 'hotel',
        day_id: day1.id,
        create_accommodation: { place_id: place.id, start_day_id: day1.id, end_day_id: day2.id },
        create_budget_entry: { total_price: 450, category: 'Accommodation' },
      });
    expect(createRes.status).toBe(201);

    const accommodationId = testDb.prepare(
      'SELECT id FROM day_accommodations WHERE trip_id = ?'
    ).get(trip.id) as any;
    expect(accommodationId).toBeDefined();

    const budgetBefore = testDb.prepare(
      'SELECT id FROM budget_items WHERE trip_id = ?'
    ).get(trip.id);
    expect(budgetBefore).toBeDefined();

    // Delete via the accommodation endpoint (the primary bug path)
    const delRes = await request(app)
      .delete(`/api/trips/${trip.id}/accommodations/${accommodationId.id}`)
      .set('Cookie', authCookie(user.id));
    expect(delRes.status).toBe(200);

    const budgetAfter = testDb.prepare(
      'SELECT id FROM budget_items WHERE trip_id = ?'
    ).get(trip.id);
    expect(budgetAfter).toBeUndefined();
  });
});
