import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp';
import { db, canAccessTrip } from '../db/database';

const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

function parseId(value: string | string[]): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function accessDenied(uri: string) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ error: 'Trip not found or access denied' }),
    }],
  };
}

function jsonContent(uri: string, data: unknown) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function registerResources(server: McpServer, userId: number): void {
  // List all accessible trips
  server.registerResource(
    'trips',
    'trek://trips',
    { description: 'All trips the user owns or is a member of' },
    async (uri) => {
      const trips = db.prepare(`
        ${TRIP_SELECT}
        LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
        WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = 0
        ORDER BY t.created_at DESC
      `).all({ userId });
      return jsonContent(uri.href, trips);
    }
  );

  // Single trip detail
  server.registerResource(
    'trip',
    new ResourceTemplate('trek://trips/{tripId}', { list: undefined }),
    { description: 'A single trip with metadata and member count' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const trip = db.prepare(`
        ${TRIP_SELECT}
        LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
        WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
      `).get({ userId, tripId: id });
      return jsonContent(uri.href, trip);
    }
  );

  // Days with assigned places
  server.registerResource(
    'trip-days',
    new ResourceTemplate('trek://trips/{tripId}/days', { list: undefined }),
    { description: 'Days of a trip with their assigned places' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);

      const days = db.prepare(
        'SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC'
      ).all(id) as { id: number; day_number: number; date: string | null; title: string | null; notes: string | null }[];

      const dayIds = days.map(d => d.id);
      const assignmentsByDay: Record<number, unknown[]> = {};

      if (dayIds.length > 0) {
        const placeholders = dayIds.map(() => '?').join(',');
        const assignments = db.prepare(`
          SELECT da.id, da.day_id, da.order_index, da.notes as assignment_notes,
            p.id as place_id, p.name, p.address, p.lat, p.lng, p.category_id,
            COALESCE(da.assignment_time, p.place_time) as place_time,
            c.name as category_name, c.color as category_color, c.icon as category_icon
          FROM day_assignments da
          JOIN places p ON da.place_id = p.id
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE da.day_id IN (${placeholders})
          ORDER BY da.order_index ASC, da.created_at ASC
        `).all(...dayIds) as (Record<string, unknown> & { day_id: number })[];

        for (const a of assignments) {
          if (!assignmentsByDay[a.day_id]) assignmentsByDay[a.day_id] = [];
          assignmentsByDay[a.day_id].push(a);
        }
      }

      const result = days.map(d => ({ ...d, assignments: assignmentsByDay[d.id] || [] }));
      return jsonContent(uri.href, result);
    }
  );

  // Places in a trip
  server.registerResource(
    'trip-places',
    new ResourceTemplate('trek://trips/{tripId}/places', { list: undefined }),
    { description: 'All places/POIs saved in a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const places = db.prepare(`
        SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
        FROM places p
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.trip_id = ?
        ORDER BY p.created_at DESC
      `).all(id);
      return jsonContent(uri.href, places);
    }
  );

  // Budget items
  server.registerResource(
    'trip-budget',
    new ResourceTemplate('trek://trips/{tripId}/budget', { list: undefined }),
    { description: 'Budget and expense items for a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const items = db.prepare(
        'SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC, created_at ASC'
      ).all(id);
      return jsonContent(uri.href, items);
    }
  );

  // Packing checklist
  server.registerResource(
    'trip-packing',
    new ResourceTemplate('trek://trips/{tripId}/packing', { list: undefined }),
    { description: 'Packing checklist for a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const items = db.prepare(
        'SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order ASC, created_at ASC'
      ).all(id);
      return jsonContent(uri.href, items);
    }
  );

  // Reservations (flights, hotels, restaurants)
  server.registerResource(
    'trip-reservations',
    new ResourceTemplate('trek://trips/{tripId}/reservations', { list: undefined }),
    { description: 'Reservations (flights, hotels, restaurants) for a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const reservations = db.prepare(`
        SELECT r.*, d.day_number, p.name as place_name
        FROM reservations r
        LEFT JOIN days d ON r.day_id = d.id
        LEFT JOIN places p ON r.place_id = p.id
        WHERE r.trip_id = ?
        ORDER BY r.reservation_time ASC, r.created_at ASC
      `).all(id);
      return jsonContent(uri.href, reservations);
    }
  );

  // Day notes
  server.registerResource(
    'day-notes',
    new ResourceTemplate('trek://trips/{tripId}/days/{dayId}/notes', { list: undefined }),
    { description: 'Notes for a specific day in a trip' },
    async (uri, { tripId, dayId }) => {
      const tId = parseId(tripId);
      const dId = parseId(dayId);
      if (tId === null || dId === null || !canAccessTrip(tId, userId)) return accessDenied(uri.href);
      const notes = db.prepare(
        'SELECT * FROM day_notes WHERE day_id = ? AND trip_id = ? ORDER BY sort_order ASC, created_at ASC'
      ).all(dId, tId);
      return jsonContent(uri.href, notes);
    }
  );

  // Accommodations (hotels, rentals) per trip
  server.registerResource(
    'trip-accommodations',
    new ResourceTemplate('trek://trips/{tripId}/accommodations', { list: undefined }),
    { description: 'Accommodations (hotels, rentals) for a trip with check-in/out details' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const accommodations = db.prepare(`
        SELECT da.*, p.name as place_name, p.address as place_address, p.lat, p.lng,
          ds.day_number as start_day_number, de.day_number as end_day_number
        FROM day_accommodations da
        JOIN places p ON da.place_id = p.id
        LEFT JOIN days ds ON da.start_day_id = ds.id
        LEFT JOIN days de ON da.end_day_id = de.id
        WHERE da.trip_id = ?
        ORDER BY ds.day_number ASC
      `).all(id);
      return jsonContent(uri.href, accommodations);
    }
  );

  // Trip members (owner + collaborators)
  server.registerResource(
    'trip-members',
    new ResourceTemplate('trek://trips/{tripId}/members', { list: undefined }),
    { description: 'Owner and collaborators of a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(id) as { user_id: number } | undefined;
      if (!trip) return accessDenied(uri.href);
      const owner = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(trip.user_id) as Record<string, unknown> | undefined;
      const members = db.prepare(`
        SELECT u.id, u.username, u.avatar, tm.added_at
        FROM trip_members tm
        JOIN users u ON tm.user_id = u.id
        WHERE tm.trip_id = ?
        ORDER BY tm.added_at ASC
      `).all(id);
      return jsonContent(uri.href, {
        owner: owner ? { ...owner, role: 'owner' } : null,
        members,
      });
    }
  );

  // Collab notes for a trip
  server.registerResource(
    'trip-collab-notes',
    new ResourceTemplate('trek://trips/{tripId}/collab-notes', { list: undefined }),
    { description: 'Shared collaborative notes for a trip' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const notes = db.prepare(`
        SELECT cn.*, u.username
        FROM collab_notes cn
        JOIN users u ON cn.user_id = u.id
        WHERE cn.trip_id = ?
        ORDER BY cn.pinned DESC, cn.updated_at DESC
      `).all(id);
      return jsonContent(uri.href, notes);
    }
  );

  // All place categories (global, no trip filter)
  server.registerResource(
    'categories',
    'trek://categories',
    { description: 'All available place categories (id, name, color, icon) for use when creating places' },
    async (uri) => {
      const categories = db.prepare(
        'SELECT id, name, color, icon FROM categories ORDER BY name ASC'
      ).all();
      return jsonContent(uri.href, categories);
    }
  );

  // User's bucket list
  server.registerResource(
    'bucket-list',
    'trek://bucket-list',
    { description: 'Your personal travel bucket list' },
    async (uri) => {
      const items = db.prepare(
        'SELECT * FROM bucket_list WHERE user_id = ? ORDER BY created_at DESC'
      ).all(userId);
      return jsonContent(uri.href, items);
    }
  );

  // User's visited countries
  server.registerResource(
    'visited-countries',
    'trek://visited-countries',
    { description: 'Countries you have marked as visited in Atlas' },
    async (uri) => {
      const countries = db.prepare(
        'SELECT country_code, created_at FROM visited_countries WHERE user_id = ? ORDER BY created_at DESC'
      ).all(userId);
      return jsonContent(uri.href, countries);
    }
  );
}
