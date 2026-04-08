import { ConvexError, v } from 'convex/values';
import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server';
import {
  getViewerAuthKey,
  requireTripAccess,
  requireTripOwner,
  computeDateRange,
  formatTrip,
  formatLeg,
} from './helpers';

const MAX_TRIP_DAYS = 90;
const DEFAULT_DATELESS_DAYS = 7;

// ── Internal helpers ────────────────────────────────────────

async function getTripCounts(ctx: { db: any }, tripId: any) {
  const days = await ctx.db
    .query('plannerDays')
    .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', tripId))
    .collect();

  const places = await ctx.db
    .query('plannerPlaces')
    .withIndex('by_trip_createdAt', (q: any) => q.eq('tripId', tripId))
    .collect();

  const members = await ctx.db
    .query('plannerTripMembers')
    .withIndex('by_trip_memberAuthUserKey', (q: any) => q.eq('tripId', tripId))
    .collect();

  return {
    day_count: days.length,
    place_count: places.length,
    member_count: members.length + 1, // +1 for owner
  };
}

async function generateDays(
  ctx: { db: any },
  tripId: any,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
) {
  const dates = computeDateRange(startDate, endDate);

  if (dates.length > 0) {
    // Create one day per date
    for (let i = 0; i < dates.length; i++) {
      await ctx.db.insert('plannerDays', {
        tripId,
        dayNumber: i + 1,
        date: dates[i],
        notes: null,
        title: null,
      });
    }
  } else {
    // No dates provided: create default dateless days
    for (let i = 0; i < DEFAULT_DATELESS_DAYS; i++) {
      await ctx.db.insert('plannerDays', {
        tripId,
        dayNumber: i + 1,
        date: null,
        notes: null,
        title: null,
      });
    }
  }
}

// ── Queries ─────────────────────────────────────────────────

export const listTrips = query({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);

    const ownedTrips = await ctx.db
      .query('plannerTrips')
      .withIndex('by_ownerAuthUserKey', (q: any) => q.eq('ownerAuthUserKey', authUserKey))
      .collect();

    const memberships = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_memberAuthUserKey', (q: any) => q.eq('memberAuthUserKey', authUserKey))
      .collect();

    const trips = [...ownedTrips];
    const seen = new Set(trips.map((t: any) => String(t._id)));

    for (const membership of memberships) {
      const trip = await ctx.db.get(membership.tripId);
      if (trip && !seen.has(String(trip._id))) {
        seen.add(String(trip._id));
        trips.push(trip);
      }
    }

    // Sort by most recently updated
    trips.sort((a: any, b: any) => b.updatedAt - a.updatedAt);

    // Enrich each trip with counts and is_owner
    const results = [];
    for (const trip of trips) {
      const counts = await getTripCounts(ctx, trip._id);
      results.push({
        ...formatTrip(trip),
        ...counts,
        is_owner: trip.ownerAuthUserKey === authUserKey ? 1 : 0,
      });
    }

    return results;
  },
});

/**
 * Resolve a trip by URL parameter — accepts either a Convex _id or a legacy numeric ID.
 * Returns the Convex _id so other queries can use it.
 */
export const resolveTripId = query({
  args: { tripParam: v.string() },
  handler: async (ctx, args) => {
    // Try as a Convex ID first
    try {
      const trip = await ctx.db.get(args.tripParam as any);
      if (trip) return trip._id;
    } catch {
      // Not a valid Convex ID — try as legacy numeric ID
    }

    const legacyId = parseInt(args.tripParam, 10);
    if (!isNaN(legacyId)) {
      const trip = await ctx.db
        .query('plannerTrips')
        .withIndex('by_legacyId', (q: any) => q.eq('legacyId', legacyId))
        .unique();
      if (trip) return trip._id;
    }

    return null;
  },
});

export const getTrip = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    const trip = await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const counts = await getTripCounts(ctx, trip._id);

    return {
      ...formatTrip(trip),
      ...counts,
      is_owner: trip.ownerAuthUserKey === authUserKey ? 1 : 0,
    };
  },
});

