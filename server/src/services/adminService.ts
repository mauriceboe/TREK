import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../db/database';
import { User, Addon } from '../types';
import { updateJwtSecret } from '../config';
import { maybe_encrypt_api_key, decrypt_api_key } from './apiKeyCrypto';
import { getAllPermissions, savePermissions as savePerms, PERMISSION_ACTIONS } from './permissions';
import { revokeUserSessions } from '../mcp';
import { validatePassword } from './passwordPolicy';
import { getPhotoProviderConfig } from './memories/helpersService';
import { send as sendNotification } from './notificationService';

// ── Helpers ────────────────────────────────────────────────────────────────

export function utcSuffix(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export const isDocker = (() => {
  try {
    return fs.existsSync('/.dockerenv') || (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
  } catch { return false; }
})();

// ── User CRUD ──────────────────────────────────────────────────────────────

export function listUsers() {
  const users = db.prepare(
    'SELECT id, username, email, role, avatar, created_at, updated_at, last_login FROM users ORDER BY created_at DESC'
  ).all() as (Pick<User, 'id' | 'username' | 'email' | 'role' | 'created_at' | 'updated_at' | 'last_login'> & { avatar?: string | null })[];
  let onlineUserIds = new Set<number>();
  try {
    const { getOnlineUserIds } = require('../websocket');
    onlineUserIds = getOnlineUserIds();
  } catch { /* */ }
  return users.map(u => ({
    ...u,
    avatar_url: u.avatar ? `/uploads/avatars/${u.avatar}` : null,
    created_at: utcSuffix(u.created_at),
    updated_at: utcSuffix(u.updated_at as string),
    last_login: utcSuffix(u.last_login),
    online: onlineUserIds.has(u.id),
  }));
}

export function createUser(data: { username: string; email: string; password: string; role?: string }) {
  const username = data.username?.trim();
  const email = data.email?.trim();
  const password = data.password?.trim();

  if (!username || !email || !password) {
    return { error: 'Username, email and password are required', status: 400 };
  }

  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };

  if (data.role && !['user', 'admin'].includes(data.role)) {
    return { error: 'Invalid role', status: 400 };
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUsername) return { error: 'Username already taken', status: 409 };

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingEmail) return { error: 'Email already taken', status: 409 };

  const passwordHash = bcrypt.hashSync(password, 12);

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(username, email, passwordHash, data.role || 'user');

  const user = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  return {
    user,
    insertedId: Number(result.lastInsertRowid),
    auditDetails: { username, email, role: data.role || 'user' },
  };
}

