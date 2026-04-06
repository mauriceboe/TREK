import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../db/database';
import { broadcast } from '../websocket';
import { isDemoUser } from '../services/authService';

function safeBroadcast(tripId: number, event: string, payload: Record<string, unknown>): void {
  try {
    broadcast(tripId, event, payload);
  } catch (err) {
    console.error(`[MCP] broadcast failed for ${event}:`, err?.message ?? err);
  }
}
import {
  listTrips, createTrip, updateTrip, deleteTrip, getTripSummary,
  isOwner, verifyTripAccess,
} from '../services/tripService';
import { listPlaces, createPlace, updatePlace, deletePlace } from '../services/placeService';
import { listCategories } from '../services/categoryService';
import {
  dayExists, placeExists, createAssignment, assignmentExistsInDay,
  deleteAssignment, reorderAssignments, getAssignmentForTrip, updateTime,
} from '../services/assignmentService';
import { createBudgetItem, updateBudgetItem, deleteBudgetItem } from '../services/budgetService';
import { createItem as createPackingItem, updateItem as updatePackingItem, deleteItem as deletePackingItem } from '../services/packingService';
import { createReservation, getReservation, updateReservation, deleteReservation } from '../services/reservationService';
import { getDay, updateDay, validateAccommodationRefs } from '../services/dayService';
import { createNote as createDayNote, getNote as getDayNote, updateNote as updateDayNote, deleteNote as deleteDayNote, dayExists as dayNoteExists } from '../services/dayNoteService';
import { createNote as createCollabNote, updateNote as updateCollabNote, deleteNote as deleteCollabNote } from '../services/collabService';
import {
  markCountryVisited, unmarkCountryVisited, createBucketItem, deleteBucketItem,
} from '../services/atlasService';
import { searchPlaces } from '../services/mapsService';

const MAX_MCP_TRIP_DAYS = 90;

const TOOL_ANNOTATIONS_READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOL_ANNOTATIONS_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOL_ANNOTATIONS_DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOL_ANNOTATIONS_NON_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function demoDenied() {
  return { content: [{ type: 'text' as const, text: 'Write operations are disabled in demo mode.' }], isError: true };
}

