import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation, action as rawAction } from './_generated/server';
import { requireTripAccess, getViewerAuthKey } from './helpers';

// ── Notes ──────────────────────────────────────────────────

export const getNotes = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const notes = await ctx.db
      .query('plannerCollabNotes')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const result = [];
    for (const note of notes) {
      const author = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', note.authorAuthUserKey))
        .unique();

      const files = await ctx.db
        .query('plannerCollabNoteFiles')
        .withIndex('by_noteId', (q: any) => q.eq('noteId', note._id))
        .collect();

      const fileList = [];
      for (const f of files) {
        const url = await ctx.storage.getUrl(f.storageId);
        fileList.push({
          id: f._id,
          filename: f.filename,
          original_name: f.filename,
          file_size: f.fileSize,
          mime_type: f.mimeType,
          url: url || null,
        });
      }

      result.push({
        id: note._id,
        _id: note._id,
        trip_id: args.tripId,
        user_id: note.authorAuthUserKey,
        username: author?.username || 'Unknown',
        avatar_url: author?.avatarUrl || null,
        title: note.title,
        content: note.content || '',
        category: note.category || null,
        color: note.color || null,
        pinned: note.pinned || false,
        website: note.website || null,
        files: fileList,
        created_at: new Date(note.createdAt).toISOString(),
        updated_at: new Date(note.updatedAt).toISOString(),
      });
    }
    return { notes: result };
  },
});

export const createNote = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const d = args.data as any;
    const now = Date.now();

    const id = await ctx.db.insert('plannerCollabNotes', {
      tripId: args.tripId,
      authorAuthUserKey: authUserKey,
      title: d.title || '',
      content: d.content || '',
      category: d.category || null,
      color: d.color || null,
      pinned: d.pinned || false,
      website: d.website || null,
      createdAt: now,
      updatedAt: now,
    });

    const note = await ctx.db.get(id);
    const author = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', authUserKey))
      .unique();

    return {
      note: {
        id: note!._id,
        _id: note!._id,
        trip_id: args.tripId,
        user_id: authUserKey,
        username: author?.username || 'Unknown',
        avatar_url: author?.avatarUrl || null,
        title: note!.title,
        content: note!.content || '',
        category: note!.category || null,
        color: note!.color || null,
        pinned: note!.pinned || false,
        website: note!.website || null,
        files: [],
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
    };
  },
});

