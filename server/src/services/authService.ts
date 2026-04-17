import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { validatePassword } from './passwordPolicy';
import { encryptMfaSecret, decryptMfaSecret } from './mfaCrypto';
import { getAllPermissions } from './permissions';
import { decrypt_api_key, maybe_encrypt_api_key, encrypt_api_key } from './apiKeyCrypto';
import { createEphemeralToken } from './ephemeralTokens';
import { revokeUserSessions } from '../mcp';
import { startTripReminders } from '../scheduler';
import { User } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

authenticator.options = { window: 1 };

const MFA_SETUP_TTL_MS = 15 * 60 * 1000;
const mfaSetupPending = new Map<number, { secret: string; exp: number }>();
const MFA_BACKUP_CODE_COUNT = 10;

const ADMIN_SETTINGS_KEYS = [
  'allow_registration', 'allowed_file_types', 'require_mfa',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify',
  'notification_channels', 'admin_webhook_url', 'admin_ntfy_server', 'admin_ntfy_topic', 'admin_ntfy_token',
  'notify_trip_reminder',
  'password_login', 'password_registration', 'oidc_login', 'oidc_registration',
];

const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

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

// ---------------------------------------------------------------------------
// Helpers (exported for route-level use where needed)
// ---------------------------------------------------------------------------

export function utcSuffix(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
}

export function stripUserForClient(user: User): Record<string, unknown> {
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

export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '--------';
  return '----' + key.slice(-4);
}

export function mask_stored_api_key(key: string | null | undefined): string | null {
  const plain = decrypt_api_key(key);
  return maskKey(plain);
}

export function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

