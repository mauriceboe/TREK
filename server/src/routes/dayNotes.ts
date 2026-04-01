import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest, DayNote } from '../types';

const router = express.Router({ mergeParams: true });

function verifyAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  if (!verifyAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const notes = db.prepare(
    'SELECT * FROM day_notes WHERE day_id = ? AND trip_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(dayId, tripId);

  res.json({ notes });
});

router.post('/', authenticate, validateStringLengths({ text: 500, time: 150 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  const access = verifyAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
  if (!day) return res.status(404).json({ error: 'Day not found' });

  const { text, time, icon, sort_order } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });

  const result = db.prepare(
    'INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(dayId, tripId, text.trim(), time || null, icon || '\uD83D\uDCDD', sort_order ?? 9999);

  const note = db.prepare('SELECT * FROM day_notes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ note });
  broadcast(tripId, 'dayNote:created', { dayId: Number(dayId), note }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, validateStringLengths({ text: 500, time: 150 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = verifyAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const note = db.prepare('SELECT * FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(id, dayId, tripId) as DayNote | undefined;
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const { text, time, icon, sort_order } = req.body;
  db.prepare(
    'UPDATE day_notes SET text = ?, time = ?, icon = ?, sort_order = ? WHERE id = ?'
  ).run(
    text !== undefined ? text.trim() : note.text,
    time !== undefined ? time : note.time,
    icon !== undefined ? icon : note.icon,
    sort_order !== undefined ? sort_order : note.sort_order,
    id
  );

  const updated = db.prepare('SELECT * FROM day_notes WHERE id = ?').get(id);
  res.json({ note: updated });
  broadcast(tripId, 'dayNote:updated', { dayId: Number(dayId), note: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = verifyAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const note = db.prepare('SELECT id FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(id, dayId, tripId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  db.prepare('DELETE FROM day_notes WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'dayNote:deleted', { noteId: Number(id), dayId: Number(dayId) }, req.headers['x-socket-id'] as string);
});

export default router;
