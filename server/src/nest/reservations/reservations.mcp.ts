import {
  McpController, Tool, ResourceTemplate, type McpContext,
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, errorResult, ok,
} from '../../nest-mcp';
import { McpToolGuardsService } from '../mcp-shared/mcp-tool-guards.service';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { BudgetService } from '../budget/budget.service';
import { noAccess, permissionDenied } from '../../mcp/tools/_shared';
import { ReservationsService } from './reservations.service';
import { DaysService } from '../days/days.service';
import { findByIata } from '../airports/airports.data';
import type { EndpointInput } from './reservations.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { transportLegsInputSchema, reservationUrlSchema, type TransportLegInput } from '@trek/shared';

// What counts as a transport booking, for the update_transport gate. Every value
// ReservationsPanel renders with a transport icon, so a stored `transit` row is
// editable through the transport tools like any other.
const TRANSPORT_TYPES = ['flight', 'train', 'bus', 'car', 'taxi', 'bicycle', 'cruise', 'ferry', 'transit', 'transport_other'] as const;
// What a caller may ASK for, which is the transport form's own picker
// (client/src/components/Planner/TransportModal.tsx), in its order. The tools
// below used to accept four of these nine, so a bus or a ferry could be planned
// in the UI and not through an assistant.
//
// `transit` is deliberately absent: the picker does not offer it either. A transit
// booking carries a provider itinerary in metadata.transit, and create_transit_journey
// is what writes one. A hand-made `transit` row would be a shape the transit UI
// does not expect.
const CREATABLE_TRANSPORT_TYPES = ['flight', 'train', 'bus', 'car', 'taxi', 'bicycle', 'cruise', 'ferry', 'transport_other'] as const;
/** Only these two carry per-segment detail: the transport form writes metadata.legs for a flight or a train and for nothing else. */
const LEG_TRANSPORT_TYPES = ['flight', 'train'] as const;
/** Everything the picker offers that is not a transport: create_reservation's half. */
const BOOKING_TYPES = ['hotel', 'restaurant', 'event', 'tour', 'activity', 'parking', 'other'] as const;

/**
 * The booking link. Same refinement the REST contract applies
 * (shared/src/reservation/reservation.schema.ts), so a javascript:/data:/vbscript:
 * URL is refused on this surface too rather than being stored and later rendered
 * as an href.
 */
const urlField = reservationUrlSchema.max(2000).optional()
  .describe('Link to the booking: the airline/hotel confirmation page, the ticket. Shown as a link on the booking.');

type TransportType = typeof CREATABLE_TRANSPORT_TYPES[number];
type BookingType = typeof BOOKING_TYPES[number];

const endpointObjectSchema = z.object({
  role: z.enum(['from', 'to', 'stop']).describe('Endpoint role: "from" (origin), "to" (destination), or "stop" (intermediate)'),
  sequence: z.number().int().min(0).describe('Order within the route (0-based)'),
  name: z.string().min(1).describe('Location name (e.g. "Paris Gare de Lyon", "ZRH Terminal 2")'),
  code: z.string().optional().describe('IATA airport code for flights (e.g. "ZRH"). Leave empty for other transport types.'),
  lat: z.number().optional().describe('Latitude. For flights, leave empty and set code instead — coordinates are filled from the airport.'),
  lng: z.number().optional().describe('Longitude. For flights, leave empty and set code instead — coordinates are filled from the airport.'),
  timezone: z.string().optional().describe('IANA timezone (e.g. "Europe/Zurich"). Use airport tz for flights.'),
  local_time: z.string().optional().describe('Local departure/arrival time at this endpoint, e.g. "14:35"'),
  local_date: z.string().optional().describe('Local date at this endpoint, YYYY-MM-DD'),
});
const endpointSchema = z.array(endpointObjectSchema).optional();

type TransportEndpoint = z.infer<typeof endpointObjectSchema>;

/**
 * Endpoint coordinates are stored NOT NULL. Callers may supply a flight endpoint
 * with only an IATA `code` (the tool description encourages this), so fill missing
 * lat/lng/timezone from the airport database. Returns an error string for the first
 * endpoint that can't be resolved rather than letting the NOT NULL bind throw.
 *
 * Normalizes to the service's EndpointInput shape (nullable fields coerced from the
 * schema's optionals), so lat/lng are guaranteed present before the insert.
 */
function resolveEndpointCoords(endpoints: TransportEndpoint[] | undefined): { endpoints: EndpointInput[] } | { error: string } {
  if (!endpoints) return { endpoints: [] };
  const out: EndpointInput[] = [];
  for (const e of endpoints) {
    const base = {
      role: e.role,
      sequence: e.sequence,
      name: e.name,
      code: e.code ?? null,
      timezone: e.timezone ?? null,
      local_time: e.local_time ?? null,
      local_date: e.local_date ?? null,
    };
    if (e.lat != null && e.lng != null) { out.push({ ...base, lat: e.lat, lng: e.lng }); continue; }
    if (e.code) {
      const airport = findByIata(e.code);
      if (airport) {
        out.push({ ...base, lat: airport.lat, lng: airport.lng, timezone: e.timezone ?? airport.tz });
        continue;
      }
      return { error: `Could not resolve airport code "${e.code}". Use search_airports to find a valid IATA code, or supply lat/lng directly.` };
    }
    return { error: `Endpoint "${e.name}" is missing coordinates. For flights set "code" to the IATA airport code; for other transport types supply lat/lng.` };
  }
  return { endpoints: out };
}

