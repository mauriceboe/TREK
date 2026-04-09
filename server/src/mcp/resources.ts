import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp';
import { canAccessTrip } from '../db/database';
import { listTrips, getTrip, getTripOwner, listMembers } from '../services/tripService';
import { listDays, listAccommodations } from '../services/dayService';
import { listPlaces } from '../services/placeService';
import { listBudgetItems, getPerPersonSummary, calculateSettlement } from '../services/budgetService';
import { listItems as listPackingItems, listBags } from '../services/packingService';
import { listReservations } from '../services/reservationService';
import { listNotes as listDayNotes } from '../services/dayNoteService';
import { listNotes as listCollabNotes, listPolls, listMessages } from '../services/collabService';
import { listItems as listTodoItems } from '../services/todoService';
import { listFiles } from '../services/fileService';
import { listCategories } from '../services/categoryService';
import { listBucketList, listVisitedCountries, getStats as getAtlasStats, listManuallyVisitedRegions } from '../services/atlasService';
import { getNotifications } from '../services/inAppNotifications';
import { getActivePlanId, getActivePlan, getPlanData, getEntries as getVacayEntries, getHolidays } from '../services/vacayService';
import { isAddonEnabled } from '../services/adminService';

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
    { description: 'All trips the user owns or is a member of', mimeType: 'application/json' },
    async (uri) => {
      const trips = listTrips(userId, 0);
      return jsonContent(uri.href, trips);
    }
  );

  // Single trip detail
  server.registerResource(
    'trip',
    new ResourceTemplate('trek://trips/{tripId}', { list: undefined }),
    { description: 'A single trip with metadata and member count', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const trip = getTrip(id, userId);
      return jsonContent(uri.href, trip);
    }
  );

  // Days with assigned places
  server.registerResource(
    'trip-days',
    new ResourceTemplate('trek://trips/{tripId}/days', { list: undefined }),
    { description: 'Days of a trip with their assigned places', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);

      const { days } = listDays(id);
      return jsonContent(uri.href, days);
    }
  );

  // Places in a trip
  server.registerResource(
    'trip-places',
    new ResourceTemplate('trek://trips/{tripId}/places', { list: undefined }),
    { description: 'All places/POIs in a trip, optionally filtered by assignment status (e.g. ?assignment=unassigned)', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const assignment = uri.searchParams.get('assignment') as 'all' | 'unassigned' | 'assigned' | null;
      const places = listPlaces(String(id), { assignment: assignment ?? undefined });
      return jsonContent(uri.href, places);
    }
  );

  // Budget items
  server.registerResource(
    'trip-budget',
    new ResourceTemplate('trek://trips/{tripId}/budget', { list: undefined }),
    { description: 'Budget and expense items for a trip', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const items = listBudgetItems(id);
      return jsonContent(uri.href, items);
    }
  );

  // Packing checklist
  server.registerResource(
    'trip-packing',
    new ResourceTemplate('trek://trips/{tripId}/packing', { list: undefined }),
    { description: 'Packing checklist for a trip', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const items = listPackingItems(id);
      return jsonContent(uri.href, items);
    }
  );

  // Reservations (flights, hotels, restaurants)
  server.registerResource(
    'trip-reservations',
    new ResourceTemplate('trek://trips/{tripId}/reservations', { list: undefined }),
    { description: 'Reservations (flights, hotels, restaurants) for a trip', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const reservations = listReservations(id);
      return jsonContent(uri.href, reservations);
    }
  );

  // Day notes
  server.registerResource(
    'day-notes',
    new ResourceTemplate('trek://trips/{tripId}/days/{dayId}/notes', { list: undefined }),
    { description: 'Notes for a specific day in a trip', mimeType: 'application/json' },
    async (uri, { tripId, dayId }) => {
      const tId = parseId(tripId);
      const dId = parseId(dayId);
      if (tId === null || dId === null || !canAccessTrip(tId, userId)) return accessDenied(uri.href);
      const notes = listDayNotes(dId, tId);
      return jsonContent(uri.href, notes);
    }
  );

  // Accommodations (hotels, rentals) per trip
  server.registerResource(
    'trip-accommodations',
    new ResourceTemplate('trek://trips/{tripId}/accommodations', { list: undefined }),
    { description: 'Accommodations (hotels, rentals) for a trip with check-in/out details', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const accommodations = listAccommodations(id);
      return jsonContent(uri.href, accommodations);
    }
  );

  // Trip members (owner + collaborators)
  server.registerResource(
    'trip-members',
    new ResourceTemplate('trek://trips/{tripId}/members', { list: undefined }),
    { description: 'Owner and collaborators of a trip', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const ownerRow = getTripOwner(id);
      if (!ownerRow) return accessDenied(uri.href);
      const { owner, members } = listMembers(id, ownerRow.user_id);
      return jsonContent(uri.href, { owner, members });
    }
  );

  // Collab notes for a trip
  server.registerResource(
    'trip-collab-notes',
    new ResourceTemplate('trek://trips/{tripId}/collab-notes', { list: undefined }),
    { description: 'Shared collaborative notes for a trip', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const notes = listCollabNotes(id);
      return jsonContent(uri.href, notes);
    }
  );

  // Trip files (active, not trash)
  server.registerResource(
    'trip-files',
    new ResourceTemplate('trek://trips/{tripId}/files', { list: undefined }),
    { description: 'Active files attached to a trip (excludes trash)', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const files = listFiles(id, false);
      return jsonContent(uri.href, files);
    }
  );

  // Trip to-do list
  server.registerResource(
    'trip-todos',
    new ResourceTemplate('trek://trips/{tripId}/todos', { list: undefined }),
    { description: 'To-do items for a trip, ordered by position', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const items = listTodoItems(id);
      return jsonContent(uri.href, items);
    }
  );

  // All place categories (global, no trip filter)
  server.registerResource(
    'categories',
    'trek://categories',
    { description: 'All available place categories (id, name, color, icon) for use when creating places', mimeType: 'application/json' },
    async (uri) => {
      const categories = listCategories();
      return jsonContent(uri.href, categories);
    }
  );

  // User's bucket list
  server.registerResource(
    'bucket-list',
    'trek://bucket-list',
    { description: 'Your personal travel bucket list', mimeType: 'application/json' },
    async (uri) => {
      const items = listBucketList(userId);
      return jsonContent(uri.href, items);
    }
  );

  // User's visited countries
  server.registerResource(
    'visited-countries',
    'trek://visited-countries',
    { description: 'Countries you have marked as visited in Atlas', mimeType: 'application/json' },
    async (uri) => {
      const countries = listVisitedCountries(userId);
      return jsonContent(uri.href, countries);
    }
  );

  // Budget per-person summary
  server.registerResource(
    'trip-budget-per-person',
    new ResourceTemplate('trek://trips/{tripId}/budget/per-person', { list: undefined }),
    { description: 'Per-person budget summary for a trip (total spent per member, split breakdown)', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const summary = getPerPersonSummary(id);
      return jsonContent(uri.href, summary);
    }
  );

  // Budget settlement
  server.registerResource(
    'trip-budget-settlement',
    new ResourceTemplate('trek://trips/{tripId}/budget/settlement', { list: undefined }),
    { description: 'Suggested settlement transactions to balance who owes whom', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const settlement = calculateSettlement(id);
      return jsonContent(uri.href, settlement);
    }
  );

  // Packing bags
  server.registerResource(
    'trip-packing-bags',
    new ResourceTemplate('trek://trips/{tripId}/packing/bags', { list: undefined }),
    { description: 'All packing bags for a trip with their members', mimeType: 'application/json' },
    async (uri, { tripId }) => {
      const id = parseId(tripId);
      if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
      const bags = listBags(id);
      return jsonContent(uri.href, bags);
    }
  );

  // In-app notifications
  server.registerResource(
    'notifications-in-app',
    'trek://notifications/in-app',
    { description: "The current user's in-app notifications (most recent 50, unread first)", mimeType: 'application/json' },
    async (uri) => {
      const result = getNotifications(userId, { limit: 50 });
      return jsonContent(uri.href, result);
    }
  );

  // Atlas stats and regions (addon-gated)
  if (isAddonEnabled('atlas')) {
    server.registerResource(
      'atlas-stats',
      'trek://atlas/stats',
      { description: "User's atlas statistics — visited country counts and breakdown", mimeType: 'application/json' },
      async (uri) => {
        const stats = await getAtlasStats(userId);
        return jsonContent(uri.href, stats);
      }
    );

    server.registerResource(
      'atlas-regions',
      'trek://atlas/regions',
      { description: 'List of manually visited regions for the current user', mimeType: 'application/json' },
      async (uri) => {
        const regions = listManuallyVisitedRegions(userId);
        return jsonContent(uri.href, regions);
      }
    );
  }

  // Collab polls & messages (addon-gated)
  if (isAddonEnabled('collab')) {
    server.registerResource(
      'trip-collab-polls',
      new ResourceTemplate('trek://trips/{tripId}/collab/polls', { list: undefined }),
      { description: 'All polls for a trip with vote counts per option', mimeType: 'application/json' },
      async (uri, { tripId }) => {
        const id = parseId(tripId);
        if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
        const polls = listPolls(id);
        return jsonContent(uri.href, polls);
      }
    );

    server.registerResource(
      'trip-collab-messages',
      new ResourceTemplate('trek://trips/{tripId}/collab/messages', { list: undefined }),
      { description: 'Most recent 100 chat messages for a trip', mimeType: 'application/json' },
      async (uri, { tripId }) => {
        const id = parseId(tripId);
        if (id === null || !canAccessTrip(id, userId)) return accessDenied(uri.href);
        const messages = listMessages(id);
        return jsonContent(uri.href, messages);
      }
    );
  }

  // Vacay resources (addon-gated)
  if (isAddonEnabled('vacay')) {
    server.registerResource(
      'vacay-plan',
      'trek://vacay/plan',
      { description: "Full snapshot of the user's active vacation plan (members, years, settings)", mimeType: 'application/json' },
      async (uri) => {
        const plan = getPlanData(userId);
        return jsonContent(uri.href, plan);
      }
    );

    server.registerResource(
      'vacay-entries',
      new ResourceTemplate('trek://vacay/entries/{year}', { list: undefined }),
      { description: 'All vacation entries for the active plan and a specific year', mimeType: 'application/json' },
      async (uri, { year }) => {
        const planId = getActivePlanId(userId);
        const entries = getVacayEntries(planId, Array.isArray(year) ? year[0] : year);
        return jsonContent(uri.href, entries);
      }
    );

    server.registerResource(
      'vacay-holidays',
      new ResourceTemplate('trek://vacay/holidays/{year}', { list: undefined }),
      { description: "Cached public holidays for the plan's configured region and year", mimeType: 'application/json' },
      async (uri, { year }) => {
        const plan = getActivePlan(userId);
        if (!plan.holidays_enabled || !plan.holidays_region) return jsonContent(uri.href, []);
        const yearStr = Array.isArray(year) ? year[0] : year;
        const result = await getHolidays(yearStr, plan.holidays_region);
        return jsonContent(uri.href, result.data ?? []);
      }
    );
  }
}
