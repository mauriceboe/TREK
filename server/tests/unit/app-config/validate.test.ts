import { describe, it, expect, vi, afterEach } from 'vitest';

import { validateEnvAtBoot, readEnv } from '../../../src/app-config/env';

describe('validateEnvAtBoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes with a completely empty environment (all defaults)', () => {
    expect(() => validateEnvAtBoot({})).not.toThrow();
  });

  it('passes with a representative valid environment', () => {
    expect(() =>
      validateEnvAtBoot({
        PORT: '3001',
        NODE_ENV: 'production',
        DEMO_MODE: 'false',
        SESSION_DURATION: '12h',
        SESSION_DURATION_REMEMBER: '90d',
        DEFAULT_LANGUAGE: 'en',
        APP_URL: 'https://trek.example.com',
        ALLOWED_ORIGINS: 'https://trek.example.com',
        LOG_LEVEL: 'debug',
        TRUST_PROXY: '2',
        OIDC_ISSUER: 'https://auth.example.com/realms/trek',
        SMTP_PORT: '587',
        MCP_RATE_LIMIT: '100',
        BACKUP_UPLOAD_LIMIT_MB: '750',
        TREK_PLUGINS_ENABLED: 'off',
        TREK_PLUGIN_PERMISSIONS: 'on',
      }),
    ).not.toThrow();
  });

  it('refuses an LLM ceiling that would silently become a zero timeout', () => {
    // Both shapes pass a plain "positive number" check and then degrade into an
    // immediate abort: a fractional value floors to 0, and anything past the
    // 32-bit range makes Node clamp the setTimeout delay to 1 ms. The wiki
    // promises invalid values abort startup, so they have to refuse here.
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '0.5' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '900000.5' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '2147483648' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '0' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '-1' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: 'abc' })).toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '900000' })).not.toThrow();
    expect(() => validateEnvAtBoot({ LLM_TIMEOUT_MS: '' })).not.toThrow();
  });

  it('treats blank values as unset (defaults apply, no error)', () => {
    expect(() => validateEnvAtBoot({ DEMO_MODE: '', PORT: '  ', TZ: '' })).not.toThrow();
  });

  it('ignores unknown environment variables', () => {
    expect(() => validateEnvAtBoot({ SOME_OTHER_TOOLS_VAR: '!!not-a-trek-var!!' })).not.toThrow();
  });

  it('does not validate NODE_ENV (non-standard values must keep booting)', () => {
    expect(() => validateEnvAtBoot({ NODE_ENV: 'staging' })).not.toThrow();
  });

  it('throws on present-but-malformed values with an aggregated report', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      validateEnvAtBoot({
        PORT: 'not-a-port',
        SESSION_DURATION: 'bogus',
        DEMO_MODE: 'maybe',
        APP_URL: 'not a url',
      }),
    ).toThrow(/Invalid environment configuration \(4 problems\)/);
    const report = error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(report).toContain('PORT="not-a-port"');
    expect(report).toContain('SESSION_DURATION="bogus"');
    expect(report).toContain('DEMO_MODE="maybe"');
    expect(report).toContain('APP_URL="not a url"');
  });

  it.each([
    ['PORT', '70000'],
    ['TRUST_PROXY', '1.5'],
    ['DEFAULT_LANGUAGE', 'klingon'],
    ['LOG_LEVEL', 'verbose'],
    ['SESSION_DURATION_REMEMBER', '-1d'],
    ['OIDC_ISSUER', 'auth.example.com'],
    ['SMTP_PORT', 'smtp'],
    ['MCP_SSE_KEEPALIVE', '-1'],
    ['IDEMPOTENCY_TTL_SECONDS', '0'],
    ['BACKUP_UPLOAD_LIMIT_MB', '0'],
    ['HSTS_INCLUDE_SUBDOMAINS', 'enabled'],
    ['TREK_PLUGINS_ENABLED', 'maybe'],
    ['TREK_PLUGINS_DEV_LINK', 'always'],
    ['TREK_PLUGIN_PERMISSIONS', 'disabled'],
    ['TREK_PLUGIN_MAX_RSS_MB', '-100'],
  ])('rejects malformed %s=%s', (key, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnvAtBoot({ [key]: value })).toThrow(/Invalid environment configuration/);
  });

  it.each([
    ['DEMO_MODE', 'TRUE'],
    ['TREK_API_DOCS_ENABLED', ' TRUE '],
    ['TREK_PLUGINS_ENABLED', ' OFF '],
    ['DEFAULT_LANGUAGE', 'EN'],
    ['DEFAULT_LANGUAGE', 'zh-TW'],
    ['LOG_LEVEL', 'ERROR'],
    ['SESSION_DURATION', ' 12H '],
  ])('accepts differently-cased/padded valid %s=%s', (key, value) => {
    expect(() => validateEnvAtBoot({ [key]: value })).not.toThrow();
  });

  // Booleans accept the whole boolean-like family (true/false, 1/0, on/off,
  // yes/no) and derive to real booleans via parseBool — DEMO_MODE=yes enables
  // demo mode, TREK_PLUGINS_DEV_LINK=true activates dev-link (see derive.test).
  it.each([
    ['DEMO_MODE', 'yes'],
    ['HSTS_INCLUDE_SUBDOMAINS', '1'],
    ['TREK_PLUGINS_DEV_LINK', 'true'],
    ['TREK_PLUGIN_PERMISSIONS', 'off'],
    ['TREK_PLUGIN_ALLOW_PRIVATE_EGRESS', 'on'],
    ['FORCE_HTTPS', 'On'],
  ])('accepts boolean-like %s=%s', (key, value) => {
    expect(() => validateEnvAtBoot({ [key]: value })).not.toThrow();
  });
});

