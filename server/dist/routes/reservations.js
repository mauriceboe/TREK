"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const websocket_1 = require("../websocket");
const router = express_1.default.Router({ mergeParams: true });
function verifyTripOwnership(tripId, userId) {
    return (0, database_1.canAccessTrip)(tripId, userId);
}
router.get('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const reservations = database_1.db.prepare(`
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
router.post('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    if (!title)
        return res.status(400).json({ error: 'Title is required' });
    // Auto-create accommodation for hotel reservations
    let resolvedAccommodationId = accommodation_id || null;
    if (type === 'hotel' && !resolvedAccommodationId && create_accommodation) {
        const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
        if (accPlaceId && start_day_id && end_day_id) {
            const accResult = database_1.db.prepare('INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
            resolvedAccommodationId = accResult.lastInsertRowid;
            (0, websocket_1.broadcast)(tripId, 'accommodation:created', {}, req.headers['x-socket-id']);
        }
    }
    const result = database_1.db.prepare(`
    INSERT INTO reservations (trip_id, day_id, place_id, assignment_id, title, reservation_time, reservation_end_time, location, confirmation_number, notes, status, type, accommodation_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, day_id || null, place_id || null, assignment_id || null, title, reservation_time || null, reservation_end_time || null, location || null, confirmation_number || null, notes || null, status || 'pending', type || 'other', resolvedAccommodationId, metadata ? JSON.stringify(metadata) : null);
    // Sync check-in/out to accommodation if linked
    if (accommodation_id && metadata) {
        const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        if (meta.check_in_time || meta.check_out_time) {
            database_1.db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out) WHERE id = ?')
                .run(meta.check_in_time || null, meta.check_out_time || null, accommodation_id);
        }
        if (confirmation_number) {
            database_1.db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
                .run(confirmation_number, accommodation_id);
        }
    }
    const reservation = database_1.db.prepare(`
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
    (0, websocket_1.broadcast)(tripId, 'reservation:created', { reservation }, req.headers['x-socket-id']);
});
router.put('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const reservation = database_1.db.prepare('SELECT * FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!reservation)
        return res.status(404).json({ error: 'Reservation not found' });
    // Update or create accommodation for hotel reservations
    let resolvedAccId = accommodation_id !== undefined ? (accommodation_id || null) : reservation.accommodation_id;
    if (type === 'hotel' && create_accommodation) {
        const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
        if (accPlaceId && start_day_id && end_day_id) {
            if (resolvedAccId) {
                database_1.db.prepare('UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ? WHERE id = ?')
                    .run(accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null, resolvedAccId);
            }
            else {
                const accResult = database_1.db.prepare('INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null);
                resolvedAccId = accResult.lastInsertRowid;
            }
            (0, websocket_1.broadcast)(tripId, 'accommodation:updated', {}, req.headers['x-socket-id']);
        }
    }
    database_1.db.prepare(`
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
  `).run(title || null, reservation_time !== undefined ? (reservation_time || null) : reservation.reservation_time, reservation_end_time !== undefined ? (reservation_end_time || null) : reservation.reservation_end_time, location !== undefined ? (location || null) : reservation.location, confirmation_number !== undefined ? (confirmation_number || null) : reservation.confirmation_number, notes !== undefined ? (notes || null) : reservation.notes, day_id !== undefined ? (day_id || null) : reservation.day_id, place_id !== undefined ? (place_id || null) : reservation.place_id, assignment_id !== undefined ? (assignment_id || null) : reservation.assignment_id, status || null, type || null, resolvedAccId, metadata !== undefined ? (metadata ? JSON.stringify(metadata) : null) : reservation.metadata, id);
    // Sync check-in/out to accommodation if linked
    const resolvedMeta = metadata !== undefined ? metadata : (reservation.metadata ? JSON.parse(reservation.metadata) : null);
    if (resolvedAccId && resolvedMeta) {
        const meta = typeof resolvedMeta === 'string' ? JSON.parse(resolvedMeta) : resolvedMeta;
        if (meta.check_in_time || meta.check_out_time) {
            database_1.db.prepare('UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out) WHERE id = ?')
                .run(meta.check_in_time || null, meta.check_out_time || null, resolvedAccId);
        }
        const resolvedConf = confirmation_number !== undefined ? confirmation_number : reservation.confirmation_number;
        if (resolvedConf) {
            database_1.db.prepare('UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?')
                .run(resolvedConf, resolvedAccId);
        }
    }
    const updated = database_1.db.prepare(`
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
    (0, websocket_1.broadcast)(tripId, 'reservation:updated', { reservation: updated }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const reservation = database_1.db.prepare('SELECT id, accommodation_id FROM reservations WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!reservation)
        return res.status(404).json({ error: 'Reservation not found' });
    // Delete linked accommodation if exists
    if (reservation.accommodation_id) {
        database_1.db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(reservation.accommodation_id);
        (0, websocket_1.broadcast)(tripId, 'accommodation:deleted', { accommodationId: reservation.accommodation_id }, req.headers['x-socket-id']);
    }
    database_1.db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'reservation:deleted', { reservationId: Number(id) }, req.headers['x-socket-id']);
});
exports.default = router;
//# sourceMappingURL=reservations.js.map