function parseId(value: string | string[]): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Multi-leg bookings (#1914)
//
// A stopover booking splits over two stores: the endpoints hold the geometry,
// `metadata.legs` holds each segment's own day, time and airline/train identity.
// The endpoint of a stop carries the ONWARD DEPARTURE only (the planner form
// writes `isLast ? arrTime : depTime`), so without legs the arrival at that stop
// exists nowhere and every reader falls back to showing one time twice, which is
// the symptom in the report. These helpers accept the same leg shape the form
// and the importers write, and keep the two stores in step.
// ---------------------------------------------------------------------------

const legsSchema = transportLegsInputSchema.optional().describe(
  'Per-segment detail of a stopover flight or train: one entry per segment, in route order, exactly ONE FEWER than endpoints[]. '
  + 'Each leg carries its own departure and arrival day + local time (dep_day_id/dep_time, arr_day_id/arr_time) plus airline/flight_number (flights) or train_number/platform (trains). '
  + 'A leg may also carry its own confirmation_number when that segment was issued a separate booking reference; leave it out and the booking-level confirmation_number covers the segment. '
  + "Required for a booking with stopovers: a stop's endpoint stores only the onward departure, so without legs that one time is shown as both the arrival and the departure. "
  + 'Omit it for a direct booking. Blank endpoint times/dates, day_id/end_day_id and reservation_time are derived from the legs; a value that contradicts them is rejected.'
);

type MetaRecord = Record<string, unknown>;

/**
 * `reservations.metadata` as stored: a JSON string, or (from an old
 * double-encoding bug the client readers still heal around) a JSON string of a
 * JSON string. Reading it must never throw: a booking with unparseable metadata
 * still has to accept a legs update.
 */
function parseStoredMetadata(raw: unknown): MetaRecord {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return typeof parsed === 'object' && parsed !== null ? parsed as MetaRecord : {};
  } catch {
    return {};
  }
}

interface LegPlan {
  legs: TransportLegInput[];
  type: string;
  /** Resolved geometry the legs run over (one more entry than legs). */
  endpoints: EndpointInput[];
  baseMetadata: MetaRecord;
  /** Stored legs of the same booking, for the day-planner positions. */
  previousLegs: unknown[];
  startDayId?: number;
  endDayId?: number;
  reservationTime?: string;
  reservationEndTime?: string;
  // A day row carries an optional date, so the caller cannot promise one. Every
  // read below treats a dateless day as "no date known" rather than stamping undefined.
  lookupDay: (id: number) => { date?: string | null } | undefined;
}

interface LegOutcome {
  metadata: MetaRecord;
  endpoints: EndpointInput[];
  /** True when a blank endpoint time/date was filled in from the legs. */
  endpointsChanged: boolean;
  day_id?: number;
  end_day_id?: number;
  reservation_time?: string;
  reservation_end_time?: string;
}

/**
 * Validate the legs against the endpoints and fold them into the metadata.
 * Returns the values the write should use, or the first error as text.
 */