function noAccess() {
  return { content: [{ type: 'text' as const, text: 'Trip not found or access denied.' }], isError: true };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
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
      const { trip } = createTrip(userId, { title, description, start_date, end_date, currency }, MAX_MCP_TRIP_DAYS);
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
      annotations: TOOL_ANNOTATIONS_WRITE,
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
      const { updatedTrip } = updateTrip(tripId, userId, { title, description, start_date, end_date, currency }, 'user');
      safeBroadcast(tripId, 'trip:updated', { trip: updatedTrip });
      return ok({ trip: updatedTrip });
    }
  );

  server.registerTool(
    'delete_trip',
    {
      description: 'Delete a trip. Only the trip owner can delete it.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!isOwner(tripId, userId)) return noAccess();
      deleteTrip(tripId, userId, 'user');
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
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ include_archived }) => {
      const trips = listTrips(userId, include_archived ? null : 0);
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
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, placeId, name, description, lat, lng, address, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = updatePlace(String(tripId), String(placeId), { name, description, lat, lng, address, notes, website, phone });
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, dayId, placeId, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!dayExists(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      if (!placeExists(placeId, tripId)) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      const assignment = createAssignment(dayId, placeId, notes || null);
      safeBroadcast(tripId, 'assignment:created', { assignment });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, dayId, assignmentId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!assignmentExistsInDay(assignmentId, dayId, tripId))
        return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      deleteAssignment(assignmentId);
      safeBroadcast(tripId, 'assignment:deleted', { assignmentId, dayId });
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, category, total_price, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createBudgetItem(tripId, { category, name, total_price, note });
      safeBroadcast(tripId, 'budget:created', { item });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deleteBudgetItem(itemId, tripId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      safeBroadcast(tripId, 'budget:deleted', { itemId });
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createPackingItem(tripId, { name, category: category || 'General' });
      safeBroadcast(tripId, 'packing:created', { item });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updatePackingItem(tripId, itemId, { checked: checked ? 1 : 0 }, ['checked']);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:updated', { item });
      return ok({ item });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePackingItem(tripId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:deleted', { itemId });
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
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']).describe('Reservation type: "flight", "hotel", "restaurant", "train", "car", "cruise", "event", "tour", "activity", or "other"'),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        day_id: z.number().int().positive().optional(),
        place_id: z.number().int().positive().optional().describe('Hotel place to link (hotel type only)'),
        start_day_id: z.number().int().positive().optional().describe('Check-in day (hotel type only; requires place_id and end_day_id)'),
        end_day_id: z.number().int().positive().optional().describe('Check-out day (hotel type only; requires place_id and start_day_id)'),
        check_in: z.string().max(10).optional().describe('Check-in time (e.g. "15:00", hotel type only)'),
        check_out: z.string().max(10).optional().describe('Check-out time (e.g. "11:00", hotel type only)'),
        assignment_id: z.number().int().positive().optional().describe('Link to a day assignment (restaurant, train, car, cruise, event, tour, activity, other)'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, title, type, reservation_time, location, confirmation_number, notes, day_id, place_id, start_day_id, end_day_id, check_in, check_out, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();

      // Validate that all referenced IDs belong to this trip
      if (day_id && !getDay(day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'day_id does not belong to this trip.' }], isError: true };
      if (place_id && !placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (start_day_id && !getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (end_day_id && !getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };
      if (assignment_id && !getAssignmentForTrip(assignment_id, tripId))
        return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };

      const createAccommodation = (type === 'hotel' && place_id && start_day_id && end_day_id)
        ? { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined, confirmation: confirmation_number || undefined }
        : undefined;

      const { reservation, accommodationCreated } = createReservation(tripId, {
        title, type, reservation_time, location, confirmation_number,
        notes, day_id, place_id, assignment_id,
        create_accommodation: createAccommodation,
      });

      if (accommodationCreated) {
        safeBroadcast(tripId, 'accommodation:created', {});
      }
      safeBroadcast(tripId, 'reservation:created', { reservation });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, reservationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const { deleted, accommodationDeleted } = deleteReservation(reservationId, tripId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      if (accommodationDeleted) {
        safeBroadcast(tripId, 'accommodation:deleted', { accommodationId: deleted.accommodation_id });
      }
      safeBroadcast(tripId, 'reservation:deleted', { reservationId });
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
        check_in: z.string().max(10).optional().describe('Check-in time (e.g. "15:00")'),
        check_out: z.string().max(10).optional().describe('Check-out time (e.g. "11:00")'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, reservationId, place_id, start_day_id, end_day_id, check_in, check_out }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const current = getReservation(reservationId, tripId);
      if (!current) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      if (current.type !== 'hotel') return { content: [{ type: 'text' as const, text: 'Reservation is not of type hotel.' }], isError: true };

      if (!placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (!getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (!getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };

      const isNewAccommodation = !current.accommodation_id;
      const { reservation } = updateReservation(reservationId, tripId, {
        place_id,
        type: current.type,
        status: current.status as string,
        create_accommodation: { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined },
      }, current);

      safeBroadcast(tripId, isNewAccommodation ? 'accommodation:created' : 'accommodation:updated', {});
      safeBroadcast(tripId, 'reservation:updated', { reservation });
      return ok({ reservation, accommodation_id: (reservation as any).accommodation_id });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, assignmentId, place_time, end_time }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getAssignmentForTrip(assignmentId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      const assignment = updateTime(
        assignmentId,
        place_time !== undefined ? place_time : (existing as any).assignment_time,
        end_time !== undefined ? end_time : (existing as any).assignment_end_time
      );
      safeBroadcast(tripId, 'assignment:updated', { assignment });
      return ok({ assignment });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, dayId, title }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const current = getDay(dayId, tripId);
      if (!current) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const updated = updateDay(dayId, current, title !== undefined ? { title } : {});
      safeBroadcast(tripId, 'day:updated', { day: updated });
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
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']).optional().describe('Reservation type: "flight", "hotel", "restaurant", "train", "car", "cruise", "event", "tour", "activity", or "other"'),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        status: z.enum(['pending', 'confirmed', 'cancelled']).optional().describe('Reservation status: "pending", "confirmed", or "cancelled"'),
        place_id: z.number().int().positive().nullable().optional().describe('Link to a place (use for hotel type), or null to unlink'),
        assignment_id: z.number().int().positive().nullable().optional().describe('Link to a day assignment (use for restaurant, train, car, cruise, event, tour, activity, other), or null to unlink'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, reservationId, title, type, reservation_time, location, confirmation_number, notes, status, place_id, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getReservation(reservationId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };

      if (place_id != null && !placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (assignment_id != null && !getAssignmentForTrip(assignment_id, tripId))
        return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };

      const { reservation } = updateReservation(reservationId, tripId, {
        title, type, reservation_time, location, confirmation_number, notes, status,
        place_id: place_id !== undefined ? place_id ?? undefined : undefined,
        assignment_id: assignment_id !== undefined ? assignment_id ?? undefined : undefined,
      }, existing);
      safeBroadcast(tripId, 'reservation:updated', { reservation });
      return ok({ reservation });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, name, category, total_price, persons, days, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updateBudgetItem(itemId, tripId, { name, category, total_price, persons, days, note });
      if (!item) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      safeBroadcast(tripId, 'budget:updated', { item });
      return ok({ item });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bodyKeys = ['name', 'category'].filter(k => k === 'name' ? name !== undefined : category !== undefined);
      const item = updatePackingItem(tripId, itemId, { name, category }, bodyKeys);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:updated', { item });
      return ok({ item });
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, dayId, assignmentIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!getDay(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      reorderAssignments(dayId, assignmentIds);
      safeBroadcast(tripId, 'assignment:reordered', { dayId, assignmentIds });
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
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const summary = getTripSummary(tripId);
      if (!summary) return noAccess();
      return ok(summary);
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ name, lat, lng, country_code, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      const item = createBucketItem(userId, { name, lat, lng, country_code, notes });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const deleted = deleteBucketItem(userId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Bucket list item not found.' }], isError: true };
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      markCountryVisited(userId, country_code.toUpperCase());
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      unmarkCountryVisited(userId, country_code.toUpperCase());
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, title, content, category, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = createCollabNote(tripId, userId, { title, content, category, color });
      safeBroadcast(tripId, 'collab:note:created', { note });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, noteId, title, content, category, color, pinned }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = updateCollabNote(tripId, noteId, { title, content, category, color, pinned });
      if (!note) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      safeBroadcast(tripId, 'collab:note:updated', { note });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deleteCollabNote(tripId, noteId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      safeBroadcast(tripId, 'collab:note:deleted', { noteId });
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
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, dayId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!dayNoteExists(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const note = createDayNote(dayId, tripId, text, time, icon);
      safeBroadcast(tripId, 'dayNote:created', { dayId, note });
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
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, dayId, noteId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getDayNote(noteId, dayId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      const note = updateDayNote(noteId, existing, { text, time: time !== undefined ? time : undefined, icon });
      safeBroadcast(tripId, 'dayNote:updated', { dayId, note });
      return ok({ note });
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
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, dayId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = getDayNote(noteId, dayId, tripId);
      if (!note) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      deleteDayNote(noteId);
      safeBroadcast(tripId, 'dayNote:deleted', { noteId, dayId });
      return ok({ success: true });
    }
  );

  // --- PROMPTS ---

  server.registerPrompt(
    'trip-summary',
    {
      title: 'Trip Summary',
      description: 'Load a full summary of a trip for context before planning or modifications',
      argsSchema: {
        tripId: z.number().int().positive().describe('Trip ID to summarize'),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Trip not found or access denied.' } }] };
      }
      const summary = getTripSummary(tripId);
      if (!summary) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Trip not found.' } }] };
      }
      const { trip, days, members, budget, packing, reservations, collabNotes } = summary;
      const packingStats = packing ? { total: packing.length, packed: packing.filter((p: any) => p.checked).length } : { total: 0, packed: 0 };
      const budgetTotal = budget?.reduce((sum: number, b: any) => sum + (b.total_price || 0), 0) || 0;
      const text = `Trip: ${trip?.title || 'Untitled'}${trip?.description ? `\n${trip.description}` : ''}
Dates: ${trip?.start_date || '?'} to ${trip?.end_date || '?'}
Members: ${members?.length || 0} (${members?.map((m: any) => m.name || m.email).join(', ') || 'none'})
Days: ${days?.length || 0}
Packing: ${packingStats.packed}/${packingStats.total} items packed
Budget: ${budgetTotal} ${trip?.currency || 'EUR'} total
Reservations: ${reservations?.length || 0}
Collab Notes: ${collabNotes?.length || 0}
${days?.map((d: any, i: number) => `Day ${i + 1} (${d.date}): ${d.assignments?.length || 0} places${d.title ? ` - ${d.title}` : ''}`).join('\n') || 'No days yet'}`;
      return {
        description: `Summary of trip "${trip?.title || tripId}"`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    }
  );

  server.registerPrompt(
    'packing-list',
    {
      title: 'Packing List',
      description: 'Get a formatted packing checklist for a trip',
      argsSchema: {
        tripId: z.number().int().positive().describe('Trip ID'),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Trip not found or access denied.' } }] };
      }
      const { listPackingItems } = await import('../services/packingService');
      const items = listPackingItems(tripId);
      if (!items.length) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'No packing items found for this trip.' } }] };
      }
      const grouped = items.reduce((acc: Record<string, any[]>, item: any) => {
        const cat = item.category || 'General';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
      }, {});
      const lines = Object.entries(grouped).map(([cat, items]) =>
        `## ${cat}\n${(items as any[]).map((i: any) => `- [${i.checked ? 'x' : ' '}] ${i.name}`).join('\n')}`
      ).join('\n\n');
      const { trip } = getTripSummary(tripId) || {};
      return {
        description: `Packing list for "${trip?.title || tripId}"`,
        messages: [{ role: 'user', content: { type: 'text', text: `# Packing List: ${trip?.title || 'Trip'}\n\n${lines}\n\n_${items.length} items across ${Object.keys(grouped).length} categories_` } }],
      };
    }
  );

  server.registerPrompt(
    'budget-overview',
    {
      title: 'Budget Overview',
      description: 'Get a formatted budget summary for a trip',
      argsSchema: {
        tripId: z.number().int().positive().describe('Trip ID'),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Trip not found or access denied.' } }] };
      }
      const summary = getTripSummary(tripId);
      if (!summary) {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Trip not found.' } }] };
      }
      const { trip, budget } = summary;
      const currency = trip?.currency || 'EUR';
      const byCategory = (budget || []).reduce((acc: Record<string, number>, item: any) => {
        const cat = item.category || 'Uncategorized';
        acc[cat] = (acc[cat] || 0) + (item.total_price || 0);
        return acc;
      }, {} as Record<string, number>);
      const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
      const lines = Object.entries(byCategory)
        .sort(([, a], [, b]) => b - a)
        .map(([cat, amount]) => `- ${cat}: ${amount} ${currency}`)
        .join('\n');
      const perPerson = (summary.members?.length || 1) > 0 ? (total / (summary.members?.length || 1)).toFixed(2) : total.toFixed(2);
      return {
        description: `Budget overview for "${trip?.title || tripId}"`,
        messages: [{ role: 'user', content: { type: 'text', text: `# Budget: ${trip?.title || 'Trip'}\n\n**Total: ${total} ${currency}** (${perPerson} ${currency} per person)\n\n${lines || 'No expenses recorded.'}` } }],
      };
    }
  );
}