export function resolveAuthToggles(): {
  password_login: boolean;
  password_registration: boolean;
  oidc_login: boolean;
  oidc_registration: boolean;
} {
  const get = (key: string) =>
    (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;

  const hasNewKeys = ['password_login', 'password_registration', 'oidc_login', 'oidc_registration']
    .some(k => get(k) !== null);

  if (hasNewKeys) {
    const result = {
      password_login: get('password_login') !== 'false',
      password_registration: get('password_registration') !== 'false',
      oidc_login: get('oidc_login') !== 'false',
      oidc_registration: get('oidc_registration') !== 'false',
    };
    if (process.env.OIDC_ONLY === 'true') {
      result.password_login = false;
      result.password_registration = false;
    }
    return result;
  }

  // Legacy fallback
  const oidcOnlyEnabled = process.env.OIDC_ONLY === 'true' || get('oidc_only') === 'true';
  const oidcConfigured = !!(
    (process.env.OIDC_ISSUER || get('oidc_issuer')) &&
    (process.env.OIDC_CLIENT_ID || get('oidc_client_id'))
  );
  const oidcOnly = oidcOnlyEnabled && oidcConfigured;
  const allowReg = (get('allow_registration') ?? 'true') === 'true';

  return {
    password_login: !oidcOnly,
    password_registration: !oidcOnly && allowReg,
    oidc_login: true,
    oidc_registration: allowReg,
  };
}

export function isOidcOnlyMode(): boolean {
  return !resolveAuthToggles().password_login;
}

export function generateToken(user: { id: number | bigint }) {
  return jwt.sign(
    { id: user.id },
    JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' }
  );
}

// ---------------------------------------------------------------------------
// MFA helpers
// ---------------------------------------------------------------------------

export function normalizeBackupCode(input: string): string {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashBackupCode(input: string): string {
  return crypto.createHash('sha256').update(normalizeBackupCode(input)).digest('hex');
}

export function generateBackupCodes(count = MFA_BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

export function parseBackupCodeHashes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function getPendingMfaSecret(userId: number): string | null {
  const row = mfaSetupPending.get(userId);
  if (!row || Date.now() > row.exp) {
    mfaSetupPending.delete(userId);
    return null;
  }
  return row.secret;
}

// ---------------------------------------------------------------------------
// App config (public)
// ---------------------------------------------------------------------------

export function getAppConfig(authenticatedUser: { id: number } | null) {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const isDemo = process.env.DEMO_MODE === 'true';
  const toggles = resolveAuthToggles();
  const version: string = process.env.APP_VERSION ?? require('../../package.json').version;
  const hasGoogleKey = !!db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
  const oidcDisplayName = process.env.OIDC_DISPLAY_NAME ||
    (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_display_name'").get() as { value: string } | undefined)?.value || null;
  const oidcConfigured = !!(
    (process.env.OIDC_ISSUER || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get() as { value: string } | undefined)?.value) &&
    (process.env.OIDC_CLIENT_ID || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get() as { value: string } | undefined)?.value)
  );
  const requireMfaRow = db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined;
  const notifChannel = (db.prepare("SELECT value FROM app_settings WHERE key = 'notification_channel'").get() as { value: string } | undefined)?.value || 'none';
  const tripReminderSetting = (db.prepare("SELECT value FROM app_settings WHERE key = 'notify_trip_reminder'").get() as { value: string } | undefined)?.value;
  const hasSmtpHost = !!(process.env.SMTP_HOST || (db.prepare("SELECT value FROM app_settings WHERE key = 'smtp_host'").get() as { value: string } | undefined)?.value);
  const notifChannelsRaw = (db.prepare("SELECT value FROM app_settings WHERE key = 'notification_channels'").get() as { value: string } | undefined)?.value || notifChannel;
  const activeChannels = notifChannelsRaw === 'none' ? [] : notifChannelsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
  const hasWebhookEnabled = activeChannels.includes('webhook');
  const tripRemindersEnabled = tripReminderSetting !== 'false';
  const placesPhotosSetting = (db.prepare("SELECT value FROM app_settings WHERE key = 'places_photos_enabled'").get() as { value: string } | undefined)?.value;
  const placesPhotosEnabled = placesPhotosSetting !== 'false';
  const placesAutocompleteSetting = (db.prepare("SELECT value FROM app_settings WHERE key = 'places_autocomplete_enabled'").get() as { value: string } | undefined)?.value;
  const placesAutocompleteEnabled = placesAutocompleteSetting !== 'false';
  const placesDetailsSetting = (db.prepare("SELECT value FROM app_settings WHERE key = 'places_details_enabled'").get() as { value: string } | undefined)?.value;
  const placesDetailsEnabled = placesDetailsSetting !== 'false';
  const setupComplete = userCount > 0 && !(db.prepare("SELECT id FROM users WHERE role = 'admin' AND must_change_password = 1 LIMIT 1").get());

  return {
    // Legacy fields (backward compat)
    allow_registration: isDemo ? false : (toggles.password_registration || toggles.oidc_registration),
    oidc_only_mode: !toggles.password_login && !toggles.password_registration,
    // Granular toggles
    password_login: toggles.password_login,
    password_registration: isDemo ? false : toggles.password_registration,
    oidc_login: toggles.oidc_login,
    oidc_registration: isDemo ? false : toggles.oidc_registration,
    env_override_oidc_only: process.env.OIDC_ONLY === 'true',
    has_users: userCount > 0,
    setup_complete: setupComplete,
    version,
    is_prerelease: version.includes('-pre.'),
    has_maps_key: hasGoogleKey,
    oidc_configured: oidcConfigured,
    oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
    require_mfa: requireMfaRow?.value === 'true',
    allowed_file_types: (db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined)?.value || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
    demo_mode: isDemo,
    demo_email: isDemo ? 'demo@trek.app' : undefined,
    demo_password: isDemo ? 'demo12345' : undefined,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    notification_channel: notifChannel,
    notification_channels: activeChannels,
    available_channels: { email: hasSmtpHost, webhook: hasWebhookEnabled, inapp: true },
    trip_reminders_enabled: tripRemindersEnabled,
    places_photos_enabled: placesPhotosEnabled,
    places_autocomplete_enabled: placesAutocompleteEnabled,
    places_details_enabled: placesDetailsEnabled,
    permissions: authenticatedUser ? getAllPermissions() : undefined,
    dev_mode: process.env.NODE_ENV === 'development',
  };
}

// ---------------------------------------------------------------------------
// Auth: register, login, demo
// ---------------------------------------------------------------------------

export function demoLogin(): { error?: string; status?: number; token?: string; user?: Record<string, unknown> } {
  if (process.env.DEMO_MODE !== 'true') {
    return { error: 'Not found', status: 404 };
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@trek.app') as User | undefined;
  if (!user) return { error: 'Demo user not found', status: 500 };
  const token = generateToken(user);
  const safe = stripUserForClient(user) as Record<string, unknown>;
  return { token, user: { ...safe, avatar_url: avatarUrl(user) } };
}

export function validateInviteToken(token: string): { error?: string; status?: number; valid?: boolean; max_uses?: number; used_count?: number; expires_at?: string } {
  const invite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token) as any;
  if (!invite) return { error: 'Invalid invite link', status: 404 };
  if (invite.max_uses > 0 && invite.used_count >= invite.max_uses) return { error: 'Invite link has been fully used', status: 410 };
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { error: 'Invite link has expired', status: 410 };
  return { valid: true, max_uses: invite.max_uses, used_count: invite.used_count, expires_at: invite.expires_at };
}

export function registerUser(body: {
  username?: string;
  email?: string;
  password?: string;
  invite_token?: string;
}): { error?: string; status?: number; token?: string; user?: Record<string, unknown>; auditUserId?: number; auditDetails?: Record<string, unknown> } {
  const { username, email, password, invite_token } = body;

  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;

  let validInvite: any = null;
  if (invite_token) {
    validInvite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(invite_token);
    if (!validInvite) return { error: 'Invalid invite link', status: 400 };
    if (validInvite.max_uses > 0 && validInvite.used_count >= validInvite.max_uses) return { error: 'Invite link has been fully used', status: 410 };
    if (validInvite.expires_at && new Date(validInvite.expires_at) < new Date()) return { error: 'Invite link has expired', status: 410 };
  }

  if (userCount > 0 && !validInvite) {
    const toggles = resolveAuthToggles();
    if (!toggles.password_registration) {
      return { error: 'Password registration is disabled. Contact your administrator.', status: 403 };
    }
  }

  if (!username || !email || !password) {
    return { error: 'Username, email and password are required', status: 400 };
  }

  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { error: 'Invalid email format', status: 400 };
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)').get(email, username);
  if (existingUser) {
    return { error: 'Registration failed. Please try different credentials.', status: 409 };
  }

  const password_hash = bcrypt.hashSync(password, 12);
  const isFirstUser = userCount === 0;
  const role = isFirstUser ? 'admin' : 'user';

  try {
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, role, first_seen_version, login_count) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(username, email, password_hash, role, process.env.APP_VERSION || '0.0.0');

    const user = { id: result.lastInsertRowid, username, email, role, avatar: null, mfa_enabled: false };
    const token = generateToken(user);

    if (validInvite) {
      const updated = db.prepare(
        'UPDATE invite_tokens SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses) RETURNING used_count'
      ).get(validInvite.id);
      if (!updated) {
        console.warn(`[Auth] Invite token ${validInvite.token.slice(0, 8)}... exceeded max_uses due to race condition`);
      }
    }

    return {
      token,
      user: { ...user, avatar_url: null },
      auditUserId: Number(result.lastInsertRowid),
      auditDetails: { username, email, role },
    };
  } catch {
    return { error: 'Error creating user', status: 500 };
  }
}

