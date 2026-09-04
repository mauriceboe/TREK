/**
 * Unit tests for the OAuth 2.1 domain service.
 *
 * Moved 1:1 from tests/unit/services/oauthService.test.ts with the fold — the
 * cases and their names are unchanged; the free-function imports became
 * methods bound to a hand-constructed OauthService (the repo's DB-backed
 * service-test shape). The delegation cases of the old thin wrapper died with
 * it; mcpEnabled/mcpSafeUrl, the module metadata and the bridge seam are
 * pinned at the bottom.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
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
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  encrypt_api_key: (v: string) => v,
  decrypt_api_key: (v: string) => v,
  maybe_encrypt_api_key: (v: string) => v,
}));
vi.mock('../../../src/mcp/sessionManager', () => ({ revokeUserSessions: vi.fn(), revokeUserSessionsForClient: vi.fn(), sessions: new Map() }));
import { revokeUserSessionsForClient } from '../../../src/mcp/sessionManager';
vi.mock('../../../src/demo/demo-reset', () => ({ saveBaseline: vi.fn() }));

const { isAddonEnabled } = vi.hoisted(() => ({ isAddonEnabled: vi.fn().mockReturnValue(true) }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
// PKCE helper — generates a valid code_verifier + code_challenge pair (RFC 7636)
function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');   // 43 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); // 43 chars
  return { verifier, challenge };
}

import { OauthService } from '../../../src/nest/oauth/oauth.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { AuditService } from '../../../src/nest/audit/audit.service';
import type { AddonsService } from '../../../src/nest/addons/addons.service';
import { getMcpSafeUrl } from '../../../src/app-config';
import { ADDON_IDS } from '../../../src/addons';
import { MAX_PENDING_CODES, sweepPendingCodes } from '../../../src/nest/oauth/oauth.pending-codes';

const dbs = new DatabaseService(testDb);
// Stubbed rather than real: every case drives the MCP gate through this one
// flag, exactly as the addons.bridge mock did before the fold.
const addonsStub = { isAddonEnabled } as unknown as AddonsService;
const svc = new OauthService(dbs, addonsStub, new AuditService(dbs));

// Legacy free-function names bound to the service, so the moved cases below read
// exactly as they did before the fold.
const createOAuthClient = svc.createOAuthClient.bind(svc);
const listOAuthClients = svc.listOAuthClients.bind(svc);
const deleteOAuthClient = svc.deleteOAuthClient.bind(svc);
const rotateOAuthClientSecret = svc.rotateOAuthClientSecret.bind(svc);
const createAuthCode = svc.createAuthCode.bind(svc);
const consumeAuthCode = svc.consumeAuthCode.bind(svc);
const issueTokens = svc.issueTokens.bind(svc);
const getUserByAccessToken = svc.getUserByAccessToken.bind(svc);
const refreshTokens = svc.refreshTokens.bind(svc);
const revokeToken = svc.revokeToken.bind(svc);
const listOAuthSessions = svc.listOAuthSessions.bind(svc);
const revokeSession = svc.revokeSession.bind(svc);
const validateAuthorizeRequest = svc.validateAuthorizeRequest.bind(svc);
const verifyPKCE = svc.verifyPKCE.bind(svc);
const authenticateClient = svc.authenticateClient.bind(svc);
const saveConsent = svc.saveConsent.bind(svc);
const getConsent = svc.getConsent.bind(svc);
const isConsentSufficient = svc.isConsentSufficient.bind(svc);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  // Clear oauth tables manually since they're not in the standard reset list
  testDb.exec('DELETE FROM oauth_tokens');
  testDb.exec('DELETE FROM oauth_consents');
  testDb.exec('DELETE FROM oauth_clients');
  isAddonEnabled.mockReturnValue(true);
});

afterAll(() => {
  testDb.close();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeClient(
  userId: number,
  overrides: Partial<{ name: string; redirectUris: string[]; scopes: string[] }> = {}
) {
  return createOAuthClient(
    userId,
    overrides.name ?? 'Test Client',
    overrides.redirectUris ?? ['https://example.com/callback'],
    overrides.scopes ?? ['trips:read'],
  );
}

// ---------------------------------------------------------------------------
// createOAuthClient
// ---------------------------------------------------------------------------

describe('createOAuthClient', () => {
  it('creates a client successfully and returns client_secret only on creation', () => {
    const { user } = createUser(testDb);
    const result = makeClient(user.id);
    expect(result.error).toBeUndefined();
    expect(result.client).toBeDefined();
    expect(typeof result.client!.client_secret).toBe('string');
    expect((result.client!.client_secret as string).startsWith('trekcs_')).toBe(true);
  });

  it('client_id is a UUID', () => {
    const { user } = createUser(testDb);
    const result = makeClient(user.id);
    expect(result.client!.client_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('returns 400 error if name is empty', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, '', ['https://example.com/cb'], ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Name');
  });

  it('returns 400 error if name exceeds 100 characters', () => {
    const { user } = createUser(testDb);
    const longName = 'A'.repeat(101);
    const result = createOAuthClient(user.id, longName, ['https://example.com/cb'], ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('100');
  });

  it('returns 400 error if no redirect URIs provided', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', [], ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('redirect URI');
  });

  it('returns 400 error if more than 10 redirect URIs provided', () => {
    const { user } = createUser(testDb);
    const uris = Array.from({ length: 11 }, (_, i) => `https://example${i}.com/cb`);
    const result = createOAuthClient(user.id, 'Test', uris, ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('10');
  });

  it('returns 400 error for invalid URI format', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['not-a-url'], ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Invalid redirect URI');
  });

  it('returns 400 error for non-https URI (not localhost)', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['http://example.com/cb'], ['trips:read']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('HTTPS');
  });

  it('allows http://localhost redirect URI', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['http://localhost:3000/callback'], ['trips:read']);
    expect(result.error).toBeUndefined();
    expect(result.client).toBeDefined();
  });

  it('allows http://127.0.0.1 redirect URI', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['http://127.0.0.1:5000/callback'], ['trips:read']);
    expect(result.error).toBeUndefined();
    expect(result.client).toBeDefined();
  });

  it('allows the http://[::1] loopback redirect URI (#2227)', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['http://[::1]:8080/callback'], ['trips:read']);
    expect(result.error).toBeUndefined();
    expect(result.client).toBeDefined();
  });

  it('allows a private-use custom scheme (#2227)', () => {
    const { user } = createUser(testDb);
    const uri = 'workbuddy://workbuddy/mcp/connector%3A/oauth/callback';
    const result = createOAuthClient(user.id, 'Test', [uri], ['trips:read']);
    expect(result.error).toBeUndefined();
    // The stored value must round-trip untouched: the whole authorize/token
    // chain compares it byte for byte.
    expect(result.client!.redirect_uris).toEqual([uri]);
  });

  it('rejects dangerous schemes that a localhost host used to smuggle through (#2227)', () => {
    const { user } = createUser(testDb);
    for (const uri of ['javascript://localhost/%0aalert(1)', 'blob://localhost/x', 'about://localhost/x']) {
      const result = createOAuthClient(user.id, 'Test', [uri], ['trips:read']);
      expect(result.status).toBe(400);
      expect(result.error).toContain('Dangerous');
    }
  });

  it('rejects non-navigable schemes on a localhost host (#2227)', () => {
    const { user } = createUser(testDb);
    for (const uri of ['ftp://localhost/x', 'wss://localhost/x']) {
      const result = createOAuthClient(user.id, 'Test', [uri], ['trips:read']);
      expect(result.status).toBe(400);
      expect(result.error).toContain('HTTPS');
    }
  });

  it('returns 400 error if no scopes provided', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['https://example.com/cb'], []);
    expect(result.status).toBe(400);
    expect(result.error).toContain('scope');
  });

  it('returns 400 error for invalid scopes', () => {
    const { user } = createUser(testDb);
    const result = createOAuthClient(user.id, 'Test', ['https://example.com/cb'], ['invalid:scope']);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Invalid scopes');
  });

  it('enforces max 10 clients per user', () => {
    const { user } = createUser(testDb);
    for (let i = 0; i < 10; i++) {
      const r = makeClient(user.id, { name: `Client ${i}` });
      expect(r.error).toBeUndefined();
    }
    const eleventh = makeClient(user.id, { name: 'Eleventh' });
    expect(eleventh.status).toBe(400);
    expect(eleventh.error).toContain('10');
  });
});

// ---------------------------------------------------------------------------
// listOAuthClients
// ---------------------------------------------------------------------------

describe('listOAuthClients', () => {
  it('returns empty array for user with no clients', () => {
    const { user } = createUser(testDb);
    expect(listOAuthClients(user.id)).toEqual([]);
  });

  it('returns created clients with redirect_uris and allowed_scopes as arrays', () => {
    const { user } = createUser(testDb);
    makeClient(user.id, { name: 'Client A', redirectUris: ['https://a.com/cb'], scopes: ['trips:read', 'budget:read'] });
    const clients = listOAuthClients(user.id);
    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe('Client A');
    expect(Array.isArray(clients[0].redirect_uris)).toBe(true);
    expect(Array.isArray(clients[0].allowed_scopes)).toBe(true);
    expect(clients[0].allowed_scopes).toContain('trips:read');
  });
});

// ---------------------------------------------------------------------------
// deleteOAuthClient
// ---------------------------------------------------------------------------

describe('deleteOAuthClient', () => {
  it('deletes own client successfully', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientRowId = created.client!.id as string;
    const result = deleteOAuthClient(user.id, clientRowId);
    expect(result.success).toBe(true);
    expect(listOAuthClients(user.id)).toHaveLength(0);
  });

  it('returns 404 for non-existent client', () => {
    const { user } = createUser(testDb);
    const result = deleteOAuthClient(user.id, 'non-existent-id');
    expect(result.status).toBe(404);
  });

  it("returns 404 for another user's client", () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const created = makeClient(owner.id);
    const result = deleteOAuthClient(other.id, created.client!.id as string);
    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// rotateOAuthClientSecret
// ---------------------------------------------------------------------------

describe('rotateOAuthClientSecret', () => {
  it('rotates secret and returns new client_secret starting with trekcs_', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const oldSecret = created.client!.client_secret as string;
    const result = rotateOAuthClientSecret(user.id, created.client!.id as string);
    expect(result.error).toBeUndefined();
    expect(result.client_secret).toBeDefined();
    expect((result.client_secret as string).startsWith('trekcs_')).toBe(true);
    expect(result.client_secret).not.toBe(oldSecret);
  });

  it('returns 404 for non-existent client', () => {
    const { user } = createUser(testDb);
    const result = rotateOAuthClientSecret(user.id, 'non-existent-id');
    expect(result.status).toBe(404);
  });

  it('revokes old tokens after rotation', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const { access_token } = issueTokens(clientId, user.id, ['trips:read']);
    expect(getUserByAccessToken(access_token)).not.toBeNull();

    rotateOAuthClientSecret(user.id, created.client!.id as string);

    expect(getUserByAccessToken(access_token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAuthCode + consumeAuthCode
// ---------------------------------------------------------------------------

describe('createAuthCode + consumeAuthCode', () => {
  it('create code and consume it once returns the pending entry', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const code = createAuthCode({
      clientId,
      userId: user.id,
      redirectUri: 'https://example.com/callback',
      scopes: ['trips:read'],
      codeChallenge: 'abc123',
      codeChallengeMethod: 'S256',
    });

    const entry = consumeAuthCode(code);
    expect(entry).not.toBeNull();
    expect(entry!.userId).toBe(user.id);
    expect(entry!.clientId).toBe(clientId);
  });

  it('returns null for non-existent code', () => {
    expect(consumeAuthCode('does-not-exist')).toBeNull();
  });

  it('consuming same code twice returns null (one-time use)', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const code = createAuthCode({
      clientId,
      userId: user.id,
      redirectUri: 'https://example.com/callback',
      scopes: ['trips:read'],
      codeChallenge: 'abc123',
      codeChallengeMethod: 'S256',
    });

    consumeAuthCode(code);
    expect(consumeAuthCode(code)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// issueTokens + getUserByAccessToken
// ---------------------------------------------------------------------------

describe('issueTokens + getUserByAccessToken', () => {
  it('issues tokens with correct prefixes', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const tokens = issueTokens(clientId, user.id, ['trips:read']);
    expect(tokens.access_token.startsWith('trekoa_')).toBe(true);
    expect(tokens.refresh_token.startsWith('trekrf_')).toBe(true);
    expect(tokens.token_type).toBe('Bearer');
    expect(typeof tokens.expires_in).toBe('number');
  });

  it('getUserByAccessToken returns user and scopes for a valid token', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { access_token } = issueTokens(clientId, user.id, ['trips:read', 'budget:write']);
    const info = getUserByAccessToken(access_token);
    expect(info).not.toBeNull();
    expect(info!.user.email).toBe(user.email);
    expect(info!.scopes).toContain('trips:read');
    expect(info!.scopes).toContain('budget:write');
  });

  it('getUserByAccessToken returns null for unknown token', () => {
    expect(getUserByAccessToken('trekoa_unknown')).toBeNull();
  });

  it('getUserByAccessToken returns null for revoked token', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { access_token } = issueTokens(clientId, user.id, ['trips:read']);
    revokeToken(access_token, clientId);
    expect(getUserByAccessToken(access_token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// refreshTokens
// ---------------------------------------------------------------------------

describe('refreshTokens', () => {
  it('exchanges a refresh token for a new token pair', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const { refresh_token } = issueTokens(clientId, user.id, ['trips:read']);
    const result = refreshTokens(refresh_token, clientId, rawSecret);
    expect(result.error).toBeUndefined();
    expect(result.tokens).toBeDefined();
    expect(result.tokens!.access_token.startsWith('trekoa_')).toBe(true);
  });

  it('old tokens are revoked after refresh (rotation)', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const { access_token, refresh_token } = issueTokens(clientId, user.id, ['trips:read']);
    refreshTokens(refresh_token, clientId, rawSecret);
    expect(getUserByAccessToken(access_token)).toBeNull();
  });

  it('does not revoke the active MCP session on a normal (non-replayed) refresh (#1475)', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const { refresh_token } = issueTokens(clientId, user.id, ['trips:read']);
    const callsBefore = vi.mocked(revokeUserSessionsForClient).mock.calls.length;
    const result = refreshTokens(refresh_token, clientId, rawSecret);
    expect(result.error).toBeUndefined();
    expect(vi.mocked(revokeUserSessionsForClient).mock.calls.length).toBe(callsBefore);
  });

  it('returns invalid_grant for unknown refresh token', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const result = refreshTokens('trekrf_unknown', clientId, rawSecret);
    expect(result.error).toBe('invalid_grant');
    expect(result.status).toBe(400);
  });

  it('returns invalid_grant for revoked token', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const { access_token, refresh_token } = issueTokens(clientId, user.id, ['trips:read']);
    revokeToken(access_token, clientId);
    const result = refreshTokens(refresh_token, clientId, rawSecret);
    expect(result.error).toBe('invalid_grant');
  });

  it('returns invalid_client for wrong client_secret', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { refresh_token } = issueTokens(clientId, user.id, ['trips:read']);
    const result = refreshTokens(refresh_token, clientId, 'wrong-secret');
    expect(result.error).toBe('invalid_client');
    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// revokeToken
// ---------------------------------------------------------------------------

describe('revokeToken', () => {
  it('after revoking access token, getUserByAccessToken returns null', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { access_token } = issueTokens(clientId, user.id, ['trips:read']);
    expect(getUserByAccessToken(access_token)).not.toBeNull();

    revokeToken(access_token, clientId);
    expect(getUserByAccessToken(access_token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listOAuthSessions + revokeSession
// ---------------------------------------------------------------------------

describe('listOAuthSessions + revokeSession', () => {
  it('lists active sessions', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    issueTokens(clientId, user.id, ['trips:read']);
    const sessions = listOAuthSessions(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].client_id).toBe(clientId);
  });

  it('revoked session is not listed', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { access_token } = issueTokens(clientId, user.id, ['trips:read']);
    revokeToken(access_token, clientId);
    const sessions = listOAuthSessions(user.id);
    expect(sessions).toHaveLength(0);
  });

  it('revokeSession returns 404 for unknown session', () => {
    const { user } = createUser(testDb);
    const result = revokeSession(user.id, 99999);
    expect(result.status).toBe(404);
  });

  it('revokeSession by session id removes session from list', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    issueTokens(clientId, user.id, ['trips:read']);
    const sessions = listOAuthSessions(user.id);
    const sessionId = sessions[0].id as number;

    const result = revokeSession(user.id, sessionId);
    expect(result.success).toBe(true);
    expect(listOAuthSessions(user.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateAuthorizeRequest
// ---------------------------------------------------------------------------

describe('validateAuthorizeRequest', () => {
  // Use a proper 43-char S256 code_challenge to pass H1 format validation
  const { challenge: VALID_CHALLENGE } = makePkce();

  function makeParams(overrides: Partial<{
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
  }> = {}) {
    return {
      response_type: 'code',
      client_id: '',
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
      ...overrides,
    };
  }

  it('returns mcp_disabled when isAddonEnabled returns false', () => {
    vi.mocked(isAddonEnabled).mockReturnValue(false);
    const result = validateAuthorizeRequest(makeParams({ client_id: 'x' }), null);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('mcp_disabled');
  });

  it('requires response_type=code', () => {
    const { user } = createUser(testDb);
    const result = validateAuthorizeRequest(makeParams({ response_type: 'token', client_id: 'x' }), user.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('unsupported_response_type');
  });

  it('requires PKCE with S256', () => {
    const { user } = createUser(testDb);
    const result = validateAuthorizeRequest(makeParams({ client_id: 'x', code_challenge_method: 'plain' }), user.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_request');
  });

  it('requires valid client_id', () => {
    const { user } = createUser(testDb);
    const result = validateAuthorizeRequest(makeParams({ client_id: 'nonexistent' }), user.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_client');
  });

  it('validates redirect_uri against registered URIs', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { redirectUris: ['https://example.com/callback'] });
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(
      makeParams({ client_id: clientId, redirect_uri: 'https://evil.com/callback' }),
      user.id
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_redirect_uri');
  });

  it('accepts a loopback redirect on the port the OS handed the client (#2227)', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { redirectUris: ['http://[::1]:8080/oauth/callback'] });
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(
      makeParams({ client_id: clientId, redirect_uri: 'http://[::1]:54321/oauth/callback' }),
      user.id
    );
    expect(result.valid).toBe(true);
  });

  it('relaxes only the port of a loopback redirect, never the path (#2227)', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { redirectUris: ['http://127.0.0.1:8080/oauth/callback'] });
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(
      makeParams({ client_id: clientId, redirect_uri: 'http://127.0.0.1:54321/stolen' }),
      user.id
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_redirect_uri');
  });

  it('validates scope against client allowed_scopes', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { scopes: ['trips:read'] });
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(
      makeParams({ client_id: clientId, scope: 'budget:write' }),
      user.id
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_scope');
  });

  it('returns loginRequired when userId is null', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(makeParams({ client_id: clientId }), null);
    expect(result.valid).toBe(true);
    expect(result.loginRequired).toBe(true);
  });

  it('returns consentRequired=true when consent not yet saved', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest(makeParams({ client_id: clientId }), user.id);
    expect(result.valid).toBe(true);
    expect(result.consentRequired).toBe(true);
  });

  it('returns consentRequired=false when consent already saved and sufficient', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    saveConsent(clientId, user.id, ['trips:read']);
    const result = validateAuthorizeRequest(makeParams({ client_id: clientId }), user.id);
    expect(result.valid).toBe(true);
    expect(result.consentRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyPKCE
// ---------------------------------------------------------------------------

describe('verifyPKCE', () => {
  it('returns true for valid code_verifier / code_challenge pair (SHA256 base64url)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });

  it('returns false for wrong verifier', () => {
    const verifier = 'correct-verifier';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPKCE('wrong-verifier', challenge)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authenticateClient
// ---------------------------------------------------------------------------

describe('authenticateClient', () => {
  it('returns client row for correct credentials', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const client = authenticateClient(clientId, rawSecret);
    expect(client).not.toBeNull();
    expect(client!.client_id).toBe(clientId);
  });

  it('returns null for wrong secret', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    expect(authenticateClient(clientId, 'wrong-secret')).toBeNull();
  });

  it('returns null for unknown client_id', () => {
    expect(authenticateClient('unknown-client-id', 'any-secret')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveConsent + getConsent + isConsentSufficient
// ---------------------------------------------------------------------------

describe('saveConsent + getConsent + isConsentSufficient', () => {
  it('saves and retrieves consent', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    saveConsent(clientId, user.id, ['trips:read', 'budget:write']);
    const consent = getConsent(clientId, user.id);
    expect(consent).not.toBeNull();
    expect(consent).toContain('trips:read');
    expect(consent).toContain('budget:write');
  });

  it('isConsentSufficient returns true when all requested scopes are in existing', () => {
    expect(isConsentSufficient(['trips:read', 'budget:write'], ['trips:read'])).toBe(true);
    expect(isConsentSufficient(['trips:read', 'budget:write'], ['trips:read', 'budget:write'])).toBe(true);
  });

  it('isConsentSufficient returns false when some scopes are missing', () => {
    expect(isConsentSufficient(['trips:read'], ['trips:read', 'budget:write'])).toBe(false);
    expect(isConsentSufficient([], ['trips:read'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M5 — saveConsent unions instead of replacing
// ---------------------------------------------------------------------------

describe('saveConsent — scope union (M5)', () => {
  it('unioning scopes: approving B after A leaves both in consent', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { scopes: ['trips:read', 'budget:write'] });
    const clientId = created.client!.client_id as string;

    saveConsent(clientId, user.id, ['trips:read']);
    saveConsent(clientId, user.id, ['budget:write']);

    const consent = getConsent(clientId, user.id);
    expect(consent).toContain('trips:read');
    expect(consent).toContain('budget:write');
  });

  it('re-approving a superset scope still preserves previously-consented scopes', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { scopes: ['trips:read', 'trips:write'] });
    const clientId = created.client!.client_id as string;

    saveConsent(clientId, user.id, ['trips:read', 'trips:write']);
    // approve only trips:read on a later request
    saveConsent(clientId, user.id, ['trips:read']);

    const consent = getConsent(clientId, user.id);
    // trips:write should NOT be removed (union semantics)
    expect(consent).toContain('trips:read');
    expect(consent).toContain('trips:write');
  });

  it('consent is sufficient after sequential approvals — no re-prompt needed', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id, { scopes: ['trips:read', 'budget:write'] });
    const clientId = created.client!.client_id as string;

    saveConsent(clientId, user.id, ['trips:read']);
    saveConsent(clientId, user.id, ['budget:write']);

    // Should not require consent again for either scope
    expect(isConsentSufficient(getConsent(clientId, user.id)!, ['trips:read'])).toBe(true);
    expect(isConsentSufficient(getConsent(clientId, user.id)!, ['budget:write'])).toBe(true);
    expect(isConsentSufficient(getConsent(clientId, user.id)!, ['trips:read', 'budget:write'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C2 — getUserByAccessToken returns clientId
// ---------------------------------------------------------------------------

describe('getUserByAccessToken — includes clientId (C2)', () => {
  it('returns clientId matching the issuing OAuth client', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const { access_token } = issueTokens(clientId, user.id, ['trips:read']);
    const info = getUserByAccessToken(access_token);
    expect(info).not.toBeNull();
    expect(info!.clientId).toBe(clientId);
  });
});

// ---------------------------------------------------------------------------
// C3 — Refresh token replay detection and chain revocation
// ---------------------------------------------------------------------------

/**
 * Push a token's rotation out of the concurrency grace window (#1007), so the
 * replay cases below still describe theft — a token used minutes later — rather
 * than two clients racing.
 */
