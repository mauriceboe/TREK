import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  verifyTripAccess,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  addNoteFile,
  getFormattedNoteById,
  deleteNoteFile,
  listPolls,
  createPoll,
  votePoll,
  closePoll,
  deletePoll,
  listMessages,
  createMessage,
  deleteMessage,
  addOrRemoveReaction,
  fetchLinkPreview,
} from '../services/collabService';

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
      return cb(null, false);
    }
    cb(null, true);
  },
});

const router = express.Router({ mergeParams: true });

/* ------------------------------------------------------------------ */
/*  Notes                                                              */
/* ------------------------------------------------------------------ */

router.get('/notes', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ notes: listNotes(tripId) });
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

  const formatted = createNote(tripId, authReq.user.id, { title, content, category, color, website });
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

  const formatted = updateNote(tripId, id, { title, content, category, color, pinned, website });
  if (!formatted) return res.status(404).json({ error: 'Note not found' });

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

  if (!deleteNote(tripId, id)) return res.status(404).json({ error: 'Note not found' });

  res.json({ success: true });
  broadcast(tripId, 'collab:note:deleted', { noteId: Number(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Note files                                                         */
/* ------------------------------------------------------------------ */

router.post('/notes/:id/files', authenticate, noteUpload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_upload', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to upload files' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const result = addNoteFile(tripId, id, req.file);
  if (!result) return res.status(404).json({ error: 'Note not found' });

  res.status(201).json(result);
  broadcast(Number(tripId), 'collab:note:updated', { note: getFormattedNoteById(id) }, req.headers['x-socket-id'] as string);
});

router.delete('/notes/:id/files/:fileId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, fileId } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteNoteFile(id, fileId)) return res.status(404).json({ error: 'File not found' });

  res.json({ success: true });
  broadcast(Number(tripId), 'collab:note:updated', { note: getFormattedNoteById(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Polls                                                              */
/* ------------------------------------------------------------------ */

router.get('/polls', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ polls: listPolls(tripId) });
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

  const poll = createPoll(tripId, authReq.user.id, { question, options, multiple, multiple_choice, deadline });
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

  const result = votePoll(tripId, id, authReq.user.id, option_index);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Poll not found' });
  if (result.error === 'closed') return res.status(400).json({ error: 'Poll is closed' });
  if (result.error === 'invalid_index') return res.status(400).json({ error: 'Invalid option index' });

  res.json({ poll: result.poll });
  broadcast(tripId, 'collab:poll:voted', { poll: result.poll }, req.headers['x-socket-id'] as string);
});

router.put('/polls/:id/close', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const updatedPoll = closePoll(tripId, id);
  if (!updatedPoll) return res.status(404).json({ error: 'Poll not found' });

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

  if (!deletePoll(tripId, id)) return res.status(404).json({ error: 'Poll not found' });

  res.json({ success: true });
  broadcast(tripId, 'collab:poll:deleted', { pollId: Number(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

router.get('/messages', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { before } = req.query;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ messages: listMessages(tripId, before as string | undefined) });
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

  const result = createMessage(tripId, authReq.user.id, text, reply_to);
  if (result.error === 'reply_not_found') return res.status(400).json({ error: 'Reply target message not found' });

  res.status(201).json({ message: result.message });
  broadcast(tripId, 'collab:message:created', { message: result.message }, req.headers['x-socket-id'] as string);

  // Notify trip members about new chat message
  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    const preview = text.trim().length > 80 ? text.trim().substring(0, 80) + '...' : text.trim();
    notifyTripMembers(Number(tripId), authReq.user.id, 'collab_message', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, preview }).catch(() => {});
  });
});

/* ------------------------------------------------------------------ */
/*  Reactions                                                          */
/* ------------------------------------------------------------------ */

router.post('/messages/:id/react', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { emoji } = req.body;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!emoji) return res.status(400).json({ error: 'Emoji is required' });

  const result = addOrRemoveReaction(id, tripId, authReq.user.id, emoji);
  if (!result.found) return res.status(404).json({ error: 'Message not found' });

  res.json({ reactions: result.reactions });
  broadcast(Number(tripId), 'collab:message:reacted', { messageId: Number(id), reactions: result.reactions }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Delete message                                                     */
/* ------------------------------------------------------------------ */

router.delete('/messages/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const result = deleteMessage(tripId, id, authReq.user.id);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Message not found' });
  if (result.error === 'not_owner') return res.status(403).json({ error: 'You can only delete your own messages' });

  res.json({ success: true });
  broadcast(tripId, 'collab:message:deleted', { messageId: Number(id), username: result.username || authReq.user.username }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Link preview                                                       */
/* ------------------------------------------------------------------ */

router.get('/link-preview', authenticate, async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const preview = await fetchLinkPreview(url);
    const asAny = preview as any;
    if (asAny.error) return res.status(400).json({ error: asAny.error });
    res.json(preview);
  } catch {
    res.json({ title: null, description: null, image: null, url });
  }
});

export default router;
