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
    const rows = database_1.db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(authReq.user.id);
    const settings = {};
    for (const row of rows) {
        try {
            settings[row.key] = JSON.parse(row.value);
        }
        catch {
            settings[row.key] = row.value;
        }
    }
    res.json({ settings });
});
router.put('/', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { key, value } = req.body;
    if (!key)
        return res.status(400).json({ error: 'Key is required' });
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
    database_1.db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(authReq.user.id, key, serialized);
    res.json({ success: true, key, value });
});
router.post('/bulk', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Settings object is required' });
    }
    const upsert = database_1.db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
    try {
        database_1.db.exec('BEGIN');
        for (const [key, value] of Object.entries(settings)) {
            const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
            upsert.run(authReq.user.id, key, serialized);
        }
        database_1.db.exec('COMMIT');
    }
    catch (err) {
        database_1.db.exec('ROLLBACK');
        console.error('Error saving settings:', err);
        return res.status(500).json({ error: 'Error saving settings' });
    }
    res.json({ success: true, updated: Object.keys(settings).length });
});
exports.default = router;
//# sourceMappingURL=settings.js.map