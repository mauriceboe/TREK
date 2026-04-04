/**
 * User Profile & Settings integration tests.
 * Covers PROFILE-001 to PROFILE-015.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import path from 'path';

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
import { createUser, createAdmin, createTrip } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();
const FIXTURE_JPEG = path.join(__dirname, '../fixtures/small-image.jpg');
const FIXTURE_PDF = path.join(__dirname, '../fixtures/test.pdf');

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
// Profile
// ─────────────────────────────────────────────────────────────────────────────

describe('PROFILE-001 — Get current user profile', () => {
  it('returns user object with expected fields', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: user.id,
      email: user.email,
      username: user.username,
    });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.mfa_secret).toBeUndefined();
    expect(res.body.user).toHaveProperty('mfa_enabled');
    expect(res.body.user).toHaveProperty('must_change_password');
  });
});

describe('Avatar', () => {
  it('PROFILE-002 — upload valid JPEG avatar updates avatar_url', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/avatar')
      .set('Cookie', authCookie(user.id))
      .attach('avatar', FIXTURE_JPEG);
    expect(res.status).toBe(200);
    expect(res.body.avatar_url).toBeDefined();
    expect(typeof res.body.avatar_url).toBe('string');
  });

  it('PROFILE-003 — uploading non-image (PDF) is rejected', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/avatar')
      .set('Cookie', authCookie(user.id))
      .attach('avatar', FIXTURE_PDF);
    // multer fileFilter rejects non-image types (cb(null, false) → req.file undefined → 400)
    expect(res.status).toBe(400);
  });

  it('PROFILE-005 — DELETE /api/auth/avatar clears avatar_url', async () => {
    const { user } = createUser(testDb);
    // Upload first
    await request(app)
      .post('/api/auth/avatar')
      .set('Cookie', authCookie(user.id))
      .attach('avatar', FIXTURE_JPEG);

    const res = await request(app)
      .delete('/api/auth/avatar')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', authCookie(user.id));
    expect(me.body.user.avatar_url).toBeNull();
  });
});

describe('Password change', () => {
  it('PROFILE-006 — change password with valid credentials succeeds', async () => {
    const { user, password } = createUser(testDb);
    const res = await request(app)
      .put('/api/auth/me/password')
      .set('Cookie', authCookie(user.id))
      .send({ current_password: password, new_password: 'NewStr0ng!Pass', confirm_password: 'NewStr0ng!Pass' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PROFILE-007 — wrong current password returns 401', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .put('/api/auth/me/password')
      .set('Cookie', authCookie(user.id))
      .send({ current_password: 'WrongPass1!', new_password: 'NewStr0ng!Pass', confirm_password: 'NewStr0ng!Pass' });
    expect(res.status).toBe(401);
  });

  it('PROFILE-008 — weak new password is rejected', async () => {
    const { user, password } = createUser(testDb);
    const res = await request(app)
      .put('/api/auth/me/password')
      .set('Cookie', authCookie(user.id))
      .send({ current_password: password, new_password: 'weak', confirm_password: 'weak' });
    expect(res.status).toBe(400);
  });
});

describe('Settings', () => {
  it('PROFILE-009 — PUT /api/settings with key+value persists and GET returns it', async () => {
    const { user } = createUser(testDb);

    const put = await request(app)
      .put('/api/settings')
      .set('Cookie', authCookie(user.id))
      .send({ key: 'dark_mode', value: 'dark' });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get('/api/settings')
      .set('Cookie', authCookie(user.id));
    expect(get.status).toBe(200);
    expect(get.body.settings).toHaveProperty('dark_mode', 'dark');
  });

  it('PROFILE-009 — PUT /api/settings without key returns 400', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', authCookie(user.id))
      .send({ value: 'dark' });
    expect(res.status).toBe(400);
  });

  it('PROFILE-010 — POST /api/settings/bulk saves multiple keys atomically', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/settings/bulk')
      .set('Cookie', authCookie(user.id))
      .send({ settings: { theme: 'dark', language: 'fr', timezone: 'Europe/Paris' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const get = await request(app)
      .get('/api/settings')
      .set('Cookie', authCookie(user.id));
    expect(get.body.settings).toHaveProperty('theme', 'dark');
    expect(get.body.settings).toHaveProperty('language', 'fr');
    expect(get.body.settings).toHaveProperty('timezone', 'Europe/Paris');
  });
});

describe('API Keys', () => {
  it('PROFILE-011 — PUT /api/auth/me/api-keys saves keys encrypted at rest', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .put('/api/auth/me/api-keys')
      .set('Cookie', authCookie(user.id))
      .send({ openweather_api_key: 'my-weather-key-123' });
    expect(res.status).toBe(200);

    // Key in DB should be encrypted (not plaintext)
    const row = testDb.prepare('SELECT openweather_api_key FROM users WHERE id = ?').get(user.id) as any;
    expect(row.openweather_api_key).toMatch(/^enc:v1:/);
  });

  it('PROFILE-011 — GET /api/auth/me does not return plaintext API keys', async () => {
    const { user } = createUser(testDb);
    await request(app)
      .put('/api/auth/me/api-keys')
      .set('Cookie', authCookie(user.id))
      .send({ openweather_api_key: 'plaintext-key' });

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', authCookie(user.id));
    // The key should be masked or absent, never plaintext
    const body = me.body.user;
    expect(body.openweather_api_key).not.toBe('plaintext-key');
  });
});

describe('Account deletion', () => {
  it('PROFILE-013 — DELETE /api/auth/me removes account, subsequent login fails', async () => {
    const { user, password } = createUser(testDb);

    const del = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);

    // Should not be able to log in
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });
    expect(login.status).toBe(401);
  });

  it('PROFILE-013 — admin cannot delete their own account', async () => {
    const { user: admin } = createAdmin(testDb);
    // Admins are protected from self-deletion
    const res = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', authCookie(admin.id));
    // deleteAccount returns 400 when the user is the last admin
    expect(res.status).toBe(400);
  });
});

describe('Travel stats', () => {
  it('PROFILE-014 — GET /api/auth/travel-stats returns stats object', async () => {
    const { user } = createUser(testDb);
    createTrip(testDb, user.id, {
      title: 'France Trip',
      start_date: '2024-06-01',
      end_date: '2024-06-05',
    });

    const res = await request(app)
      .get('/api/auth/travel-stats')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalTrips');
    expect(res.body.totalTrips).toBeGreaterThanOrEqual(1);
  });
});

describe('Demo mode protections', () => {
  it('PROFILE-015 — demo user cannot upload avatar (demoUploadBlock)', async () => {
    // demoUploadBlock checks for email === 'demo@nomad.app'
    testDb.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('demo', 'demo@nomad.app', 'x', 'user')"
    ).run();
    const demoUser = testDb.prepare('SELECT id FROM users WHERE email = ?').get('demo@nomad.app') as { id: number };
    process.env.DEMO_MODE = 'true';

    try {
      const res = await request(app)
        .post('/api/auth/avatar')
        .set('Cookie', authCookie(demoUser.id))
        .attach('avatar', FIXTURE_JPEG);
      expect(res.status).toBe(403);
    } finally {
      delete process.env.DEMO_MODE;
    }
  });
});
