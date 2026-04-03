/**
 * Notifications integration tests.
 * Covers NOTIF-001 to NOTIF-014.
 *
 * External SMTP / webhook calls are not made — tests focus on preferences,
 * in-app notification CRUD, and authentication.
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

describe('Notification preferences', () => {
  it('NOTIF-001 — GET /api/notifications/preferences returns defaults', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/notifications/preferences')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preferences');
  });

  it('NOTIF-001 — PUT /api/notifications/preferences updates settings', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .put('/api/notifications/preferences')
      .set('Cookie', authCookie(user.id))
      .send({ notify_trip_invite: true, notify_booking_change: false });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preferences');
  });

  it('NOTIF — GET preferences without auth returns 401', async () => {
    const res = await request(app).get('/api/notifications/preferences');
    expect(res.status).toBe(401);
  });
});

describe('In-app notifications', () => {
  it('NOTIF-008 — GET /api/notifications/in-app returns notifications array', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/notifications/in-app')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notifications)).toBe(true);
  });

  it('NOTIF-008 — GET /api/notifications/in-app/unread-count returns count', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/notifications/in-app/unread-count')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(typeof res.body.count).toBe('number');
  });

  it('NOTIF-009 — PUT /api/notifications/in-app/read-all marks all read', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .put('/api/notifications/in-app/read-all')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('NOTIF-010 — DELETE /api/notifications/in-app/all deletes all notifications', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .delete('/api/notifications/in-app/all')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('NOTIF-011 — PUT /api/notifications/in-app/:id/read on non-existent returns 404', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .put('/api/notifications/in-app/99999/read')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });

  it('NOTIF-012 — DELETE /api/notifications/in-app/:id on non-existent returns 404', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .delete('/api/notifications/in-app/99999')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});

describe('Notification test endpoints', () => {
  it('NOTIF-005 — POST /api/notifications/test-smtp requires admin', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/notifications/test-smtp')
      .set('Cookie', authCookie(user.id));
    // Non-admin gets 403
    expect(res.status).toBe(403);
  });

  it('NOTIF-006 — POST /api/notifications/test-webhook requires admin', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/notifications/test-webhook')
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(403);
  });
});
