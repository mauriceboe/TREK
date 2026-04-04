import { ConvexError, v } from 'convex/values';
import { queryGeneric as query, mutationGeneric as mutation } from 'convex/server';
import {
  requireTripAccess,
  formatAssignment,
  formatPlace,
  formatCategory,
  formatTag,
} from './helpers';

// ── Queries ──────────────────────────────────────────────

export const listAssignments = query({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const assignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_dayId_orderIndex', (q: any) => q.eq('dayId', args.dayId))
      .collect();

    const results = [];

    for (const assignment of assignments) {
      const place = await ctx.db.get(assignment.placeId);

      let category = null;
      if (place?.categoryId) {
        const categoryDoc = await ctx.db.get(place.categoryId);
        if (categoryDoc) category = formatCategory(categoryDoc);
      }

      let tags: ReturnType<typeof formatTag>[] = [];
      if (place) {
        const placeTags = await ctx.db
          .query('plannerPlaceTags')
          .withIndex('by_placeId', (q: any) => q.eq('placeId', place._id))
          .collect();
        for (const pt of placeTags) {
          const tagDoc = await ctx.db.get(pt.tagId);
          if (tagDoc) tags.push(formatTag(tagDoc));
        }
      }

      const participants = await ctx.db
        .query('plannerAssignmentParticipants')
        .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', assignment._id))
        .collect();

      results.push({
        ...formatAssignment(assignment),
        place: place ? { ...formatPlace(place), category, tags } : null,
        participants: participants.map((p: any) => ({ userAuthKey: p.userAuthKey })),
      });
    }

    return results;
  },
});

// ── Mutations ────────────────────────────────────────────

export const assignPlace = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
    placeId: v.id('plannerPlaces'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    // Find max orderIndex on this day
    const existing = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_dayId_orderIndex', (q: any) => q.eq('dayId', args.dayId))
      .collect();

    const maxOrder = existing.length > 0
      ? Math.max(...existing.map((a: any) => a.orderIndex))
      : -1;

    const id = await ctx.db.insert('plannerDayAssignments', {
      tripId: args.tripId,
      dayId: args.dayId,
      placeId: args.placeId,
      orderIndex: maxOrder + 1,
      notes: null,
      assignmentTime: null,
      assignmentEndTime: null,
      createdAt: Date.now(),
    });

    return { _id: id };
  },
});

export const removeAssignment = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    assignmentId: v.id('plannerDayAssignments'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new ConvexError('Assignment not found');
    if (String(assignment.tripId) !== String(args.tripId)) {
      throw new ConvexError('Assignment does not belong to this trip');
    }

    // Delete participants
    const participants = await ctx.db
      .query('plannerAssignmentParticipants')
      .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', args.assignmentId))
      .collect();
    for (const p of participants) {
      await ctx.db.delete(p._id);
    }

    // Delete assignment
    await ctx.db.delete(args.assignmentId);
  },
});

export const reorderAssignments = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
    orderedIds: v.array(v.id('plannerDayAssignments')),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    for (let i = 0; i < args.orderedIds.length; i++) {
      await ctx.db.patch(args.orderedIds[i], { orderIndex: i });
    }
  },
});

export const moveAssignment = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    assignmentId: v.id('plannerDayAssignments'),
    newDayId: v.id('plannerDays'),
    orderIndex: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new ConvexError('Assignment not found');
    if (String(assignment.tripId) !== String(args.tripId)) {
      throw new ConvexError('Assignment does not belong to this trip');
    }

    const oldDayId = assignment.dayId;

    await ctx.db.patch(args.assignmentId, {
      dayId: args.newDayId,
      orderIndex: args.orderIndex,
    });

    return { oldDayId, newDayId: args.newDayId };
  },
});

export const updateAssignmentTime = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    assignmentId: v.id('plannerDayAssignments'),
    assignmentTime: v.union(v.string(), v.null()),
    assignmentEndTime: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new ConvexError('Assignment not found');
    if (String(assignment.tripId) !== String(args.tripId)) {
      throw new ConvexError('Assignment does not belong to this trip');
    }

    await ctx.db.patch(args.assignmentId, {
      assignmentTime: args.assignmentTime,
      assignmentEndTime: args.assignmentEndTime,
    });
  },
});

export const setParticipants = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    assignmentId: v.id('plannerDayAssignments'),
    userAuthKeys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    // Delete all existing participants
    const existing = await ctx.db
      .query('plannerAssignmentParticipants')
      .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', args.assignmentId))
      .collect();
    for (const p of existing) {
      await ctx.db.delete(p._id);
    }

    // Insert new participants
    for (const userAuthKey of args.userAuthKeys) {
      await ctx.db.insert('plannerAssignmentParticipants', {
        assignmentId: args.assignmentId,
        userAuthKey,
      });
    }
  },
});
