import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import fetch from 'node-fetch';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db/database';
import { validatePassword } from '../services/passwordPolicy';
import { authenticate, optionalAuth, demoUploadBlock } from '../middleware/auth';
import { JWT_SECRET } from '../config';
import { encryptMfaSecret, decryptMfaSecret } from '../services/mfaCrypto';
import { getAllPermissions } from '../services/permissions';
import { randomBytes, createHash } from 'crypto';
import { revokeUserSessions } from '../mcp';
import { AuthRequest, OptionalAuthRequest, User } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import { decrypt_api_key, maybe_encrypt_api_key, encrypt_api_key } from '../services/apiKeyCrypto';
import { startTripReminders } from '../scheduler';
import { createEphemeralToken } from '../services/ephemeralTokens';
import { setAuthCookie, clearAuthCookie } from '../services/cookie';

authenticator.options = { window: 1 };

const MFA_SETUP_TTL_MS = 15 * 60 * 1000;
const mfaSetupPending = new Map<number, { secret: string; exp: number }>();
const MFA_BACKUP_CODE_COUNT = 10;

function normalizeBackupCode(input: string): string {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashBackupCode(input: string): string {
  return crypto.createHash('sha256').update(normalizeBackupCode(input)).digest('hex');
}

function generateBackupCodes(count = MFA_BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function parseBackupCodeHashes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function getPendingMfaSecret(userId: number): string | null {
  const row = mfaSetupPending.get(userId);
  if (!row || Date.now() > row.exp) {
    mfaSetupPending.delete(userId);
    return null;
  }
  return row.secret;
}

function utcSuffix(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
}

function stripUserForClient(user: User): Record<string, unknown> {
  const {
    password_hash: _p,
    maps_api_key: _m,
    openweather_api_key: _o,
    unsplash_api_key: _u,
    mfa_secret: _mf,
    mfa_backup_codes: _mbc,
    ...rest
  } = user;
  return {
    ...rest,
    created_at: utcSuffix(rest.created_at),
    updated_at: utcSuffix(rest.updated_at),
    last_login: utcSuffix(rest.last_login),
    mfa_enabled: !!(user.mfa_enabled === 1 || user.mfa_enabled === true),
    must_change_password: !!(user.must_change_password === 1 || user.must_change_password === true),
  };
}

const router = express.Router();

const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const ALLOWED_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: MAX_AVATAR_SIZE }, fileFilter: (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!file.mimetype.startsWith('image/') || !ALLOWED_AVATAR_EXTS.includes(ext)) {
    return cb(new Error('Only .jpg, .jpeg, .png, .gif, .webp images are allowed'));
  }
  cb(null, true);
}});

const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_CLEANUP = 5 * 60 * 1000; // 5 minutes

const loginAttempts = new Map<string, { count: number; first: number }>();
const mfaAttempts = new Map<string, { count: number; first: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts) {
    if (now - record.first >= RATE_LIMIT_WINDOW) loginAttempts.delete(key);
  }
  for (const [key, record] of mfaAttempts) {
    if (now - record.first >= RATE_LIMIT_WINDOW) mfaAttempts.delete(key);
  }
}, RATE_LIMIT_CLEANUP);

function rateLimiter(maxAttempts: number, windowMs: number, store = loginAttempts) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = store.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (!record || now - record.first >= windowMs) {
      store.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}
const authLimiter = rateLimiter(10, RATE_LIMIT_WINDOW);
const mfaLimiter = rateLimiter(5, RATE_LIMIT_WINDOW, mfaAttempts);

function isOidcOnlyMode(): boolean {
  const get = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || null;
  const enabled = process.env.OIDC_ONLY === 'true' || get('oidc_only') === 'true';
  if (!enabled) return false;
  const oidcConfigured = !!(
    (process.env.OIDC_ISSUER || get('oidc_issuer')) &&
    (process.env.OIDC_CLIENT_ID || get('oidc_client_id'))
  );
  return oidcConfigured;
}

function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '--------';
  return '----' + key.slice(-4);
}

