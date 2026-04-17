import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { db } from '../db/database';

const GOOGLE_PHOTO_DIR = path.join(__dirname, '../../uploads/photos/google');
const ERROR_TTL = 5 * 60 * 1000;

// In-flight dedup — prevents stampedes when multiple requests hit the same uncached placeId simultaneously
const inFlight = new Map<string, Promise<{ filePath: string; attribution: string | null } | null>>();

function ensureDir(): void {
  if (!fs.existsSync(GOOGLE_PHOTO_DIR)) {
    fs.mkdirSync(GOOGLE_PHOTO_DIR, { recursive: true });
  }
}

function filePath(placeId: string): string {
  // Hash to avoid filename collisions — coords:lat:lng pseudo-IDs contain characters that
  // collapse identically under sanitization (e.g. ':' and '.' both → '_')
  const hash = crypto.createHash('sha1').update(placeId).digest('hex');
  return path.join(GOOGLE_PHOTO_DIR, `${hash}.jpg`);
}

function proxyUrl(placeId: string): string {
  return `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`;
}

interface CachedPhoto {
  photoUrl: string;
  filePath: string;
  attribution: string | null;
}

export function get(placeId: string): CachedPhoto | null {
  const row = db.prepare(
    'SELECT attribution FROM google_place_photo_meta WHERE place_id = ? AND error_at IS NULL'
  ).get(placeId) as { attribution: string | null } | undefined;

  if (!row) return null;

  const fp = filePath(placeId);
  if (!fs.existsSync(fp)) {
    // File missing (e.g. volume wiped) — clear row so it refetches
    db.prepare('DELETE FROM google_place_photo_meta WHERE place_id = ?').run(placeId);
    return null;
  }

  return { photoUrl: proxyUrl(placeId), filePath: fp, attribution: row.attribution };
}

export function getErrored(placeId: string): boolean {
  const row = db.prepare(
    'SELECT error_at FROM google_place_photo_meta WHERE place_id = ? AND error_at IS NOT NULL'
  ).get(placeId) as { error_at: number } | undefined;

  if (!row) return false;
  return Date.now() - row.error_at < ERROR_TTL;
}

export function markError(placeId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO google_place_photo_meta (place_id, attribution, fetched_at, error_at) VALUES (?, NULL, ?, ?)'
  ).run(placeId, Date.now(), Date.now());
}

export async function put(placeId: string, bytes: Buffer, attribution: string | null): Promise<CachedPhoto> {
  ensureDir();
  const fp = filePath(placeId);
  const tmp = fp + '.tmp';

  await fsPromises.writeFile(tmp, bytes);
  await fsPromises.rename(tmp, fp);

  db.prepare(
    'INSERT OR REPLACE INTO google_place_photo_meta (place_id, attribution, fetched_at, error_at) VALUES (?, ?, ?, NULL)'
  ).run(placeId, attribution, Date.now());

  return { photoUrl: proxyUrl(placeId), filePath: fp, attribution };
}

export function getInFlight(placeId: string): Promise<{ filePath: string; attribution: string | null } | null> | undefined {
  return inFlight.get(placeId);
}

export function setInFlight(placeId: string, promise: Promise<{ filePath: string; attribution: string | null } | null>): void {
  inFlight.set(placeId, promise);
  promise.finally(() => inFlight.delete(placeId));
}

export function serveFilePath(placeId: string): string | null {
  const fp = filePath(placeId);
  return fs.existsSync(fp) ? fp : null;
}
