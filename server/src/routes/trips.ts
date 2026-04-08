import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip, isOwner } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, Trip, User } from '../types';
import { parseNullableNumber, syncTripLegsToDayCount } from './legs';
import { checkPermission } from '../services/permissions';

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

function getTripPermissionContext(tripId: string | number, userId: number) {
  return db.prepare(`
    SELECT t.user_id,
      CASE WHEN EXISTS(SELECT 1 FROM trip_members WHERE trip_id = t.id AND user_id = ?) THEN 1 ELSE 0 END AS is_member
    FROM trips t
    WHERE t.id = ?
  `).get(userId, tripId) as { user_id: number; is_member: number } | undefined;
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
  const {
    title, description, start_date, end_date, currency,
    destination_name, destination_address,
    destination_lat, destination_lng,
    destination_viewport_south, destination_viewport_west,
    destination_viewport_north, destination_viewport_east,
  } = req.body;
  if (!checkPermission('trip_create', authReq.user.role, null, authReq.user.id, false)) {
    return res.status(403).json({ error: 'No permission' });
  }

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  let resolvedStartDate = start_date || null;
  let resolvedEndDate = end_date || null;
  if (!resolvedStartDate && !resolvedEndDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const end = new Date(tomorrow);
    end.setDate(end.getDate() + 7);
    resolvedStartDate = tomorrow.toISOString().slice(0, 10);
    resolvedEndDate = end.toISOString().slice(0, 10);
  }

  const result = db.prepare(`
    INSERT INTO trips (
      user_id, title, description,
      destination_name, destination_address, destination_lat, destination_lng,
      destination_viewport_south, destination_viewport_west, destination_viewport_north, destination_viewport_east,
      start_date, end_date, currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    authReq.user.id, title, description || null,
    destination_name || null, destination_address || null,
    parseNullableNumber(destination_lat) ?? null, parseNullableNumber(destination_lng) ?? null,
    parseNullableNumber(destination_viewport_south) ?? null, parseNullableNumber(destination_viewport_west) ?? null,
    parseNullableNumber(destination_viewport_north) ?? null, parseNullableNumber(destination_viewport_east) ?? null,
    resolvedStartDate, resolvedEndDate, currency || 'EUR'
  );

  const tripId = result.lastInsertRowid;
  generateDays(tripId, resolvedStartDate, resolvedEndDate);
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
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const context = getTripPermissionContext(req.params.id, authReq.user.id);
  const isMember = !!context?.is_member && context?.user_id !== authReq.user.id;

  const actionKey = req.body.is_archived !== undefined || req.body.cover_image !== undefined
    ? 'trip_archive'
    : 'trip_edit';
  if (!checkPermission(actionKey, authReq.user.role, trip.user_id, authReq.user.id, isMember)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const {
    title, description, start_date, end_date, currency, is_archived, cover_image,
    destination_name, destination_address,
    destination_lat, destination_lng,
    destination_viewport_south, destination_viewport_west,
    destination_viewport_north, destination_viewport_east,
  } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newDestName = destination_name !== undefined ? (destination_name || null) : trip.destination_name;
  const newDestAddr = destination_address !== undefined ? (destination_address || null) : trip.destination_address;
  const newDestLat = destination_lat !== undefined ? parseNullableNumber(destination_lat) ?? null : trip.destination_lat;
  const newDestLng = destination_lng !== undefined ? parseNullableNumber(destination_lng) ?? null : trip.destination_lng;
  const newDestSouth = destination_viewport_south !== undefined ? parseNullableNumber(destination_viewport_south) ?? null : trip.destination_viewport_south;
  const newDestWest = destination_viewport_west !== undefined ? parseNullableNumber(destination_viewport_west) ?? null : trip.destination_viewport_west;
  const newDestNorth = destination_viewport_north !== undefined ? parseNullableNumber(destination_viewport_north) ?? null : trip.destination_viewport_north;
  const newDestEast = destination_viewport_east !== undefined ? parseNullableNumber(destination_viewport_east) ?? null : trip.destination_viewport_east;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;

  db.prepare(`
    UPDATE trips SET title=?, description=?, destination_name=?, destination_address=?,
      destination_lat=?, destination_lng=?, destination_viewport_south=?, destination_viewport_west=?,
      destination_viewport_north=?, destination_viewport_east=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    newTitle, newDesc, newDestName, newDestAddr,
    newDestLat, newDestLng, newDestSouth, newDestWest,
    newDestNorth, newDestEast, newStart || null, newEnd || null,
    newCurrency, newArchived, newCover, req.params.id
  );

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const legs = syncTripLegsToDayCount(req.params.id);
  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip, legs });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip, legs }, req.headers['x-socket-id'] as string);
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

