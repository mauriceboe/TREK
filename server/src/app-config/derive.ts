/**
 * Pure per-namespace derive functions: (raw env) → typed config namespace.
 *
 * Every field pins the EXACT coercion of the call site(s) it replaces — parity
 * is law — with ONE deliberate exception: boolean switches are unified through
 * parseBool (true/1/on/yes vs false/0/off/no, any casing), because the legacy
 * per-site literals ('true' here, '1' there, 'on' elsewhere) were an accident,
 * not a contract. Where sites apply different DEFAULTS for the same variable
 * (DEMO_ADMIN_EMAIL), only the raw value is exposed and the default stays at
 * the call site.
 *
 * These functions are plain string coercions with NO caching and NO side
 * effects: `readEnv()` (env.ts) re-derives from the live process.env on every
 * call, which is what keeps the runtime env-mutation semantics the test suite
 * depends on. Zod validation runs once at boot (env.schema.ts), never here.
 */
import { SUPPORTED_LANGUAGE_CODES } from '@trek/shared';
import {
  csvList,
  csvListFiltered,
  numberOr,
  parseBool,
  parseDurationMs,
  positiveIntOr,
  positiveNumberOr,
  resolveDurability,
  resolveKeepaliveMs,
  resolveSessionTtlMs,
  stripTrailingSlashes,
} from './parsers';

export type RawEnv = Record<string, string | undefined>;

export function deriveApp(raw: RawEnv) {
  const nodeEnv = raw.NODE_ENV;
  return {
    /** Raw NODE_ENV — for the case-SENSITIVE sites (`=== 'production'` in globalMiddleware HSTS, platform statics, spa-fallback; `=== 'development'` in authService.dev_mode). */
    nodeEnv,
    isProduction: nodeEnv?.toLowerCase() === 'production',
    isDevelopment: nodeEnv?.toLowerCase() === 'development',
    /** Case-sensitive on purpose — db/database.ts picks :memory: only on exactly 'test'. */
    isTest: nodeEnv === 'test',
    port: numberOr(raw.PORT, 3001),
    host: raw.HOST,
    /** Raw APP_VERSION — fallbacks differ per site ('0.0.0' vs package.json vs semver-validated); each keeps its own. */
    appVersion: raw.APP_VERSION,
    /** Raw APP_URL — trailing-slash stripping differs per site (feeds strips one, notifications strips all). */
    appUrl: raw.APP_URL,
    tz: raw.TZ,
    logLevel: raw.LOG_LEVEL,
    /** Resolved: lowercased, validated against the supported set, falls back to 'en' (src/config.ts semantics). */
    defaultLanguage: resolveDefaultLanguage(raw.DEFAULT_LANGUAGE),
  };
}

function resolveDefaultLanguage(raw: string | undefined): string {
  const lang = raw?.toLowerCase() || 'en';
  // Case-insensitive match resolved to the CANONICAL code (zh-TW, not zh-tw).
  // The legacy lowercase-only `includes` could never match zh-TW and silently
  // fell back to English for a supported language — deliberate fix.
  const canonical = SUPPORTED_LANGUAGE_CODES.find((c) => c.toLowerCase() === lang);
  return canonical ?? 'en';
}

export function deriveHttp(raw: RawEnv) {
  // env.schema.ts accepts 0 as a valid hop count, so `|| 1` would quietly turn
  // "trust nothing" into "trust one hop" and let a forged X-Forwarded-For through.
  const trustProxyHops = Number.parseInt(raw.TRUST_PROXY ?? '', 10);
  return {
    allowedOriginsRaw: raw.ALLOWED_ORIGINS,
    /** globalMiddleware CORS variant: trim + drop empty entries. */
    corsOrigins: csvListFiltered(raw.ALLOWED_ORIGINS),
    /** websocket variant: trim only — an empty entry stays (and can never match an Origin header). */
    wsOrigins: csvList(raw.ALLOWED_ORIGINS),
    trustProxyRaw: raw.TRUST_PROXY,
    trustProxy: Number.isFinite(trustProxyHops) ? trustProxyHops : 1,
    forceHttps: parseBool(raw.FORCE_HTTPS) === true,
    hstsIncludeSubdomains: parseBool(raw.HSTS_INCLUDE_SUBDOMAINS) === true,
    /** COOKIE_SECURE is tri-state: an explicit falsy value disables secure cookies; anything else means auto-detect. */
    cookieSecureDisabled: parseBool(raw.COOKIE_SECURE) === false,
    apiDocsEnabled: parseBool(raw.TREK_API_DOCS_ENABLED) === true,
  };
}

