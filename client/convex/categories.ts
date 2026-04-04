import { ConvexError, v } from 'convex/values';
import { queryGeneric as query, mutationGeneric as mutation } from 'convex/server';
import { getViewerAuthKey, formatCategory } from './helpers';

export const listCategories = query({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);

    const global = await ctx.db
      .query('plannerCategories')
      .withIndex('by_ownerAuthUserKey', (q: any) => q.eq('ownerAuthUserKey', null))
      .collect();

    const personal = await ctx.db
      .query('plannerCategories')
      .withIndex('by_ownerAuthUserKey', (q: any) => q.eq('ownerAuthUserKey', authUserKey))
      .collect();

    return [...global, ...personal].map(formatCategory);
  },
});

export const createCategory = mutation({
  args: {
    name: v.string(),
    color: v.string(),
    icon: v.string(),
    global: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const id = await ctx.db.insert('plannerCategories', {
      name: args.name,
      color: args.color,
      icon: args.icon,
      ownerAuthUserKey: args.global ? null : authUserKey,
      createdAt: Date.now(),
    });
    const doc = await ctx.db.get(id);
    return formatCategory(doc!);
  },
});

export const updateCategory = mutation({
  args: {
    categoryId: v.id('plannerCategories'),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    const existing = await ctx.db.get(args.categoryId);
    if (!existing) throw new ConvexError('Category not found');

    const patch: Record<string, any> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.icon !== undefined) patch.icon = args.icon;

    await ctx.db.patch(args.categoryId, patch);
    const doc = await ctx.db.get(args.categoryId);
    return formatCategory(doc!);
  },
});

export const deleteCategory = mutation({
  args: { categoryId: v.id('plannerCategories') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    const existing = await ctx.db.get(args.categoryId);
    if (!existing) throw new ConvexError('Category not found');

    // Nullify categoryId on places that reference this category
    const places = await ctx.db.query('plannerPlaces').collect();
    for (const place of places) {
      if (place.categoryId === args.categoryId) {
        await ctx.db.patch(place._id, { categoryId: null });
      }
    }

    await ctx.db.delete(args.categoryId);
    return { success: true };
  },
});
