import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { db, canAccessTrip, isOwner } from '../db/database';
import { broadcast } from '../websocket';

const MS_PER_DAY = 86400000;
const MAX_TRIP_DAYS = 90;

function isDemoUser(userId: number): boolean {
  if (process.env.DEMO_MODE !== 'true') return false;
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return user?.email === 'demo@nomad.app';
}

function demoDenied() {
  return { content: [{ type: 'text' as const, text: 'Write operations are disabled in demo mode.' }], isError: true };
}

function noAccess() {
  return { content: [{ type: 'text' as const, text: 'Trip not found or access denied.' }], isError: true };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Create days for a newly created trip (fresh insert, no existing days). */
function createDaysForNewTrip(tripId: number | bigint, startDate: string | null, endDate: string | null): void {
  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  if (startDate && endDate) {
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);
    const startMs = Date.UTC(sy, sm - 1, sd);
    const endMs = Date.UTC(ey, em - 1, ed);
    const numDays = Math.min(Math.floor((endMs - startMs) / MS_PER_DAY) + 1, MAX_TRIP_DAYS);
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startMs + i * MS_PER_DAY);
      const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      insert.run(tripId, i + 1, date);
    }
  } else {
    for (let i = 0; i < 7; i++) insert.run(tripId, i + 1, null);
  }
}

