import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getMcpSafeUrl: vi.fn(() => 'https://trek.example.test'),
}));

vi.mock('../../../src/app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/app-config')>();
  return { ...actual, getMcpSafeUrl: h.getMcpSafeUrl };
});

const sdk = vi.hoisted(() => ({
  authorizeHandler: vi.fn(),
  registerHandler: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/auth/handlers/authorize', () => ({
  authorizationHandler: vi.fn(() => sdk.authorizeHandler),
}));
vi.mock('@modelcontextprotocol/sdk/server/auth/handlers/register', () => ({
  clientRegistrationHandler: vi.fn(() => sdk.registerHandler),
}));

import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register';
import { InvalidClientMetadataError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors';
import { TrekClientsStore, TrekOAuthProvider } from '../../../src/nest/oauth/oauth-sdk.provider';
import { OauthModule } from '../../../src/nest/oauth/oauth.module';
import type { AddonsService } from '../../../src/nest/addons/addons.service';
import { ALL_SCOPES, DEFAULT_CLIENT_SCOPES, OPT_IN_ONLY_SCOPES } from '../../../src/mcp/scopes';
import type { OauthService } from '../../../src/nest/oauth/oauth.service';
import type { AuditService } from '../../../src/nest/audit/audit.service';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth';

function makeOauth(overrides: Partial<Record<keyof OauthService, unknown>> = {}) {
  return {
    getSdkClient: vi.fn(),
    createOAuthClient: vi.fn(() => ({ client: baseClientRecord() })),
    consumeAuthCode: vi.fn(),
    issueTokens: vi.fn(() => tokens()),
    refreshTokens: vi.fn(() => ({ tokens: tokens() })),
    getUserByAccessToken: vi.fn(),
    revokeToken: vi.fn(),
    verifyPKCE: vi.fn(() => true),
    ...overrides,
  } as unknown as OauthService;
}

function makeAudit() {
  return { writeAudit: vi.fn() } as unknown as AuditService;
}

function baseClientRecord() {
  return {
    client_id: 'cid-1',
    name: 'Registered',
    redirect_uris: ['https://client.example.com/cb'],
    allowed_scopes: ['trips:read'],
  } as Record<string, unknown>;
}

function tokens() {
  return { access_token: 'trekoa_x', refresh_token: 'trekrt_x', token_type: 'Bearer' as const, expires_in: 3600, scope: 'trips:read' };
}

function clientInfo(over: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: 'cid-1',
    redirect_uris: ['https://client.example.com/cb'],
    ...over,
  } as OAuthClientInformationFull;
}

function pending(over: Partial<Record<string, unknown>> = {}) {
  return {
    clientId: 'cid-1',
    userId: 7,
    redirectUri: 'https://client.example.com/cb',
    scopes: ['trips:read'],
    resource: 'https://trek.example.test/mcp',
    codeChallenge: 'chal',
    codeChallengeMethod: 'S256' as const,
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getMcpSafeUrl.mockReturnValue('https://trek.example.test');
});

// ─────────────────────────────────────────────────────────────────────────────
// TrekClientsStore
// ─────────────────────────────────────────────────────────────────────────────

