import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { getViewerAuthKey } from './helpers';

async function requireAdmin(ctx: any): Promise<string> {
  const authUserKey = await getViewerAuthKey(ctx);
  const user = await ctx.db
    .query('plannerUsers')
    .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', authUserKey))
    .unique();
  if (!user || user.role !== 'admin') throw new ConvexError('Admin access required');
  return authUserKey;
}

// ── Users ──────────────────────────────────────────────────

export const listUsers = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query('plannerUsers').collect();
    return {
      users: users.map((u) => ({
        id: u._id,
        _id: u._id,
        username: u.username,
        email: u.email,
        role: u.role,
        avatar_url: u.avatarUrl || null,
        created_at: new Date(u.createdAt).toISOString(),
        updated_at: new Date(u.updatedAt).toISOString(),
      })),
    };
  },
});

export const createUser = rawMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;

    // Check uniqueness
    const existingEmail = await ctx.db
      .query('plannerUsers')
      .withIndex('by_email', (q: any) => q.eq('email', d.email))
      .unique();
    if (existingEmail) throw new ConvexError('Email already in use');

    const now = Date.now();
    const id = await ctx.db.insert('plannerUsers', {
      authUserKey: `admin-created-${now}`,
      username: d.username,
      email: d.email,
      role: d.role || 'user',
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    });

    const user = await ctx.db.get(id);
    return {
      user: {
        id: user!._id,
        username: user!.username,
        email: user!.email,
        role: user!.role,
      },
    };
  },
});

export const updateUser = rawMutation({
  args: { userId: v.id('plannerUsers'), data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;
    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (d.username !== undefined) patch.username = d.username;
    if (d.email !== undefined) patch.email = d.email;
    if (d.role !== undefined) patch.role = d.role;

    await ctx.db.patch(args.userId, patch);
    return { success: true };
  },
});

export const deleteUser = rawMutation({
  args: { userId: v.id('plannerUsers') },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError('User not found');

    // Don't allow deleting yourself
    const authUserKey = await getViewerAuthKey(ctx);
    if (user.authUserKey === authUserKey) throw new ConvexError('Cannot delete your own account');

    await ctx.db.delete(args.userId);
    return { success: true };
  },
});

// ── Stats ──────────────────────────────────────────────────

export const stats = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query('plannerUsers').collect();
    const trips = await ctx.db.query('plannerTrips').collect();
    const places = await ctx.db.query('plannerPlaces').collect();
    const files = await ctx.db.query('plannerFiles').collect();

    return {
      stats: {
        total_users: users.length,
        total_trips: trips.length,
        total_places: places.length,
        total_files: files.filter((f) => !f.deletedAt).length,
      },
    };
  },
});

// ── Audit Log ──────────────────────────────────────────────

export const auditLog = rawQuery({
  args: { page: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const limit = args.limit || 50;
    const page = args.page || 1;
    const offset = (page - 1) * limit;

    const allEntries = await ctx.db
      .query('plannerAuditLog')
      .withIndex('by_createdAt')
      .order('desc')
      .collect();

    const total = allEntries.length;
    const entries = allEntries.slice(offset, offset + limit);

    const result = [];
    for (const e of entries) {
      let username = null;
      if (e.userAuthUserKey) {
        const user = await ctx.db
          .query('plannerUsers')
          .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', e.userAuthUserKey))
          .unique();
        username = user?.username || null;
      }
      result.push({
        id: e._id,
        user_id: e.userAuthUserKey,
        username,
        action: e.action,
        resource: e.resource,
        details: e.details || null,
        created_at: new Date(e.createdAt).toISOString(),
      });
    }
    return { entries: result, total };
  },
});

export const logAudit = rawMutation({
  args: {
    action: v.string(),
    resource: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let authUserKey: string | null = null;
    try {
      authUserKey = await getViewerAuthKey(ctx);
    } catch {
      // Allow unauthenticated audit entries (system events)
    }
    await ctx.db.insert('plannerAuditLog', {
      userAuthUserKey: authUserKey,
      action: args.action,
      resource: args.resource,
      details: args.details || null,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});

// ── Invite Tokens ──────────────────────────────────────────

export const listInvites = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const invites = await ctx.db.query('plannerInviteTokens').collect();
    const result = [];
    for (const inv of invites) {
      const creator = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', inv.createdBy))
        .unique();
      result.push({
        id: inv._id,
        token: inv.token,
        max_uses: inv.maxUses ?? null,
        used_count: inv.usedCount,
        expires_at: inv.expiresAt ? new Date(inv.expiresAt).toISOString() : null,
        created_by: inv.createdBy,
        creator_name: creator?.username || 'Unknown',
        created_at: new Date(inv.createdAt).toISOString(),
      });
    }
    return { invites: result };
  },
});