export function loginUser(body: {
  email?: string;
  password?: string;
}): {
  error?: string;
  status?: number;
  token?: string;
  user?: Record<string, unknown>;
  mfa_required?: boolean;
  mfa_token?: string;
  auditUserId?: number | null;
  auditAction?: string;
  auditDetails?: Record<string, unknown>;
} {
  if (isOidcOnlyMode()) {
    return { error: 'Password authentication is disabled. Please sign in with SSO.', status: 403 };
  }

  const { email, password } = body;
  if (!email || !password) {
    return { error: 'Email and password are required', status: 400 };
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as User | undefined;
  if (!user) {
    return {
      error: 'Invalid email or password', status: 401,
      auditUserId: null, auditAction: 'user.login_failed', auditDetails: { email, reason: 'unknown_email' },
    };
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash!);
  if (!validPassword) {
    return {
      error: 'Invalid email or password', status: 401,
      auditUserId: Number(user.id), auditAction: 'user.login_failed', auditDetails: { email, reason: 'wrong_password' },
    };
  }

  if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
    const mfa_token = jwt.sign(
      { id: Number(user.id), purpose: 'mfa_login' },
      JWT_SECRET,
      { expiresIn: '5m', algorithm: 'HS256' }
    );
    return { mfa_required: true, mfa_token };
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?').run(user.id);
  const token = generateToken(user);
  const userSafe = stripUserForClient(user) as Record<string, unknown>;

  return {
    token,
    user: { ...userSafe, avatar_url: avatarUrl(user) },
    auditUserId: Number(user.id),
    auditAction: 'user.login',
    auditDetails: { email },
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function getCurrentUser(userId: number) {
  const user = db.prepare(
    'SELECT id, username, email, role, avatar, oidc_issuer, created_at, mfa_enabled, must_change_password FROM users WHERE id = ?'
  ).get(userId) as User | undefined;
  if (!user) return null;
  const base = stripUserForClient(user as User) as Record<string, unknown>;
  return { ...base, avatar_url: avatarUrl(user) };
}

// ---------------------------------------------------------------------------
// Password & account
// ---------------------------------------------------------------------------

export function changePassword(
  userId: number,
  userEmail: string,
  body: { current_password?: string; new_password?: string }
): { error?: string; status?: number; success?: boolean } {
  if (isOidcOnlyMode()) {
    return { error: 'Password authentication is disabled.', status: 403 };
  }
  if (process.env.DEMO_MODE === 'true' && userEmail === 'demo@trek.app') {
    return { error: 'Password change is disabled in demo mode.', status: 403 };
  }

  const { current_password, new_password } = body;
  if (!current_password) return { error: 'Current password is required', status: 400 };
  if (!new_password) return { error: 'New password is required', status: 400 };

  const pwCheck = validatePassword(new_password);
  if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return { error: 'Current password is incorrect', status: 401 };
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, userId);
  return { success: true };
}

export function deleteAccount(userId: number, userEmail: string, userRole: string): { error?: string; status?: number; success?: boolean } {
  if (process.env.DEMO_MODE === 'true' && userEmail === 'demo@trek.app') {
    return { error: 'Account deletion is disabled in demo mode.', status: 403 };
  }
  if (userRole === 'admin') {
    const adminCount = (db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number }).count;
    if (adminCount <= 1) {
      return { error: 'Cannot delete the last admin account', status: 400 };
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export function updateMapsKey(userId: number, maps_api_key: string | null | undefined) {
  db.prepare(
    'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(maybe_encrypt_api_key(maps_api_key), userId);
  return { success: true, maps_api_key: mask_stored_api_key(maps_api_key) };
}

export function updateApiKeys(
  userId: number,
  body: { maps_api_key?: string; openweather_api_key?: string }
) {
  const current = db.prepare('SELECT maps_api_key, openweather_api_key FROM users WHERE id = ?').get(userId) as Pick<User, 'maps_api_key' | 'openweather_api_key'> | undefined;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    body.maps_api_key !== undefined ? maybe_encrypt_api_key(body.maps_api_key) : current!.maps_api_key,
    body.openweather_api_key !== undefined ? maybe_encrypt_api_key(body.openweather_api_key) : current!.openweather_api_key,
    userId
  );

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(userId) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  return {
    success: true,
    user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) },
  };
}

export function updateSettings(
  userId: number,
  body: { maps_api_key?: string; openweather_api_key?: string; username?: string; email?: string }
): { error?: string; status?: number; success?: boolean; user?: Record<string, unknown> } {
  const { maps_api_key, openweather_api_key, username, email } = body;

  if (username !== undefined) {
    const trimmed = username.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
      return { error: 'Username must be between 2 and 50 characters', status: 400 };
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      return { error: 'Username can only contain letters, numbers, underscores, dots and hyphens', status: 400 };
    }
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(trimmed, userId);
    if (conflict) return { error: 'Username already taken', status: 409 };
  }

  if (email !== undefined) {
    const trimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!trimmed || !emailRegex.test(trimmed)) {
      return { error: 'Invalid email format', status: 400 };
    }
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, userId);
    if (conflict) return { error: 'Email already taken', status: 409 };
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (maps_api_key !== undefined) { updates.push('maps_api_key = ?'); params.push(maybe_encrypt_api_key(maps_api_key)); }
  if (openweather_api_key !== undefined) { updates.push('openweather_api_key = ?'); params.push(maybe_encrypt_api_key(openweather_api_key)); }
  if (username !== undefined) { updates.push('username = ?'); params.push(username.trim()); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email.trim()); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(userId) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  return {
    success: true,
    user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), avatar_url: avatarUrl(updated || {}) },
  };
}

