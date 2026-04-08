import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import fetch from 'node-fetch';
import { db } from '../db/database';
import { authenticate, clearAuthCookie, demoUploadBlock, setAuthCookie } from '../middleware/auth';
import { JWT_SECRET } from '../config';
import { AuthRequest, User } from '../types';
import { maybe_encrypt_api_key, decrypt_api_key } from '../services/apiKeyCrypto';
import { createEphemeralToken } from '../services/ephemeralTokens';
import {
  changeBetterAuthPassword,
  deleteBetterAuthUser,
  getBetterAuthSession,
  REGISTRATION_DISABLED_MESSAGE,
  signInBetterAuthEmail,
  signOutBetterAuth,
  signUpBetterAuthEmail,
  updateBetterAuthUser,
} from '../lib/betterAuth';
import { CONVEX_APPLICATION_ID, getConvexIssuer, getConvexJwks, getConvexOpenIdConfiguration, signConvexToken } from '../lib/convexAuth';
import { ensureLocalUserFromBetterAuth, normalizeBetterAuthUsername } from '../lib/localUserBridge';

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

function getBetterAuthErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const maybeError = error as { body?: { message?: string }; message?: string };
    if (maybeError.body?.message) return maybeError.body.message;
    if (maybeError.message) return maybeError.message;
  }
  return fallback;
}

async function refreshLocalUserFromBetterAuthRequest(req: Request): Promise<User | null> {
  const session = await getBetterAuthSession(req, { disableRefresh: true });
  if (!session?.user) return null;
  return ensureLocalUserFromBetterAuth(session.user as {
    id: string;
    email: string;
    name?: string | null;
    username?: string | null;
    displayUsername?: string | null;
  });
}

