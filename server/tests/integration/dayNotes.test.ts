/**
 * Day Notes integration tests.
 * Covers NOTE-001 to NOTE-006.
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
import { createUser, createTrip, createDay, addTripMember } from '../helpers/factories';
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
// Create day note
// ─────────────────────────────────────────────────────────────────────────────

describe('Create day note', () => {
  it('NOTE-001 — POST creates a day note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2025-06-01' });

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Remember to book tickets', time: '09:00' });
    expect(res.status).toBe(201);
    expect(res.body.note.text).toBe('Remember to book tickets');
    expect(res.body.note.time).toBe('09:00');
  });

  it('NOTE-001 — POST without text returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ time: '10:00' });
    expect(res.status).toBe(400);
  });

  it('NOTE-002 — text exceeding 500 characters is rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'A'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('NOTE-001 — POST on non-existent day returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/99999/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'This should fail' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List day notes
// ─────────────────────────────────────────────────────────────────────────────

describe('List day notes', () => {
  it('NOTE-003 — GET returns notes for a day', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Note A' });
    await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Note B' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(2);
  });

  it('NOTE-006 — non-member cannot list notes', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(other.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update day note
// ─────────────────────────────────────────────────────────────────────────────

describe('Update day note', () => {
  it('NOTE-004 — PUT updates a note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Old text' });
    const noteId = create.body.note.id;

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/notes/${noteId}`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'New text', icon: '🎯' });
    expect(res.status).toBe(200);
    expect(res.body.note.text).toBe('New text');
    expect(res.body.note.icon).toBe('🎯');
  });

  it('NOTE-004 — PUT on non-existent note returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/notes/99999`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Updated' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete day note
// ─────────────────────────────────────────────────────────────────────────────

describe('Delete day note', () => {
  it('NOTE-005 — DELETE removes note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'To delete' });
    const noteId = create.body.note.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/days/${day.id}/notes/${noteId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/notes`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.notes).toHaveLength(0);
  });

  it('NOTE-005 — DELETE non-existent note returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/days/${day.id}/notes/99999`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});
