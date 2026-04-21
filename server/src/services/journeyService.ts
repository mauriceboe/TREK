import { db } from '../db/database';
import { broadcastToUser } from '../websocket';
import type { Journey, JourneyEntry, JourneyPhoto, JourneyContributor } from '../types';
import { getOrCreateTrekPhoto, getOrCreateLocalTrekPhoto, setTrekPhotoProvider, deleteTrekPhotoIfOrphan } from './memories/photoResolverService';

function ts(): number {
  return Date.now();
}

// Joined SELECT for journey_photos + trek_photos — returns fields matching JourneyPhoto interface
const JP_SELECT = `
  jp.id, jp.entry_id, jp.photo_id, jp.caption, jp.sort_order, jp.shared, jp.created_at,
  tkp.provider, tkp.asset_id, tkp.owner_id, tkp.file_path, tkp.thumbnail_path, tkp.width, tkp.height
`;
const JP_JOIN = 'journey_photos jp JOIN trek_photos tkp ON tkp.id = jp.photo_id';

function broadcastJourneyEvent(journeyId: number, event: string, data: Record<string, unknown>, excludeSocketId?: string | number) {
  const contributors = db.prepare(
    'SELECT user_id FROM journey_contributors WHERE journey_id = ?'
  ).all(journeyId) as { user_id: number }[];
  const owner = db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(journeyId) as { user_id: number } | undefined;

  const userIds = new Set(contributors.map(c => c.user_id));
  if (owner) userIds.add(owner.user_id);

  for (const uid of userIds) {
    broadcastToUser(uid, { type: event, journeyId, ...data }, excludeSocketId);
  }
}

// ── Access control ───────────────────────────────────────────────────────

export function canAccessJourney(journeyId: number, userId: number): Journey | null {
  const own = db.prepare('SELECT * FROM journeys WHERE id = ? AND user_id = ?').get(journeyId, userId) as Journey | undefined;
  if (own) return own;
  const contrib = db.prepare(
    'SELECT 1 FROM journey_contributors WHERE journey_id = ? AND user_id = ?'
  ).get(journeyId, userId);
  if (contrib) return db.prepare('SELECT * FROM journeys WHERE id = ?').get(journeyId) as Journey || null;
  return null;
}

export function isOwner(journeyId: number, userId: number): boolean {
  return !!db.prepare('SELECT 1 FROM journeys WHERE id = ? AND user_id = ?').get(journeyId, userId);
}

export function canEdit(journeyId: number, userId: number): boolean {
  if (isOwner(journeyId, userId)) return true;
  const c = db.prepare(
    "SELECT role FROM journey_contributors WHERE journey_id = ? AND user_id = ?"
  ).get(journeyId, userId) as { role: string } | undefined;
  return c?.role === 'editor' || c?.role === 'owner';
}

// ── Journey CRUD ─────────────────────────────────────────────────────────

export function listJourneys(userId: number) {
  return db.prepare(`
    SELECT DISTINCT j.*,
      (SELECT COUNT(*) FROM journey_entries je WHERE je.journey_id = j.id AND je.type != 'skeleton') as entry_count,
      (SELECT COUNT(DISTINCT jp.photo_id) FROM journey_photos jp JOIN journey_entries je2 ON jp.entry_id = je2.id WHERE je2.journey_id = j.id) as photo_count,
      (SELECT COUNT(DISTINCT je3.location_name) FROM journey_entries je3 WHERE je3.journey_id = j.id AND je3.location_name IS NOT NULL AND je3.location_name != '') as place_count,
      (SELECT MIN(t.start_date) FROM journey_trips jt JOIN trips t ON jt.trip_id = t.id WHERE jt.journey_id = j.id) as trip_date_min,
      (SELECT MAX(t.end_date) FROM journey_trips jt JOIN trips t ON jt.trip_id = t.id WHERE jt.journey_id = j.id) as trip_date_max
    FROM journeys j
    LEFT JOIN journey_contributors jc ON j.id = jc.journey_id AND jc.user_id = ?
    WHERE j.user_id = ? OR jc.user_id = ?
    ORDER BY j.updated_at DESC
  `).all(userId, userId, userId) as (Journey & { entry_count: number; photo_count: number; place_count: number; trip_date_min: string | null; trip_date_max: string | null })[];
}

