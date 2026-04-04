/**
 * Atlas integration tests.
 * Covers ATLAS-001 to ATLAS-008.
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
import { createUser } from '../helpers/factories';
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

describe('Atlas stats', () => {
  it('ATLAS-001 — GET /api/atlas/stats returns stats object', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/atlas/stats')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('countries');
    expect(res.body).toHaveProperty('stats');
  });

  it('ATLAS-002 — GET /api/atlas/country/:code returns places in country', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/atlas/country/FR')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.places)).toBe(true);
  });
});

describe('Mark/unmark country', () => {
  it('ATLAS-003 — POST /country/:code/mark marks country as visited', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/addons/atlas/country/DE/mark')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify it appears in visited countries
    const stats = await request(app)
      .get('/api/addons/atlas/stats')
      .set('Cookie', authCookie(user.id));
    const codes = (stats.body.countries as any[]).map((c: any) => c.code);
    expect(codes).toContain('DE');
  });

  it('ATLAS-004 — DELETE /country/:code/mark unmarks country', async () => {
    const { user } = createUser(testDb);

    await request(app)
      .post('/api/addons/atlas/country/IT/mark')
      .set('Cookie', authCookie(user.id));

    const res = await request(app)
      .delete('/api/addons/atlas/country/IT/mark')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Bucket list', () => {
  it('ATLAS-005 — POST /bucket-list creates a bucket list item', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Machu Picchu', country_code: 'PE', lat: -13.1631, lng: -72.5450 });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe('Machu Picchu');
  });

  it('ATLAS-005 — POST without name returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id))
      .send({ country_code: 'JP' });
    expect(res.status).toBe(400);
  });

  it('ATLAS-006 — GET /bucket-list returns items', async () => {
    const { user } = createUser(testDb);

    await request(app)
      .post('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Santorini', country_code: 'GR' });

    const res = await request(app)
      .get('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('ATLAS-007 — PUT /bucket-list/:id updates item', async () => {
    const { user } = createUser(testDb);

    const create = await request(app)
      .post('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Old Name' });
    const id = create.body.item.id;

    const res = await request(app)
      .put(`/api/addons/atlas/bucket-list/${id}`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'New Name', notes: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe('New Name');
  });

  it('ATLAS-008 — DELETE /bucket-list/:id removes item', async () => {
    const { user } = createUser(testDb);

    const create = await request(app)
      .post('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Tokyo' });
    const id = create.body.item.id;

    const del = await request(app)
      .delete(`/api/addons/atlas/bucket-list/${id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get('/api/addons/atlas/bucket-list')
      .set('Cookie', authCookie(user.id));
    expect(list.body.items).toHaveLength(0);
  });

  it('ATLAS-008 — DELETE non-existent item returns 404', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .delete('/api/addons/atlas/bucket-list/99999')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});
