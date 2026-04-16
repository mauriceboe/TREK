/**
 * Unit tests for journeyShareService — JOURNEY-SHARE-001 through JOURNEY-SHARE-018.
 * Uses a real in-memory SQLite DB so SQL logic is exercised faithfully.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// -- DB setup -----------------------------------------------------------------

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

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createJourney, createJourneyEntry } from '../../helpers/factories';
import {
  createOrUpdateJourneyShareLink,
  getJourneyShareLink,
  deleteJourneyShareLink,
  validateShareTokenForPhoto,
  validateShareTokenForAsset,
  getPublicJourney,
} from '../../../src/services/journeyShareService';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

// -- Helpers ------------------------------------------------------------------

/** Insert a trek_photos + journey_photos row and return the trek_photos id (used as photoId in public URLs). */
function insertJourneyPhoto(
  entryId: number,
  opts: { filePath?: string; assetId?: string; ownerId?: number } = {}
): number {
  const provider = opts.assetId ? 'immich' : 'local';
  const filePath = !opts.assetId ? (opts.filePath ?? '/photos/test.jpg') : null;
  const trekResult = testDb.prepare(`
    INSERT INTO trek_photos (provider, asset_id, file_path, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider, opts.assetId ?? null, filePath, opts.ownerId ?? null, Date.now());
  const trekId = trekResult.lastInsertRowid as number;
  testDb.prepare(`
    INSERT INTO journey_photos (entry_id, photo_id, caption, sort_order, created_at)
    VALUES (?, ?, NULL, 0, ?)
  `).run(entryId, trekId, Date.now());
  // Return trek_photos.id — this is p.photo_id in the public API response
  // and the value the client sends to /api/public/journey/:token/photos/:photoId/:kind
  return trekId;
}

// -- Tests --------------------------------------------------------------------

describe('createOrUpdateJourneyShareLink', () => {
  it('JOURNEY-SHARE-001: creates a new share link with default permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const result = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    expect(result.created).toBe(true);
    expect(result.token).toBeTruthy();
    expect(result.token.length).toBeGreaterThan(10);
  });

  it('JOURNEY-SHARE-002: creates a share link with custom permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: false,
    });

    const link = getJourneyShareLink(journey.id);
    expect(link).not.toBeNull();
    expect(link!.share_timeline).toBe(true);
    expect(link!.share_gallery).toBe(false);
    expect(link!.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-003: updates permissions on existing link without regenerating token', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const first = createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: true,
      share_map: true,
    });
    const second = createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: false,
    });

    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);

    const link = getJourneyShareLink(journey.id);
    expect(link!.share_gallery).toBe(false);
    expect(link!.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-004: different journeys get different tokens', () => {
    const { user } = createUser(testDb);
    const j1 = createJourney(testDb, user.id);
    const j2 = createJourney(testDb, user.id);

    const r1 = createOrUpdateJourneyShareLink(j1.id, user.id, {});
    const r2 = createOrUpdateJourneyShareLink(j2.id, user.id, {});

    expect(r1.token).not.toBe(r2.token);
  });
});

describe('getJourneyShareLink', () => {
  it('JOURNEY-SHARE-005: returns null when no share link exists', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const result = getJourneyShareLink(journey.id);

    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-006: returns share link info when it exists', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: true,
    });

    const result = getJourneyShareLink(journey.id);

    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.share_timeline).toBe(true);
    expect(result!.share_gallery).toBe(false);
    expect(result!.share_map).toBe(true);
    expect(result!.created_at).toBeTruthy();
  });
});

describe('deleteJourneyShareLink', () => {
  it('JOURNEY-SHARE-007: removes an existing share link', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    createOrUpdateJourneyShareLink(journey.id, user.id, {});

    deleteJourneyShareLink(journey.id);

    expect(getJourneyShareLink(journey.id)).toBeNull();
  });

  it('JOURNEY-SHARE-008: does not throw when deleting non-existent link', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    expect(() => deleteJourneyShareLink(journey.id)).not.toThrow();
  });
});

describe('validateShareTokenForPhoto', () => {
  it('JOURNEY-SHARE-009: returns journeyId and ownerId for valid token + photo', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id);
    const photoId = insertJourneyPhoto(entry.id, { ownerId: user.id });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = validateShareTokenForPhoto(token, photoId);

    expect(result).not.toBeNull();
    expect(result!.journeyId).toBe(journey.id);
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-010: returns null for invalid token', () => {
    const result = validateShareTokenForPhoto('nonexistent-token', 1);
    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-011: returns null when photo does not belong to shared journey', () => {
    const { user } = createUser(testDb);
    const journey1 = createJourney(testDb, user.id);
    const journey2 = createJourney(testDb, user.id);
    const entry2 = createJourneyEntry(testDb, journey2.id, user.id);
    const photoId = insertJourneyPhoto(entry2.id);
    const { token } = createOrUpdateJourneyShareLink(journey1.id, user.id, {});

    const result = validateShareTokenForPhoto(token, photoId);

    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-012: falls back to journey owner_id when photo has no owner_id', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id);
    const photoId = insertJourneyPhoto(entry.id, { ownerId: undefined });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = validateShareTokenForPhoto(token, photoId);

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-016: resolves correctly when trek_photos.id differs from journey_photos.id (Immich bulk-sync scenario)', () => {
    // Simulate a user who has many trek_photos from Immich syncs before adding a journey photo.
    // trek_photos.id will be higher than journey_photos.id — the previous bug matched on jp.id
    // instead of jp.photo_id, causing a 404 for Immich photos in public shares.
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id);

    // Pre-populate trek_photos to push the autoincrement higher
    for (let i = 0; i < 5; i++) {
      testDb.prepare(`INSERT INTO trek_photos (provider, asset_id, owner_id, created_at) VALUES ('immich', ?, ?, ?)`).run(`bulk-asset-${i}`, user.id, Date.now());
    }

    // This trek_photos row gets a high id (e.g. 6) while journey_photos id will be 1
    const trekPhotoId = insertJourneyPhoto(entry.id, { assetId: 'journey-asset-xyz', ownerId: user.id });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    // photoId = trek_photos.id (6), not journey_photos.id (1)
    const result = validateShareTokenForPhoto(token, trekPhotoId);

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
    expect(result!.journeyId).toBe(journey.id);
  });
});

describe('validateShareTokenForAsset', () => {
  it('JOURNEY-SHARE-013: returns ownerId when asset belongs to shared journey', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id);
    insertJourneyPhoto(entry.id, { assetId: 'immich-asset-123', ownerId: user.id });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = validateShareTokenForAsset(token, 'immich-asset-123');

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-014: returns null for invalid token', () => {
    const result = validateShareTokenForAsset('bad-token', 'some-asset');
    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-015: falls back to journey owner when asset not found in photos', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = validateShareTokenForAsset(token, 'nonexistent-asset');

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });
});

describe('getPublicJourney', () => {
  it('JOURNEY-SHARE-016: returns null for invalid token', () => {
    const result = getPublicJourney('invalid-token');
    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-017: returns journey data with entries, stats, and permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id, {
      title: 'Japan 2026',
      subtitle: 'Cherry blossom season',
    });
    const entry1 = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Arrived in Tokyo',
      entry_date: '2026-03-20',
      location_name: 'Tokyo',
    });
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Kyoto Day Trip',
      entry_date: '2026-03-22',
      location_name: 'Kyoto',
    });
    insertJourneyPhoto(entry1.id);
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: true,
      share_map: false,
    });

    const result = getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.journey.title).toBe('Japan 2026');
    expect(result!.journey.subtitle).toBe('Cherry blossom season');
    expect(result!.entries).toHaveLength(2);
    expect(result!.stats.entries).toBe(2);
    expect(result!.stats.photos).toBe(1);
    expect(result!.stats.cities).toBe(2);
    expect(result!.permissions.share_timeline).toBe(true);
    expect(result!.permissions.share_gallery).toBe(true);
    expect(result!.permissions.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-018: excludes skeleton entries from public view', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Visible Entry',
      entry_date: '2026-01-10',
    });
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'skeleton',
      title: 'Skeleton Entry',
      entry_date: '2026-01-11',
    });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].title).toBe('Visible Entry');
  });

  it('JOURNEY-SHARE-019: enriches entries with parsed tags and photos', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      entry_date: '2026-04-01',
    });
    // Set tags on the entry directly
    testDb.prepare('UPDATE journey_entries SET tags = ? WHERE id = ?')
      .run(JSON.stringify(['food', 'culture']), entry.id);
    insertJourneyPhoto(entry.id, { filePath: '/photos/a.jpg' });
    insertJourneyPhoto(entry.id, { filePath: '/photos/b.jpg' });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = getPublicJourney(token);

    expect(result).not.toBeNull();
    const enriched = result!.entries[0];
    expect(enriched.tags).toEqual(['food', 'culture']);
    expect(enriched.photos).toHaveLength(2);
  });

  it('JOURNEY-SHARE-020: returns empty entries array for journey with no entries', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id, { title: 'Empty Journey' });
    const { token } = createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([]);
    expect(result!.stats.entries).toBe(0);
    expect(result!.stats.photos).toBe(0);
    expect(result!.stats.cities).toBe(0);
  });
});
