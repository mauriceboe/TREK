import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import { checkPermission } from '../services/permissions';
import {
  MAX_FILE_SIZE,
  BLOCKED_EXTENSIONS,
  filesDir,
  getAllowedExtensions,
  verifyTripAccess,
  formatFile,
  resolveFilePath,
  authenticateDownload,
  listFiles,
  getFileById,
  getFileByIdFull,
  getDeletedFile,
  createFile,
  updateFile,
  toggleStarred,
  softDeleteFile,
  restoreFile,
  permanentDeleteFile,
  emptyTrash,
  createFileLink,
  deleteFileLink,
  getFileLinks,
} from '../services/fileService';

const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Multer setup (HTTP middleware — stays in route)
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
    cb(null, filesDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext) || file.mimetype.includes('svg')) {
      return cb(new Error('File type not allowed'));
    }
    const allowed = getAllowedExtensions().split(',').map(e => e.trim().toLowerCase());
    const fileExt = ext.replace('.', '');
    if (allowed.includes(fileExt) || (allowed.includes('*') && !BLOCKED_EXTENSIONS.includes(ext))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Authenticated file download (supports Bearer header or ?token= query param)
router.get('/:id/download', (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.split(' ')[1];
  const queryToken = req.query.token as string | undefined;

  const auth = authenticateDownload(bearerToken, queryToken);
  if ('error' in auth) return res.status(auth.status).json({ error: auth.error });

  const trip = verifyTripAccess(tripId, auth.userId);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const file = getFileById(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const { resolved, safe } = resolveFilePath(file.filename);
  if (!safe) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  res.sendFile(resolved);
});

// List files (excludes soft-deleted by default)
router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const showTrash = req.query.trash === 'true';

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  res.json({ files: listFiles(tripId, showTrash) });
});

// Upload file
router.post('/', authenticate, requireTripAccess, demoUploadBlock, upload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { user_id: tripOwnerId } = authReq.trip!;
  if (!checkPermission('file_upload', authReq.user.role, tripOwnerId, authReq.user.id, tripOwnerId !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to upload files' });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { place_id, description, reservation_id } = req.body;
  const created = createFile(tripId, req.file, authReq.user.id, { place_id, description, reservation_id });
  res.status(201).json({ file: created });
  broadcast(tripId, 'file:created', { file: created }, req.headers['x-socket-id'] as string);
});

// Update file metadata
router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { description, place_id, reservation_id } = req.body;

  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to edit files' });

  const file = getFileById(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const updated = updateFile(id, file, { description, place_id, reservation_id });
  res.json({ file: updated });
  broadcast(tripId, 'file:updated', { file: updated }, req.headers['x-socket-id'] as string);
});

// Toggle starred
router.patch('/:id/star', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = getFileById(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const updated = toggleStarred(id, file.starred);
  res.json({ file: updated });
  broadcast(tripId, 'file:updated', { file: updated }, req.headers['x-socket-id'] as string);
});

// Soft-delete (move to trash)
router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to delete files' });

  const file = getFileById(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  softDeleteFile(id);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id'] as string);
});

// Restore from trash
router.post('/:id/restore', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = getDeletedFile(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found in trash' });

  const restored = restoreFile(id);
  res.json({ file: restored });
  broadcast(tripId, 'file:created', { file: restored }, req.headers['x-socket-id'] as string);
});

// Permanently delete from trash
router.delete('/:id/permanent', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = getDeletedFile(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found in trash' });

  permanentDeleteFile(file);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id'] as string);
});

// Empty entire trash
router.delete('/trash/empty', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const deleted = emptyTrash(tripId);
  res.json({ success: true, deleted });
});

// Link a file to a reservation (many-to-many)
router.post('/:id/link', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { reservation_id, assignment_id, place_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = getFileById(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const links = createFileLink(id, { reservation_id, assignment_id, place_id });
  res.json({ success: true, links });
});

// Unlink a file from a reservation
router.delete('/:id/link/:linkId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, linkId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  deleteFileLink(linkId, id);
  res.json({ success: true });
});

// Get all links for a file
router.get('/:id/links', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const links = getFileLinks(id);
  res.json({ links });
});

export default router;