function mask_stored_api_key(key: string | null | undefined): string | null {
  const plain = decrypt_api_key(key);
  return maskKey(plain);
}

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function generateToken(user: { id: number | bigint }) {
  return jwt.sign(
    { id: user.id },
    JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' }
  );
}

router.get('/app-config', optionalAuth, (req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get() as { value: string } | undefined;
  const allowRegistration = userCount === 0 || (setting?.value ?? 'true') === 'true';
  const isDemo = process.env.DEMO_MODE === 'true';
  const { version } = require('../../package.json');
  const hasGoogleKey = !!db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
  const oidcDisplayName = process.env.OIDC_DISPLAY_NAME || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_display_name'").get() as { value: string } | undefined)?.value || null;
  const oidcConfigured = !!(
    (process.env.OIDC_ISSUER || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get() as { value: string } | undefined)?.value) &&
    (process.env.OIDC_CLIENT_ID || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get() as { value: string } | undefined)?.value)
  );
  const oidcOnlySetting = process.env.OIDC_ONLY || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_only'").get() as { value: string } | undefined)?.value;
  const oidcOnlyMode = oidcConfigured && oidcOnlySetting === 'true';
  const requireMfaRow = db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined;
  const notifChannel = (db.prepare("SELECT value FROM app_settings WHERE key = 'notification_channel'").get() as { value: string } | undefined)?.value || 'none';
  const tripReminderSetting = (db.prepare("SELECT value FROM app_settings WHERE key = 'notify_trip_reminder'").get() as { value: string } | undefined)?.value;
  const hasSmtpHost = !!(process.env.SMTP_HOST || (db.prepare("SELECT value FROM app_settings WHERE key = 'smtp_host'").get() as { value: string } | undefined)?.value);
  const hasWebhookUrl = !!(process.env.NOTIFICATION_WEBHOOK_URL || (db.prepare("SELECT value FROM app_settings WHERE key = 'notification_webhook_url'").get() as { value: string } | undefined)?.value);
  const channelConfigured = (notifChannel === 'email' && hasSmtpHost) || (notifChannel === 'webhook' && hasWebhookUrl);
  const tripRemindersEnabled = channelConfigured && tripReminderSetting !== 'false';
  const setupComplete = userCount > 0 && !(db.prepare("SELECT id FROM users WHERE role = 'admin' AND must_change_password = 1 LIMIT 1").get());
  res.json({
    allow_registration: isDemo ? false : allowRegistration,
    has_users: userCount > 0,
    setup_complete: setupComplete,
    version,
    has_maps_key: hasGoogleKey,
    oidc_configured: oidcConfigured,
    oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
    oidc_only_mode: oidcOnlyMode,
    require_mfa: requireMfaRow?.value === 'true',
    allowed_file_types: (db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined)?.value || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
    demo_mode: isDemo,
    demo_email: isDemo ? 'demo@trek.app' : undefined,
    demo_password: isDemo ? 'demo12345' : undefined,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    notification_channel: notifChannel,
    trip_reminders_enabled: tripRemindersEnabled,
    permissions: (req as OptionalAuthRequest).user ? getAllPermissions() : undefined,
  });
});

router.post('/demo-login', (_req: Request, res: Response) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@trek.app') as User | undefined;
  if (!user) return res.status(500).json({ error: 'Demo user not found' });
  const token = generateToken(user);
  const safe = stripUserForClient(user) as Record<string, unknown>;
  setAuthCookie(res, token);
  res.json({ token, user: { ...safe, avatar_url: avatarUrl(user) } });
});

// Validate invite token (public, no auth needed, rate limited)
router.get('/invite/:token', authLimiter, (req: Request, res: Response) => {
  const invite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(req.params.token) as any;
  if (!invite) return res.status(404).json({ error: 'Invalid invite link' });
  if (invite.max_uses > 0 && invite.used_count >= invite.max_uses) return res.status(410).json({ error: 'Invite link has been fully used' });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Invite link has expired' });
  res.json({ valid: true, max_uses: invite.max_uses, used_count: invite.used_count, expires_at: invite.expires_at });
});

