import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  getDay, updateDay, validateAccommodationRefs,
  createDay, deleteDay,
  createAccommodation, getAccommodation, updateAccommodation, deleteAccommodation,
} from '../../services/dayService';
import {
  createNote as createDayNote, getNote as getDayNote, updateNote as updateDayNote,
  deleteNote as deleteDayNote, dayExists as dayNoteExists,
} from '../../services/dayNoteService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerDayTools(server: McpServer, userId: number): void {
  // --- DAYS ---

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

  server.registerTool(
    'create_day',
    {
      description: 'Add a new day to a trip (optionally with a specific date and notes).',
      inputSchema: {
        tripId: z.number().int().positive(),
        date: z.string().optional().describe('ISO date string YYYY-MM-DD, optional for dateless trips'),
        notes: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, date, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const day = createDay(tripId, date, notes);
      safeBroadcast(tripId, 'day:created', { day });
      return ok({ day });
    }
  );

  server.registerTool(
    'delete_day',
    {
      description: 'Delete a day from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, dayId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      deleteDay(dayId);
      safeBroadcast(tripId, 'day:deleted', { id: dayId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'create_accommodation',
    {
      description: 'Add an accommodation (hotel, Airbnb, etc.) to a trip, linked to a place and a date range.',
      inputSchema: {
        tripId: z.number().int().positive(),
        place_id: z.number().int().positive().describe('The place to use as the accommodation'),
        start_day_id: z.number().int().positive().describe('Check-in day ID'),
        end_day_id: z.number().int().positive().describe('Check-out day ID'),
        check_in: z.string().max(10).optional().describe('Check-in time e.g. "15:00"'),
        check_out: z.string().max(10).optional().describe('Check-out time e.g. "11:00"'),
        confirmation: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const errors = validateAccommodationRefs(tripId, place_id, start_day_id, end_day_id);
      if (errors.length > 0) return { content: [{ type: 'text' as const, text: errors.map(e => e.message).join(', ') }], isError: true };
      const accommodation = createAccommodation(tripId, { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes });
      safeBroadcast(tripId, 'accommodation:created', { accommodation });
      return ok({ accommodation });
    }
  );

  server.registerTool(
    'update_accommodation',
    {
      description: 'Update fields on an existing accommodation.',
      inputSchema: {
        tripId: z.number().int().positive(),
        accommodationId: z.number().int().positive(),
        place_id: z.number().int().positive().optional(),
        start_day_id: z.number().int().positive().optional(),
        end_day_id: z.number().int().positive().optional(),
        check_in: z.string().max(10).optional(),
        check_out: z.string().max(10).optional(),
        confirmation: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, accommodationId, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getAccommodation(accommodationId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Accommodation not found.' }], isError: true };
      const accommodation = updateAccommodation(accommodationId, existing, { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes });
      safeBroadcast(tripId, 'accommodation:updated', { accommodation });
      return ok({ accommodation });
    }
  );

  server.registerTool(
    'delete_accommodation',
    {
      description: 'Delete an accommodation from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        accommodationId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, accommodationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const { linkedReservationId } = deleteAccommodation(accommodationId);
      safeBroadcast(tripId, 'accommodation:deleted', { id: accommodationId, linkedReservationId });
      return ok({ success: true, linkedReservationId });
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
}
