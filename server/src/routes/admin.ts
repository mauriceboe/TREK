import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from '../db/database';
import { authenticate, adminOnly } from '../middleware/auth';
import { AuthRequest, User, Addon } from '../types';
import { normalizeBetterAuthUsername } from '../lib/localUserBridge';
import { signUpBetterAuthEmail } from '../lib/betterAuth';
import { getAllPermissions, savePermissions, PERMISSION_ACTIONS, getPermissionLevel } from '../services/permissions';

const router = express.Router();

router.use(authenticate, adminOnly);

router.get('/users', (req: Request, res: Response) => {
  const users = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at, last_login FROM users ORDER BY created_at DESC'
  ).all() as Pick<User, 'id' | 'username' | 'email' | 'role' | 'created_at' | 'updated_at' | 'last_login'>[];
  let onlineUserIds = new Set<number>();
  try {
    const { getOnlineUserIds } = require('../websocket');
    onlineUserIds = getOnlineUserIds();
  } catch { /* */ }
  const usersWithStatus = users.map(u => ({ ...u, online: onlineUserIds.has(u.id) }));
  res.json({ users: usersWithStatus });
});

router.post('/users', async (req: Request, res: Response) => {
  const { username, email, password, role } = req.body;

  if (!username?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'Email already taken' });

  const passwordHash = bcrypt.hashSync(password.trim(), 12);
  let betterAuthUserId: string | null = null;
  try {
    const betterAuthResult = await signUpBetterAuthEmail({
      email: email.trim().toLowerCase(),
      password: password.trim(),
      name: username.trim(),
      username: normalizeBetterAuthUsername(username.trim()),
      displayUsername: username.trim(),
    });

    if (betterAuthResult.ok && betterAuthResult.data?.user) {
      betterAuthUserId = (betterAuthResult.data.user as { id?: string }).id || null;
    }
  } catch {
    betterAuthUserId = null;
  }

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, better_auth_user_id, role) VALUES (?, ?, ?, ?, ?)'
  ).run(username.trim(), email.trim().toLowerCase(), passwordHash, betterAuthUserId, role || 'user');

  const user = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ user });
});

