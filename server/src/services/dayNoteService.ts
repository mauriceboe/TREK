import { db, canAccessTrip } from '../db/database';
import { DayNote } from '../types';

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

export function listNotes(dayId: string | number, tripId: string | number) {
  return db.prepare(
    'SELECT * FROM day_notes WHERE day_id = ? AND trip_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(dayId, tripId);
}

export function dayExists(dayId: string | number, tripId: string | number) {
  return db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
}

export function createNote(dayId: string | number, tripId: string | number, text: string, time?: string, icon?: string, day_section?: string, sort_order?: number) {
  const result = db.prepare(
    'INSERT INTO day_notes (day_id, trip_id, text, time, icon, day_section, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(dayId, tripId, text.trim(), time || null, icon || '\uD83D\uDCDD', day_section ?? null, sort_order ?? 9999);
  return db.prepare('SELECT * FROM day_notes WHERE id = ?').get(result.lastInsertRowid);
}

export function getNote(id: string | number, dayId: string | number, tripId: string | number) {
  return db.prepare('SELECT * FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(id, dayId, tripId) as DayNote | undefined;
}

export function updateNote(id: string | number, current: DayNote, fields: { text?: string; time?: string; icon?: string; day_section?: string; sort_order?: number }) {
  db.prepare(
    'UPDATE day_notes SET text = ?, time = ?, icon = ?, day_section = ?, sort_order = ? WHERE id = ?'
  ).run(
    fields.text !== undefined ? fields.text.trim() : current.text,
    fields.time !== undefined ? fields.time : current.time,
    fields.icon !== undefined ? fields.icon : current.icon,
    fields.day_section !== undefined ? fields.day_section : (current.day_section ?? null),
    fields.sort_order !== undefined ? fields.sort_order : current.sort_order,
    id
  );
  return db.prepare('SELECT * FROM day_notes WHERE id = ?').get(id);
}

export function deleteNote(id: string | number) {
  db.prepare('DELETE FROM day_notes WHERE id = ?').run(id);
}
