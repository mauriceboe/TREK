import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, getViewerAuthKey } from './helpers';

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips'), trash: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const files = await ctx.db
      .query('plannerFiles')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const filtered = args.trash
      ? files.filter((f) => f.deletedAt != null)
      : files.filter((f) => f.deletedAt == null);

    const result = [];
    for (const f of filtered) {
      const url = await ctx.storage.getUrl(f.storageId);
      const uploader = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', f.uploadedBy))
        .unique();

      // Get file links
      const links = await ctx.db
        .query('plannerFileLinks')
        .withIndex('by_fileId', (q: any) => q.eq('fileId', f._id))
        .collect();

      result.push({
        id: f._id,
        _id: f._id,
        trip_id: args.tripId,
        filename: f.filename,
        original_name: f.filename,
        file_size: f.fileSize,
        mime_type: f.mimeType,
        description: f.description || null,
        uploaded_by: f.uploadedBy,
        uploader_name: uploader?.username || 'Unknown',
        starred: f.starred || false,
        deleted_at: f.deletedAt ? new Date(f.deletedAt).toISOString() : null,
        url: url || null,
        links: links.map((l) => ({
          id: l._id,
          file_id: l.fileId,
          reservation_id: l.reservationId || null,
          assignment_id: l.assignmentId || null,
          place_id: l.placeId || null,
        })),
        created_at: new Date(f.createdAt).toISOString(),
      });
    }
    return { files: result };
  },
});

export const generateUploadUrl = rawMutation({
  args: {},
  handler: async (ctx) => {
    await getViewerAuthKey(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = rawMutation({
  args: {
    tripId: v.id('plannerTrips'),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);

    const id = await ctx.db.insert('plannerFiles', {
      tripId: args.tripId,
      storageId: args.storageId,
      filename: args.filename,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      description: args.description || null,
      uploadedBy: authUserKey,
      starred: false,
      deletedAt: null,
      createdAt: Date.now(),
    });

    const file = await ctx.db.get(id);
    const url = await ctx.storage.getUrl(args.storageId);
    return {
      file: {
        id: file!._id,
        _id: file!._id,
        trip_id: args.tripId,
        filename: file!.filename,
        original_name: file!.filename,
        file_size: file!.fileSize,
        mime_type: file!.mimeType,
        description: file!.description || null,
        uploaded_by: authUserKey,
        starred: false,
        deleted_at: null,
        url: url || null,
        links: [],
        created_at: new Date(file!.createdAt).toISOString(),
      },
    };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: Record<string, any> = {};
    if (d.description !== undefined) patch.description = d.description;

    await ctx.db.patch(args.fileId, patch);
    return { success: true };
  },
});

export const toggleStar = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const file = await ctx.db.get(args.fileId);
    if (!file) throw new ConvexError('File not found');
    await ctx.db.patch(args.fileId, { starred: !file.starred });
    return { starred: !file.starred };
  },
});

export const softDelete = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.patch(args.fileId, { deletedAt: Date.now() });
    return { success: true };
  },
});

export const restore = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.patch(args.fileId, { deletedAt: null });
    return { success: true };
  },
});

export const permanentDelete = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const file = await ctx.db.get(args.fileId);
    if (file) {
      // Delete file links
      const links = await ctx.db
        .query('plannerFileLinks')
        .withIndex('by_fileId', (q: any) => q.eq('fileId', args.fileId))
        .collect();
      for (const l of links) {
        await ctx.db.delete(l._id);
      }
      await ctx.storage.delete(file.storageId);
      await ctx.db.delete(args.fileId);
    }
    return { success: true };
  },
});

export const emptyTrash = rawMutation({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const files = await ctx.db
      .query('plannerFiles')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const trashed = files.filter((f) => f.deletedAt != null);
    for (const file of trashed) {
      const links = await ctx.db
        .query('plannerFileLinks')
        .withIndex('by_fileId', (q: any) => q.eq('fileId', file._id))
        .collect();
      for (const l of links) {
        await ctx.db.delete(l._id);
      }
      await ctx.storage.delete(file.storageId);
      await ctx.db.delete(file._id);
    }
    return { success: true };
  },
});

// ── File Links ─────────────────────────────────────────────

export const getLinks = rawQuery({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const links = await ctx.db
      .query('plannerFileLinks')
      .withIndex('by_fileId', (q: any) => q.eq('fileId', args.fileId))
      .collect();

    return {
      links: links.map((l) => ({
        id: l._id,
        file_id: l.fileId,
        reservation_id: l.reservationId || null,
        assignment_id: l.assignmentId || null,
        place_id: l.placeId || null,
        created_at: new Date(l.createdAt).toISOString(),
      })),
    };
  },
});

export const addLink = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const id = await ctx.db.insert('plannerFileLinks', {
      fileId: args.fileId,
      reservationId: d.reservation_id || null,
      assignmentId: d.assignment_id || null,
      placeId: d.place_id || null,
      createdAt: Date.now(),
    });
    const link = await ctx.db.get(id);
    return {
      link: {
        id: link!._id,
        file_id: link!.fileId,
        reservation_id: link!.reservationId || null,
        assignment_id: link!.assignmentId || null,
        place_id: link!.placeId || null,
        created_at: new Date(link!.createdAt).toISOString(),
      },
    };
  },
});

export const removeLink = rawMutation({
  args: { tripId: v.id('plannerTrips'), fileId: v.id('plannerFiles'), linkId: v.id('plannerFileLinks') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.delete(args.linkId);
    return { success: true };
  },
});
