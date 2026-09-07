import { SetMetadata } from '@nestjs/common';
import { RuntimeEnvService } from '../app-config/runtime-env.service';
import { byCodeUnit } from './compare';

/** Metadata key `@ManagedForbidden()` writes. */
export const MANAGED_FORBIDDEN = 'trek:managed-forbidden';

/**
 * The one 403 body a managed instance returns, shared by REST and MCP.
 *
 * Deliberately a single constant rather than a per-route message. DEMO_MODE grew
 * two texts for the same condition — 'Uploads are disabled in demo mode. Self-host
 * TREK for full functionality.' on REST and 'Write operations are disabled in demo
 * mode.' on MCP — and now neither can be changed without hunting for the other.
 *
 * It says who owns the setting and stops there. A caller learns that the value is
 * not theirs to change, which is all they can act on; the reason belongs to
 * whoever runs the install, not in an API response.
 */
export const MANAGED_FORBIDDEN_ERROR = {
  error: 'This is configured by the operator of this instance.',
  code: 'MANAGED_FORBIDDEN',
} as const;

/**
 * Marks a route as unavailable while the instance is centrally administered.
 *
 * The reason is mandatory and is for the next reader of the source, not for the
 * client: it records why this particular surface cannot be left to the instance
 * admin. Without it the marks turn into a list nobody can audit, which is how
 * the path lists this codebase has already replaced once went stale.
 *
 * `enforcedInHandler` is for multipart routes. A guard throws before the parser
 * has drained the body and the client gets an ECONNRESET instead of the 403
 * (PROFILE-015), so those handlers call `isManagedBlocked` themselves. They
 * still carry the marker, because the boot gate inventories markers and a route
 * missing from that inventory is exactly what nobody notices.
 */
export const ManagedForbidden = (reason: string, opts?: { enforcedInHandler?: true }) =>
  SetMetadata(MANAGED_FORBIDDEN, { reason, enforcedInHandler: opts?.enforcedInHandler === true });

/**
 * The handler-side flavour of the guard below.
 *
 * Needed because a guard throws before the multipart parser has drained the
 * request body, which leaves the client with an ECONNRESET instead of the 403
 * (PROFILE-015, and the reason `isDemoWriteBlocked` is a function too). Upload
 * routes call this after the interceptor instead of carrying the decorator.
 */
export function isManagedBlocked(env: RuntimeEnvService): boolean {
  return env.isManaged();
}

/**
 * The settings a centrally administered install does not hand to its admin,
 * because the value belongs to whoever operates it.
 *
 * One list rather than a condition repeated at each write path. Several of
 * these are reachable through more than one route — the SMTP block and the
 * WebAuthn pair share a handler with keys the admin does own, and the llm_*
 * family is writable through per-user settings, the instance defaults and the
 * addon config alike — so a route-level refusal would be both too coarse and
 * incomplete.
 *
 * The three users-table columns are in here too. They are not settings keys,
 * but the filter matches on name and they are the same kind of value, so
 * splitting them into a second mechanism would only mean two things to forget.
 *
 * mapbox_access_token is in here for the same reason as the rest, though it is
 * the one that reaches the browser: a managed instance ships with the operator's
 * public pk.* token, injected when the settings are read, and a per-user value
 * saved over it would only break the map for that user.
 *
 * carto_api_key is the same shape, injected on read and public in the browser,
 * and it is the operator's for one more reason: the key is registered to
 * whoever runs the instance, and CARTO's terms hold that account answerable for
 * the tiles it fetches.
 */
export const MANAGED_LOCKED_SETTING_KEYS = [
  // The operator's for the same reason maps_api_key is: Amap bills the account
  // the key belongs to, and on a managed install that account is theirs.
  'amap_api_key',
  'carto_api_key',
  'llm_api_key',
  'llm_base_url',
  'llm_model',
  'llm_multimodal',
  'llm_provider',
  'mapbox_access_token',
  'maps_api_key',
  'oidc_login',
  'oidc_registration',
  'openweather_api_key',
  'smtp_from',
  'smtp_host',
  'smtp_pass',
  'smtp_port',
  'smtp_skip_tls_verify',
  'smtp_user',
  'unsplash_api_key',
  'webauthn_origins',
  'webauthn_rp_id',
] as const;

/**
 * The locked names that are columns on `users` rather than settings keys, so
 * the assignment test can tell "deliberately outside both source lists" from
 * "somebody removed a key and left the assignment behind".
 */
export const MANAGED_LOCKED_PROFILE_KEYS = [
  'maps_api_key',
  'openweather_api_key',
  'unsplash_api_key',
  'amap_api_key',
] as const;

/**
 * The settings that stay with the instance admin in every mode.
 *
 * Listed explicitly rather than derived as "everything not locked", so that a
 * key added to either source list belongs to neither set until somebody
 * decides. That is what MANAGED-KEYS-001 checks, and it is the only mechanism
 * here that still works a year from now.
 */
export const MANAGED_CUSTOMER_KEYS = [
  'admin_ntfy_server',
  'admin_ntfy_token',
  'admin_ntfy_topic',
  'admin_webhook_url',
  'allow_registration',
  'allowed_file_types',
  'blur_booking_codes',
  'dark_mode',
  'default_currency',
  'distance_unit',
  'map_provider',
  'map_tile_url',
  'mapbox_3d_enabled',
  'mapbox_quality_mode',
  'mapbox_style',
  'maplibre_style',
  'notification_channels',
  'notify_trip_reminder',
  'passkey_login',
  'password_login',
  'password_registration',
  // WHICH provider answers place search stays the admin's call even when the
  // operator owns both credentials: it decides what their users see, not what
  // the operator is billed for — the keys above cover that.
  'places_provider',
  'require_mfa',
  'temperature_unit',
  'time_format',
] as const;

const LOCKED = new Set<string>(MANAGED_LOCKED_SETTING_KEYS);

/** Whether this single key is the operator's to set. */
export function isManagedLockedKey(key: string): boolean {
  return LOCKED.has(key);
}

/**
 * Splits a write body into what the caller may set and what the operator owns.
 *
 * Reports the blocked names instead of throwing, and that is the whole point:
 * the admin settings tab saves SMTP and the registration toggles in one
 * request, so refusing the request would take the toggles away with the SMTP
 * block. The caller keeps working, the locked values keep their stored value,
 * and the response says which names were skipped.
 */
export function splitManagedKeys<T extends Record<string, unknown>>(
  body: T,
  managed: boolean,
): { allowed: Partial<T>; blocked: string[] } {
  if (!managed) return { allowed: body, blocked: [] };

  const allowed: Partial<T> = {};
  const blocked: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (LOCKED.has(key)) blocked.push(key);
    else (allowed as Record<string, unknown>)[key] = value;
  }
  return { allowed, blocked: blocked.sort(byCodeUnit) };
}