function applyLegs(plan: LegPlan): LegOutcome | { error: string } {
  const { legs, lookupDay } = plan;
  const last = legs.length - 1;

  if (!(LEG_TRANSPORT_TYPES as readonly string[]).includes(plan.type))
    return { error: 'legs are only supported for flight and train bookings.' };
  // Readers treat legs.length > 1 as the multi-segment marker and the form drops
  // a single-leg list on the next save, so a 1-entry list would be inert.
  if (legs.length < 2)
    return { error: 'legs describes a booking with at least one stopover, so it needs at least 2 entries. Omit legs for a direct booking.' };
  if (plan.endpoints.length !== legs.length + 1)
    return { error: `legs must contain exactly one entry fewer than endpoints (got ${legs.length} legs for ${plan.endpoints.length} endpoints).` };

  for (let i = 0; i < legs.length; i++) {
    for (const field of ['dep_day_id', 'arr_day_id'] as const) {
      const dayId = legs[i][field];
      if (dayId != null && !lookupDay(dayId))
        return { error: `legs[${i}].${field} does not belong to this trip.` };
    }
  }

  const firstDepDay = legs[0].dep_day_id ?? null;
  const lastArrDay = legs[last].arr_day_id ?? null;
  if (plan.startDayId != null && firstDepDay != null && plan.startDayId !== firstDepDay)
    return { error: `start_day_id (${plan.startDayId}) does not match legs[0].dep_day_id (${firstDepDay}).` };
  if (plan.endDayId != null && lastArrDay != null && plan.endDayId !== lastArrDay)
    return { error: `end_day_id (${plan.endDayId}) does not match legs[${last}].arr_day_id (${lastArrDay}).` };

  const endpoints = plan.endpoints.map(e => ({ ...e }));
  let endpointsChanged = false;
  const syncEndpoint = (index: number, time: string | null | undefined, dayId: number | null | undefined, label: string): string | null => {
    const ep = endpoints[index];
    if (dayId != null && !ep.local_date) {
      const day = lookupDay(dayId);
      if (day?.date) { ep.local_date = day.date; endpointsChanged = true; }
    }
    if (!time) return null;
    if (!ep.local_time) { ep.local_time = time; endpointsChanged = true; return null; }
    if (ep.local_time !== time)
      return `${label} (${time}) does not match endpoints[${index}].local_time (${ep.local_time}). A stop's endpoint carries the onward departure time; only the final endpoint carries an arrival time.`;
    return null;
  };

  const merged: MetaRecord[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const depEp = endpoints[i];
    const arrEp = endpoints[i + 1];
    // Codes only: a train endpoint is a free-text station label, and comparing
    // those would reject perfectly good input over a spelling difference.
    if (leg.from && depEp.code && leg.from.toUpperCase() !== depEp.code.toUpperCase())
      return { error: `legs[${i}].from (${leg.from}) does not match endpoints[${i}] (${depEp.code}).` };
    if (leg.to && arrEp.code && leg.to.toUpperCase() !== arrEp.code.toUpperCase())
      return { error: `legs[${i}].to (${leg.to}) does not match endpoints[${i + 1}] (${arrEp.code}).` };

    const depConflict = syncEndpoint(i, leg.dep_time, leg.dep_day_id, `legs[${i}].dep_time`);
    if (depConflict) return { error: depConflict };

    const entry: MetaRecord = {
      from: leg.from ?? depEp.code ?? depEp.name,
      to: leg.to ?? arrEp.code ?? arrEp.name,
    };
    for (const key of ['airline', 'flight_number', 'train_number', 'platform', 'seat', 'confirmation_number'] as const) {
      const value = leg[key];
      if (value) entry[key] = value;
    }
    entry.dep_day_id = leg.dep_day_id ?? null;
    entry.dep_time = leg.dep_time ?? null;
    entry.arr_day_id = leg.arr_day_id ?? null;
    entry.arr_time = leg.arr_time ?? null;
    // day_positions belongs to the day planner, not to this input, so carry the
    // stored value at the same index over, exactly as a form re-save does.
    const positions = (plan.previousLegs[i] as MetaRecord | undefined)?.day_positions;
    if (positions) entry.day_positions = positions;
    merged.push(entry);
  }

  const arrConflict = syncEndpoint(legs.length, legs[last].arr_time, lastArrDay, `legs[${last}].arr_time`);
  if (arrConflict) return { error: arrConflict };

  const metadata: MetaRecord = { ...plan.baseMetadata, legs: merged };
  const first = merged[0];
  const final = merged[last];
  // Mirror the flat keys off the first/last leg the way the form and the
  // importers do, so readers that never learned about legs keep working. Never
  // overwrite what the caller set itself.
  const mirror = (key: string, value: unknown) => {
    if (value != null && metadata[key] == null) metadata[key] = value;
  };
  if (plan.type === 'flight') {
    mirror('departure_airport', first.from);
    mirror('arrival_airport', final.to);
    mirror('airline', first.airline);
    mirror('flight_number', first.flight_number);
  } else {
    mirror('train_number', first.train_number);
    mirror('platform', first.platform);
  }
  mirror('seat', first.seat);

  const dayId = plan.startDayId ?? firstDepDay ?? undefined;
  const endDayId = plan.endDayId ?? lastArrDay ?? undefined;
  // Same fallback as the form's buildTime: date the time when the day is known,
  // otherwise keep the bare 'HH:mm' rather than dropping it.
  const stamp = (day: number | undefined, time: string | null | undefined) => {
    if (!time) return undefined;
    const row = day === undefined ? undefined : lookupDay(day);
    return row?.date ? `${row.date}T${time}` : time;
  };

  return {
    metadata,
    endpoints,
    endpointsChanged,
    day_id: dayId,
    end_day_id: endDayId,
    reservation_time: plan.reservationTime ?? stamp(dayId, legs[0].dep_time),
    reservation_end_time: plan.reservationEndTime ?? stamp(endDayId, legs[last].arr_time),
  };
}

/**
 * `metadata` is a flat string map, so segments smuggled through it can only ever
 * land as an inert JSON string that every reader skips (`Array.isArray` fails),
 * the silent dead end reported in #1914. Refuse it and name the right parameter.
 */
const LEGS_IN_METADATA_ERROR =
  'Pass the segments of a multi-leg booking in the legs parameter, not in metadata.legs. Metadata values are plain strings, so a JSON string there is stored but ignored by every reader.';

/**
 * Reservations MCP surface — ported 1:1 from the legacy registrars: the five
 * tools from src/mcp/tools/reservations.ts and the
 * trek://trips/{tripId}/reservations resource from src/mcp/resources.ts
 * (identical names, descriptions, schemas, annotations, error/payload shapes
 * and broadcasts). The registration-time gates map to the declarative
 * reservations read/write access markers (the legacy `if (canWrite)` /
 * `if (canRead)` checks, resolved by trekMcpAccessPolicy); there is no addon
 * gate, so no `when`.
 */
