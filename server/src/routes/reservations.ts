import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest, Reservation } from '../types';

const router = express.Router({ mergeParams: true });

function verifyTripOwnership(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const reservations = db.prepare(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.trip_id = ?
    ORDER BY r.reservation_time ASC, r.created_at ASC
  `).all(tripId);

  res.json({ reservations });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!title) return res.status(400).json({ error: 'Title is required' });

  // Auto-create accommodation for hotel reservations
  let resolvedAccommodationId = accommodation_id || null;
  if (type === 'hotel' && !resolvedAccommodationId && create_accommodation) {
    const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
    if (accPlaceId && start_day_id && end_day_id) {
      const accResult = db.prepare(
        'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
      resolvedAccommodationId = accResult.lastInsertRowid;
      broadcast(tripId, 'accommodation:created', {}, req.headers['x-socket-id'] as string);
    }
  }

  const result = db.prepare(`
    INSERT INTO reservations (trip_id, day_id, place_id, assignment_id, title, reservation_time, reservation_end_time, location, confirmation_number, notes, status, type, accommodation_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    day_id || null,
    place_id || null,
    assignment_id || null,
    title,
    reservation_time || null,
    reservation_end_time || null,
    location || null,
    confirmation_number || null,
    notes || null,
    status || 'pending',
    type || 'other',
    resolvedAccommodationId,
    metadata ? JSON.stringify(metadata) : null
  );

  // Sync check-in/out to accommodation if linked
  if (accommodation_id && metadata) {
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    if (meta.check_in_time || meta.check_out_time) {
      db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out) WHERE id = ?')
        .run(meta.check_in_time || null, meta.check_out_time || null, accommodation_id);
    }
    if (confirmation_number) {
      db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
        .run(confirmation_number, accommodation_id);
    }
  }

  const reservation = db.prepare(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ reservation });
  broadcast(tripId, 'reservation:created', { reservation }, req.headers['x-socket-id'] as string);

  // Notify trip members about new booking
  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    notifyTripMembers(Number(tripId), authReq.user.id, 'booking_change', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title, type: type || 'booking' }).catch(() => {});
  });
});

// Batch update day_plan_position for multiple reservations (must be before /:id)
router.put('/positions', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { positions } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!Array.isArray(positions)) return res.status(400).json({ error: 'positions must be an array' });

  const stmt = db.prepare('UPDATE reservations SET day_plan_position = ? WHERE id = ? AND trip_id = ?');
  const updateMany = db.transaction((items: { id: number; day_plan_position: number }[]) => {
    for (const item of items) {
      stmt.run(item.day_plan_position, item.id, tripId);
    }
  });
  updateMany(positions);

  res.json({ success: true });
  broadcast(tripId, 'reservation:positions', { positions }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId) as Reservation | undefined;
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  // Update or create accommodation for hotel reservations
  let resolvedAccId = accommodation_id !== undefined ? (accommodation_id || null) : reservation.accommodation_id;
  if (type === 'hotel' && create_accommodation) {
    const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
    if (accPlaceId && start_day_id && end_day_id) {
      if (resolvedAccId) {
        db.prepare('UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ? WHERE id = ?')
          .run(accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null, resolvedAccId);
      } else {
        const accResult = db.prepare(
          'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
        resolvedAccId = accResult.lastInsertRowid;
      }
      broadcast(tripId, 'accommodation:updated', {}, req.headers['x-socket-id'] as string);
    }
  }

  db.prepare(`
    UPDATE reservations SET
      title = COALESCE(?, title),
      reservation_time = ?,
      reservation_end_time = ?,
      location = ?,
      confirmation_number = ?,
      notes = ?,
      day_id = ?,
      place_id = ?,
      assignment_id = ?,
      status = COALESCE(?, status),
      type = COALESCE(?, type),
      accommodation_id = ?,
      metadata = ?
    WHERE id = ?
  `).run(
    title || null,
    reservation_time !== undefined ? (reservation_time || null) : reservation.reservation_time,
    reservation_end_time !== undefined ? (reservation_end_time || null) : reservation.reservation_end_time,
    location !== undefined ? (location || null) : reservation.location,
    confirmation_number !== undefined ? (confirmation_number || null) : reservation.confirmation_number,
    notes !== undefined ? (notes || null) : reservation.notes,
    day_id !== undefined ? (day_id || null) : reservation.day_id,
    place_id !== undefined ? (place_id || null) : reservation.place_id,
    assignment_id !== undefined ? (assignment_id || null) : reservation.assignment_id,
    status || null,
    type || null,
    resolvedAccId,
    metadata !== undefined ? (metadata ? JSON.stringify(metadata) : null) : reservation.metadata,
    id
  );

  // Sync check-in/out to accommodation if linked
  const resolvedMeta = metadata !== undefined ? metadata : (reservation.metadata ? JSON.parse(reservation.metadata as string) : null);
  if (resolvedAccId && resolvedMeta) {
    const meta = typeof resolvedMeta === 'string' ? JSON.parse(resolvedMeta) : resolvedMeta;
    if (meta.check_in_time || meta.check_out_time) {
      db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out) WHERE id = ?')
        .run(meta.check_in_time || null, meta.check_out_time || null, resolvedAccId);
    }
    const resolvedConf = confirmation_number !== undefined ? confirmation_number : reservation.confirmation_number;
    if (resolvedConf) {
      db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
        .run(resolvedConf, resolvedAccId);
    }
  }

  const updated = db.prepare(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.id = ?
  `).get(id);

  res.json({ reservation: updated });
  broadcast(tripId, 'reservation:updated', { reservation: updated }, req.headers['x-socket-id'] as string);

  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    notifyTripMembers(Number(tripId), authReq.user.id, 'booking_change', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title || reservation.title, type: type || reservation.type || 'booking' }).catch(() => {});
  });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const reservation = db.prepare('SELECT id, title, type, accommodation_id FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId) as { id: number; title: string; type: string; accommodation_id: number | null } | undefined;
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  if (reservation.accommodation_id) {
    db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(reservation.accommodation_id);
    broadcast(tripId, 'accommodation:deleted', { accommodationId: reservation.accommodation_id }, req.headers['x-socket-id'] as string);
  }

  db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'reservation:deleted', { reservationId: Number(id) }, req.headers['x-socket-id'] as string);

  import('../services/notifications').then(({ notifyTripMembers }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    notifyTripMembers(Number(tripId), authReq.user.id, 'booking_change', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: reservation.title, type: reservation.type || 'booking' }).catch(() => {});
  });
});

export default router;
