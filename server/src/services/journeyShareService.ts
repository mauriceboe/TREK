import { db } from '../db/database';
import crypto from 'crypto';

interface JourneySharePermissions {
  share_timeline?: boolean;
  share_gallery?: boolean;
  share_map?: boolean;
}

interface JourneyShareTokenInfo {
  token: string;
  created_at: string;
  share_timeline: boolean;
  share_gallery: boolean;
  share_map: boolean;
}

export function createOrUpdateJourneyShareLink(
  journeyId: number,
  createdBy: number,
  permissions: JourneySharePermissions
): { token: string; created: boolean } {
  const {
    share_timeline = true,
    share_gallery = true,
    share_map = true,
  } = permissions;

  const existing = db.prepare('SELECT token FROM journey_share_tokens WHERE journey_id = ?').get(journeyId) as { token: string } | undefined;
  if (existing) {
    db.prepare('UPDATE journey_share_tokens SET share_timeline = ?, share_gallery = ?, share_map = ? WHERE journey_id = ?')
      .run(share_timeline ? 1 : 0, share_gallery ? 1 : 0, share_map ? 1 : 0, journeyId);
    return { token: existing.token, created: false };
  }

  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO journey_share_tokens (journey_id, token, created_by, share_timeline, share_gallery, share_map) VALUES (?, ?, ?, ?, ?, ?)')
    .run(journeyId, token, createdBy, share_timeline ? 1 : 0, share_gallery ? 1 : 0, share_map ? 1 : 0);
  return { token, created: true };
}

export function getJourneyShareLink(journeyId: number): JourneyShareTokenInfo | null {
  const row = db.prepare('SELECT * FROM journey_share_tokens WHERE journey_id = ?').get(journeyId) as any;
  if (!row) return null;
  return {
    token: row.token,
    created_at: row.created_at,
    share_timeline: !!row.share_timeline,
    share_gallery: !!row.share_gallery,
    share_map: !!row.share_map,
  };
}

export function deleteJourneyShareLink(journeyId: number): void {
  db.prepare('DELETE FROM journey_share_tokens WHERE journey_id = ?').run(journeyId);
}

export function validateShareTokenForPhoto(token: string, photoId: number): { journeyId: number; ownerId: number } | null {
  const row = db.prepare('SELECT journey_id FROM journey_share_tokens WHERE token = ?').get(token) as any;
  if (!row) return null;
  const photo = db.prepare(`
    SELECT jp.photo_id, tkp.owner_id, je.journey_id
    FROM journey_photos jp
    JOIN trek_photos tkp ON tkp.id = jp.photo_id
    JOIN journey_entries je ON jp.entry_id = je.id
    WHERE jp.photo_id = ? AND je.journey_id = ?
  `).get(photoId, row.journey_id) as any;
  if (!photo) return null;
  const journey = db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(row.journey_id) as any;
  return journey ? { journeyId: row.journey_id, ownerId: photo.owner_id || journey.user_id } : null;
}

export function validateShareTokenForAsset(token: string, assetId: string): { ownerId: number } | null {
  const row = db.prepare('SELECT journey_id FROM journey_share_tokens WHERE token = ?').get(token) as any;
  if (!row) return null;
  const photo = db.prepare(`
    SELECT tkp.owner_id FROM journey_photos jp
    JOIN trek_photos tkp ON tkp.id = jp.photo_id
    JOIN journey_entries je ON jp.entry_id = je.id
    WHERE tkp.asset_id = ? AND je.journey_id = ?
  `).get(assetId, row.journey_id) as any;
  if (!photo) {
    const journey = db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(row.journey_id) as any;
    return journey ? { ownerId: journey.user_id } : null;
  }
  return { ownerId: photo.owner_id };
}

export function getPublicJourney(token: string) {
  const row = db.prepare('SELECT * FROM journey_share_tokens WHERE token = ?').get(token) as any;
  if (!row) return null;

  const journey = db.prepare('SELECT * FROM journeys WHERE id = ?').get(row.journey_id) as any;
  if (!journey) return null;

  // Entries with photos
  const entries = db.prepare(`
    SELECT je.* FROM journey_entries je
    WHERE je.journey_id = ? AND je.type != 'skeleton'
    ORDER BY je.entry_date, je.sort_order
  `).all(row.journey_id) as any[];

  const photos = db.prepare(`
    SELECT jp.id, jp.entry_id, jp.photo_id, jp.caption, jp.sort_order, jp.shared, jp.created_at,
           tkp.provider, tkp.asset_id, tkp.owner_id, tkp.file_path, tkp.thumbnail_path, tkp.width, tkp.height
    FROM journey_photos jp
    JOIN trek_photos tkp ON tkp.id = jp.photo_id
    JOIN journey_entries je ON jp.entry_id = je.id
    WHERE je.journey_id = ?
    ORDER BY jp.sort_order
  `).all(row.journey_id) as any[];

  const photosByEntry: Record<number, any[]> = {};
  for (const p of photos) {
    (photosByEntry[p.entry_id] ||= []).push(p);
  }

  const enrichedEntries = entries
    .filter(e => {
      // hide empty Gallery entries (no photos, no story)
      if (e.title === 'Gallery' && !e.story && !(photosByEntry[e.id]?.length)) return false;
      return true;
    })
    .map(e => ({
      ...e,
      tags: e.tags ? JSON.parse(e.tags) : [],
      pros_cons: e.pros_cons ? JSON.parse(e.pros_cons) : null,
      photos: photosByEntry[e.id] || [],
    }));

  // Stats
  const stats = {
    entries: entries.length,
    photos: photos.length,
    cities: new Set(entries.filter(e => e.location_name).map(e => e.location_name)).size,
  };

  return {
    journey: {
      title: journey.title,
      subtitle: journey.subtitle,
      cover_image: journey.cover_image,
      status: journey.status,
    },
    entries: enrichedEntries,
    stats,
    permissions: {
      share_timeline: !!row.share_timeline,
      share_gallery: !!row.share_gallery,
      share_map: !!row.share_map,
    },
  };
}
