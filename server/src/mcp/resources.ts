import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp';
import { canAccessTrip } from '../db/database';
import { listTrips, getTrip, getTripOwner, listMembers } from '../services/tripService';
import { listDays, listAccommodations } from '../services/dayService';
import { listPlaces } from '../services/placeService';
import { listBudgetItems } from '../services/budgetService';
import { listItems as listPackingItems } from '../services/packingService';
import { listReservations } from '../services/reservationService';
import { listNotes as listDayNotes } from '../services/dayNoteService';
import { listNotes as listCollabNotes } from '../services/collabService';
import { listCategories } from '../services/categoryService';
import { listBucketList, listVisitedCountries } from '../services/atlasService';

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
}