router.post('/register', authLimiter, (req: Request, res: Response) => {
  const { username, email, password, invite_token } = req.body;

  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;

  // Check invite token first — valid token bypasses registration restrictions
  let validInvite: any = null;
  if (invite_token) {
    validInvite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(invite_token);
    if (!validInvite) return res.status(400).json({ error: 'Invalid invite link' });
    if (validInvite.max_uses > 0 && validInvite.used_count >= validInvite.max_uses) return res.status(410).json({ error: 'Invite link has been fully used' });
    if (validInvite.expires_at && new Date(validInvite.expires_at) < new Date()) return res.status(410).json({ error: 'Invite link has expired' });
  }

  if (userCount > 0 && !validInvite) {
    if (isOidcOnlyMode()) {
      return res.status(403).json({ error: 'Password authentication is disabled. Please sign in with SSO.' });
    }
    const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get() as { value: string } | undefined;
    if (setting?.value === 'false') {
      return res.status(403).json({ error: 'Registration is disabled. Contact your administrator.' });
    }
  }

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)').get(email, username);
  if (existingUser) {
    return res.status(409).json({ error: 'Registration failed. Please try different credentials.' });
  }

  const password_hash = bcrypt.hashSync(password, 12);

  const isFirstUser = userCount === 0;
  const role = isFirstUser ? 'admin' : 'user';

  try {
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(username, email, password_hash, role);

    const user = { id: result.lastInsertRowid, username, email, role, avatar: null, mfa_enabled: false };
    const token = generateToken(user);

    // Atomically increment invite token usage (prevents race condition)
    if (validInvite) {
      const updated = db.prepare(
        'UPDATE invite_tokens SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses) RETURNING used_count'
      ).get(validInvite.id);
      if (!updated) {
        // Race condition: token was used up between check and now — user was already created, so just log it
        console.warn(`[Auth] Invite token ${validInvite.token.slice(0, 8)}... exceeded max_uses due to race condition`);
      }
    }

    writeAudit({ userId: Number(result.lastInsertRowid), action: 'user.register', ip: getClientIp(req), details: { username, email, role } });
    setAuthCookie(res, token);
    res.status(201).json({ token, user: { ...user, avatar_url: null } });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

router.post('/login', authLimiter, (req: Request, res: Response) => {
  if (isOidcOnlyMode()) {
    return res.status(403).json({ error: 'Password authentication is disabled. Please sign in with SSO.' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as User | undefined;
  if (!user) {
    writeAudit({ userId: null, action: 'user.login_failed', ip: getClientIp(req), details: { email, reason: 'unknown_email' } });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash!);
  if (!validPassword) {
    writeAudit({ userId: Number(user.id), action: 'user.login_failed', ip: getClientIp(req), details: { email, reason: 'wrong_password' } });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
    const mfa_token = jwt.sign(
      { id: Number(user.id), purpose: 'mfa_login' },
      JWT_SECRET,
      { expiresIn: '5m', algorithm: 'HS256' }
    );
    return res.json({ mfa_required: true, mfa_token });
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = generateToken(user);
  const userSafe = stripUserForClient(user) as Record<string, unknown>;

  writeAudit({ userId: Number(user.id), action: 'user.login', ip: getClientIp(req), details: { email } });
  setAuthCookie(res, token);
  res.json({ token, user: { ...userSafe, avatar_url: avatarUrl(user) } });
});

router.get('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT id, username, email, role, avatar, oidc_issuer, created_at, mfa_enabled, must_change_password FROM users WHERE id = ?'
  ).get(authReq.user.id) as User | undefined;

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const base = stripUserForClient(user as User) as Record<string, unknown>;
  res.json({ user: { ...base, avatar_url: avatarUrl(user) } });
});

router.post('/logout', (req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.put('/me/password', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (isOidcOnlyMode()) {
    return res.status(403).json({ error: 'Password authentication is disabled.' });
  }
  if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@trek.app') {
    return res.status(403).json({ error: 'Password change is disabled in demo mode.' });
  }
  const { current_password, new_password } = req.body;
  if (!current_password) return res.status(400).json({ error: 'Current password is required' });
  if (!new_password) return res.status(400).json({ error: 'New password is required' });
  const pwCheck = validatePassword(new_password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(authReq.user.id) as { password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, authReq.user.id);
  writeAudit({ userId: authReq.user.id, action: 'user.password_change', ip: getClientIp(req) });
  res.json({ success: true });
});

router.delete('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@trek.app') {
    return res.status(403).json({ error: 'Account deletion is disabled in demo mode.' });
  }
  if (authReq.user.role === 'admin') {
    const adminCount = (db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number }).count;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin account' });
    }
  }
  writeAudit({ userId: authReq.user.id, action: 'user.account_delete', ip: getClientIp(req) });
  db.prepare('DELETE FROM users WHERE id = ?').run(authReq.user.id);
  res.json({ success: true });
});

router.put('/me/maps-key', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key } = req.body;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(maybe_encrypt_api_key(maps_api_key), authReq.user.id);

  res.json({ success: true, maps_api_key: mask_stored_api_key(maps_api_key) });
});

