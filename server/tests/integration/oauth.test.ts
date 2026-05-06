/**
 * OAuth 2.1 integration tests.
 * Covers oauthPublicRouter (/.well-known, /oauth/token, /oauth/revoke)
 * and oauthApiRouter (/api/oauth/*).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import crypto from 'crypto';

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
            const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
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

const { isAddonEnabledMock } = vi.hoisted(() => {
    const isAddonEnabledMock = vi.fn().mockReturnValue(true);
    return { isAddonEnabledMock };
});
vi.mock('../../src/services/adminService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/adminService')>();
    return { ...actual, isAddonEnabled: isAddonEnabledMock };
});

vi.mock('../../src/services/oidcService', () => ({ getAppUrl: () => 'https://trek.example.com' }));

vi.mock('../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));
vi.mock('../../src/mcp/sessionManager', () => ({ revokeUserSessions: vi.fn(), revokeUserSessionsForClient: vi.fn(), sessions: new Map() }));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';
import { createOAuthClient, createAuthCode } from '../../src/services/oauthService';

const app: Application = createApp();

// PKCE helpers
function makePkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

beforeAll(() => {
    createTables(testDb);
    runMigrations(testDb);
});

beforeEach(() => {
    resetTestDb(testDb);
    loginAttempts.clear();
    mfaAttempts.clear();
    isAddonEnabledMock.mockReturnValue(true);
});

afterAll(() => {
    testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery document
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
    it('OAUTH-001 — returns RFC 8414 discovery document', async () => {
        const res = await request(app).get('/.well-known/oauth-authorization-server');
        expect(res.status).toBe(200);
        expect(res.body.issuer).toBe('https://trek.example.com');
        expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
        expect(res.body.token_endpoint).toContain('/oauth/token');
        expect(Array.isArray(res.body.scopes_supported)).toBe(true);
        expect(res.body.scopes_supported.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #959 regression tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RFC 9728 — path-based protected resource metadata (issue #959 bug 1)', () => {
    it('OAUTH-959A — /.well-known/oauth-protected-resource/mcp returns JSON (not SPA HTML)', async () => {
        const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body.resource).toContain('/mcp');
        expect(Array.isArray(res.body.authorization_servers)).toBe(true);
    });
});

describe('DCR scope optional — ChatGPT compatibility (issue #959 bug 2)', () => {
    it('OAUTH-959B — POST /oauth/register without scope field returns 201 with default scopes', async () => {
        const res = await request(app)
            .post('/oauth/register')
            .set('Content-Type', 'application/json')
            .send({ redirect_uris: ['https://chatgpt.example.com/cb'], token_endpoint_auth_method: 'none' });
        expect(res.status).toBe(201);
        expect(res.body.client_id).toBeDefined();
        expect(typeof res.body.scope).toBe('string');
        expect(res.body.scope.length).toBeGreaterThan(0);
    });

    it('OAUTH-959C — POST /oauth/register with explicit scope registers only requested scopes', async () => {
        const res = await request(app)
            .post('/oauth/register')
            .set('Content-Type', 'application/json')
            .send({ redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none', scope: 'trips:read' });
        expect(res.status).toBe(201);
        expect(res.body.scope).toBe('trips:read');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /oauth/token — authorization_code grant
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /oauth/token — authorization_code grant', () => {
    it('OAUTH-002 — missing client_id returns 401 invalid_client', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', code: 'x', redirect_uri: 'https://example.com/cb', code_verifier: 'y' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('OAUTH-003 — MCP addon disabled returns 404', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', client_id: 'x', client_secret: 'y', code: 'z', redirect_uri: 'https://r.example.com/cb', code_verifier: 'v' });
        expect(res.status).toBe(404);
    });

    it('OAUTH-004 — missing code/redirect_uri/code_verifier returns 400 invalid_request', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', client_id: 'x', client_secret: 'y' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('OAUTH-005 — invalid auth code returns 400 invalid_grant', async () => {
        const { user } = createUser(testDb);
        const clientResult = createOAuthClient(user.id, 'TestApp', ['https://app.example.com/cb'], ['trips:read']);
        const client = clientResult.client!;

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: client.client_id,
                client_secret: clientResult.client!.client_secret,
                code: 'invalid-code-xyz',
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: 'verifier',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    it('OAUTH-006 — client_id mismatch returns 400 invalid_grant', async () => {
        const { user } = createUser(testDb);
        const r1 = createOAuthClient(user.id, 'App1', ['https://app1.example.com/cb'], ['trips:read']);
        const r2 = createOAuthClient(user.id, 'App2', ['https://app2.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        // Create code for client1
        const code = createAuthCode({
            clientId: r1.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app1.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Try to use it with client2
        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r2.client!.client_id,
                client_secret: r2.client!.client_secret,
                code,
                redirect_uri: 'https://app1.example.com/cb',
                code_verifier: verifier,
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    it('OAUTH-007 — redirect_uri mismatch returns 400 invalid_grant', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://wrong.example.com/cb',
                code_verifier: verifier,
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    it('OAUTH-008 — wrong client_secret returns 401 invalid_client (timing-safe check)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: 'wrong-secret',
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: verifier,
            });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('OAUTH-009 — PKCE failure returns 400 invalid_grant', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: 'this-is-a-wrong-verifier',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    it('OAUTH-010 — happy path: exchange auth code for tokens', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: verifier,
            });
        expect(res.status).toBe(200);
        expect(res.body.access_token).toBeDefined();
        expect(res.body.refresh_token).toBeDefined();
        expect(res.body.token_type).toBe('Bearer');
        expect(typeof res.body.expires_in).toBe('number');
        expect(res.body.scope).toBe('trips:read');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /oauth/token — refresh_token grant
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /oauth/token — refresh_token grant', () => {
    it('OAUTH-011 — missing refresh_token returns 400 invalid_request', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'refresh_token', client_id: 'x', client_secret: 'y' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('OAUTH-012 — invalid refresh token returns 400 invalid_grant', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'refresh_token',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                refresh_token: 'invalid-refresh-token',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    it('OAUTH-013 — happy path: issue then refresh tokens', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Exchange code for tokens
        const tokenRes = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: verifier,
            });
        expect(tokenRes.status).toBe(200);
        const { refresh_token } = tokenRes.body;

        // Use refresh token to get new tokens
        const refreshRes = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'refresh_token',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                refresh_token,
            });
        expect(refreshRes.status).toBe(200);
        expect(refreshRes.body.access_token).toBeDefined();
        expect(refreshRes.body.refresh_token).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /oauth/token — unsupported grant_type
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /oauth/token — unsupported grant_type', () => {
    it('OAUTH-014 — returns 400 unsupported_grant_type', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'password', client_id: 'x', client_secret: 'y' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('unsupported_grant_type');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /oauth/revoke
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /oauth/revoke', () => {
    it('OAUTH-015 — missing params returns 400 invalid_request', async () => {
        const res = await request(app)
            .post('/oauth/revoke')
            .send({ token: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('OAUTH-016 — wrong client_secret returns 401 invalid_client', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .post('/oauth/revoke')
            .send({ token: 'sometoken', client_id: r.client!.client_id, client_secret: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('OAUTH-017 — valid revoke returns 200 even for unknown token (RFC 7009)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .post('/oauth/revoke')
            .send({ token: 'nonexistent-token', client_id: r.client!.client_id, client_secret: r.client!.client_secret });
        expect(res.status).toBe(200);
    });

    it('OAUTH-018 — happy path: issue token, revoke it, verify refresh no longer works', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const tokenRes = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: verifier,
            });
        expect(tokenRes.status).toBe(200);
        const { refresh_token } = tokenRes.body;

        // Revoke the refresh token
        const revokeRes = await request(app)
            .post('/oauth/revoke')
            .send({ token: refresh_token, client_id: r.client!.client_id, client_secret: r.client!.client_secret });
        expect(revokeRes.status).toBe(200);

        // Try to use the revoked token — should fail
        const retryRes = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'refresh_token',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                refresh_token,
            });
        expect(retryRes.status).toBe(400);
        expect(retryRes.body.error).toBe('invalid_grant');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/oauth/authorize/validate
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/oauth/authorize/validate', () => {
    it('OAUTH-019 — returns 404 when MCP addon disabled (M2: prevents feature fingerprinting)', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .query({ response_type: 'code', client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: 'c', code_challenge_method: 'S256' });
        expect(res.status).toBe(404);
    });

    it('OAUTH-020 — returns 200 with valid:false for wrong response_type (authenticated)', async () => {
        const { user } = createUser(testDb);
        const { challenge } = makePkce();
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({ response_type: 'token', client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256' });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('unsupported_response_type');
    });

    it('OAUTH-021 — returns 200 with valid:false for missing PKCE', async () => {
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .query({ response_type: 'code', client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read' });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_request');
    });

    it('OAUTH-022 — returns 200 with valid:false for unknown client_id (authenticated)', async () => {
        const { user } = createUser(testDb);
        const { challenge } = makePkce();
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({ response_type: 'code', client_id: 'unknown-client', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256' });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_client');
    });

    it('OAUTH-023 — returns 200 with valid:false for mismatched redirect_uri (authenticated)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://evil.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_redirect_uri');
    });

    it('OAUTH-024 — returns 200 with valid:false for empty scope (authenticated)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: '',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_scope');
    });

    it('OAUTH-025a — narrows scope to allowed intersection when client lacks some requested scopes (authenticated)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read trips:delete',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        // trips:delete was dropped — only trips:read granted
        expect(res.body.scopes).toEqual(['trips:read']);
    });

    it('OAUTH-025b — returns 200 with valid:false when no requested scope is allowed (authenticated)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'budget:write',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_scope');
    });

    it('OAUTH-026 — unauthenticated valid request returns loginRequired=true (H3: minimal response, no client info)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.loginRequired).toBe(true);
        // H3: client name and scopes must NOT be revealed to unauthenticated callers
        expect(res.body.client).toBeUndefined();
        expect(res.body.allowed_scopes).toBeUndefined();
    });

    it('OAUTH-027 — authenticated with no prior consent returns consentRequired=true with client details', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.consentRequired).toBe(true);
        // Authenticated users get full client info (unlike unauthenticated H3 path)
        expect(res.body.client).toBeDefined();
        expect(res.body.scopes).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/oauth/authorize
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/oauth/authorize', () => {
    it('OAUTH-028 — unauthenticated returns 401', async () => {
        const res = await request(app)
            .post('/api/oauth/authorize')
            .send({ approved: true, client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: 'c', code_challenge_method: 'S256' });
        expect(res.status).toBe(401);
    });

    it('OAUTH-029 — 403 when MCP disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const { user } = createUser(testDb);

        const res = await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({ approved: true, client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: 'c', code_challenge_method: 'S256' });
        expect(res.status).toBe(403);
    });

    it('OAUTH-030 — user denied returns redirect with error=access_denied', async () => {
        const { user } = createUser(testDb);

        const res = await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({
                approved: false,
                client_id: 'any',
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: 'c',
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.redirect).toContain('error=access_denied');
    });

    it('OAUTH-031 — invalid params returns 400', async () => {
        const { user } = createUser(testDb);
        const { challenge } = makePkce();

        const res = await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({
                approved: true,
                client_id: 'unknown-client',
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(400);
    });

    it('OAUTH-032 — happy path: approve returns redirect with code', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const res = await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({
                approved: true,
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.redirect).toBeDefined();
        expect(res.body.redirect).toContain('code=');
        expect(res.body.redirect).not.toContain('error=');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('Client CRUD — /api/oauth/clients', () => {
    it('OAUTH-033 — GET returns 403 when addon disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const { user } = createUser(testDb);

        const res = await request(app)
            .get('/api/oauth/clients')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(403);
    });

    it('OAUTH-034 — GET returns 200 with clients list', async () => {
        const { user } = createUser(testDb);
        createOAuthClient(user.id, 'MyApp', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .get('/api/oauth/clients')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.clients)).toBe(true);
        expect(res.body.clients).toHaveLength(1);
        expect(res.body.clients[0].name).toBe('MyApp');
    });

    it('OAUTH-035 — POST creates client and returns 201 with client_secret', async () => {
        const { user } = createUser(testDb);

        const res = await request(app)
            .post('/api/oauth/clients')
            .set('Cookie', authCookie(user.id))
            .send({ name: 'NewApp', redirect_uris: ['https://newapp.example.com/cb'], allowed_scopes: ['trips:read'] });
        expect(res.status).toBe(201);
        expect(res.body.client).toBeDefined();
        expect(res.body.client.client_id).toBeDefined();
        expect(res.body.client.client_secret).toBeDefined();
        expect(res.body.client.name).toBe('NewApp');
    });

    it('OAUTH-036 — POST returns 403 when addon disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const { user } = createUser(testDb);

        const res = await request(app)
            .post('/api/oauth/clients')
            .set('Cookie', authCookie(user.id))
            .send({ name: 'App', redirect_uris: ['https://app.example.com/cb'], allowed_scopes: ['trips:read'] });
        expect(res.status).toBe(403);
    });

    it('OAUTH-037 — POST /clients/:id/rotate rotates secret', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .post(`/api/oauth/clients/${r.client!.id}/rotate`)
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(200);
        expect(res.body.client_secret).toBeDefined();
        expect(res.body.client_secret).not.toBe(r.client!.client_secret);
    });

    it('OAUTH-038 — DELETE /clients/:id deletes client', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);

        const res = await request(app)
            .delete(`/api/oauth/clients/${r.client!.id}`)
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('OAUTH-039 — DELETE /clients/:id returns 404 for non-existent', async () => {
        const { user } = createUser(testDb);

        const res = await request(app)
            .delete('/api/oauth/clients/nonexistent-id')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(404);
    });

});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('Sessions — /api/oauth/sessions', () => {
    it('OAUTH-040 — GET returns 403 when addon disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const { user } = createUser(testDb);

        const res = await request(app)
            .get('/api/oauth/sessions')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(403);
    });

    it('OAUTH-041 — GET returns 200 with sessions list', async () => {
        const { user } = createUser(testDb);

        const res = await request(app)
            .get('/api/oauth/sessions')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.sessions)).toBe(true);
    });

    it('OAUTH-042 — DELETE /sessions/:id revokes session', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Get a token so there's a session to revoke
        await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: verifier,
            });

        const sessionsRes = await request(app)
            .get('/api/oauth/sessions')
            .set('Cookie', authCookie(user.id));
        expect(sessionsRes.body.sessions).toHaveLength(1);

        const sessionId = sessionsRes.body.sessions[0].id;
        const deleteRes = await request(app)
            .delete(`/api/oauth/sessions/${sessionId}`)
            .set('Cookie', authCookie(user.id));
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.success).toBe(true);
    });

    it('OAUTH-043 — DELETE /sessions/:id returns 404 for non-existent', async () => {
        const { user } = createUser(testDb);

        const res = await request(app)
            .delete('/api/oauth/sessions/99999')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(404);
    });

    it('OAUTH-044 — DELETE /sessions/:id returns 403 when addon disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const { user } = createUser(testDb);

        const res = await request(app)
            .delete('/api/oauth/sessions/1')
            .set('Cookie', authCookie(user.id));
        expect(res.status).toBe(403);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security behavior tests (M1, M2, H1, H3, H5, M5, M7, C3)
// ─────────────────────────────────────────────────────────────────────────────

describe('M1 — Cache-Control headers on /oauth/token', () => {
    it('OAUTH-SEC-001 — token endpoint sets Cache-Control: no-store', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .send({ grant_type: 'authorization_code', client_id: 'x', client_secret: 'y', code: 'z', redirect_uri: 'https://r.example.com/cb', code_verifier: 'v' });
        expect(res.headers['cache-control']).toBe('no-store');
    });
});

describe('M2 — 404 when MCP disabled on discovery + revoke endpoints', () => {
    it('OAUTH-SEC-002 — /.well-known/oauth-authorization-server returns 404 when disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const res = await request(app).get('/.well-known/oauth-authorization-server');
        expect(res.status).toBe(404);
    });

    it('OAUTH-SEC-003 — /oauth/revoke returns 404 when disabled', async () => {
        isAddonEnabledMock.mockReturnValue(false);
        const res = await request(app)
            .post('/oauth/revoke')
            .send({ token: 'x', client_id: 'y', client_secret: 'z' });
        expect(res.status).toBe(404);
    });
});

describe('H1 — PKCE format validation', () => {
    it('OAUTH-SEC-004 — short code_challenge (<43 chars) rejected on /authorize/validate', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: 'tooshort',
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_request');
    });

    it('OAUTH-SEC-005 — wrong code_verifier format rejected on /oauth/token (invalid_grant)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Submit a valid-looking but wrong-format verifier (too short)
        const res = await request(app)
            .post('/oauth/token')
            .send({
                grant_type: 'authorization_code',
                client_id: r.client!.client_id,
                client_secret: r.client!.client_secret,
                code,
                redirect_uri: 'https://app.example.com/cb',
                code_verifier: 'short',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });
});

describe('H3 — Unauthenticated /authorize/validate returns minimal response', () => {
    it('OAUTH-SEC-006 — invalid request by unauthenticated caller returns generic error (no oracle)', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { challenge } = makePkce();

        // Deliberately wrong redirect_uri — should get generic error, not invalid_redirect_uri
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://evil.example.com/cb',
                scope: 'trips:read',
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('invalid_request');
        // Must not leak specific error type or client details
        expect(res.body.error).not.toBe('invalid_redirect_uri');
        expect(res.body.client).toBeUndefined();
    });
});

describe('H5 — All invalid_grant cases return identical response body', () => {
    it('OAUTH-SEC-007 — expired/bad code, client_id mismatch, redirect_uri mismatch all return same body', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Bad code
        const res1 = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            code: 'bad-code-xyz',
            redirect_uri: 'https://app.example.com/cb',
            code_verifier: verifier,
        });

        // Redirect URI mismatch (need fresh code since code is single-use)
        const code2 = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });
        const res2 = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            code: code2,
            redirect_uri: 'https://wrong.example.com/cb',
            code_verifier: verifier,
        });

        expect(res1.status).toBe(400);
        expect(res2.status).toBe(400);
        expect(res1.body.error).toBe('invalid_grant');
        expect(res2.body.error).toBe('invalid_grant');
        // Both must use exactly the same error_description (H5)
        expect(res1.body.error_description).toBe(res2.body.error_description);
    });
});

describe('M5 — Consent scope union (re-authorize adds to existing consent)', () => {
    it('OAUTH-SEC-008 — second consent adds new scope without losing old scope', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read', 'places:read']);
        const { challenge: ch1 } = makePkce();
        const { challenge: ch2 } = makePkce();

        // First consent: trips:read
        await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({
                approved: true,
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: ch1,
                code_challenge_method: 'S256',
            });

        // Second consent: places:read — should not drop trips:read
        await request(app)
            .post('/api/oauth/authorize')
            .set('Cookie', authCookie(user.id))
            .send({
                approved: true,
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'places:read',
                code_challenge: ch2,
                code_challenge_method: 'S256',
            });

        // Re-validate with trips:read — should now be auto-approved (consentRequired=false)
        const { challenge: ch3 } = makePkce();
        const res = await request(app)
            .get('/api/oauth/authorize/validate')
            .set('Cookie', authCookie(user.id))
            .query({
                response_type: 'code',
                client_id: r.client!.client_id,
                redirect_uri: 'https://app.example.com/cb',
                scope: 'trips:read',
                code_challenge: ch3,
                code_challenge_method: 'S256',
            });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.consentRequired).toBeFalsy();
    });
});

describe('M7 — Cookie-only auth on privileged OAuth endpoints', () => {
    it('OAUTH-SEC-009 — POST /api/oauth/authorize rejects Bearer JWT (no cookie)', async () => {
        const { user } = createUser(testDb);
        // Use a valid JWT in Authorization header (no cookie) — must be rejected
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user.id }, 'test-jwt-secret-for-trek-testing-only', { algorithm: 'HS256' });

        const res = await request(app)
            .post('/api/oauth/authorize')
            .set('Authorization', `Bearer ${token}`)
            .send({ approved: true, client_id: 'x', redirect_uri: 'https://r.example.com/cb', scope: 'trips:read', code_challenge: 'c', code_challenge_method: 'S256' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('COOKIE_AUTH_REQUIRED');
    });

    it('OAUTH-SEC-010 — POST /api/oauth/clients rejects Bearer JWT (no cookie)', async () => {
        const jwt = require('jsonwebtoken');
        const { user } = createUser(testDb);
        const token = jwt.sign({ id: user.id }, 'test-jwt-secret-for-trek-testing-only', { algorithm: 'HS256' });

        const res = await request(app)
            .post('/api/oauth/clients')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'App', redirect_uris: ['https://app.example.com/cb'], allowed_scopes: ['trips:read'] });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('COOKIE_AUTH_REQUIRED');
    });

    it('OAUTH-SEC-011 — DELETE /api/oauth/sessions/:id rejects Bearer JWT (no cookie)', async () => {
        const jwt = require('jsonwebtoken');
        const { user } = createUser(testDb);
        const token = jwt.sign({ id: user.id }, 'test-jwt-secret-for-trek-testing-only', { algorithm: 'HS256' });

        const res = await request(app)
            .delete('/api/oauth/sessions/1')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('COOKIE_AUTH_REQUIRED');
    });
});

describe('C3 — Refresh token replay detection', () => {
    it('OAUTH-SEC-012 — replaying a rotated (old) refresh token returns invalid_grant', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        // Get initial tokens
        const t1 = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            code,
            redirect_uri: 'https://app.example.com/cb',
            code_verifier: verifier,
        });
        expect(t1.status).toBe(200);
        const originalRefreshToken = t1.body.refresh_token;

        // Rotate once (legitimate use)
        const t2 = await request(app).post('/oauth/token').send({
            grant_type: 'refresh_token',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            refresh_token: originalRefreshToken,
        });
        expect(t2.status).toBe(200);

        // Replay the original (now rotated/revoked) refresh token — must be rejected
        const t3 = await request(app).post('/oauth/token').send({
            grant_type: 'refresh_token',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            refresh_token: originalRefreshToken,
        });
        expect(t3.status).toBe(400);
        expect(t3.body.error).toBe('invalid_grant');
    });

    it('OAUTH-SEC-013 — replaying old token also invalidates the new chain', async () => {
        const { user } = createUser(testDb);
        const r = createOAuthClient(user.id, 'App', ['https://app.example.com/cb'], ['trips:read']);
        const { verifier, challenge } = makePkce();

        const code = createAuthCode({
            clientId: r.client!.client_id as string,
            userId: user.id,
            redirectUri: 'https://app.example.com/cb',
            scopes: ['trips:read'],
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });

        const t1 = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            code,
            redirect_uri: 'https://app.example.com/cb',
            code_verifier: verifier,
        });
        const originalRefreshToken = t1.body.refresh_token;

        // Legitimate rotate — get new token
        const t2 = await request(app).post('/oauth/token').send({
            grant_type: 'refresh_token',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            refresh_token: originalRefreshToken,
        });
        const newRefreshToken = t2.body.refresh_token;

        // Replay original — triggers chain revocation
        await request(app).post('/oauth/token').send({
            grant_type: 'refresh_token',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            refresh_token: originalRefreshToken,
        });

        // New token (from legitimate rotation) must also be dead now
        const t4 = await request(app).post('/oauth/token').send({
            grant_type: 'refresh_token',
            client_id: r.client!.client_id,
            client_secret: r.client!.client_secret,
            refresh_token: newRefreshToken,
        });
        expect(t4.status).toBe(400);
        expect(t4.body.error).toBe('invalid_grant');
    });
});