import { describe, it, expect } from 'vitest';

import {
  deriveApp,
  deriveHttp,
  deriveSession,
  deriveDemo,
  deriveOidc,
  deriveSmtp,
  deriveMcp,
  derivePlugins,
  deriveIntegrations,
  deriveBackup,
  deriveNet,
  derivePaths,
  deriveAll,
} from '../../../src/app-config/derive';

// These tests PIN the exact legacy coercions each derived field replaced.
// If one fails after an edit, the edit changed runtime behavior — fix the
// edit, not the test (parity is law).

describe('deriveApp', () => {
  it('NODE_ENV: loose helpers lowercase, isTest stays case-sensitive (db/database.ts)', () => {
    expect(deriveApp({ NODE_ENV: 'PRODUCTION' }).isProduction).toBe(true);
    expect(deriveApp({ NODE_ENV: 'Development' }).isDevelopment).toBe(true);
    expect(deriveApp({ NODE_ENV: 'test' }).isTest).toBe(true);
    expect(deriveApp({ NODE_ENV: 'TEST' }).isTest).toBe(false); // strict on purpose
    expect(deriveApp({}).isProduction).toBe(false);
  });

  it('PORT: Number(x) || 3001 (index.ts)', () => {
    expect(deriveApp({ PORT: '8080' }).port).toBe(8080);
    expect(deriveApp({ PORT: 'abc' }).port).toBe(3001);
    expect(deriveApp({}).port).toBe(3001);
  });

  it('APP_VERSION / APP_URL stay raw — per-site fallbacks live at the call sites', () => {
    expect(deriveApp({}).appVersion).toBeUndefined();
    expect(deriveApp({ APP_URL: 'https://x.example/' }).appUrl).toBe('https://x.example/');
  });

  it('DEFAULT_LANGUAGE resolves: case-insensitive, canonical code, en fallback', () => {
    expect(deriveApp({ DEFAULT_LANGUAGE: 'EN' }).defaultLanguage).toBe('en');
    expect(deriveApp({ DEFAULT_LANGUAGE: 'de' }).defaultLanguage).toBe('de');
    expect(deriveApp({ DEFAULT_LANGUAGE: 'klingon' }).defaultLanguage).toBe('en');
    expect(deriveApp({}).defaultLanguage).toBe('en');
    // Mixed-case canonical codes resolve to their canonical form (legacy could
    // never match zh-TW and silently served English).
    expect(deriveApp({ DEFAULT_LANGUAGE: 'zh-TW' }).defaultLanguage).toBe('zh-TW');
    expect(deriveApp({ DEFAULT_LANGUAGE: 'zh-tw' }).defaultLanguage).toBe('zh-TW');
  });
});