const DEFAULT_SESSION_DURATION = '24h';
const DEFAULT_SESSION_DURATION_REMEMBER = '30d';
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (scheduler.ts)

export function deriveSession(raw: RawEnv) {
  const durationRaw = raw.SESSION_DURATION?.trim() || DEFAULT_SESSION_DURATION;
  const parsedMs = parseDurationMs(durationRaw);
  const rememberRaw = raw.SESSION_DURATION_REMEMBER?.trim() || DEFAULT_SESSION_DURATION_REMEMBER;
  const parsedRememberMs = parseDurationMs(rememberRaw);
  const durationMs = parsedMs ?? parseDurationMs(DEFAULT_SESSION_DURATION)!;
  const rememberMs = parsedRememberMs ?? parseDurationMs(DEFAULT_SESSION_DURATION_REMEMBER)!;
  return {
    /** Human-readable session length actually in effect (invalid input falls back, matching src/config.ts). */
    duration: parsedMs == null ? DEFAULT_SESSION_DURATION : durationRaw,
    durationMs,
    durationSeconds: Math.floor(durationMs / 1000),
    durationRemember: parsedRememberMs == null ? DEFAULT_SESSION_DURATION_REMEMBER : rememberRaw,
    durationRememberMs: rememberMs,
    durationRememberSeconds: Math.floor(rememberMs / 1000),
    idempotencyTtlSeconds: positiveNumberOr(raw.IDEMPOTENCY_TTL_SECONDS, DEFAULT_IDEMPOTENCY_TTL_SECONDS),
  };
}

/**
 * Whether this instance is centrally administered: somebody other than its
 * admin user owns the configuration, the credentials and the upgrade schedule.
 *
 * Only a boolean, on purpose. It answers "who configures this install", and the
 * surfaces that care read it themselves rather than being listed here, so adding
 * one never touches this file.
 *
 * `=== true` so an unset, empty or unparseable value means off. A managed
 * install sets it deliberately; nothing should be able to switch it on by
 * accident, and a typo must not silently take settings away from an admin.
 */
export function deriveManaged(raw: RawEnv) {
  return {
    enabled: parseBool(raw.TREK_MANAGED) === true,
  };
}

/**
 * Where the Places calls go and which credential they carry.
 *
 * Both unset on a self-hosted install, which is the path the code has always
 * taken: the endpoints stay Google's and the key comes from the users table.
 * Set them and the calls leave through something the operator runs, with a
 * credential no instance admin can read back.
 */
export function deriveMaps(raw: RawEnv) {
  return {
    placesApiBase: raw.PLACES_API_BASE || undefined,
    placesApiKey: raw.PLACES_API_KEY || undefined,
    /** Public pk.* token shipped with a managed instance; reaches the browser by design. */
    mapboxToken: raw.MAPBOX_ACCESS_TOKEN || undefined,
    /** CARTO basemap key; without one the tiles come back watermarked (#2054). Public too. */
    cartoKey: raw.CARTO_API_KEY || undefined,
  };
}

export function deriveDemo(raw: RawEnv) {
  return {
    enabled: parseBool(raw.DEMO_MODE) === true,
    adminUser: raw.DEMO_ADMIN_USER || 'admin',
    /** Raw on purpose: demo-seed defaults to admin@trek.app, demo-reset to admin@nomad.app. */
    adminEmailRaw: raw.DEMO_ADMIN_EMAIL,
    adminPass: raw.DEMO_ADMIN_PASS || 'admin12345',
    /** False means the admin account is being created with the published default. */
    adminPassSet: !!raw.DEMO_ADMIN_PASS,
  };
}

