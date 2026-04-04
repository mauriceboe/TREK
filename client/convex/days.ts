import { ConvexError, v } from 'convex/values';
import { queryGeneric as query, mutationGeneric as mutation } from 'convex/server';
import {
  requireTripAccess,
  formatDay,
  formatAssignment,
  formatPlace,
  formatCategory,
  formatTag,
  formatDayNote,
  formatAccommodation,
} from './helpers';
import { syncLegsToDayCount } from './legs';

// ── Queries ──────────────────────────────────────────────

export const listDays = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    // Batch-fetch everything at the trip level
    const [days, assignments, places, dayNotes] = await Promise.all([
      ctx.db
        .query('plannerDays')
        .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
        .collect(),
      ctx.db
        .query('plannerDayAssignments')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
        .collect(),
      ctx.db
        .query('plannerPlaces')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
        .collect(),
      ctx.db
        .query('plannerDayNotes')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
        .collect(),
    ]);

    // Build place lookup
    const placeMap = new Map<string, (typeof places)[0]>();
    for (const place of places) {
      placeMap.set(String(place._id), place);
    }

    // Collect all unique categoryIds and placeIds for tags
    const categoryIds = new Set<string>();
    const placeIds = new Set<string>();
    for (const place of places) {
      if (place.categoryId) categoryIds.add(String(place.categoryId));
      placeIds.add(String(place._id));
    }

    // Fetch categories
    const categoryMap = new Map<string, ReturnType<typeof formatCategory>>();
    for (const catId of categoryIds) {
      const doc = await ctx.db.get(catId as any);
      if (doc) categoryMap.set(catId, formatCategory(doc as any));
    }

    // Fetch all place-tag joins for the trip's places
    const placeTagMap = new Map<string, ReturnType<typeof formatTag>[]>();
    for (const placeId of placeIds) {
      const placeTags = await ctx.db
        .query('plannerPlaceTags')
        .withIndex('by_placeId', (q: any) => q.eq('placeId', placeId))
        .collect();
      if (placeTags.length > 0) {
        const tags: ReturnType<typeof formatTag>[] = [];
        for (const pt of placeTags) {
          const tagDoc = await ctx.db.get(pt.tagId);
          if (tagDoc) tags.push(formatTag(tagDoc as any));
        }
        placeTagMap.set(placeId, tags);
      }
    }

    // Fetch all participants for the trip's assignments
    const assignmentIds = assignments.map((a: any) => String(a._id));
    const participantMap = new Map<string, { userAuthKey: string }[]>();
    for (const assignmentId of assignmentIds) {
      const participants = await ctx.db
        .query('plannerAssignmentParticipants')
        .withIndex('by_assignmentId', (q: any) => q.eq('assignmentId', assignmentId))
        .collect();
      participantMap.set(
        assignmentId,
        participants.map((p: any) => ({ userAuthKey: p.userAuthKey })),
      );
    }

    // Group assignments by dayId
    const assignmentsByDay = new Map<string, (typeof assignments)[0][]>();
    for (const assignment of assignments) {
      const dayKey = String(assignment.dayId);
      if (!assignmentsByDay.has(dayKey)) assignmentsByDay.set(dayKey, []);
      assignmentsByDay.get(dayKey)!.push(assignment);
    }

    // Group day notes by dayId
    const notesByDay = new Map<string, (typeof dayNotes)[0][]>();
    for (const note of dayNotes) {
      const dayKey = String(note.dayId);
      if (!notesByDay.has(dayKey)) notesByDay.set(dayKey, []);
      notesByDay.get(dayKey)!.push(note);
    }

    // Assemble result (days are already ordered by dayNumber from the index)
    return days.map((day: any) => {
      const dayKey = String(day._id);

      // Assignments sorted by orderIndex
      const dayAssignments = (assignmentsByDay.get(dayKey) || [])
        .sort((a: any, b: any) => a.orderIndex - b.orderIndex)
        .map((assignment: any) => {
          const place = placeMap.get(String(assignment.placeId));
          const placeFormatted = place ? formatPlace(place as any) : null;
          const category = place?.categoryId
            ? categoryMap.get(String(place.categoryId)) || null
            : null;
          const tags = place
            ? placeTagMap.get(String(place._id)) || []
            : [];
          const participants = participantMap.get(String(assignment._id)) || [];

          return {
            ...formatAssignment(assignment),
            place: placeFormatted ? { ...placeFormatted, category, tags } : null,
            participants,
          };
        });

      // Day notes sorted by sortOrder
      const notes = (notesByDay.get(dayKey) || [])
        .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
        .map((note: any) => formatDayNote(note));

      return {
        ...formatDay(day),
        assignments: dayAssignments,
        notes_items: notes,
      };
    });
  },
});

