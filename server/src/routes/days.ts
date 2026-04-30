import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as dayService from '../services/dayService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  res.json(dayService.listDays(tripId));
});

router.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const { date, notes } = req.body;

  const day = dayService.createDay(tripId, date, notes);
  res.status(201).json({ day });
  broadcast(tripId, 'day:created', { day }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  const current = dayService.getDay(id, tripId);
  if (!current) return res.status(404).json({ error: 'Day not found' });

  const { notes, title } = req.body;
  const day = dayService.updateDay(id, current, { notes, title });
  res.json({ day });
  broadcast(tripId, 'day:updated', { day }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  if (!dayService.getDay(id, tripId)) return res.status(404).json({ error: 'Day not found' });

  dayService.deleteDay(id);
  res.json({ success: true });
  broadcast(tripId, 'day:deleted', { dayId: Number(id) }, req.headers['x-socket-id'] as string);
});

// ---------------------------------------------------------------------------
// Accommodations sub-router
// ---------------------------------------------------------------------------

const accommodationsRouter = express.Router({ mergeParams: true });

accommodationsRouter.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  res.json({ accommodations: dayService.listAccommodations(tripId) });
});

accommodationsRouter.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes } = req.body;

  if (!place_id || !start_day_id || !end_day_id) {
    return res.status(400).json({ error: 'place_id, start_day_id, and end_day_id are required' });
  }

  const errors = dayService.validateAccommodationRefs(tripId, place_id, start_day_id, end_day_id);
  if (errors.length > 0) return res.status(404).json({ error: errors[0].message });

  const accommodation = dayService.createAccommodation(tripId, { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes });
  res.status(201).json({ accommodation });
  broadcast(tripId, 'accommodation:created', { accommodation }, req.headers['x-socket-id'] as string);
  broadcast(tripId, 'reservation:created', {}, req.headers['x-socket-id'] as string);
});

accommodationsRouter.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  const existing = dayService.getAccommodation(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Accommodation not found' });

  const { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes } = req.body;

  const errors = dayService.validateAccommodationRefs(tripId, place_id, start_day_id, end_day_id);
  if (errors.length > 0) return res.status(404).json({ error: errors[0].message });

  const accommodation = dayService.updateAccommodation(id, existing, { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes });
  res.json({ accommodation });
  broadcast(tripId, 'accommodation:updated', { accommodation }, req.headers['x-socket-id'] as string);
});

accommodationsRouter.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  if (!dayService.getAccommodation(id, tripId)) return res.status(404).json({ error: 'Accommodation not found' });

  const { linkedReservationId, deletedBudgetItemId } = dayService.deleteAccommodation(id);
  if (linkedReservationId) {
    broadcast(tripId, 'reservation:deleted', { reservationId: linkedReservationId }, req.headers['x-socket-id'] as string);
  }
  if (deletedBudgetItemId) {
    broadcast(tripId, 'budget:deleted', { itemId: deletedBudgetItemId }, req.headers['x-socket-id'] as string);
  }

  res.json({ success: true });
  broadcast(tripId, 'accommodation:deleted', { accommodationId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
export { accommodationsRouter };
