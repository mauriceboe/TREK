import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, formatAccommodation } from './helpers';

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db
      .query('plannerAccommodations')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    // Enrich with place name
    const result = [];
    for (const acc of items) {
      const place = await ctx.db.get(acc.placeId);
      result.push({
        ...formatAccommodation(acc),
        name: place?.name || 'Unknown',
        address: place?.address || null,
      });
    }
    return { accommodations: result };
  },
});

export const create = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const id = await ctx.db.insert('plannerAccommodations', {
      tripId: args.tripId,
      placeId: d.place_id || d.placeId,
      startDayId: d.start_day_id || d.startDayId,
      endDayId: d.end_day_id || d.endDayId,
      checkIn: d.check_in || d.checkIn || null,
      checkOut: d.check_out || d.checkOut || null,
      confirmation: d.confirmation || null,
      notes: d.notes || null,
      createdAt: Date.now(),
    });
    const acc = await ctx.db.get(id) as any;
    const place = acc ? await ctx.db.get(acc.placeId) : null;
    return { accommodation: { ...formatAccommodation(acc), name: (place as any)?.name || '', address: (place as any)?.address || null } };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.string(), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: any = {};
    if (d.check_in !== undefined || d.checkIn !== undefined) patch.checkIn = d.check_in ?? d.checkIn ?? null;
    if (d.check_out !== undefined || d.checkOut !== undefined) patch.checkOut = d.check_out ?? d.checkOut ?? null;
    if (d.confirmation !== undefined) patch.confirmation = d.confirmation;
    if (d.notes !== undefined) patch.notes = d.notes;
    if (d.start_day_id !== undefined || d.startDayId !== undefined) patch.startDayId = d.start_day_id ?? d.startDayId;
    if (d.end_day_id !== undefined || d.endDayId !== undefined) patch.endDayId = d.end_day_id ?? d.endDayId;
    await ctx.db.patch(args.itemId as any, patch);
    const acc = await ctx.db.get(args.itemId as any) as any;
    const place = acc ? await ctx.db.get(acc.placeId) : null;
    return { accommodation: { ...formatAccommodation(acc), name: (place as any)?.name || '', address: (place as any)?.address || null } };
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
