import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as dayNoteService from '../services/dayNoteService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  if (!dayNoteService.verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  res.json({ notes: dayNoteService.listNotes(dayId, tripId) });
});

router.post('/', authenticate, validateStringLengths({ text: 500, time: 150 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  const access = dayNoteService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!dayNoteService.dayExists(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });

  const { text, time, icon, day_section, sort_order } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });

  const note = dayNoteService.createNote(dayId, tripId, text, time, icon, day_section, sort_order);
  res.status(201).json({ note });
  broadcast(tripId, 'dayNote:created', { dayId: Number(dayId), note }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, validateStringLengths({ text: 500, time: 150 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = dayNoteService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const current = dayNoteService.getNote(id, dayId, tripId);
  if (!current) return res.status(404).json({ error: 'Note not found' });

  const { text, time, icon, day_section, sort_order } = req.body;
  const updated = dayNoteService.updateNote(id, current, { text, time, icon, day_section, sort_order });
  res.json({ note: updated });
  broadcast(tripId, 'dayNote:updated', { dayId: Number(dayId), note: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = dayNoteService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!dayNoteService.getNote(id, dayId, tripId)) return res.status(404).json({ error: 'Note not found' });
  dayNoteService.deleteNote(id);
  res.json({ success: true });
  broadcast(tripId, 'dayNote:deleted', { noteId: Number(id), dayId: Number(dayId) }, req.headers['x-socket-id'] as string);
});

export default router;
