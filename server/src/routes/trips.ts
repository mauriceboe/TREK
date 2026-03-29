import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip, isOwner } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, Trip, User } from '../types';

const router = express.Router();

const MS_PER_DAY = 86400000;
const MAX_TRIP_DAYS = 90;
const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20 MB

const coversDir = path.join(__dirname, '../../uploads/covers');
const coverStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
    cb(null, coversDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: MAX_COVER_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (file.mimetype.startsWith('image/') && !file.mimetype.includes('svg') && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, png, gif, webp images allowed'));
    }
  },
});

const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

function generateDays(tripId: number | bigint | string, startDate: string | null, endDate: string | null) {
  const existing = db.prepare('SELECT id, day_number, date FROM days WHERE trip_id = ?').all(tripId) as { id: number; day_number: number; date: string | null }[];

  if (!startDate || !endDate) {
    const datelessExisting = existing.filter(d => !d.date).sort((a, b) => a.day_number - b.day_number);
    const withDates = existing.filter(d => d.date);
    if (withDates.length > 0) {
      db.prepare(`DELETE FROM days WHERE trip_id = ? AND date IS NOT NULL`).run(tripId);
    }
    const needed = 7 - datelessExisting.length;
    if (needed > 0) {
      const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, NULL)');
      for (let i = 0; i < needed; i++) insert.run(tripId, datelessExisting.length + i + 1);
    } else if (needed < 0) {
      const toRemove = datelessExisting.slice(7);
      const del = db.prepare('DELETE FROM days WHERE id = ?');
      for (const d of toRemove) del.run(d.id);
    }
    const remaining = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(tripId) as { id: number }[];
    const tmpUpd = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
    remaining.forEach((d, i) => tmpUpd.run(-(i + 1), d.id));
    remaining.forEach((d, i) => tmpUpd.run(i + 1, d.id));
    return;
  }

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  const numDays = Math.min(Math.floor((endMs - startMs) / MS_PER_DAY) + 1, MAX_TRIP_DAYS);

  const targetDates: string[] = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startMs + i * MS_PER_DAY);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    targetDates.push(`${yyyy}-${mm}-${dd}`);
  }

  const existingByDate = new Map<string, { id: number; day_number: number; date: string | null }>();
  for (const d of existing) {
    if (d.date) existingByDate.set(d.date, d);
  }

  const targetDateSet = new Set(targetDates);

  const toDelete = existing.filter(d => d.date && !targetDateSet.has(d.date));
  const datelessToDelete = existing.filter(d => !d.date);
  const del = db.prepare('DELETE FROM days WHERE id = ?');
  for (const d of [...toDelete, ...datelessToDelete]) del.run(d.id);

  const setTemp = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
  const kept = existing.filter(d => d.date && targetDateSet.has(d.date));
  for (let i = 0; i < kept.length; i++) setTemp.run(-(i + 1), kept[i].id);

  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');

  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    const ex = existingByDate.get(date);
    if (ex) {
      update.run(i + 1, ex.id);
    } else {
      insert.run(tripId, i + 1, date);
    }
  }
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const archived = req.query.archived === '1' ? 1 : 0;
  const userId = authReq.user.id;
  const trips = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = :archived
    ORDER BY t.created_at DESC
  `).all({ userId, archived });
  res.json({ trips });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { title, description, start_date, end_date, currency } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(authReq.user.id, title, description || null, start_date || null, end_date || null, currency || 'EUR');

  const tripId = result.lastInsertRowid;
  generateDays(tripId, start_date, end_date);
  const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId });
  res.status(201).json({ trip });
});

router.get('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;
  const trip = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
  `).get({ userId, tripId: req.params.id });
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  res.json({ trip });
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const ownerOnly = req.body.is_archived !== undefined || req.body.cover_image !== undefined;
  if (ownerOnly && !isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can change this setting' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { title, description, start_date, end_date, currency, is_archived, cover_image } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, req.params.id);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id'] as string);
});