export function getSettings(userId: number): { error?: string; status?: number; settings?: Record<string, unknown> } {
  const user = db.prepare(
    'SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?'
  ).get(userId) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

  return {
    settings: {
      maps_api_key: decrypt_api_key(user.maps_api_key),
      openweather_api_key: decrypt_api_key(user.openweather_api_key),
    },
  };
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

export function saveAvatar(userId: number, filename: string) {
  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(userId) as { avatar: string | null } | undefined;
  if (current && current.avatar) {
    const oldPath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  db.prepare('UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(filename, userId);

  const updated = db.prepare('SELECT id, username, email, role, avatar FROM users WHERE id = ?').get(userId) as Pick<User, 'id' | 'username' | 'email' | 'role' | 'avatar'> | undefined;
  return { success: true, avatar_url: avatarUrl(updated || {}) };
}

export function deleteAvatar(userId: number) {
  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(userId) as { avatar: string | null } | undefined;
  if (current && current.avatar) {
    const filePath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// User directory
// ---------------------------------------------------------------------------

export function listUsers(excludeUserId: number) {
  const users = db.prepare(
    'SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username ASC'
  ).all(excludeUserId) as Pick<User, 'id' | 'username' | 'avatar'>[];
  return users.map(u => ({ ...u, avatar_url: avatarUrl(u) }));
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

export async function validateKeys(userId: number): Promise<{ error?: string; status?: number; maps: boolean; weather: boolean; maps_details: null | { ok: boolean; status: number | null; status_text: string | null; error_message: string | null; error_status: string | null; error_raw: string | null } }> {
  const user = db.prepare('SELECT role, maps_api_key, openweather_api_key FROM users WHERE id = ?').get(userId) as Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> | undefined;
  if (user?.role !== 'admin') return { error: 'Admin access required', status: 403, maps: false, weather: false, maps_details: null };

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
          try { error_json = JSON.parse(error_text); } catch { error_json = null; }
        } catch { error_text = null; error_json = null; }
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
    } catch {
      result.weather = false;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------

export function getAppSettings(userId: number): { error?: string; status?: number; data?: Record<string, string> } {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

  const result: Record<string, string> = {};
  for (const key of ADMIN_SETTINGS_KEYS) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) result[key] = (key === 'smtp_pass' || key === 'admin_webhook_url' || key === 'admin_ntfy_token') ? '••••••••' : row.value;
  }
  return { data: result };
}

export function updateAppSettings(
  userId: number,
  body: Record<string, unknown>
): {
  error?: string;
  status?: number;
  success?: boolean;
  auditSummary?: Record<string, unknown>;
  auditDebugDetails?: Record<string, unknown>;
  shouldRestartScheduler?: boolean;
} {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

  const { require_mfa } = body;
  if (require_mfa === true || require_mfa === 'true') {
    const adminMfa = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(userId) as { mfa_enabled: number } | undefined;
    if (!(adminMfa?.mfa_enabled === 1)) {
      return {
        error: 'Enable two-factor authentication on your own account before requiring it for all users.',
        status: 400,
      };
    }
  }

  // Lockout prevention: can't disable all login methods
  if (body.password_login !== undefined || body.oidc_login !== undefined) {
    const current = resolveAuthToggles();
    const oidcConfigured = !!(
      (process.env.OIDC_ISSUER || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get() as { value: string } | undefined)?.value) &&
      (process.env.OIDC_CLIENT_ID || (db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get() as { value: string } | undefined)?.value)
    );
    const nextPasswordLogin = body.password_login !== undefined ? (String(body.password_login) === 'true') : current.password_login;
    const nextOidcLogin = body.oidc_login !== undefined ? (String(body.oidc_login) === 'true') : current.oidc_login;
    if (!nextPasswordLogin && (!nextOidcLogin || !oidcConfigured)) {
      return { error: 'Cannot disable all login methods. At least one must remain enabled.', status: 400 };
    }
  }

  for (const key of ADMIN_SETTINGS_KEYS) {
    if (body[key] !== undefined) {
      let val = String(body[key]);
      if (key === 'require_mfa') {
        val = body[key] === true || val === 'true' ? 'true' : 'false';
      }
      if (key === 'smtp_pass' && val === '••••••••') continue;
      if (key === 'smtp_pass') val = encrypt_api_key(val);
      if (key === 'admin_webhook_url' && val === '••••••••') continue;
      if (key === 'admin_webhook_url' && val) val = maybe_encrypt_api_key(val) ?? val;
      if (key === 'admin_ntfy_token' && val === '••••••••') continue;
      if (key === 'admin_ntfy_token' && val) val = maybe_encrypt_api_key(val) ?? val;
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val);
    }
  }

  const changedKeys = ADMIN_SETTINGS_KEYS.filter(k => body[k] !== undefined && !(k === 'smtp_pass' && String(body[k]) === '••••••••'));

  const summary: Record<string, unknown> = {};
  const smtpChanged = changedKeys.some(k => k.startsWith('smtp_'));
  if (changedKeys.includes('notification_channels')) summary.notification_channels = body.notification_channels;
  if (changedKeys.includes('admin_webhook_url')) summary.admin_webhook_url_updated = true;
  if (changedKeys.some(k => k.startsWith('admin_ntfy_'))) summary.admin_ntfy_updated = true;
  if (smtpChanged) summary.smtp_settings_updated = true;
  if (changedKeys.includes('allow_registration')) summary.allow_registration = body.allow_registration;
  if (changedKeys.includes('allowed_file_types')) summary.allowed_file_types_updated = true;
  if (changedKeys.includes('require_mfa')) summary.require_mfa = body.require_mfa;

  const debugDetails: Record<string, unknown> = {};
  for (const k of changedKeys) {
    debugDetails[k] = k === 'smtp_pass' ? '***' : body[k];
  }

  const notifRelated = ['notification_channels', 'smtp_host'];
  const shouldRestartScheduler = changedKeys.some(k => notifRelated.includes(k));
  if (shouldRestartScheduler) {
    startTripReminders();
  }

  return { success: true, auditSummary: summary, auditDebugDetails: debugDetails, shouldRestartScheduler };
}

// ---------------------------------------------------------------------------
// Travel stats
// ---------------------------------------------------------------------------

export function getTravelStats(userId: number) {
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

  return {
    countries: [...countries],
    cities: [...cities],
    coords,
    totalTrips: tripStats?.trips || 0,
    totalDays: tripStats?.days || 0,
    totalPlaces: places.length,
  };
}

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

export function setupMfa(userId: number, userEmail: string): { error?: string; status?: number; secret?: string; otpauth_url?: string; qrPromise?: Promise<string> } {
  if (process.env.DEMO_MODE === 'true' && userEmail === 'demo@nomad.app') {
    return { error: 'MFA is not available in demo mode.', status: 403 };
  }
  const row = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(userId) as { mfa_enabled: number } | undefined;
  if (row?.mfa_enabled) {
    return { error: 'MFA is already enabled', status: 400 };
  }
  let secret: string, otpauth_url: string;
  try {
    secret = authenticator.generateSecret();
    mfaSetupPending.set(userId, { secret, exp: Date.now() + MFA_SETUP_TTL_MS });
    otpauth_url = authenticator.keyuri(userEmail, 'TREK', secret);
  } catch (err) {
    console.error('[MFA] Setup error:', err);
    return { error: 'MFA setup failed', status: 500 };
  }
  return { secret, otpauth_url, qrPromise: QRCode.toString(otpauth_url, { type: 'svg', width: 250 }) };
}

export function enableMfa(userId: number, code?: string): { error?: string; status?: number; success?: boolean; mfa_enabled?: boolean; backup_codes?: string[] } {
  if (!code) {
    return { error: 'Verification code is required', status: 400 };
  }
  const pending = getPendingMfaSecret(userId);
  if (!pending) {
    return { error: 'No MFA setup in progress. Start the setup again.', status: 400 };
  }
  const tokenStr = String(code).replace(/\s/g, '');
  const ok = authenticator.verify({ token: tokenStr, secret: pending });
  if (!ok) {
    return { error: 'Invalid verification code', status: 401 };
  }
  const backupCodes = generateBackupCodes();
  const backupHashes = backupCodes.map(hashBackupCode);
  const enc = encryptMfaSecret(pending);
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    enc,
    JSON.stringify(backupHashes),
    userId
  );
  mfaSetupPending.delete(userId);
  return { success: true, mfa_enabled: true, backup_codes: backupCodes };
}

export function disableMfa(
  userId: number,
  userEmail: string,
  body: { password?: string; code?: string }
): { error?: string; status?: number; success?: boolean; mfa_enabled?: boolean } {
  if (process.env.DEMO_MODE === 'true' && userEmail === 'demo@nomad.app') {
    return { error: 'MFA cannot be changed in demo mode.', status: 403 };
  }
  const policy = db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined;
  if (policy?.value === 'true') {
    return { error: 'Two-factor authentication cannot be disabled while it is required for all users.', status: 403 };
  }
  const { password, code } = body;
  if (!password || !code) {
    return { error: 'Password and authenticator code are required', status: 400 };
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
  if (!user?.mfa_enabled || !user.mfa_secret) {
    return { error: 'MFA is not enabled', status: 400 };
  }
  if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return { error: 'Incorrect password', status: 401 };
  }
  const secret = decryptMfaSecret(user.mfa_secret);
  const tokenStr = String(code).replace(/\s/g, '');
  const ok = authenticator.verify({ token: tokenStr, secret });
  if (!ok) {
    return { error: 'Invalid verification code', status: 401 };
  }
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    userId
  );
  mfaSetupPending.delete(userId);
  return { success: true, mfa_enabled: false };
}

