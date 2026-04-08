import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, getViewerAuthKey } from './helpers';

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const photos = await ctx.db
      .query('plannerPhotos')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const result = [];
    for (const p of photos) {
      const url = await ctx.storage.getUrl(p.storageId);
      const uploader = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', p.uploadedBy))
        .unique();

      result.push({
        id: p._id,
        _id: p._id,
        trip_id: args.tripId,
        user_id: p.uploadedBy,
        username: uploader?.username || 'Unknown',
        avatar_url: uploader?.avatarUrl || null,
        filename: p.filename,
        url: url || null,
        thumbnail_url: url || null,
        caption: p.caption || null,
        taken_at: p.takenAt || null,
        shared: p.shared || false,
        file_size: p.fileSize,
        mime_type: p.mimeType,
        created_at: new Date(p.createdAt).toISOString(),
      });
    }
    return { photos: result };
  },
});

export const generateUploadUrl = rawMutation({
  args: {},
  handler: async (ctx) => {
    await getViewerAuthKey(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const savePhoto = rawMutation({
  args: {
    tripId: v.id('plannerTrips'),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    caption: v.optional(v.string()),
    takenAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);

    const id = await ctx.db.insert('plannerPhotos', {
      tripId: args.tripId,
      uploadedBy: authUserKey,
      storageId: args.storageId,
      filename: args.filename,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      caption: args.caption || null,
      takenAt: args.takenAt || null,
      shared: false,
      createdAt: Date.now(),
    });

    const photo = await ctx.db.get(id);
    const url = await ctx.storage.getUrl(args.storageId);
    const uploader = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', authUserKey))
      .unique();

    return {
      photo: {
        id: photo!._id,
        _id: photo!._id,
        trip_id: args.tripId,
        user_id: authUserKey,
        username: uploader?.username || 'Unknown',
        avatar_url: uploader?.avatarUrl || null,
        filename: photo!.filename,
        url: url || null,
        thumbnail_url: url || null,
        caption: photo!.caption || null,
        taken_at: photo!.takenAt || null,
        shared: false,
        file_size: photo!.fileSize,
        mime_type: photo!.mimeType,
        created_at: new Date(photo!.createdAt).toISOString(),
      },
    };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), photoId: v.id('plannerPhotos'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: Record<string, any> = {};
    if (d.caption !== undefined) patch.caption = d.caption;
    if (d.shared !== undefined) patch.shared = d.shared;
    if (d.taken_at !== undefined) patch.takenAt = d.taken_at;

    await ctx.db.patch(args.photoId, patch);
    const photo = await ctx.db.get(args.photoId);
    const url = photo ? await ctx.storage.getUrl(photo.storageId) : null;
    return {
      photo: {
        id: photo!._id,
        _id: photo!._id,
        caption: photo!.caption || null,
        shared: photo!.shared || false,
        taken_at: photo!.takenAt || null,
        url: url || null,
      },
    };
  },
});

export const remove = rawMutation({
  args: { tripId: v.id('plannerTrips'), photoId: v.id('plannerPhotos') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const photo = await ctx.db.get(args.photoId);
    if (photo) {
      await ctx.storage.delete(photo.storageId);
      await ctx.db.delete(args.photoId);
    }
    return { success: true };
  },
});
