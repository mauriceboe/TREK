import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess } from './helpers';

function formatReservation(r: any) {
  return {
    id: r._id, _id: r._id, trip_id: r.tripId, name: r.name, type: r.type ?? null,
    status: r.status, date: r.date ?? null, time: r.time ?? null,
    reservation_time: r.reservationTime ?? null, reservation_end_time: r.reservationEndTime ?? null,
    location: r.location ?? null, confirmation_number: r.confirmationNumber ?? null,
    notes: r.notes ?? null, url: r.url ?? null, assignment_id: r.assignmentId ?? null,
    accommodation_id: r.accommodationId ?? null, day_plan_position: r.dayPlanPosition ?? null,
    metadata: r.metadata ?? null, created_at: new Date(r.createdAt).toISOString(),
  };
}

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db
      .query('plannerReservations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    return { reservations: items.map(formatReservation) };
  },
});

export const create = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const now = Date.now();
    const id = await ctx.db.insert('plannerReservations', {
      tripId: args.tripId, name: d.name || '', type: d.type || null,
      status: d.status || 'pending', date: d.date || null, time: d.time || null,
      reservationTime: d.reservation_time || null, reservationEndTime: d.reservation_end_time || null,
      location: d.location || null, confirmationNumber: d.confirmation_number || null,
      notes: d.notes || null, url: d.url || null,
      assignmentId: d.assignment_id || null, accommodationId: d.accommodation_id || null,
      dayPlanPosition: d.day_plan_position ?? null, metadata: d.metadata || null,
      createdAt: now, updatedAt: now,
    });
    const item = await ctx.db.get(id);
    return { reservation: formatReservation(item) };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.string(), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: any = { updatedAt: Date.now() };
    if (d.name !== undefined) patch.name = d.name;
    if (d.type !== undefined) patch.type = d.type;
    if (d.status !== undefined) patch.status = d.status;
    if (d.date !== undefined) patch.date = d.date;
    if (d.time !== undefined) patch.time = d.time;
    if (d.reservation_time !== undefined) patch.reservationTime = d.reservation_time;
    if (d.reservation_end_time !== undefined) patch.reservationEndTime = d.reservation_end_time;
    if (d.location !== undefined) patch.location = d.location;
    if (d.confirmation_number !== undefined) patch.confirmationNumber = d.confirmation_number;
    if (d.notes !== undefined) patch.notes = d.notes;
    if (d.url !== undefined) patch.url = d.url;
    if (d.assignment_id !== undefined) patch.assignmentId = d.assignment_id;
    if (d.accommodation_id !== undefined) patch.accommodationId = d.accommodation_id;
    if (d.day_plan_position !== undefined) patch.dayPlanPosition = d.day_plan_position;
    if (d.metadata !== undefined) patch.metadata = d.metadata;
    await ctx.db.patch(args.itemId as any, patch);
    const item = await ctx.db.get(args.itemId as any);
    return { reservation: formatReservation(item) };
  },
});

export const remove = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.string() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.delete(args.itemId as any);
    return { success: true };
  },
});

export const updatePositions = rawMutation({
  args: { tripId: v.id('plannerTrips'), positions: v.array(v.object({ id: v.string(), day_plan_position: v.number() })) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    for (const p of args.positions) {
      await ctx.db.patch(p.id as any, { dayPlanPosition: p.day_plan_position, updatedAt: Date.now() });
    }
    return { success: true };
  },
});
