import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, Trip, User } from '../types';
import { writeAudit, getClientIp, logInfo } from '../services/auditLog';
import { checkPermission } from '../services/permissions';

const router = express.Router();

const MS_PER_DAY = 86400000;
const MAX_TRIP_DAYS = 365;
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
  if (!checkPermission('trip_create', authReq.user.role, null, authReq.user.id, false))
    return res.status(403).json({ error: 'No permission to create trips' });
  const { title, description, start_date, end_date, currency, reminder_days } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const rd = reminder_days !== undefined ? (Number(reminder_days) >= 0 && Number(reminder_days) <= 30 ? Number(reminder_days) : 3) : 3;

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency, reminder_days)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(authReq.user.id, title, description || null, start_date || null, end_date || null, currency || 'EUR', rd);

  const tripId = result.lastInsertRowid;
  generateDays(tripId, start_date, end_date);
  writeAudit({ userId: authReq.user.id, action: 'trip.create', ip: getClientIp(req), details: { tripId: Number(tripId), title, reminder_days: rd === 0 ? 'none' : `${rd} days` } });
  if (rd > 0) {
    logInfo(`${authReq.user.email} set ${rd}-day reminder for trip "${title}"`);
  }
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

  const tripOwnerId = access.user_id;
  const isMember = access.user_id !== authReq.user.id;

  // Archive check
  if (req.body.is_archived !== undefined) {
    if (!checkPermission('trip_archive', authReq.user.role, tripOwnerId, authReq.user.id, isMember))
      return res.status(403).json({ error: 'No permission to archive/unarchive this trip' });
  }
  // Cover image check
  if (req.body.cover_image !== undefined) {
    if (!checkPermission('trip_cover_upload', authReq.user.role, tripOwnerId, authReq.user.id, isMember))
      return res.status(403).json({ error: 'No permission to change cover image' });
  }
  // General edit check (title, description, dates, currency, reminder_days)
  const editFields = ['title', 'description', 'start_date', 'end_date', 'currency', 'reminder_days'];
  if (editFields.some(f => req.body[f] !== undefined)) {
    if (!checkPermission('trip_edit', authReq.user.role, tripOwnerId, authReq.user.id, isMember))
      return res.status(403).json({ error: 'No permission to edit this trip' });
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { title, description, start_date, end_date, currency, is_archived, cover_image, reminder_days } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;
  const newReminder = reminder_days !== undefined ? (Number(reminder_days) >= 0 && Number(reminder_days) <= 30 ? Number(reminder_days) : (trip as any).reminder_days) : (trip as any).reminder_days;

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, reminder_days=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, newReminder, req.params.id);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const changes: Record<string, unknown> = {};
  if (title && title !== trip.title) changes.title = title;
  if (newStart !== trip.start_date) changes.start_date = newStart;
  if (newEnd !== trip.end_date) changes.end_date = newEnd;
  if (newReminder !== (trip as any).reminder_days) changes.reminder_days = newReminder === 0 ? 'none' : `${newReminder} days`;
  if (is_archived !== undefined && newArchived !== trip.is_archived) changes.archived = !!newArchived;

  const isAdminEdit = authReq.user.role === 'admin' && trip.user_id !== authReq.user.id;
  if (Object.keys(changes).length > 0) {
    const ownerEmail = isAdminEdit ? (db.prepare('SELECT email FROM users WHERE id = ?').get(trip.user_id) as { email: string } | undefined)?.email : undefined;
    writeAudit({ userId: authReq.user.id, action: 'trip.update', ip: getClientIp(req), details: { tripId: Number(req.params.id), trip: newTitle, ...(ownerEmail ? { owner: ownerEmail } : {}), ...changes } });
    if (isAdminEdit && ownerEmail) {
      logInfo(`Admin ${authReq.user.email} edited trip "${newTitle}" owned by ${ownerEmail}`);
    }
  }

  if (newReminder !== (trip as any).reminder_days) {
    if (newReminder > 0) {
      logInfo(`${authReq.user.email} set ${newReminder}-day reminder for trip "${newTitle}"`);
    } else {
      logInfo(`${authReq.user.email} removed reminder for trip "${newTitle}"`);
    }
  }

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id'] as string);
});