export function verifyMfaLogin(body: {
  mfa_token?: string;
  code?: string;
}): {
  error?: string;
  status?: number;
  token?: string;
  user?: Record<string, unknown>;
  auditUserId?: number;
} {
  const { mfa_token, code } = body;
  if (!mfa_token || !code) {
    return { error: 'Verification token and code are required', status: 400 };
  }
  try {
    const decoded = jwt.verify(mfa_token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; purpose?: string };
    if (decoded.purpose !== 'mfa_login') {
      return { error: 'Invalid verification token', status: 401 };
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    if (!user || !(user.mfa_enabled === 1 || user.mfa_enabled === true) || !user.mfa_secret) {
      return { error: 'Invalid session', status: 401 };
    }
    const secret = decryptMfaSecret(user.mfa_secret);
    const tokenStr = String(code).trim();
    const okTotp = authenticator.verify({ token: tokenStr.replace(/\s/g, ''), secret });
    if (!okTotp) {
      const hashes = parseBackupCodeHashes(user.mfa_backup_codes);
      const candidateHash = hashBackupCode(tokenStr);
      const idx = hashes.findIndex(h => h === candidateHash);
      if (idx === -1) {
        return { error: 'Invalid verification code', status: 401 };
      }
      hashes.splice(idx, 1);
      db.prepare('UPDATE users SET mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(hashes),
        user.id
      );
    }
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?').run(user.id);
    const sessionToken = generateToken(user);
    const userSafe = stripUserForClient(user) as Record<string, unknown>;
    return {
      token: sessionToken,
      user: { ...userSafe, avatar_url: avatarUrl(user) },
      auditUserId: Number(user.id),
    };
  } catch {
    return { error: 'Invalid or expired verification token', status: 401 };
  }
}

// ---------------------------------------------------------------------------
// MCP tokens
// ---------------------------------------------------------------------------

export function listMcpTokens(userId: number) {
  return db.prepare(
    'SELECT id, name, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

export function createMcpToken(userId: number, name?: string): { error?: string; status?: number; token?: Record<string, unknown> } {
  if (!name?.trim()) return { error: 'Token name is required', status: 400 };
  if (name.trim().length > 100) return { error: 'Token name must be 100 characters or less', status: 400 };

  const tokenCount = (db.prepare('SELECT COUNT(*) as count FROM mcp_tokens WHERE user_id = ?').get(userId) as { count: number }).count;
  if (tokenCount >= 10) return { error: 'Maximum of 10 tokens per user reached', status: 400 };

  const rawToken = 'trek_' + randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.slice(0, 13);

  const result = db.prepare(
    'INSERT INTO mcp_tokens (user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?)'
  ).run(userId, name.trim(), tokenHash, tokenPrefix);

  const token = db.prepare(
    'SELECT id, name, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE id = ?'
  ).get(result.lastInsertRowid);

  return { token: { ...(token as object), raw_token: rawToken } };
}

export function deleteMcpToken(userId: number, tokenId: string): { error?: string; status?: number; success?: boolean } {
  const token = db.prepare('SELECT id FROM mcp_tokens WHERE id = ? AND user_id = ?').get(tokenId, userId);
  if (!token) return { error: 'Token not found', status: 404 };
  db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(tokenId);
  revokeUserSessions(userId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Ephemeral tokens
// ---------------------------------------------------------------------------

export function createWsToken(userId: number): { error?: string; status?: number; token?: string } {
  const token = createEphemeralToken(userId, 'ws');
  if (!token) return { error: 'Service unavailable', status: 503 };
  return { token };
}

export function createResourceToken(userId: number, purpose?: string): { error?: string; status?: number; token?: string } {
  if (purpose !== 'download') {
    return { error: 'Invalid purpose', status: 400 };
  }
  const token = createEphemeralToken(userId, purpose);
  if (!token) return { error: 'Service unavailable', status: 503 };
  return { token };
}

// ---------------------------------------------------------------------------
// MCP auth helpers
// ---------------------------------------------------------------------------

export function isDemoUser(userId: number): boolean {
  if (process.env.DEMO_MODE !== 'true') return false;
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return user?.email === 'demo@nomad.app';
}

export function verifyMcpToken(rawToken: string): User | null {
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const row = db.prepare(`
    SELECT u.id, u.username, u.email, u.role
    FROM mcp_tokens mt
    JOIN users u ON mt.user_id = u.id
    WHERE mt.token_hash = ?
  `).get(hash) as User | undefined;
  if (row) {
    db.prepare('UPDATE mcp_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash);
    return row;
  }
  return null;
}

export function verifyJwtToken(token: string): User | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    return user || null;
  } catch {
    return null;
  }
}