// ── Copy / duplicate a trip ──────────────────────────────────────────────────
router.post('/:id/copy', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const src = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!src) return res.status(404).json({ error: 'Trip not found' });

  const title = req.body.title || src.title;

  const copyTrip = db.transaction(() => {
    // 1. Create new trip
    const tripResult = db.prepare(`
      INSERT INTO trips (user_id, title, description, start_date, end_date, currency, cover_image, is_archived, reminder_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(authReq.user.id, title, src.description, src.start_date, src.end_date, src.currency, src.cover_image, src.reminder_days ?? 3);
    const newTripId = tripResult.lastInsertRowid;

    // 2. Copy days → build ID map
    const oldDays = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(req.params.id) as any[];
    const dayMap = new Map<number, number | bigint>();
    const insertDay = db.prepare('INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)');
    for (const d of oldDays) {
      const r = insertDay.run(newTripId, d.day_number, d.date, d.notes, d.title);
      dayMap.set(d.id, r.lastInsertRowid);
    }

    // 3. Copy places → build ID map
    const oldPlaces = db.prepare('SELECT * FROM places WHERE trip_id = ?').all(req.params.id) as any[];
    const placeMap = new Map<number, number | bigint>();
    const insertPlace = db.prepare(`
      INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, price, currency,
        reservation_status, reservation_notes, reservation_datetime, place_time, end_time,
        duration_minutes, notes, image_url, google_place_id, website, phone, transport_mode, osm_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of oldPlaces) {
      const r = insertPlace.run(newTripId, p.name, p.description, p.lat, p.lng, p.address, p.category_id,
        p.price, p.currency, p.reservation_status, p.reservation_notes, p.reservation_datetime,
        p.place_time, p.end_time, p.duration_minutes, p.notes, p.image_url, p.google_place_id,
        p.website, p.phone, p.transport_mode, p.osm_id);
      placeMap.set(p.id, r.lastInsertRowid);
    }

    // 4. Copy place_tags
    const oldTags = db.prepare(`
      SELECT pt.* FROM place_tags pt JOIN places p ON p.id = pt.place_id WHERE p.trip_id = ?
    `).all(req.params.id) as any[];
    const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
    for (const t of oldTags) {
      const newPlaceId = placeMap.get(t.place_id);
      if (newPlaceId) insertTag.run(newPlaceId, t.tag_id);
    }

    // 5. Copy day_assignments → build ID map
    const oldAssignments = db.prepare(`
      SELECT da.* FROM day_assignments da JOIN days d ON d.id = da.day_id WHERE d.trip_id = ?
    `).all(req.params.id) as any[];
    const assignmentMap = new Map<number, number | bigint>();
    const insertAssignment = db.prepare(`
      INSERT INTO day_assignments (day_id, place_id, order_index, notes, reservation_status, reservation_notes, reservation_datetime, assignment_time, assignment_end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of oldAssignments) {
      const newDayId = dayMap.get(a.day_id);
      const newPlaceId = placeMap.get(a.place_id);
      if (newDayId && newPlaceId) {
        const r = insertAssignment.run(newDayId, newPlaceId, a.order_index, a.notes,
          a.reservation_status, a.reservation_notes, a.reservation_datetime,
          a.assignment_time, a.assignment_end_time);
        assignmentMap.set(a.id, r.lastInsertRowid);
      }
    }

    // 6. Copy day_accommodations → build ID map
    const oldAccom = db.prepare('SELECT * FROM day_accommodations WHERE trip_id = ?').all(req.params.id) as any[];
    const accomMap = new Map<number, number | bigint>();
    const insertAccom = db.prepare(`
      INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of oldAccom) {
      const newPlaceId = placeMap.get(a.place_id);
      const newStartDay = dayMap.get(a.start_day_id);
      const newEndDay = dayMap.get(a.end_day_id);
      if (newPlaceId && newStartDay && newEndDay) {
        const r = insertAccom.run(newTripId, newPlaceId, newStartDay, newEndDay, a.check_in, a.check_out, a.confirmation, a.notes);
        accomMap.set(a.id, r.lastInsertRowid);
      }
    }

    // 7. Copy reservations
    const oldReservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ?').all(req.params.id) as any[];
    const insertReservation = db.prepare(`
      INSERT INTO reservations (trip_id, day_id, place_id, assignment_id, accommodation_id, title, reservation_time, reservation_end_time,
        location, confirmation_number, notes, status, type, metadata, day_plan_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of oldReservations) {
      insertReservation.run(newTripId,
        r.day_id ? (dayMap.get(r.day_id) ?? null) : null,
        r.place_id ? (placeMap.get(r.place_id) ?? null) : null,
        r.assignment_id ? (assignmentMap.get(r.assignment_id) ?? null) : null,
        r.accommodation_id ? (accomMap.get(r.accommodation_id) ?? null) : null,
        r.title, r.reservation_time, r.reservation_end_time,
        r.location, r.confirmation_number, r.notes, r.status, r.type,
        r.metadata, r.day_plan_position);
    }

    // 8. Copy budget_items (paid_by_user_id reset to null)
    const oldBudget = db.prepare('SELECT * FROM budget_items WHERE trip_id = ?').all(req.params.id) as any[];
    const insertBudget = db.prepare(`
      INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of oldBudget) {
      insertBudget.run(newTripId, b.category, b.name, b.total_price, b.persons, b.days, b.note, b.sort_order);
    }

    // 9. Copy packing_bags → build ID map
    const oldBags = db.prepare('SELECT * FROM packing_bags WHERE trip_id = ?').all(req.params.id) as any[];
    const bagMap = new Map<number, number | bigint>();
    const insertBag = db.prepare('INSERT INTO packing_bags (trip_id, name, color, weight_limit_grams, sort_order) VALUES (?, ?, ?, ?, ?)');
    for (const bag of oldBags) {
      const r = insertBag.run(newTripId, bag.name, bag.color, bag.weight_limit_grams, bag.sort_order);
      bagMap.set(bag.id, r.lastInsertRowid);
    }

    // 10. Copy packing_items (checked reset to 0)
    const oldPacking = db.prepare('SELECT * FROM packing_items WHERE trip_id = ?').all(req.params.id) as any[];
    const insertPacking = db.prepare(`
      INSERT INTO packing_items (trip_id, name, checked, category, sort_order, weight_grams, bag_id)
      VALUES (?, ?, 0, ?, ?, ?, ?)
    `);
    for (const p of oldPacking) {
      insertPacking.run(newTripId, p.name, p.category, p.sort_order, p.weight_grams,
        p.bag_id ? (bagMap.get(p.bag_id) ?? null) : null);
    }

    // 11. Copy day_notes
    const oldNotes = db.prepare('SELECT * FROM day_notes WHERE trip_id = ?').all(req.params.id) as any[];
    const insertNote = db.prepare(`
      INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const n of oldNotes) {
      const newDayId = dayMap.get(n.day_id);
      if (newDayId) insertNote.run(newDayId, newTripId, n.text, n.time, n.icon, n.sort_order);
    }

    return newTripId;
  });

  try {
    const newTripId = copyTrip();
    const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: newTripId });
    res.status(201).json({ trip });
  } catch {
    return res.status(500).json({ error: 'Failed to copy trip' });
  }
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const context = getTripPermissionContext(req.params.id, authReq.user.id);
  const isMember = !!context?.is_member && trip.user_id !== authReq.user.id;
  if (!checkPermission('trip_delete', authReq.user.role, trip.user_id, authReq.user.id, isMember)) {
    return res.status(403).json({ error: 'No permission' });
  }
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

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number } | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const context = getTripPermissionContext(req.params.id, authReq.user.id);
  const isMember = !!context?.is_member && trip.user_id !== authReq.user.id;
  if (!checkPermission('member_manage', authReq.user.role, trip.user_id, authReq.user.id, isMember)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Email or username required' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim()) as Pick<User, 'id' | 'username' | 'email' | 'avatar'> | undefined;

  if (!target) return res.status(404).json({ error: 'User not found' });

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
  if (!isSelf) {
    const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number } | undefined;
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const context = getTripPermissionContext(req.params.id, authReq.user.id);
    const isMember = !!context?.is_member && trip.user_id !== authReq.user.id;
    if (!checkPermission('member_manage', authReq.user.role, trip.user_id, authReq.user.id, isMember)) {
      return res.status(403).json({ error: 'No permission' });
    }
  }

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

export default router;
