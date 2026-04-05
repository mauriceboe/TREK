/**
 * Flights API integration tests.
 * Tests authentication, validation, and response for GET /api/flights/lookup.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
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
    getPlaceWithTags: () => null,
    canAccessTrip: () => null,
    isOwner: () => false,
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
import { resetRateLimiters } from '../../src/routes/auth';

const app: Application = createApp();

const MOCK_FLIGHT_RESPONSE = [
  {
    number: 'BR115',
    airline: { name: 'EVA Air', iata: 'BR' },
    departure: {
      airport: { iata: 'TPE', name: 'Taoyuan International Airport' },
      terminal: '2',
      gate: 'D5',
      scheduledTime: { local: '2026-04-06T08:00:00+08:00', utc: '2026-04-06T00:00:00Z' },
    },
    arrival: {
      airport: { iata: 'NRT', name: 'Narita International Airport' },
      terminal: '1',
      baggageBelt: '7',
      scheduledTime: { local: '2026-04-06T12:30:00+09:00', utc: '2026-04-06T03:30:00Z' },
    },
    aircraft: { model: 'Boeing 787-10' },
    status: 'Scheduled',
  },
];

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  resetRateLimiters();
  delete process.env.FLIGHT_API_KEY;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.FLIGHT_API_KEY;
});

afterAll(() => {
  testDb.close();
});

// ── Authentication ───────────────────────────────────────────────────────────

describe('GET /api/flights/lookup — authentication', () => {
  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .get('/api/flights/lookup')
      .query({ flight_number: 'BR115', date: '2026-04-06' });
    expect(res.status).toBe(401);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('GET /api/flights/lookup — validation', () => {
  let cookie: string;

  beforeEach(() => {
    const { user } = createUser(testDb, { email: 'val@test.com', password: 'password123' });
    cookie = authCookie(user.id);
  });

  it('returns 400 when flight_number is missing', async () => {
    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ date: '2026-04-06' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when date is missing', async () => {
    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when date format is invalid', async () => {
    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115', date: '06-04-2026' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when flight_number is empty string', async () => {
    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: '', date: '2026-04-06' });
    expect(res.status).toBe(400);
  });
});

// ── No API key → 404 ─────────────────────────────────────────────────────────

describe('GET /api/flights/lookup — no API key', () => {
  it('returns 404 when no flight API key configured', async () => {
    const { user } = createUser(testDb, { email: 'nokey@test.com', password: 'password123' });
    const cookie = authCookie(user.id);

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115', date: '2026-04-06' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/api key/i);
  });
});

// ── Successful lookup ─────────────────────────────────────────────────────────

describe('GET /api/flights/lookup — successful lookup', () => {
  let cookie: string;

  beforeEach(() => {
    process.env.FLIGHT_API_KEY = 'test-rapidapi-key';
    const { user } = createUser(testDb, { email: 'user@test.com', password: 'password123' });
    cookie = authCookie(user.id);
  });

  it('returns 200 with flight info for valid flight', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_FLIGHT_RESPONSE),
    });

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115', date: '2026-04-06' });

    expect(res.status).toBe(200);
    expect(res.body.flight).toBeDefined();
    expect(res.body.flight.flight_number).toBe('BR115');
    expect(res.body.flight.airline).toBe('EVA Air');
    expect(res.body.flight.departure_airport_iata).toBe('TPE');
    expect(res.body.flight.arrival_airport_iata).toBe('NRT');
    expect(res.body.flight.departure_terminal).toBe('2');
    expect(res.body.flight.arrival_baggage_belt).toBe('7');
    expect(res.body.flight.aircraft_type).toBe('Boeing 787-10');
  });

  it('normalizes flight number (lowercase + space)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_FLIGHT_RESPONSE),
    });

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'br 115', date: '2026-04-06' });

    expect(res.status).toBe(200);
    expect(res.body.flight.flight_number).toBe('BR115');
  });

  it('returns 404 when API returns empty array (flight not found)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'XX999', date: '2026-04-06' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 502 when upstream API returns error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ message: 'Rate limit' }),
    });

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115', date: '2026-04-06' });

    expect(res.status).toBe(502);
  });

  it('returns 502 when fetch throws network error', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

    const res = await request(app)
      .get('/api/flights/lookup')
      .set('Cookie', cookie)
      .query({ flight_number: 'BR115', date: '2026-04-06' });

    expect(res.status).toBe(502);
  });
});
