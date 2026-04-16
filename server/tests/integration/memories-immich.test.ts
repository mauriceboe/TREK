/**
 * Immich-specific integration tests (IMMICH-030 – IMMICH-070).
 * Covers status, test-connection, browse, search, asset proxy, access control,
 * and albums — everything NOT covered by the existing immich.test.ts.
 *
 * safeFetch is mocked to return fake Immich API responses based on URL patterns.
 * No real HTTP calls are made.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// ── Hoisted DB mock ──────────────────────────────────────────────────────────

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
vi.mock('../../src/websocket', () => ({ broadcast: vi.fn() }));

// ── SSRF guard mock — routes all Immich API calls to fake responses ───────────
vi.mock('../../src/utils/ssrfGuard', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/ssrfGuard')>('../../src/utils/ssrfGuard');

  function makeFakeImmichFetch(url: string, init?: any) {
    const u = typeof url === 'string' ? url : String(url);

    // /api/users/me  — used by status + test-connection
    if (u.includes('/api/users/me')) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
        json: () => Promise.resolve({ name: 'Test User', email: 'test@immich.local' }),
        body: null,
      });
    }
    // /api/timeline/buckets — browse
    if (u.includes('/api/timeline/buckets')) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve([{ timeBucket: '2024-01-01T00:00:00.000Z', count: 3 }]),
        body: null,
      });
    }
    // /api/search/metadata — search
    if (u.includes('/api/search/metadata')) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({
          assets: {
            items: [
              { id: 'asset-search-1', fileCreatedAt: '2024-06-01T10:00:00.000Z', exifInfo: { city: 'Paris', country: 'France' } },
            ],
          },
        }),
        body: null,
      });
    }
    // /api/assets/:id/thumbnail — thumbnail proxy
    if (u.includes('/thumbnail')) {
      const imageBytes = Buffer.from('fake-thumbnail-data');
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h: string) => h === 'content-type' ? 'image/webp' : null },
        body: new ReadableStream({ start(c) { c.enqueue(imageBytes); c.close(); } }),
      });
    }
    // /api/assets/:id/original — original proxy
    if (u.includes('/original')) {
      const imageBytes = Buffer.from('fake-original-data');
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h: string) => h === 'content-type' ? 'image/jpeg' : null },
        body: new ReadableStream({ start(c) { c.enqueue(imageBytes); c.close(); } }),
      });
    }
    // /api/assets/:id — asset info
    if (/\/api\/assets\/[^/]+$/.test(u)) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({
          id: 'asset-info-1',
          fileCreatedAt: '2024-06-01T10:00:00.000Z',
          originalFileName: 'photo.jpg',
          exifInfo: {
            exifImageWidth: 4032, exifImageHeight: 3024,
            make: 'Apple', model: 'iPhone 15',
            lensModel: null, focalLength: 5.1, fNumber: 1.8,
            exposureTime: '1/500', iso: 100,
            city: 'Paris', state: 'Île-de-France', country: 'France',
            latitude: 48.8566, longitude: 2.3522,
            fileSizeInByte: 2048000,
          },
        }),
        body: null,
      });
    }
    // /api/albums — list albums (owned and shared?=true variant)
    if (/\/api\/albums(\?.*)?$/.test(u)) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve([
          { id: 'album-uuid-1', albumName: 'Vacation 2024', assetCount: 42, startDate: '2024-06-01', endDate: '2024-06-14', albumThumbnailAssetId: null },
        ]),
        body: null,
      });
    }
    // /api/albums/:id — album detail (for sync)
    if (/\/api\/albums\//.test(u)) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ assets: [{ id: 'asset-sync-1', type: 'IMAGE' }] }),
        body: null,
      });
    }
    // fallback — unexpected call
    return Promise.reject(new Error(`Unexpected safeFetch call: ${u}`));
  }

  return {
    ...actual,
    checkSsrf: vi.fn().mockImplementation(async (rawUrl: string) => {
      try {
        const url = new URL(rawUrl);
        const h = url.hostname;
        if (h === '127.0.0.1' || h === '::1' || h === 'localhost') {
          return { allowed: false, isPrivate: true, error: 'Loopback not allowed' };
        }
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
          return { allowed: false, isPrivate: true, error: 'Private IP not allowed' };
        }
        return { allowed: true, isPrivate: false, resolvedIp: '93.184.216.34' };
      } catch {
        return { allowed: false, isPrivate: false, error: 'Invalid URL' };
      }
    }),
    safeFetch: vi.fn().mockImplementation(makeFakeImmichFetch),
  };
});

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip, addTripMember, addTripPhoto, addAlbumLink, setImmichCredentials } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';
import { safeFetch } from '../../src/utils/ssrfGuard';

const app: Application = createApp();

const IMMICH = '/api/integrations/memories/immich';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => testDb.close());

// ── Connection status ─────────────────────────────────────────────────────────

describe('Immich connection status', () => {
  it('IMMICH-030 — GET /status when not configured returns { connected: false }', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get(`${IMMICH}/status`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it('IMMICH-031 — GET /status when configured returns connected + user info', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    const res = await request(app)
      .get(`${IMMICH}/status`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.user).toMatchObject({ name: 'Test User', email: 'test@immich.local' });
  });
});

// ── Test connection ───────────────────────────────────────────────────────────

describe('Immich test connection', () => {
  it('IMMICH-032 — POST /test with missing fields returns { connected: false }', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post(`${IMMICH}/test`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_url: 'https://immich.example.com' }); // missing api_key

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it('IMMICH-033 — POST /test with valid credentials returns { connected: true }', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post(`${IMMICH}/test`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_url: 'https://immich.example.com', immich_api_key: 'valid-key' });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.user).toBeDefined();
  });
});

// ── Browse & Search ───────────────────────────────────────────────────────────

describe('Immich browse and search', () => {
  it('IMMICH-040 — GET /browse when not configured returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get(`${IMMICH}/browse`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(400);
  });

  it('IMMICH-041 — GET /browse returns timeline buckets', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    const res = await request(app)
      .get(`${IMMICH}/browse`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.buckets.length).toBeGreaterThan(0);
  });

  it('IMMICH-042 — POST /search returns mapped assets with hasMore flag', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    const res = await request(app)
      .post(`${IMMICH}/search`)
      .set('Cookie', authCookie(user.id))
      .send({ page: 1, size: 50 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.assets[0]).toMatchObject({ id: 'asset-search-1', city: 'Paris', country: 'France' });
    expect(typeof res.body.hasMore).toBe('boolean');
  });

  it('IMMICH-043 — POST /search when upstream throws returns 502', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('upstream unreachable'));

    const res = await request(app)
      .post(`${IMMICH}/search`)
      .set('Cookie', authCookie(user.id))
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });
});

// ── Asset proxy ───────────────────────────────────────────────────────────────

describe('Immich asset proxy', () => {
  it('IMMICH-050 — GET /assets/info returns asset metadata for own photo', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');
    addTripPhoto(testDb, trip.id, user.id, 'asset-info-1', 'immich', { shared: false });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-info-1/${user.id}/info`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'asset-info-1', city: 'Paris', country: 'France' });
  });

  it('IMMICH-051 — GET /assets/info with invalid assetId (special chars) returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // ID contains characters outside [a-zA-Z0-9_-] → fails isValidAssetId()
    const invalidId = 'asset!@#$%';

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/${encodeURIComponent(invalidId)}/${user.id}/info`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(400);
  });

  it('IMMICH-052 — GET /assets/info by non-owner of unshared photo returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    setImmichCredentials(testDb, owner.id, 'https://immich.example.com', 'test-api-key');
    // private photo — shared = false
    addTripPhoto(testDb, trip.id, owner.id, 'asset-private', 'immich', { shared: false });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-private/${owner.id}/info`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(403);
  });

  it('IMMICH-053 — GET /assets/info by trip member for shared photo returns 200', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    setImmichCredentials(testDb, owner.id, 'https://immich.example.com', 'test-api-key');
    // shared photo
    addTripPhoto(testDb, trip.id, owner.id, 'asset-shared', 'immich', { shared: true });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-shared/${owner.id}/info`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(200);
  });

  it('IMMICH-054 — GET /assets/thumbnail for own photo streams image data', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');
    addTripPhoto(testDb, trip.id, user.id, 'asset-thumb', 'immich', { shared: false });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-thumb/${user.id}/thumbnail`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.body).toBeDefined();
  });

  it('IMMICH-055 — GET /assets/thumbnail for other\'s unshared photo returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    addTripPhoto(testDb, trip.id, owner.id, 'asset-noshare', 'immich', { shared: false });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-noshare/${owner.id}/thumbnail`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(403);
  });

  it('IMMICH-056 — GET /assets/original for shared photo streams image data', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    setImmichCredentials(testDb, owner.id, 'https://immich.example.com', 'test-api-key');
    addTripPhoto(testDb, trip.id, owner.id, 'asset-orig', 'immich', { shared: true });

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-orig/${owner.id}/original`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/');
  });

  it('IMMICH-057 — GET /assets/info where trip does not exist returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    // Insert a shared photo referencing a trip that doesn't exist (FK disabled temporarily)
    testDb.exec('PRAGMA foreign_keys = OFF');
    testDb.prepare('INSERT OR IGNORE INTO trek_photos (provider, asset_id, owner_id) VALUES (?, ?, ?)').run('immich', 'asset-notrip', owner.id);
    const tkpNotrip = testDb.prepare('SELECT id FROM trek_photos WHERE provider = ? AND asset_id = ? AND owner_id = ?').get('immich', 'asset-notrip', owner.id) as any;
    testDb.prepare(
      'INSERT INTO trip_photos (trip_id, user_id, photo_id, shared) VALUES (?, ?, ?, ?)'
    ).run(9999, owner.id, tkpNotrip.id, 1);
    testDb.exec('PRAGMA foreign_keys = ON');

    const res = await request(app)
      .get(`${IMMICH}/assets/9999/asset-notrip/${owner.id}/info`)
      .set('Cookie', authCookie(member.id));

    // canAccessUserPhoto: shared photo found, but canAccessTrip(9999) → null → false → 403
    expect(res.status).toBe(403);
  });

  it('IMMICH-058 — GET /assets/info when upstream returns error propagates status', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');
    addTripPhoto(testDb, trip.id, user.id, 'asset-upstream-err', 'immich', { shared: false });

    vi.mocked(safeFetch).mockResolvedValueOnce({
      ok: false, status: 503,
      headers: { get: () => null } as any,
      json: async () => ({}),
    } as any);

    const res = await request(app)
      .get(`${IMMICH}/assets/${trip.id}/asset-upstream-err/${user.id}/info`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(503);
    expect(res.body.error).toBeDefined();
  });
});

// ── Albums ────────────────────────────────────────────────────────────────────

describe('Immich albums', () => {
  it('IMMICH-060 — GET /albums when not configured returns 400', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get(`${IMMICH}/albums`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(400);
  });

  it('IMMICH-061 — GET /albums returns album list', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    const res = await request(app)
      .get(`${IMMICH}/albums`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.albums)).toBe(true);
    expect(res.body.albums[0]).toMatchObject({ id: 'album-uuid-1', albumName: 'Vacation 2024' });
  });
});

// ── Auth checks ───────────────────────────────────────────────────────────────

describe('Immich auth checks', () => {
  it('IMMICH-070 — GET /status without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/status`)).status).toBe(401);
  });

  it('IMMICH-070 — POST /test without auth returns 401', async () => {
    expect((await request(app).post(`${IMMICH}/test`)).status).toBe(401);
  });

  it('IMMICH-070 — GET /browse without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/browse`)).status).toBe(401);
  });

  it('IMMICH-070 — POST /search without auth returns 401', async () => {
    expect((await request(app).post(`${IMMICH}/search`)).status).toBe(401);
  });

  it('IMMICH-070 — GET /albums without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/albums`)).status).toBe(401);
  });

  it('IMMICH-070 — GET /assets/info without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/assets/1/asset-x/1/info`)).status).toBe(401);
  });

  it('IMMICH-070 — GET /assets/thumbnail without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/assets/1/asset-x/1/thumbnail`)).status).toBe(401);
  });

  it('IMMICH-070 — GET /assets/original without auth returns 401', async () => {
    expect((await request(app).get(`${IMMICH}/assets/1/asset-x/1/original`)).status).toBe(401);
  });
});

// ── Album sync ────────────────────────────────────────────────────────────────

describe('Immich syncAlbumAssets', () => {
  it('IMMICH-080 — POST sync happy path: trip owner with album link saves photos to DB', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');
    const link = addAlbumLink(testDb, trip.id, user.id, 'immich', 'album-uuid-1', 'Vacation 2024');

    const res = await request(app)
      .post(`${IMMICH}/trips/${trip.id}/album-links/${link.id}/sync`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.added).toBe('number');

    // Verify photos were inserted into the DB
    const photos = testDb.prepare(`
      SELECT tp.*, tkp.provider FROM trip_photos tp
      JOIN trek_photos tkp ON tkp.id = tp.photo_id
      WHERE tp.trip_id = ? AND tp.user_id = ?
    `).all(trip.id, user.id) as any[];
    expect(photos.length).toBeGreaterThan(0);
    expect(photos[0].provider).toBe('immich');
  });

  it('IMMICH-081 — POST sync when user is not a trip member returns 404', async () => {
    const { user: owner } = createUser(testDb);
    const { user: outsider } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    setImmichCredentials(testDb, owner.id, 'https://immich.example.com', 'test-api-key');
    const link = addAlbumLink(testDb, trip.id, owner.id, 'immich', 'album-uuid-1', 'Vacation 2024');

    // outsider is not a trip member — getAlbumIdFromLink checks canAccessTrip
    const res = await request(app)
      .post(`${IMMICH}/trips/${trip.id}/album-links/${link.id}/sync`)
      .set('Cookie', authCookie(outsider.id));

    expect(res.status).toBe(404);
  });

  it('IMMICH-082 — POST sync when Immich is not configured returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // No Immich credentials set — but still need a valid album link owned by user
    const link = addAlbumLink(testDb, trip.id, user.id, 'immich', 'album-uuid-1', 'Vacation 2024');

    const res = await request(app)
      .post(`${IMMICH}/trips/${trip.id}/album-links/${link.id}/sync`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('IMMICH-083 — POST sync when safeFetch throws returns 502', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');
    const link = addAlbumLink(testDb, trip.id, user.id, 'immich', 'album-uuid-1', 'Vacation 2024');

    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('network failure during sync'));

    const res = await request(app)
      .post(`${IMMICH}/trips/${trip.id}/album-links/${link.id}/sync`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });

  it('IMMICH-084 — POST sync when album link does not belong to requesting user returns 404', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    setImmichCredentials(testDb, member.id, 'https://immich.example.com', 'test-api-key');
    // Album link is owned by owner, not member
    const link = addAlbumLink(testDb, trip.id, owner.id, 'immich', 'album-uuid-1', 'Vacation 2024');

    // member is a trip member but the album link belongs to owner — getAlbumIdFromLink checks user_id
    const res = await request(app)
      .post(`${IMMICH}/trips/${trip.id}/album-links/${link.id}/sync`)
      .set('Cookie', authCookie(member.id));

    expect(res.status).toBe(404);
  });

  it('IMMICH-085 — POST sync without auth returns 401', async () => {
    expect((await request(app).post(`${IMMICH}/trips/1/album-links/1/sync`)).status).toBe(401);
  });
});

// ── searchPhotos pagination safety ────────────────────────────────────────────

describe('Immich searchPhotos pagination pass-through', () => {
  it('IMMICH-090 — POST /search proxies client page param and returns hasMore', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    // Return a full page so hasMore=true (items.length >= size)
    const fullPageResponse = {
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({
        assets: {
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `asset-p2-${i}`,
            fileCreatedAt: '2024-06-01T10:00:00.000Z',
            exifInfo: { city: 'Berlin', country: 'Germany' },
          })),
        },
      }),
      body: null,
    } as any;

    vi.mocked(safeFetch).mockClear();
    vi.mocked(safeFetch).mockResolvedValue(fullPageResponse);

    const res = await request(app)
      .post(`${IMMICH}/search`)
      .set('Cookie', authCookie(user.id))
      .send({ page: 2, size: 50 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    // Single page returned — not 20× aggregation
    expect(res.body.assets.length).toBe(50);
    expect(res.body.hasMore).toBe(true);
    // Immich was called exactly once
    expect(vi.mocked(safeFetch)).toHaveBeenCalledTimes(1);
    // page=2 was forwarded to Immich
    const callBody = JSON.parse(vi.mocked(safeFetch).mock.calls[0][1]!.body as string);
    expect(callBody.page).toBe(2);
  });

  it('IMMICH-091 — POST /search returns hasMore=false on last page', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'test-api-key');

    // Partial page → hasMore=false
    const partialPageResponse = {
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({
        assets: {
          items: Array.from({ length: 3 }, (_, i) => ({
            id: `asset-last-${i}`,
            fileCreatedAt: '2024-06-01T10:00:00.000Z',
            exifInfo: { city: 'Rome', country: 'Italy' },
          })),
        },
      }),
      body: null,
    } as any;

    vi.mocked(safeFetch).mockResolvedValue(partialPageResponse);

    const res = await request(app)
      .post(`${IMMICH}/search`)
      .set('Cookie', authCookie(user.id))
      .send({ page: 5, size: 50 });

    expect(res.status).toBe(200);
    expect(res.body.assets.length).toBe(3);
    expect(res.body.hasMore).toBe(false);
  });
});

// ── saveImmichSettings clearing credentials ───────────────────────────────────

describe('Immich saveImmichSettings clearing URL', () => {
  it('IMMICH-095 — PUT /settings with no URL clears immich_url but preserves (updates) api key', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'old-key');

    // Send without immich_url to trigger the else branch (clear URL path)
    const res = await request(app)
      .put(`${IMMICH}/settings`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_api_key: 'new-key' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = testDb.prepare('SELECT immich_url FROM users WHERE id = ?').get(user.id) as any;
    expect(row.immich_url).toBeNull();
  });

  it('IMMICH-096 — PUT /settings with empty string URL clears immich_url', async () => {
    const { user } = createUser(testDb);
    setImmichCredentials(testDb, user.id, 'https://immich.example.com', 'old-key');

    const res = await request(app)
      .put(`${IMMICH}/settings`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_url: '', immich_api_key: 'old-key' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = testDb.prepare('SELECT immich_url FROM users WHERE id = ?').get(user.id) as any;
    expect(row.immich_url).toBeNull();
  });
});

// ── testConnection canonical URL detection ────────────────────────────────────

describe('Immich testConnection canonical URL detection', () => {
  it('IMMICH-100 — POST /test with http URL that gets upgraded to https returns canonicalUrl', async () => {
    const { user } = createUser(testDb);

    // Mock safeFetch so the response.url reflects https upgrade
    vi.mocked(safeFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://immich.example.com/api/users/me',
      headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null } as any,
      json: async () => ({ name: 'Redirect User', email: 'redirect@immich.local' }),
      body: null,
    } as any);

    const res = await request(app)
      .post(`${IMMICH}/test`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_url: 'http://immich.example.com', immich_api_key: 'valid-key' });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.canonicalUrl).toBe('https://immich.example.com');
  });

  it('IMMICH-101 — POST /test with https URL that stays https does not return canonicalUrl', async () => {
    const { user } = createUser(testDb);

    // The default mock returns a response without .url property — no upgrade
    const res = await request(app)
      .post(`${IMMICH}/test`)
      .set('Cookie', authCookie(user.id))
      .send({ immich_url: 'https://immich.example.com', immich_api_key: 'valid-key' });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.canonicalUrl).toBeUndefined();
  });
});