export const updateNote = rawMutation({
  args: { tripId: v.id('plannerTrips'), noteId: v.id('plannerCollabNotes'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (d.title !== undefined) patch.title = d.title;
    if (d.content !== undefined) patch.content = d.content;
    if (d.category !== undefined) patch.category = d.category;
    if (d.color !== undefined) patch.color = d.color;
    if (d.pinned !== undefined) patch.pinned = d.pinned;
    if (d.website !== undefined) patch.website = d.website;

    await ctx.db.patch(args.noteId, patch);
    const note = await ctx.db.get(args.noteId);
    return {
      note: {
        id: note!._id,
        _id: note!._id,
        title: note!.title,
        content: note!.content || '',
        category: note!.category || null,
        color: note!.color || null,
        pinned: note!.pinned || false,
        website: note!.website || null,
        updated_at: new Date(note!.updatedAt).toISOString(),
      },
    };
  },
});

export const deleteNote = rawMutation({
  args: { tripId: v.id('plannerTrips'), noteId: v.id('plannerCollabNotes') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    // Delete attached files
    const files = await ctx.db
      .query('plannerCollabNoteFiles')
      .withIndex('by_noteId', (q: any) => q.eq('noteId', args.noteId))
      .collect();
    for (const f of files) {
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
    await ctx.db.delete(args.noteId);
    return { success: true };
  },
});

export const generateNoteUploadUrl = rawMutation({
  args: {},
  handler: async (ctx) => {
    await getViewerAuthKey(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveNoteFile = rawMutation({
  args: {
    tripId: v.id('plannerTrips'),
    noteId: v.id('plannerCollabNotes'),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const id = await ctx.db.insert('plannerCollabNoteFiles', {
      noteId: args.noteId,
      tripId: args.tripId,
      storageId: args.storageId,
      filename: args.filename,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      uploadedBy: authUserKey,
      createdAt: Date.now(),
    });
    const file = await ctx.db.get(id);
    const url = await ctx.storage.getUrl(args.storageId);
    return {
      file: {
        id: file!._id,
        filename: file!.filename,
        original_name: file!.filename,
        file_size: file!.fileSize,
        mime_type: file!.mimeType,
        url: url || null,
      },
    };
  },
});

export const deleteNoteFile = rawMutation({
  args: { tripId: v.id('plannerTrips'), noteId: v.id('plannerCollabNotes'), fileId: v.id('plannerCollabNoteFiles') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const file = await ctx.db.get(args.fileId);
    if (file) {
      await ctx.storage.delete(file.storageId);
      await ctx.db.delete(args.fileId);
    }
    return { success: true };
  },
});

// ── Polls ──────────────────────────────────────────────────

export const getPolls = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const polls = await ctx.db
      .query('plannerCollabPolls')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();

    const result = [];
    for (const poll of polls) {
      const author = await ctx.db
        .query('plannerUsers')
        .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', poll.authorAuthUserKey))
        .unique();

      const votes = await ctx.db
        .query('plannerCollabPollVotes')
        .withIndex('by_pollId', (q: any) => q.eq('pollId', poll._id))
        .collect();

      // Build vote counts per option
      const optionVotes: Record<number, { count: number; voters: { user_id: string; username: string }[]; voted: boolean }> = {};
      for (let i = 0; i < poll.options.length; i++) {
        optionVotes[i] = { count: 0, voters: [], voted: false };
      }
      for (const vote of votes) {
        if (optionVotes[vote.optionIndex]) {
          optionVotes[vote.optionIndex].count++;
          const voter = await ctx.db
            .query('plannerUsers')
            .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', vote.voterAuthUserKey))
            .unique();
          optionVotes[vote.optionIndex].voters.push({
            user_id: vote.voterAuthUserKey,
            username: voter?.username || 'Unknown',
          });
          if (vote.voterAuthUserKey === authUserKey) {
            optionVotes[vote.optionIndex].voted = true;
          }
        }
      }

      const optionsWithVotes = poll.options.map((text, i) => ({
        text,
        votes: optionVotes[i]?.count || 0,
        voters: optionVotes[i]?.voters || [],
        voted: optionVotes[i]?.voted || false,
      }));

      result.push({
        id: poll._id,
        _id: poll._id,
        trip_id: args.tripId,
        user_id: poll.authorAuthUserKey,
        username: author?.username || 'Unknown',
        avatar_url: author?.avatarUrl || null,
        question: poll.question,
        options: optionsWithVotes,
        multiple: poll.multiple || false,
        closed: poll.closed || false,
        deadline: poll.deadline || null,
        total_votes: votes.length,
        created_at: new Date(poll.createdAt).toISOString(),
      });
    }
    return { polls: result };
  },
});

export const createPoll = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);
    const d = args.data as any;

    const options: string[] = Array.isArray(d.options) ? d.options : [];
    if (options.length < 2) throw new ConvexError('A poll needs at least 2 options');

    const id = await ctx.db.insert('plannerCollabPolls', {
      tripId: args.tripId,
      authorAuthUserKey: authUserKey,
      question: d.question || '',
      options,
      multiple: d.multiple || d.multi_choice || false,
      closed: false,
      deadline: d.deadline || null,
      createdAt: Date.now(),
    });

    const poll = await ctx.db.get(id);
    const author = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', authUserKey))
      .unique();

    return {
      poll: {
        id: poll!._id,
        _id: poll!._id,
        trip_id: args.tripId,
        user_id: authUserKey,
        username: author?.username || 'Unknown',
        question: poll!.question,
        options: poll!.options.map((text) => ({ text, votes: 0, voters: [], voted: false })),
        multiple: poll!.multiple || false,
        closed: false,
        deadline: poll!.deadline || null,
        total_votes: 0,
        created_at: new Date(poll!.createdAt).toISOString(),
      },
    };
  },
});

export const votePoll = rawMutation({
  args: { tripId: v.id('plannerTrips'), pollId: v.id('plannerCollabPolls'), optionIndex: v.number() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const authUserKey = await getViewerAuthKey(ctx);

    const poll = await ctx.db.get(args.pollId);
    if (!poll) throw new ConvexError('Poll not found');
    if (poll.closed) throw new ConvexError('Poll is closed');
    if (args.optionIndex < 0 || args.optionIndex >= poll.options.length) {
      throw new ConvexError('Invalid option index');
    }

    // Check existing vote on this option
    const existingVotes = await ctx.db
      .query('plannerCollabPollVotes')
      .withIndex('by_pollId_voter', (q: any) => q.eq('pollId', args.pollId).eq('voterAuthUserKey', authUserKey))
      .collect();

    const existingVoteOnOption = existingVotes.find((v) => v.optionIndex === args.optionIndex);

    if (existingVoteOnOption) {
      // Toggle off
      await ctx.db.delete(existingVoteOnOption._id);
    } else {
      // If not multiple choice, remove all existing votes first
      if (!poll.multiple) {
        for (const v of existingVotes) {
          await ctx.db.delete(v._id);
        }
      }
      await ctx.db.insert('plannerCollabPollVotes', {
        pollId: args.pollId,
        voterAuthUserKey: authUserKey,
        optionIndex: args.optionIndex,
        createdAt: Date.now(),
      });
    }
    return { success: true };
  },
});

export const closePoll = rawMutation({
  args: { tripId: v.id('plannerTrips'), pollId: v.id('plannerCollabPolls') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    await ctx.db.patch(args.pollId, { closed: true });
    return { success: true };
  },
});

export const deletePoll = rawMutation({
  args: { tripId: v.id('plannerTrips'), pollId: v.id('plannerCollabPolls') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    // Delete votes
    const votes = await ctx.db
      .query('plannerCollabPollVotes')
      .withIndex('by_pollId', (q: any) => q.eq('pollId', args.pollId))
      .collect();
    for (const v of votes) {
      await ctx.db.delete(v._id);
    }
    await ctx.db.delete(args.pollId);
    return { success: true };
  },
});