export const listAccommodations = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const accommodations = await ctx.db
      .query('plannerAccommodations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const results = [];
    for (const acc of accommodations) {
      const place = await ctx.db.get(acc.placeId);
      results.push({
        ...formatAccommodation(acc),
        place: place ? formatPlace(place as any) : null,
      });
    }

    return results;
  },
});

// ── Mutations ────────────────────────────────────────────

export const createDay = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    date: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    // Find max dayNumber
    const existingDays = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const maxDayNumber = existingDays.length > 0
      ? Math.max(...existingDays.map((d: any) => d.dayNumber))
      : 0;

    const dayId = await ctx.db.insert('plannerDays', {
      tripId: args.tripId,
      dayNumber: maxDayNumber + 1,
      date: args.date ?? null,
      notes: args.notes ?? null,
      title: null,
    });

    const day = await ctx.db.get(dayId);
    return day ? formatDay(day) : null;
  },
});

export const updateDay = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
    notes: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const day = await ctx.db.get(args.dayId);
    if (!day) throw new ConvexError('Day not found');
    if (String(day.tripId) !== String(args.tripId)) {
      throw new ConvexError('Day does not belong to this trip');
    }

    const patch: Record<string, any> = {};
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.title !== undefined) patch.title = args.title;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.dayId, patch);
    }

    const updated = await ctx.db.get(args.dayId);
    return updated ? formatDay(updated) : null;
  },
});

export const deleteDay = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const day = await ctx.db.get(args.dayId);
    if (!day) throw new ConvexError('Day not found');
    if (String(day.tripId) !== String(args.tripId)) {
      throw new ConvexError('Day does not belong to this trip');
    }

    // Delete assignments and their participants
    const assignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_dayId_orderIndex', (q: any) => q.eq('dayId', args.dayId))
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
      .withIndex('by_dayId', (q: any) => q.eq('dayId', args.dayId))
      .collect();
    for (const note of dayNotes) {
      await ctx.db.delete(note._id);
    }

    // Delete accommodations referencing this day (startDayId or endDayId)
    const accommodations = await ctx.db
      .query('plannerAccommodations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    for (const acc of accommodations) {
      if (String(acc.startDayId) === String(args.dayId) || String(acc.endDayId) === String(args.dayId)) {
        await ctx.db.delete(acc._id);
      }
    }

    // Delete the day itself
    await ctx.db.delete(args.dayId);

    // Renumber remaining days
    const remainingDays = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    remainingDays.sort((a: any, b: any) => a.dayNumber - b.dayNumber);
    for (let i = 0; i < remainingDays.length; i++) {
      if (remainingDays[i].dayNumber !== i + 1) {
        await ctx.db.patch(remainingDays[i]._id, { dayNumber: i + 1 });
      }
    }

    // Sync legs to new day count (clamp or delete legs that exceed bounds)
    await syncLegsToDayCount(ctx, args.tripId);

    return { success: true };
  },
});

