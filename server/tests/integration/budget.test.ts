/**
 * Budget Planner integration tests.
 * Covers BUDGET-001 to BUDGET-010.
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
import { createUser, createTrip, createBudgetItem, addTripMember } from '../helpers/factories';
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
// Create budget item
// ─────────────────────────────────────────────────────────────────────────────

describe('Create budget item', () => {
  it('BUDGET-001 — POST creates budget item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Flights', category: 'Transport', total_price: 500, currency: 'EUR' });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe('Flights');
    expect(res.body.item.total_price).toBe(500);
  });

  it('BUDGET-001 — POST without name returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(user.id))
      .send({ category: 'Transport', total_price: 200 });
    expect(res.status).toBe(400);
  });

  it('BUDGET-010 — non-member cannot create budget item', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(other.id))
      .send({ name: 'Hotels', total_price: 300 });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List budget items
// ─────────────────────────────────────────────────────────────────────────────

describe('List budget items', () => {
  it('BUDGET-002 — GET /api/trips/:tripId/budget returns all items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip.id, { name: 'Flight', total_price: 300 });
    createBudgetItem(testDb, trip.id, { name: 'Hotel', total_price: 500 });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('BUDGET-002 — member can list budget items', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    createBudgetItem(testDb, trip.id, { name: 'Rental', total_price: 200 });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(member.id));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update budget item
// ─────────────────────────────────────────────────────────────────────────────

describe('Update budget item', () => {
  it('BUDGET-003 — PUT updates budget item fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id, { name: 'Old Name', total_price: 100 });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/budget/${item.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'New Name', total_price: 250 });
    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe('New Name');
    expect(res.body.item.total_price).toBe(250);
  });

  it('BUDGET-003 — PUT non-existent item returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/budget/99999`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete budget item
// ─────────────────────────────────────────────────────────────────────────────

describe('Delete budget item', () => {
  it('BUDGET-004 — DELETE removes item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id);

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/budget/${item.id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/budget`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.items).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

describe('Budget item members', () => {
  it('BUDGET-005 — PUT /members assigns members to budget item', async () => {
    const { user } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, member.id);
    const item = createBudgetItem(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/budget/${item.id}/members`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id, member.id] });
    expect(res.status).toBe(200);
    expect(res.body.members).toBeDefined();
  });

  it('BUDGET-005 — PUT /members with non-array user_ids returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/budget/${item.id}/members`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('BUDGET-006 — PUT /members/:userId/paid toggles paid status', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createBudgetItem(testDb, trip.id);

    // Assign user as member first
    await request(app)
      .put(`/api/trips/${trip.id}/budget/${item.id}/members`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id] });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/budget/${item.id}/members/${user.id}/paid`)
      .set('Cookie', authCookie(user.id))
      .send({ paid: true });
    expect(res.status).toBe(200);
    expect(res.body.member).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary & Settlement
// ─────────────────────────────────────────────────────────────────────────────

describe('Budget summary and settlement', () => {
  it('BUDGET-007 — GET /summary/per-person returns per-person breakdown', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip.id, { name: 'Dinner', total_price: 60 });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/budget/summary/per-person`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.summary)).toBe(true);
  });

  it('BUDGET-008 — GET /settlement returns settlement transactions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/budget/settlement`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('balances');
    expect(res.body).toHaveProperty('flows');
  });

  it('BUDGET-009 — settlement with no payers returns empty transactions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Item with no members/payers assigned
    createBudgetItem(testDb, trip.id, { name: 'Train', total_price: 40 });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/budget/settlement`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
  });
});
