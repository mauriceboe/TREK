"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.accommodationsRouter = void 0;
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const tripAccess_1 = require("../middleware/tripAccess");
const websocket_1 = require("../websocket");
const queryHelpers_1 = require("../services/queryHelpers");
const router = express_1.default.Router({ mergeParams: true });
function getAssignmentsForDay(dayId) {
    const assignments = database_1.db.prepare(`
    SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      p.duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id = ?
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(dayId);
    return assignments.map(a => {
        const tags = database_1.db.prepare(`
      SELECT t.* FROM tags t
      JOIN place_tags pt ON t.id = pt.tag_id
      WHERE pt.place_id = ?
    `).all(a.place_id);
        return {
            id: a.id,
            day_id: a.day_id,
            order_index: a.order_index,
            notes: a.notes,
            created_at: a.created_at,
            place: {
                id: a.place_id,
                name: a.place_name,
                description: a.place_description,
                lat: a.lat,
                lng: a.lng,
                address: a.address,
                category_id: a.category_id,
                price: a.price,
                currency: a.place_currency,
                place_time: a.place_time,
                end_time: a.end_time,
                duration_minutes: a.duration_minutes,
                notes: a.place_notes,
                image_url: a.image_url,
                transport_mode: a.transport_mode,
                google_place_id: a.google_place_id,
                website: a.website,
                phone: a.phone,
                category: a.category_id ? {
                    id: a.category_id,
                    name: a.category_name,
                    color: a.category_color,
                    icon: a.category_icon,
                } : null,
                tags,
            }
        };
    });
}
router.get('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId } = req.params;
    const days = database_1.db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId);
    if (days.length === 0) {
        return res.json({ days: [] });
    }
    const dayIds = days.map(d => d.id);
    const dayPlaceholders = dayIds.map(() => '?').join(',');
    const allAssignments = database_1.db.prepare(`
    SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      p.duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id IN (${dayPlaceholders})
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(...dayIds);
    const placeIds = [...new Set(allAssignments.map(a => a.place_id))];
    const tagsByPlaceId = (0, queryHelpers_1.loadTagsByPlaceIds)(placeIds, { compact: true });
    const allAssignmentIds = allAssignments.map(a => a.id);
    const participantsByAssignment = (0, queryHelpers_1.loadParticipantsByAssignmentIds)(allAssignmentIds);
    const assignmentsByDayId = {};
    for (const a of allAssignments) {
        if (!assignmentsByDayId[a.day_id])
            assignmentsByDayId[a.day_id] = [];
        assignmentsByDayId[a.day_id].push((0, queryHelpers_1.formatAssignmentWithPlace)(a, tagsByPlaceId[a.place_id] || [], participantsByAssignment[a.id] || []));
    }
    const allNotes = database_1.db.prepare(`SELECT * FROM day_notes WHERE day_id IN (${dayPlaceholders}) ORDER BY sort_order ASC, created_at ASC`).all(...dayIds);
    const notesByDayId = {};
    for (const note of allNotes) {
        if (!notesByDayId[note.day_id])
            notesByDayId[note.day_id] = [];
        notesByDayId[note.day_id].push(note);
    }
    const daysWithAssignments = days.map(day => ({
        ...day,
        assignments: assignmentsByDayId[day.id] || [],
        notes_items: notesByDayId[day.id] || [],
    }));
    res.json({ days: daysWithAssignments });
});
router.post('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId } = req.params;
    const { date, notes } = req.body;
    const maxDay = database_1.db.prepare('SELECT MAX(day_number) as max FROM days WHERE trip_id = ?').get(tripId);
    const dayNumber = (maxDay.max || 0) + 1;
    const result = database_1.db.prepare('INSERT INTO days (trip_id, day_number, date, notes) VALUES (?, ?, ?, ?)').run(tripId, dayNumber, date || null, notes || null);
    const day = database_1.db.prepare('SELECT * FROM days WHERE id = ?').get(result.lastInsertRowid);
    const dayResult = { ...day, assignments: [] };
    res.status(201).json({ day: dayResult });
    (0, websocket_1.broadcast)(tripId, 'day:created', { day: dayResult }, req.headers['x-socket-id']);
});
router.put('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const day = database_1.db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!day) {
        return res.status(404).json({ error: 'Day not found' });
    }
    const { notes, title } = req.body;
    database_1.db.prepare('UPDATE days SET notes = ?, title = ? WHERE id = ?').run(notes || null, title !== undefined ? title : day.title, id);
    const updatedDay = database_1.db.prepare('SELECT * FROM days WHERE id = ?').get(id);
    const dayWithAssignments = { ...updatedDay, assignments: getAssignmentsForDay(id) };
    res.json({ day: dayWithAssignments });
    (0, websocket_1.broadcast)(tripId, 'day:updated', { day: dayWithAssignments }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const day = database_1.db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!day) {
        return res.status(404).json({ error: 'Day not found' });
    }
    database_1.db.prepare('DELETE FROM days WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'day:deleted', { dayId: Number(id) }, req.headers['x-socket-id']);
});
const accommodationsRouter = express_1.default.Router({ mergeParams: true });
exports.accommodationsRouter = accommodationsRouter;
function getAccommodationWithPlace(id) {
    return database_1.db.prepare(`
    SELECT a.*, p.name as place_name, p.address as place_address, p.image_url as place_image, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a
    JOIN places p ON a.place_id = p.id
    WHERE a.id = ?
  `).get(id);
}
accommodationsRouter.get('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId } = req.params;
    const accommodations = database_1.db.prepare(`
    SELECT a.*, p.name as place_name, p.address as place_address, p.image_url as place_image, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a
    JOIN places p ON a.place_id = p.id
    WHERE a.trip_id = ?
    ORDER BY a.created_at ASC
  `).all(tripId);
    res.json({ accommodations });
});
accommodationsRouter.post('/', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId } = req.params;
    const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;
    if (!place_id || !start_day_id || !end_day_id) {
        return res.status(400).json({ error: 'place_id, start_day_id, and end_day_id are required' });
    }
    const place = database_1.db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId);
    if (!place)
        return res.status(404).json({ error: 'Place not found' });
    const startDay = database_1.db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId);
    if (!startDay)
        return res.status(404).json({ error: 'Start day not found' });
    const endDay = database_1.db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId);
    if (!endDay)
        return res.status(404).json({ error: 'End day not found' });
    const result = database_1.db.prepare('INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(tripId, place_id, start_day_id, end_day_id, check_in || null, check_out || null, confirmation || null, notes || null);
    const accommodationId = result.lastInsertRowid;
    // Auto-create linked reservation for this accommodation
    const placeName = database_1.db.prepare('SELECT name FROM places WHERE id = ?').get(place_id)?.name || 'Hotel';
    const startDayDate = database_1.db.prepare('SELECT date FROM days WHERE id = ?').get(start_day_id)?.date || null;
    const meta = {};
    if (check_in)
        meta.check_in_time = check_in;
    if (check_out)
        meta.check_out_time = check_out;
    database_1.db.prepare(`
    INSERT INTO reservations (trip_id, day_id, title, reservation_time, location, confirmation_number, notes, status, type, accommodation_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'hotel', ?, ?)
  `).run(tripId, start_day_id, placeName, startDayDate || null, null, confirmation || null, notes || null, accommodationId, Object.keys(meta).length > 0 ? JSON.stringify(meta) : null);
    const accommodation = getAccommodationWithPlace(accommodationId);
    res.status(201).json({ accommodation });
    (0, websocket_1.broadcast)(tripId, 'accommodation:created', { accommodation }, req.headers['x-socket-id']);
    (0, websocket_1.broadcast)(tripId, 'reservation:created', {}, req.headers['x-socket-id']);
});
accommodationsRouter.put('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const existing = database_1.db.prepare('SELECT * FROM day_accommodations WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!existing)
        return res.status(404).json({ error: 'Accommodation not found' });
    const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;
    const newPlaceId = place_id !== undefined ? place_id : existing.place_id;
    const newStartDayId = start_day_id !== undefined ? start_day_id : existing.start_day_id;
    const newEndDayId = end_day_id !== undefined ? end_day_id : existing.end_day_id;
    const newCheckIn = check_in !== undefined ? check_in : existing.check_in;
    const newCheckOut = check_out !== undefined ? check_out : existing.check_out;
    const newConfirmation = confirmation !== undefined ? confirmation : existing.confirmation;
    const newNotes = notes !== undefined ? notes : existing.notes;
    if (place_id !== undefined) {
        const place = database_1.db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId);
        if (!place)
            return res.status(404).json({ error: 'Place not found' });
    }
    if (start_day_id !== undefined) {
        const startDay = database_1.db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId);
        if (!startDay)
            return res.status(404).json({ error: 'Start day not found' });
    }
    if (end_day_id !== undefined) {
        const endDay = database_1.db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId);
        if (!endDay)
            return res.status(404).json({ error: 'End day not found' });
    }
    database_1.db.prepare('UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ?, notes = ? WHERE id = ?').run(newPlaceId, newStartDayId, newEndDayId, newCheckIn, newCheckOut, newConfirmation, newNotes, id);
    // Sync check-in/out/confirmation to linked reservation
    const linkedRes = database_1.db.prepare('SELECT id, metadata FROM reservations WHERE accommodation_id = ?').get(Number(id));
    if (linkedRes) {
        const meta = linkedRes.metadata ? JSON.parse(linkedRes.metadata) : {};
        if (newCheckIn)
            meta.check_in_time = newCheckIn;
        if (newCheckOut)
            meta.check_out_time = newCheckOut;
        database_1.db.prepare('UPDATE reservations SET metadata = ?, confirmation_number = COALESCE(?, confirmation_number) WHERE id = ?')
            .run(JSON.stringify(meta), newConfirmation || null, linkedRes.id);
    }
    const accommodation = getAccommodationWithPlace(Number(id));
    res.json({ accommodation });
    (0, websocket_1.broadcast)(tripId, 'accommodation:updated', { accommodation }, req.headers['x-socket-id']);
});
accommodationsRouter.delete('/:id', auth_1.authenticate, tripAccess_1.requireTripAccess, (req, res) => {
    const { tripId, id } = req.params;
    const existing = database_1.db.prepare('SELECT * FROM day_accommodations WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!existing)
        return res.status(404).json({ error: 'Accommodation not found' });
    // Delete linked reservation
    const linkedRes = database_1.db.prepare('SELECT id FROM reservations WHERE accommodation_id = ?').get(Number(id));
    if (linkedRes) {
        database_1.db.prepare('DELETE FROM reservations WHERE id = ?').run(linkedRes.id);
        (0, websocket_1.broadcast)(tripId, 'reservation:deleted', { reservationId: linkedRes.id }, req.headers['x-socket-id']);
    }
    database_1.db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'accommodation:deleted', { accommodationId: Number(id) }, req.headers['x-socket-id']);
});
exports.default = router;
//# sourceMappingURL=days.js.map