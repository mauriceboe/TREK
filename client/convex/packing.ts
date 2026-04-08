import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, getViewerAuthKey } from './helpers';

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db
      .query('plannerPackingItems')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    return {
      items: items.map(i => ({
        id: i._id, _id: i._id, trip_id: args.tripId, name: i.name,
        category: i.category ?? null, checked: i.checked, quantity: i.quantity,
        weight_grams: i.weightGrams ?? null, bag_id: i.bagId ?? null,
        sort_order: i.sortOrder ?? 0,
      })),
    };
  },
});

export const create = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const id = await ctx.db.insert('plannerPackingItems', {
      tripId: args.tripId, name: d.name || '', category: d.category || null,
      checked: d.checked ? 1 : 0, quantity: Number(d.quantity) || 1,
      weightGrams: d.weight_grams != null ? Number(d.weight_grams) : null,
      bagId: d.bag_id || null, sortOrder: d.sort_order ?? 0,
      createdAt: Date.now(),
    });
    const item = await ctx.db.get(id) as any;
    return { item: { id, _id: id, trip_id: args.tripId, name: item.name, category: item.category, checked: item.checked, quantity: item.quantity, weight_grams: item.weightGrams, bag_id: item.bagId } };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.string(), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: any = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.category !== undefined) patch.category = d.category;
    if (d.checked !== undefined) patch.checked = d.checked ? 1 : 0;
    if (d.quantity !== undefined) patch.quantity = Number(d.quantity);
    if (d.weight_grams !== undefined) patch.weightGrams = d.weight_grams != null ? Number(d.weight_grams) : null;
    if (d.bag_id !== undefined) patch.bagId = d.bag_id;
    if (d.sort_order !== undefined) patch.sortOrder = d.sort_order;
    await ctx.db.patch(args.itemId as any, patch);
    const item = await ctx.db.get(args.itemId as any) as any;
    return { item: { id: args.itemId, _id: args.itemId, trip_id: args.tripId, name: item.name, category: item.category, checked: item.checked, quantity: item.quantity, weight_grams: item.weightGrams, bag_id: item.bagId } };
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

export const reorder = rawMutation({
  args: { tripId: v.id('plannerTrips'), orderedIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    for (let i = 0; i < args.orderedIds.length; i++) {
      await ctx.db.patch(args.orderedIds[i] as any, { sortOrder: i });
    }
    return { success: true };
  },
});

// ── Apply template ──────────────────────────────────────────

export const applyTemplate = rawMutation({
  args: { tripId: v.id('plannerTrips'), templateId: v.id('plannerPackingTemplates') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const template = await ctx.db.get(args.templateId);
    if (!template) throw new ConvexError('Template not found');

    const categories = await ctx.db
      .query('plannerPackingTemplateCategories')
      .withIndex('by_templateId', (q: any) => q.eq('templateId', args.templateId))
      .collect();

    const items: any[] = [];
    for (const cat of categories) {
      const catItems = await ctx.db
        .query('plannerPackingTemplateItems')
        .withIndex('by_categoryId', (q: any) => q.eq('categoryId', cat._id))
        .collect();

      for (const item of catItems) {
        const id = await ctx.db.insert('plannerPackingItems', {
          tripId: args.tripId,
          name: item.name,
          category: cat.name,
          checked: 0,
          quantity: 1,
          weightGrams: null,
          bagId: null,
          sortOrder: items.length,
          createdAt: Date.now(),
        });
        items.push({ id, name: item.name, category: cat.name });
      }
    }

    return { items, count: items.length };
  },
});

// ── Bulk import ─────────────────────────────────────────────

export const bulkImport = rawMutation({
  args: { tripId: v.id('plannerTrips'), items: v.array(v.any()) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const created: any[] = [];

    for (let i = 0; i < args.items.length; i++) {
      const d = args.items[i] as any;
      const id = await ctx.db.insert('plannerPackingItems', {
        tripId: args.tripId,
        name: d.name || '',
        category: d.category || null,
        checked: d.checked ? 1 : 0,
        quantity: Number(d.quantity) || 1,
        weightGrams: d.weight_grams != null ? Number(d.weight_grams) : null,
        bagId: d.bag_id || null,
        sortOrder: i,
        createdAt: Date.now(),
      });
      created.push({ id, name: d.name });
    }

    return { items: created, count: created.length };
  },
});
