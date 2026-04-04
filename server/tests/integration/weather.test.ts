/**
 * Weather integration tests.
 * Covers WEATHER-001 to WEATHER-007.
 *
 * External API calls (Open-Meteo) are mocked via vi.mock.
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

// Mock node-fetch / global fetch so no real HTTP calls are made
vi.mock('node-fetch', () => ({
  default: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      current: { temperature_2m: 22, weathercode: 1, windspeed_10m: 10, relativehumidity_2m: 60, precipitation: 0 },
      daily: {
        time: ['2025-06-01'],
        temperature_2m_max: [25],
        temperature_2m_min: [18],
        weathercode: [1],
        precipitation_sum: [0],
        windspeed_10m_max: [15],
        sunrise: ['2025-06-01T06:00'],
        sunset: ['2025-06-01T21:00'],
      },
    }),
  }),
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

describe('Weather validation', () => {
  it('WEATHER-001 — GET /weather without lat/lng returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/weather')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(400);
  });

  it('WEATHER-001 — GET /weather without lng returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/weather?lat=48.8566')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(400);
  });

  it('WEATHER-005 — GET /weather/detailed without date returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/weather/detailed?lat=48.8566&lng=2.3522')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(400);
  });

  it('WEATHER-001 — GET /weather without auth returns 401', async () => {
    const res = await request(app)
      .get('/api/weather?lat=48.8566&lng=2.3522');
    expect(res.status).toBe(401);
  });
});

describe('Weather with mocked API', () => {
  it('WEATHER-001 — GET /weather with lat/lng returns weather data', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/weather?lat=48.8566&lng=2.3522')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('temp');
    expect(res.body).toHaveProperty('main');
  });

  it('WEATHER-002 — GET /weather?date=future returns forecast data', async () => {
    const { user } = createUser(testDb);
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const dateStr = futureDate.toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/weather?lat=48.8566&lng=2.3522&date=${dateStr}`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('temp');
    expect(res.body).toHaveProperty('type');
  });

  it('WEATHER-006 — GET /weather accepts lang parameter', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/weather?lat=48.8566&lng=2.3522&lang=en')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('temp');
  });
});
