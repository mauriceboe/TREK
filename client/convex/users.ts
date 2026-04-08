import { ConvexError, v } from 'convex/values';
import { mutation as rawMutation, query as rawQuery, action as rawAction, internalQuery, type QueryCtx, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { authComponent, createAuth } from './auth';

// ── Helpers ──────────────────────────────────────────────

async function getAuthUserKey(ctx: QueryCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError('Authentication required');
  return String(identity.subject);
}

async function getBetterAuthUser(ctx: QueryCtx) {
  return authComponent.safeGetAuthUser(ctx);
}

/**
 * Ensure a plannerUsers record exists for the current Better Auth user.
 * Creates one on first login, returns existing on subsequent calls.
 */
async function ensurePlannerUser(ctx: MutationCtx) {
  const authUserKey = await getAuthUserKey(ctx);
  const betterAuthUser = await getBetterAuthUser(ctx);

  // Check if planner user already exists
  const existing = await ctx.db
    .query('plannerUsers')
    .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
    .unique();

  if (existing) {
    // Sync email/username from Better Auth if changed
    const needsUpdate =
      (betterAuthUser?.email && betterAuthUser.email !== existing.email) ||
      (betterAuthUser?.name && betterAuthUser.name !== existing.username);

    if (needsUpdate) {
      await ctx.db.patch(existing._id, {
        ...(betterAuthUser?.email ? { email: betterAuthUser.email } : {}),
        ...(betterAuthUser?.name ? { username: betterAuthUser.name } : {}),
        updatedAt: Date.now(),
      });
      return await ctx.db.get(existing._id);
    }
    return existing;
  }

  // Create new planner user
  const now = Date.now();
  const allUsers = await ctx.db.query('plannerUsers').collect();
  const isFirstUser = allUsers.length === 0;

  const id = await ctx.db.insert('plannerUsers', {
    authUserKey,
    betterAuthUserId: (betterAuthUser as any)?._id as string | undefined,
    username: betterAuthUser?.name || betterAuthUser?.email?.split('@')[0] || 'user',
    email: betterAuthUser?.email || '',
    role: isFirstUser ? 'admin' : 'user',
    avatarUrl: (betterAuthUser as any)?.image || null,
    mapsApiKey: null,
    openweatherApiKey: null,
    createdAt: now,
    updatedAt: now,
  });

  return await ctx.db.get(id);
}

// ── Queries ──────────────────────────────────────────────

/** Get current user profile (planner user) */
export const me = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();

    if (!user) return null;

    return {
      id: user._id,
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar_url: user.avatarUrl || null,
      maps_api_key: user.mapsApiKey ? '****' + user.mapsApiKey.slice(-4) : null,
      openweather_api_key: user.openweatherApiKey ? '****' + user.openweatherApiKey.slice(-4) : null,
      created_at: new Date(user.createdAt).toISOString(),
    };
  },
});

/** Get app config (registration, features, etc.) */
export const getAppConfig = rawQuery({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query('plannerUsers').collect();
    const userCount = allUsers.length;

    const allowRegSetting = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q) => q.eq('key', 'allow_registration'))
      .unique();

    const allowedFileTypesSetting = await ctx.db
      .query('appSettings')
      .withIndex('by_key', (q) => q.eq('key', 'allowed_file_types'))
      .unique();

    const allowRegistration = userCount === 0 || (allowRegSetting?.value ?? 'true') === 'true';

    // Check if any admin has a maps key
    const admins = allUsers.filter((u) => u.role === 'admin');
    const hasMapsKey = admins.some((u) => u.mapsApiKey);

    return {
      allow_registration: allowRegistration,
      has_users: userCount > 0,
      version: '2.7.0',
      has_maps_key: hasMapsKey,
      oidc_configured: false,
      allowed_file_types:
        allowedFileTypesSetting?.value ||
        'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
      demo_mode: false,
    };
  },
});

/** List all users (for trip member search) */
export const listUsers = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getAuthUserKey(ctx);
    const allUsers = await ctx.db.query('plannerUsers').collect();
    return allUsers
      .filter((u) => u.authUserKey !== authUserKey)
      .map((u) => ({
        id: u._id,
        _id: u._id,
        username: u.username,
        avatar_url: u.avatarUrl || null,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  },
});

// ── Mutations ────────────────────────────────────────────

/** Ensure planner user exists after login/signup — called from client */
export const ensureUser = rawMutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensurePlannerUser(ctx);
    if (!user) throw new ConvexError('Failed to create user');
    return {
      id: user._id,
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar_url: user.avatarUrl || null,
      maps_api_key: user.mapsApiKey ? '****' + user.mapsApiKey.slice(-4) : null,
      created_at: new Date(user.createdAt).toISOString(),
    };
  },
});

/** Update user profile (username, email) */
export const updateProfile = rawMutation({
  args: {
    username: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();
    if (!user) throw new ConvexError('User not found');

    const patch: Record<string, any> = { updatedAt: Date.now() };

    if (args.username !== undefined) {
      const trimmed = args.username.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
        throw new ConvexError('Username must be between 2 and 50 characters');
      }
      // Check uniqueness
      const allUsers = await ctx.db.query('plannerUsers').collect();
      const conflict = allUsers.find(
        (u) => u._id !== user._id && u.username.toLowerCase() === trimmed.toLowerCase(),
      );
      if (conflict) throw new ConvexError('Username already taken');
      patch.username = trimmed;

      // Also update Better Auth user
      const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
      await auth.api.updateUser({ body: { name: trimmed }, headers });
    }

    if (args.email !== undefined) {
      const trimmed = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new ConvexError('Invalid email format');
      }
      const allUsers = await ctx.db.query('plannerUsers').collect();
      const conflict = allUsers.find(
        (u) => u._id !== user._id && u.email.toLowerCase() === trimmed,
      );
      if (conflict) throw new ConvexError('Email already taken');
      patch.email = trimmed;
    }

    await ctx.db.patch(user._id, patch);
    const updated = await ctx.db.get(user._id);
    return {
      id: updated!._id,
      _id: updated!._id,
      username: updated!.username,
      email: updated!.email,
      role: updated!.role,
      avatar_url: updated!.avatarUrl || null,
      maps_api_key: updated!.mapsApiKey ? '****' + updated!.mapsApiKey.slice(-4) : null,
      created_at: new Date(updated!.createdAt).toISOString(),
    };
  },
});