@McpController()
export class ReservationsMcp {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly days: DaysService,
    private readonly budget: BudgetService,
    private readonly auth: AuthService,
    // Appended, not inserted: the hand-wired MCP harnesses build this
    // positionally.
    private readonly assignments: AssignmentsService,
    private readonly guards: McpToolGuardsService,
  ) {}

  @Tool({
    name: 'create_reservation',
    description: 'Recommend a reservation for a trip. Created as pending, so the user must confirm it. For anything travelled ON (flight, train, bus, car, taxi, bicycle, cruise, ferry, transport_other) use create_transport instead. Linking: hotel → use place_id + start_day_id + end_day_id (all three required to create the accommodation link); restaurant/event/tour/activity/parking/other → use assignment_id. Set price to record the cost; it will appear on the booking and in the Budget tab.',
    inputSchema: {
      tripId: z.number().int().positive(),
      title: z.string().min(1).max(200),
      type: z.enum(BOOKING_TYPES).describe('Reservation type: "hotel", "restaurant", "event", "tour", "activity", "parking", or "other"'),
      reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
      reservation_end_time: z.string().optional().describe('When it ends: a dinner from 19:00 to 21:30, a tour that runs all afternoon. Ignored for hotels, whose span is the check-in/check-out days.'),
      url: urlField,
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
      price: z.number().nonnegative().optional().describe('Reservation cost — shown on the booking and linked in the Budget tab'),
      budget_category: z.string().max(100).optional().describe('Budget category for the price entry (defaults to reservation type)'),
    },
    annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    access: { group: 'reservations', mode: 'write' },
  })
  async createReservation(
    { tripId, title, type, reservation_time, reservation_end_time, url, location, confirmation_number, notes, day_id, place_id, start_day_id, end_day_id, check_in, check_out, assignment_id, price, budget_category }: {
      tripId: number; title: string; type: BookingType;
      reservation_time?: string; reservation_end_time?: string; url?: string; location?: string; confirmation_number?: string; notes?: string;
      day_id?: number; place_id?: number; start_day_id?: number; end_day_id?: number;
      check_in?: string; check_out?: string; assignment_id?: number; price?: number; budget_category?: string;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();

    // Validate that all referenced IDs belong to this trip
    if (day_id && !this.days.getDay(day_id, tripId))
      return errorResult('day_id does not belong to this trip.');
    if (place_id && !this.assignments.placeExists(place_id, tripId))
      return errorResult('place_id does not belong to this trip.');
    if (start_day_id && !this.days.getDay(start_day_id, tripId))
      return errorResult('start_day_id does not belong to this trip.');
    if (end_day_id && !this.days.getDay(end_day_id, tripId))
      return errorResult('end_day_id does not belong to this trip.');
    if (assignment_id && !this.assignments.getAssignmentForTrip(assignment_id, tripId))
      return errorResult('assignment_id does not belong to this trip.');

    const createAccommodation = (type === 'hotel' && place_id && start_day_id && end_day_id)
      ? { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined, confirmation: confirmation_number || undefined }
      : undefined;

    const metadata = price != null ? { price: String(price) } : undefined;

    const { reservation, accommodationCreated } = this.reservations.create(tripId, {
      title, type, reservation_time, reservation_end_time, url, location, confirmation_number,
      notes, day_id, place_id, assignment_id,
      create_accommodation: createAccommodation,
      metadata,
    });

    if (accommodationCreated) {
      this.guards.safeBroadcast(tripId, 'accommodation:created', {});
    }

    if (price != null && price > 0) {
      const item = this.budget.linkBudgetItemToReservation(tripId, reservation.id, {
        name: title,
        category: budget_category || type,
        total_price: price,
      });
      this.guards.safeBroadcast(tripId, 'budget:created', { item });
    }

    this.guards.safeBroadcast(tripId, 'reservation:created', { reservation });
    return ok({ reservation });
  }

  @Tool({
    name: 'update_reservation',
    description: 'Update an existing reservation in a trip. Use status "confirmed" to confirm a pending recommendation, or "pending" to revert it. For anything travelled ON (flight, train, bus, car, taxi, bicycle, cruise, ferry, transport_other) use update_transport instead. Linking: hotel → use place_id to link to an accommodation place; restaurant/event/tour/activity/parking/other → use assignment_id to link to a day assignment.',
    inputSchema: {
      tripId: z.number().int().positive(),
      reservationId: z.number().int().positive(),
      title: z.string().min(1).max(200).optional(),
      type: z.enum(BOOKING_TYPES).optional().describe('Reservation type: "hotel", "restaurant", "event", "tour", "activity", "parking", or "other"'),
      reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
      reservation_end_time: z.string().optional().describe('When it ends. Ignored for hotels, whose span is the check-in/check-out days.'),
      url: urlField,
      location: z.string().max(500).optional(),
      confirmation_number: z.string().max(100).optional(),
      notes: z.string().max(1000).optional(),
      status: z.enum(['pending', 'confirmed', 'cancelled']).optional().describe('Reservation status: "pending", "confirmed", or "cancelled"'),
      place_id: z.number().int().positive().nullable().optional().describe('Link to a place (use for hotel type), or null to unlink'),
      assignment_id: z.number().int().positive().nullable().optional().describe('Link to a day assignment (use for restaurant, train, car, cruise, event, tour, activity, other), or null to unlink'),
    },
    annotations: TOOL_ANNOTATIONS_WRITE,
    access: { group: 'reservations', mode: 'write' },
  })
  async updateReservation(
    { tripId, reservationId, title, type, reservation_time, reservation_end_time, url, location, confirmation_number, notes, status, place_id, assignment_id }: {
      tripId: number; reservationId: number; title?: string;
      type?: BookingType;
      reservation_time?: string; reservation_end_time?: string; url?: string; location?: string; confirmation_number?: string; notes?: string;
      status?: 'pending' | 'confirmed' | 'cancelled'; place_id?: number | null; assignment_id?: number | null;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();
    const existing = this.reservations.getReservation(reservationId, tripId);
    if (!existing) return errorResult('Reservation not found.');

    if (place_id != null && !this.assignments.placeExists(place_id, tripId))
      return errorResult('place_id does not belong to this trip.');
    if (assignment_id != null && !this.assignments.getAssignmentForTrip(assignment_id, tripId))
      return errorResult('assignment_id does not belong to this trip.');

    const { reservation } = this.reservations.update(reservationId, tripId, {
      title, type, reservation_time, reservation_end_time, url, location, confirmation_number, notes, status,
      place_id: place_id !== undefined ? place_id ?? undefined : undefined,
      assignment_id: assignment_id !== undefined ? assignment_id ?? undefined : undefined,
    }, existing);
    this.guards.safeBroadcast(tripId, 'reservation:updated', { reservation });
    return ok({ reservation });
  }

  @Tool({
    name: 'delete_reservation',
    description: 'Delete a reservation from a trip.',
    inputSchema: {
      tripId: z.number().int().positive(),
      reservationId: z.number().int().positive(),
    },
    annotations: TOOL_ANNOTATIONS_DELETE,
    access: { group: 'reservations', mode: 'write' },
  })
  async deleteReservation({ tripId, reservationId }: { tripId: number; reservationId: number }, ctx: McpContext) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();
    const { deleted, accommodationDeleted } = this.reservations.remove(reservationId, tripId);
    if (!deleted) return errorResult('Reservation not found.');
    if (accommodationDeleted) {
      this.guards.safeBroadcast(tripId, 'accommodation:deleted', { accommodationId: deleted.accommodation_id });
    }
    this.guards.safeBroadcast(tripId, 'reservation:deleted', { reservationId });
    return ok({ success: true });
  }

  @Tool({
    name: 'set_reservation_travelers',
    description: 'Set who is travelling on a booking, replacing the current list. Pass the user IDs of trip members or guests from list_trip_members; an empty array clears the list. Somebody who is not on the trip is ignored rather than added: use add_trip_member for a person with a TREK account, or create_trip_guest for one without.',
    inputSchema: {
      tripId: z.number().int().positive(),
      reservationId: z.number().int().positive(),
      user_ids: z.array(z.number().int().positive()).describe('User IDs of the travellers, from list_trip_members. Replaces the whole list; [] clears it.'),
    },
    annotations: TOOL_ANNOTATIONS_WRITE,
    access: { group: 'reservations', mode: 'write' },
  })
  async setReservationTravelers(
    { tripId, reservationId, user_ids }: { tripId: number; reservationId: number; user_ids: number[] },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();

    // The service filters the ids against the trip roster on its own, so an
    // off-trip id cannot be attached; a missing booking is the only failure.
    const result = this.reservations.setTravelers(String(reservationId), String(tripId), user_ids);
    if (!result) return errorResult('Reservation not found.');

    this.guards.safeBroadcast(tripId, 'reservation:travelers-updated', { reservationId, travelers: result.travelers });
    // Report what the roster filter dropped. Silently succeeding with a shorter
    // list reads as "done" to a caller that guessed an id for a name it could
    // not resolve, which is exactly what an importer does.
    const attached = new Set(result.travelers.map(t => t.user_id));
    const ignored = [...new Set(user_ids)].filter(uid => !attached.has(uid));
    return ok(ignored.length > 0
      ? { travelers: result.travelers, ignored_user_ids: ignored, note: 'Ignored ids are not on this trip. Add them with add_trip_member or create_trip_guest first.' }
      : { travelers: result.travelers });
  }

  @Tool({
    name: 'reorder_reservations',
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
    access: { group: 'reservations', mode: 'write' },
  })
  async reorderReservations(
    { tripId, positions, dayId }: { tripId: number; positions: { id: number; day_plan_position: number }[]; dayId?: number },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();

    // The service scopes the write to the trip on its own, so a foreign id is
    // already harmless — say so rather than reporting a success that moved
    // nothing, the way the sibling tools above do.
    if (dayId && !this.days.getDay(dayId, tripId))
      return errorResult('dayId does not belong to this trip.');

    this.reservations.updatePositions(tripId, positions, dayId);
    this.guards.safeBroadcast(tripId, 'reservation:positions', { positions, dayId });
    return ok({ success: true });
  }

  @Tool({
    name: 'link_hotel_accommodation',
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
    access: { group: 'reservations', mode: 'write' },
  })
  async linkHotelAccommodation(
    { tripId, reservationId, place_id, start_day_id, end_day_id, check_in, check_out }: {
      tripId: number; reservationId: number; place_id: number; start_day_id: number; end_day_id: number;
      check_in?: string; check_out?: string;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();
    const current = this.reservations.getReservation(reservationId, tripId);
    if (!current) return errorResult('Reservation not found.');
    if (current.type !== 'hotel') return errorResult('Reservation is not of type hotel.');

    if (!this.assignments.placeExists(place_id, tripId))
      return errorResult('place_id does not belong to this trip.');
    if (!this.days.getDay(start_day_id, tripId))
      return errorResult('start_day_id does not belong to this trip.');
    if (!this.days.getDay(end_day_id, tripId))
      return errorResult('end_day_id does not belong to this trip.');

    const isNewAccommodation = !current.accommodation_id;
    const { reservation } = this.reservations.update(reservationId, tripId, {
      place_id,
      type: current.type,
      status: current.status as string,
      create_accommodation: { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined },
    }, current);

    this.guards.safeBroadcast(tripId, isNewAccommodation ? 'accommodation:created' : 'accommodation:updated', {});
    this.guards.safeBroadcast(tripId, 'reservation:updated', { reservation });
    return ok({ reservation, accommodation_id: reservation?.accommodation_id ?? null });
  }

  // -------------------------------------------------------------------------
  // Cross-trip reads
  //
  // Every other entry here is trip-scoped and checks verifyTripAccess against
  // the tripId it was handed. This one has no tripId: the visible_trips CTE in
  // listUpcoming is the access check, exactly as for GET /api/reservations/upcoming,
  // so a booking on a trip the caller neither owns nor is a member of is never
  // in the result set to begin with.
  // -------------------------------------------------------------------------

  @Tool({
    name: 'list_upcoming_reservations',
    description: 'The next bookings across ALL of the user\'s trips, soonest first: "what is coming up?", "when is my next flight?". Prefer this over get_trip_summary when no particular trip is in question, or when the trip is unknown. Hotel stays appear as their check-in and check-out moments (the stay itself covers a range and is not a point in time), which no per-trip reservation list reports. Cancelled bookings and archived trips are left out.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe('How many entries to return, soonest first (default 6, the dashboard widget\'s size)'),
    },
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'reservations', mode: 'read' },
  })
  async listUpcomingReservations({ limit }: { limit?: number }, ctx: McpContext) {
    return ok({ reservations: this.reservations.listUpcoming(ctx.userId, limit) });
  }

  @ResourceTemplate({
    name: 'trip-reservations',
    uriTemplate: 'trek://trips/{tripId}/reservations',
    description: 'Reservations (flights, hotels, restaurants) for a trip',
    mimeType: 'application/json',
    access: { group: 'reservations', mode: 'read' },
  })
  async tripReservationsResource(uri: URL, { tripId }: { tripId: string | string[] }, ctx: McpContext) {
    const id = parseId(tripId);
    if (id === null || !this.reservations.verifyTripAccess(id, ctx.userId)) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ error: 'Trip not found or access denied' }),
        }],
      };
    }
    const reservations = this.reservations.list(id);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(reservations, null, 2),
      }],
    };
  }

  // -------------------------------------------------------------------------
  // Transports
  //
  // Ported 1:1 from the legacy registrar src/mcp/tools/transports.ts. They live
  // here rather than in a domain of their own because a transport IS a
  // reservation — same table, same service, same 'reservation_edit' permission
  // — and this class already injects everything they need. The registration-time
  // `if (!canWrite(scopes, 'reservations')) return;` that guarded the whole
  // registrar became the per-tool access marker.
  // -------------------------------------------------------------------------

  @Tool({
    name: 'create_transport',
    description: 'Create a transport booking for a trip: flight, train, bus, car, taxi, bicycle, cruise, ferry or transport_other. For scheduled public transit use create_transit_journey, which attaches the provider itinerary. Use endpoints[] to record origin/destination and intermediate stops; for flights, set code to the IATA airport code (use search_airports first). For a booking WITH STOPOVERS also pass legs[] (one entry per segment, one fewer than endpoints[]), otherwise every segment inherits the stop time as both its arrival and its departure. The top-level confirmation_number is the booking reference; when a single segment was booked under its own reference, put that one on the leg instead. Created as pending, so confirm it with update_transport. Set price to record the cost; it will appear on the booking and in the Budget tab.',
    inputSchema: {
      tripId: z.number().int().positive(),
      type: z.enum(CREATABLE_TRANSPORT_TYPES),
      title: z.string().min(1).max(200),
      status: z.enum(['pending', 'confirmed', 'cancelled']).optional().default('pending'),
      start_day_id: z.number().int().positive().optional().describe('Departure day'),
      end_day_id: z.number().int().positive().optional().describe('Arrival day (if different from departure)'),
      reservation_time: z.string().optional().describe('ISO 8601 datetime or time string for departure'),
      reservation_end_time: z.string().optional().describe('ISO 8601 datetime or time string for arrival'),
      confirmation_number: z.string().max(100).optional(),
      url: urlField,
      notes: z.string().max(1000).optional(),
      metadata: z.record(z.string(), z.string()).optional().describe('Type-specific metadata: flights → { airline, flight_number, departure_airport, arrival_airport }; trains → { train_number, platform, seat }. Values are plain strings, so per-segment detail belongs in legs[], not here.'),
      endpoints: endpointSchema,
      legs: legsSchema,
      needs_review: z.boolean().optional(),
      price: z.number().nonnegative().optional().describe('Transport cost — shown on the booking and linked in the Budget tab'),
      budget_category: z.string().max(100).optional().describe('Budget category for the price entry (defaults to transport type)'),
    },
    annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    access: { group: 'reservations', mode: 'write' },
  })
  async createTransport(
    { tripId, type, title, status, start_day_id, end_day_id, reservation_time, reservation_end_time, confirmation_number, url, notes, metadata, endpoints, legs, needs_review, price, budget_category }: {
      tripId: number; type: TransportType; title: string;
      status?: 'pending' | 'confirmed' | 'cancelled'; start_day_id?: number; end_day_id?: number;
      reservation_time?: string; reservation_end_time?: string; confirmation_number?: string; url?: string; notes?: string;
      metadata?: Record<string, string>; endpoints?: TransportEndpoint[]; legs?: TransportLegInput[]; needs_review?: boolean;
      price?: number; budget_category?: string;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();

    if (metadata && 'legs' in metadata) return errorResult(LEGS_IN_METADATA_ERROR);

    if (start_day_id && !this.days.getDay(start_day_id, tripId))
      return errorResult('start_day_id does not belong to this trip.');
    if (end_day_id && !this.days.getDay(end_day_id, tripId))
      return errorResult('end_day_id does not belong to this trip.');

    const resolved = resolveEndpointCoords(endpoints);
    if ('error' in resolved) return errorResult(resolved.error);

    const meta: Record<string, unknown> = { ...(metadata ?? {}) };
    let transportEndpoints = resolved.endpoints;
    let dayId = start_day_id;
    let spanEndDayId = end_day_id;
    let departureTime = reservation_time;
    let arrivalTime = reservation_end_time;

    if (legs !== undefined) {
      const applied = applyLegs({
        legs,
        type,
        endpoints: resolved.endpoints,
        baseMetadata: meta,
        previousLegs: [],
        startDayId: start_day_id,
        endDayId: end_day_id,
        reservationTime: reservation_time,
        reservationEndTime: reservation_end_time,
        lookupDay: (id) => this.days.getDay(id, tripId),
      });
      if ('error' in applied) return errorResult(applied.error);
      Object.assign(meta, applied.metadata);
      transportEndpoints = applied.endpoints;
      dayId = applied.day_id;
      spanEndDayId = applied.end_day_id;
      departureTime = applied.reservation_time;
      arrivalTime = applied.reservation_end_time;
    }

    if (price != null) meta.price = String(price);

    const { reservation } = this.reservations.create(tripId, {
      title,
      type,
      reservation_time: departureTime,
      reservation_end_time: arrivalTime,
      location: undefined,
      confirmation_number,
      url,
      notes,
      day_id: dayId,
      end_day_id: spanEndDayId ?? dayId,
      status: status ?? 'pending',
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
      endpoints: transportEndpoints,
      needs_review,
    });

    if (price != null && price > 0) {
      const item = this.budget.linkBudgetItemToReservation(tripId, reservation.id, {
        name: title,
        category: budget_category || type,
        total_price: price,
      });
      this.guards.safeBroadcast(tripId, 'budget:created', { item });
    }

    this.guards.safeBroadcast(tripId, 'reservation:created', { reservation });
    return ok({ reservation });
  }

  @Tool({
    name: 'update_transport',
    description: 'Update an existing transport booking. Pass endpoints[] to replace the full list of stops (origin, destination, intermediates), and legs[] to write the per-segment times of a stopover booking. Sending legs[] without metadata keeps the stored metadata (departure_airport, airtrail_ids, transit) and only replaces the segments. A per-segment booking reference lives on the leg (legs[].confirmation_number); the top-level one stays the booking reference. Use status "confirmed" to confirm.',
    inputSchema: {
      tripId: z.number().int().positive(),
      reservationId: z.number().int().positive(),
      type: z.enum(CREATABLE_TRANSPORT_TYPES).optional(),
      title: z.string().min(1).max(200).optional(),
      status: z.enum(['pending', 'confirmed', 'cancelled']).optional(),
      start_day_id: z.number().int().positive().optional().describe('Departure day'),
      end_day_id: z.number().int().positive().optional().describe('Arrival day (if different from departure)'),
      reservation_time: z.string().optional().describe('ISO 8601 datetime or time string for departure'),
      reservation_end_time: z.string().optional().describe('ISO 8601 datetime or time string for arrival'),
      confirmation_number: z.string().max(100).optional(),
      url: urlField,
      notes: z.string().max(1000).optional(),
      metadata: z.record(z.string(), z.string()).optional().describe('Type-specific metadata: flights → { airline, flight_number, departure_airport, arrival_airport }; trains → { train_number, platform, seat }. Replaces the stored metadata wholesale, except that a price mirrored from a linked expense survives unless you name the price key yourself. Values are plain strings, so per-segment detail belongs in legs[], not here.'),
      endpoints: endpointSchema,
      legs: legsSchema,
      needs_review: z.boolean().optional(),
    },
    annotations: TOOL_ANNOTATIONS_WRITE,
    access: { group: 'reservations', mode: 'write' },
  })
  async updateTransport(
    { tripId, reservationId, type, title, status, start_day_id, end_day_id, reservation_time, reservation_end_time, confirmation_number, url, notes, metadata, endpoints, legs, needs_review }: {
      tripId: number; reservationId: number; type?: TransportType; title?: string;
      status?: 'pending' | 'confirmed' | 'cancelled'; start_day_id?: number; end_day_id?: number;
      reservation_time?: string; reservation_end_time?: string; confirmation_number?: string; url?: string; notes?: string;
      metadata?: Record<string, string>; endpoints?: TransportEndpoint[]; legs?: TransportLegInput[]; needs_review?: boolean;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();

    if (metadata && 'legs' in metadata) return errorResult(LEGS_IN_METADATA_ERROR);

    const existing = this.reservations.getReservation(reservationId, tripId);
    if (!existing) return errorResult('Transport not found.');

    const resolvedType = type ?? existing.type;
    if (!(TRANSPORT_TYPES as readonly string[]).includes(resolvedType))
      return errorResult('Reservation is not a transport type. Use update_reservation instead.');

    if (start_day_id && !this.days.getDay(start_day_id, tripId))
      return errorResult('start_day_id does not belong to this trip.');
    if (end_day_id && !this.days.getDay(end_day_id, tripId))
      return errorResult('end_day_id does not belong to this trip.');

    // Only resolve when endpoints are explicitly provided; undefined leaves them untouched.
    let resolvedEndpoints: EndpointInput[] | undefined;
    if (endpoints !== undefined) {
      const resolved = resolveEndpointCoords(endpoints);
      if ('error' in resolved) return errorResult(resolved.error);
      resolvedEndpoints = resolved.endpoints;
    }

    let nextMetadata: unknown = metadata;
    let dayId = start_day_id;
    let spanEndDayId: number | undefined = end_day_id;
    let departureTime = reservation_time;
    let arrivalTime = reservation_end_time;

    if (legs !== undefined) {
      const stored = parseStoredMetadata(existing.metadata);
      const applied = applyLegs({
        legs,
        type: resolvedType,
        // Endpoints the caller did not replace stay the geometry the legs run
        // over, so read them back (the row carries them) instead of guessing.
        endpoints: resolvedEndpoints ?? (this.reservations.getReservationWithJoins(reservationId)?.endpoints ?? []).map(e => ({
          role: e.role, sequence: e.sequence, name: e.name, code: e.code,
          lat: e.lat, lng: e.lng, timezone: e.timezone,
          local_time: e.local_time, local_date: e.local_date,
        })),
        // metadata keeps replacing wholesale when it is sent; a legs-only update
        // must not drop departure_airport / airtrail_ids / transit, so it merges
        // into what is stored instead.
        baseMetadata: metadata !== undefined ? { ...metadata } : { ...stored },
        previousLegs: Array.isArray(stored.legs) ? stored.legs as unknown[] : [],
        startDayId: start_day_id,
        endDayId: end_day_id,
        reservationTime: reservation_time,
        reservationEndTime: reservation_end_time,
        lookupDay: (id) => this.days.getDay(id, tripId),
      });
      if ('error' in applied) return errorResult(applied.error);
      nextMetadata = applied.metadata;
      dayId = applied.day_id;
      spanEndDayId = applied.end_day_id;
      departureTime = applied.reservation_time;
      arrivalTime = applied.reservation_end_time;
      // Rewrite the endpoints only when the legs actually filled a blank time or
      // date in; an unchanged list is left alone so its rows survive.
      if (applied.endpointsChanged) resolvedEndpoints = applied.endpoints;
    }

    const { reservation } = this.reservations.update(reservationId, tripId, {
      title,
      type,
      reservation_time: departureTime,
      reservation_end_time: arrivalTime,
      confirmation_number,
      url,
      notes,
      day_id: dayId,
      end_day_id: spanEndDayId,
      status,
      metadata: nextMetadata,
      endpoints: resolvedEndpoints,
      needs_review,
    }, existing);
    this.guards.safeBroadcast(tripId, 'reservation:updated', { reservation });
    return ok({ reservation });
  }

  @Tool({
    name: 'delete_transport',
    description: 'Delete a transport booking from a trip.',
    inputSchema: {
      tripId: z.number().int().positive(),
      reservationId: z.number().int().positive(),
    },
    annotations: TOOL_ANNOTATIONS_DELETE,
    access: { group: 'reservations', mode: 'write' },
  })
  async deleteTransport({ tripId, reservationId }: { tripId: number; reservationId: number }, ctx: McpContext) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.reservations.verifyTripAccess(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();
    const { deleted } = this.reservations.remove(reservationId, tripId);
    if (!deleted) return errorResult('Transport not found.');
    this.guards.safeBroadcast(tripId, 'reservation:deleted', { reservationId });
    return ok({ success: true });
  }
}