function getAccessibleTripIds(userId: number): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT t.id
    FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id
    WHERE t.user_id = ? OR m.user_id = ?
    ORDER BY t.id
  `).all(userId, userId) as { id: number }[];
  return rows.map((row) => row.id);
}

router.get('/convex/.well-known/jwks.json', async (_req: Request, res: Response) => {
  res.json(await getConvexJwks());
});

router.get('/convex/.well-known/openid-configuration', (req: Request, res: Response) => {
  res.json(getConvexOpenIdConfiguration(req));
});

router.post('/convex/token', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripIds = getAccessibleTripIds(authReq.user.id);
  const avatarRecord = db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id) as { avatar?: string | null } | undefined;
  const token = await signConvexToken(req, {
    id: authReq.user.id,
    username: authReq.user.username,
    email: authReq.user.email,
    role: authReq.user.role,
    avatar_url: avatarUrl(avatarRecord || {}),
  }, tripIds);

  res.json({
    token,
    issuer: getConvexIssuer(req),
    application_id: CONVEX_APPLICATION_ID,
    expires_in: 900,
    trip_ids: tripIds,
  });
});

router.get('/app-config', (_req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get() as { value: string } | undefined;
  const inviteOnly = process.env.INVITE_ONLY === 'true';
  const allowRegistration = !inviteOnly && (userCount === 0 || (setting?.value ?? 'true') === 'true');
  const isDemo = process.env.DEMO_MODE === 'true';
  const { version } = require('../../package.json');
  const hasGoogleKey = !!db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
  const oidcDisplayName = process.env.OIDC_DISPLAY_NAME || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_display_name'").get() as { value: string } | undefined)?.value || null;
  const oidcConfigured = !!(
    (process.env.OIDC_ISSUER || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get() as { value: string } | undefined)?.value) &&
    (process.env.OIDC_CLIENT_ID || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get() as { value: string } | undefined)?.value)
  );
  res.json({
    allow_registration: isDemo ? false : allowRegistration,
    has_users: userCount > 0,
    version,
    has_maps_key: hasGoogleKey,
    oidc_configured: oidcConfigured,
    oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
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
  const { password_hash, maps_api_key, openweather_api_key, unsplash_api_key, ...safe } = user;
  setAuthCookie(res, token);
  res.json({ token, user: { ...safe, avatar_url: avatarUrl(user) } });
});

router.post('/legacy-login-bridge', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as User | undefined;
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  try {
    const signUp = await signUpBetterAuthEmail({
      email: user.email,
      password,
      name: user.username,
      username: normalizeBetterAuthUsername(user.username),
      displayUsername: user.username,
    });

    const identity = (
      signUp.ok
        ? signUp.data?.user
        : (await signInBetterAuthEmail({ email: user.email, password })).data?.user
    ) as {
      id?: string;
      email?: string;
      name?: string | null;
      username?: string | null;
      displayUsername?: string | null;
    } | undefined;

    if (identity?.id && identity.email) {
      ensureLocalUserFromBetterAuth({
        id: identity.id,
        email: identity.email,
        name: identity.name,
        username: identity.username,
        displayUsername: identity.displayUsername,
      });
      res.json({ migrated: true });
      return;
    }
    res.status(400).json({ error: 'Could not migrate account' });
  } catch (error: unknown) {
    res.status(400).json({ error: getBetterAuthErrorMessage(error, 'Could not migrate account') });
  }
});

router.post('/register', authLimiter, (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  if (process.env.INVITE_ONLY === 'true') {
    return res.status(403).json({ error: REGISTRATION_DISABLED_MESSAGE });
  }

  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (userCount > 0) {
    const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get() as { value: string } | undefined;
    if (setting?.value === 'false') {
      return res.status(403).json({ error: REGISTRATION_DISABLED_MESSAGE });
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

    const user = { id: result.lastInsertRowid, username, email, role, avatar: null };
    const token = generateToken(user);
    setAuthCookie(res, token);
    res.status(201).json({ token, user: { ...user, avatar_url: null } });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

router.post('/login', authLimiter, (req: Request, res: Response) => {
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

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = generateToken(user);
  const { password_hash, maps_api_key, openweather_api_key, unsplash_api_key, ...userWithoutSensitive } = user;
  setAuthCookie(res, token);
  res.json({ token, user: { ...userWithoutSensitive, avatar_url: avatarUrl(user) } });
});

router.post('/logout', (_req: Request, res: Response) => {
  void signOutBetterAuth(_req).catch(() => {});
  clearAuthCookie(res);
  res.json({ success: true });
});

router.get('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(authReq.user.id) as User | undefined;

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (authReq.authToken) {
    setAuthCookie(res, authReq.authToken);
  }

  const { password_hash, mfa_secret, ...safeUser } = user as User & { password_hash?: string; mfa_secret?: string; must_change_password?: number | boolean };
  res.json({
    user: {
      ...safeUser,
      mfa_enabled: Boolean(user.mfa_enabled),
      must_change_password: Boolean((user as any).must_change_password),
      avatar_url: avatarUrl(user),
    },
  });
});

router.put('/me/password', authenticate, rateLimiter(5, RATE_LIMIT_WINDOW), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
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

  if (authReq.authProvider === 'better-auth') {
    try {
      const result = await changeBetterAuthPassword(req, {
        currentPassword: current_password,
        newPassword: new_password,
        revokeOtherSessions: false,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({ error: getBetterAuthErrorMessage(result.data, 'Password change failed') });
      }
      const hash = bcrypt.hashSync(new_password, 12);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, authReq.user.id);
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(400).json({ error: getBetterAuthErrorMessage(error, 'Password change failed') });
    }
    return;
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(authReq.user.id) as { password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, authReq.user.id);
  res.json({ success: true });
});

router.delete('/me', authenticate, async (req: Request, res: Response) => {
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

  if (authReq.authProvider === 'better-auth') {
    const result = await deleteBetterAuthUser(req);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: getBetterAuthErrorMessage(result.data, 'Account deletion failed') });
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(authReq.user.id);
  clearAuthCookie(res);
  res.json({ success: true });
});

router.put('/me/maps-key', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { maps_api_key } = req.body;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(maybe_encrypt_api_key(maps_api_key), authReq.user.id);

  res.json({ success: true, maps_api_key: maps_api_key || null });
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
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar'> | undefined;

  res.json({ success: true, user: { ...updated, maps_api_key: maskKey(updated?.maps_api_key), openweather_api_key: maskKey(updated?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});

router.put('/me/settings', authenticate, async (req: Request, res: Response) => {
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

  if (authReq.authProvider === 'better-auth' && (username !== undefined || email !== undefined)) {
    try {
      const body: Record<string, unknown> = {};
      if (username !== undefined) {
        body.name = username.trim();
        body.username = normalizeBetterAuthUsername(username.trim());
        body.displayUsername = username.trim();
      }
      if (email !== undefined) {
        body.email = email.trim().toLowerCase();
      }
      const result = await updateBetterAuthUser(req, body);
      if (!result.ok) {
        return res.status(result.status || 400).json({ error: getBetterAuthErrorMessage(result.data, 'Profile update failed') });
      }
      const refreshedUser = await refreshLocalUserFromBetterAuthRequest(req);
      if (refreshedUser) {
        authReq.user = refreshedUser;
      }
    } catch (error: unknown) {
      return res.status(400).json({ error: getBetterAuthErrorMessage(error, 'Profile update failed') });
    }
  }

  if (maps_api_key !== undefined) { updates.push('maps_api_key = ?'); params.push(maybe_encrypt_api_key(maps_api_key)); }
  if (openweather_api_key !== undefined) { updates.push('openweather_api_key = ?'); params.push(maybe_encrypt_api_key(openweather_api_key)); }
  if (authReq.authProvider !== 'better-auth') {
    if (username !== undefined) { updates.push('username = ?'); params.push(username.trim()); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email.trim().toLowerCase()); }
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(authReq.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar'> | undefined;

  res.json({ success: true, user: { ...updated, maps_api_key: maskKey(updated?.maps_api_key), openweather_api_key: maskKey(updated?.openweather_api_key), avatar_url: avatarUrl(updated || {}) } });
});

router.get('/me/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = db.prepare(
    'SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  res.json({ settings: { maps_api_key: decrypt_api_key(user.maps_api_key), openweather_api_key: decrypt_api_key(user.openweather_api_key) } });
});

router.post('/resource-token', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose : 'download';
  const token = createEphemeralToken(authReq.user.id, purpose);
  if (!token) return res.status(503).json({ error: 'Could not create token' });
  res.json({ token, purpose });
});

router.post('/avatar', authenticate, avatarUpload.single('avatar'), demoUploadBlock, async (req: Request, res: Response) => {
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
  if (authReq.authProvider === 'better-auth') {
    void updateBetterAuthUser(req, {
      image: avatarUrl(updated || {}),
    }).catch(() => {});
  }
  res.json({ success: true, avatar_url: avatarUrl(updated || {}) });
});

router.delete('/avatar', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(authReq.user.id) as { avatar: string | null } | undefined;
  if (current && current.avatar) {
    const filePath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(authReq.user.id);
  if (authReq.authProvider === 'better-auth') {
    void updateBetterAuthUser(req, {
      image: null,
    }).catch(() => {});
  }
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

// GitHub releases proxy (cached, avoids client-side rate limits)
let releasesCache: { data: unknown[]; fetchedAt: number } | null = null;
const RELEASES_CACHE_TTL = 30 * 60 * 1000;

router.get('/github-releases', authenticate, async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const perPage = Math.min(parseInt(req.query.per_page as string) || 10, 30);

  if (page === 1 && releasesCache && Date.now() - releasesCache.fetchedAt < RELEASES_CACHE_TTL) {
    return res.json(releasesCache.data.slice(0, perPage));
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/mauriceboe/NOMAD/releases?per_page=${perPage}&page=${page}`,
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'TREK-Server' } }
    );
    if (!resp.ok) return res.json([]);
    const data = await resp.json();
    if (page === 1) releasesCache = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

export { avatarUrl, generateToken, loginAttempts, mfaAttempts };
export default router;
