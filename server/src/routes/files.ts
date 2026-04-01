import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { db, canAccessTrip } from '../db/database';
import { consumeEphemeralToken } from '../services/ephemeralTokens';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { AuthRequest, TripFile } from '../types';
import { checkPermission } from '../services/permissions';

const router = express.Router({ mergeParams: true });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const filesDir = path.join(__dirname, '../../uploads/files');

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

const DEFAULT_ALLOWED_EXTENSIONS = 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv';
const BLOCKED_EXTENSIONS = ['.svg', '.html', '.htm', '.xml'];

function getAllowedExtensions(): string {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined;
    return row?.value || DEFAULT_ALLOWED_EXTENSIONS;
  } catch { return DEFAULT_ALLOWED_EXTENSIONS; }
}

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

function verifyTripOwnership(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

const FILE_SELECT = `
  SELECT f.*, r.title as reservation_title, u.username as uploaded_by_name, u.avatar as uploaded_by_avatar
  FROM trip_files f
  LEFT JOIN reservations r ON f.reservation_id = r.id
  LEFT JOIN users u ON f.uploaded_by = u.id
`;

function formatFile(file: TripFile & { trip_id?: number }) {
  const tripId = file.trip_id;
  return {
    ...file,
    url: `/api/trips/${tripId}/files/${file.id}/download`,
  };
}

function getPlaceFiles(tripId: string | number, placeId: number) {
  return (db.prepare('SELECT * FROM trip_files WHERE trip_id = ? AND place_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(tripId, placeId) as (TripFile & { trip_id: number })[]).map(formatFile);
}

// Authenticated file download (supports Bearer header or ?token= query param for direct links)
router.get('/:id/download', (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  // Accept token from Authorization header (JWT) or query parameter (ephemeral token)
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.split(' ')[1];
  const queryToken = req.query.token as string | undefined;

  if (!bearerToken && !queryToken) return res.status(401).json({ error: 'Authentication required' });

  let userId: number;
  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
      userId = decoded.id;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } else {
    const uid = consumeEphemeralToken(queryToken!, 'download');
    if (!uid) return res.status(401).json({ error: 'Invalid or expired token' });
    userId = uid;
  }

  const trip = verifyTripOwnership(tripId, userId);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found' });

  const safeName = path.basename(file.filename);
  const filePath = path.join(filesDir, safeName);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(filesDir))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(resolved);
});

// List files (excludes soft-deleted by default)
interface FileLink {
  file_id: number;
  reservation_id: number | null;
  place_id: number | null;
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const showTrash = req.query.trash === 'true';

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const where = showTrash ? 'f.trip_id = ? AND f.deleted_at IS NOT NULL' : 'f.trip_id = ? AND f.deleted_at IS NULL';
  const files = db.prepare(`${FILE_SELECT} WHERE ${where} ORDER BY f.starred DESC, f.created_at DESC`).all(tripId) as TripFile[];

  // Get all file_links for this trip's files
  const fileIds = files.map(f => f.id);
  let linksMap: Record<number, FileLink[]> = {};
  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    const links = db.prepare(`SELECT file_id, reservation_id, place_id FROM file_links WHERE file_id IN (${placeholders})`).all(...fileIds) as FileLink[];
    for (const link of links) {
      if (!linksMap[link.file_id]) linksMap[link.file_id] = [];
      linksMap[link.file_id].push(link);
    }
  }

  res.json({ files: files.map(f => {
    const fileLinks = linksMap[f.id] || [];
    return {
      ...formatFile(f),
      linked_reservation_ids: fileLinks.filter(l => l.reservation_id).map(l => l.reservation_id),
      linked_place_ids: fileLinks.filter(l => l.place_id).map(l => l.place_id),
    };
  })});
});

// Upload file
router.post('/', authenticate, requireTripAccess, demoUploadBlock, upload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { user_id: tripOwnerId } = authReq.trip!;
  if (!checkPermission('file_upload', authReq.user.role, tripOwnerId, authReq.user.id, tripOwnerId !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to upload files' });
  const { place_id, description, reservation_id } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const result = db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    place_id || null,
    reservation_id || null,
    req.file.filename,
    req.file.originalname,
    req.file.size,
    req.file.mimetype,
    description || null,
    authReq.user.id
  );

  const file = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(result.lastInsertRowid) as TripFile;
  res.status(201).json({ file: formatFile(file) });
  broadcast(tripId, 'file:created', { file: formatFile(file) }, req.headers['x-socket-id'] as string);
});

// Update file metadata
router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { description, place_id, reservation_id } = req.body;

  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to edit files' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare(`
    UPDATE trip_files SET
      description = ?,
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(
    description !== undefined ? description : file.description,
    place_id !== undefined ? (place_id || null) : file.place_id,
    reservation_id !== undefined ? (reservation_id || null) : file.reservation_id,
    id
  );

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  res.json({ file: formatFile(updated) });
  broadcast(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id'] as string);
});

// Toggle starred
router.patch('/:id/star', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found' });

  const newStarred = file.starred ? 0 : 1;
  db.prepare('UPDATE trip_files SET starred = ? WHERE id = ?').run(newStarred, id);

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  res.json({ file: formatFile(updated) });
  broadcast(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id'] as string);
});

// Soft-delete (move to trash)
router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to delete files' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare('UPDATE trip_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id'] as string);
});

// Restore from trash
router.post('/:id/restore', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found in trash' });

  db.prepare('UPDATE trip_files SET deleted_at = NULL WHERE id = ?').run(id);

  const restored = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  res.json({ file: formatFile(restored) });
  broadcast(tripId, 'file:created', { file: formatFile(restored) }, req.headers['x-socket-id'] as string);
});

// Permanently delete from trash
router.delete('/:id/permanent', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId) as TripFile | undefined;
  if (!file) return res.status(404).json({ error: 'File not found in trash' });

  const filePath = path.join(filesDir, file.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting file:', e); }
  }

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id'] as string);
});

// Empty entire trash
router.delete('/trash/empty', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_delete', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const trashed = db.prepare('SELECT * FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').all(tripId) as TripFile[];
  for (const file of trashed) {
    const filePath = path.join(filesDir, file.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting file:', e); }
    }
  }

  db.prepare('DELETE FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').run(tripId);
  res.json({ success: true, deleted: trashed.length });
});

// Link a file to a reservation (many-to-many)
router.post('/:id/link', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { reservation_id, assignment_id, place_id } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  try {
    db.prepare('INSERT OR IGNORE INTO file_links (file_id, reservation_id, assignment_id, place_id) VALUES (?, ?, ?, ?)').run(
      id, reservation_id || null, assignment_id || null, place_id || null
    );
  } catch (err) {
    console.error('[Files] Error creating file link:', err instanceof Error ? err.message : err);
  }

  const links = db.prepare('SELECT * FROM file_links WHERE file_id = ?').all(id);
  res.json({ success: true, links });
});

// Unlink a file from a reservation
router.delete('/:id/link/:linkId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, linkId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  db.prepare('DELETE FROM file_links WHERE id = ? AND file_id = ?').run(linkId, id);
  res.json({ success: true });
});

// Get all links for a file
router.get('/:id/links', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const links = db.prepare(`
    SELECT fl.*, r.title as reservation_title
    FROM file_links fl
    LEFT JOIN reservations r ON fl.reservation_id = r.id
    WHERE fl.file_id = ?
  `).all(id);
  res.json({ links });
});

export default router;
