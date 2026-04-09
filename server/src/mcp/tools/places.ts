import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import { listPlaces, createPlace, updatePlace, deletePlace } from '../../services/placeService';
import { listCategories } from '../../services/categoryService';
import { searchPlaces } from '../../services/mapsService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerPlaceTools(server: McpServer, userId: number): void {
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = createPlace(String(tripId), { name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone });
      safeBroadcast(tripId, 'place:created', { place });
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
        category_id: z.number().int().positive().optional().describe('Category ID — use list_categories'),
        price: z.number().optional(),
        currency: z.string().length(3).optional(),
        place_time: z.string().max(50).optional().describe('Scheduled time (e.g. "09:00")'),
        end_time: z.string().max(50).optional().describe('End time (e.g. "11:00")'),
        duration_minutes: z.number().int().positive().optional(),
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
        transport_mode: z.enum(['walking', 'driving', 'cycling', 'transit', 'flight']).optional(),
        osm_id: z.string().optional().describe('OpenStreetMap ID (e.g. "way:12345")'),
        google_place_id: z.string().optional().describe('Google Place ID (e.g. "ChIJd8BlQ2BZwokRAFUEcm_qrcA")'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, placeId, name, description, lat, lng, address, category_id, price, currency, place_time, end_time, duration_minutes, notes, website, phone, transport_mode, osm_id, google_place_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = updatePlace(String(tripId), String(placeId), { name, description, lat, lng, address, category_id, price, currency, place_time, end_time, duration_minutes, notes, website, phone, transport_mode, osm_id, google_place_id });
      if (!place) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      safeBroadcast(tripId, 'place:updated', { place });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, placeId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePlace(String(tripId), String(placeId));
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      safeBroadcast(tripId, 'place:deleted', { placeId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'list_places',
    {
      description: 'List all places/POIs in a trip, optionally filtered by assignment status. Use assignment=unassigned to find orphan activities not yet scheduled on any day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        search: z.string().optional(),
        category: z.string().optional(),
        tag: z.string().optional(),
        assignment: z.enum(['all', 'unassigned', 'assigned']).optional().default('all').describe('Filter by assignment status: "all" (default), "unassigned" (not on any day), or "assigned" (scheduled on a day)'),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId, search, category, tag, assignment }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const places = listPlaces(String(tripId), { search, category, tag, assignment });
      return ok({ places });
    }
  );

  // --- CATEGORIES ---

  server.registerTool(
    'list_categories',
    {
      description: 'List all available place categories with their id, name, icon and color. Use category_id when creating or updating places.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => {
      const categories = listCategories();
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
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ query }) => {
      try {
        const result = await searchPlaces(userId, query);
        return ok(result);
      } catch {
        return { content: [{ type: 'text' as const, text: 'Place search failed.' }], isError: true };
      }
    }
  );
}