export const getTripMembers = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    const trip = await requireTripAccess(ctx, args.tripId);

    // Get owner info
    const owner = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', trip.ownerAuthUserKey))
      .unique();

    const result: any[] = [];

    if (owner) {
      result.push({
        _id: owner._id,
        auth_user_key: owner.authUserKey,
        username: owner.username,
        email: owner.email,
        avatar_url: owner.avatarUrl || null,
        role: 'owner',
      });
    }

    // Get members
    const memberships = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_trip_memberAuthUserKey', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    for (const membership of memberships) {
      const user = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', membership.memberAuthUserKey))
        .unique();

      if (user) {
        result.push({
          _id: user._id,
          membership_id: membership._id,
          auth_user_key: user.authUserKey,
          username: user.username,
          email: user.email,
          avatar_url: user.avatarUrl || null,
          role: 'member',
          added_at: new Date(membership.addedAt).toISOString(),
        });
      }
    }

    return result;
  },
});

// ── Mutations ───────────────────────────────────────────────

export const createTrip = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    startDate: v.optional(v.union(v.string(), v.null())),
    endDate: v.optional(v.union(v.string(), v.null())),
    currency: v.optional(v.string()),
    destinationName: v.optional(v.union(v.string(), v.null())),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);

    const title = args.title.trim();
    if (!title) throw new ConvexError('Trip title is required');

    // Validate date range if provided
    if (args.startDate && args.endDate) {
      const start = new Date(args.startDate + 'T00:00:00Z');
      const end = new Date(args.endDate + 'T00:00:00Z');
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
        throw new ConvexError('Invalid date range');
      }
      const diffDays = Math.round((end.getTime() - start.getTime()) / (86400000)) + 1;
      if (diffDays > MAX_TRIP_DAYS) {
        throw new ConvexError(`Trip cannot exceed ${MAX_TRIP_DAYS} days`);
      }
    }

    const now = Date.now();
    const tripId = await ctx.db.insert('plannerTrips', {
      ownerAuthUserKey: authUserKey,
      title,
      description: args.description ?? null,
      startDate: args.startDate ?? null,
      endDate: args.endDate ?? null,
      currency: args.currency || 'USD',
      coverImage: null,
      isArchived: false,
      destinationName: args.destinationName ?? null,
      destinationAddress: args.destinationAddress ?? null,
      destinationLat: args.destinationLat ?? null,
      destinationLng: args.destinationLng ?? null,
      destinationViewportSouth: args.destinationViewportSouth ?? null,
      destinationViewportWest: args.destinationViewportWest ?? null,
      destinationViewportNorth: args.destinationViewportNorth ?? null,
      destinationViewportEast: args.destinationViewportEast ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Auto-generate days
    await generateDays(ctx, tripId, args.startDate, args.endDate);

    const trip = await ctx.db.get(tripId);
    return trip ? formatTrip(trip) : null;
  },
});

