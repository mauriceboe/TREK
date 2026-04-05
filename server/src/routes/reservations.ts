import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import {
  verifyTripAccess,
  listReservations,
  createReservation,
  updatePositions,
  getReservation,
  updateReservation,
  deleteReservation,
} from '../services/reservationService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const reservations = listReservations(tripId);
  res.json({ reservations });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation, create_budget_entry } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!title) return res.status(400).json({ error: 'Title is required' });

  const { reservation, accommodationCreated } = createReservation(tripId, {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, place_id, assignment_id,
    status, type, accommodation_id, metadata, create_accommodation
  });

  if (accommodationCreated) {
    broadcast(tripId, 'accommodation:created', {}, req.headers['x-socket-id'] as string);
  }

  // Auto-create budget entry if price was provided
  if (create_budget_entry && create_budget_entry.total_price > 0) {
    try {
      const { createBudgetItem } = require('../services/budgetService');
      const budgetItem = createBudgetItem(tripId, {
        name: title,
        category: create_budget_entry.category || type || 'Other',
        total_price: create_budget_entry.total_price,
      });
      db.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(reservation.id, budgetItem.id);
      budgetItem.reservation_id = reservation.id;
      broadcast(tripId, 'budget:created', { item: budgetItem }, req.headers['x-socket-id'] as string);
    } catch (err) {
      console.error('[reservations] Failed to create budget entry:', err);
    }
  }

  res.status(201).json({ reservation });
  broadcast(tripId, 'reservation:created', { reservation }, req.headers['x-socket-id'] as string);

  // Notify trip members about new booking
  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title, type: type || 'booking', tripId: String(tripId) } }).catch(() => {});
  });
});

// Batch update day_plan_position for multiple reservations (must be before /:id)
router.put('/positions', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { positions } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!Array.isArray(positions)) return res.status(400).json({ error: 'positions must be an array' });

  updatePositions(tripId, positions);

  res.json({ success: true });
  broadcast(tripId, 'reservation:positions', { positions }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation, create_budget_entry } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const current = getReservation(id, tripId);
  if (!current) return res.status(404).json({ error: 'Reservation not found' });

  const { reservation, accommodationChanged } = updateReservation(id, tripId, {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, place_id, assignment_id,
    status, type, accommodation_id, metadata, create_accommodation
  }, current);

  if (accommodationChanged) {
    broadcast(tripId, 'accommodation:updated', {}, req.headers['x-socket-id'] as string);
  }

  // Remove linked budget entry if price was cleared
  if (!create_budget_entry || !create_budget_entry.total_price) {
    const linked = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?').get(tripId, id) as { id: number } | undefined;
    if (linked) {
      const { deleteBudgetItem } = require('../services/budgetService');
      deleteBudgetItem(linked.id, tripId);
      broadcast(tripId, 'budget:deleted', { id: linked.id }, req.headers['x-socket-id'] as string);
    }
  }

  // Auto-create or update budget entry if price was provided
  if (create_budget_entry && create_budget_entry.total_price > 0) {
    try {
      const { createBudgetItem, updateBudgetItem } = require('../services/budgetService');
      const itemName = title || current.title;
      const existing = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?').get(tripId, id) as { id: number } | undefined;
      if (existing) {
        const updated = updateBudgetItem(existing.id, tripId, {
          name: itemName,
          category: create_budget_entry.category || type || current.type || 'Other',
          total_price: create_budget_entry.total_price,
        });
        broadcast(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id'] as string);
      } else {
        const budgetItem = createBudgetItem(tripId, {
          name: itemName,
          category: create_budget_entry.category || type || current.type || 'Other',
          total_price: create_budget_entry.total_price,
        });
        db.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(id, budgetItem.id);
        budgetItem.reservation_id = Number(id);
        broadcast(tripId, 'budget:created', { item: budgetItem }, req.headers['x-socket-id'] as string);
      }
    } catch (err) {
      console.error('[reservations] Failed to create/update budget entry:', err);
    }
  }

  res.json({ reservation });
  broadcast(tripId, 'reservation:updated', { reservation }, req.headers['x-socket-id'] as string);

  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title || current.title, type: type || current.type || 'booking', tripId: String(tripId) } }).catch(() => {});
  });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { deleted: reservation, accommodationDeleted } = deleteReservation(id, tripId);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  if (accommodationDeleted) {
    broadcast(tripId, 'accommodation:deleted', { accommodationId: reservation.accommodation_id }, req.headers['x-socket-id'] as string);
  }

  res.json({ success: true });
  broadcast(tripId, 'reservation:deleted', { reservationId: Number(id) }, req.headers['x-socket-id'] as string);

  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: reservation.title, type: reservation.type || 'booking', tripId: String(tripId) } }).catch(() => {});
  });
});

export default router;
