import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest, CollabNote, CollabPoll, CollabMessage, TripFile } from '../types';
import { checkSsrf, createPinnedAgent } from '../utils/ssrfGuard';

interface ReactionRow {
  emoji: string;
  user_id: number;
  username: string;
  message_id?: number;
}

interface PollVoteRow {
  option_index: number;
  user_id: number;
  username: string;
  avatar: string | null;
}

interface NoteFileRow {
  id: number;
  filename: string;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
}

const MAX_NOTE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const filesDir = path.join(__dirname, '../../uploads/files');
const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true }); cb(null, filesDir) },
    filename: (_req, file, cb) => { cb(null, `${uuidv4()}${path.extname(file.originalname)}`) },
  }),
  limits: { fileSize: MAX_NOTE_FILE_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const BLOCKED = ['.svg', '.html', '.htm', '.xml', '.xhtml', '.js', '.jsx', '.ts', '.exe', '.bat', '.sh', '.cmd', '.msi', '.dll', '.com', '.vbs', '.ps1', '.php'];
    if (BLOCKED.includes(ext) || file.mimetype.includes('svg') || file.mimetype.includes('html') || file.mimetype.includes('javascript')) {
      return cb(new Error('File type not allowed'));
    }
    cb(null, true);
  },
});

const router = express.Router({ mergeParams: true });

function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function formatNote(note: CollabNote) {
  const attachments = db.prepare('SELECT id, filename, original_name, file_size, mime_type FROM trip_files WHERE note_id = ?').all(note.id) as NoteFileRow[];
  return {
    ...note,
    avatar_url: avatarUrl(note),
    attachments: attachments.map(a => ({ ...a, url: `/uploads/${a.filename}` })),
  };
}

function loadReactions(messageId: number | string) {
  return db.prepare(`
    SELECT r.emoji, r.user_id, u.username
    FROM collab_message_reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(messageId) as ReactionRow[];
}

function groupReactions(reactions: ReactionRow[]) {
  const map: Record<string, { user_id: number; username: string }[]> = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push({ user_id: r.user_id, username: r.username });
  }
  return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

function formatMessage(msg: CollabMessage, reactions?: { emoji: string; users: { user_id: number; username: string }[]; count: number }[]) {
  return { ...msg, user_avatar: avatarUrl(msg), avatar_url: avatarUrl(msg), reactions: reactions || [] };
}

router.get('/notes', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const notes = db.prepare(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `).all(tripId) as CollabNote[];

  res.json({ notes: notes.map(formatNote) });
});

router.post('/notes', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, content, category, color, website } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const result = db.prepare(`
    INSERT INTO collab_notes (trip_id, user_id, title, content, category, color, website)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, authReq.user.id, title, content || null, category || 'General', color || '#6366f1', website || null);

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(result.lastInsertRowid) as CollabNote;

  const formatted = formatNote(note);
  res.status(201).json({ note: formatted });
  broadcast(tripId, 'collab:note:created', { note: formatted }, req.headers['x-socket-id'] as string);

  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    notifyTripMembers(Number(tripId), authReq.user.id, 'collab_message', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email }).catch(() => {});
  });
});

router.put('/notes/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { title, content, category, color, pinned, website } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const existing = db.prepare('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

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
    title || null,
    content !== undefined ? 1 : 0, content !== undefined ? content : null,
    category || null,
    color || null,
    pinned !== undefined ? 1 : null, pinned ? 1 : 0,
    website !== undefined ? 1 : 0, website !== undefined ? website : null,
    id
  );

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(id) as CollabNote;

  const formatted = formatNote(note);
  res.json({ note: formatted });
  broadcast(tripId, 'collab:note:updated', { note: formatted }, req.headers['x-socket-id'] as string);
});

router.delete('/notes/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const existing = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  const noteFiles = db.prepare('SELECT id, filename FROM trip_files WHERE note_id = ?').all(id) as NoteFileRow[];
  for (const f of noteFiles) {
    const filePath = path.join(__dirname, '../../uploads', f.filename);
    try { fs.unlinkSync(filePath) } catch {}
  }
  db.prepare('DELETE FROM trip_files WHERE note_id = ?').run(id);

  db.prepare('DELETE FROM collab_notes WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:note:deleted', { noteId: Number(id) }, req.headers['x-socket-id'] as string);
});

router.post('/notes/:id/files', authenticate, noteUpload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_upload', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to upload files' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const note = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const result = db.prepare(
    'INSERT INTO trip_files (trip_id, note_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tripId, id, `files/${req.file.filename}`, req.file.originalname, req.file.size, req.file.mimetype);

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ?').get(result.lastInsertRowid) as TripFile;
  res.status(201).json({ file: { ...file, url: `/uploads/${file.filename}` } });
  broadcast(Number(tripId), 'collab:note:updated', { note: formatNote(db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id) as CollabNote) }, req.headers['x-socket-id'] as string);
});

router.delete('/notes/:id/files/:fileId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, fileId } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND note_id = ?').get(fileId, id) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found' });

  const filePath = path.join(__dirname, '../../uploads', file.filename);
  try { fs.unlinkSync(filePath) } catch {}

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(fileId);
  res.json({ success: true });
  broadcast(Number(tripId), 'collab:note:updated', { note: formatNote(db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id) as CollabNote) }, req.headers['x-socket-id'] as string);
});

function getPollWithVotes(pollId: number | bigint | string) {
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

router.get('/polls', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const rows = db.prepare(`
    SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC
  `).all(tripId) as { id: number }[];

  const polls = rows.map(row => getPollWithVotes(row.id)).filter(Boolean);
  res.json({ polls });
});

router.post('/polls', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { question, options, multiple, multiple_choice, deadline } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!question) return res.status(400).json({ error: 'Question is required' });
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options are required' });
  }

  const isMultiple = multiple || multiple_choice;

  const result = db.prepare(`
    INSERT INTO collab_polls (trip_id, user_id, question, options, multiple, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, authReq.user.id, question, JSON.stringify(options), isMultiple ? 1 : 0, deadline || null);

  const poll = getPollWithVotes(result.lastInsertRowid);
  res.status(201).json({ poll });
  broadcast(tripId, 'collab:poll:created', { poll }, req.headers['x-socket-id'] as string);
});