export const updateTrip = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    startDate: v.optional(v.union(v.string(), v.null())),
    endDate: v.optional(v.union(v.string(), v.null())),
    currency: v.optional(v.string()),
    coverImage: v.optional(v.union(v.string(), v.null())),
    destinationName: v.optional(v.union(v.string(), v.null())),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const trip = await requireTripAccess(ctx, args.tripId);

    if (args.title !== undefined && !args.title.trim()) {
      throw new ConvexError('Trip title cannot be empty');
    }

    // Determine if dates are changing
    const newStartDate = args.startDate !== undefined ? args.startDate : trip.startDate;
    const newEndDate = args.endDate !== undefined ? args.endDate : trip.endDate;
    const datesChanged =
      (args.startDate !== undefined && args.startDate !== trip.startDate) ||
      (args.endDate !== undefined && args.endDate !== trip.endDate);

    // Build patch object (only include provided fields)
    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.description !== undefined) patch.description = args.description;
    if (args.startDate !== undefined) patch.startDate = args.startDate;
    if (args.endDate !== undefined) patch.endDate = args.endDate;
    if (args.currency !== undefined) patch.currency = args.currency;
    if (args.coverImage !== undefined) patch.coverImage = args.coverImage;
    if (args.destinationName !== undefined) patch.destinationName = args.destinationName;
    if (args.destinationAddress !== undefined) patch.destinationAddress = args.destinationAddress;
    if (args.destinationLat !== undefined) patch.destinationLat = args.destinationLat;
    if (args.destinationLng !== undefined) patch.destinationLng = args.destinationLng;
    if (args.destinationViewportSouth !== undefined) patch.destinationViewportSouth = args.destinationViewportSouth;
    if (args.destinationViewportWest !== undefined) patch.destinationViewportWest = args.destinationViewportWest;
    if (args.destinationViewportNorth !== undefined) patch.destinationViewportNorth = args.destinationViewportNorth;
    if (args.destinationViewportEast !== undefined) patch.destinationViewportEast = args.destinationViewportEast;

    await ctx.db.patch(args.tripId, patch);

    // Regenerate days if dates changed
    if (datesChanged) {
      const newDates = computeDateRange(newStartDate, newEndDate);
      const existingDays = await ctx.db
        .query('plannerDays')
        .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
        .collect();

      if (newDates.length > 0) {
        // Dated mode: reconcile days
        const newDateSet = new Set(newDates);
        const existingByDate = new Map<string, any>();
        for (const day of existingDays) {
          if (day.date && newDateSet.has(day.date)) {
            existingByDate.set(day.date, day);
          } else {
            // Delete days whose dates are not in the new range
            // First delete associated assignments and their participants
            const assignments = await ctx.db
              .query('plannerDayAssignments')
              .withIndex('by_dayId_orderIndex', (q: any) => q.eq('dayId', day._id))
              .collect();
            for (const assignment of assignments) {
              const participants = await ctx.db
                .query('plannerAssignmentParticipants')
                .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', assignment._id))
                .collect();
              for (const p of participants) {
                await ctx.db.delete(p._id);
              }
              await ctx.db.delete(assignment._id);
            }
            // Delete day notes
            const dayNotes = await ctx.db
              .query('plannerDayNotes')
              .withIndex('by_dayId', (q: any) => q.eq('dayId', day._id))
              .collect();
            for (const note of dayNotes) {
              await ctx.db.delete(note._id);
            }
            await ctx.db.delete(day._id);
          }
        }

        // Create new days for dates that don't exist yet, and renumber
        for (let i = 0; i < newDates.length; i++) {
          const date = newDates[i];
          const existing = existingByDate.get(date);
          if (existing) {
            // Update day number if it changed
            if (existing.dayNumber !== i + 1) {
              await ctx.db.patch(existing._id, { dayNumber: i + 1 });
            }
          } else {
            await ctx.db.insert('plannerDays', {
              tripId: args.tripId,
              dayNumber: i + 1,
              date,
              notes: null,
              title: null,
            });
          }
        }

        // Sync legs: clamp or delete legs that exceed new day count
        const legs = await ctx.db
          .query('plannerTripLegs')
          .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
          .collect();

        const totalDays = newDates.length;
        for (const leg of legs) {
          if (leg.startDayNumber > totalDays) {
            // Leg starts beyond new range, delete it
            await ctx.db.delete(leg._id);
          } else if (leg.endDayNumber > totalDays) {
            // Clamp end to new day count
            await ctx.db.patch(leg._id, {
              endDayNumber: totalDays,
              updatedAt: Date.now(),
            });
          }
        }
      } else {
        // Switching to dateless mode: keep existing day count, clear dates
        for (const day of existingDays) {
          if (day.date) {
            await ctx.db.patch(day._id, { date: null });
          }
        }
      }
    }

    const updated = await ctx.db.get(args.tripId);
    return updated ? formatTrip(updated) : null;
  },
});

