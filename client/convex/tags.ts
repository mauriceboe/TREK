import { ConvexError, v } from 'convex/values';
import { queryGeneric as query, mutationGeneric as mutation } from 'convex/server';
import { getViewerAuthKey, formatTag } from './helpers';

export const listTags = query({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const tags = await ctx.db
      .query('plannerTags')
      .withIndex('by_ownerAuthUserKey', (q: any) => q.eq('ownerAuthUserKey', authUserKey))
      .collect();
    return tags.map(formatTag);
  },
});

export const createTag = mutation({
  args: {
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const id = await ctx.db.insert('plannerTags', {
      name: args.name,
      color: args.color,
      ownerAuthUserKey: authUserKey,
      createdAt: Date.now(),
    });
    const doc = await ctx.db.get(id);
    return formatTag(doc!);
  },
});

export const updateTag = mutation({
  args: {
    tagId: v.id('plannerTags'),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    const existing = await ctx.db.get(args.tagId);
    if (!existing) throw new ConvexError('Tag not found');

    const patch: Record<string, any> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;

    await ctx.db.patch(args.tagId, patch);
    const doc = await ctx.db.get(args.tagId);
    return formatTag(doc!);
  },
});

export const deleteTag = mutation({
  args: { tagId: v.id('plannerTags') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    const existing = await ctx.db.get(args.tagId);
    if (!existing) throw new ConvexError('Tag not found');

    // Remove all place-tag associations
    const placeTags = await ctx.db
      .query('plannerPlaceTags')
      .withIndex('by_tagId', (q: any) => q.eq('tagId', args.tagId))
      .collect();
    for (const pt of placeTags) {
      await ctx.db.delete(pt._id);
    }

    await ctx.db.delete(args.tagId);
    return { success: true };
  },
});
