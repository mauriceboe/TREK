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
function loadItemMembers(itemId) {
    return database_1.db.prepare(`
    SELECT bm.user_id, bm.paid, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ?
  `).all(itemId);
}
function avatarUrl(user) {
    return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}
router.get('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const items = database_1.db.prepare('SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC, created_at ASC').all(tripId);
    const itemIds = items.map(i => i.id);
    const membersByItem = {};
    if (itemIds.length > 0) {
        const allMembers = database_1.db.prepare(`
      SELECT bm.budget_item_id, bm.user_id, bm.paid, u.username, u.avatar
      FROM budget_item_members bm
      JOIN users u ON bm.user_id = u.id
      WHERE bm.budget_item_id IN (${itemIds.map(() => '?').join(',')})
    `).all(...itemIds);
        for (const m of allMembers) {
            if (!membersByItem[m.budget_item_id])
                membersByItem[m.budget_item_id] = [];
            membersByItem[m.budget_item_id].push({
                user_id: m.user_id, paid: m.paid, username: m.username, avatar_url: avatarUrl(m)
            });
        }
    }
    items.forEach(item => { item.members = membersByItem[item.id] || []; });
    res.json({ items });
});
router.get('/summary/per-person', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    if (!(0, database_1.canAccessTrip)(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const summary = database_1.db.prepare(`
    SELECT bm.user_id, u.username, u.avatar,
      SUM(bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id)) as total_assigned,
      SUM(CASE WHEN bm.paid = 1 THEN bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id) ELSE 0 END) as total_paid,
      COUNT(bi.id) as items_count
    FROM budget_item_members bm
    JOIN budget_items bi ON bm.budget_item_id = bi.id
    JOIN users u ON bm.user_id = u.id
    WHERE bi.trip_id = ?
    GROUP BY bm.user_id
  `).all(tripId);
    res.json({ summary: summary.map(s => ({ ...s, avatar_url: avatarUrl(s) })) });
});
router.post('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { category, name, total_price, persons, days, note } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    if (!name)
        return res.status(400).json({ error: 'Name is required' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?').get(tripId);
    const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
    const result = database_1.db.prepare('INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(tripId, category || 'Other', name, total_price || 0, persons != null ? persons : null, days !== undefined && days !== null ? days : null, note || null, sortOrder);
    const item = database_1.db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid);
    item.members = [];
    res.status(201).json({ item });
    (0, websocket_1.broadcast)(tripId, 'budget:created', { item }, req.headers['x-socket-id']);
});
router.put('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { category, name, total_price, persons, days, note, sort_order } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const item = database_1.db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!item)
        return res.status(404).json({ error: 'Budget item not found' });
    database_1.db.prepare(`
    UPDATE budget_items SET
      category = COALESCE(?, category),
      name = COALESCE(?, name),
      total_price = CASE WHEN ? IS NOT NULL THEN ? ELSE total_price END,
      persons = CASE WHEN ? IS NOT NULL THEN ? ELSE persons END,
      days = CASE WHEN ? THEN ? ELSE days END,
      note = CASE WHEN ? THEN ? ELSE note END,
      sort_order = CASE WHEN ? IS NOT NULL THEN ? ELSE sort_order END
    WHERE id = ?
  `).run(category || null, name || null, total_price !== undefined ? 1 : null, total_price !== undefined ? total_price : 0, persons !== undefined ? 1 : null, persons !== undefined ? persons : null, days !== undefined ? 1 : 0, days !== undefined ? days : null, note !== undefined ? 1 : 0, note !== undefined ? note : null, sort_order !== undefined ? 1 : null, sort_order !== undefined ? sort_order : 0, id);
    const updated = database_1.db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id);
    updated.members = loadItemMembers(id);
    res.json({ item: updated });
    (0, websocket_1.broadcast)(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id']);
});
router.put('/:id/members', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    if (!(0, database_1.canAccessTrip)(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const item = database_1.db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!item)
        return res.status(404).json({ error: 'Budget item not found' });
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids))
        return res.status(400).json({ error: 'user_ids must be an array' });
    const existingPaid = {};
    const existing = database_1.db.prepare('SELECT user_id, paid FROM budget_item_members WHERE budget_item_id = ?').all(id);
    for (const e of existing)
        existingPaid[e.user_id] = e.paid;
    database_1.db.prepare('DELETE FROM budget_item_members WHERE budget_item_id = ?').run(id);
    if (user_ids.length > 0) {
        const insert = database_1.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, ?)');
        for (const userId of user_ids)
            insert.run(id, userId, existingPaid[userId] || 0);
        database_1.db.prepare('UPDATE budget_items SET persons = ? WHERE id = ?').run(user_ids.length, id);
    }
    else {
        database_1.db.prepare('UPDATE budget_items SET persons = NULL WHERE id = ?').run(id);
    }
    const members = loadItemMembers(id).map(m => ({ ...m, avatar_url: avatarUrl(m) }));
    const updated = database_1.db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id);
    res.json({ members, item: updated });
    (0, websocket_1.broadcast)(Number(tripId), 'budget:members-updated', { itemId: Number(id), members, persons: updated.persons }, req.headers['x-socket-id']);
});
router.put('/:id/members/:userId/paid', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id, userId } = req.params;
    if (!(0, database_1.canAccessTrip)(Number(tripId), authReq.user.id))
        return res.status(404).json({ error: 'Trip not found' });
    const { paid } = req.body;
    database_1.db.prepare('UPDATE budget_item_members SET paid = ? WHERE budget_item_id = ? AND user_id = ?')
        .run(paid ? 1 : 0, id, userId);
    const member = database_1.db.prepare(`
    SELECT bm.user_id, bm.paid, u.username, u.avatar
    FROM budget_item_members bm JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ? AND bm.user_id = ?
  `).get(id, userId);
    const result = member ? { ...member, avatar_url: avatarUrl(member) } : null;
    res.json({ member: result });
    (0, websocket_1.broadcast)(Number(tripId), 'budget:member-paid-updated', { itemId: Number(id), userId: Number(userId), paid: paid ? 1 : 0 }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const item = database_1.db.prepare('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!item)
        return res.status(404).json({ error: 'Budget item not found' });
    database_1.db.prepare('DELETE FROM budget_items WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'budget:deleted', { itemId: Number(id) }, req.headers['x-socket-id']);
});
exports.default = router;
//# sourceMappingURL=budget.js.map