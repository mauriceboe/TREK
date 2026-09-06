import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';
import type { Request, Response } from 'express';
import { readEnv } from '../../app-config';
import { JWT_SECRET, SESSION_DURATION_SECONDS, SESSION_DURATION_REMEMBER_SECONDS } from '../../config';
import { DatabaseService } from '../database/database.service';
import { PermissionsService } from '../permissions/permissions.service';
import { validatePassword } from '../common/passwordPolicy';
import { encryptMfaSecret, decryptMfaSecret } from '../common/crypto/mfaCrypto';
import { decrypt_api_key, maybe_encrypt_api_key, encrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { resolveApiKey } from '../settings/instance-api-keys';
import { EphemeralTokenService } from './ephemeral-token.service';
// Import from sessionManager directly, NOT the ../../mcp barrel: the barrel pulls
// the whole tools fan-out (and via the domain bridges, the Nest services) into
// every consumer of this module — a nest→mcp→nest module cycle.
import { revokeUserSessions } from '../../mcp/sessionManager';
import { UserCleanupService } from './user-cleanup.service';
import { splitManagedKeys } from '../common/managed';
import { emitUserDeleted } from '../../plugin-user-lifecycle';
import { verifyJwtAndLoadUser } from './jwt-verify';
import { User } from '../../types';
import { DEMO_EMAIL_PRIMARY, DEMO_PASS, isDemoEmail } from '../common/demo';
import { avatarUrl } from '../common/avatarUrl';
import { TripMembershipService } from '../trip-membership/trip-membership.service';
import { WebauthnConfigService } from './webauthn-config.service';
import { setAuthCookie, clearAuthCookie } from '../common/cookie';
import { MailerService } from '../notifications/mailer/mailer.service';
import { AllowedFileTypesService } from '../files/allowed-file-types.service';
import { getAppUrl } from '../../app-config';
import {
  ADMIN_SETTINGS_KEYS,
  BCRYPT_COST,
  DUMMY_PASSWORD_HASH,
  EMAIL_REGEX,
  generateBackupCodes,
  hashBackupCodeBcrypt,
  mask_stored_api_key,
  matchBackupCode,
  parseBackupCodeHashes,
  stripUserForClient,
} from './auth.helpers';

// Mutates otplib module state; must run before any TOTP verify in either the
// container singleton or the bridge instance (legacy parity — same line sat at
// the top of services/authService.ts).
authenticator.options = { window: 1 };

const MFA_SETUP_TTL_MS = 15 * 60 * 1000;
// Module-scoped on purpose: the bridge instance and the container singleton
// must see the same pending-MFA state (permissions-cache precedent).
const mfaSetupPending = new Map<number, { secret: string; exp: number }>();

// 60 min; long enough to read the email in a second tab, short enough
// that a leaked link is unlikely to still be valid when someone tries it.
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_BYTES = 32; // 256-bit entropy

/**
 * Returns the SHA-256 hex hash of a reset token. Raw tokens are never
 * persisted — we only store and compare their hashes.
 */
function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Shape returned by requestPasswordReset. For enumeration-safety the
 * route ALWAYS returns the same response to the client regardless of
 * whether a user existed — this struct is only consumed internally by
 * the route handler to decide whether to send an email / log a link.
 */
export interface PasswordResetRequestOutcome {
  tokenForDelivery: string | null;   // raw token — send via email or log, never return to client
  userId: number | null;
  userEmail: string | null;
  reason: 'issued' | 'no_user' | 'oidc_only' | 'throttled_per_email' | 'password_login_disabled';
}

// Per-email throttle (defence-in-depth on top of the per-IP limiter).
// Module-scoped + import-time interval on purpose (legacy parity, shared
// between bridge and container instances — atlas-geo interval precedent).
const perEmailResetAttempts = new Map<string, { count: number; first: number }>();
const PASSWORD_RESET_PER_EMAIL_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_RESET_PER_EMAIL_MAX = 3;
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of perEmailResetAttempts) {
    if (now - record.first >= PASSWORD_RESET_PER_EMAIL_WINDOW_MS) perEmailResetAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

export interface ResetPasswordOutcome {
  error?: string;
  status?: number;
  success?: boolean;
  /** When true the client must collect a TOTP/backup code and call again. */
  mfa_required?: boolean;
  userId?: number;
}

/**
 * DI-native auth domain service. The SQL moved 1:1 from the legacy
 * src/services/authService.ts (same statements, same `||` falsy-coercion
 * defaults, same post-write re-selects, same error strings); the pure
 * password/backup-code crypto lives in auth.helpers.ts. PermissionsService is
 * injected (it replaced the permissions.bridge import); the JWT cookie
 * set/clear, the reset-email delivery and the remaining legacy helpers keep
 * their plain imports. Non-Nest consumers (legacy MCP registrars, legacy
 * adminService/oidcService/passkeyService) go through auth.bridge.ts.
 *
 * AtlasService is deliberately NOT injected any more: getTravelStats, its only
 * reader, now lives on AtlasService itself. Dropping that edge is what lets
 * AtlasModule import AuthModule instead of going the other way around.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly membership: TripMembershipService,
    private readonly webauthn: WebauthnConfigService,
    private readonly userCleanup: UserCleanupService,
    private readonly mailer: MailerService,
    private readonly tokens: EphemeralTokenService,
    private readonly allowedFileTypes: AllowedFileTypesService,
  ) {}

  // Cookie
  setAuthCookie(res: Response, token: string, req: Request, remember?: boolean) { setAuthCookie(res, token, req, remember); }
  clearAuthCookie(res: Response, req: Request) { clearAuthCookie(res, req); }

  // Reset-email delivery (canonical app URL, never request headers)
  getAppUrl() { return getAppUrl(); }
  sendPasswordResetEmail(email: string, url: string, userId: number | null) { return this.mailer.sendPasswordResetEmail(email, url, userId); }

  // -------------------------------------------------------------------------
  // Toggles + tokens
  // -------------------------------------------------------------------------

  resolveAuthToggles(): {
    password_login: boolean;
    password_registration: boolean;
    oidc_login: boolean;
    oidc_registration: boolean;
    passkey_login: boolean;
  } {
    const get = (key: string) =>
      this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)?.value ?? null;

    // Passkey login is independent of the password/OIDC "new keys" probe, so it
    // must be resolved OUTSIDE the branch below — otherwise on a fresh install
    // that never touched the password/OIDC toggles it would silently read false
    // even after an admin enabled it. Default OFF (opt-in).
    const passkey_login = get('passkey_login') === 'true';

    const hasNewKeys = ['password_login', 'password_registration', 'oidc_login', 'oidc_registration']
      .some(k => get(k) !== null);

    if (hasNewKeys) {
      const result = {
        password_login: get('password_login') !== 'false',
        password_registration: get('password_registration') !== 'false',
        oidc_login: get('oidc_login') !== 'false',
        oidc_registration: get('oidc_registration') !== 'false',
        passkey_login,
      };
      if (readEnv().oidc.only) {
        result.password_login = false;
        result.password_registration = false;
      }
      return result;
    }

    // Legacy fallback
    const oidcOnlyEnabled = readEnv().oidc.only || get('oidc_only') === 'true';
    const oidcConfigured = !!(
      (readEnv().oidc.issuer || get('oidc_issuer')) &&
      (readEnv().oidc.clientId || get('oidc_client_id'))
    );
    const oidcOnly = oidcOnlyEnabled && oidcConfigured;
    const allowReg = (get('allow_registration') ?? 'true') === 'true';

    return {
      password_login: !oidcOnly,
      password_registration: !oidcOnly && allowReg,
      oidc_login: true,
      oidc_registration: allowReg,
      passkey_login,
    };
  }

  isOidcOnlyMode(): boolean {
    return !this.resolveAuthToggles().password_login;
  }

  generateToken(user: { id: number | bigint; password_version?: number }, remember?: boolean) {
    const pv = typeof user.password_version === 'number'
      ? user.password_version
      : (this.db.get<{ password_version?: number }>('SELECT password_version FROM users WHERE id = ?', user.id)?.password_version ?? 0);
    // "Remember me" extends the JWT lifetime to match the persistent cookie maxAge;
    // the cookie service decides session-vs-persistent off the same flag.
    const expiresIn = remember === true ? SESSION_DURATION_REMEMBER_SECONDS : SESSION_DURATION_SECONDS;
    // The flag is embedded as a claim so sliding renewal can re-issue with the
    // same duration AND cookie semantics (false → browser-session cookie is not
    // recoverable from exp − iat). Omitted when the caller didn't choose, so
    // register/demo/passkey tokens keep their historical payload.
    return jwt.sign(
      { id: user.id, pv, ...(typeof remember === 'boolean' ? { remember } : {}) },
      JWT_SECRET,
      { expiresIn, algorithm: 'HS256' }
    );
  }

  getPendingMfaSecret(userId: number): string | null {
    const row = mfaSetupPending.get(userId);
    if (!row || Date.now() > row.exp) {
      mfaSetupPending.delete(userId);
      return null;
    }
    return row.secret;
  }

  // -------------------------------------------------------------------------
  // App config (public)
  // -------------------------------------------------------------------------

  /**
   * Whether a passkey ceremony can actually complete on this deployment. With
   * nothing configured at all, getAppUrl() invents `http://localhost:{PORT}` and
   * the resolver returns a localhost RP for it: a phantom config that every real
   * browser is turned away from at the options step (#2147), so advertising it
   * as configured only produces a button whose every click 400s. A localhost RP
   * the operator pointed here themselves (APP_URL, ALLOWED_ORIGINS or the
   * webauthn settings) is a real single-machine install and still counts.
   */
  private passkeyConfigured(): boolean {
    const cfg = this.webauthn.resolve();
    if (!cfg) return false;
    if (cfg.rpID !== 'localhost' || cfg.explicitOrigins) return true;
    const env = readEnv();
    const declaredRpId = (
      env.webauthn.rpId || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'webauthn_rp_id'")?.value
    )?.trim();
    return !!(declaredRpId || env.app.appUrl || env.http.allowedOriginsRaw);
  }

  getAppConfig(authenticatedUser: User | undefined | null) {
    const userCount = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM users WHERE COALESCE(is_guest, 0) = 0')!.count;
    const isDemo = readEnv().demo.enabled;
    const toggles = this.resolveAuthToggles();
    // One directory deeper than the legacy src/services location — the extra
    // '../' keeps resolving to the workspace package.json.
    const version: string = readEnv().app.appVersion ?? require('../../../package.json').version;
    // Asked through the same resolver the search itself uses, so the client can
    // never show Google features that rest on a key this caller does not get —
    // nor hide them from a member who does have one (#1939). Unauthenticated the
    // question is only about the instance, which is the first two steps of the
    // chain; id 0 matches no row.
    const hasGoogleKey = !!resolveApiKey(this.db, 'maps_api_key', authenticatedUser?.id ?? 0, readEnv().maps.placesApiKey).key;
    const oidcDisplayName = readEnv().oidc.displayName ||
      this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'oidc_display_name'")?.value || null;
    const oidcConfigured = !!(
      (readEnv().oidc.issuer || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'oidc_issuer'")?.value) &&
      (readEnv().oidc.clientId || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'oidc_client_id'")?.value)
    );
    const requireMfaRow = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'require_mfa'");
    const notifChannel = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_channel'")?.value || 'none';
    const tripReminderSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notify_trip_reminder'")?.value;
    const hasSmtpHost = !!(readEnv().smtp.host || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'smtp_host'")?.value);
    const notifChannelsRaw = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_channels'")?.value || notifChannel;
    const activeChannels = notifChannelsRaw === 'none' ? [] : notifChannelsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
    const hasWebhookEnabled = activeChannels.includes('webhook');
    const tripRemindersEnabled = tripReminderSetting !== 'false';
    const placesPhotosSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'places_photos_enabled'")?.value;
    const placesPhotosEnabled = placesPhotosSetting !== 'false';
    const placesAutocompleteSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'places_autocomplete_enabled'")?.value;
    const placesAutocompleteEnabled = placesAutocompleteSetting !== 'false';
    const placesDetailsSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'places_details_enabled'")?.value;
    const placesDetailsEnabled = placesDetailsSetting !== 'false';
    const placesEnrichSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'places_enrich_enabled'")?.value;
    const placesEnrichEnabled = placesEnrichSetting !== 'false';
    // Fail-closed, and deliberately on this unauthenticated endpoint: whether an
    // instance records what its users search for is something a visitor is
    // entitled to know before logging in, not a detail to keep behind the door.
    const placeShadowSetting = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'place_shadow_enabled'")?.value;
    const placeShadowEnabled = placeShadowSetting === 'true';
    const setupComplete = userCount > 0 && !this.db.get("SELECT id FROM users WHERE role = 'admin' AND must_change_password = 1 LIMIT 1");

    return {
      // Legacy fields (backward compat)
      allow_registration: isDemo ? false : (toggles.password_registration || toggles.oidc_registration),
      oidc_only_mode: !toggles.password_login && !toggles.password_registration,
      // Granular toggles
      password_login: toggles.password_login,
      password_registration: isDemo ? false : toggles.password_registration,
      oidc_login: toggles.oidc_login,
      oidc_registration: isDemo ? false : toggles.oidc_registration,
      // Passkey login: the instance toggle + whether a usable RP ID resolves for
      // this deployment. The login page shows the passkey button only when both
      // are true. `passkey_configured` stays a pure boolean — it never leaks the
      // resolved RP ID / origin / APP_URL on this unauthenticated endpoint.
      passkey_login: toggles.passkey_login,
      passkey_configured: this.passkeyConfigured(),
      env_override_oidc_only: readEnv().oidc.only,
      has_users: userCount > 0,
      setup_complete: setupComplete,
      version,
      is_prerelease: version.includes('-pre.'),
      has_maps_key: hasGoogleKey,
      oidc_configured: oidcConfigured,
      oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
      require_mfa: requireMfaRow?.value === 'true',
      // The canonical live-read: same query + DEFAULT_ALLOWED_EXTENSIONS
      // fallback the upload filters use, so the client's picker and the
      // server's acceptance can never drift (the historical inline copy here
      // dropped pkpass, pkpasses, md and markdown).
      allowed_file_types: this.allowedFileTypes.get(),
      // Whether the configuration belongs to whoever operates this install
      // rather than to its admin. The client uses it to stop offering settings
      // the server would refuse anyway — it is an honesty flag for the UI, never
      // the boundary itself, which is the guard and the operator's network.
      managed: readEnv().managed.enabled,
      demo_mode: isDemo,
      demo_email: isDemo ? DEMO_EMAIL_PRIMARY : undefined,
      demo_password: isDemo ? DEMO_PASS : undefined,
      timezone: readEnv().app.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      notification_channel: notifChannel,
      notification_channels: activeChannels,
      available_channels: { email: hasSmtpHost, webhook: hasWebhookEnabled, inapp: true },
      trip_reminders_enabled: tripRemindersEnabled,
      places_photos_enabled: placesPhotosEnabled,
      places_autocomplete_enabled: placesAutocompleteEnabled,
      places_details_enabled: placesDetailsEnabled,
      places_enrich_enabled: placesEnrichEnabled,
      place_shadow_enabled: placeShadowEnabled,
      permissions: authenticatedUser ? this.permissions.getAllPermissions() : undefined,
      // Case-sensitive on purpose (legacy parity).
      dev_mode: readEnv().app.nodeEnv === 'development',
    };
  }

  // -------------------------------------------------------------------------
  // Auth: register, login, demo
  // -------------------------------------------------------------------------

  demoLogin(): { error?: string; status?: number; token?: string; user?: Record<string, unknown> } {
    if (!readEnv().demo.enabled) {
      return { error: 'Not found', status: 404 };
    }
    const user = this.db.get<User>('SELECT * FROM users WHERE email = ?', DEMO_EMAIL_PRIMARY);
    if (!user) return { error: 'Demo user not found', status: 500 };
    const token = this.generateToken(user);
    const safe = stripUserForClient(user) as Record<string, unknown>;
    return { token, user: { ...safe, avatar_url: avatarUrl(user) } };
  }

  validateInviteToken(token: string): { error?: string; status?: number; valid?: boolean; max_uses?: number; used_count?: number; expires_at?: string } {
    const invite = this.db.get('SELECT * FROM invite_tokens WHERE token = ?', token) as any;
    if (!invite) return { error: 'Invalid invite link', status: 404 };
    if (invite.max_uses > 0 && invite.used_count >= invite.max_uses) return { error: 'Invite link has been fully used', status: 410 };
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { error: 'Invite link has expired', status: 410 };
    return { valid: true, max_uses: invite.max_uses, used_count: invite.used_count, expires_at: invite.expires_at };
  }

  registerUser(rawBody: unknown): { error?: string; status?: number; token?: string; user?: Record<string, unknown>; auditUserId?: number; auditDetails?: Record<string, unknown> } {
    const body = rawBody as { username?: string; email?: string; password?: string; invite_token?: string };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const { password, invite_token } = body;

    const userCount = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM users WHERE COALESCE(is_guest, 0) = 0')!.count;

    let validInvite: any = null;
    if (invite_token) {
      validInvite = this.db.get('SELECT * FROM invite_tokens WHERE token = ?', invite_token);
      if (!validInvite) return { error: 'Invalid invite link', status: 400 };
      if (validInvite.max_uses > 0 && validInvite.used_count >= validInvite.max_uses) return { error: 'Invite link has been fully used', status: 410 };
      if (validInvite.expires_at && new Date(validInvite.expires_at) < new Date()) return { error: 'Invite link has expired', status: 410 };
    }

    if (userCount > 0 && !validInvite) {
      const toggles = this.resolveAuthToggles();
      if (!toggles.password_registration) {
        return { error: 'Password registration is disabled. Contact your administrator.', status: 403 };
      }
    }

    if (!username || !email || !password) {
      return { error: 'Username, email and password are required', status: 400 };
    }

    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };

    if (!EMAIL_REGEX.test(email)) {
      return { error: 'Invalid email format', status: 400 };
    }

    // Ignore guests (#1362): their synthetic username/email must never block a real signup.
    const existingUser = this.db.get('SELECT id FROM users WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)) AND COALESCE(is_guest, 0) = 0', email, username);
    if (existingUser) {
      return { error: 'Registration failed. Please try different credentials.', status: 409 };
    }

    const password_hash = bcrypt.hashSync(password, BCRYPT_COST);
    const isFirstUser = userCount === 0;
    const role = isFirstUser ? 'admin' : 'user';

    try {
      // One transaction for the whole signup: a mid-sequence throw (invite
      // bookkeeping, trip auto-join) must not leave a half-registered user.
      return this.db.transaction(() => {
        const result = this.db.run(
          'INSERT INTO users (username, email, password_hash, role, first_seen_version, login_count) VALUES (?, ?, ?, ?, ?, 0)',
          username, email, password_hash, role, readEnv().app.appVersion || '0.0.0'
        );

        const user = { id: result.lastInsertRowid, username, email, role, avatar: null, mfa_enabled: false };
        const token = this.generateToken(user);

        if (validInvite) {
          const updated = this.db.get(
            'UPDATE invite_tokens SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses) RETURNING used_count',
            validInvite.id
          );
          if (!updated) {
            console.warn(`[Auth] Invite token ${validInvite.token.slice(0, 8)}... exceeded max_uses due to race condition`);
          }
          // Trip-bound invite (#1402): auto-add the freshly registered user to the
          // trip. Idempotent + owner-safe; no-ops if the bound trip was since deleted.
          if (validInvite.trip_id) {
            this.membership.joinTripAsMember(Number(validInvite.trip_id), Number(result.lastInsertRowid), validInvite.created_by ?? null);
          }
        }

        return {
          token,
          user: { ...user, avatar_url: null },
          auditUserId: Number(result.lastInsertRowid),
          auditDetails: { username, email, role },
        };
      });
    } catch {
      return { error: 'Error creating user', status: 500 };
    }
  }

  loginUser(rawBody: unknown): {
    error?: string;
    status?: number;
    token?: string;
    user?: Record<string, unknown>;
    mfa_required?: boolean;
    mfa_token?: string;
    remember?: boolean;
    auditUserId?: number | null;
    auditAction?: string;
    auditDetails?: Record<string, unknown>;
  } {
    const body = rawBody as { email?: string; password?: string; remember_me?: boolean };
    if (this.isOidcOnlyMode()) {
      return { error: 'Password authentication is disabled. Please sign in with SSO.', status: 403 };
    }

    const { email, password, remember_me } = body;
    const remember = remember_me === true;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }

    // Guests (#1362) carry a synthetic email but must never authenticate — treat a
    // matched guest row exactly like an unknown email (dummy-hash timing preserved).
    const user = this.db.get<User>('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND COALESCE(is_guest, 0) = 0', email);

    // Always run bcrypt — even for unknown/OIDC-only users — so response time
    // does not reveal whether the email exists in the database (CWE-203/208).
    const hashToCheck = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const validPassword = bcrypt.compareSync(password, hashToCheck);

    if (!user) {
      return {
        error: 'Invalid email or password', status: 401,
        auditUserId: null, auditAction: 'user.login_failed', auditDetails: { email, reason: 'unknown_email' },
      };
    }
    if (!user.password_hash) {
      return {
        error: 'Invalid email or password', status: 401,
        auditUserId: Number(user.id), auditAction: 'user.login_failed', auditDetails: { email, reason: 'oidc_only' },
      };
    }
    if (!validPassword) {
      return {
        error: 'Invalid email or password', status: 401,
        auditUserId: Number(user.id), auditAction: 'user.login_failed', auditDetails: { email, reason: 'wrong_password' },
      };
    }

    if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
      const pv = (user as User & { password_version?: number }).password_version ?? 0;
      const mfa_token = jwt.sign(
        { id: Number(user.id), purpose: 'mfa_login', pv },
        JWT_SECRET,
        { expiresIn: '5m', algorithm: 'HS256' }
      );
      return { mfa_required: true, mfa_token };
    }

    this.db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?', user.id);
    const token = this.generateToken(user, remember);
    const userSafe = stripUserForClient(user) as Record<string, unknown>;

    return {
      token,
      user: { ...userSafe, avatar_url: avatarUrl(user) },
      remember,
      auditUserId: Number(user.id),
      auditAction: 'user.login',
      auditDetails: { email },
    };
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  getCurrentUser(
    userId: number
  ): (Record<string, unknown> & Pick<User, 'id' | 'username' | 'email' | 'role'> & { avatar_url: string }) | null {
    const user = this.db.get<User>(
      'SELECT id, username, email, role, avatar, oidc_issuer, created_at, mfa_enabled, must_change_password FROM users WHERE id = ?',
      userId
    );
    if (!user) return null;
    const base = stripUserForClient(user as User) as Record<string, unknown>;
    return { ...base, id: user.id, username: user.username, email: user.email, role: user.role, avatar_url: avatarUrl(user) };
  }

  // -------------------------------------------------------------------------
  // Password & account
  // -------------------------------------------------------------------------

  changePassword(
    userId: number,
    userEmail: string,
    rawBody: unknown,
    remember?: boolean,
  ): { error?: string; status?: number; success?: boolean; token?: string } {
    const body = rawBody as { current_password?: string; new_password?: string };
    if (this.isOidcOnlyMode()) {
      return { error: 'Password authentication is disabled.', status: 403 };
    }
    if (readEnv().demo.enabled && isDemoEmail(userEmail)) {
      return { error: 'Password change is disabled in demo mode.', status: 403 };
    }

    const { current_password, new_password } = body;
    if (!current_password) return { error: 'Current password is required', status: 400 };
    if (!new_password) return { error: 'New password is required', status: 400 };

    const pwCheck = validatePassword(new_password);
    if (!pwCheck.ok) return { error: pwCheck.reason, status: 400 };

    const user = this.db.get<{ password_hash: string; password_version?: number }>('SELECT password_hash, password_version FROM users WHERE id = ?', userId);
    if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
      return { error: 'Current password is incorrect', status: 401 };
    }

    const hash = bcrypt.hashSync(new_password, BCRYPT_COST);
    const newPv = (user.password_version ?? 0) + 1;

    this.db.transaction(() => {
      this.db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', hash, newPv, userId);
      // A password change rotates the user's sessions: bumping password_version
      // invalidates existing JWT cookie sessions, and the separate MCP static
      // token and OAuth bearer-token stores are pruned to match (same set the
      // password-reset path already revokes).
      this.db.run('DELETE FROM mcp_tokens WHERE user_id = ?', userId);
      try {
        this.db.run("UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL", userId);
      } catch { /* oauth_tokens table may not exist in very old installs */ }
    });

    try { revokeUserSessions?.(userId); } catch { /* best-effort */ }

    // Re-issue a session bound to the new password_version so the current device
    // stays logged in while other existing sessions are rotated out by the pv
    // gate — preserving the login's remember choice instead of downgrading a
    // remembered session to the default duration (#1927).
    const token = this.generateToken({ id: userId, password_version: newPv }, remember);
    return { success: true, token };
  }

  deleteAccount(userId: number, userEmail: string, userRole: string): { error?: string; status?: number; success?: boolean } {
    if (readEnv().demo.enabled && isDemoEmail(userEmail)) {
      return { error: 'Account deletion is disabled in demo mode.', status: 403 };
    }
    if (userRole === 'admin') {
      const adminCount = this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")!.count;
      if (adminCount <= 1) {
        return { error: 'Cannot delete the last admin account', status: 400 };
      }
    }
    this.userCleanup.deleteUserCompletely(userId);
    emitUserDeleted(userId); // let plugins erase their own per-user data
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Admin settings
  //
  // These stay here, against the first instinct to file them under settings/
  // with the other app_settings readers. updateAppSettings runs the lockout
  // guard that stops an admin disabling every login method at once, and that
  // guard is resolveAuthToggles — auth's own view of which methods exist.
  // Moving the pair would put an AuthModule import inside SettingsModule, a
  // leaf that half the container pulls in, to buy nothing but a tidier
  // directory. The role check below is likewise left as written: swapping it
  // for AdminGuard changes the response body, so it belongs with the guard
  // work, not with a move.
  // -------------------------------------------------------------------------

  getAppSettings(userId: number): { error?: string; status?: number; data?: Record<string, string> } {
    const user = this.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
    if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

    const result: Record<string, string> = {};
    for (const key of ADMIN_SETTINGS_KEYS) {
      const row = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
      if (row) result[key] = (key === 'smtp_pass' || key === 'admin_webhook_url' || key === 'admin_ntfy_token') ? '••••••••' : row.value;
    }
    return { data: result };
  }

  updateAppSettings(
    userId: number,
    rawBody: unknown
  ): {
    error?: string;
    status?: number;
    success?: boolean;
    auditSummary?: Record<string, unknown>;
    auditDebugDetails?: Record<string, unknown>;
    /** Names the operator holds, skipped rather than written. Empty when self-hosted. */
    managedKeys?: string[];
  } {
    const body = rawBody as Record<string, unknown>;
    const user = this.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
    if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

    const { require_mfa } = body;
    if (require_mfa === true || require_mfa === 'true') {
      const adminMfa = this.db.get<{ mfa_enabled: number }>('SELECT mfa_enabled FROM users WHERE id = ?', userId);
      // A user-verified passkey satisfies the MFA policy, so an admin who secured
      // their own account with a passkey may enable it too (not only TOTP).
      const adminHasPasskey = !!this.db.get('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1', userId);
      if (!(adminMfa?.mfa_enabled === 1) && !adminHasPasskey) {
        return {
          error: 'Secure your own account with two-factor authentication or a passkey before requiring it for all users.',
          status: 400,
        };
      }
    }

    // Lockout prevention: can't disable all login methods
    if (body.password_login !== undefined || body.oidc_login !== undefined) {
      const current = this.resolveAuthToggles();
      const oidcConfigured = !!(
        (readEnv().oidc.issuer || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'oidc_issuer'")?.value) &&
        (readEnv().oidc.clientId || this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'oidc_client_id'")?.value)
      );
      const nextPasswordLogin = body.password_login !== undefined ? (String(body.password_login) === 'true') : current.password_login;
      const nextOidcLogin = body.oidc_login !== undefined ? (String(body.oidc_login) === 'true') : current.oidc_login;
      if (!nextPasswordLogin && (!nextOidcLogin || !oidcConfigured)) {
        return { error: 'Cannot disable all login methods. At least one must remain enabled.', status: 400 };
      }
    }

    // SMTP, the OIDC toggles and the WebAuthn pair share this handler with keys
    // the admin does own, so a managed install skips those names and keeps the
    // rest of the save working. Reported, never thrown: the settings tab sends
    // the whole form in one request.
    const { blocked } = splitManagedKeys(body as Record<string, unknown>, readEnv().managed.enabled);

    for (const key of ADMIN_SETTINGS_KEYS) {
      if (blocked.includes(key)) continue;
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
        this.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", key, val);
      }
    }

    const changedKeys = ADMIN_SETTINGS_KEYS.filter(k => !blocked.includes(k) && body[k] !== undefined && !(k === 'smtp_pass' && String(body[k]) === '••••••••'));

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

    // The reminder crons read their enable gates and channels per tick, so a
    // notification-settings change takes effect at the next run — no restart.
    return { success: true, auditSummary: summary, auditDebugDetails: debugDetails, managedKeys: blocked };
  }

  // -------------------------------------------------------------------------
  // MFA
  // -------------------------------------------------------------------------

  setupMfa(userId: number, userEmail: string): { error?: string; status?: number; secret?: string; otpauth_url?: string; qrPromise?: Promise<string> } {
    if (readEnv().demo.enabled && isDemoEmail(userEmail)) {
      return { error: 'MFA is not available in demo mode.', status: 403 };
    }
    const row = this.db.get<{ mfa_enabled: number }>('SELECT mfa_enabled FROM users WHERE id = ?', userId);
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

  enableMfa(userId: number, rawCode: unknown): { error?: string; status?: number; success?: boolean; mfa_enabled?: boolean; backup_codes?: string[] } {
    const code = rawCode as string | undefined;
    if (!code) {
      return { error: 'Verification code is required', status: 400 };
    }
    const pending = this.getPendingMfaSecret(userId);
    if (!pending) {
      return { error: 'No MFA setup in progress. Start the setup again.', status: 400 };
    }
    const tokenStr = String(code).replace(/\s/g, '');
    const ok = authenticator.verify({ token: tokenStr, secret: pending });
    if (!ok) {
      return { error: 'Invalid verification code', status: 401 };
    }
    const backupCodes = generateBackupCodes();
    const backupHashes = backupCodes.map(hashBackupCodeBcrypt);
    const enc = encryptMfaSecret(pending);
    this.db.run('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      enc,
      JSON.stringify(backupHashes),
      userId
    );
    mfaSetupPending.delete(userId);
    return { success: true, mfa_enabled: true, backup_codes: backupCodes };
  }

  disableMfa(
    userId: number,
    userEmail: string,
    rawBody: unknown
  ): { error?: string; status?: number; success?: boolean; mfa_enabled?: boolean } {
    const body = rawBody as { password?: string; code?: string };
    if (readEnv().demo.enabled && isDemoEmail(userEmail)) {
      return { error: 'MFA cannot be changed in demo mode.', status: 403 };
    }
    const policy = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'require_mfa'");
    if (policy?.value === 'true') {
      return { error: 'Two-factor authentication cannot be disabled while it is required for all users.', status: 403 };
    }
    const { password, code } = body;
    if (!password || !code) {
      return { error: 'Password and authenticator code are required', status: 400 };
    }
    const user = this.db.get<User>('SELECT * FROM users WHERE id = ?', userId);
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
    this.db.run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      userId
    );
    mfaSetupPending.delete(userId);
    return { success: true, mfa_enabled: false };
  }

  verifyMfaLogin(rawBody: unknown): {
    error?: string;
    status?: number;
    token?: string;
    user?: Record<string, unknown>;
    remember?: boolean;
    auditUserId?: number;
  } {
    const body = rawBody as { mfa_token?: string; code?: string; remember_me?: boolean };
    const { mfa_token, code, remember_me } = body;
    const remember = remember_me === true;
    if (!mfa_token || !code) {
      return { error: 'Verification token and code are required', status: 400 };
    }
    try {
      const decoded = jwt.verify(mfa_token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; purpose?: string };
      if (decoded.purpose !== 'mfa_login') {
        return { error: 'Invalid verification token', status: 401 };
      }
      const user = this.db.get<User>('SELECT * FROM users WHERE id = ?', decoded.id);
      if (!user || !(user.mfa_enabled === 1 || user.mfa_enabled === true) || !user.mfa_secret) {
        return { error: 'Invalid session', status: 401 };
      }
      const secret = decryptMfaSecret(user.mfa_secret);
      const tokenStr = String(code).trim();
      const okTotp = authenticator.verify({ token: tokenStr.replace(/\s/g, ''), secret });
      if (!okTotp) {
        const hashes = parseBackupCodeHashes(user.mfa_backup_codes);
        // matchBackupCode handles both bcrypt and legacy SHA-256 hashes;
        // any store older than the bcrypt migration keeps working.
        const idx = hashes.findIndex((h) => matchBackupCode(tokenStr, h));
        if (idx === -1) {
          return { error: 'Invalid verification code', status: 401 };
        }
        hashes.splice(idx, 1);
        // Consume the backup code and record the login atomically — the code
        // must not burn without the login landing (or vice versa).
        this.db.transaction(() => {
          this.db.run('UPDATE users SET mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            JSON.stringify(hashes),
            user.id
          );
          this.db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?', user.id);
        });
      } else {
        this.db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?', user.id);
      }
      const sessionToken = this.generateToken(user, remember);
      const userSafe = stripUserForClient(user) as Record<string, unknown>;
      return {
        token: sessionToken,
        user: { ...userSafe, avatar_url: avatarUrl(user) },
        remember,
        auditUserId: Number(user.id),
      };
    } catch {
      return { error: 'Invalid or expired verification token', status: 401 };
    }
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  requestPasswordReset(rawEmail: string, createdIp: string | null): PasswordResetRequestOutcome {
    const email = String(rawEmail || '').trim().toLowerCase();
    // Basic shape check — a fully empty / malformed email is treated like
    // "no user" so we still spend the same time internally. Same "x@y.z somewhere
    // on one line" test as the old /.+@.+\..+/, but anchored per line and pinned to
    // the first usable '@' and '.', so a body full of '@' can no longer stall it.
    const looksLikeEmail = email.length > 0 && /^.[^@\r\n\u2028\u2029]*@.[^.\r\n\u2028\u2029]*\../m.test(email);

    // Global policy check: password login disabled → no reset possible.
    const toggles = this.resolveAuthToggles();
    if (!toggles.password_login) {
      return { tokenForDelivery: null, userId: null, userEmail: null, reason: 'password_login_disabled' };
    }

    // Per-email throttle. We check this BEFORE the DB lookup so the timing
    // is identical regardless of whether the account exists.
    const throttleKey = email || '__noemail__';
    const now = Date.now();
    const record = perEmailResetAttempts.get(throttleKey);
    if (record && record.count >= PASSWORD_RESET_PER_EMAIL_MAX && now - record.first < PASSWORD_RESET_PER_EMAIL_WINDOW_MS) {
      return { tokenForDelivery: null, userId: null, userEmail: null, reason: 'throttled_per_email' };
    }
    if (!record || now - record.first >= PASSWORD_RESET_PER_EMAIL_WINDOW_MS) {
      perEmailResetAttempts.set(throttleKey, { count: 1, first: now });
    } else {
      record.count++;
    }

    if (!looksLikeEmail) {
      return { tokenForDelivery: null, userId: null, userEmail: null, reason: 'no_user' };
    }

    // A guest (#1362) must never receive a reset link — treat its synthetic email as unknown.
    const user = this.db.get<{ id: number; email: string; password_hash: string | null; oidc_sub: string | null }>(
      'SELECT id, email, password_hash, oidc_sub FROM users WHERE email = ? AND COALESCE(is_guest, 0) = 0',
      email
    );

    if (!user) {
      return { tokenForDelivery: null, userId: null, userEmail: null, reason: 'no_user' };
    }
    // SSO-linked account — refuse a reset. OIDC users are created with a random
    // bcrypt hash (so password_hash is never empty), which is why we must key off
    // oidc_sub rather than a missing hash. Letting the reset proceed would set a
    // local password and revoke session/credential state, which breaks the SSO
    // login; admins (or the user, with their current password) can still set one.
    // The client still gets the generic "if that email exists…" response.
    if (user.oidc_sub) {
      return { tokenForDelivery: null, userId: user.id, userEmail: user.email, reason: 'oidc_only' };
    }

    // Invalidate any prior unconsumed tokens for this user so there is
    // always at most one live reset link in flight.
    this.db.run(
      "UPDATE password_reset_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND consumed_at IS NULL",
      user.id
    );

    const raw = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
    const token_hash = hashResetToken(raw);
    const expires_at = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

    this.db.run(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_ip) VALUES (?, ?, ?, ?)',
      user.id, token_hash, expires_at, createdIp
    );

    return { tokenForDelivery: raw, userId: user.id, userEmail: user.email, reason: 'issued' };
  }

  /**
   * Consume a reset token and set a new password. If the target user has
   * MFA enabled, a valid TOTP code or backup code must be supplied — a
   * compromised email alone therefore does NOT allow taking over a
   * 2FA-protected account.
   */
  resetPassword(rawBody: unknown): ResetPasswordOutcome {
    const body = rawBody as { token?: string; new_password?: string; mfa_code?: string };
    const { token, new_password, mfa_code } = body;
    if (!token || typeof token !== 'string') {
      return { error: 'Reset token is required', status: 400 };
    }
    if (!new_password || typeof new_password !== 'string') {
      return { error: 'New password is required', status: 400 };
    }
    // Check the policy BEFORE touching the token so an invalid password
    // does not burn the user's one-time link.
    const pwCheck = validatePassword(new_password);
    if (!pwCheck.ok) return { error: pwCheck.reason!, status: 400 };

    const tokenHash = hashResetToken(token);
    const row = this.db.get<{ id: number; user_id: number; expires_at: string; consumed_at: string | null }>(
      'SELECT id, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ?',
      tokenHash
    );

    if (!row) return { error: 'Invalid or expired reset link', status: 400 };
    if (row.consumed_at) return { error: 'This reset link has already been used', status: 400 };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { error: 'Reset link has expired. Please request a new one.', status: 400 };
    }

    const user = this.db.get<{ id: number; email: string; mfa_enabled: number | boolean; mfa_secret: string | null; mfa_backup_codes: string | null; password_version: number }>(
      'SELECT id, email, mfa_enabled, mfa_secret, mfa_backup_codes, password_version FROM users WHERE id = ?',
      row.user_id
    );

    if (!user) return { error: 'Invalid or expired reset link', status: 400 };

    // MFA gate. If enabled, require a valid TOTP or backup code.
    const mfaOn = user.mfa_enabled === 1 || user.mfa_enabled === true;
    let backupCodeConsumedIndex: number | null = null;
    if (mfaOn) {
      if (!user.mfa_secret) {
        // Data inconsistency — fail closed.
        return { error: 'MFA is enabled but not configured. Contact your administrator.', status: 500 };
      }
      const supplied = typeof mfa_code === 'string' ? mfa_code.trim() : '';
      if (!supplied) return { mfa_required: true, status: 200 };

      const secret = decryptMfaSecret(user.mfa_secret);
      const okTotp = authenticator.verify({ token: supplied.replace(/\s/g, ''), secret });
      if (!okTotp) {
        const hashes = parseBackupCodeHashes(user.mfa_backup_codes);
        const idx = hashes.findIndex((h) => matchBackupCode(supplied, h));
        if (idx === -1) return { error: 'Invalid MFA code', status: 401 };
        backupCodeConsumedIndex = idx;
      }
    }

    const newHash = bcrypt.hashSync(new_password, BCRYPT_COST);
    const newPv = (user.password_version ?? 0) + 1;

    this.db.transaction(() => {
      // Burn the token first to keep it atomic with the password change.
      this.db.run('UPDATE password_reset_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);
      // Also burn every OTHER live token for this user — a fresh login
      // should not leave a second door open.
      this.db.run(
        "UPDATE password_reset_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND consumed_at IS NULL AND id != ?",
        user.id, row.id
      );
      this.db.run(
        'UPDATE users SET password_hash = ?, must_change_password = 0, password_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        newHash, newPv, user.id
      );
      // Consume backup code if one was used.
      if (backupCodeConsumedIndex !== null) {
        const hashes = parseBackupCodeHashes(user.mfa_backup_codes);
        hashes.splice(backupCodeConsumedIndex, 1);
        this.db.run('UPDATE users SET mfa_backup_codes = ? WHERE id = ?', JSON.stringify(hashes), user.id);
      }
      // Revoke every other credential class the user had. The
      // password_version bump alone invalidates JWT cookie sessions, but
      // MCP static tokens and OAuth 2.1 bearer tokens are separate stores
      // that survive the bump unless we prune them here.
      this.db.run('DELETE FROM mcp_tokens WHERE user_id = ?', user.id);
      try {
        this.db.run(
          "UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL",
          user.id
        );
      } catch { /* oauth_tokens table may not exist in very old installs */ }
    });

    // Kick off any MCP/WS session cleanup — same hook the account-delete path uses.
    try { revokeUserSessions?.(user.id); } catch { /* best-effort */ }

    return { success: true, userId: user.id };
  }

  // -------------------------------------------------------------------------
  // Demo gate + JWT verification
  //
  // The MCP token half of this section moved to tokens/token.service.ts. What
  // stays is login identity (verifyJwtToken) and the demo check, neither of
  // which is about minting a token.
  // -------------------------------------------------------------------------

  isDemoUser(userId: number): boolean {
    if (!readEnv().demo.enabled) return false;
    const user = this.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId);
    return isDemoEmail(user?.email);
  }

  /**
   * Verify a JWT the same way `auth/jwt-verify.ts#verifyJwtAndLoadUser`
   * does — including the `password_version` check — so that stolen tokens
   * lose access the moment the victim resets their password.
   *
   * This is the single entry point every non-cookie JWT verification path
   * (MCP bearer, WebSocket handshake, file-download query tokens, photo
   * route) should go through.
   */
  verifyJwtToken(token: string): User | null {
    return verifyJwtAndLoadUser(token);
  }
}