export function updateUser(id: string, data: { username?: string; email?: string; role?: string; password?: string }) {
  const { username, email, role, password } = data;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;

  if (!user) return { error: 'User not found', status: 404 };

  if (role && !['user', 'admin'].includes(role)) {
    return { error: 'Invalid role', status: 400 };
  }

  if (username && username !== user.username) {
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
    if (conflict) return { error: 'Username already taken', status: 409 };
  }
  if (email && email !== user.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, id);
    if (conflict) return { error: 'Email already taken', status: 409 };
  }

  if (password) {
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };
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
  `).run(username || null, email || null, role || null, passwordHash, id);

  const updated = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(id);

  const changed: string[] = [];
  if (username) changed.push('username');
  if (email) changed.push('email');
  if (role) changed.push('role');
  if (password) changed.push('password');

  return {
    user: updated,
    previousEmail: user.email,
    changed,
  };
}

export function deleteUser(id: string, currentUserId: number) {
  if (parseInt(id) === currentUserId) {
    return { error: 'Cannot delete own account', status: 400 };
  }

  const userToDel = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as { id: number; email: string } | undefined;
  if (!userToDel) return { error: 'User not found', status: 404 };

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { email: userToDel.email };
}

// ── Stats ──────────────────────────────────────────────────────────────────

export function getStats() {
  const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const totalTrips = (db.prepare('SELECT COUNT(*) as count FROM trips').get() as { count: number }).count;
  const totalPlaces = (db.prepare('SELECT COUNT(*) as count FROM places').get() as { count: number }).count;
  const totalFiles = (db.prepare('SELECT COUNT(*) as count FROM trip_files').get() as { count: number }).count;
  return { totalUsers, totalTrips, totalPlaces, totalFiles };
}

// ── Permissions ────────────────────────────────────────────────────────────

export function getPermissions() {
  const current = getAllPermissions();
  const actions = PERMISSION_ACTIONS.map(a => ({
    key: a.key,
    level: current[a.key],
    defaultLevel: a.defaultLevel,
    allowedLevels: a.allowedLevels,
  }));
  return { permissions: actions };
}

export function savePermissions(permissions: Record<string, string>) {
  const { skipped } = savePerms(permissions);
  return { permissions: getAllPermissions(), skipped };
}

// ── Audit Log ──────────────────────────────────────────────────────────────

export function getAuditLog(query: { limit?: string; offset?: string }) {
  const limitRaw = parseInt(String(query.limit || '100'), 10);
  const offsetRaw = parseInt(String(query.offset || '0'), 10);
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

  const entries = rows.map((r) => {
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
  });

  return { entries, total, limit, offset };
}

// ── OIDC Settings ──────────────────────────────────────────────────────────

export function getOidcSettings() {
  const get = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || '';
  const secret = decrypt_api_key(get('oidc_client_secret'));
  return {
    issuer: get('oidc_issuer'),
    client_id: get('oidc_client_id'),
    client_secret_set: !!secret,
    display_name: get('oidc_display_name'),
    oidc_only: get('oidc_only') === 'true',
    discovery_url: get('oidc_discovery_url'),
  };
}

export function updateOidcSettings(data: {
  issuer?: string;
  client_id?: string;
  client_secret?: string;
  display_name?: string;
  oidc_only?: boolean;
  discovery_url?: string;
}) {
  const set = (key: string, val: string) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');
  set('oidc_issuer', data.issuer ?? '');
  set('oidc_client_id', data.client_id ?? '');
  if (data.client_secret !== undefined) set('oidc_client_secret', maybe_encrypt_api_key(data.client_secret) ?? '');
  set('oidc_display_name', data.display_name ?? '');
  set('oidc_only', data.oidc_only ? 'true' : 'false');
  set('oidc_discovery_url', data.discovery_url ?? '');
}

// ── Demo Baseline ──────────────────────────────────────────────────────────

export function saveDemoBaseline(): { error?: string; status?: number; message?: string } {
  if (process.env.DEMO_MODE !== 'true') {
    return { error: 'Not found', status: 404 };
  }
  try {
    const { saveBaseline } = require('../demo/demo-reset');
    saveBaseline();
    return { message: 'Demo baseline saved. Hourly resets will restore to this state.' };
  } catch (err: unknown) {
    console.error(err);
    return { error: 'Failed to save baseline', status: 500 };
  }
}

// ── GitHub Integration ─────────────────────────────────────────────────────

export async function getGithubReleases(perPage: string = '10', page: string = '1') {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/mauriceboe/TREK/releases?per_page=${perPage}&page=${page}`,
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function checkVersion() {
  const { version: currentVersion } = require('../../package.json');
  try {
    const resp = await fetch(
      'https://api.github.com/repos/mauriceboe/TREK/releases/latest',
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } }
    );
    if (!resp.ok) return { current: currentVersion, latest: currentVersion, update_available: false };
    const data = await resp.json() as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name || '').replace(/^v/, '');
    const update_available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
    return { current: currentVersion, latest, update_available, release_url: data.html_url || '', is_docker: isDocker };
  } catch {
    return { current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker };
  }
}