export const deleteTrip = mutation({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripOwner(ctx, args.tripId);

    // Cascade delete: days and their children
    const days = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    for (const day of days) {
      // Delete day notes
      const dayNotes = await ctx.db
        .query('plannerDayNotes')
        .withIndex('by_dayId', (q: any) => q.eq('dayId', day._id))
        .collect();
      for (const note of dayNotes) {
        await ctx.db.delete(note._id);
      }
      await ctx.db.delete(day._id);
    }

    // Delete assignments and their participants
    const assignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    for (const assignment of assignments) {
      const participants = await ctx.db
        .query('plannerAssignmentParticipants')
        .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', assignment._id))
        .collect();
      for (const p of participants) {
        await ctx.db.delete(p._id);
      }
      await ctx.db.delete(assignment._id);
    }

    // Delete places and their tags
    const places = await ctx.db
      .query('plannerPlaces')
      .withIndex('by_trip_createdAt', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    for (const place of places) {
      const placeTags = await ctx.db
        .query('plannerPlaceTags')
        .withIndex('by_placeId', (q: any) => q.eq('placeId', place._id))
        .collect();
      for (const pt of placeTags) {
        await ctx.db.delete(pt._id);
      }
      await ctx.db.delete(place._id);
    }

    // Delete legs
    const legs = await ctx.db
      .query('plannerTripLegs')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const leg of legs) {
      await ctx.db.delete(leg._id);
    }

    // Delete members
    const members = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_trip_memberAuthUserKey', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const member of members) {
      await ctx.db.delete(member._id);
    }

    // Delete accommodations
    const accommodations = await ctx.db
      .query('plannerAccommodations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const acc of accommodations) {
      await ctx.db.delete(acc._id);
    }

    // Delete the trip itself
    await ctx.db.delete(args.tripId);

    return { success: true };
  },
});

