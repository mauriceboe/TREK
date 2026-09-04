/**
 * The single Zod catalog of TREK's environment surface, validated ONCE at boot
 * (see env.ts / boot-validate.ts) — never per-request and never inside
 * buildApp(), so the test harness (which boots dozens of apps per run with a
 * minimal env) is unaffected.
 *
 * Fail-fast contract: a variable that is UNSET (or blank) always falls back to
 * its default — only a PRESENT-but-malformed value aborts startup. Keys not
 * listed here pass through untouched (Zod strips unknown keys, it does not
 * reject them).
 */
import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES } from '@trek/shared';
import { parseDurationMs } from './parsers';

/** Present-but-malformed fails; unset/blank always passes (defaults apply). */
function optionalWith(test: (v: string) => boolean, message: string) {
  return z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || test(v.trim()), message);
}

const anyString = z.string().optional();
const boolStr = optionalWith(
  (v) => /^(true|false|on|off|yes|no|1|0)$/i.test(v),
  'must be a boolean-like value (true/false, 1/0, on/off, yes/no)',
);
const integer = (min: number, max = Number.MAX_SAFE_INTEGER, msg = `must be an integer between ${min} and ${max}`) =>
  optionalWith((v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max;
  }, msg);
const positiveNumber = optionalWith((v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}, 'must be a positive number');
const url = optionalWith((v) => {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid URL (with protocol)');
const duration = optionalWith(
  (v) => parseDurationMs(v) != null,
  'must be a duration like "1h", "7d" or "30d"',
);
const oneOf = (values: string[]) =>
  optionalWith((v) => values.includes(v.toLowerCase()), `must be one of: ${values.join(', ')}`);

export const envSchema = z.object({
  // Core runtime
  PORT: integer(1, 65535, 'must be a port number (1-65535)'),
  HOST: anyString,
  // NODE_ENV and TZ are deliberately unvalidated: non-standard values (e.g.
  // NODE_ENV=staging) behave as "not production" today and must keep booting.
  NODE_ENV: anyString,
  TZ: anyString,
  LOG_LEVEL: oneOf(['error', 'warn', 'info', 'debug']),
  APP_VERSION: anyString,
  APP_URL: url,
  ALLOWED_ORIGINS: anyString,
  // Candidates lowercased so mixed-case codes (zh-TW) validate case-insensitively.
  DEFAULT_LANGUAGE: oneOf(SUPPORTED_LANGUAGE_CODES.map((c) => c.toLowerCase())),

  // Security / session
  ENCRYPTION_KEY: anyString,
  SESSION_DURATION: duration,
  SESSION_DURATION_REMEMBER: duration,
  COOKIE_SECURE: boolStr,
  FORCE_HTTPS: boolStr,
  HSTS_INCLUDE_SUBDOMAINS: boolStr,
  TRUST_PROXY: integer(0, 2 ** 31, 'must be an integer (number of trusted proxy hops)'),
  ALLOW_INTERNAL_NETWORK: boolStr,
  IDEMPOTENCY_TTL_SECONDS: positiveNumber,

  // OIDC
  OIDC_ISSUER: url,
  OIDC_CLIENT_ID: anyString,
  OIDC_CLIENT_SECRET: anyString,
  OIDC_DISPLAY_NAME: anyString,
  OIDC_DISCOVERY_URL: url,
  OIDC_SCOPE: anyString,
  OIDC_ONLY: boolStr,
  OIDC_ADMIN_CLAIM: anyString,
  OIDC_ADMIN_VALUE: anyString,

  // SMTP
  SMTP_HOST: anyString,
  SMTP_PORT: integer(1, 65535, 'must be a port number (1-65535)'),
  SMTP_USER: anyString,
  SMTP_PASS: anyString,
  SMTP_FROM: anyString,
  SMTP_SKIP_TLS_VERIFY: boolStr,

  // WebAuthn
  WEBAUTHN_RP_ID: anyString,
  WEBAUTHN_ORIGINS: anyString,

  // MCP
  MCP_SESSION_TTL: positiveNumber,
  MCP_MAX_SESSION_PER_USER: positiveNumber,
  MCP_SSE_KEEPALIVE: integer(0, Number.MAX_SAFE_INTEGER, 'must be a non-negative integer (seconds, 0 disables)'),
  MCP_RATE_LIMIT: positiveNumber,

  // Integrations
  UNSPLASH_ACCESS_KEY: anyString,
  TRANSIT_API_URL: url,
  // OVERPASS_URL accepts a comma-separated endpoint list and silently drops
  // non-http(s) entries today — left unvalidated to keep that behavior.
  OVERPASS_URL: anyString,
  OVERPASS_TIMEOUT_MS: positiveNumber,
  // Whole milliseconds, and inside setTimeout's 32-bit range. A fractional value
  // would floor to 0 and abort every model call on the next tick; anything past
  // 2^31-1 makes Node clamp the delay to 1 ms and do the same. Both refuse at
  // boot rather than degrading into a timeout of zero.
  LLM_TIMEOUT_MS: integer(1, 2_147_483_647, 'must be a whole number of milliseconds between 1 and 2147483647'),
  KITINERARY_EXTRACTOR_PATH: anyString,
  // The OS search path. Not configuration anybody sets for TREK — it is here so
  // the kitinerary probe can resolve its binary to an absolute path itself
  // instead of handing an unqualified name to exec, which would re-resolve
  // through whatever PATH held at that moment.
  PATH: anyString,
  Path: anyString,

  // Data / paths
  TREK_DB_FILE: anyString,
  // The two SQLite pragmas are deliberately unvalidated: a typo here must fall
  // back and warn rather than abort boot, because reset-admin.js — the way out
  // of a locked-out instance — reads the same variables and is not covered by
  // this schema at all. Resolution lives in parsers.resolveDurability().
  TREK_DB_JOURNAL_MODE: anyString,
  TREK_DB_SYNCHRONOUS: anyString,
  TREK_WIKI_DIR: anyString,
  TREK_PLACE_PHOTO_DIR: anyString,
  BACKUP_UPLOAD_LIMIT_MB: positiveNumber,
  BACKUP_MAX_DECOMPRESSED_MB: positiveNumber,

  // Admin / demo
  ADMIN_EMAIL: anyString,
  ADMIN_PASSWORD: anyString,
  TREK_MANAGED: boolStr,
  PLACES_API_BASE: url,
  PLACES_API_KEY: anyString,
  MAPBOX_ACCESS_TOKEN: anyString,
  CARTO_API_KEY: anyString,
  DEMO_MODE: boolStr,
  DEMO_ADMIN_USER: anyString,
  DEMO_ADMIN_EMAIL: anyString,
  DEMO_ADMIN_PASS: anyString,

  // API docs / plugins
  TREK_API_DOCS_ENABLED: boolStr,
  TREK_PLUGINS_ENABLED: boolStr,
  TREK_PLUGINS_DEV_LINK: boolStr,
  TREK_PLUGINS_IGNORE_TREK_RANGE: boolStr,
  TREK_PLUGINS_DIR: anyString,
  TREK_PLUGINS_DATA_DIR: anyString,
  TREK_PLUGIN_PERMISSIONS: boolStr,
  TREK_PLUGIN_ALLOW_PRIVATE_EGRESS: boolStr,
  TREK_PLUGIN_REGISTRY_URL: url,
  TREK_PLUGIN_RPC_BURST: positiveNumber,
  TREK_PLUGIN_RPC_PER_SEC: positiveNumber,
  TREK_PLUGIN_RPC_INFLIGHT: positiveNumber,
  TREK_PLUGIN_LOG_BURST: positiveNumber,
  TREK_PLUGIN_LOG_PER_SEC: positiveNumber,
  TREK_PLUGIN_MAX_RSS_MB: positiveNumber,
});