describe('deriveHttp', () => {
  it('ALLOWED_ORIGINS: CORS variant filters empties, websocket variant keeps them', () => {
    const env = { ALLOWED_ORIGINS: ' https://a.example ,, https://b.example ' };
    expect(deriveHttp(env).corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(deriveHttp(env).wsOrigins).toEqual(['https://a.example', '', 'https://b.example']);
    expect(deriveHttp({}).corsOrigins).toBeNull();
    expect(deriveHttp({}).wsOrigins).toBeNull();
  });

  it('TRUST_PROXY: numeric hop count wins, 1 only as fallback (globalMiddleware)', () => {
    expect(deriveHttp({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    // 0 is a valid hop count ("trust no proxy"), not a missing value.
    expect(deriveHttp({ TRUST_PROXY: '0' }).trustProxy).toBe(0);
    expect(deriveHttp({ TRUST_PROXY: 'abc' }).trustProxy).toBe(1);
    expect(deriveHttp({}).trustProxy).toBe(1);
  });

  it('boolean switches accept the whole boolean-like family (unified semantics)', () => {
    expect(deriveHttp({ FORCE_HTTPS: 'TRUE' }).forceHttps).toBe(true);
    expect(deriveHttp({ FORCE_HTTPS: 'on' }).forceHttps).toBe(true);
    expect(deriveHttp({ HSTS_INCLUDE_SUBDOMAINS: 'TRUE' }).hstsIncludeSubdomains).toBe(true);
    expect(deriveHttp({ HSTS_INCLUDE_SUBDOMAINS: '1' }).hstsIncludeSubdomains).toBe(true);
    expect(deriveHttp({ HSTS_INCLUDE_SUBDOMAINS: 'off' }).hstsIncludeSubdomains).toBe(false);
  });

  it('COOKIE_SECURE is tri-state: explicit falsy disables, anything else auto-detects', () => {
    expect(deriveHttp({ COOKIE_SECURE: 'false' }).cookieSecureDisabled).toBe(true);
    expect(deriveHttp({ COOKIE_SECURE: 'off' }).cookieSecureDisabled).toBe(true);
    expect(deriveHttp({ COOKIE_SECURE: 'true' }).cookieSecureDisabled).toBe(false);
    expect(deriveHttp({}).cookieSecureDisabled).toBe(false);
  });

  it('TREK_API_DOCS_ENABLED: trimmed, boolean-like (api-docs.kill-switch)', () => {
    expect(deriveHttp({ TREK_API_DOCS_ENABLED: ' TRUE ' }).apiDocsEnabled).toBe(true);
    expect(deriveHttp({ TREK_API_DOCS_ENABLED: '1' }).apiDocsEnabled).toBe(true);
    expect(deriveHttp({ TREK_API_DOCS_ENABLED: 'false' }).apiDocsEnabled).toBe(false);
    expect(deriveHttp({}).apiDocsEnabled).toBe(false);
  });
});

describe('deriveSession', () => {
  it('parses durations and falls back on invalid input (src/config.ts semantics)', () => {
    const ok = deriveSession({ SESSION_DURATION: '12h', SESSION_DURATION_REMEMBER: '90d' });
    expect(ok.duration).toBe('12h');
    expect(ok.durationMs).toBe(12 * 3_600_000);
    expect(ok.durationSeconds).toBe(12 * 3600);
    expect(ok.durationRememberMs).toBe(90 * 86_400_000);

    const bad = deriveSession({ SESSION_DURATION: 'bogus' });
    expect(bad.duration).toBe('24h');
    expect(bad.durationMs).toBe(24 * 3_600_000);
    expect(deriveSession({}).durationRemember).toBe('30d');
  });

  it('IDEMPOTENCY_TTL_SECONDS: positive number or 30 days (scheduler.ts)', () => {
    expect(deriveSession({ IDEMPOTENCY_TTL_SECONDS: '60' }).idempotencyTtlSeconds).toBe(60);
    expect(deriveSession({ IDEMPOTENCY_TTL_SECONDS: '0' }).idempotencyTtlSeconds).toBe(30 * 24 * 60 * 60);
    expect(deriveSession({}).idempotencyTtlSeconds).toBe(30 * 24 * 60 * 60);
  });
});

describe('deriveDemo', () => {
  it('DEMO_MODE coerces the whole boolean-like family to one bool', () => {
    expect(deriveDemo({ DEMO_MODE: 'TRUE' }).enabled).toBe(true);
    expect(deriveDemo({ DEMO_MODE: 'yes' }).enabled).toBe(true);
    expect(deriveDemo({ DEMO_MODE: 'off' }).enabled).toBe(false);
    expect(deriveDemo({ DEMO_MODE: 'maybe' }).enabled).toBe(false); // out-of-family → default (validation rejects it at boot)
    expect(deriveDemo({}).enabled).toBe(false);
  });

  it('DEMO_ADMIN_EMAIL stays raw — demo-seed and demo-reset apply different defaults', () => {
    expect(deriveDemo({}).adminEmailRaw).toBeUndefined();
    expect(deriveDemo({}).adminUser).toBe('admin');
    expect(deriveDemo({}).adminPass).toBe('admin12345');
  });

  it('DEMO_ADMIN_PASS: adminPassSet tells the default apart from an explicit value', () => {
    expect(deriveDemo({}).adminPassSet).toBe(false);
    expect(deriveDemo({ DEMO_ADMIN_PASS: '' }).adminPassSet).toBe(false);
    expect(deriveDemo({ DEMO_ADMIN_PASS: 'hunter22' }).adminPassSet).toBe(true);
  });
});

describe('deriveOidc', () => {
  it('scope and adminClaim carry their single-site defaults', () => {
    expect(deriveOidc({}).scope).toBe('openid email profile');
    expect(deriveOidc({}).adminClaim).toBe('groups');
    expect(deriveOidc({ OIDC_ADMIN_CLAIM: 'roles' }).adminClaim).toBe('roles');
  });

  it('OIDC_ONLY coerces the boolean-like family', () => {
    expect(deriveOidc({ OIDC_ONLY: 'True' }).only).toBe(true);
    expect(deriveOidc({ OIDC_ONLY: '1' }).only).toBe(true);
    expect(deriveOidc({ OIDC_ONLY: 'no' }).only).toBe(false);
  });
});

describe('deriveSmtp', () => {
  it('SMTP_SKIP_TLS_VERIFY coerces the boolean-like family', () => {
    expect(deriveSmtp({ SMTP_SKIP_TLS_VERIFY: 'true' }).skipTlsVerify).toBe(true);
    expect(deriveSmtp({ SMTP_SKIP_TLS_VERIFY: 'TRUE' }).skipTlsVerify).toBe(true);
    expect(deriveSmtp({ SMTP_SKIP_TLS_VERIFY: 'off' }).skipTlsVerify).toBe(false);
    expect(deriveSmtp({}).skipTlsVerify).toBe(false);
  });
});

describe('deriveMcp', () => {
  it('pins the mcp/index.ts module-const parsing', () => {
    expect(deriveMcp({}).sessionTtlMs).toBe(3_600_000);
    expect(deriveMcp({ MCP_MAX_SESSION_PER_USER: '5' }).maxSessionsPerUser).toBe(5);
    expect(deriveMcp({ MCP_MAX_SESSION_PER_USER: '0' }).maxSessionsPerUser).toBe(20);
    expect(deriveMcp({ MCP_SSE_KEEPALIVE: '0' }).sseKeepaliveMs).toBe(0);
    expect(deriveMcp({ MCP_RATE_LIMIT: '100' }).rateLimitMax).toBe(100);
    expect(deriveMcp({}).rateLimitMax).toBe(300);
  });
});

describe('derivePlugins', () => {
  it('kill-switch is default-on; only an explicit falsy value disables', () => {
    expect(derivePlugins({}).enabled).toBe(true);
    expect(derivePlugins({ TREK_PLUGINS_ENABLED: 'anything' }).enabled).toBe(true); // out-of-family → default-on
    for (const v of ['false', '0', 'off', 'no', ' OFF ']) {
      expect(derivePlugins({ TREK_PLUGINS_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('devLink and permissions jail coerce the boolean-like family; jail is default-on', () => {
    expect(derivePlugins({ TREK_PLUGINS_DEV_LINK: '1' }).devLink).toBe(true);
    expect(derivePlugins({ TREK_PLUGINS_DEV_LINK: 'true' }).devLink).toBe(true);
    expect(derivePlugins({ TREK_PLUGINS_DEV_LINK: 'off' }).devLink).toBe(false);
    expect(derivePlugins({ TREK_PLUGIN_PERMISSIONS: 'OFF' }).permissionsOff).toBe(true);
    expect(derivePlugins({ TREK_PLUGIN_PERMISSIONS: 'false' }).permissionsOff).toBe(true);
    expect(derivePlugins({ TREK_PLUGIN_PERMISSIONS: 'on' }).permissionsOff).toBe(false);
    expect(derivePlugins({}).permissionsOff).toBe(false);
  });

  it('ignoreTrekRange is off unless explicitly truthy — the version gate must never bypass by accident', () => {
    expect(derivePlugins({}).ignoreTrekRange).toBe(false);
    expect(derivePlugins({ TREK_PLUGINS_IGNORE_TREK_RANGE: '' }).ignoreTrekRange).toBe(false);
    expect(derivePlugins({ TREK_PLUGINS_IGNORE_TREK_RANGE: 'off' }).ignoreTrekRange).toBe(false);
    expect(derivePlugins({ TREK_PLUGINS_IGNORE_TREK_RANGE: '1' }).ignoreTrekRange).toBe(true);
    expect(derivePlugins({ TREK_PLUGINS_IGNORE_TREK_RANGE: 'TRUE' }).ignoreTrekRange).toBe(true);
  });

  it('allowPrivateEgress is a bool (supervisor normalizes it to the literal "on" for the child)', () => {
    expect(derivePlugins({ TREK_PLUGIN_ALLOW_PRIVATE_EGRESS: 'on' }).allowPrivateEgress).toBe(true);
    expect(derivePlugins({ TREK_PLUGIN_ALLOW_PRIVATE_EGRESS: 'true' }).allowPrivateEgress).toBe(true);
    expect(derivePlugins({ TREK_PLUGIN_ALLOW_PRIVATE_EGRESS: 'off' }).allowPrivateEgress).toBe(false);
    expect(derivePlugins({}).allowPrivateEgress).toBe(false);
  });

  it('rate limits use Number(x) || default (rate-limit.ts / supervisor)', () => {
    expect(derivePlugins({}).rpcBurst).toBe(60);
    expect(derivePlugins({ TREK_PLUGIN_RPC_PER_SEC: '5' }).rpcPerSec).toBe(5);
    expect(derivePlugins({ TREK_PLUGIN_MAX_RSS_MB: 'abc' }).maxRssMb).toBe(300);
  });
});

describe('deriveIntegrations', () => {
  it('pins unsplash trim, transit base strip + default, overpass timeout', () => {
    expect(deriveIntegrations({ UNSPLASH_ACCESS_KEY: ' key ' }).unsplashAccessKey).toBe('key');
    expect(deriveIntegrations({}).transitApiBase).toBe('https://api.transitous.org');
    expect(deriveIntegrations({ TRANSIT_API_URL: 'https://t.example//' }).transitApiBase).toBe('https://t.example');
    expect(deriveIntegrations({}).overpassTimeoutMs).toBe(12000);
    expect(deriveIntegrations({ OVERPASS_TIMEOUT_MS: '-1' }).overpassTimeoutMs).toBe(12000);
  });

  it('floors the LLM ceiling to a whole number — undici rejects a fractional headersTimeout', () => {
    expect(deriveIntegrations({}).llmTimeoutMs).toBe(900_000);
    expect(deriveIntegrations({ LLM_TIMEOUT_MS: '-1' }).llmTimeoutMs).toBe(900_000);
    expect(deriveIntegrations({ LLM_TIMEOUT_MS: '60000.5' }).llmTimeoutMs).toBe(60_000);
  });
});

describe('deriveBackup', () => {
  it('pins the backupService limit parsing (positive number or default)', () => {
    expect(deriveBackup({}).uploadLimitMb).toBe(500);
    expect(deriveBackup({ BACKUP_UPLOAD_LIMIT_MB: ' 750 ' }).uploadLimitMb).toBe(750);
    expect(deriveBackup({ BACKUP_UPLOAD_LIMIT_MB: '-1' }).uploadLimitMb).toBe(500);
    expect(deriveBackup({}).maxDecompressedMb).toBe(5 * 1024);
    expect(deriveBackup({ ENCRYPTION_KEY: 'x' }).encryptionKeyFromEnv).toBe(true);
  });
});

describe('deriveNet', () => {
  it('ALLOW_INTERNAL_NETWORK coerces the boolean-like family (ssrfGuard)', () => {
    expect(deriveNet({ ALLOW_INTERNAL_NETWORK: 'True' }).allowInternalNetwork).toBe(true);
    expect(deriveNet({ ALLOW_INTERNAL_NETWORK: '1' }).allowInternalNetwork).toBe(true);
    expect(deriveNet({}).allowInternalNetwork).toBe(false);
  });
});

describe('derivePaths', () => {
  it('passes the path vars through raw — defaulting stays at the consumer', () => {
    expect(derivePaths({ TREK_WIKI_DIR: '/w' }).wikiDir).toBe('/w');
    expect(derivePaths({ TREK_PLACE_PHOTO_DIR: '/p' }).placePhotoDir).toBe('/p');
    expect(derivePaths({}).wikiDir).toBeUndefined();
    expect(derivePaths({}).placePhotoDir).toBeUndefined();
  });
});

describe('deriveAll', () => {
  it('assembles every namespace', () => {
    const env = deriveAll({ PORT: '4000', DEMO_MODE: 'true' });
    expect(env.app.port).toBe(4000);
    expect(env.demo.enabled).toBe(true);
    for (const ns of [
      'app', 'http', 'session', 'demo', 'adminBootstrap', 'oidc', 'smtp', 'mcp',
      'plugins', 'webauthn', 'integrations', 'backup', 'db', 'paths', 'net',
    ] as const) {
      expect(env[ns]).toBeDefined();
    }
  });
});