export const archiveTrip = mutation({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.patch(args.tripId, {
      isArchived: true,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(args.tripId);
    return updated ? formatTrip(updated) : null;
  },
});

export const unarchiveTrip = mutation({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.patch(args.tripId, {
      isArchived: false,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(args.tripId);
    return updated ? formatTrip(updated) : null;
  },
});

export const copyTrip = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trip = await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const now = Date.now();

    // 1. Create new trip
    const newTripId = await ctx.db.insert('plannerTrips', {
      ownerAuthUserKey: authUserKey,
      title: args.title || `${trip.title} (Copy)`,
      description: trip.description,
      startDate: trip.startDate,
      endDate: trip.endDate,
      currency: trip.currency,
      coverImage: trip.coverImage,
      isArchived: false,
      destinationName: trip.destinationName,
      destinationAddress: trip.destinationAddress,
      destinationLat: trip.destinationLat,
      destinationLng: trip.destinationLng,
      destinationViewportSouth: trip.destinationViewportSouth,
      destinationViewportWest: trip.destinationViewportWest,
      destinationViewportNorth: trip.destinationViewportNorth,
      destinationViewportEast: trip.destinationViewportEast,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Copy days
    const oldDays = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    const dayIdMap = new Map<string, any>();
    for (const day of oldDays) {
      const newDayId = await ctx.db.insert('plannerDays', {
        tripId: newTripId,
        dayNumber: day.dayNumber,
        date: day.date,
        notes: day.notes,
        title: day.title,
      });
      dayIdMap.set(String(day._id), newDayId);
    }

    // 3. Copy places
    const oldPlaces = await ctx.db
      .query('plannerPlaces')
      .withIndex('by_trip_createdAt', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    const placeIdMap = new Map<string, any>();
    for (const place of oldPlaces) {
      const newPlaceId = await ctx.db.insert('plannerPlaces', {
        tripId: newTripId,
        name: place.name,
        description: place.description,
        lat: place.lat,
        lng: place.lng,
        address: place.address,
        categoryId: place.categoryId,
        price: place.price,
        currency: place.currency,
        reservationStatus: place.reservationStatus,
        reservationNotes: place.reservationNotes,
        reservationDatetime: place.reservationDatetime,
        placeTime: place.placeTime,
        endTime: place.endTime,
        durationMinutes: place.durationMinutes,
        notes: place.notes,
        imageUrl: place.imageUrl,
        googlePlaceId: place.googlePlaceId,
        website: place.website,
        phone: place.phone,
        transportMode: place.transportMode,
        createdAt: now,
        updatedAt: now,
      });
      placeIdMap.set(String(place._id), newPlaceId);
    }

    // 4. Copy assignments
    const oldAssignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const assignment of oldAssignments) {
      const newDayId = dayIdMap.get(String(assignment.dayId));
      const newPlaceId = placeIdMap.get(String(assignment.placeId));
      if (newDayId && newPlaceId) {
        await ctx.db.insert('plannerDayAssignments', {
          tripId: newTripId,
          dayId: newDayId,
          placeId: newPlaceId,
          orderIndex: assignment.orderIndex,
          notes: assignment.notes,
          assignmentTime: assignment.assignmentTime,
          assignmentEndTime: assignment.assignmentEndTime,
          createdAt: now,
        });
      }
    }

    // 5. Copy place tags
    for (const place of oldPlaces) {
      const oldTags = await ctx.db
        .query('plannerPlaceTags')
        .withIndex('by_placeId', (q: any) => q.eq('placeId', place._id))
        .collect();
      const newPlaceId = placeIdMap.get(String(place._id));
      if (newPlaceId) {
        for (const pt of oldTags) {
          await ctx.db.insert('plannerPlaceTags', {
            placeId: newPlaceId,
            tagId: pt.tagId,
          });
        }
      }
    }

    // 6. Copy legs
    const oldLegs = await ctx.db
      .query('plannerTripLegs')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const leg of oldLegs) {
      await ctx.db.insert('plannerTripLegs', {
        tripId: newTripId,
        destinationName: leg.destinationName,
        destinationAddress: leg.destinationAddress,
        destinationLat: leg.destinationLat,
        destinationLng: leg.destinationLng,
        destinationViewportSouth: leg.destinationViewportSouth,
        destinationViewportWest: leg.destinationViewportWest,
        destinationViewportNorth: leg.destinationViewportNorth,
        destinationViewportEast: leg.destinationViewportEast,
        startDayNumber: leg.startDayNumber,
        endDayNumber: leg.endDayNumber,
        color: leg.color,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 7. Copy day notes
    const oldDayNotes = await ctx.db
      .query('plannerDayNotes')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    for (const note of oldDayNotes) {
      const newDayId = dayIdMap.get(String(note.dayId));
      if (newDayId) {
        await ctx.db.insert('plannerDayNotes', {
          dayId: newDayId,
          tripId: newTripId,
          text: note.text,
          time: note.time,
          icon: note.icon,
          sortOrder: note.sortOrder,
          createdAt: now,
        });
      }
    }

    const newTrip = await ctx.db.get(newTripId);
    return newTrip ? formatTrip(newTrip) : null;
  },
});

export const addTripMember = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    email: v.optional(v.string()),
    username: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    if (!args.email && !args.username) {
      throw new ConvexError('Either email or username is required');
    }

    // Find the user by email or username
    let user: any = null;

    if (args.email) {
      const allUsers = await ctx.db.query('plannerUsers').collect();
      user = allUsers.find(
        (u: any) => u.email.toLowerCase() === args.email!.toLowerCase(),
      );
    }

    if (!user && args.username) {
      const allUsers = await ctx.db.query('plannerUsers').collect();
      user = allUsers.find(
        (u: any) => u.username.toLowerCase() === args.username!.toLowerCase(),
      );
    }

    if (!user) {
      throw new ConvexError('User not found');
    }

    // Check if user is already the owner
    const trip = await ctx.db.get(args.tripId);
    if (trip && trip.ownerAuthUserKey === user.authUserKey) {
      throw new ConvexError('User is already the trip owner');
    }

    // Check for duplicate membership
    const existing = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_trip_memberAuthUserKey', (q: any) =>
        q.eq('tripId', args.tripId).eq('memberAuthUserKey', user.authUserKey),
      )
      .unique();

    if (existing) {
      throw new ConvexError('User is already a member of this trip');
    }

    await ctx.db.insert('plannerTripMembers', {
      tripId: args.tripId,
      memberAuthUserKey: user.authUserKey,
      addedAt: Date.now(),
    });

    return {
      auth_user_key: user.authUserKey,
      username: user.username,
      email: user.email,
      avatar_url: user.avatarUrl || null,
    };
  },
});

export const removeTripMember = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    memberAuthUserKey: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const trip = await requireTripAccess(ctx, args.tripId);

    const isOwner = trip.ownerAuthUserKey === authUserKey;
    const isSelf = args.memberAuthUserKey === authUserKey;

    if (!isOwner && !isSelf) {
      throw new ConvexError('Only the trip owner or the member themselves can remove a member');
    }

    const membership = await ctx.db
      .query('plannerTripMembers')
      .withIndex('by_trip_memberAuthUserKey', (q: any) =>
        q.eq('tripId', args.tripId).eq('memberAuthUserKey', args.memberAuthUserKey),
      )
      .unique();

    if (!membership) {
      throw new ConvexError('Member not found');
    }

    await ctx.db.delete(membership._id);

    return { success: true };
  },
});