export function deriveAdminBootstrap(raw: RawEnv) {
  return {
    email: raw.ADMIN_EMAIL,
    password: raw.ADMIN_PASSWORD,
  };
}

export function deriveOidc(raw: RawEnv) {
  return {
    issuer: raw.OIDC_ISSUER,
    clientId: raw.OIDC_CLIENT_ID,
    clientSecret: raw.OIDC_CLIENT_SECRET,
    displayName: raw.OIDC_DISPLAY_NAME,
    discoveryUrl: raw.OIDC_DISCOVERY_URL,
    scope: raw.OIDC_SCOPE || 'openid email profile',
    only: parseBool(raw.OIDC_ONLY) === true,
    adminClaim: raw.OIDC_ADMIN_CLAIM || 'groups',
    adminValue: raw.OIDC_ADMIN_VALUE,
  };
}

export function deriveSmtp(raw: RawEnv) {
  return {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    user: raw.SMTP_USER,
    pass: raw.SMTP_PASS,
    from: raw.SMTP_FROM,
    skipTlsVerify: parseBool(raw.SMTP_SKIP_TLS_VERIFY) === true,
  };
}

export function deriveMcp(raw: RawEnv) {
  return {
    sessionTtlMs: resolveSessionTtlMs(raw.MCP_SESSION_TTL),
    maxSessionsPerUser: positiveIntOr(raw.MCP_MAX_SESSION_PER_USER, 20),
    sseKeepaliveMs: resolveKeepaliveMs(raw.MCP_SSE_KEEPALIVE),
    rateLimitMax: positiveIntOr(raw.MCP_RATE_LIMIT, 300),
  };
}

export function derivePlugins(raw: RawEnv) {
  return {
    /** Kill-switch is default-on: only an explicit falsy value disables (plugins/kill-switch.ts). */
    enabled: parseBool(raw.TREK_PLUGINS_ENABLED) !== false,
    devLink: parseBool(raw.TREK_PLUGINS_DEV_LINK) === true,
    /**
     * Range bypass is default-OFF: only an explicit truthy value turns the TREK-version
     * gates into warnings (plugins/install/host-compat.ts). Never inferred from any
     * other switch — an admin has to ask for "install it anyway" by name.
     */
    ignoreTrekRange: parseBool(raw.TREK_PLUGINS_IGNORE_TREK_RANGE) === true,
    dir: raw.TREK_PLUGINS_DIR,
    dataDir: raw.TREK_PLUGINS_DATA_DIR,
    /** Permission jail is default-on: only an explicit falsy value turns it off. */
    permissionsOff: parseBool(raw.TREK_PLUGIN_PERMISSIONS) === false,
    registryUrl:
      raw.TREK_PLUGIN_REGISTRY_URL || 'https://raw.githubusercontent.com/liketrek/TREK-Plugins/main/dist/index.json',
    /**
     * The child process and plugin-sdk keep their literal `=== 'on'` check (they
     * are exempt from this layer); the supervisor normalizes this boolean to the
     * literal 'on' when building the child's scrubbed env.
     */
    allowPrivateEgress: parseBool(raw.TREK_PLUGIN_ALLOW_PRIVATE_EGRESS) === true,
    rpcBurst: numberOr(raw.TREK_PLUGIN_RPC_BURST, 60),
    rpcPerSec: numberOr(raw.TREK_PLUGIN_RPC_PER_SEC, 20),
    rpcInflight: numberOr(raw.TREK_PLUGIN_RPC_INFLIGHT, 16),
    logBurst: numberOr(raw.TREK_PLUGIN_LOG_BURST, 50),
    logPerSec: numberOr(raw.TREK_PLUGIN_LOG_PER_SEC, 10),
    maxRssMb: numberOr(raw.TREK_PLUGIN_MAX_RSS_MB, 300),
  };
}

