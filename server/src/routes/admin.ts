import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../db/database';
import { authenticate, adminOnly } from '../middleware/auth';
import { AuthRequest, User, Addon } from '../types';
import { writeAudit, getClientIp, logInfo } from '../services/auditLog';
import { getAllPermissions, savePermissions, PERMISSION_ACTIONS } from '../services/permissions';
import { revokeUserSessions } from '../mcp';
import { maybe_encrypt_api_key, decrypt_api_key } from '../services/apiKeyCrypto';
import { validatePassword } from '../services/passwordPolicy';
import { updateJwtSecret } from '../config';

const router = express.Router();

router.use(authenticate, adminOnly);

function utcSuffix(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
}

router.get('/users', (req: Request, res: Response) => {
  const users = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at, last_login FROM users ORDER BY created_at DESC'
  ).all() as Pick<User, 'id' | 'username' | 'email' | 'role' | 'created_at' | 'updated_at' | 'last_login'>[];
  let onlineUserIds = new Set<number>();
  try {
    const { getOnlineUserIds } = require('../websocket');
    onlineUserIds = getOnlineUserIds();
  } catch { /* */ }
  const usersWithStatus = users.map(u => ({
    ...u,
    created_at: utcSuffix(u.created_at),
    updated_at: utcSuffix(u.updated_at as string),
    last_login: utcSuffix(u.last_login),
    online: onlineUserIds.has(u.id),
  }));
  res.json({ users: usersWithStatus });
});

router.post('/users', (req: Request, res: Response) => {
  const { username, email, password, role } = req.body;

  if (!username?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  const pwCheck = validatePassword(password.trim());
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });

  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'Email already taken' });

  const passwordHash = bcrypt.hashSync(password.trim(), 12);

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(username.trim(), email.trim(), passwordHash, role || 'user');

  const user = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_create',
    resource: String(result.lastInsertRowid),
    ip: getClientIp(req),
    details: { username: username.trim(), email: email.trim(), role: role || 'user' },
  });
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

  if (password) {
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });
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

  const authReq = req as AuthRequest;
  const changed: string[] = [];
  if (username) changed.push('username');
  if (email) changed.push('email');
  if (role) changed.push('role');
  if (password) changed.push('password');
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_update',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { targetUser: user.email, fields: changed },
  });
  logInfo(`Admin ${authReq.user.email} edited user ${user.email} (fields: ${changed.join(', ')})`);
  res.json({ user: updated });
});

router.delete('/users/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (parseInt(req.params.id as string) === authReq.user.id) {
    return res.status(400).json({ error: 'Cannot delete own account' });
  }

  const userToDel = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id) as { id: number; email: string } | undefined;
  if (!userToDel) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.user_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { targetUser: userToDel.email },
  });
  logInfo(`Admin ${authReq.user.email} deleted user ${userToDel.email}`);
  res.json({ success: true });
});

router.get('/stats', (_req: Request, res: Response) => {
  const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const totalTrips = (db.prepare('SELECT COUNT(*) as count FROM trips').get() as { count: number }).count;
  const totalPlaces = (db.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number }).count;
  const totalFiles = (db.prepare('SELECT COUNT(*) as count FROM trip_files').get() as { count: number }).count;

  res.json({ totalUsers, totalTrips, totalPlaces, totalFiles });
});

// Permissions management
router.get('/permissions', (_req: Request, res: Response) => {
  const current = getAllPermissions();
  const actions = PERMISSION_ACTIONS.map(a => ({
    key: a.key,
    level: current[a.key],
    defaultLevel: a.defaultLevel,
    allowedLevels: a.allowedLevels,
  }));
  res.json({ permissions: actions });
});

router.put('/permissions', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'permissions object required' });
  }
  const { skipped } = savePermissions(permissions);
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.permissions_update',
    resource: 'permissions',
    ip: getClientIp(req),
    details: permissions,
  });
  res.json({ success: true, permissions: getAllPermissions(), ...(skipped.length ? { skipped } : {}) });
});