function agePastGrace(rawRefreshToken: string) {
  const hash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  testDb.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE refresh_token_hash = ?').run(old, hash);
}

describe('refreshTokens — replay detection (C3)', () => {
  it('replaying a revoked refresh token returns invalid_grant', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    // Issue tokens, then rotate once (old token becomes revoked)
    const { refresh_token: firstRefresh } = issueTokens(clientId, user.id, ['trips:read']);
    const rotateResult = refreshTokens(firstRefresh, clientId, rawSecret);
    expect(rotateResult.error).toBeUndefined();
    const { refresh_token: secondRefresh } = rotateResult.tokens!;

    // Replay the FIRST (now revoked) refresh token, long enough after the
    // rotation that it cannot be a concurrent refresh.
    agePastGrace(firstRefresh);
    const callsBefore = vi.mocked(revokeUserSessionsForClient).mock.calls.length;
    const replayResult = refreshTokens(firstRefresh, clientId, rawSecret);
    expect(replayResult.error).toBe('invalid_grant');
    expect(replayResult.status).toBe(400);
    // Replay IS a security event — sessions must still be torn down here.
    expect(vi.mocked(revokeUserSessionsForClient).mock.calls.length).toBe(callsBefore + 1);
    expect(vi.mocked(revokeUserSessionsForClient)).toHaveBeenLastCalledWith(user.id, clientId);
  });

  it('replaying a revoked token also revokes the entire rotation chain', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    // Issue → rotate once
    const { refresh_token: first } = issueTokens(clientId, user.id, ['trips:read']);
    const r1 = refreshTokens(first, clientId, rawSecret);
    const { access_token: access2, refresh_token: second } = r1.tokens!;

    // Replay first (revoked) refresh token → chain revoke
    agePastGrace(first);
    refreshTokens(first, clientId, rawSecret);

    // The rotated access token should also be dead now
    expect(getUserByAccessToken(access2)).toBeNull();

    // The second refresh token should also be revoked
    const r2 = refreshTokens(second, clientId, rawSecret);
    expect(r2.error).toBe('invalid_grant');
  });

  it('new rotation chain after replay is independent', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const rawSecret = created.client!.client_secret as string;

    const { refresh_token: first } = issueTokens(clientId, user.id, ['trips:read']);
    // Rotate once
    const r1 = refreshTokens(first, clientId, rawSecret);
    const { refresh_token: second } = r1.tokens!;
    // Rotate again on the second token
    const r2 = refreshTokens(second, clientId, rawSecret);
    expect(r2.error).toBeUndefined();
    const { refresh_token: third } = r2.tokens!;

    // Replay the first revoked token → revokes chain containing first+second+third
    agePastGrace(first);
    refreshTokens(first, clientId, rawSecret);

    // third should now be revoked too (it's in the same chain)
    const r3 = refreshTokens(third, clientId, rawSecret);
    expect(r3.error).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// #1007 — Concurrent rotation is not a replay
// ---------------------------------------------------------------------------

describe('refreshTokens — concurrent rotation grace (#1007)', () => {
  const setup = () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    return {
      user,
      clientId: created.client!.client_id as string,
      rawSecret: created.client!.client_secret as string,
    };
  };

  it('OAUTH-GRACE-001: two clients refreshing the same token both get tokens', () => {
    const { user, clientId, rawSecret } = setup();
    const { refresh_token: shared } = issueTokens(clientId, user.id, ['trips:read']);

    const first = refreshTokens(shared, clientId, rawSecret);
    const callsBefore = vi.mocked(revokeUserSessionsForClient).mock.calls.length;
    const second = refreshTokens(shared, clientId, rawSecret);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.tokens!.refresh_token).not.toBe(first.tokens!.refresh_token);
    // The whole point: no chain revocation, no torn-down MCP sessions, no login window.
    expect(vi.mocked(revokeUserSessionsForClient).mock.calls.length).toBe(callsBefore);
    expect(getUserByAccessToken(first.tokens!.access_token)).not.toBeNull();
    expect(getUserByAccessToken(second.tokens!.access_token)).not.toBeNull();
  });

  it('OAUTH-GRACE-002: both successors keep working afterwards', () => {
    const { user, clientId, rawSecret } = setup();
    const { refresh_token: shared } = issueTokens(clientId, user.id, ['trips:read']);
    const a = refreshTokens(shared, clientId, rawSecret).tokens!;
    const b = refreshTokens(shared, clientId, rawSecret).tokens!;

    expect(refreshTokens(a.refresh_token, clientId, rawSecret).error).toBeUndefined();
    expect(refreshTokens(b.refresh_token, clientId, rawSecret).error).toBeUndefined();
  });

  it('OAUTH-GRACE-003: the same token replayed after the window is still theft', () => {
    const { user, clientId, rawSecret } = setup();
    const { refresh_token: shared } = issueTokens(clientId, user.id, ['trips:read']);
    const rotated = refreshTokens(shared, clientId, rawSecret).tokens!;

    agePastGrace(shared);
    const replay = refreshTokens(shared, clientId, rawSecret);

    expect(replay.error).toBe('invalid_grant');
    expect(refreshTokens(rotated.refresh_token, clientId, rawSecret).error).toBe('invalid_grant');
  });

  it('OAUTH-GRACE-004: a token revoked by logout is not re-opened by the window', () => {
    const { user, clientId, rawSecret } = setup();
    const { refresh_token: shared } = issueTokens(clientId, user.id, ['trips:read']);

    // Explicit revocation leaves no successor, so there is nothing to be
    // concurrent with — the grace must not resurrect it.
    revokeToken(shared, clientId, user.id);
    const result = refreshTokens(shared, clientId, rawSecret);

    expect(result.error).toBe('invalid_grant');
  });

  it('OAUTH-GRACE-005: a chain killed by a real replay stays dead inside the window', () => {
    const { user, clientId, rawSecret } = setup();
    const { refresh_token: first } = issueTokens(clientId, user.id, ['trips:read']);
    const second = refreshTokens(first, clientId, rawSecret).tokens!;

    // Real theft: the first token turns up again once the window has passed.
    agePastGrace(first);
    expect(refreshTokens(first, clientId, rawSecret).error).toBe('invalid_grant');

    // The successor was revoked with the chain, so presenting it now must not
    // find a live child and slip through as "concurrent".
    expect(refreshTokens(second.refresh_token, clientId, rawSecret).error).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// H1 — PKCE code_challenge / code_verifier format validation
// ---------------------------------------------------------------------------

describe('verifyPKCE — format validation (H1)', () => {
  it('returns false for a code_verifier that is too short (< 43 chars)', () => {
    const { challenge } = makePkce();
    expect(verifyPKCE('short', challenge)).toBe(false);
  });

  it('returns false for a code_verifier that is too long (> 128 chars)', () => {
    const { challenge } = makePkce();
    const longVerifier = 'a'.repeat(129);
    expect(verifyPKCE(longVerifier, challenge)).toBe(false);
  });

  it('returns false for a code_verifier with invalid characters', () => {
    const { challenge } = makePkce();
    const badVerifier = 'A'.repeat(42) + ' '; // space is not allowed
    expect(verifyPKCE(badVerifier, challenge)).toBe(false);
  });

  it('returns true for a valid 43-char verifier matching its challenge', () => {
    const { verifier, challenge } = makePkce();
    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });
});

describe('validateAuthorizeRequest — PKCE format (H1)', () => {
  it('returns invalid_request when code_challenge is shorter than 43 chars', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    const result = validateAuthorizeRequest({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: 'tooshort',
      code_challenge_method: 'S256',
    }, user.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_request');
  });

  it('returns invalid_request when code_challenge contains invalid characters', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;

    // 43 chars but includes '=' which is not base64url
    const badChallenge = '='.repeat(43);
    const result = validateAuthorizeRequest({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: badChallenge,
      code_challenge_method: 'S256',
    }, user.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_request');
  });
});

// ---------------------------------------------------------------------------
// H3 — validateAuthorizeRequest: loginRequired response strips client info
// ---------------------------------------------------------------------------

describe('validateAuthorizeRequest — unauthenticated strips client info (H3)', () => {
  it('loginRequired response does not include client.name or allowed_scopes', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = created.client!.client_id as string;
    const { challenge } = makePkce();

    const result = validateAuthorizeRequest({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }, null /* unauthenticated */);

    expect(result.valid).toBe(true);
    expect(result.loginRequired).toBe(true);
    // Must NOT expose client metadata to unauthenticated callers
    expect(result.client).toBeUndefined();
    expect(result.scopes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wrapper surface that survived the fold, plus the branches the legacy suite
// never reached (they were free functions nobody could drive in isolation).
// ---------------------------------------------------------------------------

describe('addon gate and MCP endpoint', () => {
  it('mcpEnabled checks the MCP addon flag', () => {
    isAddonEnabled.mockReturnValue(true);
    expect(svc.mcpEnabled()).toBe(true);
    expect(isAddonEnabled).toHaveBeenCalledWith(ADDON_IDS.MCP);
    isAddonEnabled.mockReturnValue(false);
    expect(svc.mcpEnabled()).toBe(false);
  });

  it('mcpSafeUrl forwards to the app-config helper', () => {
    expect(svc.mcpSafeUrl()).toBe(getMcpSafeUrl());
  });
});

describe('pending-code store', () => {
  const codeParams = {
    clientId: 'c',
    userId: 42,
    redirectUri: 'https://example.com/callback',
    scopes: ['trips:read'],
    resource: null,
    codeChallenge: 'x',
    codeChallengeMethod: 'S256' as const,
  };

  it('refuses a new code at capacity and the sweep frees it again', () => {
    for (let i = 0; i < MAX_PENDING_CODES; i++) createAuthCode(codeParams);

    expect(createAuthCode(codeParams)).toBeNull();

    // Everything in the store is past its 2-minute TTL by then.
    sweepPendingCodes(Date.now() + 3 * 60 * 1000);

    const afterSweep = createAuthCode(codeParams);
    expect(afterSweep).not.toBeNull();
    sweepPendingCodes(Date.now() + 3 * 60 * 1000);
  });

  it('a code past its TTL is consumed as invalid', () => {
    const code = createAuthCode(codeParams)!;
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    try {
      expect(consumeAuthCode(code)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('branches the legacy suite could not reach', () => {
  it('rejects an expired access token', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = (created.client as { client_id: string }).client_id;
    const tokens = issueTokens(clientId, user.id, ['trips:read']);
    testDb.prepare("UPDATE oauth_tokens SET access_token_expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(getUserByAccessToken(tokens.access_token)).toBeNull();
  });

  it('refreshTokens rejects an unknown client before touching the token', () => {
    expect(refreshTokens('trekrf_whatever', 'no-such-client', 'secret')).toEqual({ error: 'invalid_client', status: 401 });
  });

  it('refreshTokens skips the secret check for a public client', () => {
    const { user } = createUser(testDb);
    const created = createOAuthClient(user.id, 'Public', ['https://example.com/callback'], ['trips:read'], null, { isPublic: true });
    const clientId = (created.client as { client_id: string }).client_id;
    const tokens = issueTokens(clientId, user.id, ['trips:read']);

    const result = refreshTokens(tokens.refresh_token, clientId, undefined);

    expect(result.error).toBeUndefined();
    expect(result.tokens?.access_token).toMatch(/^trekoa_/);
  });

  it('authenticateClient identifies a public client by id alone and rejects a missing secret otherwise', () => {
    const { user } = createUser(testDb);
    const pub = createOAuthClient(user.id, 'Public', ['https://example.com/callback'], ['trips:read'], null, { isPublic: true });
    const pubId = (pub.client as { client_id: string }).client_id;
    const conf = makeClient(user.id, { name: 'Confidential' });
    const confId = (conf.client as { client_id: string }).client_id;

    expect(authenticateClient(pubId, undefined)?.client_id).toBe(pubId);
    expect(authenticateClient(confId, undefined)).toBeNull();
  });

  it('validateAuthorizeRequest rejects a resource that is not the MCP endpoint', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = (created.client as { client_id: string }).client_id;
    const { challenge } = makePkce();

    const result = validateAuthorizeRequest({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://evil.example.org/mcp',
    }, user.id);

    expect(result).toEqual({ valid: false, error: 'invalid_target', error_description: 'Requested resource must be the TREK MCP endpoint' });
  });

  it('validateAuthorizeRequest accepts the MCP endpoint passed explicitly, trailing slash and all', () => {
    const { user } = createUser(testDb);
    const created = makeClient(user.id);
    const clientId = (created.client as { client_id: string }).client_id;
    const { challenge } = makePkce();
    const mcpResource = getMcpSafeUrl().replace(/\/+$/, '') + '/mcp';

    const result = validateAuthorizeRequest({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      scope: 'trips:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: mcpResource + '/',
    }, user.id);

    expect(result.valid).toBe(true);
    expect(result.resource).toBe(mcpResource);
  });
});

describe('module-scoped OAuth state', () => {
  it('shares the pending-code map across service instances', () => {
    // The load-bearing invariant: the consent controller writes the code through
    // the DI singleton, the SDK exchange path reads it back. The map is module-
    // scoped, so even a second hand-built instance must see it — two maps would
    // kill the authorization-code flow silently.
    const code = createAuthCode({
      clientId: 'c',
      userId: 42,
      redirectUri: 'https://example.com/callback',
      scopes: ['trips:read'],
      resource: null,
      codeChallenge: 'x',
      codeChallengeMethod: 'S256',
    })!;

    const secondInstance = new OauthService(dbs, addonsStub, new AuditService(dbs));
    expect(secondInstance.consumeAuthCode(code)?.userId).toBe(42);
  });
});

describe('OauthModule', () => {
  it('wires the public + api controllers and the providers', async () => {
    const { OauthModule } = await import('../../../src/nest/oauth/oauth.module');
    const { OauthPublicController } = await import('../../../src/nest/oauth/oauth-public.controller');
    const { OauthApiController } = await import('../../../src/nest/oauth/oauth-api.controller');
    const { OauthService: Svc } = await import('../../../src/nest/oauth/oauth.service');

    const { TrekClientsStore, TrekOAuthProvider } = await import('../../../src/nest/oauth/oauth-sdk.provider');

    const controllers = Reflect.getMetadata('controllers', OauthModule);
    const providers = Reflect.getMetadata('providers', OauthModule);
    expect(controllers).toEqual([OauthPublicController, OauthApiController]);
    // RateLimitService is deliberately absent: it comes from the global
    // RateLimitModule so all consumers share one set of counters.
    expect(providers).toEqual([Svc, TrekClientsStore, TrekOAuthProvider]);
  });
});

// ---------------------------------------------------------------------------
// Admin view of live sessions — moved here from admin.service.test.ts with the
// method. Named apart from the user-facing listOAuthSessions because the two
// are different queries: this one spans users and carries the owner username.
// ---------------------------------------------------------------------------

describe('admin OAuth sessions', () => {
  it('ADMIN-SVC-074 — listAllOAuthSessions survives a row with malformed scopes JSON', () => {
    const { user } = createUser(testDb);
    testDb.prepare("INSERT INTO oauth_clients (client_id, client_secret_hash, name) VALUES ('c1', 'hash', 'Client')").run();
    testDb.prepare(`
      INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, refresh_token_hash, scopes,
                                access_token_expires_at, refresh_token_expires_at)
      VALUES ('c1', ?, 'ahash', 'rhash', 'not-json{', datetime('now', '+1 hour'), datetime('now', '+1 day'))
    `).run(user.id);

    const sessions = svc.listAllOAuthSessions() as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].scopes).toBeNull();
  });
});