export function deriveWebauthn(raw: RawEnv) {
  return {
    rpId: raw.WEBAUTHN_RP_ID,
    origins: raw.WEBAUTHN_ORIGINS,
  };
}

export function deriveIntegrations(raw: RawEnv) {
  return {
    unsplashAccessKey: raw.UNSPLASH_ACCESS_KEY?.trim(),
    transitApiBase: stripTrailingSlashes(raw.TRANSIT_API_URL || 'https://api.transitous.org'),
    overpassUrl: raw.OVERPASS_URL,
    overpassTimeoutMs: positiveNumberOr(raw.OVERPASS_TIMEOUT_MS, 12000),
    kitineraryExtractorPath: raw.KITINERARY_EXTRACTOR_PATH,
    /**
     * One ceiling for a model call, replacing the three per-client constants
     * that used to disagree. The default is deliberately generous: heavier
     * parsing work should fit without a code change.
     * Floored to a whole number — it reaches undici's headersTimeout, which
     * rejects a fractional value.
     */
    llmTimeoutMs: Math.floor(positiveNumberOr(raw.LLM_TIMEOUT_MS, 900_000)),
    // Windows spells it Path; every other platform PATH. Split here so callers
    // get a list and never re-implement the delimiter.
    searchPath: (raw.PATH || raw.Path || '')
      .split(process.platform === 'win32' ? ';' : ':')
      .map(p => p.trim())
      .filter(Boolean),
  };
}

export function deriveBackup(raw: RawEnv) {
  return {
    uploadLimitMb: positiveNumberOr(raw.BACKUP_UPLOAD_LIMIT_MB, 500),
    maxDecompressedMb: positiveNumberOr(raw.BACKUP_MAX_DECOMPRESSED_MB, 5 * 1024),
    /** backupService only bundles data/.encryption_key into archives when the key does NOT come from env. */
    encryptionKeyFromEnv: !!raw.ENCRYPTION_KEY,
  };
}

export function deriveDb(raw: RawEnv) {
  const durability = resolveDurability(raw.TREK_DB_JOURNAL_MODE, raw.TREK_DB_SYNCHRONOUS);
  return {
    trekDbFile: raw.TREK_DB_FILE,
    /** Resolved journal_mode — WAL unless the operator asked for something else (network storage needs DELETE/TRUNCATE). */
    journalMode: durability.journalMode,
    /** Resolved synchronous level — NORMAL under WAL (what SQLite already does), FULL under a rollback journal. */
    synchronous: durability.synchronous,
    /** Complaints about unusable values; derivation stays side-effect free, so db/durability.ts logs them when it opens the file. */
    durabilityWarnings: durability.warnings,
  };
}

export function derivePaths(raw: RawEnv) {
  return {
    wikiDir: raw.TREK_WIKI_DIR,
    placePhotoDir: raw.TREK_PLACE_PHOTO_DIR,
  };
}

export function deriveNet(raw: RawEnv) {
  return {
    allowInternalNetwork: parseBool(raw.ALLOW_INTERNAL_NETWORK) === true,
  };
}

export function deriveAll(raw: RawEnv) {
  return {
    app: deriveApp(raw),
    http: deriveHttp(raw),
    session: deriveSession(raw),
    managed: deriveManaged(raw),
    maps: deriveMaps(raw),
    demo: deriveDemo(raw),
    adminBootstrap: deriveAdminBootstrap(raw),
    oidc: deriveOidc(raw),
    smtp: deriveSmtp(raw),
    mcp: deriveMcp(raw),
    plugins: derivePlugins(raw),
    webauthn: deriveWebauthn(raw),
    integrations: deriveIntegrations(raw),
    backup: deriveBackup(raw),
    db: deriveDb(raw),
    paths: derivePaths(raw),
    net: deriveNet(raw),
  };
}

export type AppEnv = ReturnType<typeof deriveAll>;
