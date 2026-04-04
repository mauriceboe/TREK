import { ConvexError, v } from 'convex/values';
import { internalMutationGeneric as internalMutation, queryGeneric as query } from 'convex/server';

type IdentityLike = Record<string, unknown> & {
  subject?: string;
  email?: string | null;
};

const plannerUserInput = v.object({
  legacyUserId: v.number(),
  betterAuthUserId: v.optional(v.union(v.string(), v.null())),
  username: v.string(),
  email: v.string(),
  role: v.string(),
  avatarUrl: v.optional(v.union(v.string(), v.null())),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const plannerTripInput = v.object({
  legacyId: v.number(),
  ownerLegacyUserId: v.number(),
  title: v.string(),
  description: v.optional(v.union(v.string(), v.null())),
  startDate: v.optional(v.union(v.string(), v.null())),
  endDate: v.optional(v.union(v.string(), v.null())),
  currency: v.string(),
  coverImage: v.optional(v.union(v.string(), v.null())),
  isArchived: v.boolean(),
  destinationName: v.optional(v.union(v.string(), v.null())),
  destinationAddress: v.optional(v.union(v.string(), v.null())),
  destinationLat: v.optional(v.union(v.number(), v.null())),
  destinationLng: v.optional(v.union(v.number(), v.null())),
  destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
  destinationViewportWest: v.optional(v.union(v.number(), v.null())),
  destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
  destinationViewportEast: v.optional(v.union(v.number(), v.null())),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const plannerTripMemberInput = v.object({
  legacyId: v.number(),
  tripLegacyId: v.number(),
  memberLegacyUserId: v.number(),
  invitedByLegacyUserId: v.optional(v.union(v.number(), v.null())),
  addedAt: v.number(),
});

const plannerDayInput = v.object({
  legacyId: v.number(),
  tripLegacyId: v.number(),
  dayNumber: v.number(),
  date: v.optional(v.union(v.string(), v.null())),
  notes: v.optional(v.union(v.string(), v.null())),
  title: v.optional(v.union(v.string(), v.null())),
});

const plannerPlaceInput = v.object({
  legacyId: v.number(),
  tripLegacyId: v.number(),
  name: v.string(),
  description: v.optional(v.union(v.string(), v.null())),
  lat: v.optional(v.union(v.number(), v.null())),
  lng: v.optional(v.union(v.number(), v.null())),
  address: v.optional(v.union(v.string(), v.null())),
  categoryId: v.optional(v.union(v.number(), v.null())),
  price: v.optional(v.union(v.number(), v.null())),
  currency: v.optional(v.union(v.string(), v.null())),
  reservationStatus: v.optional(v.string()),
  reservationNotes: v.optional(v.union(v.string(), v.null())),
  reservationDatetime: v.optional(v.union(v.string(), v.null())),
  placeTime: v.optional(v.union(v.string(), v.null())),
  endTime: v.optional(v.union(v.string(), v.null())),
  durationMinutes: v.optional(v.number()),
  notes: v.optional(v.union(v.string(), v.null())),
  imageUrl: v.optional(v.union(v.string(), v.null())),
  googlePlaceId: v.optional(v.union(v.string(), v.null())),
  website: v.optional(v.union(v.string(), v.null())),
  phone: v.optional(v.union(v.string(), v.null())),
  transportMode: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function authUserKeyFor(input: { betterAuthUserId?: string | null; legacyUserId: number }): string {
  return input.betterAuthUserId || `legacy:${input.legacyUserId}`;
}

async function getViewerAuthKey(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity() as IdentityLike | null;
  if (!identity?.subject) throw new ConvexError('Authentication required');
  return String(identity.subject);
}

async function getPlannerUserByLegacyId(ctx: { db: any }, legacyUserId: number) {
  return ctx.db
    .query('plannerUsers')
    .withIndex('by_legacyUserId', (q: any) => q.eq('legacyUserId', legacyUserId))
    .unique();
}

async function getPlannerTripByLegacyId(ctx: { db: any }, legacyId: number) {
  return ctx.db
    .query('plannerTrips')
    .withIndex('by_legacyId', (q: any) => q.eq('legacyId', legacyId))
    .unique();
}

async function requireTripAccess(ctx: { auth: { getUserIdentity: () => Promise<unknown> }; db: any }, tripLegacyId: number) {
  const authUserKey = await getViewerAuthKey(ctx);
  const trip = await getPlannerTripByLegacyId(ctx, tripLegacyId);
  if (!trip) throw new ConvexError('Trip not found');

  if (trip.ownerAuthUserKey === authUserKey) {
    return trip;
  }

  const membership = await ctx.db
    .query('plannerTripMembers')
    .withIndex('by_trip_memberAuthUserKey', (q: any) => q.eq('tripId', trip._id).eq('memberAuthUserKey', authUserKey))
    .unique();

  if (!membership) throw new ConvexError('Trip access denied');
  return trip;
}

function formatTrip(doc: Record<string, any>) {
  return {
    id: doc.legacyId,
    title: doc.title,
    description: doc.description || null,
    start_date: doc.startDate || null,
    end_date: doc.endDate || null,
    currency: doc.currency,
    cover_image: doc.coverImage || null,
    is_archived: doc.isArchived ? 1 : 0,
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

export const listTripsForViewer = query({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);

    const ownedTrips = await ctx.db
      .query('plannerTrips')
      .withIndex('by_ownerAuthUserKey', (q) => q.eq('ownerAuthUserKey', authUserKey))
      .collect();

    const memberships = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_memberAuthUserKey', (q) => q.eq('memberAuthUserKey', authUserKey))
      .collect();

    const trips = [...ownedTrips];
    const seen = new Set(trips.map((trip) => String(trip._id)));

    for (const membership of memberships) {
      const trip = await ctx.db.get(membership.tripId);
      if (trip && !seen.has(String(trip._id))) {
        seen.add(String(trip._id));
        trips.push(trip);
      }
    }

    return trips
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(formatTrip);
  },
});

export const getTripSummary = query({
  args: {
    tripLegacyId: v.number(),
  },
  handler: async (ctx, args) => {
    const trip = await requireTripAccess(ctx, args.tripLegacyId);

    const days = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q) => q.eq('tripId', trip._id))
      .collect();

    const places = await ctx.db
      .query('plannerPlaces')
      .withIndex('by_trip_createdAt', (q) => q.eq('tripId', trip._id))
      .collect();

    const members = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_trip_memberAuthUserKey', (q) => q.eq('tripId', trip._id))
      .collect();

    return {
      trip: formatTrip(trip),
      dayCount: days.length,
      placeCount: places.length,
      memberCount: members.length + 1,
    };
  },
});

export const getMigrationCounts = query({
  args: {},
  handler: async (ctx) => {
    const [users, trips, members, days, places] = await Promise.all([
      ctx.db.query('plannerUsers').collect(),
      ctx.db.query('plannerTrips').collect(),
      ctx.db.query('plannerTripMembers').collect(),
      ctx.db.query('plannerDays').collect(),
      ctx.db.query('plannerPlaces').collect(),
    ]);

    return {
      users: users.length,
      trips: trips.length,
      tripMembers: members.length,
      days: days.length,
      places: places.length,
    };
  },
});

export const upsertUsers = internalMutation({
  args: {
    users: v.array(plannerUserInput),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const user of args.users) {
      const authUserKey = authUserKeyFor(user);
      const existing = await getPlannerUserByLegacyId(ctx, user.legacyUserId);
      const payload = {
        legacyUserId: user.legacyUserId,
        authUserKey,
        betterAuthUserId: user.betterAuthUserId || undefined,
        username: user.username,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl ?? null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert('plannerUsers', payload);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

export const upsertTrips = internalMutation({
  args: {
    trips: v.array(plannerTripInput),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const trip of args.trips) {
      const owner = await getPlannerUserByLegacyId(ctx, trip.ownerLegacyUserId);
      if (!owner) {
        throw new ConvexError(`Missing planner user for trip owner ${trip.ownerLegacyUserId}`);
      }

      const existing = await getPlannerTripByLegacyId(ctx, trip.legacyId);
      const payload = {
        legacyId: trip.legacyId,
        ownerLegacyUserId: trip.ownerLegacyUserId,
        ownerAuthUserKey: owner.authUserKey,
        title: trip.title,
        description: trip.description ?? null,
        startDate: trip.startDate ?? null,
        endDate: trip.endDate ?? null,
        currency: trip.currency,
        coverImage: trip.coverImage ?? null,
        isArchived: trip.isArchived,
        destinationName: trip.destinationName ?? null,
        destinationAddress: trip.destinationAddress ?? null,
        destinationLat: trip.destinationLat ?? null,
        destinationLng: trip.destinationLng ?? null,
        destinationViewportSouth: trip.destinationViewportSouth ?? null,
        destinationViewportWest: trip.destinationViewportWest ?? null,
        destinationViewportNorth: trip.destinationViewportNorth ?? null,
        destinationViewportEast: trip.destinationViewportEast ?? null,
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert('plannerTrips', payload);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

export const upsertTripMembers = internalMutation({
  args: {
    members: v.array(plannerTripMemberInput),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const member of args.members) {
      const trip = await getPlannerTripByLegacyId(ctx, member.tripLegacyId);
      if (!trip) {
        throw new ConvexError(`Missing planner trip ${member.tripLegacyId}`);
      }

      const plannerUser = await getPlannerUserByLegacyId(ctx, member.memberLegacyUserId);
      if (!plannerUser) {
        throw new ConvexError(`Missing planner user ${member.memberLegacyUserId}`);
      }

      const existing = await ctx.db
        .query('plannerTripMembers')
        .withIndex('by_legacyId', (q: any) => q.eq('legacyId', member.legacyId))
        .unique();

      const payload = {
        legacyId: member.legacyId,
        tripId: trip._id,
        memberLegacyUserId: member.memberLegacyUserId,
        memberAuthUserKey: plannerUser.authUserKey,
        invitedByLegacyUserId: member.invitedByLegacyUserId ?? null,
        addedAt: member.addedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert('plannerTripMembers', payload);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

export const upsertDays = internalMutation({
  args: {
    days: v.array(plannerDayInput),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const day of args.days) {
      const trip = await getPlannerTripByLegacyId(ctx, day.tripLegacyId);
      if (!trip) {
        throw new ConvexError(`Missing planner trip ${day.tripLegacyId}`);
      }

      const existing = await ctx.db
        .query('plannerDays')
        .withIndex('by_legacyId', (q: any) => q.eq('legacyId', day.legacyId))
        .unique();

      const payload = {
        legacyId: day.legacyId,
        tripId: trip._id,
        dayNumber: day.dayNumber,
        date: day.date ?? null,
        notes: day.notes ?? null,
        title: day.title ?? null,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert('plannerDays', payload);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

export const upsertPlaces = internalMutation({
  args: {
    places: v.array(plannerPlaceInput),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const place of args.places) {
      const trip = await getPlannerTripByLegacyId(ctx, place.tripLegacyId);
      if (!trip) {
        throw new ConvexError(`Missing planner trip ${place.tripLegacyId}`);
      }

      const existing = await ctx.db
        .query('plannerPlaces')
        .withIndex('by_legacyId', (q: any) => q.eq('legacyId', place.legacyId))
        .unique();

      const payload = {
        legacyId: place.legacyId,
        tripId: trip._id,
        name: place.name,
        description: place.description ?? null,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        address: place.address ?? null,
        categoryId: place.categoryId ?? null,
        price: place.price ?? null,
        currency: place.currency ?? null,
        reservationStatus: place.reservationStatus || 'none',
        reservationNotes: place.reservationNotes ?? null,
        reservationDatetime: place.reservationDatetime ?? null,
        placeTime: place.placeTime ?? null,
        endTime: place.endTime ?? null,
        durationMinutes: place.durationMinutes ?? 60,
        notes: place.notes ?? null,
        imageUrl: place.imageUrl ?? null,
        googlePlaceId: place.googlePlaceId ?? null,
        website: place.website ?? null,
        phone: place.phone ?? null,
        transportMode: place.transportMode || 'walking',
        createdAt: place.createdAt,
        updatedAt: place.updatedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert('plannerPlaces', payload);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});
