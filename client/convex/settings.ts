import { v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import type { QueryCtx } from './_generated/server';

async function getAuthUserKey(ctx: QueryCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Authentication required');
  return String(identity.subject);
}

export const getSettings = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getAuthUserKey(ctx);
    const rows = await ctx.db
      .query('userSettings')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .collect();
    const settings: Record<string, any> = {};
    for (const row of rows) {
      try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
    }
    return { settings };
  },
});

export const setSetting = rawMutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, args) => {
    const authUserKey = await getAuthUserKey(ctx);
    const existing = await ctx.db
      .query('userSettings')
      .withIndex('by_authUserKey_key', (q) => q.eq('authUserKey', authUserKey).eq('key', args.key))
      .unique();
    const serialized = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
    if (existing) {
      await ctx.db.patch(existing._id, { value: serialized });
    } else {
      await ctx.db.insert('userSettings', { authUserKey, key: args.key, value: serialized });
    }
    return { success: true };
  },
});

export const setBulk = rawMutation({
  args: { settings: v.any() },
  handler: async (ctx, args) => {
    const authUserKey = await getAuthUserKey(ctx);
    const obj = args.settings as Record<string, any>;
    for (const [key, value] of Object.entries(obj)) {
      const existing = await ctx.db
        .query('userSettings')
        .withIndex('by_authUserKey_key', (q) => q.eq('authUserKey', authUserKey).eq('key', key))
        .unique();
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (existing) {
        await ctx.db.patch(existing._id, { value: serialized });
      } else {
        await ctx.db.insert('userSettings', { authUserKey, key, value: serialized });
      }
    }
    return { success: true };
  },
});
