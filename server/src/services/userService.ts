import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { db } from '../db/database';
import { validatePassword } from './passwordPolicy';
import { decrypt_api_key, maybe_encrypt_api_key, encrypt_api_key } from './apiKeyCrypto';
import { startTripReminders } from '../scheduler';
import { stripUserForClient, avatarUrl, isOidcOnlyMode, maskKey, mask_stored_api_key, utcSuffix } from './authService';
import { User } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ADMIN_SETTINGS_KEYS = [
  'allow_registration', 'allowed_file_types', 'require_mfa',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify',
  'notification_webhook_url', 'notification_channel',
  'notify_trip_invite', 'notify_booking_change', 'notify_trip_reminder',
  'notify_vacay_invite', 'notify_photos_shared', 'notify_collab_message', 'notify_packing_tagged',
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
  body: { maps_api_key?: string; openweather_api_key?: string; flight_api_key?: string }
) {
  const current = db.prepare('SELECT maps_api_key, openweather_api_key, flight_api_key FROM users WHERE id = ?').get(userId) as (Pick<User, 'maps_api_key' | 'openweather_api_key'> & { flight_api_key?: string | null }) | undefined;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, flight_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    body.maps_api_key !== undefined ? maybe_encrypt_api_key(body.maps_api_key) : current!.maps_api_key,
    body.openweather_api_key !== undefined ? maybe_encrypt_api_key(body.openweather_api_key) : current!.openweather_api_key,
    body.flight_api_key !== undefined ? maybe_encrypt_api_key(body.flight_api_key) : (current?.flight_api_key ?? null),
    userId
  );

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, flight_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(userId) as (Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> & { flight_api_key?: string | null }) | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  return {
    success: true,
    user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), flight_api_key: mask_stored_api_key(u?.flight_api_key), avatar_url: avatarUrl(updated || {}) },
  };
}

export function updateSettings(
  userId: number,
  body: { maps_api_key?: string; openweather_api_key?: string; flight_api_key?: string; username?: string; email?: string }
): { error?: string; status?: number; success?: boolean; user?: Record<string, unknown> } {
  const { maps_api_key, openweather_api_key, flight_api_key, username, email } = body;

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
  if (flight_api_key !== undefined) { updates.push('flight_api_key = ?'); params.push(maybe_encrypt_api_key(flight_api_key)); }
  if (username !== undefined) { updates.push('username = ?'); params.push(username.trim()); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email.trim()); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, flight_api_key, avatar, mfa_enabled FROM users WHERE id = ?'
  ).get(userId) as (Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'avatar' | 'mfa_enabled'> & { flight_api_key?: string | null }) | undefined;

  const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
  return {
    success: true,
    user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), flight_api_key: mask_stored_api_key(u?.flight_api_key), avatar_url: avatarUrl(updated || {}) },
  };
}

export function getSettings(userId: number): { error?: string; status?: number; settings?: Record<string, unknown> } {
  const user = db.prepare(
    'SELECT role, maps_api_key, openweather_api_key, flight_api_key FROM users WHERE id = ?'
  ).get(userId) as (Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key'> & { flight_api_key?: string | null }) | undefined;
  if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

  return {
    settings: {
      maps_api_key: decrypt_api_key(user.maps_api_key),
      openweather_api_key: decrypt_api_key(user.openweather_api_key),
      flight_api_key: decrypt_api_key(user.flight_api_key),
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
      let error_json: { error?: { message?: string; status?: string } } | null = null;
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
    if (row) result[key] = key === 'smtp_pass' ? '••••••••' : row.value;
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

  for (const key of ADMIN_SETTINGS_KEYS) {
    if (body[key] !== undefined) {
      let val = String(body[key]);
      if (key === 'require_mfa') {
        val = body[key] === true || val === 'true' ? 'true' : 'false';
      }
      if (key === 'smtp_pass' && val === '••••••••') continue;
      if (key === 'smtp_pass') val = encrypt_api_key(val);
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val);
    }
  }

  const changedKeys = ADMIN_SETTINGS_KEYS.filter(k => body[k] !== undefined && !(k === 'smtp_pass' && String(body[k]) === '••••••••'));

  const summary: Record<string, unknown> = {};
  const smtpChanged = changedKeys.some(k => k.startsWith('smtp_'));
  const eventsChanged = changedKeys.some(k => k.startsWith('notify_'));
  if (changedKeys.includes('notification_channel')) summary.notification_channel = body.notification_channel;
  if (changedKeys.includes('notification_webhook_url')) summary.webhook_url_updated = true;
  if (smtpChanged) summary.smtp_settings_updated = true;
  if (eventsChanged) summary.notification_events_updated = true;
  if (changedKeys.includes('allow_registration')) summary.allow_registration = body.allow_registration;
  if (changedKeys.includes('allowed_file_types')) summary.allowed_file_types_updated = true;
  if (changedKeys.includes('require_mfa')) summary.require_mfa = body.require_mfa;

  const debugDetails: Record<string, unknown> = {};
  for (const k of changedKeys) {
    debugDetails[k] = k === 'smtp_pass' ? '***' : body[k];
  }

  const notifRelated = ['notification_channel', 'notification_webhook_url', 'smtp_host', 'notify_trip_reminder'];
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