describe('TrekClientsStore.getClient', () => {
  it('SDKP-001: maps a public client row to SDK client info', async () => {
    const oauth = makeOauth({
      getSdkClient: vi.fn(() => ({
        client_id: 'cid-1', name: 'App', redirect_uris: '["https://a.example.com/cb"]',
        allowed_scopes: '["trips:read","trips:write"]', is_public: 1, created_via: 'dcr',
      })),
    });
    const info = await new TrekClientsStore(oauth).getClient('cid-1');
    expect(info).toEqual({
      client_id: 'cid-1',
      client_name: 'App',
      redirect_uris: ['https://a.example.com/cb'],
      scope: 'trips:read trips:write',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  it('SDKP-002: a confidential client maps to client_secret_post', async () => {
    const oauth = makeOauth({
      getSdkClient: vi.fn(() => ({
        client_id: 'cid-2', name: 'Secret', redirect_uris: '[]', allowed_scopes: '["trips:read"]',
        is_public: 0, created_via: 'ui',
      })),
    });
    const info = await new TrekClientsStore(oauth).getClient('cid-2');
    expect(info!.token_endpoint_auth_method).toBe('client_secret_post');
  });

  it('SDKP-003: unknown client resolves undefined', async () => {
    const store = new TrekClientsStore(makeOauth({ getSdkClient: vi.fn(() => undefined) }));
    await expect(store.getClient('nope')).resolves.toBeUndefined();
  });
});

describe('TrekClientsStore.registerClient', () => {
  const store = () => new TrekClientsStore(makeOauth());

  it('SDKP-010: rejects a malformed redirect URI', async () => {
    await expect(store().registerClient({ redirect_uris: ['not a url'] } as never))
      .rejects.toThrowError(new InvalidClientMetadataError('Invalid redirect URI: not a url'));
  });

  it('SDKP-011: rejects dangerous schemes', async () => {
    await expect(store().registerClient({ redirect_uris: ['javascript:alert(1)'] } as never))
      .rejects.toThrowError(new InvalidClientMetadataError('Dangerous redirect URI scheme: javascript:alert(1)'));
    // A host named localhost does not make the scheme safe (#2227).
    for (const uri of ['javascript://localhost/%0aalert(1)', 'blob://localhost/x', 'about://localhost/x']) {
      await expect(store().registerClient({ redirect_uris: [uri] } as never))
        .rejects.toThrowError(new InvalidClientMetadataError(`Dangerous redirect URI scheme: ${uri}`));
    }
  });

  it('SDKP-012: rejects plain-http non-loopback and non-navigable schemes', async () => {
    const msg = 'redirect_uris must be HTTPS, loopback HTTP, or a private custom scheme';
    for (const uri of ['http://evil.example.com/cb', 'ws://localhost/cb']) {
      await expect(store().registerClient({ redirect_uris: [uri] } as never))
        .rejects.toThrowError(new InvalidClientMetadataError(msg));
    }
    // These were only ever refused as a side effect of the old dot rule.
    for (const uri of ['view-source:https://x', 'moz-extension://a/b']) {
      await expect(store().registerClient({ redirect_uris: [uri] } as never))
        .rejects.toThrowError(new InvalidClientMetadataError(`Dangerous redirect URI scheme: ${uri}`));
    }
  });

  it('SDKP-013: accepts https, loopback http, and private-use custom schemes', async () => {
    for (const uri of [
      'https://a.example.com/cb',
      'http://localhost:8080/cb',
      'http://127.0.0.1/cb',
      'http://[::1]/cb',
      'com.example.app:/oauth',
      // #2227: single-label private-use schemes are legal (RFC 8252 §7.1 only
      // SHOULDs the reverse-domain form) and were rejected outright.
      'workbuddy://workbuddy/mcp/connector%3A/oauth/callback',
      'myapp://cb',
      'msauth://com.x.y/abc',
    ]) {
      const oauth = makeOauth();
      await new TrekClientsStore(oauth).registerClient({
        redirect_uris: [uri], token_endpoint_auth_method: 'none', scope: 'trips:read',
      } as never);
      expect(oauth.createOAuthClient).toHaveBeenCalled();
    }
  });

  it('SDKP-014: blank/missing client_name defaults to MCP Client; long names are clipped', async () => {
    const oauth = makeOauth();
    const s = new TrekClientsStore(oauth);
    await s.registerClient({ redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read' } as never);
    expect(vi.mocked(oauth.createOAuthClient).mock.calls[0][1]).toBe('MCP Client');

    await s.registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read', client_name: `  ${'x'.repeat(150)}  `,
    } as never);
    expect(vi.mocked(oauth.createOAuthClient).mock.calls[1][1]).toBe('x'.repeat(100));
  });

  it('SDKP-015: absent scope defaults to the safe set, not every scope', async () => {
    const oauth = makeOauth();
    await new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], token_endpoint_auth_method: 'none',
    } as never);
    expect(vi.mocked(oauth.createOAuthClient).mock.calls[0][3]).toEqual(DEFAULT_CLIENT_SCOPES);
  });

  it('SDKP-015b: an opt-in-only scope is never handed out by the default', async () => {
    // A scope in the default set is PRE-SELECTED on the consent screen, so
    // "the user still approves it" is not consent to a default nobody asked
    // for. plugins:use runs third-party code as the caller.
    const oauth = makeOauth();
    await new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], token_endpoint_auth_method: 'none',
    } as never);
    const granted = vi.mocked(oauth.createOAuthClient).mock.calls[0][3] as string[];
    expect(OPT_IN_ONLY_SCOPES.length).toBeGreaterThan(0);
    for (const scope of OPT_IN_ONLY_SCOPES) expect(granted).not.toContain(scope);
    // Still reachable when a client asks for it by name.
    expect(ALL_SCOPES).toContain('plugins:use');
  });

  it('SDKP-015c: a client that names plugins:use still gets it', async () => {
    const oauth = makeOauth();
    await new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read plugins:use',
    } as never);
    expect(vi.mocked(oauth.createOAuthClient).mock.calls[0][3]).toEqual(['trips:read', 'plugins:use']);
  });

  it('SDKP-016: unknown scopes are filtered; nothing valid left is an error', async () => {
    const oauth = makeOauth();
    await new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read bogus:scope',
    } as never);
    expect(vi.mocked(oauth.createOAuthClient).mock.calls[0][3]).toEqual(['trips:read']);

    await expect(new TrekClientsStore(makeOauth()).registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'bogus:scope',
    } as never)).rejects.toThrowError(new InvalidClientMetadataError('No valid scopes requested'));
  });

  it('SDKP-017: a service-side rejection surfaces as InvalidClientMetadataError', async () => {
    const oauth = makeOauth({ createOAuthClient: vi.fn(() => ({ error: 'Maximum 10 redirect URIs per client', status: 400 })) });
    await expect(new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read',
    } as never)).rejects.toThrowError(new InvalidClientMetadataError('Maximum 10 redirect URIs per client'));
  });

  it('SDKP-018: response shape — public client has no secret, confidential carries a never-expiring one', async () => {
    const pub = await new TrekClientsStore(makeOauth()).registerClient({
      redirect_uris: ['https://a.example.com/cb'], token_endpoint_auth_method: 'none', scope: 'trips:read',
    } as never);
    expect(pub.token_endpoint_auth_method).toBe('none');
    expect(pub.client_secret).toBeUndefined();

    const oauth = makeOauth({
      createOAuthClient: vi.fn(() => ({ client: { ...baseClientRecord(), client_secret: 'sec-1' } })),
    });
    const conf = await new TrekClientsStore(oauth).registerClient({
      redirect_uris: ['https://a.example.com/cb'], scope: 'trips:read',
    } as never);
    expect(conf.token_endpoint_auth_method).toBe('client_secret_post');
    expect(conf.client_secret).toBe('sec-1');
    expect(conf.client_secret_expires_at).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TrekOAuthProvider
// ─────────────────────────────────────────────────────────────────────────────

function makeProvider(oauth = makeOauth(), audit = makeAudit()) {
  const clients = new TrekClientsStore(oauth);
  return { provider: new TrekOAuthProvider(clients, oauth, audit), clients, oauth, audit };
}

function makeRes() {
  return { redirect: vi.fn() };
}

describe('TrekOAuthProvider basics', () => {
  it('SDKP-020: exposes the injected clients store and skips local PKCE', () => {
    const { provider, clients } = makeProvider();
    expect(provider.clientsStore).toBe(clients);
    expect(provider.skipLocalPkceValidation).toBe(true);
  });

  it('SDKP-021: challengeForAuthorizationCode is unreachable by design', async () => {
    const { provider } = makeProvider();
    await expect(provider.challengeForAuthorizationCode(clientInfo(), 'code'))
      .rejects.toThrowError(new ServerError('PKCE validation is handled by the provider directly'));
  });
});

describe('TrekOAuthProvider.authorize', () => {
  it('SDKP-030: forwards the exact params to the SPA consent page', async () => {
    const { provider } = makeProvider();
    const res = makeRes();
    await provider.authorize(clientInfo(), {
      redirectUri: 'https://client.example.com/cb',
      scopes: ['trips:read', 'trips:write'],
      codeChallenge: 'chal',
      state: 'st',
      resource: new URL('https://trek.example.test/mcp'),
    } as never, res as never);
    const qs = new URLSearchParams({
      client_id: 'cid-1',
      redirect_uri: 'https://client.example.com/cb',
      scope: 'trips:read trips:write',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 'st',
      resource: 'https://trek.example.test/mcp',
    });
    expect(res.redirect).toHaveBeenCalledWith(302, `https://trek.example.test/oauth/consent?${qs.toString()}`);
  });

  it('SDKP-031: omits state/resource params when the request carried none', async () => {
    const { provider } = makeProvider();
    const res = makeRes();
    await provider.authorize(clientInfo(), {
      redirectUri: 'https://client.example.com/cb',
      scopes: ['trips:read'],
      codeChallenge: 'chal',
    } as never, res as never);
    const target = vi.mocked(res.redirect).mock.calls[0][1] as string;
    const url = new URL(target);
    expect(url.searchParams.get('state')).toBeNull();
    expect(url.searchParams.get('resource')).toBeNull();
  });

  it('SDKP-032: a foreign resource bounces back to the client with invalid_target (+state)', async () => {
    const { provider } = makeProvider();
    const res = makeRes();
    await provider.authorize(clientInfo(), {
      redirectUri: 'https://client.example.com/cb',
      scopes: ['trips:read'],
      codeChallenge: 'chal',
      state: 'keep-me',
      resource: new URL('https://other.example.com/api'),
    } as never, res as never);
    const target = new URL(vi.mocked(res.redirect).mock.calls[0][1] as string);
    expect(`${target.origin}${target.pathname}`).toBe('https://client.example.com/cb');
    expect(target.searchParams.get('error')).toBe('invalid_target');
    expect(target.searchParams.get('error_description')).toBe('Requested resource must be the TREK MCP endpoint');
    expect(target.searchParams.get('state')).toBe('keep-me');
  });

  it('SDKP-033: the invalid_target bounce omits state when there was none', async () => {
    const { provider } = makeProvider();
    const res = makeRes();
    await provider.authorize(clientInfo(), {
      redirectUri: 'https://client.example.com/cb',
      scopes: ['trips:read'],
      codeChallenge: 'chal',
      resource: new URL('https://other.example.com/api'),
    } as never, res as never);
    const target = new URL(vi.mocked(res.redirect).mock.calls[0][1] as string);
    expect(target.searchParams.get('state')).toBeNull();
  });
});

describe('TrekOAuthProvider.exchangeAuthorizationCode', () => {
  const invalid = 'Authorization grant is invalid.';

  it('SDKP-040: unknown/expired code throws the uniform grant error', async () => {
    const { provider } = makeProvider(makeOauth({ consumeAuthCode: vi.fn(() => null) }));
    await expect(provider.exchangeAuthorizationCode(clientInfo(), 'code')).rejects.toThrow(invalid);
  });

  it('SDKP-041: a code minted for another client throws the same error', async () => {
    const { provider } = makeProvider(makeOauth({ consumeAuthCode: vi.fn(() => pending({ clientId: 'someone-else' })) }));
    await expect(provider.exchangeAuthorizationCode(clientInfo(), 'code')).rejects.toThrow(invalid);
  });

  it('SDKP-042: redirect_uri mismatch throws the same error', async () => {
    const { provider } = makeProvider(makeOauth({ consumeAuthCode: vi.fn(() => pending()) }));
    await expect(provider.exchangeAuthorizationCode(clientInfo(), 'code', undefined, 'https://wrong.example.com/cb'))
      .rejects.toThrow(invalid);
  });

  it('SDKP-043: resource mismatch throws the same error', async () => {
    const { provider } = makeProvider(makeOauth({ consumeAuthCode: vi.fn(() => pending()) }));
    await expect(provider.exchangeAuthorizationCode(
      clientInfo(), 'code', undefined, 'https://client.example.com/cb', new URL('https://other.example.com/'),
    )).rejects.toThrow(invalid);
  });

  it('SDKP-044: failed PKCE throws the same error', async () => {
    const oauth = makeOauth({ consumeAuthCode: vi.fn(() => pending()), verifyPKCE: vi.fn(() => false) });
    const { provider } = makeProvider(oauth);
    await expect(provider.exchangeAuthorizationCode(clientInfo(), 'code', 'bad-verifier', 'https://client.example.com/cb'))
      .rejects.toThrow(invalid);
    expect(oauth.verifyPKCE).toHaveBeenCalledWith('bad-verifier', 'chal');
  });

  it('SDKP-045: a valid exchange issues tokens and audits the issue', async () => {
    const oauth = makeOauth({ consumeAuthCode: vi.fn(() => pending()) });
    const audit = makeAudit();
    const { provider } = makeProvider(oauth, audit);
    const result = await provider.exchangeAuthorizationCode(
      clientInfo(), 'code', 'verifier', 'https://client.example.com/cb', new URL('https://trek.example.test/mcp'),
    );
    expect(result).toEqual(tokens());
    expect(oauth.issueTokens).toHaveBeenCalledWith('cid-1', 7, ['trips:read'], null, 'https://trek.example.test/mcp');
    expect(audit.writeAudit).toHaveBeenCalledWith({
      userId: 7,
      action: 'oauth.token.issue',
      details: { client_id: 'cid-1', scopes: ['trips:read'], audience: 'https://trek.example.test/mcp' },
      ip: null,
    });
  });

  it('SDKP-046: a pending code without a resource issues a null-audience token', async () => {
    const oauth = makeOauth({ consumeAuthCode: vi.fn(() => pending({ resource: null })) });
    const { provider } = makeProvider(oauth);
    await provider.exchangeAuthorizationCode(clientInfo(), 'code', 'verifier');
    expect(oauth.issueTokens).toHaveBeenCalledWith('cid-1', 7, ['trips:read'], null, null);
  });

  it('SDKP-047: a missing codeVerifier is refused, not waved through', async () => {
    const oauth = makeOauth({ consumeAuthCode: vi.fn(() => pending()) });
    const { provider } = makeProvider(oauth);
    await expect(provider.exchangeAuthorizationCode(clientInfo(), 'code')).rejects.toThrow(invalid);
    expect(oauth.issueTokens).not.toHaveBeenCalled();
  });
});

describe('TrekOAuthProvider.exchangeRefreshToken', () => {
  it('SDKP-050: maps invalid_client and generic failures to their legacy messages', async () => {
    const bad = makeProvider(makeOauth({ refreshTokens: vi.fn(() => ({ error: 'invalid_client' })) }));
    await expect(bad.provider.exchangeRefreshToken(clientInfo(), 'rt')).rejects.toThrow('Invalid client credentials');

    const expired = makeProvider(makeOauth({ refreshTokens: vi.fn(() => ({ error: 'invalid_grant' })) }));
    await expect(expired.provider.exchangeRefreshToken(clientInfo(), 'rt')).rejects.toThrow('Refresh token is invalid or expired');
  });

  it('SDKP-051: success returns the rotated tokens with the client secret forwarded', async () => {
    const oauth = makeOauth();
    const { provider } = makeProvider(oauth);
    const result = await provider.exchangeRefreshToken(clientInfo({ client_secret: 'sec' }), 'rt');
    expect(result).toEqual(tokens());
    expect(oauth.refreshTokens).toHaveBeenCalledWith('rt', 'cid-1', 'sec', null);
  });
});

describe('TrekOAuthProvider.verifyAccessToken / revokeToken', () => {
  it('SDKP-060: an unknown token throws; a live one maps to AuthInfo', async () => {
    const dead = makeProvider(makeOauth({ getUserByAccessToken: vi.fn(() => null) }));
    await expect(dead.provider.verifyAccessToken('trekoa_dead')).rejects.toThrow('Invalid or expired token');

    const info = {
      user: { id: 7, username: 'u', email: 'u@example.com', role: 'user' as const },
      scopes: ['trips:read'],
      clientId: 'cid-1',
      audience: null,
    };
    const live = makeProvider(makeOauth({ getUserByAccessToken: vi.fn(() => info) }));
    await expect(live.provider.verifyAccessToken('trekoa_live')).resolves.toEqual({
      token: 'trekoa_live',
      clientId: 'cid-1',
      scopes: ['trips:read'],
      extra: { user: info.user },
    });
  });

  it('SDKP-061: revokeToken delegates with the caller client id and a null ip', async () => {
    const oauth = makeOauth();
    const { provider } = makeProvider(oauth);
    await provider.revokeToken(clientInfo(), { token: 'trekoa_x' });
    expect(oauth.revokeToken).toHaveBeenCalledWith('trekoa_x', 'cid-1', undefined, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OauthModule.configure — the SDK routers behind the addon gate
// ─────────────────────────────────────────────────────────────────────────────

describe('OauthModule.configure', () => {
  it('SDKP-070: mounts gate + SDK handlers on their prefixes over the injected adapters', () => {
    const { provider, clients } = makeProvider();
    const addons = { isAddonEnabled: vi.fn(() => true) } as unknown as AddonsService;
    const applied: Array<{ handlers: unknown[]; route: string }> = [];
    const consumer = {
      apply: vi.fn((...handlers: unknown[]) => ({
        forRoutes: (route: string) => applied.push({ handlers, route }),
      })),
    };

    new OauthModule(addons, provider, clients).configure(consumer as never);

    expect(vi.mocked(authorizationHandler)).toHaveBeenCalledWith({ provider });
    expect(vi.mocked(clientRegistrationHandler)).toHaveBeenCalledWith({ clientsStore: clients });
    expect(applied).toHaveLength(2);
    const [authz, reg] = applied;
    expect(authz.route).toBe('oauth/authorize');
    expect(authz.handlers[1]).toBe(sdk.authorizeHandler);
    expect(reg.route).toBe('oauth/register');
    expect(reg.handlers[1]).toBe(sdk.registerHandler);
    // Both mounts share one gate instance, built over the injected AddonsService.
    expect(authz.handlers[0]).toBe(reg.handlers[0]);
    const res = { status: vi.fn(() => ({ end: vi.fn() })), end: vi.fn() };
    (authz.handlers[0] as (rq: unknown, rs: unknown, nx: () => void) => void)({}, res, vi.fn());
    expect(addons.isAddonEnabled).toHaveBeenCalled();
  });
});
