import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, getViewerAuthKey, formatTrip, formatDay, formatPlace, formatAssignment, formatAccommodation } from './helpers';

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export const getLink = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const link = await ctx.db
      .query('plannerShareTokens')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .unique();

    if (!link) return { link: null };
    return {
      link: {
        id: link._id,
        token: link.token,
        trip_id: args.tripId,
        share_map: link.shareMap ?? true,
        share_bookings: link.shareBookings ?? true,
        share_packing: link.sharePacking ?? true,
        share_budget: link.shareBudget ?? true,
        share_collab: link.shareCollab ?? true,
        created_at: new Date(link.createdAt).toISOString(),
      },
    };
  },
});

export const createLink = rawMutation({
  args: { tripId: v.id('plannerTrips'), permissions: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const perms = (args.permissions || {}) as any;

    // Delete existing link first
    const existing = await ctx.db
      .query('plannerShareTokens')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);

    const token = generateToken();
    const id = await ctx.db.insert('plannerShareTokens', {
      tripId: args.tripId,
      token,
      createdBy: authUserKey,
      shareMap: perms.share_map ?? true,
      shareBookings: perms.share_bookings ?? true,
      sharePacking: perms.share_packing ?? true,
      shareBudget: perms.share_budget ?? true,
      shareCollab: perms.share_collab ?? true,
      createdAt: Date.now(),
    });

    const link = await ctx.db.get(id);
    return {
      link: {
        id: link!._id,
        token: link!.token,
        trip_id: args.tripId,
        share_map: link!.shareMap ?? true,
        share_bookings: link!.shareBookings ?? true,
        share_packing: link!.sharePacking ?? true,
        share_budget: link!.shareBudget ?? true,
        share_collab: link!.shareCollab ?? true,
        created_at: new Date(link!.createdAt).toISOString(),
      },
    };
  },
});

export const deleteLink = rawMutation({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const existing = await ctx.db
      .query('plannerShareTokens')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { success: true };
  },
});

export const updateLinkPermissions = rawMutation({
  args: { tripId: v.id('plannerTrips'), permissions: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const perms = args.permissions as any;
    const existing = await ctx.db
      .query('plannerShareTokens')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .unique();
    if (!existing) throw new ConvexError('No share link found');

    const patch: Record<string, any> = {};
    if (perms.share_map !== undefined) patch.shareMap = perms.share_map;
    if (perms.share_bookings !== undefined) patch.shareBookings = perms.share_bookings;
    if (perms.share_packing !== undefined) patch.sharePacking = perms.share_packing;
    if (perms.share_budget !== undefined) patch.shareBudget = perms.share_budget;
    if (perms.share_collab !== undefined) patch.shareCollab = perms.share_collab;

    await ctx.db.patch(existing._id, patch);
    const updated = await ctx.db.get(existing._id);
    return {
      link: {
        id: updated!._id,
        token: updated!.token,
        trip_id: args.tripId,
        share_map: updated!.shareMap ?? true,
        share_bookings: updated!.shareBookings ?? true,
        share_packing: updated!.sharePacking ?? true,
        share_budget: updated!.shareBudget ?? true,
        share_collab: updated!.shareCollab ?? true,
        created_at: new Date(updated!.createdAt).toISOString(),
      },
    };
  },
});

export const getSharedTrip = rawQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query('plannerShareTokens')
      .withIndex('by_token', (q: any) => q.eq('token', args.token))
      .unique();
    if (!link) return null;

    const trip = await ctx.db.get(link.tripId);
    if (!trip) return null;

    const permissions = {
      share_map: link.shareMap ?? true,
      share_bookings: link.shareBookings ?? true,
      share_packing: link.sharePacking ?? true,
      share_budget: link.shareBudget ?? true,
      share_collab: link.shareCollab ?? true,
    };

    // Always include basic trip data and days
    const days = await ctx.db
      .query('plannerDays')
      .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', link.tripId))
      .collect();

    const places = await ctx.db
      .query('plannerPlaces')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
      .collect();

    const assignments = await ctx.db
      .query('plannerDayAssignments')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
      .collect();

    const result: Record<string, any> = {
      trip: formatTrip(trip),
      days: days.map(formatDay),
      places: places.map(formatPlace),
      assignments: assignments.map(formatAssignment),
      permissions,
    };

    // Conditional data based on permissions
    if (permissions.share_bookings) {
      const reservations = await ctx.db
        .query('plannerReservations')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
        .collect();
      const accommodations = await ctx.db
        .query('plannerAccommodations')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
        .collect();
      result.reservations = reservations.map((r) => ({
        id: r._id, _id: r._id, name: r.name, type: r.type, status: r.status,
        date: r.date, time: r.time, location: r.location,
        confirmation_number: r.confirmationNumber, notes: r.notes, url: r.url,
      }));
      result.accommodations = accommodations.map(formatAccommodation);
    }

    if (permissions.share_packing) {
      const packingItems = await ctx.db
        .query('plannerPackingItems')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
        .collect();
      result.packing = packingItems.map((i) => ({
        id: i._id, name: i.name, category: i.category, checked: i.checked,
        quantity: i.quantity,
      }));
    }

    if (permissions.share_budget) {
      const budgetItems = await ctx.db
        .query('plannerBudgetItems')
        .withIndex('by_tripId', (q: any) => q.eq('tripId', link.tripId))
        .collect();
      result.budget = budgetItems.map((b) => ({
        id: b._id, name: b.name, amount: b.amount, currency: b.currency,
        category: b.category, note: b.note,
      }));
    }

    return result;
  },
});
