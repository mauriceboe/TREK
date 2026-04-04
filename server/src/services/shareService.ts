import { db, canAccessTrip } from '../db/database';
import crypto from 'crypto';
import { loadTagsByPlaceIds } from './queryHelpers';

interface SharePermissions {
  share_map?: boolean;
  share_bookings?: boolean;
  share_packing?: boolean;
  share_budget?: boolean;
  share_collab?: boolean;
}

interface ShareTokenInfo {
  token: string;
  created_at: string;
  share_map: boolean;
  share_bookings: boolean;
  share_packing: boolean;
  share_budget: boolean;
  share_collab: boolean;
}

/**
 * Creates a new share link or updates the permissions on an existing one.
 * Returns an object with the token string and whether it was newly created.
 */
export function createOrUpdateShareLink(
  tripId: string,
  createdBy: number,
  permissions: SharePermissions
): { token: string; created: boolean } {
  const {
    share_map = true,
    share_bookings = true,
    share_packing = false,
    share_budget = false,
    share_collab = false,
  } = permissions;

  const existing = db.prepare('SELECT token FROM share_tokens WHERE trip_id = ?').get(tripId) as { token: string } | undefined;
  if (existing) {
    db.prepare('UPDATE share_tokens SET share_map = ?, share_bookings = ?, share_packing = ?, share_budget = ?, share_collab = ? WHERE trip_id = ?')
      .run(share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0, tripId);
    return { token: existing.token, created: false };
  }

  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tripId, token, createdBy, share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0);
  return { token, created: true };
}

/**
 * Returns share token info for a trip, or null if no share link exists.
 */
export function getShareLink(tripId: string): ShareTokenInfo | null {
  const row = db.prepare('SELECT * FROM share_tokens WHERE trip_id = ?').get(tripId) as any;
  if (!row) return null;
  return {
    token: row.token,
    created_at: row.created_at,
    share_map: !!row.share_map,
    share_bookings: !!row.share_bookings,
    share_packing: !!row.share_packing,
    share_budget: !!row.share_budget,
    share_collab: !!row.share_collab,
  };
}

/**
 * Deletes the share token for a trip.
 */
export function deleteShareLink(tripId: string): void {
  db.prepare('DELETE FROM share_tokens WHERE trip_id = ?').run(tripId);
}

/**
 * Loads the full public trip data for a share token, filtered by the token's
 * permission flags. Returns null if the token is invalid or the trip is gone.
 */
export function getSharedTripData(token: string): Record<string, any> | null {
  const shareRow = db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token) as any;
  if (!shareRow) return null;

  const tripId = shareRow.trip_id;

  // Trip
  const trip = db.prepare('SELECT id, title, description, start_date, end_date, cover_image, currency FROM trips WHERE id = ?').get(tripId);
  if (!trip) return null;

  // Days with assignments
  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as any[];
  const dayIds = days.map(d => d.id);

  let assignments: Record<number, any[]> = {};
  let dayNotes: Record<number, any[]> = {};
  if (dayIds.length > 0) {
    const ph = dayIds.map(() => '?').join(',');
    const allAssignments = db.prepare(`
      SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
        p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
        COALESCE(da.assignment_time, p.place_time) as place_time,
        COALESCE(da.assignment_end_time, p.end_time) as end_time,
        p.duration_minutes, p.notes as place_notes, p.image_url, p.transport_mode,
        c.name as category_name, c.color as category_color, c.icon as category_icon
      FROM day_assignments da
      JOIN places p ON da.place_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE da.day_id IN (${ph})
      ORDER BY da.order_index ASC
    `).all(...dayIds);

    const placeIds = [...new Set(allAssignments.map((a: any) => a.place_id))];
    const tagsByPlace = loadTagsByPlaceIds(placeIds, { compact: true });

    const byDay: Record<number, any[]> = {};
    for (const a of allAssignments as any[]) {
      if (!byDay[a.day_id]) byDay[a.day_id] = [];
      byDay[a.day_id].push({
        id: a.id, day_id: a.day_id, order_index: a.order_index, notes: a.notes,
        place: {
          id: a.place_id, name: a.place_name, description: a.place_description,
          lat: a.lat, lng: a.lng, address: a.address, category_id: a.category_id,
          price: a.price, place_time: a.place_time, end_time: a.end_time,
          image_url: a.image_url, transport_mode: a.transport_mode,
          category: a.category_id ? { id: a.category_id, name: a.category_name, color: a.category_color, icon: a.category_icon } : null,
          tags: tagsByPlace[a.place_id] || [],
        }
      });
    }
    assignments = byDay;

    const allNotes = db.prepare(`SELECT * FROM day_notes WHERE day_id IN (${ph}) ORDER BY sort_order ASC`).all(...dayIds);
    const notesByDay: Record<number, any[]> = {};
    for (const n of allNotes as any[]) {
      if (!notesByDay[n.day_id]) notesByDay[n.day_id] = [];
      notesByDay[n.day_id].push(n);
    }
    dayNotes = notesByDay;
  }

  // Places
  const places = db.prepare(`
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ? ORDER BY p.created_at DESC
  `).all(tripId);

  // Reservations
  const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ? ORDER BY reservation_time ASC').all(tripId);

  // Accommodations
  const accommodations = db.prepare(`
    SELECT a.*, p.name as place_name, p.address as place_address, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a JOIN places p ON a.place_id = p.id
    WHERE a.trip_id = ?
  `).all(tripId);

  // Packing
  const packing = db.prepare('SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order ASC').all(tripId);

  // Budget
  const budget = db.prepare('SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC').all(tripId);

  // Categories
  const categories = db.prepare('SELECT * FROM categories').all();

  const permissions = {
    share_map: !!shareRow.share_map,
    share_bookings: !!shareRow.share_bookings,
    share_packing: !!shareRow.share_packing,
    share_budget: !!shareRow.share_budget,
    share_collab: !!shareRow.share_collab,
  };

  // Collab messages (only if owner chose to share)
  const collabMessages = permissions.share_collab
    ? db.prepare('SELECT m.*, u.username, u.avatar FROM collab_messages m JOIN users u ON m.user_id = u.id WHERE m.trip_id = ? AND m.deleted = 0 ORDER BY m.created_at').all(tripId)
    : [];

  return {
    trip, days, assignments, dayNotes, places, categories, permissions,
    reservations: permissions.share_bookings ? reservations : [],
    accommodations: permissions.share_bookings ? accommodations : [],
    packing: permissions.share_packing ? packing : [],
    budget: permissions.share_budget ? budget : [],
    collab: collabMessages,
  };
}
