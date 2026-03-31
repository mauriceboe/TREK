"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const websocket_1 = require("../websocket");
const validate_1 = require("../middleware/validate");
const router = express_1.default.Router({ mergeParams: true });
function verifyAccess(tripId, userId) {
    return (0, database_1.canAccessTrip)(tripId, userId);
}
router.get('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, dayId } = req.params;
    if (!verifyAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const notes = database_1.db.prepare('SELECT * FROM day_notes WHERE day_id = ? AND trip_id = ? ORDER BY sort_order ASC, created_at ASC').all(dayId, tripId);
    res.json({ notes });
});
router.post('/', auth_1.authenticate, (0, validate_1.validateStringLengths)({ text: 500, time: 150 }), (req, res) => {
    const authReq = req;
    const { tripId, dayId } = req.params;
    if (!verifyAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const day = database_1.db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
    if (!day)
        return res.status(404).json({ error: 'Day not found' });
    const { text, time, icon, sort_order } = req.body;
    if (!text?.trim())
        return res.status(400).json({ error: 'Text required' });
    const result = database_1.db.prepare('INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(dayId, tripId, text.trim(), time || null, icon || '\uD83D\uDCDD', sort_order ?? 9999);
    const note = database_1.db.prepare('SELECT * FROM day_notes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ note });
    (0, websocket_1.broadcast)(tripId, 'dayNote:created', { dayId: Number(dayId), note }, req.headers['x-socket-id']);
});
router.put('/:id', auth_1.authenticate, (0, validate_1.validateStringLengths)({ text: 500, time: 150 }), (req, res) => {
    const authReq = req;
    const { tripId, dayId, id } = req.params;
    if (!verifyAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const note = database_1.db.prepare('SELECT * FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(id, dayId, tripId);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const { text, time, icon, sort_order } = req.body;
    database_1.db.prepare('UPDATE day_notes SET text = ?, time = ?, icon = ?, sort_order = ? WHERE id = ?').run(text !== undefined ? text.trim() : note.text, time !== undefined ? time : note.time, icon !== undefined ? icon : note.icon, sort_order !== undefined ? sort_order : note.sort_order, id);
    const updated = database_1.db.prepare('SELECT * FROM day_notes WHERE id = ?').get(id);
    res.json({ note: updated });
    (0, websocket_1.broadcast)(tripId, 'dayNote:updated', { dayId: Number(dayId), note: updated }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, dayId, id } = req.params;
    if (!verifyAccess(tripId, authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const note = database_1.db.prepare('SELECT id FROM day_notes WHERE id = ? AND day_id = ? AND trip_id = ?').get(id, dayId, tripId);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    database_1.db.prepare('DELETE FROM day_notes WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'dayNote:deleted', { noteId: Number(id), dayId: Number(dayId) }, req.headers['x-socket-id']);
});
exports.default = router;
//# sourceMappingURL=dayNotes.js.map