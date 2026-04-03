/**
 * Share link integration tests.
 * Covers SHARE-001 to SHARE-009.
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
import { createUser, createTrip, addTripMember } from '../helpers/factories';
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

describe('Share link CRUD', () => {
  it('SHARE-001 — POST creates share link with default permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
  });

  it('SHARE-002 — POST creates share link with custom permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false, share_packing: true });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
  });

  it('SHARE-003 — POST again updates share link permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const first = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true });

    const second = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false });
    // Same token (update, not create)
    expect(second.body.token).toBe(first.body.token);
  });

  it('SHARE-004 — GET returns share link status', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const res = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('SHARE-004 — GET returns null token when no share link exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeNull();
  });

  it('SHARE-005 — DELETE removes share link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const status = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(status.body.token).toBeNull();
  });
});

describe('Shared trip access', () => {
  it('SHARE-006 — GET /shared/:token returns trip data with all sections', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Paris Adventure' });

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true, share_packing: true });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trip).toBeDefined();
    expect(res.body.trip.title).toBe('Paris Adventure');
  });

  it('SHARE-007 — GET /shared/:token hides budget when share_budget=false', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    // Budget should be an empty array when share_budget is false
    expect(Array.isArray(res.body.budget)).toBe(true);
    expect(res.body.budget).toHaveLength(0);
  });

  it('SHARE-008 — GET /shared/:invalid-token returns 404', async () => {
    const res = await request(app).get('/api/shared/invalid-token-xyz');
    expect(res.status).toBe(404);
  });

  it('SHARE-009 — non-member cannot create share link', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(other.id))
      .send({});
    expect(res.status).toBe(404);
  });
});
