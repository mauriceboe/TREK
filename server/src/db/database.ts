import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createTables } from './schema';
import { runMigrations } from './migrations';
import { runSeeds } from './seeds';
import { Place, Tag } from '../types';

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'travel.db');

let _db: Database.Database | null = null;

function initDb(): void {
  if (_db) {
    try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { _db.close(); } catch (e) {}
    _db = null;
  }

  _db = new Database(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec('PRAGMA foreign_keys = ON');

  createTables(_db);
  runMigrations(_db);

  runSeeds(_db);
}

initDb();

if (process.env.DEMO_MODE === 'true') {
  try {
    const { seedDemoData } = require('../demo/demo-seed');
    seedDemoData(_db);
  } catch (err: unknown) {
    console.error('[Demo] Seed error:', err instanceof Error ? err.message : err);
  }
}

const db = new Proxy({} as Database.Database, {
  get(_, prop: string | symbol) {
    if (!_db) throw new Error('Database connection is not available (restore in progress?)');
    const val = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  },
  set(_, prop: string | symbol, val: unknown) {
    (_db as unknown as Record<string | symbol, unknown>)[prop] = val;
    return true;
  },
});

function closeDb(): void {
  if (_db) {
    try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { _db.close(); } catch (e) {}
    _db = null;
    console.log('[DB] Database connection closed');
  }
}

function reinitialize(): void {
  console.log('[DB] Reinitializing database connection after restore...');
  if (_db) closeDb();
  initDb();
  console.log('[DB] Database reinitialized successfully');
}

interface PlaceWithCategory extends Place {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

interface PlaceWithTags extends Place {
  category: { id: number; name: string; color: string; icon: string } | null;
  tags: Tag[];
}

function getPlaceWithTags(placeId: number | string): PlaceWithTags | null {
  const place = db.prepare(`
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(placeId) as PlaceWithCategory | undefined;

  if (!place) return null;

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `).all(placeId) as Tag[];

  return {
    ...place,
    category: place.category_id ? {
      id: place.category_id,
      name: place.category_name!,
      color: place.category_color!,
      icon: place.category_icon!,
    } : null,
    tags,
  };
}

interface TripAccess {
  id: number;
  user_id: number;
}

function canAccessTrip(tripId: number | string, userId: number): TripAccess | undefined {
  return db.prepare(`
    SELECT t.id, t.user_id FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
  `).get(userId, tripId, userId) as TripAccess | undefined;
}

function isOwner(tripId: number | string, userId: number): boolean {
  return !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

export { db, closeDb, reinitialize, getPlaceWithTags, canAccessTrip, isOwner };