router.put('/me/api-keys', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key, openweather_api_key } = req.body;
  const current = db.prepare('SELECT maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id) as Pick<User, 'maps_api_key' | 'openweather_api_key'> | undefined;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    maps_api_key !== undefined ? maybe_encrypt_api_key(maps_api_key) : current.maps_api_key,
    openweather_api_key !== undefined ? maybe_encrypt_api_key(openweather_api_key) : current.openweather_api_key,
    authReq.user.id
  );

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  res.json({ success: true, user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});

router.put('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key, openweather_api_key, username, email } = req.body;

  if (username !== undefined) {
    const trimmed = username.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
      return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, dots and hyphens' });
    }
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(trimmed, authReq.user.id);
    if (conflict) return res.status(409).json({ error: 'Username already taken' });
  }

  if (email !== undefined) {
    const trimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!trimmed || !emailRegex.test(trimmed)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, authReq.user.id);
    if (conflict) return res.status(409).json({ error: 'Email already taken' });
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (maps_api_key !== undefined) { updates.push('maps_api_key = ?'); params.push(maybe_encrypt_api_key(maps_api_key)); }
  if (openweather_api_key !== undefined) { updates.push('openweather_api_key = ?'); params.push(maybe_encrypt_api_key(openweather_api_key)); }
  if (username !== undefined) { updates.push('username = ?'); params.push(username.trim()); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email.trim()); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(authReq.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  res.json({ success: true, user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});

router.get('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  res.json({
    settings: {
      maps_api_key: decrypt_api_key(user.maps_api_key),
      openweather_api_key: decrypt_api_key(user.openweather_api_key),
    }
  });
});

router.post('/avatar', authenticate, demoUploadBlock, avatarUpload.single('avatar'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id) as { avatar: string | null } | undefined;
  if (current && current.avatar) {
    const oldPath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const filename = req.file.filename;
  db.prepare('UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(filename, authReq.user.id);

  const updated = db.prepare('SELECT id, username, email, role, avatar FROM users WHERE id = ?').get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'avatar'> | undefined;
  res.json({ success: true, avatar_url: avatarUrl(updated || {}) });
});

router.delete('/avatar', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id) as { avatar: string | null } | undefined;
  if (current && current.avatar) {
    const filePath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(authReq.user.id);
  res.json({ success: true });
});

router.get('/users', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const users = db.prepare(
    'SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username ASC'
  ).all(authReq.user.id) as Pick<User, 'id' | 'username' | 'avatar'>[];
  res.json({ users: users.map(u => ({ ...u, avatar_url: avatarUrl(u) })) });
});

