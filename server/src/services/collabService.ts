import path from 'path';
import fs from 'fs';
import { db, canAccessTrip } from '../db/database';
import { CollabNote, CollabPoll, CollabMessage, TripFile } from '../types';
import { checkSsrf, createPinnedDispatcher } from '../utils/ssrfGuard';

/* ------------------------------------------------------------------ */
/*  Internal row types                                                 */
/* ------------------------------------------------------------------ */

export interface ReactionRow {
  emoji: string;
  user_id: number;
  username: string;
  message_id?: number;
}

export interface PollVoteRow {
  option_index: number;
  user_id: number;
  username: string;
  avatar: string | null;
}

export interface NoteFileRow {
  id: number;
  filename: string;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface GroupedReaction {
  emoji: string;
  users: { user_id: number; username: string }[];
  count: number;
}

export interface LinkPreviewResult {
  title: string | null;
  description: string | null;
  image: string | null;
  site_name?: string | null;
  url: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

/* ------------------------------------------------------------------ */
/*  Reactions                                                          */
/* ------------------------------------------------------------------ */

export function loadReactions(messageId: number | string): ReactionRow[] {
  return db.prepare(`
    SELECT r.emoji, r.user_id, u.username
    FROM collab_message_reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(messageId) as ReactionRow[];
}

export function groupReactions(reactions: ReactionRow[]): GroupedReaction[] {
  const map: Record<string, { user_id: number; username: string }[]> = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push({ user_id: r.user_id, username: r.username });
  }
  return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

export function addOrRemoveReaction(messageId: number | string, tripId: number | string, userId: number, emoji: string): { found: boolean; reactions: GroupedReaction[] } {
  const msg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(messageId, tripId);
  if (!msg) return { found: false, reactions: [] };

  const existing = db.prepare('SELECT id FROM collab_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM collab_message_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO collab_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, userId, emoji);
  }

  return { found: true, reactions: groupReactions(loadReactions(messageId)) };
}

/* ------------------------------------------------------------------ */
/*  Notes                                                              */
/* ------------------------------------------------------------------ */

export function formatNote(note: CollabNote) {
  const attachments = db.prepare('SELECT id, filename, original_name, file_size, mime_type FROM trip_files WHERE note_id = ?').all(note.id) as NoteFileRow[];
  return {
    ...note,
    avatar_url: avatarUrl(note),
    attachments: attachments.map(a => ({ ...a, url: `/api/trips/${note.trip_id}/files/${a.id}/download` })),
  };
}

export function listNotes(tripId: string | number) {
  const notes = db.prepare(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `).all(tripId) as CollabNote[];

  return notes.map(formatNote);
}

export function createNote(tripId: string | number, userId: number, data: { title: string; content?: string; category?: string; color?: string; website?: string; pinned?: boolean }) {
  const pinned = data.pinned ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO collab_notes (trip_id, user_id, title, content, category, color, website, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, userId, data.title, data.content || null, data.category || 'General', data.color || '#6366f1', data.website || null, pinned);

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(result.lastInsertRowid) as CollabNote;

  return formatNote(note);
}

export function updateNote(tripId: string | number, noteId: string | number, data: { title?: string; content?: string; category?: string; color?: string; pinned?: number | boolean; website?: string }): ReturnType<typeof formatNote> | null {
  const existing = db.prepare('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?').get(noteId, tripId);
  if (!existing) return null;

  db.prepare(`
    UPDATE collab_notes SET
      title = COALESCE(?, title),
      content = CASE WHEN ? THEN ? ELSE content END,
      category = COALESCE(?, category),
      color = COALESCE(?, color),
      pinned = CASE WHEN ? IS NOT NULL THEN ? ELSE pinned END,
      website = CASE WHEN ? THEN ? ELSE website END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    data.title || null,
    data.content !== undefined ? 1 : 0, data.content !== undefined ? data.content : null,
    data.category || null,
    data.color || null,
    data.pinned !== undefined ? 1 : null, data.pinned ? 1 : 0,
    data.website !== undefined ? 1 : 0, data.website !== undefined ? data.website : null,
    noteId
  );

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(noteId) as CollabNote;

  return formatNote(note);
}

export function deleteNote(tripId: string | number, noteId: string | number): boolean {
  const existing = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(noteId, tripId);
  if (!existing) return false;

  // Clean up attached files from disk
  const noteFiles = db.prepare('SELECT id, filename FROM trip_files WHERE note_id = ?').all(noteId) as NoteFileRow[];
  for (const f of noteFiles) {
    const filePath = path.join(__dirname, '../../uploads', f.filename);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM trip_files WHERE note_id = ?').run(noteId);

  db.prepare('DELETE FROM collab_notes WHERE id = ?').run(noteId);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Note files                                                         */
/* ------------------------------------------------------------------ */

export function addNoteFile(tripId: string | number, noteId: string | number, file: { filename: string; originalname: string; size: number; mimetype: string }): { file: TripFile & { url: string } } | null {
  const note = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(noteId, tripId);
  if (!note) return null;

  const result = db.prepare(
    'INSERT INTO trip_files (trip_id, note_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tripId, noteId, `files/${file.filename}`, file.originalname, file.size, file.mimetype);

  const saved = db.prepare('SELECT * FROM trip_files WHERE id = ?').get(result.lastInsertRowid) as TripFile;
  return { file: { ...saved, url: `/api/trips/${tripId}/files/${saved.id}/download` } };
}

export function getFormattedNoteById(noteId: string | number) {
  const note = db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(noteId) as CollabNote;
  return formatNote(note);
}

export function deleteNoteFile(noteId: string | number, fileId: string | number): boolean {
  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND note_id = ?').get(fileId, noteId) as TripFile | undefined;
  if (!file) return false;

  const filePath = path.join(__dirname, '../../uploads', file.filename);
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(fileId);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Polls                                                              */
/* ------------------------------------------------------------------ */

export function getPollWithVotes(pollId: number | bigint | string) {
  const poll = db.prepare(`
    SELECT p.*, u.username, u.avatar
    FROM collab_polls p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(pollId) as CollabPoll | undefined;

  if (!poll) return null;

  const options: (string | { label: string })[] = JSON.parse(poll.options);

  const votes = db.prepare(`
    SELECT v.option_index, v.user_id, u.username, u.avatar
    FROM collab_poll_votes v
    JOIN users u ON v.user_id = u.id
    WHERE v.poll_id = ?
  `).all(pollId) as PollVoteRow[];

  const formattedOptions = options.map((label: string | { label: string }, idx: number) => ({
    label: typeof label === 'string' ? label : label.label || label,
    voters: votes
      .filter(v => v.option_index === idx)
      .map(v => ({ id: v.user_id, user_id: v.user_id, username: v.username, avatar: v.avatar, avatar_url: avatarUrl(v) })),
  }));

  return {
    ...poll,
    avatar_url: avatarUrl(poll),
    options: formattedOptions,
    is_closed: !!poll.closed,
    multiple_choice: !!poll.multiple,
  };
}

export function listPolls(tripId: string | number) {
  const rows = db.prepare(`
    SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC
  `).all(tripId) as { id: number }[];

  return rows.map(row => getPollWithVotes(row.id)).filter(Boolean);
}

export function createPoll(tripId: string | number, userId: number, data: { question: string; options: unknown[]; multiple?: boolean; multiple_choice?: boolean; deadline?: string }) {
  const isMultiple = data.multiple || data.multiple_choice;

  const result = db.prepare(`
    INSERT INTO collab_polls (trip_id, user_id, question, options, multiple, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, userId, data.question, JSON.stringify(data.options), isMultiple ? 1 : 0, data.deadline || null);

  return getPollWithVotes(result.lastInsertRowid);
}

export function votePoll(tripId: string | number, pollId: string | number, userId: number, optionIndex: number): { error?: string; poll?: ReturnType<typeof getPollWithVotes> } {
  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(pollId, tripId) as CollabPoll | undefined;
  if (!poll) return { error: 'not_found' };
  if (poll.closed) return { error: 'closed' };

  const options = JSON.parse(poll.options);
  if (optionIndex < 0 || optionIndex >= options.length) {
    return { error: 'invalid_index' };
  }

  const existingVote = db.prepare(
    'SELECT id FROM collab_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?'
  ).get(pollId, userId, optionIndex) as { id: number } | undefined;

  if (existingVote) {
    db.prepare('DELETE FROM collab_poll_votes WHERE id = ?').run(existingVote.id);
  } else {
    if (!poll.multiple) {
      db.prepare('DELETE FROM collab_poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId);
    }
    db.prepare('INSERT INTO collab_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)').run(pollId, userId, optionIndex);
  }

  return { poll: getPollWithVotes(pollId) };
}

export function closePoll(tripId: string | number, pollId: string | number): ReturnType<typeof getPollWithVotes> | null {
  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(pollId, tripId);
  if (!poll) return null;

  db.prepare('UPDATE collab_polls SET closed = 1 WHERE id = ?').run(pollId);
  return getPollWithVotes(pollId);
}

export function deletePoll(tripId: string | number, pollId: string | number): boolean {
  const poll = db.prepare('SELECT id FROM collab_polls WHERE id = ? AND trip_id = ?').get(pollId, tripId);
  if (!poll) return false;

  db.prepare('DELETE FROM collab_polls WHERE id = ?').run(pollId);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

export function formatMessage(msg: CollabMessage, reactions?: GroupedReaction[]) {
  return { ...msg, user_avatar: avatarUrl(msg), avatar_url: avatarUrl(msg), reactions: reactions || [] };
}

export function countMessages(tripId: string | number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM collab_messages WHERE trip_id = ?').get(tripId) as { cnt: number };
  return row.cnt;
}

export function listMessages(tripId: string | number, before?: string | number) {
  const query = `
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.trip_id = ?${before ? ' AND m.id < ?' : ''}
    ORDER BY m.id DESC
    LIMIT 100
  `;

  const messages = before
    ? db.prepare(query).all(tripId, before) as CollabMessage[]
    : db.prepare(query).all(tripId) as CollabMessage[];

  messages.reverse();

  const msgIds = messages.map(m => m.id);
  const reactionsByMsg: Record<number, ReactionRow[]> = {};
  if (msgIds.length > 0) {
    const allReactions = db.prepare(`
      SELECT r.message_id, r.emoji, r.user_id, u.username
      FROM collab_message_reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds) as (ReactionRow & { message_id: number })[];
    for (const r of allReactions) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
      reactionsByMsg[r.message_id].push(r);
    }
  }

