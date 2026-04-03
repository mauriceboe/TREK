/**
 * Vacay integration tests.
 * Covers VACAY-001 to VACAY-025.
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

// Mock external holiday API (node-fetch used by some service paths)
vi.mock('node-fetch', () => ({
  default: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([
      { date: '2025-01-01', name: 'New Year\'s Day', countryCode: 'DE' },
    ]),
  }),
}));

// Mock vacayService.getCountries to avoid real HTTP call to nager.at
vi.mock('../../src/services/vacayService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/vacayService')>('../../src/services/vacayService');
  return {
    ...actual,
    getCountries: vi.fn().mockResolvedValue({
      data: [{ countryCode: 'DE', name: 'Germany' }, { countryCode: 'FR', name: 'France' }],
    }),
  };
});

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

describe('Vacay plan', () => {
  it('VACAY-001 — GET /api/addons/vacay/plan auto-creates plan on first access', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
    expect(res.body.plan.owner_id).toBe(user.id);
  });

  it('VACAY-001 — second GET returns same plan (no duplicate creation)', async () => {
    const { user } = createUser(testDb);

    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    const res = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
  });

  it('VACAY-002 — PUT /api/addons/vacay/plan updates plan settings', async () => {
    const { user } = createUser(testDb);

    // Ensure plan exists
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .put('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id))
      .send({ vacation_days: 30, carry_over_days: 5 });
    expect(res.status).toBe(200);
  });
});

describe('Vacay years', () => {
  it('VACAY-007 — POST /api/addons/vacay/years adds a year to the plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(user.id))
      .send({ year: 2025 });
    expect(res.status).toBe(200);
    expect(res.body.years).toBeDefined();
  });

  it('VACAY-025 — GET /api/addons/vacay/years lists years in plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/years')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.years)).toBe(true);
    expect(res.body.years.length).toBeGreaterThanOrEqual(1);
  });

  it('VACAY-008 — DELETE /api/addons/vacay/years/:year removes year', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2026 });

    const res = await request(app)
      .delete('/api/addons/vacay/years/2026')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.years).toBeDefined();
  });

  it('VACAY-011 — PUT /api/addons/vacay/stats/:year updates allowance', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .put('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id))
      .send({ vacation_days: 28 });
    expect(res.status).toBe(200);
  });
});

describe('Vacay entries', () => {
  it('VACAY-003 — POST /api/addons/vacay/entries/toggle marks a day as vacation', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(user.id))
      .send({ date: '2025-06-16', year: 2025, type: 'vacation' });
    expect(res.status).toBe(200);
  });

  it('VACAY-004 — POST /api/addons/vacay/entries/toggle on weekend is allowed (no server-side weekend blocking)', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    // 2025-06-21 is a Saturday — server does not block weekends; client-side only
    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(user.id))
      .send({ date: '2025-06-21', year: 2025, type: 'vacation' });
    expect(res.status).toBe(200);
  });

  it('VACAY-006 — GET /api/addons/vacay/entries/:year returns vacation entries', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/entries/2025')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('VACAY-009 — GET /api/addons/vacay/stats/:year returns stats for year', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stats');
  });
});

describe('Vacay color', () => {
  it('VACAY-024 — PUT /api/addons/vacay/color sets user color in plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .put('/api/addons/vacay/color')
      .set('Cookie', authCookie(user.id))
      .send({ color: '#3b82f6' });
    expect(res.status).toBe(200);
  });
});

describe('Vacay invite flow', () => {
  it('VACAY-022 — cannot invite yourself', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(user.id))
      .send({ user_id: user.id });
    expect(res.status).toBe(400);
  });

  it('VACAY-016 — send invite to another user', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));

    const res = await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('VACAY-023 — GET /api/addons/vacay/available-users returns users who can be invited', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .get('/api/addons/vacay/available-users')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

describe('Vacay holidays', () => {
  it('VACAY-014 — GET /api/addons/vacay/holidays/countries returns available countries', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/vacay/holidays/countries')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('VACAY-012 — POST /api/addons/vacay/plan/holiday-calendars adds a holiday calendar', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/plan/holiday-calendars')
      .set('Cookie', authCookie(user.id))
      .send({ region: 'DE', label: 'Germany Holidays' });
    expect(res.status).toBe(200);
  });
});

describe('Vacay dissolve plan', () => {
  it('VACAY-020 — POST /api/addons/vacay/dissolve removes user from plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/dissolve')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
  });
});
