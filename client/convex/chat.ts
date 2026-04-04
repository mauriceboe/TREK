import { ConvexError, v } from 'convex/values';
import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server';

type IdentityLike = Record<string, unknown> & {
  subject?: string;
  name?: string | null;
  email?: string | null;
};

type ReactionUser = {
  user_id: string;
  username: string;
};

type Reaction = {
  emoji: string;
  count: number;
  users: ReactionUser[];
};

function toIsoString(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function getViewer(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }, tripId: number) {
  const identity = await ctx.auth.getUserIdentity() as IdentityLike | null;
  if (!identity) throw new ConvexError('Authentication required');

  const rawTripIds = identity.trip_ids;
  const tripIds = Array.isArray(rawTripIds)
    ? rawTripIds.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];

  if (!tripIds.includes(Number(tripId))) {
    throw new ConvexError('Trip access denied');
  }

  return {
    id: String(identity.subject || ''),
    username: String(identity.name || identity.email || 'Traveler'),
    avatarUrl: typeof identity.avatar_url === 'string' ? identity.avatar_url : null,
  };
}

function formatMessage(doc: Record<string, any>) {
  return {
    id: String(doc._id),
    trip_id: doc.tripId,
    user_id: doc.authorId,
    username: doc.authorName,
    user_avatar: doc.authorAvatarUrl || null,
    avatar_url: doc.authorAvatarUrl || null,
    text: doc.text,
    deleted: !!doc.deleted,
    reply_to: doc.replyToMessageId ? String(doc.replyToMessageId) : null,
    reply_text: doc.replyPreview?.text || null,
    reply_username: doc.replyPreview?.username || null,
    reactions: (doc.reactions || []) as Reaction[],
    created_at: toIsoString(doc.createdAt),
    updated_at: toIsoString(doc.updatedAt || doc.createdAt),
  };
}

export const listMessages = query({
  args: {
    tripId: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await getViewer(ctx, args.tripId);
    const limit = Math.min(Math.max(args.limit || 200, 1), 300);
    const docs = await ctx.db
      .query('messages')
      .withIndex('by_trip_createdAt', (q) => q.eq('tripId', args.tripId))
      .order('desc')
      .take(limit);

    return docs.reverse().map(formatMessage);
  },
});

export const sendMessage = mutation({
  args: {
    tripId: v.number(),
    text: v.string(),
    replyToMessageId: v.optional(v.id('messages')),
  },
  handler: async (ctx, args) => {
    const viewer = await getViewer(ctx, args.tripId);
    const text = args.text.trim();
    if (!text) throw new ConvexError('Message text is required');

    let replyPreview: { text: string; username: string } | undefined;
    if (args.replyToMessageId) {
      const replied = await ctx.db.get(args.replyToMessageId);
      if (!replied || replied.tripId !== args.tripId) {
        throw new ConvexError('Reply target message not found');
      }
      replyPreview = {
        text: replied.text,
        username: replied.authorName,
      };
    }

    const now = Date.now();
    const id = await ctx.db.insert('messages', {
      tripId: args.tripId,
      authorId: viewer.id,
      authorName: viewer.username,
      authorAvatarUrl: viewer.avatarUrl,
      text,
      deleted: false,
      replyToMessageId: args.replyToMessageId,
      replyPreview,
      reactions: [],
      createdAt: now,
      updatedAt: now,
    });

    const created = await ctx.db.get(id);
    return created ? formatMessage(created) : null;
  },
});

export const deleteMessage = mutation({
  args: {
    tripId: v.number(),
    messageId: v.id('messages'),
  },
  handler: async (ctx, args) => {
    const viewer = await getViewer(ctx, args.tripId);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.tripId !== args.tripId) throw new ConvexError('Message not found');
    if (message.authorId !== viewer.id) throw new ConvexError('You can only delete your own messages');

    await ctx.db.patch(args.messageId, {
      deleted: true,
      updatedAt: Date.now(),
    });

    const updated = await ctx.db.get(args.messageId);
    return updated ? formatMessage(updated) : null;
  },
});

export const toggleReaction = mutation({
  args: {
    tripId: v.number(),
    messageId: v.id('messages'),
    emoji: v.string(),
  },
  handler: async (ctx, args) => {
    const viewer = await getViewer(ctx, args.tripId);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.tripId !== args.tripId) throw new ConvexError('Message not found');
    if (!args.emoji.trim()) throw new ConvexError('Emoji is required');

    const reactions = Array.isArray(message.reactions) ? [...message.reactions] as Reaction[] : [];
    const reactionIndex = reactions.findIndex((reaction) => reaction.emoji === args.emoji);
    if (reactionIndex === -1) {
      reactions.push({
        emoji: args.emoji,
        count: 1,
        users: [{ user_id: viewer.id, username: viewer.username }],
      });
    } else {
      const reaction = reactions[reactionIndex];
      const existingUserIndex = reaction.users.findIndex((user) => user.user_id === viewer.id);
      if (existingUserIndex === -1) {
        reaction.users = [...reaction.users, { user_id: viewer.id, username: viewer.username }];
      } else {
        reaction.users = reaction.users.filter((user) => user.user_id !== viewer.id);
      }
      reaction.count = reaction.users.length;
      if (reaction.count === 0) reactions.splice(reactionIndex, 1);
      else reactions[reactionIndex] = reaction;
    }

    await ctx.db.patch(args.messageId, {
      reactions,
      updatedAt: Date.now(),
    });

    return reactions;
  },
});
