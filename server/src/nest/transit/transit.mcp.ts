import {
  McpController, Tool, type McpContext,
  TOOL_ANNOTATIONS_OPEN_WORLD_NON_IDEMPOTENT, TOOL_ANNOTATIONS_OPEN_WORLD_READONLY,
  demoDenied, ok,
} from '../../nest-mcp';
import { McpToolGuardsService } from '../mcp-shared/mcp-tool-guards.service';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import {
  buildTransitReservationParts,
  cleanTransitItineraryNames,
  transitCoordinatesMatch,
  transitCoordinatesSchema,
  transitItinerarySchema,
  transitPlaceSchema,
} from './transit-itinerary.helpers';
import { noAccess, permissionDenied } from '../../mcp/tools/_shared';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService } from '../database/database.service';
import { DaysService } from '../days/days.service';
import { ReservationsService } from '../reservations/reservations.service';
import { SCHEDULED_TRANSIT_MODES, type TransitItinerary } from './transit.helpers';
import { TransitService } from './transit.service';

const TRANSIT_RATE_WINDOW = 15 * 60 * 1000;
// Deliberately its own instance, separate from the REST controller's: the MCP
// buckets are keyed by userId (mcp_transit_*), the REST ones by req.ip.
const transitRateLimiter = new RateLimitService();

const transitModes = z.enum(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

// Local 2-arg variant (the src/nest-mcp errorResult takes a string only):
// surface the provider/validation message when there is one, else the fallback.
function errorResult(err: unknown, fallback: string) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : fallback }],
    isError: true,
  };
}

function rateLimit(userId: number, bucket: string, max: number) {
  if (transitRateLimiter.check(bucket, String(userId), max, TRANSIT_RATE_WINDOW, Date.now())) return null;
  return {
    content: [{ type: 'text' as const, text: 'Too many transit requests. Please try again later.' }],
    isError: true,
  };
}

/**
 * Transit MCP surface — ported 1:1 from the legacy registrar
 * src/mcp/tools/transit.ts (identical names, descriptions, schemas,
 * annotations, error/payload shapes, rate limits and broadcasts). The
 * registration-time gates map to the declarative access markers: the
 * `canRead(scopes, 'geo')` wrap on the two search tools ('geo' is a read-only
 * scope group — there is no geo:write) and the `canWrite(scopes,
 * 'reservations')` early return on create_transit_journey. The
 * days/reservations bridge imports became injected services; the itinerary
 * schemas/helpers live in the colocated transit-itinerary.helpers.ts.
 */
@McpController()
export class TransitMcp {
  constructor(
    private readonly transit: TransitService,
    private readonly days: DaysService,
    private readonly reservations: ReservationsService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly guards: McpToolGuardsService,
  ) {}

