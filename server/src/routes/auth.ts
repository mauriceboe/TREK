import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import fetch from 'node-fetch';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { JWT_SECRET } from '../config';
import { encryptMfaSecret, decryptMfaSecret } from '../services/mfaCrypto';
import { AuthRequest, User } from '../types';

authenticator.options = { window: 1 };

const MFA_SETUP_TTL_MS = 15 * 60 * 1000;
const mfaSetupPending = new Map<number, { secret: string; exp: number }>();

function getPendingMfaSecret(userId: number): string | null {
  const row = mfaSetupPending.get(userId);
  if (!row || Date.now() > row.exp) {
    mfaSetupPending.delete(userId);
    return null;
  }
  return row.secret;
}

function stripUserForClient(user: User): Record<string, unknown> {
  const {
    password_hash: _p,
    maps_api_key: _m,
    openweather_api_key: _o,
    unsplash_api_key: _u,
    mfa_secret: _mf,
    ...rest
  } = user;
  return {
    ...rest,
    mfa_enabled: !!(user.mfa_enabled === 1 || user.mfa_enabled === true),
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
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts) {
    if (now - record.first >= RATE_LIMIT_WINDOW) loginAttempts.delete(key);
  }
}, RATE_LIMIT_CLEANUP);

function rateLimiter(maxAttempts: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (!record || now - record.first >= windowMs) {
      loginAttempts.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}
const authLimiter = rateLimiter(10, RATE_LIMIT_WINDOW);

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

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function generateToken(user: { id: number | bigint }) {
  return jwt.sign(
    { id: user.id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

router.get('/app-config', (_req: Request, res: Response) => {
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
  res.json({
    allow_registration: isDemo ? false : allowRegistration,
    has_users: userCount > 0,
    version,
    has_maps_key: hasGoogleKey,
    oidc_configured: oidcConfigured,
    oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
    oidc_only_mode: oidcOnlyMode,
    allowed_file_types: (db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined)?.value || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
    demo_mode: isDemo,
    demo_email: isDemo ? 'demo@trek.app' : undefined,
    demo_password: isDemo ? 'demo12345' : undefined,
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

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
  }

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
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash!);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
    const mfa_token = jwt.sign(
      { id: Number(user.id), purpose: 'mfa_login' },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    return res.json({ mfa_required: true, mfa_token });
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = generateToken(user);
  const userSafe = stripUserForClient(user) as Record<string, unknown>;

  res.json({ token, user: { ...userSafe, avatar_url: avatarUrl(user) } });
});

router.get('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT id, username, email, role, avatar, oidc_issuer, created_at, mfa_enabled FROM users WHERE id = ?'
  ).get(authReq.user.id) as User | undefined;

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const base = stripUserForClient(user as User) as Record<string, unknown>;
  res.json({ user: { ...base, avatar_url: avatarUrl(user) } });
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
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (!/[A-Z]/.test(new_password) || !/[a-z]/.test(new_password) || !/[0-9]/.test(new_password)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(authReq.user.id) as { password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, authReq.user.id);
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
  db.prepare('DELETE FROM users WHERE id = ?').run(authReq.user.id);
  res.json({ success: true });
});

router.put('/me/maps-key', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key } = req.body;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(maps_api_key || null, authReq.user.id);

  res.json({ success: true, maps_api_key: maps_api_key || null });
});

router.put('/me/api-keys', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key, openweather_api_key } = req.body;
  const current = db.prepare('SELECT maps_api_key, openweather_api_key FROM users WHERE id = ?').get(authReq.user.id) as Pick<User, 'maps_api_key' | 'openweather_api_key'> | undefined;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    maps_api_key !== undefined ? (maps_api_key || null) : current.maps_api_key,
    openweather_api_key !== undefined ? (openweather_api_key || null) : current.openweather_api_key,
    authReq.user.id
  );

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  res.json({ success: true, user: { ...u, maps_api_key: maskKey(u?.maps_api_key), openweather_api_key: maskKey(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
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

  if (maps_api_key !== undefined) { updates.push('maps_api_key = ?'); params.push(maps_api_key || null); }
  if (openweather_api_key !== undefined) { updates.push('openweather_api_key = ?'); params.push(openweather_api_key || null); }
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
  res.json({ success: true, user: { ...u, maps_api_key: maskKey(u?.maps_api_key), openweather_api_key: maskKey(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});

router.get('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  res.json({ settings: { maps_api_key: user.maps_api_key, openweather_api_key: user.openweather_api_key } });
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

  const result = { maps: false, weather: false };

  if (user.maps_api_key) {
    try {
      const mapsRes = await fetch(
        `https://places.googleapis.com/v1/places:searchText`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': user.maps_api_key,
            'X-Goog-FieldMask': 'places.displayName',
          },
          body: JSON.stringify({ textQuery: 'test' }),
        }
      );
      result.maps = mapsRes.status === 200;
    } catch (err: unknown) {
      result.maps = false;
    }
  }

  if (user.openweather_api_key) {
    try {
      const weatherRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=London&appid=${user.openweather_api_key}`
      );
      result.weather = weatherRes.status === 200;
    } catch (err: unknown) {
      result.weather = false;
    }
  }

  res.json(result);
});

router.put('/app-settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(authReq.user.id) as { role: string } | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const { allow_registration, allowed_file_types } = req.body;
  if (allow_registration !== undefined) {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allow_registration', ?)").run(String(allow_registration));
  }
  if (allowed_file_types !== undefined) {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allowed_file_types', ?)").run(String(allowed_file_types));
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

router.post('/mfa/verify-login', authLimiter, (req: Request, res: Response) => {
  const { mfa_token, code } = req.body as { mfa_token?: string; code?: string };
  if (!mfa_token || !code) {
    return res.status(400).json({ error: 'Verification token and code are required' });
  }
  try {
    const decoded = jwt.verify(mfa_token, JWT_SECRET) as { id: number; purpose?: string };
    if (decoded.purpose !== 'mfa_login') {
      return res.status(401).json({ error: 'Invalid verification token' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    if (!user || !(user.mfa_enabled === 1 || user.mfa_enabled === true) || !user.mfa_secret) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const secret = decryptMfaSecret(user.mfa_secret);
    const tokenStr = String(code).replace(/\s/g, '');
    const ok = authenticator.verify({ token: tokenStr, secret });
    if (!ok) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const sessionToken = generateToken(user);
    const userSafe = stripUserForClient(user) as Record<string, unknown>;
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

router.post('/mfa/enable', authenticate, (req: Request, res: Response) => {
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
  const enc = encryptMfaSecret(pending);
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    enc,
    authReq.user.id
  );
  mfaSetupPending.delete(authReq.user.id);
  res.json({ success: true, mfa_enabled: true });
});

router.post('/mfa/disable', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user.email === 'demo@nomad.app') {
    return res.status(403).json({ error: 'MFA cannot be changed in demo mode.' });
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
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    authReq.user.id
  );
  mfaSetupPending.delete(authReq.user.id);
  res.json({ success: true, mfa_enabled: false });
});

export default router;
