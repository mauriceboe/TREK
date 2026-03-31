"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
router.use(auth_1.authenticate, auth_1.adminOnly);
router.get('/users', (req, res) => {
    const users = database_1.db.prepare('SELECT id, username, email, role, created_at, updated_at, last_login FROM users ORDER BY created_at DESC').all();
    let onlineUserIds = new Set();
    try {
        const { getOnlineUserIds } = require('../websocket');
        onlineUserIds = getOnlineUserIds();
    }
    catch { /* */ }
    const usersWithStatus = users.map(u => ({ ...u, online: onlineUserIds.has(u.id) }));
    res.json({ users: usersWithStatus });
});
router.post('/users', (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username?.trim() || !email?.trim() || !password?.trim()) {
        return res.status(400).json({ error: 'Username, email and password are required' });
    }
    if (role && !['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    const existingUsername = database_1.db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existingUsername)
        return res.status(409).json({ error: 'Username already taken' });
    const existingEmail = database_1.db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
    if (existingEmail)
        return res.status(409).json({ error: 'Email already taken' });
    const passwordHash = bcryptjs_1.default.hashSync(password.trim(), 12);
    const result = database_1.db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run(username.trim(), email.trim(), passwordHash, role || 'user');
    const user = database_1.db.prepare('SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ user });
});
router.put('/users/:id', (req, res) => {
    const { username, email, role, password } = req.body;
    const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user)
        return res.status(404).json({ error: 'User not found' });
    if (role && !['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    if (username && username !== user.username) {
        const conflict = database_1.db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
        if (conflict)
            return res.status(409).json({ error: 'Username already taken' });
    }
    if (email && email !== user.email) {
        const conflict = database_1.db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
        if (conflict)
            return res.status(409).json({ error: 'Email already taken' });
    }
    const passwordHash = password ? bcryptjs_1.default.hashSync(password, 12) : null;
    database_1.db.prepare(`
    UPDATE users SET
      username = COALESCE(?, username),
      email = COALESCE(?, email),
      role = COALESCE(?, role),
      password_hash = COALESCE(?, password_hash),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(username || null, email || null, role || null, passwordHash, req.params.id);
    const updated = database_1.db.prepare('SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?').get(req.params.id);
    res.json({ user: updated });
});
router.delete('/users/:id', (req, res) => {
    const authReq = req;
    if (parseInt(req.params.id) === authReq.user.id) {
        return res.status(400).json({ error: 'Cannot delete own account' });
    }
    const user = database_1.db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user)
        return res.status(404).json({ error: 'User not found' });
    database_1.db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});
router.get('/stats', (_req, res) => {
    const totalUsers = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalTrips = database_1.db.prepare('SELECT COUNT(*) as count FROM trips').get().count;
    const totalPlaces = database_1.db.prepare('SELECT COUNT(*) as count FROM places').get().count;
    const totalFiles = database_1.db.prepare('SELECT COUNT(*) as count FROM trip_files').get().count;
    res.json({ totalUsers, totalTrips, totalPlaces, totalFiles });
});
router.get('/oidc', (_req, res) => {
    const get = (key) => database_1.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || '';
    const secret = get('oidc_client_secret');
    res.json({
        issuer: get('oidc_issuer'),
        client_id: get('oidc_client_id'),
        client_secret_set: !!secret,
        display_name: get('oidc_display_name'),
        oidc_only: get('oidc_only') === 'true',
    });
});
router.put('/oidc', (req, res) => {
    const { issuer, client_id, client_secret, display_name, oidc_only } = req.body;
    const set = (key, val) => database_1.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');
    set('oidc_issuer', issuer);
    set('oidc_client_id', client_id);
    if (client_secret !== undefined)
        set('oidc_client_secret', client_secret);
    set('oidc_display_name', display_name);
    set('oidc_only', oidc_only ? 'true' : 'false');
    res.json({ success: true });
});
router.post('/save-demo-baseline', (_req, res) => {
    if (process.env.DEMO_MODE !== 'true') {
        return res.status(404).json({ error: 'Not found' });
    }
    try {
        const { saveBaseline } = require('../demo/demo-reset');
        saveBaseline();
        res.json({ success: true, message: 'Demo baseline saved. Hourly resets will restore to this state.' });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save baseline' });
    }
});
const isDocker = (() => {
    try {
        return fs_1.default.existsSync('/.dockerenv') || (fs_1.default.existsSync('/proc/1/cgroup') && fs_1.default.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
    }
    catch {
        return false;
    }
})();
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na > nb)
            return 1;
        if (na < nb)
            return -1;
    }
    return 0;
}
router.get('/github-releases', async (req, res) => {
    const { per_page = '10', page = '1' } = req.query;
    try {
        const resp = await fetch(`https://api.github.com/repos/mauriceboe/TREK/releases?per_page=${per_page}&page=${page}`, { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } });
        if (!resp.ok)
            return res.json([]);
        const data = await resp.json();
        res.json(Array.isArray(data) ? data : []);
    }
    catch {
        res.json([]);
    }
});
router.get('/version-check', async (_req, res) => {
    const { version: currentVersion } = require('../../package.json');
    try {
        const resp = await fetch('https://api.github.com/repos/mauriceboe/TREK/releases/latest', { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } });
        if (!resp.ok)
            return res.json({ current: currentVersion, latest: currentVersion, update_available: false });
        const data = await resp.json();
        const latest = (data.tag_name || '').replace(/^v/, '');
        const update_available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
        res.json({ current: currentVersion, latest, update_available, release_url: data.html_url || '', is_docker: isDocker });
    }
    catch {
        res.json({ current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker });
    }
});
router.post('/update', async (_req, res) => {
    const rootDir = path_1.default.resolve(__dirname, '../../..');
    const serverDir = path_1.default.resolve(__dirname, '../..');
    const clientDir = path_1.default.join(rootDir, 'client');
    const steps = [];
    try {
        const pullOutput = (0, child_process_1.execSync)('git pull origin main', { cwd: rootDir, timeout: 60000, encoding: 'utf8' });
        steps.push({ step: 'git pull', success: true, output: pullOutput.trim() });
        (0, child_process_1.execSync)('npm install --production --ignore-scripts', { cwd: serverDir, timeout: 120000, encoding: 'utf8' });
        steps.push({ step: 'npm install (server)', success: true });
        if (process.env.NODE_ENV === 'production') {
            (0, child_process_1.execSync)('npm install --ignore-scripts', { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
            (0, child_process_1.execSync)('npm run build', { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
            steps.push({ step: 'npm install + build (client)', success: true });
        }
        delete require.cache[require.resolve('../../package.json')];
        const { version: newVersion } = require('../../package.json');
        steps.push({ step: 'version', version: newVersion });
        res.json({ success: true, steps, restarting: true });
        setTimeout(() => {
            console.log('[Update] Restarting after update...');
            process.exit(0);
        }, 1000);
    }
    catch (err) {
        console.error(err);
        steps.push({ step: 'error', success: false, output: 'Internal error' });
        res.status(500).json({ success: false, steps });
    }
});
// ── Invite Tokens ───────────────────────────────────────────────────────────
router.get('/invites', (_req, res) => {
    const invites = database_1.db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `).all();
    res.json({ invites });
});
router.post('/invites', (req, res) => {
    const authReq = req;
    const { max_uses, expires_in_days } = req.body;
    const rawUses = parseInt(max_uses);
    const uses = rawUses === 0 ? 0 : Math.min(Math.max(rawUses || 1, 1), 5);
    const token = crypto_1.default.randomBytes(16).toString('hex');
    const expiresAt = expires_in_days
        ? new Date(Date.now() + parseInt(expires_in_days) * 86400000).toISOString()
        : null;
    database_1.db.prepare('INSERT INTO invite_tokens (token, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?)').run(token, uses, expiresAt, authReq.user.id);
    const invite = database_1.db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    WHERE i.id = last_insert_rowid()
  `).get();
    res.status(201).json({ invite });
});
router.delete('/invites/:id', (_req, res) => {
    const invite = database_1.db.prepare('SELECT id FROM invite_tokens WHERE id = ?').get(_req.params.id);
    if (!invite)
        return res.status(404).json({ error: 'Invite not found' });
    database_1.db.prepare('DELETE FROM invite_tokens WHERE id = ?').run(_req.params.id);
    res.json({ success: true });
});
// ── Bag Tracking Setting ────────────────────────────────────────────────────
router.get('/bag-tracking', (_req, res) => {
    const row = database_1.db.prepare("SELECT value FROM app_settings WHERE key = 'bag_tracking_enabled'").get();
    res.json({ enabled: row?.value === 'true' });
});
router.put('/bag-tracking', (req, res) => {
    const { enabled } = req.body;
    database_1.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bag_tracking_enabled', ?)").run(enabled ? 'true' : 'false');
    res.json({ enabled: !!enabled });
});
// ── Packing Templates ───────────────────────────────────────────────────────
router.get('/packing-templates', (_req, res) => {
    const templates = database_1.db.prepare(`
    SELECT pt.*, u.username as created_by_name,
      (SELECT COUNT(*) FROM packing_template_items ti JOIN packing_template_categories tc ON ti.category_id = tc.id WHERE tc.template_id = pt.id) as item_count,
      (SELECT COUNT(*) FROM packing_template_categories WHERE template_id = pt.id) as category_count
    FROM packing_templates pt
    JOIN users u ON pt.created_by = u.id
    ORDER BY pt.created_at DESC
  `).all();
    res.json({ templates });
});
router.get('/packing-templates/:id', (_req, res) => {
    const template = database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(_req.params.id);
    if (!template)
        return res.status(404).json({ error: 'Template not found' });
    const categories = database_1.db.prepare('SELECT * FROM packing_template_categories WHERE template_id = ? ORDER BY sort_order, id').all(_req.params.id);
    const items = database_1.db.prepare(`
    SELECT ti.* FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ? ORDER BY ti.sort_order, ti.id
  `).all(_req.params.id);
    res.json({ template, categories, items });
});
router.post('/packing-templates', (req, res) => {
    const authReq = req;
    const { name } = req.body;
    if (!name?.trim())
        return res.status(400).json({ error: 'Name is required' });
    const result = database_1.db.prepare('INSERT INTO packing_templates (name, created_by) VALUES (?, ?)').run(name.trim(), authReq.user.id);
    const template = database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ template });
});
router.put('/packing-templates/:id', (req, res) => {
    const { name } = req.body;
    const template = database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id);
    if (!template)
        return res.status(404).json({ error: 'Template not found' });
    if (name?.trim())
        database_1.db.prepare('UPDATE packing_templates SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    res.json({ template: database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id) });
});
router.delete('/packing-templates/:id', (_req, res) => {
    const template = database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(_req.params.id);
    if (!template)
        return res.status(404).json({ error: 'Template not found' });
    database_1.db.prepare('DELETE FROM packing_templates WHERE id = ?').run(_req.params.id);
    res.json({ success: true });
});
// Template categories
router.post('/packing-templates/:id/categories', (req, res) => {
    const { name } = req.body;
    if (!name?.trim())
        return res.status(400).json({ error: 'Category name is required' });
    const template = database_1.db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id);
    if (!template)
        return res.status(404).json({ error: 'Template not found' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM packing_template_categories WHERE template_id = ?').get(req.params.id);
    const result = database_1.db.prepare('INSERT INTO packing_template_categories (template_id, name, sort_order) VALUES (?, ?, ?)').run(req.params.id, name.trim(), (maxOrder.max ?? -1) + 1);
    res.status(201).json({ category: database_1.db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(result.lastInsertRowid) });
});
router.put('/packing-templates/:templateId/categories/:catId', (req, res) => {
    const { name } = req.body;
    const cat = database_1.db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(req.params.catId, req.params.templateId);
    if (!cat)
        return res.status(404).json({ error: 'Category not found' });
    if (name?.trim())
        database_1.db.prepare('UPDATE packing_template_categories SET name = ? WHERE id = ?').run(name.trim(), req.params.catId);
    res.json({ category: database_1.db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(req.params.catId) });
});
router.delete('/packing-templates/:templateId/categories/:catId', (_req, res) => {
    const cat = database_1.db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(_req.params.catId, _req.params.templateId);
    if (!cat)
        return res.status(404).json({ error: 'Category not found' });
    database_1.db.prepare('DELETE FROM packing_template_categories WHERE id = ?').run(_req.params.catId);
    res.json({ success: true });
});
// Template items
router.post('/packing-templates/:templateId/categories/:catId/items', (req, res) => {
    const { name } = req.body;
    if (!name?.trim())
        return res.status(400).json({ error: 'Item name is required' });
    const cat = database_1.db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(req.params.catId, req.params.templateId);
    if (!cat)
        return res.status(404).json({ error: 'Category not found' });
    const maxOrder = database_1.db.prepare('SELECT MAX(sort_order) as max FROM packing_template_items WHERE category_id = ?').get(req.params.catId);
    const result = database_1.db.prepare('INSERT INTO packing_template_items (category_id, name, sort_order) VALUES (?, ?, ?)').run(req.params.catId, name.trim(), (maxOrder.max ?? -1) + 1);
    res.status(201).json({ item: database_1.db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(result.lastInsertRowid) });
});
router.put('/packing-templates/:templateId/items/:itemId', (req, res) => {
    const { name } = req.body;
    const item = database_1.db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(req.params.itemId);
    if (!item)
        return res.status(404).json({ error: 'Item not found' });
    if (name?.trim())
        database_1.db.prepare('UPDATE packing_template_items SET name = ? WHERE id = ?').run(name.trim(), req.params.itemId);
    res.json({ item: database_1.db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(req.params.itemId) });
});
router.delete('/packing-templates/:templateId/items/:itemId', (_req, res) => {
    const item = database_1.db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(_req.params.itemId);
    if (!item)
        return res.status(404).json({ error: 'Item not found' });
    database_1.db.prepare('DELETE FROM packing_template_items WHERE id = ?').run(_req.params.itemId);
    res.json({ success: true });
});
router.get('/addons', (_req, res) => {
    const addons = database_1.db.prepare('SELECT * FROM addons ORDER BY sort_order, id').all();
    res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled, config: JSON.parse(a.config || '{}') })) });
});
router.put('/addons/:id', (req, res) => {
    const addon = database_1.db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
    if (!addon)
        return res.status(404).json({ error: 'Addon not found' });
    const { enabled, config } = req.body;
    if (enabled !== undefined)
        database_1.db.prepare('UPDATE addons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
    if (config !== undefined)
        database_1.db.prepare('UPDATE addons SET config = ? WHERE id = ?').run(JSON.stringify(config), req.params.id);
    const updated = database_1.db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
    res.json({ addon: { ...updated, enabled: !!updated.enabled, config: JSON.parse(updated.config || '{}') } });
});
exports.default = router;
//# sourceMappingURL=admin.js.map