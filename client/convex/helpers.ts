import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';

// ── Auth ─────────────────────────────────────────────────

type IdentityLike = Record<string, unknown> & {
  subject?: string;
  email?: string | null;
};

type Ctx = {
  auth: { getUserIdentity: () => Promise<unknown> };
  db: any;
};

export async function getViewerAuthKey(ctx: Ctx): Promise<string> {
  const identity = (await ctx.auth.getUserIdentity()) as IdentityLike | null;
  if (!identity?.subject) throw new ConvexError('Authentication required');
  return String(identity.subject);
}

// ── Trip access ──────────────────────────────────────────

export async function requireTripAccess(
  ctx: Ctx,
  tripId: Id<'plannerTrips'>,
): Promise<Doc<'plannerTrips'>> {
  const authUserKey = await getViewerAuthKey(ctx);
  const trip = await ctx.db.get(tripId);
  if (!trip) throw new ConvexError('Trip not found');

  if (trip.ownerAuthUserKey === authUserKey) return trip;

  const membership = await ctx.db
    .query('plannerTripMembers')
    .withIndex('by_trip_memberAuthUserKey', (q: any) =>
      q.eq('tripId', tripId).eq('memberAuthUserKey', authUserKey),
    )
    .unique();

  if (!membership) throw new ConvexError('Trip access denied');
  return trip;
}

export async function requireTripOwner(
  ctx: Ctx,
  tripId: Id<'plannerTrips'>,
): Promise<Doc<'plannerTrips'>> {
  const authUserKey = await getViewerAuthKey(ctx);
  const trip = await ctx.db.get(tripId);
  if (!trip) throw new ConvexError('Trip not found');
  if (trip.ownerAuthUserKey !== authUserKey) throw new ConvexError('Only the trip owner can do this');
  return trip;
}

// ── Date helpers ─────────────────────────────────────────

const MAX_TRIP_DAYS = 90;

export function computeDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string[] {
  if (!startDate || !endDate) return [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return [];

  const dates: string[] = [];
  const cur = new Date(start);
  while (cur <= end && dates.length < MAX_TRIP_DAYS) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── Format helpers (Convex doc → client shape) ───────────

export function formatTrip(doc: Doc<'plannerTrips'>, ownerLegacyId?: number) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    name: doc.title,
    description: doc.description || null,
    start_date: doc.startDate || null,
    end_date: doc.endDate || null,
    currency: doc.currency,
    cover_url: doc.coverImage || null,
    is_archived: doc.isArchived,
    owner_id: ownerLegacyId ?? doc.ownerLegacyUserId ?? 0,
    destination_name: doc.destinationName || null,
    destination_address: doc.destinationAddress || null,
    destination_lat: doc.destinationLat ?? null,
    destination_lng: doc.destinationLng ?? null,
    destination_viewport_south: doc.destinationViewportSouth ?? null,
    destination_viewport_west: doc.destinationViewportWest ?? null,
    destination_viewport_north: doc.destinationViewportNorth ?? null,
    destination_viewport_east: doc.destinationViewportEast ?? null,
    created_at: new Date(doc.createdAt).toISOString(),
    updated_at: new Date(doc.updatedAt).toISOString(),
  };
}

export function formatDay(doc: Doc<'plannerDays'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    trip_id: doc.tripId,
    day_number: doc.dayNumber,
    date: doc.date || null,
    notes: doc.notes || null,
    title: doc.title || null,
  };
}

export function formatPlace(doc: Doc<'plannerPlaces'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    trip_id: doc.tripId,
    name: doc.name,
    description: doc.description || null,
    lat: doc.lat ?? null,
    lng: doc.lng ?? null,
    address: doc.address || null,
    category_id: doc.categoryId || null,
    icon: null as string | null,
    price: doc.price != null ? String(doc.price) : null,
    image_url: doc.imageUrl || null,
    google_place_id: doc.googlePlaceId || null,
    osm_id: null as string | null,
    place_time: doc.placeTime || null,
    end_time: doc.endTime || null,
    notes: doc.notes || null,
    website: doc.website || null,
    phone: doc.phone || null,
    transport_mode: doc.transportMode || 'walking',
    created_at: new Date(doc.createdAt).toISOString(),
  };
}

export function formatAssignment(doc: Doc<'plannerDayAssignments'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    day_id: doc.dayId,
    place_id: doc.placeId,
    order_index: doc.orderIndex,
    notes: doc.notes || null,
    assignment_time: doc.assignmentTime || null,
    assignment_end_time: doc.assignmentEndTime || null,
    created_at: new Date(doc.createdAt).toISOString(),
  };
}

export function formatLeg(doc: Doc<'plannerTripLegs'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    trip_id: doc.tripId,
    destination_name: doc.destinationName,
    destination_address: doc.destinationAddress || null,
    destination_lat: doc.destinationLat ?? null,
    destination_lng: doc.destinationLng ?? null,
    destination_viewport_south: doc.destinationViewportSouth ?? null,
    destination_viewport_west: doc.destinationViewportWest ?? null,
    destination_viewport_north: doc.destinationViewportNorth ?? null,
    destination_viewport_east: doc.destinationViewportEast ?? null,
    start_day_number: doc.startDayNumber,
    end_day_number: doc.endDayNumber,
    color: doc.color,
    created_at: new Date(doc.createdAt).toISOString(),
    updated_at: new Date(doc.updatedAt).toISOString(),
  };
}

export function formatCategory(doc: Doc<'plannerCategories'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    name: doc.name,
    icon: doc.icon || null,
    user_id: 0,
  };
}

export function formatTag(doc: Doc<'plannerTags'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    name: doc.name,
    color: doc.color || null,
    user_id: 0,
  };
}

export function formatDayNote(doc: Doc<'plannerDayNotes'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    day_id: doc.dayId,
    text: doc.text,
    time: doc.time || null,
    icon: doc.icon,
    sort_order: doc.sortOrder,
    created_at: new Date(doc.createdAt).toISOString(),
  };
}

export function formatAccommodation(doc: Doc<'plannerAccommodations'>) {
  return {
    _id: doc._id,
    id: doc.legacyId ?? doc._id,
    trip_id: doc.tripId,
    place_id: doc.placeId,
    start_day_id: doc.startDayId,
    end_day_id: doc.endDayId,
    check_in: doc.checkIn || null,
    check_out: doc.checkOut || null,
    confirmation: doc.confirmation || null,
    notes: doc.notes || null,
    created_at: new Date(doc.createdAt).toISOString(),
  };
}

// ── Leg helpers ──────────────────────────────────────────

export const LEG_COLORS = ['#0f766e', '#0369a1', '#c2410c', '#7c3aed', '#be123c', '#15803d'];
