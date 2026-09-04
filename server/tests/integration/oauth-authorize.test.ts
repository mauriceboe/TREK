/**
 * HTTP-level tests for GET /oauth/authorize — the MCP SDK authorizationHandler
 * wrapping TREK's OAuthServerProvider. Written as byte-level parity oracles for
 * the MCP/OAuth mount migration: they must pass identically while the handler
 * is mounted pre-init AND after it moves behind the Nest container.
 *
 * This was the one platform surface with no HTTP coverage at all —
 * trekOAuthProvider.authorize and trekClientsStore.getClient run for the first
 * time under test here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import type { INestApplication } from '@nestjs/common';
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
        getPlaceWithTags: () => null,
        canAccessTrip: () => undefined,
        isOwner: () => false,
    };
    return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
    JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
    ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
    updateJwtSecret: () => {},
    SESSION_DURATION: '24h',
    SESSION_DURATION_MS: 86400000,
    SESSION_DURATION_SECONDS: 86400,
    DEFAULT_LANGUAGE: 'en',
}));

vi.mock('../../src/app-config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/app-config')>();
    return { ...actual, getMcpSafeUrl: () => 'https://trek.example.com' };
});

vi.mock('../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));
vi.mock('../../src/mcp/sessionManager', () => ({ revokeUserSessions: vi.fn(), revokeUserSessionsForClient: vi.fn(), sessions: new Map() }));

import { buildApp } from '../../src/bootstrap';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb, resetRateLimits } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { OauthService } from '../../src/nest/oauth/oauth.service';
import { DatabaseService } from '../../src/nest/database/database.service';
import { AddonsService } from '../../src/nest/addons/addons.service';
import { AuditService } from '../../src/nest/audit/audit.service';

// The consent controller writes pending codes through the container instance;
// the SDK-mounted authorize path reads them back. The map is module-scoped in
// oauth.pending-codes.ts, so a hand-built service instance shares it — the
// same single-instance property the full auth-code loop below proves end-to-end.
const oauthDbs = new DatabaseService(testDb);
const containerSideOauth = new OauthService(oauthDbs, new AddonsService(oauthDbs), new AuditService(oauthDbs));

let nestApp: INestApplication;
let app: Application;

function makePkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function setMcpEnabled(enabled: boolean) {
    testDb.prepare(
        "INSERT OR REPLACE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES ('mcp', 'MCP', 'AI assistant integration', 'integration', 'Terminal', ?, 12)"
    ).run(enabled ? 1 : 0);
}

/** DCR-register a public client and return its client_id. */
async function registerClient(redirectUri = 'https://client.example.com/cb', scope = 'trips:read'): Promise<string> {
    const res = await request(app)
        .post('/oauth/register')
        .set('Content-Type', 'application/json')
        .send({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope });
    expect(res.status).toBe(201);
    return res.body.client_id as string;
}

beforeAll(async () => {
    createTables(testDb);
    runMigrations(testDb);
    nestApp = await buildApp();
    app = nestApp.getHttpAdapter().getInstance();
});

beforeEach(() => {
    resetTestDb(testDb);
    resetRateLimits(nestApp);
    setMcpEnabled(true);
});

afterAll(async () => {
    await nestApp.close();
    testDb.close();
});