export const createInvite = rawMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    const authUserKey = await requireAdmin(ctx);
    const d = args.data as any;

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 24; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const id = await ctx.db.insert('plannerInviteTokens', {
      token,
      maxUses: d.max_uses ?? null,
      usedCount: 0,
      expiresAt: d.expires_at ? new Date(d.expires_at).getTime() : null,
      createdBy: authUserKey,
      createdAt: Date.now(),
    });

    const invite = await ctx.db.get(id);
    return {
      invite: {
        id: invite!._id,
        token: invite!.token,
        max_uses: invite!.maxUses ?? null,
        used_count: 0,
        expires_at: invite!.expiresAt ? new Date(invite!.expiresAt).toISOString() : null,
        created_at: new Date(invite!.createdAt).toISOString(),
      },
    };
  },
});

export const deleteInvite = rawMutation({
  args: { inviteId: v.id('plannerInviteTokens') },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.inviteId);
    return { success: true };
  },
});

// ── Packing Templates ──────────────────────────────────────

export const listPackingTemplates = rawQuery({
  args: {},
  handler: async (ctx) => {
    await getViewerAuthKey(ctx);
    const templates = await ctx.db.query('plannerPackingTemplates').collect();
    return {
      templates: templates.map((t) => ({
        id: t._id,
        _id: t._id,
        name: t.name,
        created_by: t.createdBy,
        created_at: new Date(t.createdAt).toISOString(),
      })),
    };
  },
});

export const getPackingTemplate = rawQuery({
  args: { templateId: v.id('plannerPackingTemplates') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    const template = await ctx.db.get(args.templateId);
    if (!template) throw new ConvexError('Template not found');

    const categories = await ctx.db
      .query('plannerPackingTemplateCategories')
      .withIndex('by_templateId', (q: any) => q.eq('templateId', args.templateId))
      .collect();

    const categoriesWithItems = [];
    for (const cat of categories.sort((a, b) => a.sortOrder - b.sortOrder)) {
      const items = await ctx.db
        .query('plannerPackingTemplateItems')
        .withIndex('by_categoryId', (q: any) => q.eq('categoryId', cat._id))
        .collect();

      categoriesWithItems.push({
        id: cat._id,
        _id: cat._id,
        name: cat.name,
        sort_order: cat.sortOrder,
        items: items
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => ({
            id: item._id,
            _id: item._id,
            name: item.name,
            sort_order: item.sortOrder,
          })),
      });
    }

    return {
      template: {
        id: template._id,
        _id: template._id,
        name: template.name,
        created_at: new Date(template.createdAt).toISOString(),
      },
      categories: categoriesWithItems,
    };
  },
});

export const createPackingTemplate = rawMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    const authUserKey = await requireAdmin(ctx);
    const d = args.data as any;

    const id = await ctx.db.insert('plannerPackingTemplates', {
      name: d.name || 'New Template',
      createdBy: authUserKey,
      createdAt: Date.now(),
    });
    const template = await ctx.db.get(id);
    return {
      template: {
        id: template!._id,
        _id: template!._id,
        name: template!.name,
        created_at: new Date(template!.createdAt).toISOString(),
      },
    };
  },
});

export const updatePackingTemplate = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates'), data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;
    if (d.name !== undefined) await ctx.db.patch(args.templateId, { name: d.name });
    return { success: true };
  },
});

export const deletePackingTemplate = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates') },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // Cascade delete categories and items
    const categories = await ctx.db
      .query('plannerPackingTemplateCategories')
      .withIndex('by_templateId', (q: any) => q.eq('templateId', args.templateId))
      .collect();
    for (const cat of categories) {
      const items = await ctx.db
        .query('plannerPackingTemplateItems')
        .withIndex('by_categoryId', (q: any) => q.eq('categoryId', cat._id))
        .collect();
      for (const item of items) await ctx.db.delete(item._id);
      await ctx.db.delete(cat._id);
    }
    await ctx.db.delete(args.templateId);
    return { success: true };
  },
});

export const addTemplateCategory = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates'), data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;

    // Get max sort order
    const existing = await ctx.db
      .query('plannerPackingTemplateCategories')
      .withIndex('by_templateId', (q: any) => q.eq('templateId', args.templateId))
      .collect();
    const maxSort = existing.reduce((max, c) => Math.max(max, c.sortOrder), -1);

    const id = await ctx.db.insert('plannerPackingTemplateCategories', {
      templateId: args.templateId,
      name: d.name || 'New Category',
      sortOrder: maxSort + 1,
    });
    const cat = await ctx.db.get(id);
    return {
      category: {
        id: cat!._id, _id: cat!._id, name: cat!.name, sort_order: cat!.sortOrder, items: [],
      },
    };
  },
});