export async function checkAndNotifyVersion(): Promise<void> {
  try {
    const result = await checkVersion();
    if (!result.update_available) return;

    const lastNotified = (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('last_notified_version') as { value: string } | undefined)?.value;
    if (lastNotified === result.latest) return;

    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('last_notified_version', result.latest);

    await sendNotification({
      event: 'version_available',
      actorId: null,
      scope: 'admin',
      targetId: 0,
      params: { version: result.latest as string },
    });
  } catch {
    // Silently ignore — version check is non-critical
  }
}

// ── Invite Tokens ──────────────────────────────────────────────────────────

export function listInvites() {
  return db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `).all();
}

export function createInvite(createdBy: number, data: { max_uses?: string | number; expires_in_days?: string | number }) {
  const rawUses = parseInt(String(data.max_uses));
  const uses = rawUses === 0 ? 0 : Math.min(Math.max(rawUses || 1, 1), 5);
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = data.expires_in_days
    ? new Date(Date.now() + parseInt(String(data.expires_in_days)) * 86400000).toISOString()
    : null;

  const ins = db.prepare(
    'INSERT INTO invite_tokens (token, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(token, uses, expiresAt, createdBy);

  const inviteId = Number(ins.lastInsertRowid);
  const invite = db.prepare(`
    SELECT i.*, u.username as created_by_name
    FROM invite_tokens i
    JOIN users u ON i.created_by = u.id
    WHERE i.id = ?
  `).get(inviteId);

  return { invite, inviteId, uses, expiresInDays: data.expires_in_days ?? null };
}

export function deleteInvite(id: string) {
  const invite = db.prepare('SELECT id FROM invite_tokens WHERE id = ?').get(id);
  if (!invite) return { error: 'Invite not found', status: 404 };
  db.prepare('DELETE FROM invite_tokens WHERE id = ?').run(id);
  return {};
}

// ── Bag Tracking ───────────────────────────────────────────────────────────

export function getBagTracking() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'bag_tracking_enabled'").get() as { value: string } | undefined;
  return { enabled: row?.value === 'true' };
}

export function updateBagTracking(enabled: boolean) {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bag_tracking_enabled', ?)").run(enabled ? 'true' : 'false');
  return { enabled: !!enabled };
}

// ── Packing Templates ──────────────────────────────────────────────────────

export function listPackingTemplates() {
  return db.prepare(`
    SELECT pt.*, u.username as created_by_name,
      (SELECT COUNT(*) FROM packing_template_items ti JOIN packing_template_categories tc ON ti.category_id = tc.id WHERE tc.template_id = pt.id) as item_count,
      (SELECT COUNT(*) FROM packing_template_categories WHERE template_id = pt.id) as category_count
    FROM packing_templates pt
    JOIN users u ON pt.created_by = u.id
    ORDER BY pt.created_at DESC
  `).all();
}

export function getPackingTemplate(id: string) {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(id);
  if (!template) return { error: 'Template not found', status: 404 };
  const categories = db.prepare('SELECT * FROM packing_template_categories WHERE template_id = ? ORDER BY sort_order, id').all(id) as any[];
  const items = db.prepare(`
    SELECT ti.* FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ? ORDER BY ti.sort_order, ti.id
  `).all(id);
  return { template, categories, items };
}

export function createPackingTemplate(name: string, createdBy: number) {
  if (!name?.trim()) return { error: 'Name is required', status: 400 };
  const result = db.prepare('INSERT INTO packing_templates (name, created_by) VALUES (?, ?)').run(name.trim(), createdBy);
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(result.lastInsertRowid);
  return { template };
}

export function updatePackingTemplate(id: string, data: { name?: string }) {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(id);
  if (!template) return { error: 'Template not found', status: 404 };
  if (data.name?.trim()) db.prepare('UPDATE packing_templates SET name = ? WHERE id = ?').run(data.name.trim(), id);
  return { template: db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(id) };
}

export function deletePackingTemplate(id: string) {
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(id) as { name?: string } | undefined;
  if (!template) return { error: 'Template not found', status: 404 };
  db.prepare('DELETE FROM packing_templates WHERE id = ?').run(id);
  return { name: template.name };
}

// Template categories

export function createTemplateCategory(templateId: string, name: string) {
  if (!name?.trim()) return { error: 'Category name is required', status: 400 };
  const template = db.prepare('SELECT * FROM packing_templates WHERE id = ?').get(templateId);
  if (!template) return { error: 'Template not found', status: 404 };
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_template_categories WHERE template_id = ?').get(templateId) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_template_categories (template_id, name, sort_order) VALUES (?, ?, ?)').run(templateId, name.trim(), (maxOrder.max ?? -1) + 1);
  return { category: db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(result.lastInsertRowid) };
}

export function updateTemplateCategory(templateId: string, catId: string, data: { name?: string }) {
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(catId, templateId);
  if (!cat) return { error: 'Category not found', status: 404 };
  if (data.name?.trim()) db.prepare('UPDATE packing_template_categories SET name = ? WHERE id = ?').run(data.name.trim(), catId);
  return { category: db.prepare('SELECT * FROM packing_template_categories WHERE id = ?').get(catId) };
}

export function deleteTemplateCategory(templateId: string, catId: string) {
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(catId, templateId);
  if (!cat) return { error: 'Category not found', status: 404 };
  db.prepare('DELETE FROM packing_template_categories WHERE id = ?').run(catId);
  return {};
}

// Template items

export function createTemplateItem(templateId: string, catId: string, name: string) {
  if (!name?.trim()) return { error: 'Item name is required', status: 400 };
  const cat = db.prepare('SELECT * FROM packing_template_categories WHERE id = ? AND template_id = ?').get(catId, templateId);
  if (!cat) return { error: 'Category not found', status: 404 };
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_template_items WHERE category_id = ?').get(catId) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_template_items (category_id, name, sort_order) VALUES (?, ?, ?)').run(catId, name.trim(), (maxOrder.max ?? -1) + 1);
  return { item: db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(result.lastInsertRowid) };
}

export function updateTemplateItem(itemId: string, data: { name?: string }) {
  const item = db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(itemId);
  if (!item) return { error: 'Item not found', status: 404 };
  if (data.name?.trim()) db.prepare('UPDATE packing_template_items SET name = ? WHERE id = ?').run(data.name.trim(), itemId);
  return { item: db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(itemId) };
}

export function deleteTemplateItem(itemId: string) {
  const item = db.prepare('SELECT * FROM packing_template_items WHERE id = ?').get(itemId);
  if (!item) return { error: 'Item not found', status: 404 };
  db.prepare('DELETE FROM packing_template_items WHERE id = ?').run(itemId);
  return {};
}

// ── Addons ─────────────────────────────────────────────────────────────────

export function isAddonEnabled(addonId: string): boolean {
  const addon = db.prepare('SELECT enabled FROM addons WHERE id = ?').get(addonId) as { enabled: number } | undefined;
  return !!addon?.enabled;
}

export function listAddons() {
  const addons = db.prepare('SELECT * FROM addons ORDER BY sort_order, id').all() as Addon[];
  const providers = db.prepare(`
    SELECT id, name, description, icon, enabled, sort_order
    FROM photo_providers
    ORDER BY sort_order, id
  `).all() as Array<{ id: string; name: string; description?: string | null; icon: string; enabled: number; sort_order: number }>;
  const fields = db.prepare(`
    SELECT provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order
    FROM photo_provider_fields
    ORDER BY sort_order, id
  `).all() as Array<{
    provider_id: string;
    field_key: string;
    label: string;
    input_type: string;
    placeholder?: string | null;
    required: number;
    secret: number;
    settings_key?: string | null;
    payload_key?: string | null;
    sort_order: number;
  }>;
  const fieldsByProvider = new Map<string, typeof fields>();
  for (const field of fields) {
    const arr = fieldsByProvider.get(field.provider_id) || [];
    arr.push(field);
    fieldsByProvider.set(field.provider_id, arr);
  }

  return [
    ...addons.map(a => ({ ...a, enabled: !!a.enabled, config: JSON.parse(a.config || '{}') })),
    ...providers.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: 'photo_provider',
      icon: p.icon,
      enabled: !!p.enabled,
      config: getPhotoProviderConfig(p.id),
      fields: (fieldsByProvider.get(p.id) || []).map(f => ({
        key: f.field_key,
        label: f.label,
        input_type: f.input_type,
        placeholder: f.placeholder || '',
        required: !!f.required,
        secret: !!f.secret,
        settings_key: f.settings_key || null,
        payload_key: f.payload_key || null,
        sort_order: f.sort_order,
      })),
      sort_order: p.sort_order,
    })),
  ];
}

export function updateAddon(id: string, data: { enabled?: boolean; config?: Record<string, unknown> }) {
  const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(id) as Addon | undefined;
  const provider = db.prepare('SELECT * FROM photo_providers WHERE id = ?').get(id) as { id: string; name: string; description?: string | null; icon: string; enabled: number; sort_order: number } | undefined;
  if (!addon && !provider) return { error: 'Addon not found', status: 404 };

  if (addon) {
    if (data.enabled !== undefined) db.prepare('UPDATE addons SET enabled = ? WHERE id = ?').run(data.enabled ? 1 : 0, id);
    if (data.config !== undefined) db.prepare('UPDATE addons SET config = ? WHERE id = ?').run(JSON.stringify(data.config), id);
  } else {
    if (data.enabled !== undefined) db.prepare('UPDATE photo_providers SET enabled = ? WHERE id = ?').run(data.enabled ? 1 : 0, id);
  }

  const updatedAddon = db.prepare('SELECT * FROM addons WHERE id = ?').get(id) as Addon | undefined;
  const updatedProvider = db.prepare('SELECT * FROM photo_providers WHERE id = ?').get(id) as { id: string; name: string; description?: string | null; icon: string; enabled: number; sort_order: number } | undefined;
  const updated = updatedAddon
    ? { ...updatedAddon, enabled: !!updatedAddon.enabled, config: JSON.parse(updatedAddon.config || '{}') }
    : updatedProvider
      ? {
        id: updatedProvider.id,
        name: updatedProvider.name,
        description: updatedProvider.description,
        type: 'photo_provider',
        icon: updatedProvider.icon,
        enabled: !!updatedProvider.enabled,
        config: getPhotoProviderConfig(updatedProvider.id),
        sort_order: updatedProvider.sort_order,
      }
      : null;

  return {
    addon: updated,
    auditDetails: { enabled: data.enabled !== undefined ? !!data.enabled : undefined, config_changed: data.config !== undefined },
  };
}

// ── MCP Tokens ─────────────────────────────────────────────────────────────

export function listMcpTokens() {
  return db.prepare(`
    SELECT t.id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.user_id, u.username
    FROM mcp_tokens t
    JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC
  `).all();
}

export function deleteMcpToken(id: string) {
  const token = db.prepare('SELECT id, user_id FROM mcp_tokens WHERE id = ?').get(id) as { id: number; user_id: number } | undefined;
  if (!token) return { error: 'Token not found', status: 404 };
  db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(id);
  revokeUserSessions(token.user_id);
  return {};
}

// ── JWT Rotation ───────────────────────────────────────────────────────────

export function rotateJwtSecret(): { error?: string; status?: number } {
  const newSecret = crypto.randomBytes(32).toString('hex');
  const dataDir = path.resolve(__dirname, '../../data');
  const secretFile = path.join(dataDir, '.jwt_secret');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, newSecret, { mode: 0o600 });
  } catch (err: unknown) {
    return { error: 'Failed to persist new JWT secret to disk', status: 500 };
  }
  updateJwtSecret(newSecret);
  return {};
}
