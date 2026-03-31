"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
router.get('/', auth_1.authenticate, (_req, res) => {
    const categories = database_1.db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
    res.json({ categories });
});
router.post('/', auth_1.authenticate, auth_1.adminOnly, (req, res) => {
    const authReq = req;
    const { name, color, icon } = req.body;
    if (!name)
        return res.status(400).json({ error: 'Category name is required' });
    const result = database_1.db.prepare('INSERT INTO categories (name, color, icon, user_id) VALUES (?, ?, ?, ?)').run(name, color || '#6366f1', icon || '\uD83D\uDCCD', authReq.user.id);
    const category = database_1.db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ category });
});
router.put('/:id', auth_1.authenticate, auth_1.adminOnly, (req, res) => {
    const { name, color, icon } = req.body;
    const category = database_1.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category)
        return res.status(404).json({ error: 'Category not found' });
    database_1.db.prepare(`
    UPDATE categories SET
      name = COALESCE(?, name),
      color = COALESCE(?, color),
      icon = COALESCE(?, icon)
    WHERE id = ?
  `).run(name || null, color || null, icon || null, req.params.id);
    const updated = database_1.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    res.json({ category: updated });
});
router.delete('/:id', auth_1.authenticate, auth_1.adminOnly, (req, res) => {
    const category = database_1.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category)
        return res.status(404).json({ error: 'Category not found' });
    database_1.db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=categories.js.map