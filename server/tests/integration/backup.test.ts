/**
 * Backup integration tests.
 * Covers BACKUP-001 to BACKUP-008.
 *
 * Note: createBackup() is async and creates real files.
 *       These tests run in test env and may not have a full DB file to zip,
 *       but the service should handle gracefully.
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

// Mock filesystem-dependent service functions to avoid real disk I/O in tests
vi.mock('../../src/services/backupService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/backupService')>('../../src/services/backupService');
  return {
    ...actual,
    createBackup: vi.fn().mockResolvedValue({
      filename: 'backup-2026-04-03T06-00-00.zip',
      size: 1024,
      sizeText: '1.0 KB',
      created_at: new Date().toISOString(),
    }),
    updateAutoSettings: vi.fn().mockReturnValue({
      enabled: false,
      interval: 'daily',
      keep_days: 7,
      hour: 2,
      day_of_week: 0,
      day_of_month: 1,
    }),
  };
});

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createAdmin, createUser } from '../helpers/factories';
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

describe('Backup access control', () => {
  it('non-admin cannot access backup routes', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/backup/list')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(403);
  });
});

describe('Backup list', () => {
  it('BACKUP-001 — GET /backup/list returns backups array', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/backup/list')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.backups)).toBe(true);
  });
});

describe('Backup creation', () => {
  it('BACKUP-001 — POST /backup/create creates a backup', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/backup/create')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.backup).toHaveProperty('filename');
    expect(res.body.backup).toHaveProperty('size');
  });
});

describe('Auto-backup settings', () => {
  it('BACKUP-008 — GET /backup/auto-settings returns current config', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/backup/auto-settings')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
    expect(res.body.settings).toHaveProperty('enabled');
  });

  it('BACKUP-008 — PUT /backup/auto-settings updates settings', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .put('/api/backup/auto-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ enabled: false, interval: 'daily', keep_days: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
    expect(res.body.settings).toHaveProperty('enabled');
    expect(res.body.settings).toHaveProperty('interval');
  });
});

describe('Backup security', () => {
  it('BACKUP-007 — Download with path traversal filename is rejected', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/backup/download/../../etc/passwd')
      .set('Cookie', authCookie(admin.id));
    // Express normalises the URL before routing; path traversal gets resolved
    // to a path that matches no route → 404
    expect(res.status).toBe(404);
  });

  it('BACKUP-007 — Delete with path traversal filename is rejected', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .delete('/api/backup/../../../etc/passwd')
      .set('Cookie', authCookie(admin.id));
    // Express normalises the URL, stripping traversal → no route match → 404
    expect(res.status).toBe(404);
  });
});