export function registerTools(server: McpServer, userId: number): void {
  // --- TRIPS ---

  server.registerTool(
    'create_trip',
    {
      description: 'Create a new trip. Returns the created trip with its generated days.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Trip title'),
        description: z.string().max(2000).optional().describe('Trip description'),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date (YYYY-MM-DD)'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date (YYYY-MM-DD)'),
        currency: z.string().length(3).optional().describe('Currency code (e.g. EUR, USD)'),
      },
    },
    async ({ title, description, start_date, end_date, currency }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (start_date) {
        const d = new Date(start_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start_date)
          return { content: [{ type: 'text' as const, text: 'start_date is not a valid calendar date.' }], isError: true };
      }
      if (end_date) {
        const d = new Date(end_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== end_date)
          return { content: [{ type: 'text' as const, text: 'end_date is not a valid calendar date.' }], isError: true };
      }
      if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
        return { content: [{ type: 'text' as const, text: 'End date must be after start date.' }], isError: true };
      }
      const trip = db.transaction(() => {
        const result = db.prepare(
          'INSERT INTO trips (user_id, title, description, start_date, end_date, currency) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(userId, title, description || null, start_date || null, end_date || null, currency || 'EUR');
        const tripId = result.lastInsertRowid as number;
        createDaysForNewTrip(tripId, start_date || null, end_date || null);
        return db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
      })();
      return ok({ trip });
    }
  );

  server.registerTool(
    'update_trip',
    {
      description: 'Update an existing trip\'s details.',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        currency: z.string().length(3).optional(),
      },
    },
    async ({ tripId, title, description, start_date, end_date, currency }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (start_date) {
        const d = new Date(start_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start_date)
          return { content: [{ type: 'text' as const, text: 'start_date is not a valid calendar date.' }], isError: true };
      }
      if (end_date) {
        const d = new Date(end_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== end_date)
          return { content: [{ type: 'text' as const, text: 'end_date is not a valid calendar date.' }], isError: true };
      }
      const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Record<string, unknown> & { title: string; description: string; start_date: string; end_date: string; currency: string } | undefined;
      if (!existing) return noAccess();
      db.prepare(
        'UPDATE trips SET title = ?, description = ?, start_date = ?, end_date = ?, currency = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(
        title ?? existing.title,
        description !== undefined ? description : existing.description,
        start_date !== undefined ? start_date : existing.start_date,
        end_date !== undefined ? end_date : existing.end_date,
        currency ?? existing.currency,
        tripId
      );
      const updated = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
      broadcast(tripId, 'trip:updated', { trip: updated });
      return ok({ trip: updated });
    }
  );

  server.registerTool(
    'delete_trip',
    {
      description: 'Delete a trip. Only the trip owner can delete it.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
    },
    async ({ tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!isOwner(tripId, userId)) return noAccess();
      db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
      return ok({ success: true, tripId });
    }
  );

  server.registerTool(
    'list_trips',
    {
      description: 'List all trips the current user owns or is a member of. Use this for trip discovery before calling get_trip_summary.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived trips (default false)'),
      },
    },
    async ({ include_archived }) => {
      const trips = db.prepare(`
        SELECT t.*, u.username as owner_username,
          (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
          (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
          CASE WHEN t.user_id = ? THEN 1 ELSE 0 END as is_owner
        FROM trips t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = ?
        WHERE (t.user_id = ? OR tm.user_id IS NOT NULL)
          AND (? = 1 OR t.is_archived = 0)
        ORDER BY t.updated_at DESC
      `).all(userId, userId, userId, include_archived ? 1 : 0);
      return ok({ trips });
    }
  );

  // --- PLACES ---

  server.registerTool(
    'create_place',
    {
      description: 'Add a new place/POI to a trip. Set google_place_id or osm_id (from search_place) so the app can show opening hours and ratings.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(500).optional(),
        category_id: z.number().int().positive().optional().describe('Category ID — use list_categories to see available options'),
        google_place_id: z.string().optional().describe('Google Place ID from search_place — enables opening hours display'),
        osm_id: z.string().optional().describe('OpenStreetMap ID from search_place (e.g. "way:12345") — enables opening hours if no Google ID'),
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
      },
    },
    async ({ tripId, name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const result = db.prepare(`
        INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone, transport_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tripId, name, description || null, lat ?? null, lng ?? null, address || null, category_id || null, google_place_id || null, osm_id || null, notes || null, website || null, phone || null, 'walking');
      const place = db.prepare('SELECT * FROM places WHERE id = ?').get(result.lastInsertRowid);
      broadcast(tripId, 'place:created', { place });
      return ok({ place });
    }
  );

  server.registerTool(
    'update_place',
    {
      description: 'Update an existing place in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        placeId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(500).optional(),
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
      },
    },
    async ({ tripId, placeId, name, description, lat, lng, address, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      db.prepare(`
        UPDATE places SET
          name = ?, description = ?, lat = ?, lng = ?, address = ?, notes = ?, website = ?, phone = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        name ?? existing.name,
        description !== undefined ? description : existing.description,
        lat !== undefined ? lat : existing.lat,
        lng !== undefined ? lng : existing.lng,
        address !== undefined ? address : existing.address,
        notes !== undefined ? notes : existing.notes,
        website !== undefined ? website : existing.website,
        phone !== undefined ? phone : existing.phone,
        placeId
      );
      const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
      broadcast(tripId, 'place:updated', { place });
      return ok({ place });
    }
  );

  server.registerTool(
    'delete_place',
    {
      description: 'Delete a place from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        placeId: z.number().int().positive(),
      },
    },
    async ({ tripId, placeId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId);
      if (!place) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      db.prepare('DELETE FROM places WHERE id = ?').run(placeId);
      broadcast(tripId, 'place:deleted', { placeId });
      return ok({ success: true });
    }
  );

  // --- CATEGORIES ---

  server.registerTool(
    'list_categories',
    {
      description: 'List all available place categories with their id, name, icon and color. Use category_id when creating or updating places.',
      inputSchema: {},
    },
    async () => {
      const categories = db.prepare('SELECT id, name, color, icon FROM categories ORDER BY name ASC').all();
      return ok({ categories });
    }
  );

  // --- SEARCH ---

  server.registerTool(
    'search_place',
    {
      description: 'Search for a real-world place by name or address. Returns results with osm_id (and google_place_id if configured). Use these IDs when calling create_place so the app can display opening hours and ratings.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Place name or address to search for'),
      },
    },
    async ({ query }) => {
      // Use Nominatim (no API key needed, always available)
      const params = new URLSearchParams({
        q: query, format: 'json', addressdetails: '1', limit: '5', 'accept-language': 'en',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'TREK Travel Planner' },
      });
      if (!response.ok) {
        return { content: [{ type: 'text' as const, text: 'Search failed — Nominatim API error.' }], isError: true };
      }
      const data = await response.json() as { osm_type: string; osm_id: number; name: string; display_name: string; lat: string; lon: string }[];
      const places = data.map(item => ({
        osm_id: `${item.osm_type}:${item.osm_id}`,
        name: item.name || item.display_name?.split(',')[0] || '',
        address: item.display_name || '',
        lat: parseFloat(item.lat) || null,
        lng: parseFloat(item.lon) || null,
      }));
      return ok({ places });
    }
  );

  // --- ASSIGNMENTS ---

  server.registerTool(
    'assign_place_to_day',
    {
      description: 'Assign a place to a specific day in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        placeId: z.number().int().positive(),
        notes: z.string().max(500).optional(),
      },
    },
    async ({ tripId, dayId, placeId, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
      if (!day) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId);
      if (!place) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM day_assignments WHERE day_id = ?').get(dayId) as { max: number | null };
      const orderIndex = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
      const result = db.prepare(
        'INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, ?, ?)'
      ).run(dayId, placeId, orderIndex, notes || null);
      const assignment = db.prepare(`
        SELECT da.*, p.name as place_name, p.address, p.lat, p.lng
        FROM day_assignments da JOIN places p ON da.place_id = p.id
        WHERE da.id = ?
      `).get(result.lastInsertRowid);
      broadcast(tripId, 'assignment:created', { assignment });
      return ok({ assignment });
    }
  );

  server.registerTool(
    'unassign_place',
    {
      description: 'Remove a place assignment from a day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
      },
    },
    async ({ tripId, dayId, assignmentId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignment = db.prepare(
        'SELECT da.id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ? AND da.day_id = ? AND d.trip_id = ?'
      ).get(assignmentId, dayId, tripId);
      if (!assignment) return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      db.prepare('DELETE FROM day_assignments WHERE id = ?').run(assignmentId);
      broadcast(tripId, 'assignment:deleted', { assignmentId, dayId });
      return ok({ success: true });
    }
  );

  // --- BUDGET ---

  server.registerTool(
    'create_budget_item',
    {
      description: 'Add a budget/expense item to a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Budget category (e.g. Accommodation, Food, Transport)'),
        total_price: z.number().nonnegative(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ tripId, name, category, total_price, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?').get(tripId) as { max: number | null };
      const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
      const result = db.prepare(
        'INSERT INTO budget_items (trip_id, category, name, total_price, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(tripId, category || 'Other', name, total_price, note || null, sortOrder);
      const item = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid);
      broadcast(tripId, 'budget:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_budget_item',
    {
      description: 'Delete a budget item from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = db.prepare('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?').get(itemId, tripId);
      if (!item) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      db.prepare('DELETE FROM budget_items WHERE id = ?').run(itemId);
      broadcast(tripId, 'budget:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- PACKING ---

  server.registerTool(
    'create_packing_item',
    {
      description: 'Add an item to the packing checklist for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Packing category (e.g. Clothes, Electronics)'),
      },
    },
    async ({ tripId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
      const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
      const result = db.prepare(
        'INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, ?, ?, ?)'
      ).run(tripId, name, 0, category || 'General', sortOrder);
      const item = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid);
      broadcast(tripId, 'packing:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'toggle_packing_item',
    {
      description: 'Check or uncheck a packing item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        checked: z.boolean(),
      },
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = db.prepare('SELECT id FROM packing_items WHERE id = ? AND trip_id = ?').get(itemId, tripId);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      db.prepare('UPDATE packing_items SET checked = ? WHERE id = ?').run(checked ? 1 : 0, itemId);
      const updated = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(itemId);
      broadcast(tripId, 'packing:updated', { item: updated });
      return ok({ item: updated });
    }
  );

  server.registerTool(
    'delete_packing_item',
    {
      description: 'Remove an item from the packing checklist.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = db.prepare('SELECT id FROM packing_items WHERE id = ? AND trip_id = ?').get(itemId, tripId);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      db.prepare('DELETE FROM packing_items WHERE id = ?').run(itemId);
      broadcast(tripId, 'packing:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- RESERVATIONS ---

  server.registerTool(
    'create_reservation',
    {
      description: 'Recommend a reservation for a trip. Created as pending — the user must confirm it. Linking: hotel → use place_id + start_day_id + end_day_id (all three required to create the accommodation link); restaurant/train/car/cruise/event/tour/activity/other → use assignment_id; flight → no linking.',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200),
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        day_id: z.number().int().positive().optional(),
        place_id: z.number().int().positive().optional().describe('Hotel place to link (hotel type only)'),
        start_day_id: z.number().int().positive().optional().describe('Check-in day (hotel type only; requires place_id and end_day_id)'),
        end_day_id: z.number().int().positive().optional().describe('Check-out day (hotel type only; requires place_id and start_day_id)'),
        assignment_id: z.number().int().positive().optional().describe('Link to a day assignment (restaurant, train, car, cruise, event, tour, activity, other)'),
      },
    },
    async ({ tripId, title, type, reservation_time, location, confirmation_number, notes, day_id, place_id, start_day_id, end_day_id, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();

      // Validate that all referenced IDs belong to this trip
      if (day_id) {
        if (!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(day_id, tripId))
          return { content: [{ type: 'text' as const, text: 'day_id does not belong to this trip.' }], isError: true };
      }
      if (place_id) {
        if (!db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId))
          return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      }
      if (start_day_id) {
        if (!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId))
          return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      }
      if (end_day_id) {
        if (!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId))
          return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };
      }
      if (assignment_id) {
        if (!db.prepare('SELECT da.id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ? AND d.trip_id = ?').get(assignment_id, tripId))
          return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };
      }

      const reservation = db.transaction(() => {
        let accommodationId: number | null = null;
        if (type === 'hotel' && place_id && start_day_id && end_day_id) {
          const accResult = db.prepare(
            'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, confirmation) VALUES (?, ?, ?, ?, ?)'
          ).run(tripId, place_id, start_day_id, end_day_id, confirmation_number || null);
          accommodationId = accResult.lastInsertRowid as number;
        }
        const result = db.prepare(`
          INSERT INTO reservations (trip_id, title, type, reservation_time, location, confirmation_number, notes, day_id, place_id, assignment_id, accommodation_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(tripId, title, type, reservation_time || null, location || null, confirmation_number || null, notes || null, day_id || null, place_id || null, assignment_id || null, accommodationId, 'pending');
        return db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid);
      })();

      if (type === 'hotel' && place_id && start_day_id && end_day_id) {
        broadcast(tripId, 'accommodation:created', {});
      }
      broadcast(tripId, 'reservation:created', { reservation });
      return ok({ reservation });
    }
  );

  server.registerTool(
    'delete_reservation',
    {
      description: 'Delete a reservation from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
      },
    },
    async ({ tripId, reservationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const reservation = db.prepare('SELECT id, accommodation_id FROM reservations WHERE id = ? AND trip_id = ?').get(reservationId, tripId) as { id: number; accommodation_id: number | null } | undefined;
      if (!reservation) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      db.transaction(() => {
        if (reservation.accommodation_id) {
          db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(reservation.accommodation_id);
        }
        db.prepare('DELETE FROM reservations WHERE id = ?').run(reservationId);
      })();
      if (reservation.accommodation_id) {
        broadcast(tripId, 'accommodation:deleted', { accommodationId: reservation.accommodation_id });
      }
      broadcast(tripId, 'reservation:deleted', { reservationId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'link_hotel_accommodation',
    {
      description: 'Set or update the check-in/check-out day links for a hotel reservation. Creates or updates the accommodation record that ties the reservation to a place and a date range. Use the day IDs from get_trip_summary.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
        place_id: z.number().int().positive().describe('The hotel place to link'),
        start_day_id: z.number().int().positive().describe('Check-in day ID'),
        end_day_id: z.number().int().positive().describe('Check-out day ID'),
      },
    },
    async ({ tripId, reservationId, place_id, start_day_id, end_day_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const reservation = db.prepare('SELECT * FROM reservations WHERE id = ? AND trip_id = ?').get(reservationId, tripId) as Record<string, unknown> | undefined;
      if (!reservation) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      if (reservation.type !== 'hotel') return { content: [{ type: 'text' as const, text: 'Reservation is not of type hotel.' }], isError: true };

      if (!db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };

      let accommodationId = reservation.accommodation_id as number | null;
      const isNewAccommodation = !accommodationId;
      db.transaction(() => {
        if (accommodationId) {
          db.prepare('UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ? WHERE id = ?')
            .run(place_id, start_day_id, end_day_id, accommodationId);
        } else {
          const accResult = db.prepare(
            'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, confirmation) VALUES (?, ?, ?, ?, ?)'
          ).run(tripId, place_id, start_day_id, end_day_id, reservation.confirmation_number || null);
          accommodationId = accResult.lastInsertRowid as number;
        }
        db.prepare('UPDATE reservations SET place_id = ?, accommodation_id = ? WHERE id = ?')
          .run(place_id, accommodationId, reservationId);
      })();
      broadcast(tripId, isNewAccommodation ? 'accommodation:created' : 'accommodation:updated', {});
      const updated = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
      broadcast(tripId, 'reservation:updated', { reservation: updated });
      return ok({ reservation: updated, accommodation_id: accommodationId });
    }
  );

  // --- DAYS ---

  server.registerTool(
    'update_assignment_time',
    {
      description: 'Set the start and/or end time for a place assignment on a day (e.g. "09:00", "11:30"). Pass null to clear a time.',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
        place_time: z.string().max(50).nullable().optional().describe('Start time (e.g. "09:00"), or null to clear'),
        end_time: z.string().max(50).nullable().optional().describe('End time (e.g. "11:00"), or null to clear'),
      },
    },
    async ({ tripId, assignmentId, place_time, end_time }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignment = db.prepare(`
        SELECT da.* FROM day_assignments da
        JOIN days d ON da.day_id = d.id
        WHERE da.id = ? AND d.trip_id = ?
      `).get(assignmentId, tripId) as Record<string, unknown> | undefined;
      if (!assignment) return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      db.prepare('UPDATE day_assignments SET assignment_time = ?, assignment_end_time = ? WHERE id = ?')
        .run(
          place_time !== undefined ? place_time : assignment.assignment_time,
          end_time !== undefined ? end_time : assignment.assignment_end_time,
          assignmentId
        );
      const updated = db.prepare(`
        SELECT da.id, da.day_id, da.order_index, da.notes as assignment_notes,
          da.assignment_time, da.assignment_end_time,
          p.id as place_id, p.name, p.address
        FROM day_assignments da
        JOIN places p ON da.place_id = p.id
        WHERE da.id = ?
      `).get(assignmentId);
      broadcast(tripId, 'assignment:updated', { assignment: updated });
      return ok({ assignment: updated });
    }
  );

  server.registerTool(
    'update_day',
    {
      description: 'Set the title of a day in a trip (e.g. "Arrival in Paris", "Free day").',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        title: z.string().max(200).nullable().describe('Day title, or null to clear it'),
      },
    },
    async ({ tripId, dayId, title }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
      if (!day) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      db.prepare('UPDATE days SET title = ? WHERE id = ?').run(title, dayId);
      const updated = db.prepare('SELECT * FROM days WHERE id = ?').get(dayId);
      broadcast(tripId, 'day:updated', { day: updated });
      return ok({ day: updated });
    }
  );

  // --- RESERVATIONS (update) ---

  server.registerTool(
    'update_reservation',
    {
      description: 'Update an existing reservation in a trip. Use status "confirmed" to confirm a pending recommendation, or "pending" to revert it. Linking: hotel → use place_id to link to an accommodation place; restaurant/train/car/cruise/event/tour/activity/other → use assignment_id to link to a day assignment; flight → no linking.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']).optional(),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        status: z.enum(['pending', 'confirmed', 'cancelled']).optional(),
        place_id: z.number().int().positive().nullable().optional().describe('Link to a place (use for hotel type), or null to unlink'),
        assignment_id: z.number().int().positive().nullable().optional().describe('Link to a day assignment (use for restaurant, train, car, cruise, event, tour, activity, other), or null to unlink'),
      },
    },
    async ({ tripId, reservationId, title, type, reservation_time, location, confirmation_number, notes, status, place_id, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM reservations WHERE id = ? AND trip_id = ?').get(reservationId, tripId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };

      if (place_id != null) {
        if (!db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId))
          return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      }
      if (assignment_id != null) {
        if (!db.prepare('SELECT da.id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ? AND d.trip_id = ?').get(assignment_id, tripId))
          return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };
      }

      db.prepare(`
        UPDATE reservations SET
          title = ?, type = ?, reservation_time = ?, location = ?,
          confirmation_number = ?, notes = ?, status = ?,
          place_id = ?, assignment_id = ?
        WHERE id = ?
      `).run(
        title ?? existing.title,
        type ?? existing.type,
        reservation_time !== undefined ? reservation_time : existing.reservation_time,
        location !== undefined ? location : existing.location,
        confirmation_number !== undefined ? confirmation_number : existing.confirmation_number,
        notes !== undefined ? notes : existing.notes,
        status ?? existing.status,
        place_id !== undefined ? place_id : existing.place_id,
        assignment_id !== undefined ? assignment_id : existing.assignment_id,
        reservationId
      );
      const updated = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
      broadcast(tripId, 'reservation:updated', { reservation: updated });
      return ok({ reservation: updated });
    }
  );

  // --- BUDGET (update) ---

  server.registerTool(
    'update_budget_item',
    {
      description: 'Update an existing budget/expense item in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
        total_price: z.number().nonnegative().optional(),
        persons: z.number().int().positive().nullable().optional(),
        days: z.number().int().positive().nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      },
    },
    async ({ tripId, itemId, name, category, total_price, persons, days, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(itemId, tripId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      db.prepare(`
        UPDATE budget_items SET
          name = ?, category = ?, total_price = ?, persons = ?, days = ?, note = ?
        WHERE id = ?
      `).run(
        name ?? existing.name,
        category ?? existing.category,
        total_price !== undefined ? total_price : existing.total_price,
        persons !== undefined ? persons : existing.persons,
        days !== undefined ? days : existing.days,
        note !== undefined ? note : existing.note,
        itemId
      );
      const updated = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(itemId);
      broadcast(tripId, 'budget:updated', { item: updated });
      return ok({ item: updated });
    }
  );

  // --- PACKING (update) ---

  server.registerTool(
    'update_packing_item',
    {
      description: 'Rename a packing item or change its category.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
      },
    },
    async ({ tripId, itemId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM packing_items WHERE id = ? AND trip_id = ?').get(itemId, tripId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      db.prepare('UPDATE packing_items SET name = ?, category = ? WHERE id = ?').run(
        name ?? existing.name,
        category ?? existing.category,
        itemId
      );
      const updated = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(itemId);
      broadcast(tripId, 'packing:updated', { item: updated });
      return ok({ item: updated });
    }
  );

  // --- REORDER ---

  server.registerTool(
    'reorder_day_assignments',
    {
      description: 'Reorder places within a day by providing the assignment IDs in the desired order.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentIds: z.array(z.number().int().positive()).min(1).max(200).describe('Assignment IDs in desired display order'),
      },
    },
    async ({ tripId, dayId, assignmentIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
      if (!day) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const update = db.prepare('UPDATE day_assignments SET order_index = ? WHERE id = ? AND day_id = ?');
      const updateMany = db.transaction((ids: number[]) => {
        ids.forEach((id, index) => update.run(index, id, dayId));
      });
      updateMany(assignmentIds);
      broadcast(tripId, 'assignment:reordered', { dayId, assignmentIds });
      return ok({ success: true, dayId, order: assignmentIds });
    }
  );

  // --- TRIP SUMMARY ---

  server.registerTool(
    'get_trip_summary',
    {
      description: 'Get a full denormalized summary of a trip in a single call: metadata, members, days with assignments and notes, accommodations, budget totals, packing stats, reservations, and collab notes. Use this as a context loader before planning or modifying a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();

      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Record<string, unknown> | undefined;
      if (!trip) return noAccess();

      // Members
      const owner = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(trip.user_id as number);
      const members = db.prepare(`
        SELECT u.id, u.username, u.avatar, tm.added_at
        FROM trip_members tm JOIN users u ON tm.user_id = u.id
        WHERE tm.trip_id = ?
      `).all(tripId);

      // Days with assignments
      const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as (Record<string, unknown> & { id: number })[];
      const dayIds = days.map(d => d.id);
      const assignmentsByDay: Record<number, unknown[]> = {};
      if (dayIds.length > 0) {
        const placeholders = dayIds.map(() => '?').join(',');
        const assignments = db.prepare(`
          SELECT da.id, da.day_id, da.order_index, da.notes as assignment_notes,
            p.id as place_id, p.name, p.address, p.lat, p.lng,
            COALESCE(da.assignment_time, p.place_time) as place_time,
            c.name as category_name, c.icon as category_icon
          FROM day_assignments da
          JOIN places p ON da.place_id = p.id
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE da.day_id IN (${placeholders})
          ORDER BY da.order_index ASC
        `).all(...dayIds) as (Record<string, unknown> & { day_id: number })[];
        for (const a of assignments) {
          if (!assignmentsByDay[a.day_id]) assignmentsByDay[a.day_id] = [];
          assignmentsByDay[a.day_id].push(a);
        }
      }
      // Day notes
      const dayNotesByDay: Record<number, unknown[]> = {};
      if (dayIds.length > 0) {
        const placeholders = dayIds.map(() => '?').join(',');
        const dayNotes = db.prepare(`
          SELECT * FROM day_notes WHERE day_id IN (${placeholders}) ORDER BY sort_order ASC
        `).all(...dayIds) as (Record<string, unknown> & { day_id: number })[];
        for (const n of dayNotes) {
          if (!dayNotesByDay[n.day_id]) dayNotesByDay[n.day_id] = [];
          dayNotesByDay[n.day_id].push(n);
        }
      }

      const daysWithAssignments = days.map(d => ({
        ...d,
        assignments: assignmentsByDay[d.id] || [],
        notes: dayNotesByDay[d.id] || [],
      }));

      // Accommodations
      const accommodations = db.prepare(`
        SELECT da.*, p.name as place_name, ds.day_number as start_day_number, de.day_number as end_day_number
        FROM day_accommodations da
        JOIN places p ON da.place_id = p.id
        LEFT JOIN days ds ON da.start_day_id = ds.id
        LEFT JOIN days de ON da.end_day_id = de.id
        WHERE da.trip_id = ?
        ORDER BY ds.day_number ASC
      `).all(tripId);

      // Budget summary
      const budgetStats = db.prepare(`
        SELECT COUNT(*) as item_count, COALESCE(SUM(total_price), 0) as total
        FROM budget_items WHERE trip_id = ?
      `).get(tripId) as { item_count: number; total: number };

      // Packing summary
      const packingStats = db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) as checked
        FROM packing_items WHERE trip_id = ?
      `).get(tripId) as { total: number; checked: number };

      // Upcoming reservations (all, sorted by time)
      const reservations = db.prepare(`
        SELECT r.*, d.day_number
        FROM reservations r
        LEFT JOIN days d ON r.day_id = d.id
        WHERE r.trip_id = ?
        ORDER BY r.reservation_time ASC, r.created_at ASC
      `).all(tripId);

      // Collab notes
      const collabNotes = db.prepare(
        'SELECT * FROM collab_notes WHERE trip_id = ? ORDER BY pinned DESC, updated_at DESC'
      ).all(tripId);

      return ok({
        trip,
        members: { owner, collaborators: members },
        days: daysWithAssignments,
        accommodations,
        budget: { ...budgetStats, currency: trip.currency },
        packing: packingStats,
        reservations,
        collab_notes: collabNotes,
      });
    }
  );

  // --- BUCKET LIST ---

  server.registerTool(
    'create_bucket_list_item',
    {
      description: 'Add a destination to your personal travel bucket list.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Destination or experience name'),
        lat: z.number().optional(),
        lng: z.number().optional(),
        country_code: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2 country code'),
        notes: z.string().max(1000).optional(),
      },
    },
    async ({ name, lat, lng, country_code, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      const result = db.prepare(
        'INSERT INTO bucket_list (user_id, name, lat, lng, country_code, notes) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, name, lat ?? null, lng ?? null, country_code || null, notes || null);
      const item = db.prepare('SELECT * FROM bucket_list WHERE id = ?').get(result.lastInsertRowid);
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_bucket_list_item',
    {
      description: 'Remove an item from your travel bucket list.',
      inputSchema: {
        itemId: z.number().int().positive(),
      },
    },
    async ({ itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const item = db.prepare('SELECT id FROM bucket_list WHERE id = ? AND user_id = ?').get(itemId, userId);
      if (!item) return { content: [{ type: 'text' as const, text: 'Bucket list item not found.' }], isError: true };
      db.prepare('DELETE FROM bucket_list WHERE id = ?').run(itemId);
      return ok({ success: true });
    }
  );

  // --- ATLAS ---

  server.registerTool(
    'mark_country_visited',
    {
      description: 'Mark a country as visited in your Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code (e.g. "FR", "JP")'),
      },
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      db.prepare('INSERT OR IGNORE INTO visited_countries (user_id, country_code) VALUES (?, ?)').run(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  server.registerTool(
    'unmark_country_visited',
    {
      description: 'Remove a country from your visited countries in Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code'),
      },
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      db.prepare('DELETE FROM visited_countries WHERE user_id = ? AND country_code = ?').run(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  // --- COLLAB NOTES ---

  server.registerTool(
    'create_collab_note',
    {
      description: 'Create a shared collaborative note on a trip (visible to all trip members in the Collab tab).',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200),
        content: z.string().max(10000).optional(),
        category: z.string().max(100).optional().describe('Note category (e.g. "Ideas", "To-do", "General")'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color for the note card'),
      },
    },
    async ({ tripId, title, content, category, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const result = db.prepare(`
        INSERT INTO collab_notes (trip_id, user_id, title, content, category, color)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tripId, userId, title, content || null, category || 'General', color || '#6366f1');
      const note = db.prepare('SELECT * FROM collab_notes WHERE id = ?').get(result.lastInsertRowid);
      broadcast(tripId, 'collab:note:created', { note });
      return ok({ note });
    }
  );

  server.registerTool(
    'update_collab_note',
    {
      description: 'Edit an existing collaborative note on a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        noteId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().max(10000).optional(),
        category: z.string().max(100).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color for the note card'),
        pinned: z.boolean().optional().describe('Pin the note to the top'),
      },
    },
    async ({ tripId, noteId, title, content, category, color, pinned }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?').get(noteId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      db.prepare(`
        UPDATE collab_notes SET
          title = CASE WHEN ? THEN ? ELSE title END,
          content = CASE WHEN ? THEN ? ELSE content END,
          category = CASE WHEN ? THEN ? ELSE category END,
          color = CASE WHEN ? THEN ? ELSE color END,
          pinned = CASE WHEN ? THEN ? ELSE pinned END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        title !== undefined ? 1 : 0, title !== undefined ? title : null,
        content !== undefined ? 1 : 0, content !== undefined ? content : null,
        category !== undefined ? 1 : 0, category !== undefined ? category : null,
        color !== undefined ? 1 : 0, color !== undefined ? color : null,
        pinned !== undefined ? 1 : 0, pinned !== undefined ? (pinned ? 1 : 0) : null,
        noteId
      );
      const note = db.prepare('SELECT * FROM collab_notes WHERE id = ?').get(noteId);
      broadcast(tripId, 'collab:note:updated', { note });
      return ok({ note });
    }
  );

  server.registerTool(
    'delete_collab_note',
    {
      description: 'Delete a collaborative note from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        noteId: z.number().int().positive(),
      },
    },
    async ({ tripId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(noteId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      const noteFiles = db.prepare('SELECT filename FROM trip_files WHERE note_id = ?').all(noteId) as { filename: string }[];
      const uploadsDir = path.resolve(__dirname, '../../uploads');
      for (const f of noteFiles) {
        const resolved = path.resolve(path.join(uploadsDir, 'files', f.filename));
        if (!resolved.startsWith(uploadsDir)) continue;
        try { fs.unlinkSync(resolved); } catch {}
      }
      db.transaction(() => {
        db.prepare('DELETE FROM trip_files WHERE note_id = ?').run(noteId);
        db.prepare('DELETE FROM collab_notes WHERE id = ?').run(noteId);
      })();
      broadcast(tripId, 'collab:note:deleted', { noteId });
      return ok({ success: true });
    }
  );

  // --- DAY NOTES ---

  server.registerTool(
    'create_day_note',
    {
      description: 'Add a note to a specific day in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        text: z.string().min(1).max(500),
        time: z.string().max(150).optional().describe('Time label (e.g. "09:00" or "Morning")'),
        icon: z.string().optional().describe('Emoji icon for the note'),
      },
    },
    async ({ tripId, dayId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
      if (!day) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const result = db.prepare(
        'INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(dayId, tripId, text.trim(), time || null, icon || '📝', 9999);
      const note = db.prepare('SELECT * FROM day_notes WHERE id = ?').get(result.lastInsertRowid);
      broadcast(tripId, 'dayNote:created', { dayId, note });
      return ok({ note });
    }
  );

  server.registerTool(
    'update_day_note',
    {
      description: 'Edit an existing note on a specific day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        noteId: z.number().int().positive(),
        text: z.string().min(1).max(500).optional(),
        time: z.string().max(150).nullable().optional().describe('Time label (e.g. "09:00" or "Morning"), or null to clear'),
        icon: z.string().optional().describe('Emoji icon for the note'),
      },
    },
    async ({ tripId, dayId, noteId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = db.prepare('SELECT * FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(noteId, dayId, tripId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      db.prepare('UPDATE day_notes SET text = ?, time = ?, icon = ? WHERE id = ?').run(
        text !== undefined ? text.trim() : existing.text,
        time !== undefined ? time : existing.time,
        icon ?? existing.icon,
        noteId
      );
      const updated = db.prepare('SELECT * FROM day_notes WHERE id = ?').get(noteId);
      broadcast(tripId, 'dayNote:updated', { dayId, note: updated });
      return ok({ note: updated });
    }
  );

  server.registerTool(
    'delete_day_note',
    {
      description: 'Delete a note from a specific day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        noteId: z.number().int().positive(),
      },
    },
    async ({ tripId, dayId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = db.prepare('SELECT id FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(noteId, dayId, tripId);
      if (!note) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      db.prepare('DELETE FROM day_notes WHERE id = ?').run(noteId);
      broadcast(tripId, 'dayNote:deleted', { noteId, dayId });
      return ok({ success: true });
    }
  );
}