router.post('/:id/cover', authenticate, demoUploadBlock, uploadCover.single('cover'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  const tripOwnerId = access?.user_id;
  if (!tripOwnerId) return res.status(404).json({ error: 'Trip not found' });
  const isMember = tripOwnerId !== authReq.user.id;
  if (!checkPermission('trip_cover_upload', authReq.user.role, tripOwnerId, authReq.user.id, isMember))
    return res.status(403).json({ error: 'No permission to change the cover image' });

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
  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number } | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const tripOwnerId = trip.user_id;
  const isMemberDel = tripOwnerId !== authReq.user.id;
  if (!checkPermission('trip_delete', authReq.user.role, tripOwnerId, authReq.user.id, isMemberDel))
    return res.status(403).json({ error: 'No permission to delete this trip' });
  const deletedTripId = Number(req.params.id);
  const delTrip = db.prepare('SELECT title, user_id FROM trips WHERE id = ?').get(req.params.id) as { title: string; user_id: number } | undefined;
  const isAdminDel = authReq.user.role === 'admin' && delTrip && delTrip.user_id !== authReq.user.id;
  const ownerEmail = isAdminDel ? (db.prepare('SELECT email FROM users WHERE id = ?').get(delTrip!.user_id) as { email: string } | undefined)?.email : undefined;
  writeAudit({ userId: authReq.user.id, action: 'trip.delete', ip: getClientIp(req), details: { tripId: deletedTripId, trip: delTrip?.title, ...(ownerEmail ? { owner: ownerEmail } : {}) } });
  if (isAdminDel && ownerEmail) {
    logInfo(`Admin ${authReq.user.email} deleted trip "${delTrip!.title}" owned by ${ownerEmail}`);
  }
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
  broadcast(deletedTripId, 'trip:deleted', { id: deletedTripId }, req.headers['x-socket-id'] as string);
});

