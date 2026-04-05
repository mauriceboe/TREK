import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  verifyTripAccess,
  listBudgetItems,
  createBudgetItem,
  updateBudgetItem,
  deleteBudgetItem,
  updateMembers,
  toggleMemberPaid,
  getPerPersonSummary,
  calculateSettlement,
} from '../services/budgetService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  res.json({ items: listBudgetItems(tripId) });
});

router.get('/summary/per-person', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  if (!verifyTripAccess(Number(tripId), authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  res.json({ summary: getPerPersonSummary(tripId) });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const item = createBudgetItem(tripId, req.body);
  res.status(201).json({ item });
  broadcast(tripId, 'budget:created', { item }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const updated = updateBudgetItem(id, tripId, req.body);
  if (!updated) return res.status(404).json({ error: 'Budget item not found' });

  // Sync price back to linked reservation
  if (updated.reservation_id && req.body.total_price !== undefined) {
    try {
      const reservation = db.prepare('SELECT id, metadata FROM reservations WHERE id = ? AND trip_id = ?').get(updated.reservation_id, tripId) as { id: number; metadata: string | null } | undefined;
      if (reservation) {
        const meta = reservation.metadata ? JSON.parse(reservation.metadata) : {};
        meta.price = String(updated.total_price);
        db.prepare('UPDATE reservations SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), reservation.id);
        const updatedRes = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
        broadcast(tripId, 'reservation:updated', { reservation: updatedRes }, req.headers['x-socket-id'] as string);
      }
    } catch (err) {
      console.error('[budget] Failed to sync price to reservation:', err);
    }
  }

  res.json({ item: updated });
  broadcast(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id'] as string);
});

router.put('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' });

  const result = updateMembers(id, tripId, user_ids);
  if (!result) return res.status(404).json({ error: 'Budget item not found' });

  res.json({ members: result.members, item: result.item });
  broadcast(Number(tripId), 'budget:members-updated', { itemId: Number(id), members: result.members, persons: result.item.persons }, req.headers['x-socket-id'] as string);
});

router.put('/:id/members/:userId/paid', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, userId } = req.params;

  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { paid } = req.body;
  const member = toggleMemberPaid(id, userId, paid);
  res.json({ member });
  broadcast(Number(tripId), 'budget:member-paid-updated', { itemId: Number(id), userId: Number(userId), paid: paid ? 1 : 0 }, req.headers['x-socket-id'] as string);
});

router.get('/settlement', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  if (!verifyTripAccess(Number(tripId), authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  res.json(calculateSettlement(tripId));
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteBudgetItem(id, tripId))
    return res.status(404).json({ error: 'Budget item not found' });

  res.json({ success: true });
  broadcast(tripId, 'budget:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