router.get('/validate-keys', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare('SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const result: {
    maps: boolean;
    weather: boolean;
    maps_details: null | {
      ok: boolean;
      status: number | null;
      status_text: string | null;
      error_message: string | null;
      error_status: string | null;
      error_raw: string | null;
    };
  } = { maps: false, weather: false, maps_details: null };

  const maps_api_key = decrypt_api_key(user.maps_api_key);
  if (maps_api_key) {
    try {
      const mapsRes = await fetch(
        `https://places.googleapis.com/v1/places:searchText`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': maps_api_key,
            'X-Goog-FieldMask': 'places.displayName',
          },
          body: JSON.stringify({ textQuery: 'test' }),
        }
      );
      result.maps = mapsRes.status === 200;
      let error_text: string | null = null;
      let error_json: any = null;
      if (!result.maps) {
        try {
          error_text = await mapsRes.text();
          try {
            error_json = JSON.parse(error_text);
          } catch {
            error_json = null;
          }
        } catch {
          error_text = null;
          error_json = null;
        }
      }
      result.maps_details = {
        ok: result.maps,
        status: mapsRes.status,
        status_text: mapsRes.statusText || null,
        error_message: error_json?.error?.message || null,
        error_status: error_json?.error?.status || null,
        error_raw: error_text,
      };
    } catch (err: unknown) {
      result.maps = false;
      result.maps_details = {
        ok: false,
        status: null,
        status_text: null,
        error_message: err instanceof Error ? err.message : 'Request failed',
        error_status: 'FETCH_ERROR',
        error_raw: null,
      };
    }
  }

  const openweather_api_key = decrypt_api_key(user.openweather_api_key);
  if (openweather_api_key) {
    try {
      const weatherRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=London&appid=${openweather_api_key}`
      );
      result.weather = weatherRes.status === 200;
    } catch (err: unknown) {
      result.weather = false;
    }
  }

  res.json(result);
});

const ADMIN_SETTINGS_KEYS = ['allow_registration', 'allowed_file_types', 'require_mfa', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify', 'notification_webhook_url', 'notification_channel', 'notify_trip_invite', 'notify_booking_change', 'notify_trip_reminder', 'notify_vacay_invite', 'notify_photos_shared', 'notify_collab_message', 'notify_packing_tagged'];

router.get('/app-settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(authReq.user.id) as { role: string } | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const result: Record<string, string> = {};
  for (const key of ADMIN_SETTINGS_KEYS) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) result[key] = key === 'smtp_pass' ? '••••••••' : row.value;
  }
  res.json(result);
});

router.put('/app-settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(authReq.user.id) as { role: string } | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const { require_mfa } = req.body as Record<string, unknown>;

  if (require_mfa === true || require_mfa === 'true') {
    const adminMfa = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(authReq.user.id) as { mfa_enabled: number } | undefined;
    if (!(adminMfa?.mfa_enabled === 1)) {
      return res.status(400).json({
        error: 'Enable two-factor authentication on your own account before requiring it for all users.',
      });
    }
  }

  for (const key of ADMIN_SETTINGS_KEYS) {
    if (req.body[key] !== undefined) {
      let val = String(req.body[key]);
      if (key === 'require_mfa') {
        val = req.body[key] === true || val === 'true' ? 'true' : 'false';
      }
      // Don't save masked password
      if (key === 'smtp_pass' && val === '••••••••') continue;
      if (key === 'smtp_pass') val = encrypt_api_key(val);
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val);
    }
  }
  const changedKeys = ADMIN_SETTINGS_KEYS.filter(k => req.body[k] !== undefined && !(k === 'smtp_pass' && String(req.body[k]) === '••••••••'));

  const summary: Record<string, unknown> = {};
  const smtpChanged = changedKeys.some(k => k.startsWith('smtp_'));
  const eventsChanged = changedKeys.some(k => k.startsWith('notify_'));
  if (changedKeys.includes('notification_channel')) summary.notification_channel = req.body.notification_channel;
  if (changedKeys.includes('notification_webhook_url')) summary.webhook_url_updated = true;
  if (smtpChanged) summary.smtp_settings_updated = true;
  if (eventsChanged) summary.notification_events_updated = true;
  if (changedKeys.includes('allow_registration')) summary.allow_registration = req.body.allow_registration;
  if (changedKeys.includes('allowed_file_types')) summary.allowed_file_types_updated = true;
  if (changedKeys.includes('require_mfa')) summary.require_mfa = req.body.require_mfa;

  const debugDetails: Record<string, unknown> = {};
  for (const k of changedKeys) {
    debugDetails[k] = k === 'smtp_pass' ? '***' : req.body[k];
  }

  writeAudit({
    userId: authReq.user.id,
    action: 'settings.app_update',
    ip: getClientIp(req),
    details: summary,
    debugDetails,
  });

  const notifRelated = ['notification_channel', 'notification_webhook_url', 'smtp_host', 'notify_trip_reminder'];
  if (changedKeys.some(k => notifRelated.includes(k))) {
    startTripReminders();
  }

  res.json({ success: true });
});

router.get('/travel-stats', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;

  const places = db.prepare(`
    SELECT DISTINCT p.address, p.lat, p.lng
    FROM places p
    JOIN trips t ON p.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE t.user_id = ? OR tm.user_id = ?
  `).all(userId, userId) as { address: string | null; lat: number | null; lng: number | null }[];

  const tripStats = db.prepare(`
    SELECT COUNT(DISTINCT t.id) as trips,
           COUNT(DISTINCT d.id) as days
    FROM trips t
    LEFT JOIN days d ON d.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE (t.user_id = ? OR tm.user_id = ?) AND t.is_archived = 0
  `).get(userId, userId) as { trips: number; days: number } | undefined;

  const KNOWN_COUNTRIES = new Set([
    'Japan', 'Germany', 'Deutschland', 'France', 'Frankreich', 'Italy', 'Italien', 'Spain', 'Spanien',
    'United States', 'USA', 'United Kingdom', 'UK', 'Thailand', 'Australia', 'Australien',
    'Canada', 'Kanada', 'Mexico', 'Mexiko', 'Brazil', 'Brasilien', 'China', 'India', 'Indien',
    'South Korea', 'Sudkorea', 'Indonesia', 'Indonesien', 'Turkey', 'Turkei', 'Turkiye',
    'Greece', 'Griechenland', 'Portugal', 'Netherlands', 'Niederlande', 'Belgium', 'Belgien',
    'Switzerland', 'Schweiz', 'Austria', 'Osterreich', 'Sweden', 'Schweden', 'Norway', 'Norwegen',
    'Denmark', 'Danemark', 'Finland', 'Finnland', 'Poland', 'Polen', 'Czech Republic', 'Tschechien',
    'Czechia', 'Hungary', 'Ungarn', 'Croatia', 'Kroatien', 'Romania', 'Rumanien',
    'Ireland', 'Irland', 'Iceland', 'Island', 'New Zealand', 'Neuseeland',
    'Singapore', 'Singapur', 'Malaysia', 'Vietnam', 'Philippines', 'Philippinen',
    'Egypt', 'Agypten', 'Morocco', 'Marokko', 'South Africa', 'Sudafrika', 'Kenya', 'Kenia',
    'Argentina', 'Argentinien', 'Chile', 'Colombia', 'Kolumbien', 'Peru',
    'Russia', 'Russland', 'United Arab Emirates', 'UAE', 'Vereinigte Arabische Emirate',
    'Israel', 'Jordan', 'Jordanien', 'Taiwan', 'Hong Kong', 'Hongkong',
    'Cuba', 'Kuba', 'Costa Rica', 'Panama', 'Ecuador', 'Bolivia', 'Bolivien', 'Uruguay', 'Paraguay',
    'Luxembourg', 'Luxemburg', 'Malta', 'Cyprus', 'Zypern', 'Estonia', 'Estland',
    'Latvia', 'Lettland', 'Lithuania', 'Litauen', 'Slovakia', 'Slowakei', 'Slovenia', 'Slowenien',
    'Bulgaria', 'Bulgarien', 'Serbia', 'Serbien', 'Montenegro', 'Albania', 'Albanien',
    'Sri Lanka', 'Nepal', 'Cambodia', 'Kambodscha', 'Laos', 'Myanmar', 'Mongolia', 'Mongolei',
    'Saudi Arabia', 'Saudi-Arabien', 'Qatar', 'Katar', 'Oman', 'Bahrain', 'Kuwait',
    'Tanzania', 'Tansania', 'Ethiopia', 'Athiopien', 'Nigeria', 'Ghana', 'Tunisia', 'Tunesien',
    'Dominican Republic', 'Dominikanische Republik', 'Jamaica', 'Jamaika',
    'Ukraine', 'Georgia', 'Georgien', 'Armenia', 'Armenien', 'Pakistan', 'Bangladesh', 'Bangladesch',
    'Senegal', 'Mozambique', 'Mosambik', 'Moldova', 'Moldawien', 'Belarus', 'Weissrussland',
  ]);

  const countries = new Set<string>();
  const cities = new Set<string>();
  const coords: { lat: number; lng: number }[] = [];

  places.forEach(p => {
    if (p.lat && p.lng) coords.push({ lat: p.lat, lng: p.lng });
    if (p.address) {
      const parts = p.address.split(',').map(s => s.trim().replace(/\d{3,}/g, '').trim());
      for (const part of parts) {
        if (KNOWN_COUNTRIES.has(part)) { countries.add(part); break; }
      }
      const cityPart = parts.find(s => !KNOWN_COUNTRIES.has(s) && /^[A-Za-z\u00C0-\u00FF\s-]{2,}$/.test(s));
      if (cityPart) cities.add(cityPart);
    }
  });

  res.json({
    countries: [...countries],
    cities: [...cities],
    coords,
    totalTrips: tripStats?.trips || 0,
    totalDays: tripStats?.days || 0,
    totalPlaces: places.length,
  });
});

router.post('/mfa/verify-login', mfaLimiter, (req: Request, res: Response) => {
  const { mfa_token, code } = req.body as { mfa_token?: string; code?: string };
  if (!mfa_token || !code) {
    return res.status(400).json({ error: 'Verification token and code are required' });
  }
  try {
    const decoded = jwt.verify(mfa_token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; purpose?: string };
    if (decoded.purpose !== 'mfa_login') {
      return res.status(401).json({ error: 'Invalid verification token' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    if (!user || !(user.mfa_enabled === 1 || user.mfa_enabled === true) || !user.mfa_secret) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const secret = decryptMfaSecret(user.mfa_secret);
    const tokenStr = String(code).trim();
    const okTotp = authenticator.verify({ token: tokenStr.replace(/\s/g, ''), secret });
    if (!okTotp) {
      const hashes = parseBackupCodeHashes(user.mfa_backup_codes);
      const candidateHash = hashBackupCode(tokenStr);
      const idx = hashes.findIndex(h => h === candidateHash);
      if (idx === -1) {
        return res.status(401).json({ error: 'Invalid verification code' });
      }
      hashes.splice(idx, 1);
      db.prepare('UPDATE users SET mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(hashes),
        user.id
      );
    }
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const sessionToken = generateToken(user);
    const userSafe = stripUserForClient(user) as Record<string, unknown>;
    writeAudit({ userId: Number(user.id), action: 'user.login', ip: getClientIp(req), details: { mfa: true } });
    setAuthCookie(res, sessionToken);
    res.json({ token: sessionToken, user: { ...userSafe, avatar_url: avatarUrl(user) } });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired verification token' });
  }
});

router.post('/mfa/setup', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@nomad.app') {
    return res.status(403).json({ error: 'MFA is not available in demo mode.' });
  }
  const row = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(authReq.user.id) as { mfa_enabled: number } | undefined;
  if (row?.mfa_enabled) {
    return res.status(400).json({ error: 'MFA is already enabled' });
  }
  let secret: string, otpauth_url: string;
  try {
    secret = authenticator.generateSecret();
    mfaSetupPending.set(authReq.user.id, { secret, exp: Date.now() + MFA_SETUP_TTL_MS });
    otpauth_url = authenticator.keyuri(authReq.user.email, 'TREK', secret);
  } catch (err) {
    console.error('[MFA] Setup error:', err);
    return res.status(500).json({ error: 'MFA setup failed' });
  }
  QRCode.toDataURL(otpauth_url)
    .then((qr_data_url: string) => {
      res.json({ secret, otpauth_url, qr_data_url });
    })
    .catch((err: unknown) => {
      console.error('[MFA] QR code generation error:', err);
      res.status(500).json({ error: 'Could not generate QR code' });
    });
});

router.post('/mfa/enable', authenticate, mfaLimiter, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { code } = req.body as { code?: string };
  if (!code) {
    return res.status(400).json({ error: 'Verification code is required' });
  }
  const pending = getPendingMfaSecret(authReq.user.id);
  if (!pending) {
    return res.status(400).json({ error: 'No MFA setup in progress. Start the setup again.' });
  }
  const tokenStr = String(code).replace(/\s/g, '');
  const ok = authenticator.verify({ token: tokenStr, secret: pending });
  if (!ok) {
    return res.status(401).json({ error: 'Invalid verification code' });
  }
  const backupCodes = generateBackupCodes();
  const backupHashes = backupCodes.map(hashBackupCode);
  const enc = encryptMfaSecret(pending);
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    enc,
    JSON.stringify(backupHashes),
    authReq.user.id
  );
  mfaSetupPending.delete(authReq.user.id);
  writeAudit({ userId: authReq.user.id, action: 'user.mfa_enable', ip: getClientIp(req) });
  res.json({ success: true, mfa_enabled: true, backup_codes: backupCodes });
});

router.post('/mfa/disable', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@nomad.app') {
    return res.status(403).json({ error: 'MFA cannot be changed in demo mode.' });
  }
  const policy = db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined;
  if (policy?.value === 'true') {
    return res.status(403).json({ error: 'Two-factor authentication cannot be disabled while it is required for all users.' });
  }
  const { password, code } = req.body as { password?: string; code?: string };
  if (!password || !code) {
    return res.status(400).json({ error: 'Password and authenticator code are required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authReq.user.id) as User | undefined;
  if (!user?.mfa_enabled || !user.mfa_secret) {
    return res.status(400).json({ error: 'MFA is not enabled' });
  }
  if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const secret = decryptMfaSecret(user.mfa_secret);
  const tokenStr = String(code).replace(/\s/g, '');
  const ok = authenticator.verify({ token: tokenStr, secret });
  if (!ok) {
    return res.status(401).json({ error: 'Invalid verification code' });
  }
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    authReq.user.id
  );
  mfaSetupPending.delete(authReq.user.id);
  writeAudit({ userId: authReq.user.id, action: 'user.mfa_disable', ip: getClientIp(req) });
  res.json({ success: true, mfa_enabled: false });
});

// --- MCP Token Management ---

router.get('/mcp-tokens', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tokens = db.prepare(
    'SELECT id, name, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(authReq.user.id);
  res.json({ tokens });
});

router.post('/mcp-tokens', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Token name is required' });
  if (name.trim().length > 100) return res.status(400).json({ error: 'Token name must be 100 characters or less' });

  const tokenCount = (db.prepare('SELECT COUNT(*) as count FROM mcp_tokens WHERE user_id = ?').get(authReq.user.id) as { count: number }).count;
  if (tokenCount >= 10) return res.status(400).json({ error: 'Maximum of 10 tokens per user reached' });

  const rawToken = 'trek_' + randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.slice(0, 13); // "trek_" + 8 hex chars

  const result = db.prepare(
    'INSERT INTO mcp_tokens (user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?)'
  ).run(authReq.user.id, name.trim(), tokenHash, tokenPrefix);

  const token = db.prepare(
    'SELECT id, name, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ token: { ...(token as object), raw_token: rawToken } });
});

router.delete('/mcp-tokens/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { id } = req.params;
  const token = db.prepare('SELECT id FROM mcp_tokens WHERE id = ? AND user_id = ?').get(id, authReq.user.id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(id);
  revokeUserSessions(authReq.user.id);
  res.json({ success: true });
});

// Short-lived single-use token for WebSocket connections (avoids JWT in WS URL)
router.post('/ws-token', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const token = createEphemeralToken(authReq.user.id, 'ws');
  if (!token) return res.status(503).json({ error: 'Service unavailable' });
  res.json({ token });
});

// Short-lived single-use token for direct resource URLs (file downloads, Immich assets)
router.post('/resource-token', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { purpose } = req.body as { purpose?: string };
  if (purpose !== 'download' && purpose !== 'immich') {
    return res.status(400).json({ error: 'Invalid purpose' });
  }
  const token = createEphemeralToken(authReq.user.id, purpose);
  if (!token) return res.status(503).json({ error: 'Service unavailable' });
  res.json({ token });
});

export default router;
