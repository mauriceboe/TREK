import path from 'path';
import fs from 'fs';
import { db, canAccessTrip, isOwner } from '../db/database';
import { Trip, User } from '../types';

export const MS_PER_DAY = 86400000;
export const MAX_TRIP_DAYS = 365;

export const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

// ── Access helpers ────────────────────────────────────────────────────────

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

export { isOwner };

// ── Day generation ────────────────────────────────────────────────────────

export function generateDays(tripId: number | bigint | string, startDate: string | null, endDate: string | null) {
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

// ── Trip CRUD ─────────────────────────────────────────────────────────────

export function listTrips(userId: number, archived: number) {
  return db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = :archived
    ORDER BY t.created_at DESC
  `).all({ userId, archived });
}

interface CreateTripData {
  title: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  currency?: string;
  reminder_days?: number;
}

export function createTrip(userId: number, data: CreateTripData) {
  const rd = data.reminder_days !== undefined
    ? (Number(data.reminder_days) >= 0 && Number(data.reminder_days) <= 30 ? Number(data.reminder_days) : 3)
    : 3;

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency, reminder_days)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.title, data.description || null, data.start_date || null, data.end_date || null, data.currency || 'EUR', rd);

  const tripId = result.lastInsertRowid;
  generateDays(tripId, data.start_date || null, data.end_date || null);

  const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId, tripId });
  return { trip, tripId: Number(tripId), reminderDays: rd };
}

export function getTrip(tripId: string | number, userId: number) {
  return db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
  `).get({ userId, tripId });
}

interface UpdateTripData {
  title?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  currency?: string;
  is_archived?: boolean | number;
  cover_image?: string;
  reminder_days?: number;
}

export interface UpdateTripResult {
  updatedTrip: any;
  changes: Record<string, unknown>;
  isAdminEdit: boolean;
  ownerEmail?: string;
  newTitle: string;
  newReminder: number;
  oldReminder: number;
}

export function updateTrip(tripId: string | number, userId: number, data: UpdateTripData, userRole: string): UpdateTripResult {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Trip & { reminder_days?: number } | undefined;
  if (!trip) throw new NotFoundError('Trip not found');

  const { title, description, start_date, end_date, currency, is_archived, cover_image, reminder_days } = data;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    throw new ValidationError('End date must be after start date');

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;
  const oldReminder = (trip as any).reminder_days ?? 3;
  const newReminder = reminder_days !== undefined
    ? (Number(reminder_days) >= 0 && Number(reminder_days) <= 30 ? Number(reminder_days) : oldReminder)
    : oldReminder;

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, reminder_days=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, newReminder, tripId);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(tripId, newStart || null, newEnd || null);

  const changes: Record<string, unknown> = {};
  if (title && title !== trip.title) changes.title = title;
  if (newStart !== trip.start_date) changes.start_date = newStart;
  if (newEnd !== trip.end_date) changes.end_date = newEnd;
  if (newReminder !== oldReminder) changes.reminder_days = newReminder === 0 ? 'none' : `${newReminder} days`;
  if (is_archived !== undefined && newArchived !== trip.is_archived) changes.archived = !!newArchived;

  const isAdminEdit = userRole === 'admin' && trip.user_id !== userId;
  let ownerEmail: string | undefined;
  if (Object.keys(changes).length > 0 && isAdminEdit) {
    ownerEmail = (db.prepare('SELECT email FROM users WHERE id = ?').get(trip.user_id) as { email: string } | undefined)?.email;
  }

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId, tripId });

  return { updatedTrip, changes, isAdminEdit, ownerEmail, newTitle, newReminder, oldReminder };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export interface DeleteTripInfo {
  tripId: number;
  title: string;
  ownerId: number;
  isAdminDelete: boolean;
  ownerEmail?: string;
}

export function deleteTrip(tripId: string | number, userId: number, userRole: string): DeleteTripInfo {
  const trip = db.prepare('SELECT title, user_id FROM trips WHERE id = ?').get(tripId) as { title: string; user_id: number } | undefined;
  if (!trip) throw new NotFoundError('Trip not found');

  const isAdminDelete = userRole === 'admin' && trip.user_id !== userId;
  let ownerEmail: string | undefined;
  if (isAdminDelete) {
    ownerEmail = (db.prepare('SELECT email FROM users WHERE id = ?').get(trip.user_id) as { email: string } | undefined)?.email;
  }

  db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);

  return { tripId: Number(tripId), title: trip.title, ownerId: trip.user_id, isAdminDelete, ownerEmail };
}

// ── Cover image ───────────────────────────────────────────────────────────

export function deleteOldCover(coverImage: string | null | undefined) {
  if (!coverImage) return;
  const oldPath = path.join(__dirname, '../../', coverImage.replace(/^\//, ''));
  const resolvedPath = path.resolve(oldPath);
  const uploadsDir = path.resolve(__dirname, '../../uploads');
  if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);
  }
}

export function updateCoverImage(tripId: string | number, coverUrl: string) {
  db.prepare('UPDATE trips SET cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(coverUrl, tripId);
}

export function getTripRaw(tripId: string | number): Trip | undefined {
  return db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Trip | undefined;
}

export function getTripOwner(tripId: string | number): { user_id: number } | undefined {
  return db.prepare('SELECT user_id FROM trips WHERE id = ?').get(tripId) as { user_id: number } | undefined;
}

// ── Members ───────────────────────────────────────────────────────────────

export function listMembers(tripId: string | number, tripOwnerId: number) {
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
  `).all(tripOwnerId, tripId) as { id: number; username: string; email: string; avatar: string | null; role: string; added_at: string; invited_by_username: string | null }[];

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(tripOwnerId) as Pick<User, 'id' | 'username' | 'email' | 'avatar'>;

  return {
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
  };
}

export interface AddMemberResult {
  member: { id: number; username: string; email: string; avatar?: string | null; role: string; avatar_url: string | null };
  targetUserId: number;
  tripTitle: string;
}

export function addMember(tripId: string | number, identifier: string, tripOwnerId: number, invitedByUserId: number): AddMemberResult {
  if (!identifier) throw new ValidationError('Email or username required');

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim()) as Pick<User, 'id' | 'username' | 'email' | 'avatar'> | undefined;

  if (!target) throw new NotFoundError('User not found');

  if (target.id === tripOwnerId)
    throw new ValidationError('Trip owner is already a member');

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(tripId, target.id);
  if (existing) throw new ValidationError('User already has access');

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(tripId, target.id, invitedByUserId);

  const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;

  return {
    member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null },
    targetUserId: target.id,
    tripTitle: tripInfo?.title || 'Untitled',
  };
}

export function removeMember(tripId: string | number, targetUserId: number) {
  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(tripId, targetUserId);
}

// ── ICS export ────────────────────────────────────────────────────────────

export function exportICS(tripId: string | number): { ics: string; filename: string } {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as any;
  if (!trip) throw new NotFoundError('Trip not found');

  const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ?').all(tripId) as any[];

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

  const safeFilename = (trip.title || 'trek-trip').replace(/["\r\n]/g, '').replace(/[^\w\s.-]/g, '_');
  return { ics, filename: `${safeFilename}.ics` };
}

// ── Custom error types ────────────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