router.get('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access)
    return res.status(404).json({ error: 'Trip not found' });

  const tripOwnerId = access.user_id;
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
  `).all(tripOwnerId, req.params.id) as { id: number; username: string; email: string; avatar: string | null; role: string; added_at: string; invited_by_username: string | null }[];

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(tripOwnerId) as Pick<User, 'id' | 'username' | 'email' | 'avatar'>;

  res.json({
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
    current_user_id: authReq.user.id,
  });
});

router.post('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access)
    return res.status(404).json({ error: 'Trip not found' });

  const tripOwnerId = access.user_id;
  const isMember = tripOwnerId !== authReq.user.id;
  if (!checkPermission('member_manage', authReq.user.role, tripOwnerId, authReq.user.id, isMember))
    return res.status(403).json({ error: 'No permission to manage members' });

  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Email or username required' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim()) as Pick<User, 'id' | 'username' | 'email' | 'avatar'> | undefined;

  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.id === tripOwnerId)
    return res.status(400).json({ error: 'Trip owner is already a member' });

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(req.params.id, target.id);
  if (existing) return res.status(400).json({ error: 'User already has access' });

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(req.params.id, target.id, authReq.user.id);

  // Notify invited user
  const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(req.params.id) as { title: string } | undefined;
  import('../services/notifications').then(({ notify }) => {
    notify({ userId: target.id, event: 'trip_invite', params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, invitee: target.email } }).catch(() => {});
  });

  res.status(201).json({ member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null } });
});

router.delete('/:id/members/:userId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const targetId = parseInt(req.params.userId);
  const isSelf = targetId === authReq.user.id;
  if (!isSelf) {
    const access = canAccessTrip(req.params.id, authReq.user.id);
    if (!access) return res.status(404).json({ error: 'Trip not found' });
    const memberCheck = access.user_id !== authReq.user.id;
    if (!checkPermission('member_manage', authReq.user.role, access.user_id, authReq.user.id, memberCheck))
      return res.status(403).json({ error: 'No permission to remove members' });
  }

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

// ICS calendar export
router.get('/:id/export.ics', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as any;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(req.params.id) as any[];
  const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ?').all(req.params.id) as any[];

  const esc = (s: string) => s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
    .replace(/\r/g, '');
  const fmtDate = (d: string) => d.replace(/-/g, '');
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const uid = (id: number, type: string) => `trek-${type}-${id}@trek`;

  // Format datetime: handles full ISO "2026-03-30T09:00" and time-only "10:00"
  const fmtDateTime = (d: string, refDate?: string) => {
    if (d.includes('T')) return d.replace(/[-:]/g, '').split('.')[0];
    // Time-only: combine with reference date
    if (refDate && d.match(/^\d{2}:\d{2}/)) {
      const datePart = refDate.split('T')[0];
      return `${datePart}T${d.replace(/:/g, '')}00`.replace(/-/g, '');
    }
    return d.replace(/[-:]/g, '');
  };

  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TREK//Travel Planner//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n';
  ics += `X-WR-CALNAME:${esc(trip.title || 'TREK Trip')}\r\n`;

  // Trip as all-day event
  if (trip.start_date && trip.end_date) {
    const endNext = new Date(trip.end_date + 'T00:00:00');
    endNext.setDate(endNext.getDate() + 1);
    const endStr = endNext.toISOString().split('T')[0].replace(/-/g, '');
    ics += `BEGIN:VEVENT\r\nUID:${uid(trip.id, 'trip')}\r\nDTSTAMP:${now}\r\nDTSTART;VALUE=DATE:${fmtDate(trip.start_date)}\r\nDTEND;VALUE=DATE:${endStr}\r\nSUMMARY:${esc(trip.title || 'Trip')}\r\n`;
    if (trip.description) ics += `DESCRIPTION:${esc(trip.description)}\r\n`;
    ics += `END:VEVENT\r\n`;
  }

  // Reservations as events
  for (const r of reservations) {
    if (!r.reservation_time) continue;
    const hasTime = r.reservation_time.includes('T');
    const meta = r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : {};

    ics += `BEGIN:VEVENT\r\nUID:${uid(r.id, 'res')}\r\nDTSTAMP:${now}\r\n`;
    if (hasTime) {
      ics += `DTSTART:${fmtDateTime(r.reservation_time)}\r\n`;
      if (r.reservation_end_time) {
        const endDt = fmtDateTime(r.reservation_end_time, r.reservation_time);
        if (endDt.length >= 15) ics += `DTEND:${endDt}\r\n`;
      }
    } else {
      ics += `DTSTART;VALUE=DATE:${fmtDate(r.reservation_time)}\r\n`;
    }
    ics += `SUMMARY:${esc(r.title)}\r\n`;

    let desc = r.type ? `Type: ${r.type}` : '';
    if (r.confirmation_number) desc += `\nConfirmation: ${r.confirmation_number}`;
    if (meta.airline) desc += `\nAirline: ${meta.airline}`;
    if (meta.flight_number) desc += `\nFlight: ${meta.flight_number}`;
    if (meta.departure_airport) desc += `\nFrom: ${meta.departure_airport}`;
    if (meta.arrival_airport) desc += `\nTo: ${meta.arrival_airport}`;
    if (meta.train_number) desc += `\nTrain: ${meta.train_number}`;
    if (r.notes) desc += `\n${r.notes}`;
    if (desc) ics += `DESCRIPTION:${esc(desc)}\r\n`;
    if (r.location) ics += `LOCATION:${esc(r.location)}\r\n`;
    ics += `END:VEVENT\r\n`;
  }

  ics += 'END:VCALENDAR\r\n';

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  const safeFilename = (trip.title || 'trek-trip').replace(/["\r\n]/g, '').replace(/[^\w\s.-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.ics"`);
  res.send(ics);
});

export default router;