export const createAccommodation = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    placeId: v.id('plannerPlaces'),
    startDayId: v.id('plannerDays'),
    endDayId: v.id('plannerDays'),
    checkIn: v.optional(v.union(v.string(), v.null())),
    checkOut: v.optional(v.union(v.string(), v.null())),
    confirmation: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const accId = await ctx.db.insert('plannerAccommodations', {
      tripId: args.tripId,
      placeId: args.placeId,
      startDayId: args.startDayId,
      endDayId: args.endDayId,
      checkIn: args.checkIn ?? null,
      checkOut: args.checkOut ?? null,
      confirmation: args.confirmation ?? null,
      notes: args.notes ?? null,
      createdAt: Date.now(),
    });

    const acc = await ctx.db.get(accId);
    return acc ? formatAccommodation(acc) : null;
  },
});

export const updateAccommodation = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    accommodationId: v.id('plannerAccommodations'),
    placeId: v.optional(v.id('plannerPlaces')),
    startDayId: v.optional(v.id('plannerDays')),
    endDayId: v.optional(v.id('plannerDays')),
    checkIn: v.optional(v.union(v.string(), v.null())),
    checkOut: v.optional(v.union(v.string(), v.null())),
    confirmation: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const acc = await ctx.db.get(args.accommodationId);
    if (!acc) throw new ConvexError('Accommodation not found');
    if (String(acc.tripId) !== String(args.tripId)) {
      throw new ConvexError('Accommodation does not belong to this trip');
    }

    const patch: Record<string, any> = {};
    if (args.placeId !== undefined) patch.placeId = args.placeId;
    if (args.startDayId !== undefined) patch.startDayId = args.startDayId;
    if (args.endDayId !== undefined) patch.endDayId = args.endDayId;
    if (args.checkIn !== undefined) patch.checkIn = args.checkIn;
    if (args.checkOut !== undefined) patch.checkOut = args.checkOut;
    if (args.confirmation !== undefined) patch.confirmation = args.confirmation;
    if (args.notes !== undefined) patch.notes = args.notes;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.accommodationId, patch);
    }

    const updated = await ctx.db.get(args.accommodationId);
    return updated ? formatAccommodation(updated) : null;
  },
});

export const deleteAccommodation = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    accommodationId: v.id('plannerAccommodations'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const acc = await ctx.db.get(args.accommodationId);
    if (!acc) throw new ConvexError('Accommodation not found');
    if (String(acc.tripId) !== String(args.tripId)) {
      throw new ConvexError('Accommodation does not belong to this trip');
    }

    await ctx.db.delete(args.accommodationId);

    return { success: true };
  },
});

// ── Day Notes CRUD ───────────────────────────────────────

export const createDayNote = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
    text: v.string(),
    time: v.optional(v.union(v.string(), v.null())),
    icon: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const now = Date.now();
    const id = await ctx.db.insert('plannerDayNotes', {
      dayId: args.dayId,
      tripId: args.tripId,
      text: args.text,
      time: args.time ?? null,
      icon: args.icon || '📝',
      sortOrder: args.sortOrder ?? 0,
      createdAt: now,
    });
    const doc = await ctx.db.get(id);
    return formatDayNote(doc!);
  },
});

export const updateDayNote = mutation({
  args: {
    noteId: v.id('plannerDayNotes'),
    text: v.optional(v.string()),
    time: v.optional(v.union(v.string(), v.null())),
    icon: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) throw new ConvexError('Day note not found');
    await requireTripAccess(ctx, note.tripId);

    const patch: Record<string, any> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.time !== undefined) patch.time = args.time;
    if (args.icon !== undefined) patch.icon = args.icon;
    if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;

    await ctx.db.patch(args.noteId, patch);
    const doc = await ctx.db.get(args.noteId);
    return formatDayNote(doc!);
  },
});

export const deleteDayNote = mutation({
  args: {
    noteId: v.id('plannerDayNotes'),
  },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) throw new ConvexError('Day note not found');
    await requireTripAccess(ctx, note.tripId);
    await ctx.db.delete(args.noteId);
    return { success: true };
  },
});
