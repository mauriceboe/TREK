import path from 'path';
import fs from 'fs';
import { db, canAccessTrip, isOwner } from '../db/database';
import { Trip, User } from '../types';
import { listDays, listAccommodations } from './dayService';
import { listBudgetItems } from './budgetService';
import { listItems as listPackingItems } from './packingService';
import { listReservations } from './reservationService';
import { listNotes as listCollabNotes } from './collabService';

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

export function generateDays(tripId: number | bigint | string, startDate: string | null, endDate: string | null, maxDays?: number, dayCount?: number) {
  const existing = db.prepare('SELECT id, day_number, date FROM days WHERE trip_id = ?').all(tripId) as { id: number; day_number: number; date: string | null }[];
  const setDayNumber = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');

  // Helper: two-phase renumber to avoid UNIQUE(trip_id, day_number) collisions
  function renumber(days: { id: number }[]) {
    days.forEach((d, i) => setDayNumber.run(-(i + 1), d.id));
    days.forEach((d, i) => setDayNumber.run(i + 1, d.id));
  }

  if (!startDate || !endDate) {
    // Nullify all dated days instead of deleting them — preserves assignments/notes/accommodations
    const withDates = existing.filter(d => d.date);
    if (withDates.length > 0) {
      const nullify = db.prepare('UPDATE days SET date = NULL WHERE id = ?');
      for (const d of withDates) nullify.run(d.id);
    }
    // Now all days are dateless — adjust count toward dayCount target
    const allDays = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(tripId) as { id: number }[];
    const targetCount = Math.min(Math.max(dayCount ?? (allDays.length || 7), 1), MAX_TRIP_DAYS);
    const needed = targetCount - allDays.length;
    if (needed > 0) {
      const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, NULL)');
      for (let i = 0; i < needed; i++) insert.run(tripId, allDays.length + i + 1);
    } else if (needed < 0) {
      // Only trim trailing empty days to avoid destroying content
      const candidates = db.prepare(
        `SELECT d.id FROM days d
         WHERE d.trip_id = ?
           AND NOT EXISTS (SELECT 1 FROM day_assignments da WHERE da.day_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM day_notes dn WHERE dn.day_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM day_accommodations dac WHERE dac.start_day_id = d.id OR dac.end_day_id = d.id)
         ORDER BY d.day_number DESC
         LIMIT ?`
      ).all(tripId, -needed) as { id: number }[];
      const del = db.prepare('DELETE FROM days WHERE id = ?');
      for (const d of candidates) del.run(d.id);
    }
    const remaining = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(tripId) as { id: number }[];
    renumber(remaining);
    return;
  }

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  const numDays = Math.min(Math.floor((endMs - startMs) / MS_PER_DAY) + 1, maxDays ?? MAX_TRIP_DAYS);

  const targetDates: string[] = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startMs + i * MS_PER_DAY);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    targetDates.push(`${yyyy}-${mm}-${dd}`);
  }

  // Split into dated (sorted by day_number = position) and dateless (spare pool)
  const dated = existing.filter(d => d.date).sort((a, b) => a.day_number - b.day_number);
  const dateless = existing.filter(d => !d.date).sort((a, b) => a.day_number - b.day_number);

  // Phase 1: stamp all existing days with negative day_numbers to free up slots
  const allExisting = [...dated, ...dateless];
  allExisting.forEach((d, i) => setDayNumber.run(-(i + 1), d.id));

  const assignDay = db.prepare('UPDATE days SET date = ?, day_number = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');

  let datelessIdx = 0;

  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    if (i < dated.length) {
      // Positional remap: existing dated day i gets new date — keeps all children
      assignDay.run(date, i + 1, dated[i].id);
    } else if (datelessIdx < dateless.length) {
      // Reuse a dateless day — keeps its assignments, notes, etc.
      assignDay.run(date, i + 1, dateless[datelessIdx].id);
      datelessIdx++;
    } else {
      insert.run(tripId, i + 1, date);
    }
  }

  // Overflow dated days (trip shrunk): convert to dateless instead of deleting
  const nullify = db.prepare('UPDATE days SET date = NULL, day_number = ? WHERE id = ?');
  for (let i = targetDates.length; i < dated.length; i++) {
    nullify.run(targetDates.length + (i - targetDates.length) + 1, dated[i].id);
  }

  // Any remaining unused dateless days: keep as dateless, just renumber.
  // Base must be max(targetDates.length, dated.length) to avoid colliding with
  // positives already assigned by the main loop or the overflow loop above.
  const maxAssigned = Math.max(targetDates.length, dated.length);
  for (let i = datelessIdx; i < dateless.length; i++) {
    setDayNumber.run(maxAssigned + (i - datelessIdx) + 1, dateless[i].id);
  }

  // Final renumber to compact and eliminate any gaps/negatives
  const remaining = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(tripId) as { id: number }[];
  renumber(remaining);
}

