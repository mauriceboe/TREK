import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { getViewerAuthKey } from './helpers';

export const list = rawQuery({
  args: {
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    unreadOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const limit = args.limit || 20;
    const offset = args.offset || 0;

    let allNotifications = await ctx.db
      .query('plannerNotifications')
      .withIndex('by_recipient', (q: any) => q.eq('recipientAuthUserKey', authUserKey))
      .collect();

    // Sort by createdAt descending
    allNotifications.sort((a, b) => b.createdAt - a.createdAt);

    if (args.unreadOnly) {
      allNotifications = allNotifications.filter((n) => !n.isRead);
    }

    const total = allNotifications.length;
    const paged = allNotifications.slice(offset, offset + limit);

    const notifications = [];
    for (const n of paged) {
      let senderUsername = null;
      if (n.senderAuthUserKey) {
        const sender = await ctx.db
          .query('plannerUsers')
          .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', n.senderAuthUserKey))
          .unique();
        senderUsername = sender?.username || null;
      }

      notifications.push({
        id: n._id,
        _id: n._id,
        type: n.type,
        scope: n.scope,
        sender_id: n.senderAuthUserKey || null,
        sender_username: senderUsername,
        recipient_id: n.recipientAuthUserKey,
        trip_id: n.tripId || null,
        title_key: n.titleKey,
        title_params: n.titleParams ? JSON.parse(n.titleParams) : null,
        text_key: n.textKey,
        text_params: n.textParams ? JSON.parse(n.textParams) : null,
        positive_text_key: n.positiveTextKey || null,
        negative_text_key: n.negativeTextKey || null,
        navigate_text_key: n.navigateTextKey || null,
        navigate_target: n.navigateTarget || null,
        response: n.response || null,
        is_read: n.isRead || false,
        created_at: new Date(n.createdAt).toISOString(),
      });
    }

    return { notifications, total };
  },
});

export const unreadCount = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const unread = await ctx.db
      .query('plannerNotifications')
      .withIndex('by_recipient', (q: any) => q.eq('recipientAuthUserKey', authUserKey))
      .collect();

    const count = unread.filter((n) => !n.isRead).length;
    return { count };
  },
});

export const markRead = rawMutation({
  args: { notificationId: v.id('plannerNotifications') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    await ctx.db.patch(args.notificationId, { isRead: true });
    return { success: true };
  },
});

export const markUnread = rawMutation({
  args: { notificationId: v.id('plannerNotifications') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    await ctx.db.patch(args.notificationId, { isRead: false });
    return { success: true };
  },
});

export const markAllRead = rawMutation({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const unread = await ctx.db
      .query('plannerNotifications')
      .withIndex('by_recipient', (q: any) => q.eq('recipientAuthUserKey', authUserKey))
      .collect();

    for (const n of unread.filter((n) => !n.isRead)) {
      await ctx.db.patch(n._id, { isRead: true });
    }
    return { success: true };
  },
});

export const deleteNotification = rawMutation({
  args: { notificationId: v.id('plannerNotifications') },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    await ctx.db.delete(args.notificationId);
    return { success: true };
  },
});

export const deleteAll = rawMutation({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const all = await ctx.db
      .query('plannerNotifications')
      .withIndex('by_recipient', (q: any) => q.eq('recipientAuthUserKey', authUserKey))
      .collect();

    for (const n of all) {
      await ctx.db.delete(n._id);
    }
    return { success: true };
  },
});

export const respond = rawMutation({
  args: {
    notificationId: v.id('plannerNotifications'),
    response: v.string(),
  },
  handler: async (ctx, args) => {
    await getViewerAuthKey(ctx);
    await ctx.db.patch(args.notificationId, { response: args.response, isRead: true });
    return { success: true };
  },
});

// Helper to create notifications (called from other mutations)
export const create = rawMutation({
  args: {
    type: v.string(),
    scope: v.string(),
    recipientAuthUserKey: v.string(),
    senderAuthUserKey: v.optional(v.string()),
    tripId: v.optional(v.id('plannerTrips')),
    titleKey: v.string(),
    titleParams: v.optional(v.string()),
    textKey: v.string(),
    textParams: v.optional(v.string()),
    positiveTextKey: v.optional(v.string()),
    negativeTextKey: v.optional(v.string()),
    navigateTextKey: v.optional(v.string()),
    navigateTarget: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert('plannerNotifications', {
      type: args.type,
      scope: args.scope,
      recipientAuthUserKey: args.recipientAuthUserKey,
      senderAuthUserKey: args.senderAuthUserKey || null,
      tripId: args.tripId || null,
      titleKey: args.titleKey,
      titleParams: args.titleParams || null,
      textKey: args.textKey,
      textParams: args.textParams || null,
      positiveTextKey: args.positiveTextKey || null,
      negativeTextKey: args.negativeTextKey || null,
      navigateTextKey: args.navigateTextKey || null,
      navigateTarget: args.navigateTarget || null,
      response: null,
      isRead: false,
      createdAt: Date.now(),
    });
    return { id };
  },
});

// ── Notification Preferences ──────────────────────────────

export const getPreferences = rawQuery({
  args: {},
  handler: async (ctx) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const prefs = await ctx.db
      .query('plannerNotificationPreferences')
      .withIndex('by_user', (q: any) => q.eq('userAuthUserKey', authUserKey))
      .unique();

    if (!prefs) {
      return {
        notify_trip_invite: true,
        notify_booking_change: true,
        notify_trip_reminder: true,
        notify_webhook: false,
      };
    }
    return {
      notify_trip_invite: prefs.notifyTripInvite ?? true,
      notify_booking_change: prefs.notifyBookingChange ?? true,
      notify_trip_reminder: prefs.notifyTripReminder ?? true,
      notify_webhook: prefs.notifyWebhook ?? false,
    };
  },
});

export const updatePreferences = rawMutation({
  args: { prefs: v.any() },
  handler: async (ctx, args) => {
    const authUserKey = await getViewerAuthKey(ctx);
    const p = args.prefs as any;
    const existing = await ctx.db
      .query('plannerNotificationPreferences')
      .withIndex('by_user', (q: any) => q.eq('userAuthUserKey', authUserKey))
      .unique();

    const data: Record<string, any> = {};
    if (p.notify_trip_invite !== undefined) data.notifyTripInvite = p.notify_trip_invite;
    if (p.notify_booking_change !== undefined) data.notifyBookingChange = p.notify_booking_change;
    if (p.notify_trip_reminder !== undefined) data.notifyTripReminder = p.notify_trip_reminder;
    if (p.notify_webhook !== undefined) data.notifyWebhook = p.notify_webhook;

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert('plannerNotificationPreferences', {
        userAuthUserKey: authUserKey,
        ...data,
      });
    }
    return { success: true };
  },
});