router.put('/users/:id', (req: Request, res: Response) => {
  const { username, email, role, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as User | undefined;

  if (!user) return res.status(404).json({ error: 'User not found' });

  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (username && username !== user.username) {
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
    if (conflict) return res.status(409).json({ error: 'Username already taken' });
  }
  if (email && email !== user.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
    if (conflict) return res.status(409).json({ error: 'Email already taken' });
  }

  if (user.better_auth_user_id && (username || email || password)) {
    return res.status(400).json({ error: 'Admin edits for Convex Better Auth users are not supported from this panel yet.' });
  }

  const passwordHash = password ? bcrypt.hashSync(password, 12) : null;

  db.prepare(`
    UPDATE users SET
      username = COALESCE(?, username),
      email = COALESCE(?, email),
      role = COALESCE(?, role),
      password_hash = COALESCE(?, password_hash),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(username || null, email || null, role || null, passwordHash, req.params.id);

  const updated = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(req.params.id);

  res.json({ user: updated });
});

router.delete('/users/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (parseInt(userIdParam, 10) === authReq.user.id) {
    return res.status(400).json({ error: 'Cannot delete own account' });
  }

  const user = db.prepare('SELECT id, better_auth_user_id FROM users WHERE id = ?').get(userIdParam) as Pick<User, 'id' | 'better_auth_user_id'> | undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.better_auth_user_id) {
    return res.status(400).json({ error: 'Admin deletion for Convex Better Auth users is not supported from this panel yet.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userIdParam);
  res.json({ success: true });
});

router.get('/stats', (_req: Request, res: Response) => {
  const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const totalTrips = (db.prepare('SELECT COUNT(*) as count FROM trips').get() as { count: number }).count;
  const totalPlaces = (db.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number }).count;
  const totalFiles = (db.prepare('SELECT COUNT(*) as count FROM trip_files').get() as { count: number }).count;

  res.json({ totalUsers, totalTrips, totalPlaces, totalFiles });
});

router.get('/permissions', (_req: Request, res: Response) => {
  res.json({
    permissions: PERMISSION_ACTIONS.map(action => ({
      key: action.key,
      level: getPermissionLevel(action.key),
      defaultLevel: action.defaultLevel,
      allowedLevels: action.allowedLevels,
    })),
  });
});

router.put('/permissions', (req: Request, res: Response) => {
  if (!req.body || typeof req.body.permissions !== 'object' || req.body.permissions === null) {
    return res.status(400).json({ error: 'permissions object is required' });
  }

  const raw = req.body.permissions as any;
  const normalized = Array.isArray(raw)
    ? Object.fromEntries(raw.map((entry: any) => [entry.key, entry.level]))
    : Array.isArray(raw.permissions)
      ? Object.fromEntries(raw.permissions.map((entry: any) => [entry.key, entry.level]))
      : raw;

  const result = savePermissions(normalized as Record<string, string>);
  res.json({
    permissions: PERMISSION_ACTIONS.map(action => ({
      key: action.key,
      level: getPermissionLevel(action.key),
      defaultLevel: action.defaultLevel,
      allowedLevels: action.allowedLevels,
    })),
    skipped: result.skipped,
  });
});

router.post('/rotate-jwt-secret', (_req: Request, res: Response) => {
  res.json({ success: true });
});

router.get('/oidc', (_req: Request, res: Response) => {
  const get = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || '';
  const secret = get('oidc_client_secret');
  res.json({
    issuer: get('oidc_issuer'),
    client_id: get('oidc_client_id'),
    client_secret_set: !!secret,
    display_name: get('oidc_display_name'),
    oidc_only: get('oidc_only') === 'true',
  });
});

router.put('/oidc', (req: Request, res: Response) => {
  const { issuer, client_id, client_secret, display_name, oidc_only } = req.body;
  const set = (key: string, val: string) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');
  set('oidc_issuer', issuer);
  set('oidc_client_id', client_id);
  if (client_secret !== undefined) set('oidc_client_secret', client_secret);
  set('oidc_display_name', display_name);
  set('oidc_only', oidc_only ? 'true' : 'false');
  res.json({ success: true });
});

router.post('/save-demo-baseline', (_req: Request, res: Response) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { saveBaseline } = require('../demo/demo-reset');
    saveBaseline();
    res.json({ success: true, message: 'Demo baseline saved. Hourly resets will restore to this state.' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save baseline' });
  }
});

const isDocker = (() => {
  try {
    return fs.existsSync('/.dockerenv') || (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
  } catch { return false }
})();
const canAdminSelfUpdate = process.env.ENABLE_ADMIN_UPDATE === 'true' && !isDocker;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

router.get('/github-releases', async (req: Request, res: Response) => {
  const { per_page = '10', page = '1' } = req.query;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/mauriceboe/TREK/releases?per_page=${per_page}&page=${page}`,
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } }
    );
    if (!resp.ok) return res.json([]);
    const data = await resp.json();
    res.json(Array.isArray(data) ? data : []);
  } catch {
    res.json([]);
  }
});

router.get('/version-check', async (_req: Request, res: Response) => {
  const { version: currentVersion } = require('../../package.json');
  try {
    const resp = await fetch(
      'https://api.github.com/repos/mauriceboe/TREK/releases/latest',
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } }
    );
    if (!resp.ok) return res.json({ current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker, can_update: canAdminSelfUpdate });
    const data = await resp.json() as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name || '').replace(/^v/, '');
    const update_available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
    res.json({ current: currentVersion, latest, update_available, release_url: data.html_url || '', is_docker: isDocker, can_update: canAdminSelfUpdate });
  } catch {
    res.json({ current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker, can_update: canAdminSelfUpdate });
  }
});

