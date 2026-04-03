/**
 * Maps integration tests.
 * Covers MAPS-001 to MAPS-008.
 *
 * External API calls (Nominatim, Google Places, Wikipedia) are tested at the
 * input validation level. Full integration tests would require live external APIs.
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

describe('Maps authentication', () => {
  it('POST /maps/search without auth returns 401', async () => {
    const res = await request(app)
      .post('/api/maps/search')
      .send({ query: 'Paris' });
    expect(res.status).toBe(401);
  });

  it('GET /maps/reverse without auth returns 401', async () => {
    const res = await request(app)
      .get('/api/maps/reverse?lat=48.8566&lng=2.3522');
    expect(res.status).toBe(401);
  });
});

describe('Maps validation', () => {
  it('MAPS-001 — POST /maps/search without query returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/maps/search')
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it('MAPS-006 — GET /maps/reverse without lat/lng returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/maps/reverse')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(400);
  });

  it('MAPS-007 — POST /maps/resolve-url without url returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/maps/resolve-url')
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('Maps SSRF protection', () => {
  it('MAPS-007 — POST /maps/resolve-url with internal IP is blocked', async () => {
    const { user } = createUser(testDb);

    // SSRF: should be blocked by ssrfGuard
    const res = await request(app)
      .post('/api/maps/resolve-url')
      .set('Cookie', authCookie(user.id))
      .send({ url: 'http://192.168.1.1/admin' });
    expect(res.status).toBe(400);
  });

  it('MAPS-007 — POST /maps/resolve-url with loopback IP is blocked', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/maps/resolve-url')
      .set('Cookie', authCookie(user.id))
      .send({ url: 'http://127.0.0.1/secret' });
    expect(res.status).toBe(400);
  });
});