router.get('/audit-log', (req: Request, res: Response) => {
  const limitRaw = parseInt(String(req.query.limit || '100'), 10);
  const offsetRaw = parseInt(String(req.query.offset || '0'), 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  type Row = {
    id: number;
    created_at: string;
    user_id: number | null;
    username: string | null;
    user_email: string | null;
    action: string;
    resource: string | null;
    details: string | null;
    ip: string | null;
  };
  const rows = db.prepare(`
    SELECT a.id, a.created_at, a.user_id, u.username, u.email as user_email, a.action, a.resource, a.details, a.ip
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Row[];
  const total = (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
  res.json({
    entries: rows.map((r) => {
      let details: Record<string, unknown> | null = null;
      if (r.details) {
        try {
          details = JSON.parse(r.details) as Record<string, unknown>;
        } catch {
          details = { _parse_error: true };
        }
      }
      const created_at = r.created_at && !r.created_at.endsWith('Z') ? r.created_at.replace(' ', 'T') + 'Z' : r.created_at;
      return { ...r, created_at, details };
    }),
    total,
    limit,
    offset,
  });
});

router.get('/oidc', (_req: Request, res: Response) => {
  const get = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || '';
  const secret = decrypt_api_key(get('oidc_client_secret'));
  res.json({
    issuer: get('oidc_issuer'),
    client_id: get('oidc_client_id'),
    client_secret_set: !!secret,
    display_name: get('oidc_display_name'),
    oidc_only: get('oidc_only') === 'true',
    discovery_url: get('oidc_discovery_url'),
  });
});

router.put('/oidc', (req: Request, res: Response) => {
  const { issuer, client_id, client_secret, display_name, oidc_only, discovery_url } = req.body;
  const set = (key: string, val: string) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');
  set('oidc_issuer', issuer);
  set('oidc_client_id', client_id);
  if (client_secret !== undefined) set('oidc_client_secret', maybe_encrypt_api_key(client_secret) ?? '');
  set('oidc_display_name', display_name);
  set('oidc_only', oidc_only ? 'true' : 'false');
  set('oidc_discovery_url', discovery_url);
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.oidc_update',
    ip: getClientIp(req),
    details: { oidc_only: !!oidc_only, issuer_set: !!issuer },
  });
  res.json({ success: true });
});

router.post('/save-demo-baseline', (req: Request, res: Response) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { saveBaseline } = require('../demo/demo-reset');
    saveBaseline();
    const authReq = req as AuthRequest;
    writeAudit({ userId: authReq.user.id, action: 'admin.demo_baseline_save', ip: getClientIp(req) });
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
    if (!resp.ok) return res.json({ current: currentVersion, latest: currentVersion, update_available: false });
    const data = await resp.json() as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name || '').replace(/^v/, '');
    const update_available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
    res.json({ current: currentVersion, latest, update_available, release_url: data.html_url || '', is_docker: isDocker });
  } catch {
    res.json({ current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker });
  }
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

  const ins = db.prepare(
    'INSERT INTO invite_tokens (token, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(token, uses, expiresAt, authReq.user.id);

  const inviteId = Number(ins.lastInsertRowid);
  const invite = db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    WHERE i.id = ?
  `).get(inviteId);

  writeAudit({
    userId: authReq.user.id,
    action: 'admin.invite_create',
    resource: String(inviteId),
    ip: getClientIp(req),
    details: { max_uses: uses, expires_in_days: expires_in_days ?? null },
  });
  res.status(201).json({ invite });
});

router.delete('/invites/:id', (req: Request, res: Response) => {
  const invite = db.prepare('SELECT id FROM invite_tokens WHERE id = ?').get(req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  db.prepare('DELETE FROM invite_tokens WHERE id = ?').run(req.params.id);
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.invite_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
  });
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
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.bag_tracking',
    ip: getClientIp(req),
    details: { enabled: !!enabled },
  });
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

router.delete('/packing-templates/:id', (req: Request, res: Response) => {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  db.prepare('DELETE FROM packing_templates WHERE id = ?').run(req.params.id);
  const authReq = req as AuthRequest;
  const t = template as { name?: string };
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.packing_template_delete',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { name: t.name },
  });
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
  const authReq = req as AuthRequest;
  writeAudit({
    userId: authReq.user.id,
    action: 'admin.addon_update',
    resource: String(req.params.id),
    ip: getClientIp(req),
    details: { enabled: enabled !== undefined ? !!enabled : undefined, config_changed: config !== undefined },
  });
  res.json({ addon: { ...updated, enabled: !!updated.enabled, config: JSON.parse(updated.config || '{}') } });
});

router.get('/mcp-tokens', (req: Request, res: Response) => {
  const tokens = db.prepare(`
    SELECT t.id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.user_id, u.username
    FROM mcp_tokens t
    JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC
  `).all();
  res.json({ tokens });
});

router.delete('/mcp-tokens/:id', (req: Request, res: Response) => {
  const token = db.prepare('SELECT id, user_id FROM mcp_tokens WHERE id = ?').get(req.params.id) as { id: number; user_id: number } | undefined;
  if (!token) return res.status(404).json({ error: 'Token not found' });
  db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(req.params.id);
  revokeUserSessions(token.user_id);
  res.json({ success: true });
});

router.post('/rotate-jwt-secret', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const newSecret = crypto.randomBytes(32).toString('hex');
  const dataDir = path.resolve(__dirname, '../../data');
  const secretFile = path.join(dataDir, '.jwt_secret');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, newSecret, { mode: 0o600 });
  } catch (err: unknown) {
    return res.status(500).json({ error: 'Failed to persist new JWT secret to disk' });
  }
  updateJwtSecret(newSecret);
  writeAudit({
    user_id: authReq.user?.id ?? null,
    username: authReq.user?.username ?? 'unknown',
    action: 'admin.rotate_jwt_secret',
    target_type: 'system',
    target_id: null,
    details: null,
    ip: getClientIp(req),
  });
  res.json({ success: true });
});

export default router;
