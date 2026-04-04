/**
 * Miscellaneous integration tests.
 * Covers MISC-001, 002, 004, 007, 008, 013, 015.
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

describe('Health check', () => {
  it('MISC-001 — GET /api/health returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Addons list', () => {
  it('MISC-002 — GET /api/addons returns enabled addons', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.addons)).toBe(true);
    // Should only return enabled addons
    const enabled = (res.body.addons as any[]).filter((a: any) => !a.enabled);
    expect(enabled.length).toBe(0);
  });
});

describe('Photo endpoint auth', () => {
  it('MISC-007 — GET /uploads/files without auth is blocked (401)', async () => {
    // /uploads/files is blocked without auth; /uploads/avatars and /uploads/covers are public static
    const res = await request(app).get('/uploads/files/nonexistent.txt');
    expect(res.status).toBe(401);
  });
});

describe('Force HTTPS redirect', () => {
  it('MISC-004 — FORCE_HTTPS redirect sends 301 for HTTP requests', async () => {
    // createApp() reads FORCE_HTTPS at call time, so we need a fresh app instance
    process.env.FORCE_HTTPS = 'true';
    let httpsApp: Express;
    try {
      httpsApp = createApp();
    } finally {
      delete process.env.FORCE_HTTPS;
    }
    const res = await request(httpsApp)
      .get('/api/health')
      .set('X-Forwarded-Proto', 'http');
    expect(res.status).toBe(301);
  });

  it('MISC-004 — no redirect when FORCE_HTTPS is not set', async () => {
    delete process.env.FORCE_HTTPS;

    const res = await request(app)
      .get('/api/health')
      .set('X-Forwarded-Proto', 'http');
    expect(res.status).toBe(200);
  });
});

describe('Categories endpoint', () => {
  it('MISC-013/PLACE-015 — GET /api/categories returns seeded categories', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/categories')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBeGreaterThan(0);
  });
});

describe('App config', () => {
  it('MISC-015 — GET /api/auth/app-config returns configuration', async () => {
    const res = await request(app).get('/api/auth/app-config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('allow_registration');
    expect(res.body).toHaveProperty('oidc_configured');
  });
});