export function createJourney(userId: number, data: {
  title: string;
  subtitle?: string;
  trip_ids?: number[];
}): Journey {
  const now = ts();
  const res = db.prepare(`
    INSERT INTO journeys (user_id, title, subtitle, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(userId, data.title, data.subtitle || null, now, now);

  const journeyId = Number(res.lastInsertRowid);

  // add owner as contributor
  db.prepare(
    'INSERT INTO journey_contributors (journey_id, user_id, role, added_at) VALUES (?, ?, ?, ?)'
  ).run(journeyId, userId, 'owner', now);

  // link trips and sync skeleton entries
  if (data.trip_ids?.length) {
    for (const tripId of data.trip_ids) {
      addTripToJourney(journeyId, tripId, userId);
    }

    // inherit cover image from first selected trip
    const firstTrip = db.prepare('SELECT cover_image FROM trips WHERE id = ?').get(data.trip_ids[0]) as { cover_image: string | null } | undefined;
    if (firstTrip?.cover_image) {
      // trip stores full path (/uploads/covers/x.jpg), journey stores relative (covers/x.jpg)
      const relativePath = firstTrip.cover_image.replace(/^\/uploads\//, '');
      db.prepare('UPDATE journeys SET cover_image = ? WHERE id = ?').run(relativePath, journeyId);
    }
  }

  return db.prepare('SELECT * FROM journeys WHERE id = ?').get(journeyId) as Journey;
}

export function getJourneyFull(journeyId: number, userId: number) {
  const journey = canAccessJourney(journeyId, userId);
  if (!journey) return null;

  const entries = db.prepare(
    'SELECT * FROM journey_entries WHERE journey_id = ? ORDER BY entry_date ASC, entry_time ASC, sort_order ASC'
  ).all(journeyId) as JourneyEntry[];

  const photos = db.prepare(
    `SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.entry_id IN (SELECT id FROM journey_entries WHERE journey_id = ?) ORDER BY jp.sort_order ASC`
  ).all(journeyId) as JourneyPhoto[];

  // group photos by entry
  const photosByEntry: Record<number, JourneyPhoto[]> = {};
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
      source_trip_name: e.source_trip_id
        ? (db.prepare('SELECT title FROM trips WHERE id = ?').get(e.source_trip_id) as { title: string } | undefined)?.title || null
        : null,
    }));

  // linked trips
  const trips = db.prepare(`
    SELECT jt.trip_id, jt.added_at, t.title, t.start_date, t.end_date, t.cover_image, t.currency,
      (SELECT COUNT(*) FROM places WHERE trip_id = t.id) as place_count
    FROM journey_trips jt JOIN trips t ON jt.trip_id = t.id
    WHERE jt.journey_id = ? ORDER BY t.start_date ASC
  `).all(journeyId);

  // contributors
  const contributorsRaw = db.prepare(`
    SELECT jc.journey_id, jc.user_id, jc.role, jc.added_at, u.username, u.avatar
    FROM journey_contributors jc JOIN users u ON jc.user_id = u.id
    WHERE jc.journey_id = ? ORDER BY jc.added_at
  `).all(journeyId) as any[];
  const contributors = contributorsRaw.map(c => ({
    ...c,
    avatar_url: c.avatar ? `/uploads/avatars/${c.avatar}` : null,
  }));

  // stats
  const entryCount = entries.filter(e => e.type === 'entry').length;
  const photoCount = new Set(photos.map(p => p.photo_id)).size;
  const places = [...new Set(entries.map(e => e.location_name).filter(Boolean))];

  const userPrefs = db.prepare(
    'SELECT hide_skeletons FROM journey_contributors WHERE journey_id = ? AND user_id = ?'
  ).get(journeyId, userId) as { hide_skeletons: number } | undefined;

  // Determine the viewer's role on this journey so the UI can gate edit/settings
  // actions. 'owner' = creator, 'editor' | 'viewer' = from journey_contributors.
  const journeyRow = journey as unknown as { user_id?: number };
  let myRole: 'owner' | 'editor' | 'viewer' | null = null;
  if (journeyRow.user_id === userId) {
    myRole = 'owner';
  } else {
    const contribRow = db.prepare(
      'SELECT role FROM journey_contributors WHERE journey_id = ? AND user_id = ?'
    ).get(journeyId, userId) as { role: 'editor' | 'viewer' } | undefined;
    myRole = contribRow?.role ?? null;
  }

  return {
    ...journey,
    entries: enrichedEntries,
    trips,
    contributors,
    stats: { entries: entryCount, photos: photoCount, places: places.length },
    hide_skeletons: !!(userPrefs?.hide_skeletons),
    my_role: myRole,
  };
}

export function updateJourney(journeyId: number, userId: number, data: Partial<{
  title: string;
  subtitle: string;
  cover_gradient: string;
  cover_image: string;
  status: string;
}>): Journey | null {
  // Journey-level settings (title, cover, status) are owner-only — editors
  // may only edit entries and photos, not reshape the journey itself.
  if (!isOwner(journeyId, userId)) return null;

  const ALLOWED_STATUSES = ['draft', 'active', 'completed', 'archived'];
  const allowed = ['title', 'subtitle', 'cover_gradient', 'cover_image', 'status'];
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && allowed.includes(key)) {
      if (key === 'status' && !ALLOWED_STATUSES.includes(val as string)) continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return db.prepare('SELECT * FROM journeys WHERE id = ?').get(journeyId) as Journey;

  fields.push('updated_at = ?');
  values.push(ts());
  values.push(journeyId);
  db.prepare(`UPDATE journeys SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM journeys WHERE id = ?').get(journeyId) as Journey;
}

export function updateJourneyPreferences(journeyId: number, userId: number, data: { hide_skeletons?: boolean }) {
  if (!canAccessJourney(journeyId, userId)) return null;
  if (data.hide_skeletons !== undefined) {
    db.prepare(
      'UPDATE journey_contributors SET hide_skeletons = ? WHERE journey_id = ? AND user_id = ?'
    ).run(data.hide_skeletons ? 1 : 0, journeyId, userId);
  }
  const row = db.prepare(
    'SELECT hide_skeletons FROM journey_contributors WHERE journey_id = ? AND user_id = ?'
  ).get(journeyId, userId) as { hide_skeletons: number };
  return { hide_skeletons: !!row.hide_skeletons };
}

export function deleteJourney(journeyId: number, userId: number): boolean {
  if (!isOwner(journeyId, userId)) return false;
  db.prepare('DELETE FROM journeys WHERE id = ?').run(journeyId);
  return true;
}

// ── Trip management ──────────────────────────────────────────────────────

export function addTripToJourney(journeyId: number, tripId: number, userId: number): boolean {
  const now = ts();
  try {
    db.prepare(
      'INSERT OR IGNORE INTO journey_trips (journey_id, trip_id, added_at) VALUES (?, ?, ?)'
    ).run(journeyId, tripId, now);
  } catch { return false; }

  // sync skeleton entries for all places in this trip
  syncTripPlaces(journeyId, tripId, userId);
  // import existing trip photos (Immich/Synology) with sharing settings
  syncTripPhotos(journeyId, tripId);
  broadcastJourneyEvent(journeyId, 'journey:trip:synced', { tripId });
  return true;
}

export function removeTripFromJourney(journeyId: number, tripId: number, userId: number): boolean {
  if (!isOwner(journeyId, userId)) return false;

  // remove skeleton entries that haven't been filled in
  db.prepare(`
    DELETE FROM journey_entries
    WHERE journey_id = ? AND source_trip_id = ? AND type = 'skeleton'
  `).run(journeyId, tripId);

  // detach filled entries from this trip
  db.prepare(`
    UPDATE journey_entries SET source_trip_id = NULL, source_place_id = NULL
    WHERE journey_id = ? AND source_trip_id = ? AND type != 'skeleton'
  `).run(journeyId, tripId);

  db.prepare('DELETE FROM journey_trips WHERE journey_id = ? AND trip_id = ?').run(journeyId, tripId);
  return true;
}

// ── Sync engine ──────────────────────────────────────────────────────────

export function syncTripPlaces(journeyId: number, tripId: number, authorId: number) {
  const places = db.prepare(`
    SELECT p.*, da.day_id, d.date as day_date, da.assignment_time, da.assignment_end_time, d.day_number
    FROM places p
    INNER JOIN day_assignments da ON da.place_id = p.id
    INNER JOIN days d ON da.day_id = d.id
    WHERE p.trip_id = ?
    ORDER BY d.day_number ASC, da.order_index ASC
  `).all(tripId) as any[];

  const now = ts();
  const existing = db.prepare(
    'SELECT source_place_id FROM journey_entries WHERE journey_id = ? AND source_trip_id = ?'
  ).all(journeyId, tripId) as { source_place_id: number }[];
  const existingPlaceIds = new Set(existing.map(e => e.source_place_id));

  for (const place of places) {
    if (existingPlaceIds.has(place.id)) continue;
    existingPlaceIds.add(place.id);

    const entryDate = place.day_date || new Date().toISOString().split('T')[0];
    const entryTime = place.assignment_time || place.place_time || null;

    db.prepare(`
      INSERT INTO journey_entries (journey_id, source_trip_id, source_place_id, author_id, type, title, entry_date, entry_time, location_name, location_lat, location_lng, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'skeleton', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      journeyId, tripId, place.id, authorId,
      place.name, entryDate, entryTime,
      place.address || place.name, place.lat || null, place.lng || null,
      place.day_number || 0, now, now
    );
  }
}

// import trip_photos into journey when a trip is linked
function syncTripPhotos(journeyId: number, tripId: number) {
  const tripPhotos = db.prepare(
    'SELECT tp.photo_id, tp.user_id, tp.shared FROM trip_photos tp WHERE tp.trip_id = ?'
  ).all(tripId) as { photo_id: number; user_id: number; shared: number }[];
  if (!tripPhotos.length) return;

  const now = ts();

  // find or create a "Photos" entry for this trip's photos
  let photoEntry = db.prepare(`
    SELECT id FROM journey_entries
    WHERE journey_id = ? AND source_trip_id = ? AND title = '[Trip Photos]' AND type = 'entry'
  `).get(journeyId, tripId) as { id: number } | undefined;

  if (!photoEntry) {
    const trip = db.prepare('SELECT start_date FROM trips WHERE id = ?').get(tripId) as { start_date: string } | undefined;
    const entryDate = trip?.start_date || new Date().toISOString().split('T')[0];
    const owner = db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(journeyId) as { user_id: number };

    const res = db.prepare(`
      INSERT INTO journey_entries (journey_id, source_trip_id, author_id, type, title, entry_date, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 'entry', '[Trip Photos]', ?, 999, ?, ?)
    `).run(journeyId, tripId, owner.user_id, entryDate, now, now);
    photoEntry = { id: Number(res.lastInsertRowid) };
  }

  // import each trip photo, skip duplicates (by photo_id)
  for (const tp of tripPhotos) {
    const exists = db.prepare(
      'SELECT 1 FROM journey_photos WHERE entry_id = ? AND photo_id = ?'
    ).get(photoEntry.id, tp.photo_id);
    if (exists) continue;

    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM journey_photos WHERE entry_id = ?').get(photoEntry.id) as { m: number | null };

    db.prepare(`
      INSERT INTO journey_photos (entry_id, photo_id, shared, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(photoEntry.id, tp.photo_id, tp.shared, (maxOrder?.m ?? -1) + 1, now);
  }
}

// called when a trip place is created
export function onPlaceCreated(tripId: number, placeId: number) {
  const links = db.prepare('SELECT journey_id FROM journey_trips WHERE trip_id = ?').all(tripId) as { journey_id: number }[];
  if (!links.length) return;

  const place = db.prepare(`
    SELECT p.*, da.day_id, d.date as day_date, da.assignment_time, d.day_number
    FROM places p
    INNER JOIN day_assignments da ON da.place_id = p.id
    INNER JOIN days d ON da.day_id = d.id
    WHERE p.id = ?
  `).get(placeId) as any;
  if (!place) return; // not assigned to a day yet — skip

  const now = ts();
  for (const link of links) {
    const already = db.prepare(
      'SELECT 1 FROM journey_entries WHERE journey_id = ? AND source_place_id = ?'
    ).get(link.journey_id, placeId);
    if (already) continue;

    const journey = db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(link.journey_id) as { user_id: number };
    const entryDate = place.day_date;

    db.prepare(`
      INSERT INTO journey_entries (journey_id, source_trip_id, source_place_id, author_id, type, title, entry_date, entry_time, location_name, location_lat, location_lng, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'skeleton', ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      link.journey_id, tripId, placeId, journey.user_id,
      place.name, entryDate, place.assignment_time || place.place_time || null,
      place.address || place.name, place.lat || null, place.lng || null,
      now, now
    );
  }
}

// called when a trip place is updated
export function onPlaceUpdated(placeId: number) {
  const entries = db.prepare(
    'SELECT * FROM journey_entries WHERE source_place_id = ?'
  ).all(placeId) as JourneyEntry[];
  if (!entries.length) return;

  const place = db.prepare(`
    SELECT p.*, da.day_id, d.date as day_date, da.assignment_time, d.day_number
    FROM places p
    LEFT JOIN day_assignments da ON da.place_id = p.id
    LEFT JOIN days d ON da.day_id = d.id
    WHERE p.id = ?
  `).get(placeId) as any;
  if (!place) return;

  const now = ts();
  for (const entry of entries) {
    if (entry.type === 'skeleton') {
      // update everything on skeletons
      db.prepare(`
        UPDATE journey_entries SET title = ?, entry_date = ?, entry_time = ?, location_name = ?, location_lat = ?, location_lng = ?, updated_at = ?
        WHERE id = ?
      `).run(
        place.name,
        place.day_date || entry.entry_date,
        place.assignment_time || place.place_time || entry.entry_time,
        place.address || place.name,
        place.lat || null, place.lng || null,
        now, entry.id
      );
    } else {
      // for filled entries, only update location silently
      db.prepare(`
        UPDATE journey_entries SET location_name = ?, location_lat = ?, location_lng = ?, updated_at = ?
        WHERE id = ?
      `).run(place.address || place.name, place.lat || null, place.lng || null, now, entry.id);
    }
  }
}

// called when a trip place is deleted
export function onPlaceDeleted(placeId: number) {
  const entries = db.prepare(
    'SELECT * FROM journey_entries WHERE source_place_id = ?'
  ).all(placeId) as JourneyEntry[];

  for (const entry of entries) {
    if (entry.type === 'skeleton') {
      // no content: just delete
      const hasPhotos = db.prepare('SELECT 1 FROM journey_photos WHERE entry_id = ?').get(entry.id);
      if (!hasPhotos && !entry.story) {
        db.prepare('DELETE FROM journey_entries WHERE id = ?').run(entry.id);
        continue;
      }
    }
    // entry has content: keep it, detach, add note
    const note = '\n\n> _Note: the original trip place was removed from the trip plan_';
    const newStory = (entry.story || '') + note;
    db.prepare(
      'UPDATE journey_entries SET source_place_id = NULL, source_trip_id = NULL, type = ?, story = ?, updated_at = ? WHERE id = ?'
    ).run(entry.type === 'skeleton' ? 'entry' : entry.type, newStory, ts(), entry.id);
  }
}

// ── Entries ──────────────────────────────────────────────────────────────

export function listEntries(journeyId: number, userId: number) {
  if (!canAccessJourney(journeyId, userId)) return null;

  const entries = db.prepare(
    'SELECT * FROM journey_entries WHERE journey_id = ? ORDER BY entry_date ASC, entry_time ASC, sort_order ASC'
  ).all(journeyId) as JourneyEntry[];

  const photos = db.prepare(
    `SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.entry_id IN (SELECT id FROM journey_entries WHERE journey_id = ?) ORDER BY jp.sort_order ASC`
  ).all(journeyId) as JourneyPhoto[];

  const photosByEntry: Record<number, JourneyPhoto[]> = {};
  for (const p of photos) {
    (photosByEntry[p.entry_id] ||= []).push(p);
  }

  return entries.map(e => ({
    ...e,
    tags: e.tags ? JSON.parse(e.tags) : [],
    pros_cons: e.pros_cons ? JSON.parse(e.pros_cons) : null,
    photos: photosByEntry[e.id] || [],
    source_trip_name: e.source_trip_id
      ? (db.prepare('SELECT title FROM trips WHERE id = ?').get(e.source_trip_id) as { title: string } | undefined)?.title || null
      : null,
  }));
}

export function createEntry(journeyId: number, userId: number, data: {
  type?: string;
  title?: string;
  story?: string;
  entry_date: string;
  entry_time?: string;
  location_name?: string;
  location_lat?: number;
  location_lng?: number;
  mood?: string;
  weather?: string;
  tags?: string[];
  pros_cons?: { pros: string[]; cons: string[] };
  visibility?: string;
}, sid?: string): JourneyEntry | null {
  if (!canEdit(journeyId, userId)) return null;

  const now = ts();
  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as m FROM journey_entries WHERE journey_id = ? AND entry_date = ?'
  ).get(journeyId, data.entry_date) as { m: number | null };

  const prosConsJson = data.pros_cons && (data.pros_cons.pros.length || data.pros_cons.cons.length)
    ? JSON.stringify(data.pros_cons) : null;

  const res = db.prepare(`
    INSERT INTO journey_entries (journey_id, author_id, type, title, story, entry_date, entry_time, location_name, location_lat, location_lng, mood, weather, tags, pros_cons, visibility, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    journeyId, userId,
    data.type || 'entry',
    data.title || null,
    data.story || null,
    data.entry_date,
    data.entry_time || null,
    data.location_name || null,
    data.location_lat ?? null,
    data.location_lng ?? null,
    data.mood || null,
    data.weather || null,
    data.tags?.length ? JSON.stringify(data.tags) : null,
    prosConsJson,
    data.visibility || 'private',
    (maxOrder?.m ?? -1) + 1,
    now, now
  );

  const created = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(Number(res.lastInsertRowid)) as JourneyEntry;
  broadcastJourneyEvent(journeyId, 'journey:entry:created', { entry: created }, sid);
  return created;
}

export function updateEntry(entryId: number, userId: number, data: Partial<{
  type: string;
  title: string;
  story: string;
  entry_date: string;
  entry_time: string;
  location_name: string;
  location_lat: number;
  location_lng: number;
  mood: string;
  weather: string;
  tags: string[];
  pros_cons: { pros: string[]; cons: string[] };
  visibility: string;
  sort_order: number;
}>, sid?: string): JourneyEntry | null {
  const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry | undefined;
  if (!entry) return null;
  if (!canEdit(entry.journey_id, userId)) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    if (key === 'tags') {
      fields.push('tags = ?');
      values.push(Array.isArray(val) ? JSON.stringify(val) : val);
    } else if (key === 'pros_cons') {
      fields.push('pros_cons = ?');
      values.push(val && typeof val === 'object' ? JSON.stringify(val) : val);
    } else {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }

  // if adding story to a skeleton, promote to entry
  if (entry.type === 'skeleton' && data.story && data.story.trim()) {
    fields.push('type = ?');
    values.push('entry');
  }

  if (fields.length === 0) return entry;

  fields.push('updated_at = ?');
  values.push(ts());
  values.push(entryId);
  db.prepare(`UPDATE journey_entries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // touch the journey
  db.prepare('UPDATE journeys SET updated_at = ? WHERE id = ?').run(ts(), entry.journey_id);

  const updated = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry;
  broadcastJourneyEvent(entry.journey_id, 'journey:entry:updated', { entry: updated }, sid);
  return updated;
}

// Reorder entries (typically within a single day). Caller passes the new
// desired order of ids; each entry's sort_order is set to its index in the
// array. Only entries owned by this journey are accepted.
export function reorderEntries(journeyId: number, userId: number, orderedIds: number[], sid?: string): boolean {
  if (!canEdit(journeyId, userId)) return false;
  if (!orderedIds.length) return true;

  const placeholders = orderedIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM journey_entries WHERE id IN (${placeholders}) AND journey_id = ?`)
    .all(...orderedIds, journeyId) as { id: number }[];
  if (rows.length !== orderedIds.length) return false;

  const now = ts();
  const update = db.prepare('UPDATE journey_entries SET sort_order = ?, updated_at = ? WHERE id = ?');
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, now, id));
    db.prepare('UPDATE journeys SET updated_at = ? WHERE id = ?').run(now, journeyId);
  });
  tx();

  broadcastJourneyEvent(journeyId, 'journey:entries:reordered', { orderedIds }, sid);
  return true;
}

export function deleteEntry(entryId: number, userId: number, sid?: string): boolean {
  const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry | undefined;
  if (!entry) return false;
  if (!canEdit(entry.journey_id, userId)) return false;

  // delete photos along with the entry — no more orphan Gallery entries
  db.prepare('DELETE FROM journey_photos WHERE entry_id = ?').run(entryId);

  if (entry.source_trip_id && entry.source_place_id && entry.type !== 'skeleton') {
    // Revert filled entry back to skeleton instead of deleting
    db.prepare(`
      UPDATE journey_entries
      SET type = 'skeleton', story = NULL, mood = NULL, weather = NULL, pros_cons = NULL,
          visibility = 'private', updated_at = ?
      WHERE id = ?
    `).run(ts(), entryId);
    broadcastJourneyEvent(entry.journey_id, 'journey:entry:updated', { entryId }, sid);
  } else {
    db.prepare('DELETE FROM journey_entries WHERE id = ?').run(entryId);
    broadcastJourneyEvent(entry.journey_id, 'journey:entry:deleted', { entryId }, sid);
  }

  // clean up any empty Gallery entries in this journey
  db.prepare(`
    DELETE FROM journey_entries WHERE journey_id = ? AND title = 'Gallery'
    AND id NOT IN (SELECT DISTINCT entry_id FROM journey_photos)
  `).run(entry.journey_id);

  return true;
}

// ── Photos ───────────────────────────────────────────────────────────────

// Promote a skeleton suggestion to a concrete entry. Called whenever the user
// adds content (photo upload, provider photo, gallery link) — a suggestion
// with photos is no longer just a suggestion.
function promoteSkeletonIfNeeded(entry: JourneyEntry): void {
  if (entry.type !== 'skeleton') return;
  db.prepare('UPDATE journey_entries SET type = ?, updated_at = ? WHERE id = ?').run('entry', ts(), entry.id);
}

export function addPhoto(entryId: number, userId: number, filePath: string, thumbnailPath?: string, caption?: string): JourneyPhoto | null {
  const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry | undefined;
  if (!entry) return null;
  if (!canEdit(entry.journey_id, userId)) return null;

  const trekPhotoId = getOrCreateLocalTrekPhoto(filePath, thumbnailPath);
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM journey_photos WHERE entry_id = ?').get(entryId) as { m: number | null };
  const now = ts();

  const res = db.prepare(`
    INSERT INTO journey_photos (entry_id, photo_id, caption, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(entryId, trekPhotoId, caption || null, (maxOrder?.m ?? -1) + 1, now);

  promoteSkeletonIfNeeded(entry);

  return db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(Number(res.lastInsertRowid)) as JourneyPhoto;
}

export function addProviderPhoto(entryId: number, userId: number, provider: string, assetId: string, caption?: string, passphrase?: string): JourneyPhoto | null {
  const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry | undefined;
  if (!entry) return null;
  if (!canEdit(entry.journey_id, userId)) return null;

  const trekPhotoId = getOrCreateTrekPhoto(provider, assetId, userId, passphrase);

  // skip if already added
  const exists = db.prepare('SELECT 1 FROM journey_photos WHERE entry_id = ? AND photo_id = ?').get(entryId, trekPhotoId);
  if (exists) return null;

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM journey_photos WHERE entry_id = ?').get(entryId) as { m: number | null };
  const now = ts();

  const res = db.prepare(`
    INSERT INTO journey_photos (entry_id, photo_id, caption, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(entryId, trekPhotoId, caption || null, (maxOrder?.m ?? -1) + 1, now);

  promoteSkeletonIfNeeded(entry);

  return db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(Number(res.lastInsertRowid)) as JourneyPhoto;
}

export function linkPhotoToEntry(entryId: number, photoId: number, userId: number): JourneyPhoto | null {
  const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(entryId) as JourneyEntry | undefined;
  if (!entry) return null;
  if (!canEdit(entry.journey_id, userId)) return null;

  const source = db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(photoId) as JourneyPhoto | undefined;
  if (!source) return null;

  if (source.entry_id === entryId) return source;

  const oldEntry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(source.entry_id) as JourneyEntry | undefined;
  const sourceIsGallery = oldEntry?.title === 'Gallery';

  // skip if target already has this photo (by trek_photo_id)
  const dupe = db.prepare('SELECT id FROM journey_photos WHERE entry_id = ? AND photo_id = ?').get(entryId, source.photo_id) as { id: number } | undefined;
  if (dupe) return db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(dupe.id) as JourneyPhoto;

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM journey_photos WHERE entry_id = ?').get(entryId) as { m: number | null };
  let resultId: number;

  if (sourceIsGallery) {
    // Copy so the photo stays in the gallery even after being used in an entry.
    const res = db.prepare(`
      INSERT INTO journey_photos (entry_id, photo_id, caption, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entryId, source.photo_id, source.caption || null, (maxOrder?.m ?? -1) + 1, ts());
    resultId = Number(res.lastInsertRowid);
  } else {
    // Non-gallery source: keep existing move behavior.
    db.prepare('UPDATE journey_photos SET entry_id = ? WHERE id = ?').run(entryId, photoId);
    resultId = photoId;
  }

  promoteSkeletonIfNeeded(entry);

  // If we moved out of a Gallery entry (shouldn't happen with the guard above,
  // but kept for any legacy data), clean up the Gallery wrapper if emptied.
  if (!sourceIsGallery && oldEntry && oldEntry.title === 'Gallery') {
    const remaining = db.prepare('SELECT COUNT(*) as c FROM journey_photos WHERE entry_id = ?').get(source.entry_id) as { c: number };
    if (remaining.c === 0) {
      db.prepare('DELETE FROM journey_entries WHERE id = ?').run(source.entry_id);
    }
  }

  return db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(resultId) as JourneyPhoto;
}

export function setPhotoProvider(photoId: number, provider: string, assetId: string, ownerId: number) {
  // Get the trek_photo_id from the journey_photo, then update the central registry
  const jp = db.prepare('SELECT photo_id FROM journey_photos WHERE id = ?').get(photoId) as { photo_id: number } | undefined;
  if (!jp) return;
  setTrekPhotoProvider(jp.photo_id, provider, assetId, ownerId);
}

export function updatePhoto(photoId: number, userId: number, data: { caption?: string; sort_order?: number }): JourneyPhoto | null {
  const photo = db.prepare(`
    SELECT ${JP_SELECT}, je.journey_id FROM ${JP_JOIN}
    JOIN journey_entries je ON jp.entry_id = je.id
    WHERE jp.id = ?
  `).get(photoId) as (JourneyPhoto & { journey_id: number }) | undefined;
  if (!photo) return null;
  if (!canEdit(photo.journey_id, userId)) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.caption !== undefined) { fields.push('caption = ?'); values.push(data.caption); }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order); }
  if (!fields.length) return photo;

  values.push(photoId);
  db.prepare(`UPDATE journey_photos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare(`SELECT ${JP_SELECT} FROM ${JP_JOIN} WHERE jp.id = ?`).get(photoId) as JourneyPhoto;
}

export function deletePhoto(photoId: number, userId: number): (JourneyPhoto & { journey_id: number }) | null {
  const photo = db.prepare(`
    SELECT ${JP_SELECT}, je.journey_id FROM ${JP_JOIN}
    JOIN journey_entries je ON jp.entry_id = je.id
    WHERE jp.id = ?
  `).get(photoId) as (JourneyPhoto & { journey_id: number }) | undefined;
  if (!photo) return null;
  if (!canEdit(photo.journey_id, userId)) return null;

  db.prepare('DELETE FROM journey_photos WHERE id = ?').run(photoId);
  deleteTrekPhotoIfOrphan(photo.photo_id);

  // clean up empty Gallery entries left behind
  const remaining = db.prepare('SELECT 1 FROM journey_photos WHERE entry_id = ?').get(photo.entry_id);
  if (!remaining) {
    const entry = db.prepare('SELECT * FROM journey_entries WHERE id = ?').get(photo.entry_id) as JourneyEntry | undefined;
    if (entry && entry.title === 'Gallery' && !entry.story) {
      db.prepare('DELETE FROM journey_entries WHERE id = ?').run(photo.entry_id);
    }
  }

  return photo;
}

// ── Contributors ─────────────────────────────────────────────────────────

export function addContributor(journeyId: number, userId: number, targetUserId: number, role: 'editor' | 'viewer'): boolean {
  if (!isOwner(journeyId, userId)) return false;
  if (targetUserId === userId) return false;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO journey_contributors (journey_id, user_id, role, added_at) VALUES (?, ?, ?, ?)'
    ).run(journeyId, targetUserId, role, ts());
    broadcastJourneyEvent(journeyId, 'journey:contributor:changed', { targetUserId, role });
    return true;
  } catch { return false; }
}

export function updateContributorRole(journeyId: number, userId: number, targetUserId: number, role: 'editor' | 'viewer'): boolean {
  if (!isOwner(journeyId, userId)) return false;
  db.prepare(
    'UPDATE journey_contributors SET role = ? WHERE journey_id = ? AND user_id = ?'
  ).run(role, journeyId, targetUserId);
  broadcastJourneyEvent(journeyId, 'journey:contributor:changed', { targetUserId, role });
  return true;
}

export function removeContributor(journeyId: number, userId: number, targetUserId: number): boolean {
  if (!isOwner(journeyId, userId)) return false;
  db.prepare(
    "DELETE FROM journey_contributors WHERE journey_id = ? AND user_id = ? AND role != 'owner'"
  ).run(journeyId, targetUserId);
  return true;
}

// ── Suggestions ──────────────────────────────────────────────────────────

export function getSuggestions(userId: number) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return db.prepare(`
    SELECT t.id, t.title, t.start_date, t.end_date, t.cover_image,
      (SELECT COUNT(*) FROM places p INNER JOIN day_assignments da ON da.place_id = p.id WHERE p.trip_id = t.id) as place_count
    FROM trips t
    LEFT JOIN trip_members tm ON t.id = tm.trip_id AND tm.user_id = ?
    WHERE (t.user_id = ? OR tm.user_id = ?)
      AND t.end_date IS NOT NULL
      AND t.end_date >= ?
      AND t.end_date <= date('now')
      AND t.id NOT IN (SELECT trip_id FROM journey_trips)
    ORDER BY t.end_date DESC
  `).all(userId, userId, userId, thirtyDaysAgo);
}

// ── User trips (for trip picker) ─────────────────────────────────────────

export function listUserTrips(userId: number) {
  return db.prepare(`
    SELECT t.id, t.title, t.start_date, t.end_date, t.cover_image,
      (SELECT COUNT(*) FROM places p INNER JOIN day_assignments da ON da.place_id = p.id WHERE p.trip_id = t.id) as place_count
    FROM trips t
    LEFT JOIN trip_members tm ON t.id = tm.trip_id AND tm.user_id = ?
    WHERE t.user_id = ? OR tm.user_id = ?
    ORDER BY t.start_date DESC
  `).all(userId, userId, userId);
}
