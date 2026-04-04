import { ConvexError, v } from 'convex/values';
import { queryGeneric as query, mutationGeneric as mutation } from 'convex/server';
import { requireTripAccess, formatPlace, formatCategory, formatTag } from './helpers';

// ── Helpers ──────────────────────────────────────────────

async function attachCategoryAndTags(
  ctx: { db: any },
  placeDoc: any,
) {
  // Category
  let category = null;
  if (placeDoc.categoryId) {
    const catDoc = await ctx.db.get(placeDoc.categoryId);
    if (catDoc) category = formatCategory(catDoc);
  }

  // Tags via join table
  const placeTags = await ctx.db
    .query('plannerPlaceTags')
    .withIndex('by_placeId', (q: any) => q.eq('placeId', placeDoc._id))
    .collect();

  const tags = [];
  for (const pt of placeTags) {
    const tagDoc = await ctx.db.get(pt.tagId);
    if (tagDoc) tags.push(formatTag(tagDoc));
  }

  return {
    ...formatPlace(placeDoc),
    category,
    tags,
  };
}

// ── Queries ──────────────────────────────────────────────

export const listPlaces = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const places = await ctx.db
      .query('plannerPlaces')
      .withIndex('by_trip_createdAt', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const results = [];
    for (const place of places) {
      results.push(await attachCategoryAndTags(ctx, place));
    }
    return results;
  },
});

export const getPlace = query({
  args: {
    placeId: v.id('plannerPlaces'),
  },
  handler: async (ctx, args) => {
    const place = await ctx.db.get(args.placeId);
    if (!place) throw new ConvexError('Place not found');

    await requireTripAccess(ctx, place.tripId);

    return attachCategoryAndTags(ctx, place);
  },
});

// ── Mutations ────────────────────────────────────────────

export const createPlace = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    name: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    lat: v.optional(v.union(v.number(), v.null())),
    lng: v.optional(v.union(v.number(), v.null())),
    address: v.optional(v.union(v.string(), v.null())),
    categoryId: v.optional(v.union(v.id('plannerCategories'), v.null())),
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
    tagIds: v.optional(v.array(v.id('plannerTags'))),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const now = Date.now();
    const { tagIds, ...rest } = args;

    const placeId = await ctx.db.insert('plannerPlaces', {
      ...rest,
      description: rest.description ?? null,
      lat: rest.lat ?? null,
      lng: rest.lng ?? null,
      address: rest.address ?? null,
      categoryId: rest.categoryId ?? null,
      price: rest.price ?? null,
      currency: rest.currency ?? null,
      reservationStatus: rest.reservationStatus || 'none',
      reservationNotes: rest.reservationNotes ?? null,
      reservationDatetime: rest.reservationDatetime ?? null,
      placeTime: rest.placeTime ?? null,
      endTime: rest.endTime ?? null,
      notes: rest.notes ?? null,
      imageUrl: rest.imageUrl ?? null,
      googlePlaceId: rest.googlePlaceId ?? null,
      website: rest.website ?? null,
      phone: rest.phone ?? null,
      transportMode: rest.transportMode || 'walking',
      createdAt: now,
      updatedAt: now,
    });

    if (tagIds && tagIds.length > 0) {
      for (const tagId of tagIds) {
        await ctx.db.insert('plannerPlaceTags', { placeId, tagId });
      }
    }

    const place = await ctx.db.get(placeId);
    return attachCategoryAndTags(ctx, place);
  },
});

export const updatePlace = mutation({
  args: {
    placeId: v.id('plannerPlaces'),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    lat: v.optional(v.union(v.number(), v.null())),
    lng: v.optional(v.union(v.number(), v.null())),
    address: v.optional(v.union(v.string(), v.null())),
    categoryId: v.optional(v.union(v.id('plannerCategories'), v.null())),
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
    tagIds: v.optional(v.array(v.id('plannerTags'))),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.placeId);
    if (!existing) throw new ConvexError('Place not found');

    await requireTripAccess(ctx, existing.tripId);

    const { placeId, tagIds, ...updates } = args;

    await ctx.db.patch(placeId, {
      ...updates,
      updatedAt: Date.now(),
    });

    // Replace tags if tagIds provided
    if (tagIds !== undefined) {
      const existingTags = await ctx.db
        .query('plannerPlaceTags')
        .withIndex('by_placeId', (q: any) => q.eq('placeId', placeId))
        .collect();

      for (const pt of existingTags) {
        await ctx.db.delete(pt._id);
      }

      for (const tagId of tagIds) {
        await ctx.db.insert('plannerPlaceTags', { placeId, tagId });
      }
    }

    const updated = await ctx.db.get(placeId);
    return attachCategoryAndTags(ctx, updated);
  },
});

export const deletePlace = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    placeId: v.id('plannerPlaces'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const place = await ctx.db.get(args.placeId);
    if (!place) throw new ConvexError('Place not found');

    // Delete place_tags
    const placeTags = await ctx.db
      .query('plannerPlaceTags')
      .withIndex('by_placeId', (q: any) => q.eq('placeId', args.placeId))
      .collect();
    for (const pt of placeTags) {
      await ctx.db.delete(pt._id);
    }

    // Delete day_assignments and their participants
    const assignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_placeId', (q: any) => q.eq('placeId', args.placeId))
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

    // Delete accommodations referencing this place
    const accommodations = await ctx.db
      .query('plannerAccommodations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', place.tripId))
      .collect();
    for (const acc of accommodations) {
      if (String(acc.placeId) === String(args.placeId)) {
        await ctx.db.delete(acc._id);
      }
    }

    // Delete the place itself
    await ctx.db.delete(args.placeId);

    return { success: true };
  },
});
