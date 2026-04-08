import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { getViewerAuthKey } from './helpers';

/**
 * Cloud backup implementation using Convex.
 * Instead of SQLite file backups, this exports/imports trip data as JSON
 * stored in Convex file storage.
 */

async function requireAdmin(ctx: any): Promise<string> {
  const authUserKey = await getViewerAuthKey(ctx);
  const user = await ctx.db
    .query('plannerUsers')
    .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', authUserKey))
    .unique();
  if (!user || user.role !== 'admin') throw new ConvexError('Admin access required');
  return authUserKey;
}

export const list = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const settings = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'backups'))
      .unique();

    if (!settings) return { backups: [] };
    try {
      const backups = JSON.parse(settings.value);
      return { backups: Array.isArray(backups) ? backups : [] };
    } catch {
      return { backups: [] };
    }
  },
});

export const create = rawMutation({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await requireAdmin(ctx);
    const now = Date.now();

    // Collect all data
    const users = await ctx.db.query('plannerUsers').collect();
    const trips = await ctx.db.query('plannerTrips').collect();
    const tripMembers = await ctx.db.query('plannerTripMembers').collect();
    const days = await ctx.db.query('plannerDays').collect();
    const places = await ctx.db.query('plannerPlaces').collect();
    const assignments = await ctx.db.query('plannerDayAssignments').collect();
    const participants = await ctx.db.query('plannerAssignmentParticipants').collect();
    const legs = await ctx.db.query('plannerTripLegs').collect();
    const categories = await ctx.db.query('plannerCategories').collect();
    const tags = await ctx.db.query('plannerTags').collect();
    const placeTags = await ctx.db.query('plannerPlaceTags').collect();
    const dayNotes = await ctx.db.query('plannerDayNotes').collect();
    const accommodations = await ctx.db.query('plannerAccommodations').collect();
    const reservations = await ctx.db.query('plannerReservations').collect();
    const budgetItems = await ctx.db.query('plannerBudgetItems').collect();
    const budgetMembers = await ctx.db.query('plannerBudgetMembers').collect();
    const packingItems = await ctx.db.query('plannerPackingItems').collect();
    const appSettings = await ctx.db.query('appSettings').collect();
    const userSettings = await ctx.db.query('userSettings').collect();
    const addons = await ctx.db.query('addons').collect();
    const collabNotes = await ctx.db.query('plannerCollabNotes').collect();
    const collabPolls = await ctx.db.query('plannerCollabPolls').collect();
    const shareTokens = await ctx.db.query('plannerShareTokens').collect();
    const notifications = await ctx.db.query('plannerNotifications').collect();

    const backupData = {
      version: '3.0.0-convex',
      createdAt: new Date(now).toISOString(),
      createdBy: authUserKey,
      tables: {
        plannerUsers: users,
        plannerTrips: trips,
        plannerTripMembers: tripMembers,
        plannerDays: days,
        plannerPlaces: places,
        plannerDayAssignments: assignments,
        plannerAssignmentParticipants: participants,
        plannerTripLegs: legs,
        plannerCategories: categories,
        plannerTags: tags,
        plannerPlaceTags: placeTags,
        plannerDayNotes: dayNotes,
        plannerAccommodations: accommodations,
        plannerReservations: reservations,
        plannerBudgetItems: budgetItems,
        plannerBudgetMembers: budgetMembers,
        plannerPackingItems: packingItems,
        appSettings: appSettings.filter((s) => s.key !== 'backups'),
        userSettings,
        addons,
        plannerCollabNotes: collabNotes,
        plannerCollabPolls: collabPolls,
        plannerShareTokens: shareTokens,
        plannerNotifications: notifications,
      },
    };

    // Store backup data as a JSON string in app settings
    const jsonStr = JSON.stringify(backupData);

    const filename = `backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
    const backupEntry = {
      filename,
      size: jsonStr.length,
      created_at: new Date(now).toISOString(),
      created_by: authUserKey,
      data: jsonStr,
    };

    // Update backup list in app settings
    const settingRow = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'backups'))
      .unique();

    let backupList: any[] = [];
    if (settingRow) {
      try {
        backupList = JSON.parse(settingRow.value);
        if (!Array.isArray(backupList)) backupList = [];
      } catch { backupList = []; }
      backupList.unshift(backupEntry);
      await ctx.db.patch(settingRow._id, { value: JSON.stringify(backupList) });
    } else {
      backupList = [backupEntry];
      await ctx.db.insert('appSettings', { key: 'backups', value: JSON.stringify(backupList) });
    }

    return { backup: backupEntry };
  },
});

export const remove = rawMutation({
  args: { filename: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const settingRow = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'backups'))
      .unique();

    if (settingRow) {
      try {
        const backupList: any[] = JSON.parse(settingRow.value);
        const filtered = backupList.filter((b) => b.filename !== args.filename);
        await ctx.db.patch(settingRow._id, { value: JSON.stringify(filtered) });
      } catch { /* ignore parse errors */ }
    }
    return { success: true };
  },
});

export const getAutoSettings = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const setting = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'auto_backup_settings'))
      .unique();

    if (!setting) return { enabled: false, interval: 'daily', keep_days: 30 };
    try {
      return JSON.parse(setting.value);
    } catch {
      return { enabled: false, interval: 'daily', keep_days: 30 };
    }
  },
});

export const setAutoSettings = rawMutation({
  args: { settings: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'auto_backup_settings'))
      .unique();

    const value = JSON.stringify(args.settings);
    if (existing) {
      await ctx.db.patch(existing._id, { value });
    } else {
      await ctx.db.insert('appSettings', { key: 'auto_backup_settings', value });
    }
    return { success: true };
  },
});

export const getDownloadData = rawQuery({
  args: { filename: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const settingRow = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'backups'))
      .unique();

    if (!settingRow) throw new ConvexError('No backups found');

    try {
      const backupList: any[] = JSON.parse(settingRow.value);
      const backup = backupList.find((b) => b.filename === args.filename);
      if (!backup) throw new ConvexError('Backup not found');

      return { data: backup.data, filename: backup.filename };
    } catch (e) {
      if (e instanceof ConvexError) throw e;
      throw new ConvexError('Failed to get backup data');
    }
  },
});