  return messages.map(m => formatMessage(m, groupReactions(reactionsByMsg[m.id] || [])));
}

export function createMessage(tripId: string | number, userId: number, text: string, replyTo?: number | null): { error?: string; message?: ReturnType<typeof formatMessage> } {
  if (replyTo) {
    const replyMsg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(replyTo, tripId);
    if (!replyMsg) return { error: 'reply_not_found' };
  }

  const result = db.prepare(`
    INSERT INTO collab_messages (trip_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
  `).run(tripId, userId, text.trim(), replyTo || null);

  const message = db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.id = ?
  `).get(result.lastInsertRowid) as CollabMessage;

  return { message: formatMessage(message) };
}

export function deleteMessage(tripId: string | number, messageId: string | number, userId: number): { error?: string; username?: string } {
  const message = db.prepare('SELECT * FROM collab_messages WHERE id = ? AND trip_id = ?').get(messageId, tripId) as CollabMessage | undefined;
  if (!message) return { error: 'not_found' };
  if (Number(message.user_id) !== Number(userId)) return { error: 'not_owner' };

  db.prepare('UPDATE collab_messages SET deleted = 1 WHERE id = ?').run(messageId);
  return { username: message.username };
}

/* ------------------------------------------------------------------ */
/*  Link preview                                                       */
/* ------------------------------------------------------------------ */

export async function fetchLinkPreview(url: string): Promise<LinkPreviewResult> {
  const fallback: LinkPreviewResult = { title: null, description: null, image: null, url };

  const parsed = new URL(url);
  const ssrf = await checkSsrf(url, true);
  if (!ssrf.allowed) {
    return { ...fallback, error: ssrf.error } as LinkPreviewResult & { error?: string };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const r = await fetch(url, {
        redirect: 'error',
        signal: controller.signal,
        dispatcher: createPinnedDispatcher(ssrf.resolvedIp!),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NOMAD/1.0; +https://github.com/mauriceboe/NOMAD)' },
      } as any);
      clearTimeout(timeout);
      if (!r.ok) throw new Error('Fetch failed');

      const html = await r.text();
      const get = (prop: string) => {
        const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
          || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'));
        return m ? m[1] : null;
      };
      const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const descMeta = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);

      return {
        title: get('title') || (titleTag ? titleTag[1].trim() : null),
        description: get('description') || (descMeta ? descMeta[1].trim() : null),
        image: get('image') || null,
        site_name: get('site_name') || null,
        url,
      };
    } catch {
      clearTimeout(timeout);
      return fallback;
    }
  } catch {
    return fallback;
  }
}