describe('GET /oauth/authorize — SDK authorizationHandler over trekOAuthProvider', () => {
    it('AUTHZ-001 — happy path 302-redirects to the SPA consent page with the exact forwarded params', async () => {
        const clientId = await registerClient();
        const { challenge } = makePkce();

        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            state: 'st4te',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: 'https://trek.example.com/mcp',
        });

        expect(res.status).toBe(302);
        const expected = new URLSearchParams({
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'st4te',
            resource: 'https://trek.example.com/mcp',
        });
        expect(res.headers.location).toBe(`https://trek.example.com/oauth/consent?${expected.toString()}`);
    });

    it('AUTHZ-002 — omitted resource defaults to the MCP endpoint and still reaches consent', async () => {
        const clientId = await registerClient();
        const { challenge } = makePkce();

        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });

        expect(res.status).toBe(302);
        const loc = new URL(res.headers.location);
        expect(`${loc.origin}${loc.pathname}`).toBe('https://trek.example.com/oauth/consent');
        expect(loc.searchParams.get('client_id')).toBe(clientId);
        // No resource param was sent, so none is forwarded.
        expect(loc.searchParams.get('resource')).toBeNull();
        expect(loc.searchParams.get('state')).toBeNull();
    });

    it('AUTHZ-002B: a private-use scheme registers and authorizes with the byte-identical URI (#2227)', async () => {
        const redirectUri = 'workbuddy://workbuddy/mcp/connector%3A/oauth/callback';
        const clientId = await registerClient(redirectUri);
        const { challenge } = makePkce();

        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });

        expect(res.status).toBe(302);
        const loc = new URL(res.headers.location);
        expect(`${loc.origin}${loc.pathname}`).toBe('https://trek.example.com/oauth/consent');
        // Forwarded unchanged: the %3A must survive to the token exchange.
        expect(loc.searchParams.get('redirect_uri')).toBe(redirectUri);
    });

    it('AUTHZ-003 — wrong resource 302-redirects back to the client with invalid_target', async () => {
        const clientId = await registerClient();
        const { challenge } = makePkce();

        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            state: 'xyz',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: 'https://evil.example.com/other',
        });

        expect(res.status).toBe(302);
        const loc = new URL(res.headers.location);
        expect(`${loc.origin}${loc.pathname}`).toBe('https://client.example.com/cb');
        expect(loc.searchParams.get('error')).toBe('invalid_target');
        expect(loc.searchParams.get('error_description')).toBe('Requested resource must be the TREK MCP endpoint');
        expect(loc.searchParams.get('state')).toBe('xyz');
    });

    it('AUTHZ-004 — unknown client_id is a 400 invalid_client, no redirect', async () => {
        const { challenge } = makePkce();
        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: 'does-not-exist',
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client');
    });

    it('AUTHZ-005 — unregistered redirect_uri is a 400 invalid_request, no redirect', async () => {
        const clientId = await registerClient();
        const { challenge } = makePkce();
        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://attacker.example.com/cb',
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('AUTHZ-006 — missing code_challenge redirects back to the client with invalid_request', async () => {
        const clientId = await registerClient();
        const res = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
        });
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.location);
        expect(`${loc.origin}${loc.pathname}`).toBe('https://client.example.com/cb');
        expect(loc.searchParams.get('error')).toBe('invalid_request');
    });

    it('AUTHZ-007 — MCP addon off: authorize and register both 404 with empty bodies', async () => {
        setMcpEnabled(false);
        const authz = await request(app).get('/oauth/authorize').query({ client_id: 'x' });
        expect(authz.status).toBe(404);
        expect(authz.text).toBe('');

        const reg = await request(app)
            .post('/oauth/register')
            .set('Content-Type', 'application/json')
            .send({ redirect_uris: ['https://client.example.com/cb'], token_endpoint_auth_method: 'none' });
        expect(reg.status).toBe(404);
        expect(reg.text).toBe('');
    });

    it('AUTHZ-008 — full loop: register → authorize → consent-written code → token exchange', async () => {
        const { user } = createUser(testDb);
        const clientId = await registerClient();
        const { verifier, challenge } = makePkce();

        // 1. authorize forwards to consent
        const authz = await request(app).get('/oauth/authorize').query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://client.example.com/cb',
            scope: 'trips:read',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: 'https://trek.example.com/mcp',
        });
        expect(authz.status).toBe(302);

        // 2. the consent controller writes the code through the container
        //    singleton; the module-scoped pending-code map is what lets the
        //    SDK-side exchange see it.
        const code = containerSideOauth.createAuthCode({
            clientId,
            userId: user.id,
            redirectUri: 'https://client.example.com/cb',
            scopes: ['trips:read'],
            resource: 'https://trek.example.com/mcp',
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
        });
        expect(code).toBeTruthy();

        // 3. token exchange through the public token endpoint
        const token = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: 'https://client.example.com/cb',
            code_verifier: verifier,
            resource: 'https://trek.example.com/mcp',
        });
        expect(token.status).toBe(200);
        expect(token.body.access_token).toMatch(/^trekoa_/);
        expect(token.body.token_type).toBe('Bearer');
        expect(token.body.scope).toBe('trips:read');
    });
});
