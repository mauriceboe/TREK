import { Injectable } from '@nestjs/common';
import { readEnv, getAppUrl } from '../../app-config';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { decrypt_api_key, maybe_encrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { avatarUrl } from '../common/avatarUrl';
import { EMAIL_REGEX, mask_stored_api_key } from './auth.helpers';
import { splitManagedKeys, MANAGED_LOCKED_PROFILE_KEYS } from '../common/managed';
import {
  INSTANCE_API_KEY_NAMES,
  readInstanceApiKey,
  resolveApiKey,
  writeInstanceApiKey,
  type InstanceApiKeyName,
} from '../settings/instance-api-keys';
import { SEARCH_TEXT_FIELD_MASK } from '../maps/maps.helpers';
import { User } from '../../types';

/**
 * The account a user administers about themselves: display settings, avatar,
 * the third-party API keys they paste in, and the directory listing other
 * members are picked from.
 *
 * Split out of AuthService, which had grown to 1471 lines by owning identity,
 * profile, settings and tokens together. None of this is identity: no password
 * is checked here, no session is issued, no MFA secret is touched. Everything
 * moved verbatim — same SQL, same validation order, same masking, same error
 * strings and status codes.
 *
 * DatabaseService is the only injected dependency, which is what made this the
 * second-cheapest cut after tokens.
 */
@Injectable()
export class UserProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /**
   * On a centrally administered install the three key columns belong to the
   * operator, and there are four ways to reach them: this method, updateApiKeys,
   * updateSettings and the read in getSettings. Sealing one route would leave
   * the other three open, so all four ask here.
   *
   * Read live rather than injected: the unit tests construct this service by
   * hand with a single argument, and tests/ sits outside the tsconfig, so a new
   * constructor parameter would only surface at runtime.
   */
  private get managed(): boolean {
    return readEnv().managed.enabled;
  }

  /** The three key columns plus the role that decides where a save lands. */
  private currentKeys(userId: number) {
    return this.db.get<Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key'>>(
      'SELECT role, maps_api_key, openweather_api_key, unsplash_api_key, amap_api_key FROM users WHERE id = ?',
      userId
    );
  }

  /**
   * The value a save is measured against, in cleartext.
   *
   * For an admin and one of the two instance-wide names that is the instance
   * value, because that is what the panel shows them and what the search uses;
   * their own column only speaks when no instance value has been set yet.
   */
  private storedKeyPlaintext(
    name: 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key',
    current: Pick<User, 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key'> | undefined,
    isAdmin: boolean,
  ): string {
    if (isAdmin && (INSTANCE_API_KEY_NAMES as readonly string[]).includes(name)) {
      const instance = readInstanceApiKey(this.db, name as InstanceApiKeyName);
      if (instance !== null) return instance;
    }
    return decrypt_api_key(current?.[name]) ?? '';
  }

  /**
   * Which key names this body actually changes.
   *
   * Compared on cleartext, never on what is stored: the IV is random, so the
   * same key encrypted twice differs every time and a ciphertext comparison
   * would report a change on every save. The panel saves before each test click,
   * so that difference is the one between an audit trail and a full log.
   *
   * `skipped` are the names a managed install refuses to write — auditing them
   * would claim a change that never happened.
   */
  private changedKeyNames(
    body: Record<string, unknown>,
    current: Pick<User, 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key'> | undefined,
    isAdmin: boolean,
    skipped: string[] = [],
  ): string[] {
    const norm = (v: unknown) => String(v ?? '').trim();
    return (['maps_api_key', 'openweather_api_key', 'unsplash_api_key', 'amap_api_key'] as const).filter(
      (name) => body[name] !== undefined && !skipped.includes(name) && norm(body[name]) !== norm(this.storedKeyPlaintext(name, current, isAdmin))
    );
  }

  /**
   * Mirror the two instance-wide names into app_settings when an admin saves.
   *
   * Only an admin: `PUT /me/api-keys` is not admin-gated (the class carries
   * JwtAuthGuard alone), so letting any caller write here would hand every
   * member the instance credential. A non-admin keeps writing their own column,
   * which is still the last step of the resolver.
   */
  private mirrorInstanceKeys(body: Record<string, unknown>, isAdmin: boolean): void {
    if (!isAdmin) return;
    for (const name of INSTANCE_API_KEY_NAMES) {
      if (body[name] !== undefined) writeInstanceApiKey(this.db, name, body[name]);
    }
  }

  updateMapsKey(userId: number, key: unknown) {
    const maps_api_key = key as string | null | undefined;
    if (this.managed) {
      return { success: true, maps_api_key: null, managed_keys: ['maps_api_key'], changedKeys: [] };
    }
    const current = this.currentKeys(userId);
    const isAdmin = current?.role === 'admin';
    const changedKeys = this.changedKeyNames({ maps_api_key }, current, isAdmin);
    this.db.transaction(() => {
      this.db.run(
        'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        maybe_encrypt_api_key(maps_api_key), userId
      );
      this.mirrorInstanceKeys({ maps_api_key }, isAdmin);
    });
    return { success: true, maps_api_key: mask_stored_api_key(maps_api_key), changedKeys };
  }

  updateApiKeys(userId: number, rawBody: unknown) {
    const body = rawBody as { maps_api_key?: string; openweather_api_key?: string; unsplash_api_key?: string; amap_api_key?: string };
    const { blocked } = splitManagedKeys(body, this.managed);
    for (const key of blocked) delete body[key as keyof typeof body];
    const current = this.currentKeys(userId);
    const isAdmin = current?.role === 'admin';
    const changedKeys = this.changedKeyNames(body, current, isAdmin, blocked);

    this.db.transaction(() => {
      // `?? null` instead of the former non-null assertions: a user row deleted
      // mid-request must degrade to a 0-row UPDATE, not a TypeError/500.
      this.db.run(
        'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, unsplash_api_key = ?, amap_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        body.maps_api_key !== undefined ? maybe_encrypt_api_key(body.maps_api_key) : current?.maps_api_key ?? null,
        body.openweather_api_key !== undefined ? maybe_encrypt_api_key(body.openweather_api_key) : current?.openweather_api_key ?? null,
        body.unsplash_api_key !== undefined ? maybe_encrypt_api_key(body.unsplash_api_key) : current?.unsplash_api_key ?? null,
        body.amap_api_key !== undefined ? maybe_encrypt_api_key(body.amap_api_key) : current?.amap_api_key ?? null,
        userId
      );
      this.mirrorInstanceKeys(body, isAdmin);
    });

    const updated = this.db.get<Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key' | 'avatar' | 'mfa_enabled'>>(
      'SELECT id, username, email, role, maps_api_key, openweather_api_key, unsplash_api_key, amap_api_key, avatar, mfa_enabled FROM users WHERE id = ?',
      userId
    );

    const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
    return {
      success: true,
      ...(blocked.length ? { managed_keys: blocked } : {}),
      user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), unsplash_api_key: mask_stored_api_key(u?.unsplash_api_key), amap_api_key: mask_stored_api_key(u?.amap_api_key), avatar_url: avatarUrl(updated || {}) },
      changedKeys,
    };
  }

  updateSettings(
    userId: number,
    rawBody: unknown
  ): { error?: string; status?: number; success?: boolean; user?: Record<string, unknown>; changedKeys?: string[] } {
    const body = rawBody as { maps_api_key?: string; openweather_api_key?: string; unsplash_api_key?: string; amap_api_key?: string; username?: string; email?: string };
    const { maps_api_key, openweather_api_key, unsplash_api_key, amap_api_key, username, email } = body;

    if (username !== undefined) {
      const trimmed = username.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
        return { error: 'Username must be between 2 and 50 characters', status: 400 };
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
        return { error: 'Username can only contain letters, numbers, underscores, dots and hyphens', status: 400 };
      }
      const conflict = this.db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ? AND COALESCE(is_guest, 0) = 0', trimmed, userId);
      if (conflict) return { error: 'Username already taken', status: 409 };
    }

    if (email !== undefined) {
      const trimmed = email.trim();
      if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
        return { error: 'Invalid email format', status: 400 };
      }
      const conflict = this.db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ? AND COALESCE(is_guest, 0) = 0', trimmed, userId);
      if (conflict) return { error: 'Email already taken', status: 409 };
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    // The name and email half of this body stays the user's own in every mode;
    // only the three key columns answer to the operator.
    const { blocked } = splitManagedKeys(body, this.managed);
    const keyLocked = blocked.length > 0;

    if (maps_api_key !== undefined && !keyLocked) { updates.push('maps_api_key = ?'); params.push(maybe_encrypt_api_key(maps_api_key)); }
    if (openweather_api_key !== undefined && !keyLocked) { updates.push('openweather_api_key = ?'); params.push(maybe_encrypt_api_key(openweather_api_key)); }
    if (unsplash_api_key !== undefined && !keyLocked) { updates.push('unsplash_api_key = ?'); params.push(maybe_encrypt_api_key(unsplash_api_key)); }
    if (amap_api_key !== undefined && !keyLocked) { updates.push('amap_api_key = ?'); params.push(maybe_encrypt_api_key(amap_api_key)); }
    if (username !== undefined) { updates.push('username = ?'); params.push(username.trim()); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email.trim()); }

    // Read before the write, so the comparison sees the old value; the role in
    // the same row decides whether the two instance-wide names travel with it.
    const current = this.currentKeys(userId);
    const isAdmin = current?.role === 'admin';
    const changedKeys = keyLocked ? [] : this.changedKeyNames(body, current, isAdmin, blocked);

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(userId);
      this.db.transaction(() => {
        this.db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params);
        if (!keyLocked) this.mirrorInstanceKeys(body, isAdmin);
      });
    }

    const updated = this.db.get<Pick<User, 'id' | 'username' | 'email' | 'role' | 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key' | 'avatar' | 'mfa_enabled'>>(
      'SELECT id, username, email, role, maps_api_key, openweather_api_key, unsplash_api_key, amap_api_key, avatar, mfa_enabled FROM users WHERE id = ?',
      userId
    );

    const u = updated ? { ...updated, mfa_enabled: !!(updated.mfa_enabled === 1 || updated.mfa_enabled === true) } : undefined;
    return {
      success: true,
      ...(blocked.length ? { managed_keys: blocked } : {}),
      user: { ...u, maps_api_key: mask_stored_api_key(u?.maps_api_key), openweather_api_key: mask_stored_api_key(u?.openweather_api_key), unsplash_api_key: mask_stored_api_key(u?.unsplash_api_key), amap_api_key: mask_stored_api_key(u?.amap_api_key), avatar_url: avatarUrl(updated || {}) },
      changedKeys,
    };
  }

  getSettings(userId: number): { error?: string; status?: number; settings?: Record<string, unknown> } {
    const user = this.db.get<Pick<User, 'role' | 'maps_api_key' | 'openweather_api_key' | 'unsplash_api_key' | 'amap_api_key'>>(
      'SELECT role, maps_api_key, openweather_api_key, unsplash_api_key, amap_api_key FROM users WHERE id = ?',
      userId
    );
    if (user?.role !== 'admin') return { error: 'Admin access required', status: 403 };

    // The one endpoint in the codebase that hands back a stored key in the
    // clear. That is fine when the admin pasted it in themselves and wrong when
    // the operator supplied it, so a managed install answers with the shape and
    // not the values. Keys kept, values null, because the client reads them as
    // `settings?.maps_api_key || ''`.
    if (this.managed) {
      return {
        settings: {
          maps_api_key: null,
          openweather_api_key: null,
          unsplash_api_key: null,
          amap_api_key: null,
          managed_keys: [...MANAGED_LOCKED_PROFILE_KEYS],
        },
      };
    }

    // Maps and Unsplash are read where the search reads them: instance-wide
    // first. Showing the admin their own column while every request used another
    // value is the confusion #1939 reported. Their column still answers while no
    // instance value exists — on that install it is what the resolver picks too.
    return {
      settings: {
        maps_api_key: readInstanceApiKey(this.db, 'maps_api_key') ?? decrypt_api_key(user.maps_api_key),
        openweather_api_key: decrypt_api_key(user.openweather_api_key),
        unsplash_api_key: readInstanceApiKey(this.db, 'unsplash_api_key') ?? decrypt_api_key(user.unsplash_api_key),
        amap_api_key: readInstanceApiKey(this.db, 'amap_api_key') ?? decrypt_api_key(user.amap_api_key),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Avatar
  // -------------------------------------------------------------------------

  async saveAvatar(userId: number, filename: string) {
    const current = this.db.get<{ avatar: string | null }>('SELECT avatar FROM users WHERE id = ?', userId);
    // Only a locally uploaded file has something to clean up. An OIDC picture URL
    // (#1399) has no storage object, so skip the delete entirely.
    if (current?.avatar && !/^https:\/\//i.test(current.avatar)) {
      // Fire-and-forget parity: leftover objects are harmless; the DB update is
      // the source of truth for which avatar is current. The catch also
      // swallows a hostile stored value the central key validation rejects.
      await this.storage.delete('avatars', current.avatar).catch(() => {});
    }

    this.db.run('UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', filename, userId);

    const updated = this.db.get<Pick<User, 'id' | 'username' | 'email' | 'role' | 'avatar'>>('SELECT id, username, email, role, avatar FROM users WHERE id = ?', userId);
    return { success: true, avatar_url: avatarUrl(updated || {}) };
  }

  async deleteAvatar(userId: number) {
    const current = this.db.get<{ avatar: string | null }>('SELECT avatar FROM users WHERE id = ?', userId);
    // An OIDC picture URL (#1399) has no storage object — only delete an uploaded one.
    if (current?.avatar && !/^https:\/\//i.test(current.avatar)) {
      await this.storage.delete('avatars', current.avatar).catch(() => {});
    }
    this.db.run('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', userId);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // User directory
  // -------------------------------------------------------------------------

  listUsers(excludeUserId: number) {
    // The global user directory feeds the trip member-add / contributor pickers —
    // guests (#1362) are trip-scoped and must never be selectable here.
    const users = this.db.all<Pick<User, 'id' | 'username' | 'avatar'>>(
      'SELECT id, username, avatar FROM users WHERE id != ? AND COALESCE(is_guest, 0) = 0 ORDER BY username ASC',
      excludeUserId
    );
    return users.map(u => ({ ...u, avatar_url: avatarUrl(u) }));
  }

  // -------------------------------------------------------------------------
  // Key validation
  // -------------------------------------------------------------------------

  async validateKeys(userId: number): Promise<{ error?: string; status?: number; maps: boolean; weather: boolean; maps_details: null | { ok: boolean; status: number | null; status_text: string | null; error_message: string | null; error_status: string | null; error_raw: string | null } }> {
    const user = this.db.get<Pick<User, 'role' | 'openweather_api_key'>>('SELECT role, openweather_api_key FROM users WHERE id = ?', userId);
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

    // The key a search would actually use, not the one in this admin's column:
    // testing a value nothing resolves to is how "the panel says the key is
    // fine" and "every search 403s" coexisted (#1939).
    const { key: maps_api_key } = resolveApiKey(this.db, 'maps_api_key', userId, readEnv().maps.placesApiKey);
    if (maps_api_key) {
      try {
        // Same Referer as maps.service googleFetch — without it, keys with an
        // HTTP-referrer restriction fail validation while real requests succeed.
        const referer = readEnv().app.appUrl ? getAppUrl() : undefined;
        const mapsRes = await fetch(
          `https://places.googleapis.com/v1/places:searchText`,
          {
            method: 'POST',
            headers: {
              ...(referer ? { Referer: referer } : {}),
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': maps_api_key,
              // The mask the real search sends. A narrower probe passes on keys
              // that are restricted to fewer Places SKUs than TREK asks for.
              'X-Goog-FieldMask': SEARCH_TEXT_FIELD_MASK,
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
}
