import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { v } from 'convex/values';

const DEFAULT_ADDONS = [
  { addonId: 'packing', name: 'Packing List', description: 'Pack your bags with checklists per trip', type: 'trip', icon: 'ListChecks', enabled: true, sortOrder: 0 },
  { addonId: 'budget', name: 'Budget Planner', description: 'Track expenses and plan your travel budget', type: 'trip', icon: 'Wallet', enabled: true, sortOrder: 1 },
  { addonId: 'documents', name: 'Documents', description: 'Store and manage travel documents', type: 'trip', icon: 'FileText', enabled: true, sortOrder: 2 },
  { addonId: 'collab', name: 'Collab', description: 'Notes, polls, and live chat for trip collaboration', type: 'trip', icon: 'Users', enabled: true, sortOrder: 6 },
  { addonId: 'vacay', name: 'Vacay', description: 'Personal vacation day planner with calendar view', type: 'global', icon: 'CalendarDays', enabled: true, sortOrder: 10 },
  { addonId: 'atlas', name: 'Atlas', description: 'World map of your visited countries with travel stats', type: 'global', icon: 'Globe', enabled: true, sortOrder: 11 },
  { addonId: 'memories', name: 'Memories', description: 'Photo memories for your trips', type: 'trip', icon: 'Camera', enabled: true, sortOrder: 7 },
];

/** Get enabled addons. Seeds defaults if none exist. */
export const enabled = rawQuery({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query('addons').collect();
    if (existing.length === 0) {
      // Return defaults (they'll be seeded on first mutation)
      return { addons: DEFAULT_ADDONS.filter(a => a.enabled).map(a => ({ id: a.addonId, ...a })) };
    }
    return {
      addons: existing
        .filter(a => a.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(a => ({ id: a.addonId, name: a.name, type: a.type, icon: a.icon, enabled: a.enabled })),
    };
  },
});

/** Seed default addons if they don't exist */
export const seedDefaults = rawMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query('addons').collect();
    if (existing.length > 0) return;
    for (const addon of DEFAULT_ADDONS) {
      await ctx.db.insert('addons', addon);
    }
  },
});

/** Update addon enabled state (admin) */
export const updateAddon = rawMutation({
  args: { addonId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const addon = await ctx.db
      .query('addons')
      .withIndex('by_addonId', (q) => q.eq('addonId', args.addonId))
      .unique();
    if (addon) {
      await ctx.db.patch(addon._id, { enabled: args.enabled });
    }
    return { success: true };
  },
});