export const updateTemplateCategory = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates'), categoryId: v.id('plannerPackingTemplateCategories'), data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;
    if (d.name !== undefined) await ctx.db.patch(args.categoryId, { name: d.name });
    return { success: true };
  },
});

export const deleteTemplateCategory = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates'), categoryId: v.id('plannerPackingTemplateCategories') },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const items = await ctx.db
      .query('plannerPackingTemplateItems')
      .withIndex('by_categoryId', (q: any) => q.eq('categoryId', args.categoryId))
      .collect();
    for (const item of items) await ctx.db.delete(item._id);
    await ctx.db.delete(args.categoryId);
    return { success: true };
  },
});

export const addTemplateItem = rawMutation({
  args: { templateId: v.id('plannerPackingTemplates'), categoryId: v.id('plannerPackingTemplateCategories'), data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;

    const existing = await ctx.db
      .query('plannerPackingTemplateItems')
      .withIndex('by_categoryId', (q: any) => q.eq('categoryId', args.categoryId))
      .collect();
    const maxSort = existing.reduce((max, i) => Math.max(max, i.sortOrder), -1);

    const id = await ctx.db.insert('plannerPackingTemplateItems', {
      categoryId: args.categoryId,
      name: d.name || 'New Item',
      sortOrder: maxSort + 1,
    });
    const item = await ctx.db.get(id);
    return {
      item: { id: item!._id, _id: item!._id, name: item!.name, sort_order: item!.sortOrder },
    };
  },
});

export const updateTemplateItem = rawMutation({
  args: {
    templateId: v.id('plannerPackingTemplates'),
    categoryId: v.id('plannerPackingTemplateCategories'),
    itemId: v.id('plannerPackingTemplateItems'),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;
    if (d.name !== undefined) await ctx.db.patch(args.itemId, { name: d.name });
    return { success: true };
  },
});

export const deleteTemplateItem = rawMutation({
  args: {
    templateId: v.id('plannerPackingTemplates'),
    categoryId: v.id('plannerPackingTemplateCategories'),
    itemId: v.id('plannerPackingTemplateItems'),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.itemId);
    return { success: true };
  },
});

// ── Bag Tracking ──────────────────────────────────────────

export const getBagTracking = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const setting = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'bag_tracking_enabled'))
      .unique();
    return { enabled: setting?.value === 'true' };
  },
});

export const updateBagTracking = rawMutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const setting = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q: any) => q.eq('key', 'bag_tracking_enabled'))
      .unique();

    if (setting) {
      await ctx.db.patch(setting._id, { value: String(args.enabled) });
    } else {
      await ctx.db.insert('appSettings', { key: 'bag_tracking_enabled', value: String(args.enabled) });
    }
    return { success: true };
  },
});

// ── Sessions (read-only view of active users) ──────────────

export const sessions = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // In Convex Auth, we don't have a sessions table directly.
    // Return active users as a proxy for sessions.
    const users = await ctx.db.query('plannerUsers').collect();
    return {
      sessions: users.map((u) => ({
        id: u._id,
        user_id: u._id,
        username: u.username,
        email: u.email,
        last_active: new Date(u.updatedAt).toISOString(),
      })),
    };
  },
});

// ── OIDC Config (stored in app settings) ──────────────────

export const getOidc = rawQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const keys = ['oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'oidc_display_name', 'oidc_only'];
    const result: Record<string, any> = {};
    for (const key of keys) {
      const setting = await ctx.db
        .query('appSettings')
        .withIndex('by_key', (q: any) => q.eq('key', key))
        .unique();
      result[key] = setting?.value || '';
    }
    // Mask secret
    if (result.oidc_client_secret) {
      result.oidc_client_secret = '****' + (result.oidc_client_secret as string).slice(-4);
    }
    return result;
  },
});

export const updateOidc = rawMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const d = args.data as any;
    const keys = ['oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'oidc_display_name', 'oidc_only'];

    for (const key of keys) {
      if (d[key] !== undefined) {
        // Skip masked secrets
        if (key === 'oidc_client_secret' && String(d[key]).startsWith('****')) continue;

        const existing = await ctx.db
          .query('appSettings')
          .withIndex('by_key', (q: any) => q.eq('key', key))
          .unique();
        if (existing) {
          await ctx.db.patch(existing._id, { value: String(d[key]) });
        } else {
          await ctx.db.insert('appSettings', { key, value: String(d[key]) });
        }
      }
    }
    return { success: true };
  },
});