/** Update API keys */
export const updateApiKeys = rawMutation({
  args: {
    mapsApiKey: v.optional(v.union(v.string(), v.null())),
    openweatherApiKey: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();
    if (!user) throw new ConvexError('User not found');

    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (args.mapsApiKey !== undefined) patch.mapsApiKey = args.mapsApiKey || null;
    if (args.openweatherApiKey !== undefined) patch.openweatherApiKey = args.openweatherApiKey || null;

    await ctx.db.patch(user._id, patch);
    const updated = await ctx.db.get(user._id);
    return {
      id: updated!._id,
      _id: updated!._id,
      username: updated!.username,
      email: updated!.email,
      role: updated!.role,
      avatar_url: updated!.avatarUrl || null,
      maps_api_key: updated!.mapsApiKey ? '****' + updated!.mapsApiKey.slice(-4) : null,
      openweather_api_key: updated!.openweatherApiKey ? '****' + updated!.openweatherApiKey.slice(-4) : null,
      created_at: new Date(updated!.createdAt).toISOString(),
    };
  },
});

/** Update app settings (admin only) */
export const updateAppSettings = rawMutation({
  args: {
    allowRegistration: v.optional(v.boolean()),
    allowedFileTypes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();
    if (!user || user.role !== 'admin') throw new ConvexError('Admin access required');

    if (args.allowRegistration !== undefined) {
      const existing = await ctx.db
        .query('appSettings')
        .withIndex('by_key', (q) => q.eq('key', 'allow_registration'))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { value: String(args.allowRegistration) });
      } else {
        await ctx.db.insert('appSettings', {
          key: 'allow_registration',
          value: String(args.allowRegistration),
        });
      }
    }

    if (args.allowedFileTypes !== undefined) {
      const existing = await ctx.db
        .query('appSettings')
        .withIndex('by_key', (q) => q.eq('key', 'allowed_file_types'))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { value: args.allowedFileTypes });
      } else {
        await ctx.db.insert('appSettings', {
          key: 'allowed_file_types',
          value: args.allowedFileTypes,
        });
      }
    }

    return { success: true };
  },
});

/** Delete own account */
export const deleteAccount = rawMutation({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();
    if (!user) throw new ConvexError('User not found');

    if (user.role === 'admin') {
      const allUsers = await ctx.db.query('plannerUsers').collect();
      const adminCount = allUsers.filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) {
        throw new ConvexError('Cannot delete the last admin account');
      }
    }

    // Delete Better Auth user
    try {
      const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
      await auth.api.deleteUser({ body: {}, headers });
    } catch {
      // Continue even if Better Auth deletion fails
    }

    await ctx.db.delete(user._id);
    return { success: true };
  },
});

/** Get raw maps API key (for use in maps proxy action — not exposed to client) */
export const getMapsApiKey = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getAuthUserKey(ctx);
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q) => q.eq('authUserKey', authUserKey))
      .unique();
    if (!user) return null;

    // Return own key, or fall back to any admin's key
    if (user.mapsApiKey) return user.mapsApiKey;

    const allUsers = await ctx.db.query('plannerUsers').collect();
    const adminWithKey = allUsers.find((u) => u.role === 'admin' && u.mapsApiKey);
    return adminWithKey?.mapsApiKey || null;
  },
});

/** Internal query to get raw API keys for the current user (used by validateKeys action) */
export const _getUserApiKeys = internalQuery({
  args: { authUserKey: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', args.authUserKey))
      .unique();
    if (!user) return { mapsApiKey: null, openweatherApiKey: null };
    return {
      mapsApiKey: (user.mapsApiKey as string) || null,
      openweatherApiKey: (user.openweatherApiKey as string) || null,
    };
  },
});

/** Validate API keys by making test requests to Google Maps and OpenWeather */
export const validateKeys = rawAction({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.subject) throw new ConvexError('Authentication required');

    const keys = await ctx.runQuery(internal.users._getUserApiKeys, {
      authUserKey: String(identity.subject),
    });

    const result: Record<string, boolean> = { maps: false, weather: false };

    // Test Google Maps API key
    if (keys.mapsApiKey) {
      try {
        const res = await fetch(
          `https://places.googleapis.com/v1/places:searchText`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': keys.mapsApiKey,
              'X-Goog-FieldMask': 'places.id',
            },
            body: JSON.stringify({ textQuery: 'test', maxResultCount: 1 }),
          },
        );
        result.maps = res.ok;
      } catch {
        result.maps = false;
      }
    }

    // Test OpenWeather API key
    if (keys.openweatherApiKey) {
      try {
        const res = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?q=London&appid=${keys.openweatherApiKey}`,
        );
        result.weather = res.ok;
      } catch {
        result.weather = false;
      }
    }

    return result;
  },
});
