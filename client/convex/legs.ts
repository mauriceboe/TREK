import { ConvexError, v } from 'convex/values';
import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server';
import type { Id } from './_generated/dataModel';
import { requireTripAccess, formatLeg, LEG_COLORS } from './helpers';

// ── Internal helpers ────────────────────────────────────

type Ctx = {
  auth: { getUserIdentity: () => Promise<unknown> };
  db: any;
};

async function getDayCount(ctx: Ctx, tripId: Id<'plannerTrips'>): Promise<number> {
  const days = await ctx.db
    .query('plannerDays')
    .withIndex('by_trip_dayNumber', (q: any) => q.eq('tripId', tripId))
    .collect();
  return days.length;
}

async function hasOverlap(
  ctx: Ctx,
  tripId: Id<'plannerTrips'>,
  start: number,
  end: number,
  excludeLegId?: Id<'plannerTripLegs'>,
): Promise<boolean> {
  const legs = await ctx.db
    .query('plannerTripLegs')
    .withIndex('by_tripId', (q: any) => q.eq('tripId', tripId))
    .collect();

  for (const leg of legs) {
    if (excludeLegId && String(leg._id) === String(excludeLegId)) continue;
    if (start <= leg.endDayNumber && end >= leg.startDayNumber) {
      return true;
    }
  }
  return false;
}

// ── Queries ─────────────────────────────────────────────

export const listLegs = query({
  args: {
    tripId: v.id('plannerTrips'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const legs = await ctx.db
      .query('plannerTripLegs')
      .withIndex('by_tripId_range', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    return legs.map(formatLeg);
  },
});

// ── Mutations ───────────────────────────────────────────

export const createLeg = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    destinationName: v.string(),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
    startDayNumber: v.number(),
    endDayNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);

    const { startDayNumber, endDayNumber, tripId } = args;

    // Validate range
    if (startDayNumber < 1 || endDayNumber < 1) {
      throw new ConvexError('Day numbers must be >= 1');
    }
    if (startDayNumber > endDayNumber) {
      throw new ConvexError('Start day must be <= end day');
    }

    const dayCount = await getDayCount(ctx, tripId);
    if (startDayNumber > dayCount || endDayNumber > dayCount) {
      throw new ConvexError('Day numbers must be within trip day count');
    }

    // Check overlap
    if (await hasOverlap(ctx, tripId, startDayNumber, endDayNumber)) {
      throw new ConvexError('Leg overlaps with an existing leg');
    }

    // Auto-assign color
    const existingLegs = await ctx.db
      .query('plannerTripLegs')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', tripId))
      .collect();
    const color = LEG_COLORS[existingLegs.length % LEG_COLORS.length];

    const now = Date.now();
    const legId = await ctx.db.insert('plannerTripLegs', {
      tripId,
      destinationName: args.destinationName,
      destinationAddress: args.destinationAddress ?? null,
      destinationLat: args.destinationLat ?? null,
      destinationLng: args.destinationLng ?? null,
      destinationViewportSouth: args.destinationViewportSouth ?? null,
      destinationViewportWest: args.destinationViewportWest ?? null,
      destinationViewportNorth: args.destinationViewportNorth ?? null,
      destinationViewportEast: args.destinationViewportEast ?? null,
      startDayNumber,
      endDayNumber,
      color,
      createdAt: now,
      updatedAt: now,
    });

    const leg = await ctx.db.get(legId);
    return leg ? formatLeg(leg) : null;
  },
});

export const updateLeg = mutation({
  args: {
    legId: v.id('plannerTripLegs'),
    destinationName: v.optional(v.string()),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
    startDayNumber: v.optional(v.number()),
    endDayNumber: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new ConvexError('Leg not found');

    await requireTripAccess(ctx, leg.tripId);

    const startDayNumber = args.startDayNumber ?? leg.startDayNumber;
    const endDayNumber = args.endDayNumber ?? leg.endDayNumber;

    // Validate range
    if (startDayNumber < 1 || endDayNumber < 1) {
      throw new ConvexError('Day numbers must be >= 1');
    }
    if (startDayNumber > endDayNumber) {
      throw new ConvexError('Start day must be <= end day');
    }

    const dayCount = await getDayCount(ctx, leg.tripId);
    if (startDayNumber > dayCount || endDayNumber > dayCount) {
      throw new ConvexError('Day numbers must be within trip day count');
    }

    // Check overlap excluding self
    if (await hasOverlap(ctx, leg.tripId, startDayNumber, endDayNumber, args.legId)) {
      throw new ConvexError('Leg overlaps with an existing leg');
    }

    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (args.destinationName !== undefined) patch.destinationName = args.destinationName;
    if (args.destinationAddress !== undefined) patch.destinationAddress = args.destinationAddress;
    if (args.destinationLat !== undefined) patch.destinationLat = args.destinationLat;
    if (args.destinationLng !== undefined) patch.destinationLng = args.destinationLng;
    if (args.destinationViewportSouth !== undefined) patch.destinationViewportSouth = args.destinationViewportSouth;
    if (args.destinationViewportWest !== undefined) patch.destinationViewportWest = args.destinationViewportWest;
    if (args.destinationViewportNorth !== undefined) patch.destinationViewportNorth = args.destinationViewportNorth;
    if (args.destinationViewportEast !== undefined) patch.destinationViewportEast = args.destinationViewportEast;
    if (args.startDayNumber !== undefined) patch.startDayNumber = args.startDayNumber;
    if (args.endDayNumber !== undefined) patch.endDayNumber = args.endDayNumber;

    await ctx.db.patch(args.legId, patch);

    const updated = await ctx.db.get(args.legId);
    return updated ? formatLeg(updated) : null;
  },
});

export const deleteLeg = mutation({
  args: {
    tripId: v.id('plannerTrips'),
    legId: v.id('plannerTripLegs'),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new ConvexError('Leg not found');

    await ctx.db.delete(args.legId);
  },
});

// ── Exported helper (NOT a mutation) ────────────────────
// Call this from trips.ts mutations to sync legs when day count changes.

export async function syncLegsToDayCount(
  ctx: Ctx,
  tripId: Id<'plannerTrips'>,
): Promise<void> {
  const dayCount = await getDayCount(ctx, tripId);

  const legs = await ctx.db
    .query('plannerTripLegs')
    .withIndex('by_tripId', (q: any) => q.eq('tripId', tripId))
    .collect();

  for (const leg of legs) {
    if (leg.startDayNumber > dayCount) {
      await ctx.db.delete(leg._id);
    } else if (leg.endDayNumber > dayCount) {
      await ctx.db.patch(leg._id, {
        endDayNumber: dayCount,
        updatedAt: Date.now(),
      });
    }
  }
}