  @Tool({
    name: 'search_transit_stops',
    description:
      'Search real public-transit stops and stations via Transitous. Use the returned coordinates with search_transit_routes.',
    inputSchema: {
      query: z.string().min(2).max(200),
      language: z.string().min(2).max(5).optional(),
      near: z
        .object(transitCoordinatesSchema.shape)
        .optional()
        .describe('Optional coordinates used to bias nearby results'),
    },
    annotations: TOOL_ANNOTATIONS_OPEN_WORLD_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async searchTransitStops(
    { query, language, near }: { query: string; language?: string; near?: { lat: number; lng: number } },
    ctx: McpContext,
  ) {
    const limited = rateLimit(ctx.userId, 'mcp_transit_geocode', 300);
    if (limited) return limited;
    try {
      return ok(await this.transit.geocode(query, language, near ? `${near.lat},${near.lng}` : undefined, ctx.userId));
    } catch (err) {
      return errorResult(err, 'Transit stop search failed.');
    }
  }

  @Tool({
    name: 'search_transit_routes',
    description:
      'Search scheduled public-transit routes between two coordinates, via whichever backend the instance is configured for. Returns itineraries that can be passed unchanged to create_transit_journey. `dropped` counts provider itineraries that failed validation and are therefore absent from the results — a non-zero value means the provider offered routes this tool could not represent.',
    inputSchema: {
      from: transitPlaceSchema,
      to: transitPlaceSchema,
      time: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('ISO 8601 departure or arrival time with timezone offset'),
      arriveBy: z.boolean().optional().default(false),
      modes: z.array(transitModes).max(14).optional(),
      maxTransfers: z.number().int().min(0).max(10).optional(),
    },
    annotations: TOOL_ANNOTATIONS_OPEN_WORLD_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async searchTransitRoutes(
    { from, to, time, arriveBy, modes, maxTransfers }: {
      from: z.infer<typeof transitPlaceSchema>;
      to: z.infer<typeof transitPlaceSchema>;
      time?: string;
      arriveBy?: boolean;
      modes?: z.infer<typeof transitModes>[];
      maxTransfers?: number;
    },
    ctx: McpContext,
  ) {
    const limited = rateLimit(ctx.userId, 'mcp_transit_plan', 60);
    if (limited) return limited;
    try {
      const result = await this.transit.plan({
        from: `${from.lat},${from.lng}`,
        to: `${to.lat},${to.lng}`,
        time,
        arriveBy,
        modes: modes?.join(','),
        maxTransfers,
      }, undefined, ctx.userId);
      const itineraries = result.itineraries.flatMap((itinerary) => {
        const parsed = transitItinerarySchema.safeParse(cleanTransitItineraryNames(itinerary, from.name, to.name));
        if (!parsed.success) return [];
        const firstStop = parsed.data.legs[0].from;
        const lastStop = parsed.data.legs[parsed.data.legs.length - 1].to;
        return transitCoordinatesMatch(from, firstStop) && transitCoordinatesMatch(to, lastStop)
          ? [parsed.data]
          : [];
      });
      // A rejected itinerary is provider data we could not vouch for, but dropping it
      // silently is indistinguishable from "no routes exist" — report the count so the
      // caller knows the difference.
      return ok({ itineraries, dropped: result.itineraries.length - itineraries.length });
    } catch (err) {
      return errorResult(err, 'Transit route search failed.');
    }
  }

  @Tool({
    name: 'create_transit_journey',
    description:
      'Add one itinerary returned by search_transit_routes to a trip day as a first-class automated public-transit journey.',
    inputSchema: {
      tripId: z.number().int().positive(),
      dayId: z.number().int().positive().describe('Trip day on which the journey departs'),
      from: transitPlaceSchema,
      to: transitPlaceSchema,
      itinerary: transitItinerarySchema,
      notes: z.string().max(1000).optional(),
    },
    annotations: TOOL_ANNOTATIONS_OPEN_WORLD_NON_IDEMPOTENT,
    access: { group: 'reservations', mode: 'write' },
  })
  async createTransitJourney(
    { tripId, dayId, from, to, itinerary, notes }: {
      tripId: number;
      dayId: number;
      from: z.infer<typeof transitPlaceSchema>;
      to: z.infer<typeof transitPlaceSchema>;
      // The schema validates exactly the wire TransitItinerary shape; its
      // z.infer prints looser optionals, so name the contract type directly.
      itinerary: TransitItinerary;
      notes?: string;
    },
    ctx: McpContext,
  ) {
    if (this.auth.isDemoUser(ctx.userId)) return demoDenied();
    if (!this.db.canAccessTrip(tripId, ctx.userId)) return noAccess();
    if (!this.guards.hasTripPermission('reservation_edit', tripId, ctx.userId)) return permissionDenied();
    const day = this.days.getDay(dayId, tripId);
    if (!day) {
      return { content: [{ type: 'text' as const, text: 'dayId does not belong to this trip.' }], isError: true };
    }

    const cleaned = cleanTransitItineraryNames(itinerary, from.name, to.name);
    const firstStop = cleaned.legs[0].from;
    const lastStop = cleaned.legs[cleaned.legs.length - 1].to;
    if (!transitCoordinatesMatch(from, firstStop) || !transitCoordinatesMatch(to, lastStop)) {
      return {
        content: [
          { type: 'text' as const, text: 'The itinerary does not match the requested origin and destination.' },
        ],
        isError: true,
      };
    }
    let reservationParts: ReturnType<typeof buildTransitReservationParts>;
    try {
      reservationParts = buildTransitReservationParts(from, to, cleaned);
    } catch (err) {
      return errorResult(err, 'Unable to resolve the transit journey timezones.');
    }
    const { endpoints, metadata } = reservationParts;
    const departure = endpoints[0];
    const arrival = endpoints[endpoints.length - 1];
    if (!day.date) {
      return {
        content: [{ type: 'text' as const, text: 'Automated transit requires a dated trip day.' }],
        isError: true,
      };
    }
    if (departure.local_date !== day.date) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `The journey departs on ${departure.local_date}, but dayId is ${day.date}.`,
          },
        ],
        isError: true,
      };
    }
    const endDay = this.days.list(tripId).days.find((d) => d.date === arrival.local_date);
    if (!endDay) {
      return {
        content: [{ type: 'text' as const, text: `No trip day exists for the arrival date ${arrival.local_date}.` }],
        isError: true,
      };
    }
    const { reservation } = this.reservations.create(tripId, {
      title: `${from.name} → ${to.name}`,
      type: 'transit',
      status: 'confirmed',
      day_id: dayId,
      end_day_id: endDay.id,
      reservation_time: `${departure.local_date}T${departure.local_time}`,
      reservation_end_time: `${arrival.local_date}T${arrival.local_time}`,
      notes,
      metadata,
      endpoints,
      needs_review: false,
    });
    this.guards.safeBroadcast(tripId, 'reservation:created', { reservation });
    this.reservations.notifyBookingChange(tripId, ctx.userId, reservation.title, reservation.type || '');
    return ok({ reservation });
  }
}
