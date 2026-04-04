import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import {
  getAssignmentWithPlace,
  listDayAssignments,
  dayExists,
  placeExists,
  createAssignment,
  assignmentExistsInDay,
  deleteAssignment,
  reorderAssignments,
  getAssignmentForTrip,
  moveAssignment,
  getParticipants,
  updateTime,
  updateSection,
  setParticipants,
} from '../services/assignmentService';
import { AuthRequest } from '../types';

const router = express.Router({ mergeParams: true });

router.get('/trips/:tripId/days/:dayId/assignments', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, dayId } = req.params;

  if (!dayExists(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });

  const result = listDayAssignments(dayId);
  res.json({ assignments: result });
});

router.post('/trips/:tripId/days/:dayId/assignments', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, dayId } = req.params;
  const { place_id, notes } = req.body;

  if (!dayExists(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });
  if (!placeExists(place_id, tripId)) return res.status(404).json({ error: 'Place not found' });

  const assignment = createAssignment(dayId, place_id, notes);
  res.status(201).json({ assignment });
  broadcast(tripId, 'assignment:created', { assignment }, req.headers['x-socket-id'] as string);
});

router.delete('/trips/:tripId/days/:dayId/assignments/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, dayId, id } = req.params;

  if (!assignmentExistsInDay(id, dayId, tripId)) return res.status(404).json({ error: 'Assignment not found' });

  deleteAssignment(id);
  res.json({ success: true });
  broadcast(tripId, 'assignment:deleted', { assignmentId: Number(id), dayId: Number(dayId) }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/days/:dayId/assignments/reorder', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, dayId } = req.params;
  const { orderedIds } = req.body;

  if (!dayExists(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });

  reorderAssignments(dayId, orderedIds);
  res.json({ success: true });
  broadcast(tripId, 'assignment:reordered', { dayId: Number(dayId), orderedIds }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/assignments/:id/move', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;
  const { new_day_id, order_index } = req.body;

  const existing = getAssignmentForTrip(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Assignment not found' });

  if (!dayExists(new_day_id, tripId)) return res.status(404).json({ error: 'Target day not found' });

  const oldDayId = existing.day_id;
  const { assignment: updated } = moveAssignment(id, new_day_id, order_index, oldDayId);
  res.json({ assignment: updated });
  broadcast(tripId, 'assignment:moved', { assignment: updated, oldDayId: Number(oldDayId), newDayId: Number(new_day_id) }, req.headers['x-socket-id'] as string);
});

router.get('/trips/:tripId/assignments/:id/participants', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { id } = req.params;

  const participants = getParticipants(id);
  res.json({ participants });
});

router.put('/trips/:tripId/assignments/:id/time', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  const existing = getAssignmentForTrip(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Assignment not found' });

  const { place_time, end_time } = req.body;
  const updated = updateTime(id, place_time, end_time);
  res.json({ assignment: updated });
  broadcast(Number(tripId), 'assignment:updated', { assignment: updated }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/assignments/:id/section', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;
  const existing = getAssignmentForTrip(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Assignment not found' });

  const { day_section } = req.body;
  const updated = updateSection(id, day_section);
  res.json({ assignment: updated });
  broadcast(Number(tripId), 'assignment:updated', { assignment: updated }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/assignments/:id/participants', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;
  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' });

  const participants = setParticipants(id, user_ids);
  res.json({ participants });
  broadcast(Number(tripId), 'assignment:participants', { assignmentId: Number(id), participants }, req.headers['x-socket-id'] as string);
});

export default router;
