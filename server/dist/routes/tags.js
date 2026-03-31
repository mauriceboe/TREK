"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
router.get('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const tags = database_1.db.prepare('SELECT * FROM tags WHERE user_id = ? ORDER BY name ASC').all(authReq.user.id);
    res.json({ tags });
});
router.post('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { name, color } = req.body;
    if (!name)
        return res.status(400).json({ error: 'Tag name is required' });
    const result = database_1.db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(authReq.user.id, name, color || '#10b981');
    const tag = database_1.db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ tag });
});
router.put('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { name, color } = req.body;
    const tag = database_1.db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, authReq.user.id);
    if (!tag)
        return res.status(404).json({ error: 'Tag not found' });
    database_1.db.prepare('UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?')
        .run(name || null, color || null, req.params.id);
    const updated = database_1.db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    res.json({ tag: updated });
});
router.delete('/:id', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const tag = database_1.db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, authReq.user.id);
    if (!tag)
        return res.status(404).json({ error: 'Tag not found' });
    database_1.db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=tags.js.map