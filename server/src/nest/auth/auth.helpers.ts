import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User } from '../../types';
import { decrypt_api_key } from '../common/crypto/apiKeyCrypto';

/**
 * Pure half of the auth domain (no DB, no injected deps) — the DB half lives
 * in auth.service.ts. Split out so the legacy consumers (passkeyService, the
 * moved unit tests) and both the container singleton and the bridge instance
 * share one copy, mirroring atlas-geo.ts / maps.helpers.ts.
 *
 * Everything here moved verbatim from src/services/authService.ts.
 */

// bcrypt cost factor for user passwords. Shared by register/changePassword/
// resetPassword and the dummy-hash timing equaliser below — must stay in sync.
export const BCRYPT_COST = 12;

// Shape check for email input on register and profile update. The dot is pinned to
// the first one that can split the domain, so the runs on either side of it can
// never claim the same characters. Same strings as before, without backtracking.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

// Pre-computed bcrypt hash to equalise timing of "unknown email" and
// "OIDC-only account" branches with the real verification path (CWE-208).
// Import-time bcrypt on purpose (legacy parity): computing it lazily would
// make the first unknown-email login measurably slower than the rest.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('__trek_no_such_user__', BCRYPT_COST);

export const MFA_BACKUP_CODE_COUNT = 10;

export const ADMIN_SETTINGS_KEYS = [
  'allow_registration', 'allowed_file_types', 'require_mfa',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_skip_tls_verify',
  'notification_channels', 'admin_webhook_url', 'admin_ntfy_server', 'admin_ntfy_topic', 'admin_ntfy_token',
  'notify_trip_reminder',
  'password_login', 'password_registration', 'oidc_login', 'oidc_registration',
  'passkey_login', 'webauthn_rp_id', 'webauthn_origins',
  // Which places provider answers search/autocomplete/details: 'auto' (the
  // default and what every install had before Amap existed), 'google', 'amap' or
  // 'openstreetmap'. Validated in updateAppSettings — an unknown value is
  // refused rather than stored, because the reader degrades a bad row to 'auto'
  // and the admin would be left looking at a setting that does nothing.
  'places_provider',
];

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
    amap_api_key: _a,
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

// ---------------------------------------------------------------------------
// MFA helpers
// ---------------------------------------------------------------------------

export function normalizeBackupCode(input: string): string {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Legacy SHA-256 hex hash. Kept so existing stored hashes (from before
// the bcrypt migration) can still be verified in `matchBackupCode`
// without forcing every user to re-enrol their MFA device. New hashes
// are produced by `hashBackupCodeBcrypt` below.
export function hashBackupCode(input: string): string {
  return crypto.createHash('sha256').update(normalizeBackupCode(input)).digest('hex');
}

const BCRYPT_BACKUP_COST = 10;

/**
 * Hash a backup code with bcrypt for at-rest storage. Backup codes only
 * have ~40 bits of entropy (8 hex chars) so a plain SHA-256 rainbow
 * table cracks them in minutes if the DB ever leaks. bcrypt with a
 * moderate cost raises that cost by ~3-4 orders of magnitude.
 */
export function hashBackupCodeBcrypt(input: string): string {
  return bcrypt.hashSync(normalizeBackupCode(input), BCRYPT_BACKUP_COST);
}

/**
 * Constant-time match of a plaintext backup code against a stored hash
 * in either format (bcrypt or legacy SHA-256 hex). Used by login and
 * password-reset flows; callers that need to CONSUME the matching
 * entry should use this to find the index, then splice it out.
 */
export function matchBackupCode(plaintext: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2')) {
    // bcrypt hash — compareSync is constant-time internally.
    try { return bcrypt.compareSync(normalizeBackupCode(plaintext), storedHash); }
    catch { return false; }
  }
  // Legacy SHA-256 hex. Compare the SHA-256 of the input against the
  // stored hex with a constant-time comparator so timing can't leak.
  const candidate = hashBackupCode(plaintext);
  if (candidate.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash));
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