router.post('/polls/:id/vote', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { option_index } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId) as CollabPoll | undefined;
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });

  const options = JSON.parse(poll.options);
  if (option_index < 0 || option_index >= options.length) {
    return res.status(400).json({ error: 'Invalid option index' });
  }

  const existingVote = db.prepare(
    'SELECT id FROM collab_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?'
  ).get(id, authReq.user.id, option_index) as { id: number } | undefined;

  if (existingVote) {
    db.prepare('DELETE FROM collab_poll_votes WHERE id = ?').run(existingVote.id);
  } else {
    if (!poll.multiple) {
      db.prepare('DELETE FROM collab_poll_votes WHERE poll_id = ? AND user_id = ?').run(id, authReq.user.id);
    }
    db.prepare('INSERT INTO collab_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)').run(id, authReq.user.id, option_index);
  }

  const updatedPoll = getPollWithVotes(id);
  res.json({ poll: updatedPoll });
  broadcast(tripId, 'collab:poll:voted', { poll: updatedPoll }, req.headers['x-socket-id'] as string);
});

router.put('/polls/:id/close', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  db.prepare('UPDATE collab_polls SET closed = 1 WHERE id = ?').run(id);

  const updatedPoll = getPollWithVotes(id);
  res.json({ poll: updatedPoll });
  broadcast(tripId, 'collab:poll:closed', { poll: updatedPoll }, req.headers['x-socket-id'] as string);
});

router.delete('/polls/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const poll = db.prepare('SELECT id FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  db.prepare('DELETE FROM collab_polls WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:poll:deleted', { pollId: Number(id) }, req.headers['x-socket-id'] as string);
});

router.get('/messages', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { before } = req.query;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

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
  res.json({ messages: messages.map(m => formatMessage(m, groupReactions(reactionsByMsg[m.id] || []))) });
});

router.post('/messages', authenticate, validateStringLengths({ text: 5000 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { text, reply_to } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required' });

  if (reply_to) {
    const replyMsg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(reply_to, tripId);
    if (!replyMsg) return res.status(400).json({ error: 'Reply target message not found' });
  }

  const result = db.prepare(`
    INSERT INTO collab_messages (trip_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
  `).run(tripId, authReq.user.id, text.trim(), reply_to || null);

  const message = db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.id = ?
  `).get(result.lastInsertRowid) as CollabMessage;

  const formatted = formatMessage(message);
  res.status(201).json({ message: formatted });
  broadcast(tripId, 'collab:message:created', { message: formatted }, req.headers['x-socket-id'] as string);

  // Notify trip members about new chat message
  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    const preview = text.trim().length > 80 ? text.trim().substring(0, 80) + '...' : text.trim();
    notifyTripMembers(Number(tripId), authReq.user.id, 'collab_message', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, preview }).catch(() => {});
  });
});

router.post('/messages/:id/react', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { emoji } = req.body;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!emoji) return res.status(400).json({ error: 'Emoji is required' });

  const msg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const existing = db.prepare('SELECT id FROM collab_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, authReq.user.id, emoji) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM collab_message_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO collab_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(id, authReq.user.id, emoji);
  }

  const reactions = groupReactions(loadReactions(id));
  res.json({ reactions });
  broadcast(Number(tripId), 'collab:message:reacted', { messageId: Number(id), reactions }, req.headers['x-socket-id'] as string);
});

router.delete('/messages/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const message = db.prepare('SELECT * FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId) as CollabMessage | undefined;
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (Number(message.user_id) !== Number(authReq.user.id)) return res.status(403).json({ error: 'You can only delete your own messages' });

  db.prepare('UPDATE collab_messages SET deleted = 1 WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:message:deleted', { messageId: Number(id), username: message.username || authReq.user.username }, req.headers['x-socket-id'] as string);
});

router.get('/link-preview', authenticate, async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const parsed = new URL(url);
    const ssrf = await checkSsrf(url);
    if (!ssrf.allowed) {
      return res.status(400).json({ error: ssrf.error });
    }

    const nodeFetch = require('node-fetch');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    nodeFetch(url, {
      redirect: 'error',
      signal: controller.signal,
      agent: createPinnedAgent(ssrf.resolvedIp!, parsed.protocol),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NOMAD/1.0; +https://github.com/mauriceboe/NOMAD)' },
    })
      .then((r: { ok: boolean; text: () => Promise<string> }) => {
        clearTimeout(timeout);
        if (!r.ok) throw new Error('Fetch failed');
        return r.text();
      })
      .then((html: string) => {
        const get = (prop: string) => {
          const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
            || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'));
          return m ? m[1] : null;
        };
        const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const descMeta = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
          || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);

        res.json({
          title: get('title') || (titleTag ? titleTag[1].trim() : null),
          description: get('description') || (descMeta ? descMeta[1].trim() : null),
          image: get('image') || null,
          site_name: get('site_name') || null,
          url,
        });
      })
      .catch(() => {
        clearTimeout(timeout);
        res.json({ title: null, description: null, image: null, url });
      });
  } catch {
    res.json({ title: null, description: null, image: null, url });
  }
});

export default router;
