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
    const items = database_1.db.prepare('SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order ASC, created_at ASC').all(tripId);
    res.json({ items });
});
router.post('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { name, category, checked } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    if (!name)
        return res.status(400).json({ error: 'Item name is required' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId);
    const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
    const result = database_1.db.prepare('INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, ?, ?, ?)').run(tripId, name, checked ? 1 : 0, category || 'Allgemein', sortOrder);
    const item = database_1.db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ item });
    (0, websocket_1.broadcast)(tripId, 'packing:created', { item }, req.headers['x-socket-id']);
});
router.put('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const { name, checked, category, weight_grams, bag_id } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const item = database_1.db.prepare('SELECT * FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!item)
        return res.status(404).json({ error: 'Item not found' });
    database_1.db.prepare(`
    UPDATE packing_items SET
      name = COALESCE(?, name),
      checked = CASE WHEN ? IS NOT NULL THEN ? ELSE checked END,
      category = COALESCE(?, category),
      weight_grams = CASE WHEN ? THEN ? ELSE weight_grams END,
      bag_id = CASE WHEN ? THEN ? ELSE bag_id END
    WHERE id = ?
  `).run(name || null, checked !== undefined ? 1 : null, checked ? 1 : 0, category || null, 'weight_grams' in req.body ? 1 : 0, weight_grams ?? null, 'bag_id' in req.body ? 1 : 0, bag_id ?? null, id);
    const updated = database_1.db.prepare('SELECT * FROM packing_items WHERE id = ?').get(id);
    res.json({ item: updated });
    (0, websocket_1.broadcast)(tripId, 'packing:updated', { item: updated }, req.headers['x-socket-id']);
});
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, id } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const item = database_1.db.prepare('SELECT id FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!item)
        return res.status(404).json({ error: 'Item not found' });
    database_1.db.prepare('DELETE FROM packing_items WHERE id = ?').run(id);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'packing:deleted', { itemId: Number(id) }, req.headers['x-socket-id']);
});
// ── Bags CRUD ───────────────────────────────────────────────────────────────
router.get('/bags', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const bags = database_1.db.prepare('SELECT * FROM packing_bags WHERE trip_id = ? ORDER BY sort_order, id').all(tripId);
    res.json({ bags });
});
router.post('/bags', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { name, color } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    if (!name?.trim())
        return res.status(400).json({ error: 'Name is required' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM packing_bags WHERE trip_id = ?').get(tripId);
    const result = database_1.db.prepare('INSERT INTO packing_bags (trip_id, name, color, sort_order) VALUES (?, ?, ?, ?)').run(tripId, name.trim(), color || '#6366f1', (maxOrder.max ?? -1) + 1);
    const bag = database_1.db.prepare('SELECT * FROM packing_bags WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ bag });
    (0, websocket_1.broadcast)(tripId, 'packing:bag-created', { bag }, req.headers['x-socket-id']);
});
router.put('/bags/:bagId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, bagId } = req.params;
    const { name, color, weight_limit_grams } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const bag = database_1.db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
    if (!bag)
        return res.status(404).json({ error: 'Bag not found' });
    database_1.db.prepare('UPDATE packing_bags SET name = COALESCE(?, name), color = COALESCE(?, color), weight_limit_grams = ? WHERE id = ?').run(name?.trim() || null, color || null, weight_limit_grams ?? null, bagId);
    const updated = database_1.db.prepare('SELECT * FROM packing_bags WHERE id = ?').get(bagId);
    res.json({ bag: updated });
    (0, websocket_1.broadcast)(tripId, 'packing:bag-updated', { bag: updated }, req.headers['x-socket-id']);
});
router.delete('/bags/:bagId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, bagId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const bag = database_1.db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
    if (!bag)
        return res.status(404).json({ error: 'Bag not found' });
    database_1.db.prepare('DELETE FROM packing_bags WHERE id = ?').run(bagId);
    res.json({ success: true });
    (0, websocket_1.broadcast)(tripId, 'packing:bag-deleted', { bagId: Number(bagId) }, req.headers['x-socket-id']);
});
// ── Apply template ──────────────────────────────────────────────────────────
router.post('/apply-template/:templateId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, templateId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const templateItems = database_1.db.prepare(`
    SELECT ti.name, tc.name as category
    FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ?
    ORDER BY tc.sort_order, ti.sort_order
  `).all(templateId);
    if (templateItems.length === 0)
        return res.status(404).json({ error: 'Template not found or empty' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId);
    let sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
    const insert = database_1.db.prepare('INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, 0, ?, ?)');
    const added = [];
    for (const ti of templateItems) {
        const result = insert.run(tripId, ti.name, ti.category, sortOrder++);
        const item = database_1.db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid);
        added.push(item);
    }
    res.json({ items: added, count: added.length });
    (0, websocket_1.broadcast)(tripId, 'packing:template-applied', { items: added }, req.headers['x-socket-id']);
});
// ── Category assignees ──────────────────────────────────────────────────────
router.get('/category-assignees', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const rows = database_1.db.prepare(`
    SELECT pca.category_name, pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    WHERE pca.trip_id = ?
  `).all(tripId);
    // Group by category
    const assignees = {};
    for (const row of rows) {
        if (!assignees[row.category_name])
            assignees[row.category_name] = [];
        assignees[row.category_name].push({ user_id: row.user_id, username: row.username, avatar: row.avatar });
    }
    res.json({ assignees });
});
router.put('/category-assignees/:categoryName', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId, categoryName } = req.params;
    const { user_ids } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const cat = decodeURIComponent(categoryName);
    database_1.db.prepare('DELETE FROM packing_category_assignees WHERE trip_id = ? AND category_name = ?').run(tripId, cat);
    if (Array.isArray(user_ids) && user_ids.length > 0) {
        const insert = database_1.db.prepare('INSERT OR IGNORE INTO packing_category_assignees (trip_id, category_name, user_id) VALUES (?, ?, ?)');
        for (const uid of user_ids)
            insert.run(tripId, cat, uid);
    }
    const rows = database_1.db.prepare(`
    SELECT pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    WHERE pca.trip_id = ? AND pca.category_name = ?
  `).all(tripId, cat);
    res.json({ assignees: rows });
    (0, websocket_1.broadcast)(tripId, 'packing:assignees', { category: cat, assignees: rows }, req.headers['x-socket-id']);
});
router.put('/reorder', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { orderedIds } = req.body;
    const trip = verifyTripOwnership(tripId, authReq.user.id);
    if (!trip)
        return res.status(404).json({ error: 'Trip not found' });
    const update = database_1.db.prepare('UPDATE packing_items SET sort_order = ? WHERE id = ? AND trip_id = ?');
    const updateMany = database_1.db.transaction((ids) => {
        ids.forEach((id, index) => {
            update.run(index, id, tripId);
        });
    });
    updateMany(orderedIds);
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=packing.js.map