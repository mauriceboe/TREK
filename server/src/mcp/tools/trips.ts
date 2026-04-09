import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  listTrips, createTrip, updateTrip, deleteTrip, getTripSummary,
  isOwner, verifyTripAccess,
  listMembers as listTripMembers, getTripOwner, addMember as addTripMember,
  removeMember as removeTripMember,
  copyTripById, exportICS, NotFoundError, ValidationError,
} from '../../services/tripService';
import {
  createOrUpdateShareLink, getShareLink, deleteShareLink,
} from '../../services/shareService';
import { isAddonEnabled } from '../../services/adminService';
import { countMessages, listPolls } from '../../services/collabService';
import {
  listItems as listTodoItems,
} from '../../services/todoService';
import { listFiles } from '../../services/fileService';
import {
  safeBroadcast, MAX_MCP_TRIP_DAYS,
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerTripTools(server: McpServer, userId: number): void {
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
      const todos = listTodoItems(tripId);
      const files = listFiles(tripId, false).map((f: any) => ({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        file_size: f.file_size,
        starred: !!f.starred,
        deleted: !!f.deleted_at,
        created_at: f.created_at,
      }));
      let pollCount = 0;
      if (isAddonEnabled('collab')) {
        pollCount = listPolls(tripId).length;
      }
      let messageCount = 0;
      if (isAddonEnabled('collab')) {
        messageCount = countMessages(tripId);
      }
      return ok({ ...summary, todos, files, pollCount, messageCount });
    }
  );

  // --- TRIP MEMBERS, COPY, ICS, SHARE ---

  server.registerTool(
    'list_trip_members',
    {
      description: 'List all members of a trip (owner + collaborators).',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const ownerRow = getTripOwner(tripId);
      if (!ownerRow) return noAccess();
      const { owner, members } = listTripMembers(tripId, ownerRow.user_id);
      return ok({ owner, members });
    }
  );

  server.registerTool(
    'add_trip_member',
    {
      description: 'Add a user to a trip by their username or email address. Only the trip owner can do this.',
      inputSchema: {
        tripId: z.number().int().positive(),
        identifier: z.string().min(1).describe('Username or email of the user to add'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, identifier }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const ownerRow = getTripOwner(tripId);
      if (!ownerRow || ownerRow.user_id !== userId)
        return { content: [{ type: 'text' as const, text: 'Only the trip owner can add members.' }], isError: true };
      try {
        const result = addTripMember(tripId, identifier, ownerRow.user_id, userId);
        safeBroadcast(tripId, 'member:added', { member: result.member });
        return ok({ member: result.member });
      } catch (err) {
        const msg = err instanceof ValidationError || err instanceof NotFoundError ? err.message : 'Failed to add member.';
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }
  );

  server.registerTool(
    'remove_trip_member',
    {
      description: 'Remove a member from a trip. Only the trip owner can do this.',
      inputSchema: {
        tripId: z.number().int().positive(),
        memberId: z.number().int().positive().describe('User ID of the member to remove'),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, memberId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const ownerRow = getTripOwner(tripId);
      if (!ownerRow || ownerRow.user_id !== userId)
        return { content: [{ type: 'text' as const, text: 'Only the trip owner can remove members.' }], isError: true };
      removeTripMember(tripId, memberId);
      safeBroadcast(tripId, 'member:removed', { userId: memberId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'copy_trip',
    {
      description: 'Duplicate a trip (all days, places, itinerary, packing, budget, reservations, day notes). Packing items are reset to unchecked. Returns the new trip.',
      inputSchema: {
        tripId: z.number().int().positive().describe('Source trip ID to duplicate'),
        title: z.string().min(1).max(200).optional().describe('Title for the new trip (defaults to source title)'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, title }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      try {
        const newTripId = copyTripById(tripId, userId, title);
        const newTrip = canAccessTrip(newTripId, userId);
        return ok({ trip: { id: newTripId, ...newTrip } });
      } catch {
        return { content: [{ type: 'text' as const, text: 'Failed to copy trip.' }], isError: true };
      }
    }
  );

  server.registerTool(
    'export_trip_ics',
    {
      description: 'Export a trip\'s itinerary and reservations as iCalendar (.ics) format text. Useful for importing into calendar apps.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      try {
        const { ics, filename } = exportICS(tripId);
        return ok({ ics, filename });
      } catch {
        return { content: [{ type: 'text' as const, text: 'Trip not found.' }], isError: true };
      }
    }
  );

  server.registerTool(
    'get_share_link',
    {
      description: 'Get the current public share link for a trip, including its permission flags. Returns null if no share link exists.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const link = getShareLink(String(tripId));
      return ok({ link });
    }
  );

  server.registerTool(
    'create_share_link',
    {
      description: 'Create or update the public share link for a trip. Set permission flags to control what is visible to guests.',
      inputSchema: {
        tripId: z.number().int().positive(),
        share_map: z.boolean().optional().default(true).describe('Share the map and places'),
        share_bookings: z.boolean().optional().default(true).describe('Share reservations'),
        share_packing: z.boolean().optional().default(false).describe('Share packing list'),
        share_budget: z.boolean().optional().default(false).describe('Share budget'),
        share_collab: z.boolean().optional().default(false).describe('Share collab messages'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, share_map, share_bookings, share_packing, share_budget, share_collab }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const { token, created } = createOrUpdateShareLink(String(tripId), userId, {
        share_map: share_map ?? true,
        share_bookings: share_bookings ?? true,
        share_packing: share_packing ?? false,
        share_budget: share_budget ?? false,
        share_collab: share_collab ?? false,
      });
      return ok({ token, created });
    }
  );

  server.registerTool(
    'delete_share_link',
    {
      description: 'Revoke the public share link for a trip. Guests will no longer be able to access the shared view.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      deleteShareLink(String(tripId));
      return ok({ success: true });
    }
  );
}
