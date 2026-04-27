/**
 * Authentication integration tests.
 * Covers AUTH-001 to AUTH-022, AUTH-028 to AUTH-033.
 * OIDC scenarios (AUTH-023 to AUTH-027) require a real IdP and are excluded.
 * Rate limiting scenarios (AUTH-004, AUTH-018) are at the end of this file.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { authenticator } from 'otplib';

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Bare in-memory DB — schema applied in beforeAll after mocks register
// ─────────────────────────────────────────────────────────────────────────────
const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`
        SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
        FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?
      `).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };

  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createAdmin, createUserWithMfa, createInviteToken, createTrip, createBudgetItem, createJourney, createJourneyEntry, addJourneyContributor } from '../helpers/factories';
import { authCookie, authHeader } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  // Reset rate limiter state between tests so they don't interfere
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

describe('Login', () => {
  it('AUTH-001 — successful login returns 200, user object, and trek_session cookie', async () => {
    const { user, password } = createUser(testDb);
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.password_hash).toBeUndefined();
    const cookies: string[] = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : [res.headers['set-cookie']];
    expect(cookies.some((c: string) => c.includes('trek_session'))).toBe(true);
  });

  it('AUTH-002 — wrong password returns 401 with generic message', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'WrongPass1!' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid email or password');
  });

  it('AUTH-003 — non-existent email returns 401 with same generic message (no user enumeration)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'SomePass1!' });
    expect(res.status).toBe(401);
    // Must be same message as wrong-password to avoid email enumeration
    expect(res.body.error).toContain('Invalid email or password');
  });

  it('AUTH-013 — POST /api/auth/logout clears session cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    const cookies: string[] = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : (res.headers['set-cookie'] ? [res.headers['set-cookie']] : []);
    const sessionCookie = cookies.find((c: string) => c.includes('trek_session'));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('Registration', () => {
  it('AUTH-005 — first user registration creates admin role and returns 201 + cookie', async () => {
    const res = await request(app).post('/api/auth/register').send({
      username: 'firstadmin',
      email: 'admin@example.com',
      password: 'Str0ng!Pass',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    const cookies: string[] = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : [res.headers['set-cookie']];
    expect(cookies.some((c: string) => c.includes('trek_session'))).toBe(true);
  });

  it('AUTH-006 — registration with weak password is rejected', async () => {
    const res = await request(app).post('/api/auth/register').send({
      username: 'weakpwduser',
      email: 'weak@example.com',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('AUTH-007 — registration with common password is rejected', async () => {
    const res = await request(app).post('/api/auth/register').send({
      username: 'commonpwd',
      email: 'common@example.com',
      password: 'Password1', // 'password1' is in the COMMON_PASSWORDS set
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/common/i);
  });

  it('AUTH-008 — registration with duplicate email returns 409', async () => {
    createUser(testDb, { email: 'taken@example.com' });
    const res = await request(app).post('/api/auth/register').send({
      username: 'newuser',
      email: 'taken@example.com',
      password: 'Str0ng!Pass',
    });
    expect(res.status).toBe(409);
  });

  it('AUTH-009 — registration disabled by admin returns 403', async () => {
    createUser(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();
    const res = await request(app).post('/api/auth/register').send({
      username: 'blocked',
      email: 'blocked@example.com',
      password: 'Str0ng!Pass',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('AUTH-010 — registration with valid invite token succeeds even when registration disabled', async () => {
    const { user: admin } = createAdmin(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();
    const invite = createInviteToken(testDb, { max_uses: 1, created_by: admin.id });

    const res = await request(app).post('/api/auth/register').send({
      username: 'invited',
      email: 'invited@example.com',
      password: 'Str0ng!Pass',
      invite_token: invite.token,
    });
    expect(res.status).toBe(201);

    const row = testDb.prepare('SELECT used_count FROM invite_tokens WHERE id = ?').get(invite.id) as { used_count: number };
    expect(row.used_count).toBe(1);
  });

  it('AUTH-011 — GET /api/auth/invite/:token with expired token returns 410', async () => {
    const { user: admin } = createAdmin(testDb);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const invite = createInviteToken(testDb, { expires_at: yesterday, created_by: admin.id });

    const res = await request(app).get(`/api/auth/invite/${invite.token}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('AUTH-012 — GET /api/auth/invite/:token with exhausted token returns 410', async () => {
    const { user: admin } = createAdmin(testDb);
    const invite = createInviteToken(testDb, { max_uses: 1, created_by: admin.id });
    // Mark as exhausted
    testDb.prepare('UPDATE invite_tokens SET used_count = 1 WHERE id = ?').run(invite.id);

    const res = await request(app).get(`/api/auth/invite/${invite.token}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/fully used/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session / Me
// ─────────────────────────────────────────────────────────────────────────────

describe('Session', () => {
  it('AUTH-014 — GET /api/auth/me without session returns 401 AUTH_REQUIRED', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('AUTH-014 — GET /api/auth/me with valid cookie returns safe user object', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.mfa_secret).toBeUndefined();
  });

  it('AUTH-021 — user with must_change_password=1 sees the flag in their profile', async () => {
    const { user } = createUser(testDb);
    testDb.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);

    const res = await request(app).get('/api/auth/me').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.user.must_change_password).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App Config (AUTH-028)
// ─────────────────────────────────────────────────────────────────────────────

describe('App config', () => {
  it('AUTH-028 — GET /api/auth/app-config returns expected flags', async () => {
    const res = await request(app).get('/api/auth/app-config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('allow_registration');
    expect(res.body).toHaveProperty('oidc_configured');
    expect(res.body).toHaveProperty('demo_mode');
    expect(res.body).toHaveProperty('has_users');
    expect(res.body).toHaveProperty('setup_complete');
  });

  it('AUTH-028 — allow_registration is false after admin disables it', async () => {
    createUser(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();
    const res = await request(app).get('/api/auth/app-config');
    expect(res.status).toBe(200);
    expect(res.body.allow_registration).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Demo Login (AUTH-022)
// ─────────────────────────────────────────────────────────────────────────────

describe('Demo login', () => {
  it('AUTH-022 — POST /api/auth/demo-login without DEMO_MODE returns 404', async () => {
    delete process.env.DEMO_MODE;
    const res = await request(app).post('/api/auth/demo-login');
    expect(res.status).toBe(404);
  });

  it('AUTH-022 — POST /api/auth/demo-login with DEMO_MODE and demo user returns 200 + cookie', async () => {
    testDb.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('demo', 'demo@trek.app', 'x', 'user')"
    ).run();
    process.env.DEMO_MODE = 'true';
    try {
      const res = await request(app).post('/api/auth/demo-login');
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('demo@trek.app');
    } finally {
      delete process.env.DEMO_MODE;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MFA (AUTH-015 to AUTH-019)
// ─────────────────────────────────────────────────────────────────────────────

describe('MFA', () => {
  it('AUTH-015 — POST /api/auth/mfa/setup returns secret and QR data URL', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.secret).toBeDefined();
    expect(res.body.otpauth_url).toContain('otpauth://');
    expect(res.body.qr_svg).toMatch(/^<svg/);
  });

  it('AUTH-015 — POST /api/auth/mfa/enable with valid TOTP code enables MFA', async () => {
    const { user } = createUser(testDb);

    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Cookie', authCookie(user.id));
    expect(setupRes.status).toBe(200);

    const enableRes = await request(app)
      .post('/api/auth/mfa/enable')
      .set('Cookie', authCookie(user.id))
      .send({ code: authenticator.generate(setupRes.body.secret) });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.mfa_enabled).toBe(true);
    expect(Array.isArray(enableRes.body.backup_codes)).toBe(true);
  });

  it('AUTH-016 — login with MFA-enabled account returns mfa_required + mfa_token', async () => {
    const { user, password } = createUserWithMfa(testDb);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.mfa_required).toBe(true);
    expect(typeof loginRes.body.mfa_token).toBe('string');
  });

  it('AUTH-016 — POST /api/auth/mfa/verify-login with valid code completes login', async () => {
    const { user, password, totpSecret } = createUserWithMfa(testDb);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });
    const { mfa_token } = loginRes.body;

    const verifyRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ mfa_token, code: authenticator.generate(totpSecret) });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.user).toBeDefined();
    const cookies: string[] = Array.isArray(verifyRes.headers['set-cookie'])
      ? verifyRes.headers['set-cookie']
      : [verifyRes.headers['set-cookie']];
    expect(cookies.some((c: string) => c.includes('trek_session'))).toBe(true);
  });

  it('AUTH-017 — verify-login with invalid TOTP code returns 401', async () => {
    const { user, password } = createUserWithMfa(testDb);
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });

    const verifyRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ mfa_token: loginRes.body.mfa_token, code: '000000' });
    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.error).toMatch(/invalid/i);
  });

  it('AUTH-019 — disable MFA with valid password and TOTP code', async () => {
    const { user, password, totpSecret } = createUserWithMfa(testDb);

    const disableRes = await request(app)
      .post('/api/auth/mfa/disable')
      .set('Cookie', authCookie(user.id))
      .send({ password, code: authenticator.generate(totpSecret) });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.mfa_enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Forced MFA Policy (AUTH-020)
// ─────────────────────────────────────────────────────────────────────────────

describe('Forced MFA policy', () => {
  it('AUTH-020 — non-MFA user is blocked (403 MFA_REQUIRED) when require_mfa is true', async () => {
    const { user } = createUser(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('require_mfa', 'true')").run();

    // mfaPolicy checks Authorization: Bearer header
    const res = await request(app).get('/api/trips').set(authHeader(user.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });

  it('AUTH-020 — /api/auth/me and MFA setup endpoints are exempt from require_mfa', async () => {
    const { user } = createUser(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('require_mfa', 'true')").run();

    const meRes = await request(app).get('/api/auth/me').set(authHeader(user.id));
    expect(meRes.status).toBe(200);

    const setupRes = await request(app).post('/api/auth/mfa/setup').set(authHeader(user.id));
    expect(setupRes.status).toBe(200);
  });

  it('AUTH-020 — MFA-enabled user passes through require_mfa policy', async () => {
    const { user } = createUserWithMfa(testDb);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('require_mfa', 'true')").run();

    const res = await request(app).get('/api/trips').set(authHeader(user.id));
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Short-lived tokens (AUTH-029, AUTH-030)
// ─────────────────────────────────────────────────────────────────────────────

describe('Short-lived tokens', () => {
  it('AUTH-029 — POST /api/auth/ws-token returns a single-use token', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/ws-token')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
  });

  it('AUTH-030 — POST /api/auth/resource-token returns a single-use token', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/resource-token')
      .set('Cookie', authCookie(user.id))
      .send({ purpose: 'download' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extended scenarios (AUTH-031 to AUTH-033)
// ─────────────────────────────────────────────────────────────────────────────

describe('Extended auth scenarios', () => {
  it('AUTH-031 — login succeeds with uppercased email (case-insensitive lookup)', async () => {
    const { user, password } = createUser(testDb, { email: 'alice@example.com' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@EXAMPLE.COM', password });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
  });

  it('AUTH-032 — registration with duplicate username returns 409', async () => {
    createUser(testDb, { username: 'alice' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'alice2@example.com', password: 'Str0ng!Pass' });
    expect(res.status).toBe(409);
  });

  it('AUTH-033 — MFA backup code login succeeds and invalidates the used code', async () => {
    const { hashBackupCode, generateBackupCodes } = await import('../../src/services/authService');
    const { user, password } = createUserWithMfa(testDb);

    // Generate and store backup codes on the MFA-enabled user
    const backupCodes = generateBackupCodes();
    const backupHashes = backupCodes.map(hashBackupCode);
    testDb.prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ?')
      .run(JSON.stringify(backupHashes), user.id);

    // Step 1: login to get mfa_token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });
    expect(loginRes.body.mfa_required).toBe(true);
    const { mfa_token } = loginRes.body;

    // Step 2: verify with a backup code
    const res = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ mfa_token, code: backupCodes[0] });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();

    // Step 3: same backup code is now consumed — second login attempt fails
    const loginRes2 = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });
    const { mfa_token: mfa_token2 } = loginRes2.body;

    const res2 = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ mfa_token: mfa_token2, code: backupCodes[0] });
    expect(res2.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Account deletion
// ─────────────────────────────────────────────────────────────────────────────

describe('Account deletion', () => {
  it('AUTH-040 — DELETE /auth/me succeeds when user has FK references', async () => {
    const { user: admin } = createAdmin(testDb);
    const { user: target } = createUser(testDb);
    const { user: otherUser } = createUser(testDb);
    const { user: thirdUser } = createUser(testDb);

    // trip_members.invited_by: target invited thirdUser to otherUser's trip
    // (trip survives deletion; only invited_by should become NULL)
    const otherTrip = createTrip(testDb, otherUser.id);
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(otherTrip.id, thirdUser.id, target.id);

    // share_tokens.created_by: target created a share token for otherUser's trip
    testDb.prepare("INSERT INTO share_tokens (trip_id, token, created_by) VALUES (?, 'tok-auth-test', ?)").run(otherTrip.id, target.id);

    // budget_items.paid_by_user_id: target paid for an expense on otherUser's trip
    const budgetItem = createBudgetItem(testDb, otherTrip.id);
    testDb.prepare('UPDATE budget_items SET paid_by_user_id = ? WHERE id = ?').run(target.id, budgetItem.id);

    // journey_contributors: target is a contributor on otherUser's journey
    const otherJourney = createJourney(testDb, otherUser.id);
    addJourneyContributor(testDb, otherJourney.id, target.id);

    // journey_entries: target authored an entry on otherUser's journey
    createJourneyEntry(testDb, otherJourney.id, target.id);

    // journey_share_tokens: target created a share token for otherUser's journey
    testDb.prepare("INSERT INTO journey_share_tokens (journey_id, token, created_by) VALUES (?, 'jst-auth-test', ?)").run(otherJourney.id, target.id);

    // notifications.sender_id (SET NULL): target sent a notification to otherUser
    const sentNotif = testDb.prepare(
      "INSERT INTO notifications (type, scope, target, sender_id, recipient_id, title_key, text_key) VALUES ('simple', 'trip', ?, ?, ?, 'k', 'k')"
    ).run(otherTrip.id, target.id, otherUser.id);
    // notifications.recipient_id (CASCADE): otherUser sent a notification to target
    testDb.prepare(
      "INSERT INTO notifications (type, scope, target, sender_id, recipient_id, title_key, text_key) VALUES ('simple', 'trip', ?, ?, ?, 'k', 'k')"
    ).run(otherTrip.id, otherUser.id, target.id);

    // user_notice_dismissals (CASCADE): target dismissed a notice
    testDb.prepare(
      "INSERT INTO user_notice_dismissals (user_id, notice_id, dismissed_at) VALUES (?, 'test-notice', ?)"
    ).run(target.id, Date.now());

    // admin exists to ensure target (non-admin user) passes the last-admin guard
    void admin;

    const res = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', authCookie(target.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(testDb.prepare('SELECT id FROM users WHERE id = ?').get(target.id)).toBeUndefined();
    // trip_members row survives but invited_by is now NULL
    expect((testDb.prepare('SELECT invited_by FROM trip_members WHERE trip_id = ? AND user_id = ?').get(otherTrip.id, thirdUser.id) as any).invited_by).toBeNull();
    expect(testDb.prepare('SELECT id FROM share_tokens WHERE created_by = ?').get(target.id)).toBeUndefined();
    expect((testDb.prepare('SELECT paid_by_user_id FROM budget_items WHERE id = ?').get(budgetItem.id) as any).paid_by_user_id).toBeNull();
    expect(testDb.prepare('SELECT user_id FROM journey_contributors WHERE journey_id = ? AND user_id = ?').get(otherJourney.id, target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM journey_entries WHERE author_id = ?').get(target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM journey_share_tokens WHERE created_by = ?').get(target.id)).toBeUndefined();
    // sent notification survives but sender_id becomes NULL
    expect((testDb.prepare('SELECT sender_id FROM notifications WHERE id = ?').get(sentNotif.lastInsertRowid) as any).sender_id).toBeNull();
    // received notification is cascade-deleted
    expect(testDb.prepare('SELECT id FROM notifications WHERE recipient_id = ?').get(target.id)).toBeUndefined();
    // notice dismissals are cascade-deleted
    expect(testDb.prepare("SELECT user_id FROM user_notice_dismissals WHERE user_id = ? AND notice_id = 'test-notice'").get(target.id)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting (AUTH-004, AUTH-018) — placed last
// ─────────────────────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  it('AUTH-004 — login endpoint rate-limits after 10 attempts from the same IP', async () => {
    // beforeEach has cleared loginAttempts; we fill up exactly to the limit
    let lastStatus = 0;
    for (let i = 0; i <= 10; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ratelimit@example.com', password: 'wrong' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('AUTH-018 — MFA verify-login endpoint rate-limits after 5 attempts', async () => {
    let lastStatus = 0;
    for (let i = 0; i <= 5; i++) {
      const res = await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ mfa_token: 'badtoken', code: '000000' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP token management (AUTH-034 to AUTH-039)
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP token management', () => {
  it('AUTH-034 — GET /auth/mcp-tokens returns empty list initially', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .get('/api/auth/mcp-tokens')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.tokens).toEqual([]);
  });

  it('AUTH-035 — POST /auth/mcp-tokens creates a token', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/mcp-tokens')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'my-token' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token.raw_token).toBe('string');
  });

  it('AUTH-036 — POST /auth/mcp-tokens without name returns 400', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/mcp-tokens')
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it('AUTH-037 — DELETE /auth/mcp-tokens/:id deletes the token', async () => {
    const { user } = createUser(testDb);
    const createRes = await request(app)
      .post('/api/auth/mcp-tokens')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'to-delete' });
    expect(createRes.status).toBe(201);
    const tokenId = createRes.body.token.id;

    const delRes = await request(app)
      .delete(`/api/auth/mcp-tokens/${tokenId}`)
      .set('Cookie', authCookie(user.id));
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    const listRes = await request(app)
      .get('/api/auth/mcp-tokens')
      .set('Cookie', authCookie(user.id));
    expect(listRes.body.tokens).toEqual([]);
  });

  it('AUTH-038 — DELETE /auth/mcp-tokens/:id returns 404 for non-existent', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .delete('/api/auth/mcp-tokens/99999')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });

  it('AUTH-039 — unauthenticated GET /auth/mcp-tokens returns 401', async () => {
    const res = await request(app).get('/api/auth/mcp-tokens');
    expect(res.status).toBe(401);
  });
});