describe('validateEnvAtBoot — centrally administered preconditions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MANAGED-BOOT-001: refuses TREK_MANAGED without ENCRYPTION_KEY', () => {
    // The combination boots fine and is wrong: the at-rest key falls back to a
    // file in the data volume, and backupService puts that file in every archive
    // an instance admin can download.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnvAtBoot({ TREK_MANAGED: '1' })).toThrow(/1 problem/);
  });

  it('MANAGED-BOOT-002: names the variable, so the fix does not need the source', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnvAtBoot({ TREK_MANAGED: 'true' })).toThrow();
    expect(err.mock.calls[0][0]).toMatch(/ENCRYPTION_KEY/);
  });

  it('MANAGED-BOOT-003: passes once the key is supplied', () => {
    expect(() =>
      validateEnvAtBoot({ TREK_MANAGED: '1', ENCRYPTION_KEY: 'a'.repeat(64) }),
    ).not.toThrow();
  });

  it('MANAGED-BOOT-004: inert without the switch — a self-hoster keeps the file-based key', () => {
    // The whole point of the check is that it cannot reach anyone who did not
    // ask to be centrally administered.
    expect(() => validateEnvAtBoot({})).not.toThrow();
    expect(() => validateEnvAtBoot({ TREK_MANAGED: 'off' })).not.toThrow();
    expect(() => validateEnvAtBoot({ TREK_MANAGED: 'false' })).not.toThrow();
  });

  it('MANAGED-BOOT-005: reports alongside schema problems rather than instead of them', () => {
    // Both kinds land in one report: fixing the env should take one pass, not a
    // restart per problem.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnvAtBoot({ TREK_MANAGED: '1', PORT: 'not-a-port' })).toThrow(
      /2 problems/,
    );
    expect(err.mock.calls[0][0]).toMatch(/PORT/);
    expect(err.mock.calls[0][0]).toMatch(/ENCRYPTION_KEY/);
  });
});

describe('readEnv', () => {
  it('reads process.env live — a runtime mutation is visible on the next call', () => {
    const before = process.env.DEMO_MODE;
    try {
      process.env.DEMO_MODE = 'true';
      expect(readEnv().demo.enabled).toBe(true);
      process.env.DEMO_MODE = 'false';
      expect(readEnv().demo.enabled).toBe(false);
      delete process.env.DEMO_MODE;
      expect(readEnv().demo.enabled).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = before;
    }
  });
});