router.post('/update', async (_req: Request, res: Response) => {
  if (!canAdminSelfUpdate) {
    return res.status(403).json({ error: 'Automatic self-update is disabled on this deployment.' });
  }

  const rootDir = path.resolve(__dirname, '../../..');
  const serverDir = path.resolve(__dirname, '../..');
  const clientDir = path.join(rootDir, 'client');
  const steps: { step: string; success?: boolean; output?: string; version?: string }[] = [];

  try {
    const pullOutput = execSync('git pull origin main', { cwd: rootDir, timeout: 60000, encoding: 'utf8' });
    steps.push({ step: 'git pull', success: true, output: pullOutput.trim() });

    execSync('npm install --production --ignore-scripts', { cwd: serverDir, timeout: 120000, encoding: 'utf8' });
    steps.push({ step: 'npm install (server)', success: true });

    if (process.env.NODE_ENV === 'production') {
      execSync('npm install --ignore-scripts', { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
      execSync('npm run build', { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
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
  } catch (err: unknown) {
    console.error(err);
    steps.push({ step: 'error', success: false, output: 'Internal error' });
    res.status(500).json({ success: false, steps });
  }
});

// ── Audit Log ───────────────────────────────────────────────────────────────

router.get('/audit-log', (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number }).count;
  const entries = db.prepare(`
    SELECT a.id, a.user_id, a.action, a.resource, a.details, a.ip, a.created_at,
           u.username, u.email
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({ entries, total, page, limit });
});

// ── Active Sessions ─────────────────────────────────────────────────────────

router.get('/sessions', (_req: Request, res: Response) => {
  const sessions = db.prepare(`
    SELECT s.id, s.createdAt, s.updatedAt, s.expiresAt, s.ipAddress, s.userAgent, s.userId,
           bau.name, bau.email,
           u.username, u.role
    FROM better_auth_sessions s
    JOIN better_auth_users bau ON s.userId = bau.id
    LEFT JOIN users u ON u.better_auth_user_id = bau.id
    WHERE s.expiresAt > datetime('now')
    ORDER BY s.updatedAt DESC
  `).all();

  res.json({ sessions });
});

// ── Invite Tokens ───────────────────────────────────────────────────────────

router.get('/invites', (_req: Request, res: Response) => {
  const invites = db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `).all();
  res.json({ invites });
});

router.post('/invites', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { max_uses, expires_in_days } = req.body;

  const rawUses = parseInt(max_uses);
  const uses = rawUses === 0 ? 0 : Math.min(Math.max(rawUses || 1, 1), 5);
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = expires_in_days
    ? new Date(Date.now() + parseInt(expires_in_days) * 86400000).toISOString()
    : null;

  db.prepare(
    'INSERT INTO invite_tokens (token, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(token, uses, expiresAt, authReq.user.id);

  const invite = db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    WHERE i.id = last_insert_rowid()
  `).get();

  res.status(201).json({ invite });
});

router.delete('/invites/:id', (_req: Request, res: Response) => {
  const invite = db.prepare('SELECT id FROM invite_tokens WHERE id = ?').get(_req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  db.prepare('DELETE FROM invite_tokens WHERE id = ?').run(_req.params.id);
  res.json({ success: true });
});

// ── Bag Tracking Setting ────────────────────────────────────────────────────

router.get('/bag-tracking', (_req: Request, res: Response) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'bag_tracking_enabled'").get() as { value: string } | undefined;
  res.json({ enabled: row?.value === 'true' });
});

router.put('/bag-tracking', (req: Request, res: Response) => {
  const { enabled } = req.body;
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bag_tracking_enabled', ?)").run(enabled ? 'true' : 'false');
  res.json({ enabled: !!enabled });
});

// ── Packing Templates ───────────────────────────────────────────────────────

router.get('/packing-templates', (_req: Request, res: Response) => {
  const templates = db.prepare(`
    SELECT pt.*, u.username as created_by_name,
      (SELECT COUNT(*) FROM packing_template_items ti JOIN packing_template_categories tc ON ti.category_id = tc.id WHERE tc.template_id = pt.id) as item_count,
      (SELECT COUNT(*) FROM packing_template_categories WHERE template_id = pt.id) as category_count
    FROM packing_templates pt
    JOIN users u ON pt.created_by = u.id
    ORDER BY pt.created_at DESC
  `).all();
  res.json({ templates });
});

router.get('/packing-templates/:id', (_req: Request, res: Response) => {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(_req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const categories = db.prepare('SELECT * FROM packing_template_categories WHERE template_id = ? ORDER BY sort_order, id').all(_req.params.id) as any[];
  const items = db.prepare(`
    SELECT ti.* FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ? ORDER BY ti.sort_order, ti.id
  `).all(_req.params.id);
  res.json({ template, categories, items });
});

router.post('/packing-templates', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const result = db.prepare('INSERT INTO packing_templates (name, created_by) VALUES (?, ?)').run(name.trim(), authReq.user.id);
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ template });
});

router.put('/packing-templates/:id', (req: Request, res: Response) => {
  const { name } = req.body;
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  if (name?.trim()) db.prepare('UPDATE packing_templates SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ template: db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id) });
});

router.delete('/packing-templates/:id', (_req: Request, res: Response) => {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(_req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  db.prepare('DELETE FROM packing_templates WHERE id = ?').run(_req.params.id);
  res.json({ success: true });
});

// Template categories
router.post('/packing-templates/:id/categories', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Category name is required' });
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_template_categories WHERE template_id = ?').get(req.params.id) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_template_categories (template_id, name, sort_order) VALUES (?, ?, ?)').run(req.params.id, name.trim(), (maxOrder.max ?? -1) + 1);
  res.status(201).json({ category: db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/packing-templates/:templateId/categories/:catId', (req: Request, res: Response) => {
  const { name } = req.body;
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(req.params.catId, req.params.templateId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  if (name?.trim()) db.prepare('UPDATE packing_template_categories SET name = ? WHERE id = ?').run(name.trim(), req.params.catId);
  res.json({ category: db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(req.params.catId) });
});

router.delete('/packing-templates/:templateId/categories/:catId', (_req: Request, res: Response) => {
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(_req.params.catId, _req.params.templateId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  db.prepare('DELETE FROM packing_template_categories WHERE id = ?').run(_req.params.catId);
  res.json({ success: true });
});

// Template items
router.post('/packing-templates/:templateId/categories/:catId/items', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(req.params.catId, req.params.templateId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_template_items WHERE category_id = ?').get(req.params.catId) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_template_items (category_id, name, sort_order) VALUES (?, ?, ?)').run(req.params.catId, name.trim(), (maxOrder.max ?? -1) + 1);
  res.status(201).json({ item: db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/packing-templates/:templateId/items/:itemId', (req: Request, res: Response) => {
  const { name } = req.body;
  const item = db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (name?.trim()) db.prepare('UPDATE packing_template_items SET name = ? WHERE id = ?').run(name.trim(), req.params.itemId);
  res.json({ item: db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(req.params.itemId) });
});

router.delete('/packing-templates/:templateId/items/:itemId', (_req: Request, res: Response) => {
  const item = db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(_req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM packing_template_items WHERE id = ?').run(_req.params.itemId);
  res.json({ success: true });
});

router.get('/addons', (_req: Request, res: Response) => {
  const addons = db.prepare('SELECT * FROM addons ORDER BY sort_order, id').all() as Addon[];
  res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled, config: JSON.parse(a.config || '{}') })) });
});

router.put('/addons/:id', (req: Request, res: Response) => {
  const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
  if (!addon) return res.status(404).json({ error: 'Addon not found' });
  const { enabled, config } = req.body;
  if (enabled !== undefined) db.prepare('UPDATE addons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  if (config !== undefined) db.prepare('UPDATE addons SET config = ? WHERE id = ?').run(JSON.stringify(config), req.params.id);
  const updated = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id) as Addon;
  res.json({ addon: { ...updated, enabled: !!updated.enabled, config: JSON.parse(updated.config || '{}') } });
});

export default router;