// ── Trip CRUD ─────────────────────────────────────────────────────────────

export function listTrips(userId: number, archived: number | null) {
  if (archived === null) {
    return db.prepare(`
      ${TRIP_SELECT}
      LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
      WHERE (t.user_id = :userId OR m.user_id IS NOT NULL)
      ORDER BY t.created_at DESC
    `).all({ userId });
  }
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
  day_count?: number;
}

export function createTrip(userId: number, data: CreateTripData, maxDays?: number) {
  const rd = data.reminder_days !== undefined
    ? (Number(data.reminder_days) >= 0 && Number(data.reminder_days) <= 30 ? Number(data.reminder_days) : 3)
    : 3;

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency, reminder_days)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.title, data.description || null, data.start_date || null, data.end_date || null, data.currency || 'EUR', rd);

  const tripId = result.lastInsertRowid;
  generateDays(tripId, data.start_date || null, data.end_date || null, maxDays, data.day_count);

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
  day_count?: number;
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

  const dayCount = data.day_count ? Math.min(Math.max(Number(data.day_count) || 7, 1), MAX_TRIP_DAYS) : undefined;
  if (newStart !== trip.start_date || newEnd !== trip.end_date || dayCount)
    generateDays(tripId, newStart || null, newEnd || null, undefined, dayCount);

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

  // Clean up journey entries synced from this trip before deleting
  // Delete skeleton entries (unfilled synced places)
  db.prepare(`
    DELETE FROM journey_entries
    WHERE source_trip_id = ? AND type = 'skeleton'
  `).run(tripId);
  // Detach filled entries (keep user's written content, just remove trip link)
  db.prepare(`
    UPDATE journey_entries SET source_trip_id = NULL, source_place_id = NULL
    WHERE source_trip_id = ?
  `).run(tripId);

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
  // iCal requires exactly YYYYMMDDTHHMMSS format
  const fmtDateTime = (d: string, refDate?: string) => {
    if (d.includes('T')) {
      const raw = d.replace(/[-:]/g, '').split('.')[0];
      // Pad to 15 chars (YYYYMMDDTHHMMSS) — add missing seconds
      return raw.length === 13 ? raw + '00' : raw;
    }
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

  // Days with assignments and notes
  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as any[];
  for (const day of days) {
    if (!day.date) continue;

    const assignments = db.prepare(`
      SELECT da.*, p.name as place_name, p.address as place_address,
        COALESCE(da.assignment_time, p.place_time) as effective_time,
        COALESCE(da.assignment_end_time, p.end_time) as effective_end_time
      FROM day_assignments da
      JOIN places p ON da.place_id = p.id
      WHERE da.day_id = ?
      ORDER BY da.order_index ASC, da.created_at ASC
    `).all(day.id) as any[];

    const notes = db.prepare(
      'SELECT * FROM day_notes WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(day.id) as any[];

    const timed = assignments.filter(a => a.effective_time);
    const untimed = assignments.filter(a => !a.effective_time);

    // Timed assignments → individual events
    for (const a of timed) {
      ics += `BEGIN:VEVENT\r\nUID:${uid(a.id, 'assign')}\r\nDTSTAMP:${now}\r\n`;
      ics += `DTSTART:${fmtDateTime(a.effective_time, day.date + 'T00:00')}\r\n`;
      if (a.effective_end_time) {
        ics += `DTEND:${fmtDateTime(a.effective_end_time, day.date + 'T00:00')}\r\n`;
      }
      ics += `SUMMARY:${esc(a.place_name)}\r\n`;
      let desc = '';
      if (a.notes) desc += a.notes;
      if (a.place_address) desc += (desc ? '\n' : '') + a.place_address;
      if (desc) ics += `DESCRIPTION:${esc(desc)}\r\n`;
      if (a.place_address) ics += `LOCATION:${esc(a.place_address)}\r\n`;
      ics += `END:VEVENT\r\n`;
    }

    // Build all-day summary event if there are untimed activities or notes
    if (untimed.length > 0 || notes.length > 0) {
      const dayTitle = day.title || `Day ${day.day_number}`;
      const endNext = new Date(day.date + 'T00:00:00');
      endNext.setDate(endNext.getDate() + 1);
      const endStr = endNext.toISOString().split('T')[0].replace(/-/g, '');

      ics += `BEGIN:VEVENT\r\nUID:${uid(day.id, 'day')}\r\nDTSTAMP:${now}\r\n`;
      ics += `DTSTART;VALUE=DATE:${fmtDate(day.date)}\r\nDTEND;VALUE=DATE:${endStr}\r\n`;
      ics += `SUMMARY:${esc(dayTitle)}\r\n`;

      let desc = '';
      if (untimed.length > 0) {
        desc += untimed.map(a => {
          let line = `• ${a.place_name}`;
          if (a.place_address) line += ` (${a.place_address})`;
          if (a.notes) line += ` — ${a.notes}`;
          return line;
        }).join('\n');
      }
      if (notes.length > 0) {
        if (desc) desc += '\n\n';
        desc += 'Notes:\n' + notes.map(n => {
          let line = n.time ? `${n.time} — ${n.text}` : `• ${n.text}`;
          return line;
        }).join('\n');
      }
      if (desc) ics += `DESCRIPTION:${esc(desc)}\r\n`;
      ics += `END:VEVENT\r\n`;
    }
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

// ── Copy / duplicate ─────────────────────────────────────────────────────

/**
 * Duplicates a trip (all days, places, assignments, accommodations, reservations,
 * budget, packing bags/items, day notes) into a new trip owned by `newOwnerId`.
 * Packing items are reset to unchecked. Budget paid status is cleared.
 * Returns the new trip's ID.
 */
export function copyTripById(sourceTripId: string | number, newOwnerId: number, title?: string): number {
  const src = db.prepare('SELECT * FROM trips WHERE id = ?').get(sourceTripId) as any;
  if (!src) throw new NotFoundError('Trip not found');

  const newTitle = title || src.title;

  const fn = db.transaction(() => {
    const tripResult = db.prepare(`
      INSERT INTO trips (user_id, title, description, start_date, end_date, currency, cover_image, is_archived, reminder_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(newOwnerId, newTitle, src.description, src.start_date, src.end_date, src.currency, src.cover_image, src.reminder_days ?? 3);
    const newTripId = tripResult.lastInsertRowid;

    const oldDays = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(sourceTripId) as any[];
    const dayMap = new Map<number, number | bigint>();
    const insertDay = db.prepare('INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)');
    for (const d of oldDays) {
      const r = insertDay.run(newTripId, d.day_number, d.date, d.notes, d.title);
      dayMap.set(d.id, r.lastInsertRowid);
    }

    const oldPlaces = db.prepare('SELECT * FROM places WHERE trip_id = ?').all(sourceTripId) as any[];
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

    const oldTags = db.prepare(`
      SELECT pt.* FROM place_tags pt JOIN places p ON p.id = pt.place_id WHERE p.trip_id = ?
    `).all(sourceTripId) as any[];
    const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
    for (const t of oldTags) {
      const newPlaceId = placeMap.get(t.place_id);
      if (newPlaceId) insertTag.run(newPlaceId, t.tag_id);
    }

    const oldAssignments = db.prepare(`
      SELECT da.* FROM day_assignments da JOIN days d ON d.id = da.day_id WHERE d.trip_id = ?
    `).all(sourceTripId) as any[];
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

    const oldAccom = db.prepare('SELECT * FROM day_accommodations WHERE trip_id = ?').all(sourceTripId) as any[];
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

    const oldReservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ?').all(sourceTripId) as any[];
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

    const oldBudget = db.prepare('SELECT * FROM budget_items WHERE trip_id = ?').all(sourceTripId) as any[];
    const insertBudget = db.prepare(`
      INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of oldBudget) {
      insertBudget.run(newTripId, b.category, b.name, b.total_price, b.persons, b.days, b.note, b.sort_order);
    }

    const oldBags = db.prepare('SELECT * FROM packing_bags WHERE trip_id = ?').all(sourceTripId) as any[];
    const bagMap = new Map<number, number | bigint>();
    const insertBag = db.prepare(`
      INSERT INTO packing_bags (trip_id, name, color, weight_limit_grams, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const bag of oldBags) {
      const r = insertBag.run(newTripId, bag.name, bag.color, bag.weight_limit_grams, bag.sort_order);
      bagMap.set(bag.id, r.lastInsertRowid);
    }

    const oldPacking = db.prepare('SELECT * FROM packing_items WHERE trip_id = ?').all(sourceTripId) as any[];
    const insertPacking = db.prepare(`
      INSERT INTO packing_items (trip_id, name, checked, category, sort_order, weight_grams, bag_id)
      VALUES (?, ?, 0, ?, ?, ?, ?)
    `);
    for (const p of oldPacking) {
      insertPacking.run(newTripId, p.name, p.category, p.sort_order, p.weight_grams,
        p.bag_id ? (bagMap.get(p.bag_id) ?? null) : null);
    }

    const oldNotes = db.prepare('SELECT * FROM day_notes WHERE trip_id = ?').all(sourceTripId) as any[];
    const insertNote = db.prepare(`
      INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const n of oldNotes) {
      const newDayId = dayMap.get(n.day_id);
      if (newDayId) insertNote.run(newDayId, newTripId, n.text, n.time, n.icon, n.sort_order);
    }

    const oldTodos = db.prepare('SELECT * FROM todo_items WHERE trip_id = ?').all(sourceTripId) as any[];
    const insertTodo = db.prepare(`
      INSERT INTO todo_items (trip_id, name, checked, category, sort_order, due_date, description, assigned_user_id, priority)
      VALUES (?, ?, 0, ?, ?, ?, ?, NULL, ?)
    `);
    for (const t of oldTodos) {
      insertTodo.run(newTripId, t.name, t.category, t.sort_order, t.due_date, t.description, t.priority);
    }

    const oldCategoryOrder = db.prepare('SELECT category, sort_order FROM budget_category_order WHERE trip_id = ?').all(sourceTripId) as any[];
    const insertCategoryOrder = db.prepare(`
      INSERT INTO budget_category_order (trip_id, category, sort_order)
      VALUES (?, ?, ?)
    `);
    for (const o of oldCategoryOrder) {
      insertCategoryOrder.run(newTripId, o.category, o.sort_order);
    }

    return Number(newTripId);
  });

  return fn();
}

// ── Trip summary (used by MCP get_trip_summary tool) ──────────────────────

export function getTripSummary(tripId: number) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Record<string, unknown> | undefined;
  if (!trip) return null;

  const ownerRow = getTripOwner(tripId);
  if (!ownerRow) return null;
  const { owner, members } = listMembers(tripId, ownerRow.user_id);

  const { days: rawDays } = listDays(tripId);
  const days = rawDays.map(({ notes_items, ...day }) => ({ ...day, notes: notes_items }));

  const accommodations = listAccommodations(tripId);

  const budgetItems = listBudgetItems(tripId);
  const budget = {
    items: budgetItems,
    item_count: budgetItems.length,
    total: budgetItems.reduce((sum, i) => sum + (i.total_price || 0), 0),
    currency: trip.currency,
  };

  const packingItems = listPackingItems(tripId);
  const packing = {
    items: packingItems,
    total: packingItems.length,
    checked: (packingItems as { checked: number }[]).filter(i => i.checked).length,
  };

  const reservations = listReservations(tripId);
  const collab_notes = listCollabNotes(tripId);

  return {
    trip,
    members: { owner, collaborators: members },
    days,
    accommodations,
    budget,
    packing,
    reservations,
    collab_notes,
  };
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