router.post('/:id/cover', authenticate, demoUploadBlock, uploadCover.single('cover'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can change the cover image' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  if (trip.cover_image) {
    const oldPath = path.join(__dirname, '../../', trip.cover_image.replace(/^\//, ''));
    const resolvedPath = path.resolve(oldPath);
    const uploadsDir = path.resolve(__dirname, '../../uploads');
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  }

  const coverUrl = `/uploads/covers/${req.file.filename}`;
  db.prepare('UPDATE trips SET cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(coverUrl, req.params.id);
  res.json({ cover_image: coverUrl });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can delete the trip' });
  const deletedTripId = Number(req.params.id);
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
  broadcast(deletedTripId, 'trip:deleted', { id: deletedTripId }, req.headers['x-socket-id'] as string);
});

router.get('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number };
  const members = db.prepare(`
    SELECT u.id, u.username, u.email, u.avatar,
      CASE WHEN u.id = ? THEN 'owner' ELSE 'member' END as role,
      m.added_at,
      ib.username as invited_by_username
    FROM trip_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users ib ON ib.id = m.invited_by
    WHERE m.trip_id = ?
    ORDER BY m.added_at ASC
  `).all(trip.user_id, req.params.id) as { id: number; username: string; email: string; avatar: string | null; role: string; added_at: string; invited_by_username: string | null }[];

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(trip.user_id) as Pick<User, 'id' | 'username' | 'email' | 'avatar'>;

  res.json({
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
    current_user_id: authReq.user.id,
  });
});

router.post('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Email or username required' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim()) as Pick<User, 'id' | 'username' | 'email' | 'avatar'> | undefined;

  if (!target) return res.status(404).json({ error: 'User not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number };
  if (target.id === trip.user_id)
    return res.status(400).json({ error: 'Trip owner is already a member' });

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(req.params.id, target.id);
  if (existing) return res.status(400).json({ error: 'User already has access' });

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(req.params.id, target.id, authReq.user.id);

  res.status(201).json({ member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null } });
});

router.delete('/:id/members/:userId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const targetId = parseInt(req.params.userId);
  const isSelf = targetId === authReq.user.id;
  if (!isSelf && !isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

// GET /:id/context — full trip state in one call (for MCP)
router.get('/:id/context', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { id } = req.params;
  if (!canAccessTrip(id, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(id);
  const places = db.prepare(
    `SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
     FROM places p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.trip_id = ? ORDER BY p.id`
  ).all(id);
  const assignments = db.prepare(
    `SELECT da.*, d.day_number FROM day_assignments da
     JOIN days d ON d.id = da.day_id WHERE d.trip_id = ? ORDER BY d.day_number, da.order_index`
  ).all(id);
  const packing = db.prepare('SELECT * FROM packing_items WHERE trip_id = ? ORDER BY category, sort_order').all(id);
  const budget = db.prepare('SELECT * FROM budget_items WHERE trip_id = ? ORDER BY sort_order').all(id);
  const members = db.prepare(
    `SELECT u.id, u.username, u.email, u.avatar FROM trip_members tm
     JOIN users u ON u.id = tm.user_id WHERE tm.trip_id = ?`
  ).all(id);

  res.json({ trip, days, places, assignments, packing, budget, members });
});

// POST /:id/duplicate — clone a trip with all days and places (no assignments)
router.post('/:id/duplicate', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { id } = req.params;
  if (!canAccessTrip(id, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const original = db.prepare('SELECT * FROM trips WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!original) return res.status(404).json({ error: 'Trip not found' });

  const newTitle = (req.body.title as string) || `${original.title} (copy)`;

  const tripResult = db.prepare(
    `INSERT INTO trips (user_id, title, description, start_date, end_date, currency, cover_image)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(authReq.user.id, newTitle, original.description, original.start_date, original.end_date, original.currency, original.cover_image);

  const newTripId = tripResult.lastInsertRowid;

  // Clone days
  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(id) as Array<Record<string, unknown>>;
  for (const day of days) {
    db.prepare('INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)').run(newTripId, day.day_number, day.date, day.notes, day.title);
  }

  // Clone places (unassigned)
  const places = db.prepare('SELECT * FROM places WHERE trip_id = ?').all(id) as Array<Record<string, unknown>>;
  for (const p of places) {
    db.prepare(
      `INSERT INTO places (trip_id, name, lat, lng, address, category_id, price, currency, notes, image_url, website, phone, transport_mode, duration_minutes, place_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newTripId, p.name, p.lat, p.lng, p.address, p.category_id, p.price, p.currency, p.notes, p.image_url, p.website, p.phone, p.transport_mode, p.duration_minutes, p.place_time, p.end_time);
  }

  const newTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(newTripId);
  res.status(201).json({ trip: newTrip });
});

export default router;
