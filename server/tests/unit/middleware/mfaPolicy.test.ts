import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/database', () => ({
  db: { prepare: () => ({ get: vi.fn(), all: vi.fn() }) },
}));
vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret' }));

import { isPublicApiPath, isMfaSetupExemptPath } from '../../../src/middleware/mfaPolicy';

// ── isPublicApiPath ──────────────────────────────────────────────────────────

describe('isPublicApiPath', () => {
  // AUTH-001 — Public paths must bypass MFA
  it('AUTH-001: GET /api/health is public', () => {
    expect(isPublicApiPath('GET', '/api/health')).toBe(true);
  });

  it('GET /api/auth/app-config is public', () => {
    expect(isPublicApiPath('GET', '/api/auth/app-config')).toBe(true);
  });

  it('POST /api/auth/login is public', () => {
    expect(isPublicApiPath('POST', '/api/auth/login')).toBe(true);
  });

  it('POST /api/auth/register is public', () => {
    expect(isPublicApiPath('POST', '/api/auth/register')).toBe(true);
  });

  it('POST /api/auth/demo-login is public', () => {
    expect(isPublicApiPath('POST', '/api/auth/demo-login')).toBe(true);
  });

  it('GET /api/auth/invite/<token> is public', () => {
    expect(isPublicApiPath('GET', '/api/auth/invite/abc123')).toBe(true);
    expect(isPublicApiPath('GET', '/api/auth/invite/xyz-789')).toBe(true);
  });

  it('POST /api/auth/mfa/verify-login is public', () => {
    expect(isPublicApiPath('POST', '/api/auth/mfa/verify-login')).toBe(true);
  });

  it('OIDC paths are public (any method)', () => {
    expect(isPublicApiPath('GET', '/api/auth/oidc/callback')).toBe(true);
    expect(isPublicApiPath('POST', '/api/auth/oidc/login')).toBe(true);
    expect(isPublicApiPath('GET', '/api/auth/oidc/discovery')).toBe(true);
  });

  it('GET /api/trips is not public', () => {
    expect(isPublicApiPath('GET', '/api/trips')).toBe(false);
  });

  it('POST /api/auth/login with wrong method (GET) is not public', () => {
    expect(isPublicApiPath('GET', '/api/auth/login')).toBe(false);
  });

  it('GET /api/auth/me is not public', () => {
    expect(isPublicApiPath('GET', '/api/auth/me')).toBe(false);
  });

  it('DELETE /api/auth/logout is not public', () => {
    expect(isPublicApiPath('DELETE', '/api/auth/logout')).toBe(false);
  });
});

// ── isMfaSetupExemptPath ─────────────────────────────────────────────────────

describe('isMfaSetupExemptPath', () => {
  it('GET /api/auth/me is MFA-setup exempt', () => {
    expect(isMfaSetupExemptPath('GET', '/api/auth/me')).toBe(true);
  });

  it('POST /api/auth/mfa/setup is MFA-setup exempt', () => {
    expect(isMfaSetupExemptPath('POST', '/api/auth/mfa/setup')).toBe(true);
  });

  it('POST /api/auth/mfa/enable is MFA-setup exempt', () => {
    expect(isMfaSetupExemptPath('POST', '/api/auth/mfa/enable')).toBe(true);
  });

  it('GET /api/auth/app-settings is MFA-setup exempt', () => {
    expect(isMfaSetupExemptPath('GET', '/api/auth/app-settings')).toBe(true);
  });

  it('PUT /api/auth/app-settings is MFA-setup exempt', () => {
    expect(isMfaSetupExemptPath('PUT', '/api/auth/app-settings')).toBe(true);
  });

  it('POST /api/auth/app-settings is NOT exempt (wrong method)', () => {
    expect(isMfaSetupExemptPath('POST', '/api/auth/app-settings')).toBe(false);
  });

  it('GET /api/trips is NOT exempt', () => {
    expect(isMfaSetupExemptPath('GET', '/api/trips')).toBe(false);
  });

  it('GET /api/auth/logout is NOT exempt', () => {
    expect(isMfaSetupExemptPath('GET', '/api/auth/logout')).toBe(false);
  });
});
