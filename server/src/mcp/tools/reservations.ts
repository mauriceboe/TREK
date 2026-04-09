import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  createReservation, getReservation, updateReservation, deleteReservation,
  updatePositions as updateReservationPositions,
} from '../../services/reservationService';
import { getDay } from '../../services/dayService';
import { placeExists, getAssignmentForTrip } from '../../services/assignmentService';
import {
  safeBroadcast, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';

export function registerReservationTools(server: McpServer, userId: number): void {

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
    'reorder_reservations',
    {
      description: 'Update the display order of reservations within a day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        positions: z.array(z.object({
          id: z.number().int().positive(),
          day_plan_position: z.number().int().min(0),
        })).describe('Array of { id, day_plan_position } pairs'),
        dayId: z.number().int().positive().optional().describe('Optionally scope the update to a specific day'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, positions, dayId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      updateReservationPositions(tripId, positions, dayId);
      safeBroadcast(tripId, 'reservation:positions', { positions, dayId });
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
}
