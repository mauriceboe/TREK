import express, { Request, Response } from 'express';
import { authenticate, requireCookieAuth, optionalAuth } from '../middleware/auth';
import { AuthRequest, OptionalAuthRequest } from '../types';
import { isAddonEnabled } from '../services/adminService';
import { ALL_SCOPES, SCOPE_INFO } from '../mcp/scopes';
import { ADDON_IDS } from '../addons';
import {
  validateAuthorizeRequest,
  createAuthCode,
  consumeAuthCode,
  saveConsent,
  issueTokens,
  refreshTokens,
  revokeToken,
  verifyPKCE,
  authenticateClient,
  isValidRedirectUri,
  listOAuthClients,
  createOAuthClient,
  deleteOAuthClient,
  rotateOAuthClientSecret,
  listOAuthSessions,
  revokeSession,
  AuthorizeParams,
} from '../services/oauthService';
import { getAppUrl } from '../services/oidcService';
import { writeAudit, getClientIp, logWarn } from '../services/auditLog';

// ---------------------------------------------------------------------------
// Minimal in-file rate limiter (same pattern as auth.ts)
// ---------------------------------------------------------------------------

interface RateEntry { count: number; first: number; }

function makeRateLimiter(maxAttempts: number, windowMs: number, keyFn: (req: Request) => string) {
  const store = new Map<string, RateEntry>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, r] of store) if (now - r.first >= windowMs) store.delete(k);
  }, windowMs).unref();

  return (req: Request, res: Response, next: () => void): void => {
    const key = keyFn(req);
    const now = Date.now();
    const record = store.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      res.status(429).json({ error: 'too_many_requests', error_description: 'Too many attempts. Please try again later.' });
      return;
    }
    if (!record || now - record.first >= windowMs) {
      store.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}

const tokenLimiter    = makeRateLimiter(30, 60_000, (req) => `${req.ip}|${req.body?.client_id ?? ''}`);
const validateLimiter = makeRateLimiter(30, 60_000, (req) => req.ip ?? 'unknown');
const revokeLimiter   = makeRateLimiter(10, 60_000, (req) => req.ip ?? 'unknown');
const dcrLimiter      = makeRateLimiter(10, 60_000, (req) => req.ip ?? 'unknown');

// ---------------------------------------------------------------------------
// Public router: /.well-known, /oauth/token, /oauth/revoke
// ---------------------------------------------------------------------------

export const oauthPublicRouter = express.Router();

// RFC 8414 discovery document
oauthPublicRouter.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
  // M2: return 404 (not 403) so feature presence isn't fingerprinted
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();

  const base = (getAppUrl() || '').replace(/\/+$/, '');
  res.json({
    issuer:                                base,
    authorization_endpoint:                `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    revocation_endpoint:                   `${base}/oauth/revoke`,
    registration_endpoint:                 `${base}/oauth/register`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported:                      ALL_SCOPES,
    scope_descriptions:                    Object.fromEntries(
      ALL_SCOPES.map(s => [s, SCOPE_INFO[s].label])
    ),
  });
});

// Token endpoint — handles authorization_code and refresh_token grants
oauthPublicRouter.post('/oauth/token', tokenLimiter, (req: Request, res: Response) => {
  // M1: RFC 6749 §5.1 — token responses must not be cached
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  // Accept both JSON and application/x-www-form-urlencoded
  const body: Record<string, string> = typeof req.body === 'object' ? req.body : {};
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = body;
  const ip = getClientIp(req);

  if (!isAddonEnabled(ADDON_IDS.MCP)) {
    return res.status(403).json({ error: 'mcp_disabled', error_description: 'MCP is not enabled' });
  }

  if (!client_id) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'client_id is required' });
  }

  // ---- authorization_code grant ----
  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri, and code_verifier are required' });
    }

    const pending = consumeAuthCode(code);

    // H5: collapse all invalid_grant cases to one message; log specifics server-side
    if (!pending) {
      writeAudit({ userId: null, action: 'oauth.token.grant_failed', details: { client_id, reason: 'code_invalid_or_expired' }, ip });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization grant is invalid.' });
    }

    if (pending.clientId !== client_id) {
      writeAudit({ userId: pending.userId, action: 'oauth.token.grant_failed', details: { client_id, reason: 'client_id_mismatch' }, ip });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization grant is invalid.' });
    }

    if (pending.redirectUri !== redirect_uri) {
      writeAudit({ userId: pending.userId, action: 'oauth.token.grant_failed', details: { client_id, reason: 'redirect_uri_mismatch' }, ip });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization grant is invalid.' });
    }

    // Verify client secret
    if (!authenticateClient(client_id, client_secret)) {
      logWarn(`[OAuth] Invalid client credentials for client_id=${client_id} ip=${ip ?? '-'}`);
      writeAudit({ userId: pending.userId, action: 'oauth.token.client_auth_failed', details: { client_id }, ip });
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    // Verify PKCE
    if (!verifyPKCE(code_verifier, pending.codeChallenge)) {
      writeAudit({ userId: pending.userId, action: 'oauth.token.grant_failed', details: { client_id, reason: 'pkce_failed' }, ip });
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization grant is invalid.' });
    }

    const tokens = issueTokens(client_id, pending.userId, pending.scopes);
    writeAudit({ userId: pending.userId, action: 'oauth.token.issue', details: { client_id, scopes: pending.scopes }, ip });
    return res.json(tokens);
  }

  // ---- refresh_token grant ----
  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
    }

    const result = refreshTokens(refresh_token, client_id, client_secret, ip);
    if (result.error) {
      if (result.error === 'invalid_client') {
        logWarn(`[OAuth] Invalid client credentials on refresh for client_id=${client_id} ip=${ip ?? '-'}`);
      }
      return res.status(result.status || 400).json({
        error: result.error,
        error_description: result.error === 'invalid_client' ? 'Invalid client credentials' : 'Refresh token is invalid or expired',
      });
    }

    return res.json(result.tokens);
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grant_type}` });
});

// RFC 7591 Dynamic Client Registration endpoint
oauthPublicRouter.post('/oauth/register', dcrLimiter, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();

  const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const ip = getClientIp(req);

  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (redirectUris.length === 0) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required and must be a non-empty array' });
  }

  const rawName = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 100) : '';
  const clientName = rawName || 'MCP Client';

  // Determine if the client wants to be public (no secret) — MCP clients typically use PKCE only
  const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'client_secret_post';
  const isPublic = authMethod === 'none';

  // Resolve requested scopes — default to all supported scopes if not specified
  const rawScope = typeof body.scope === 'string' ? body.scope : ALL_SCOPES.join(' ');
  const requestedScopes = rawScope.split(' ').filter(s => (ALL_SCOPES as string[]).includes(s));
  if (requestedScopes.length === 0) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'No valid scopes requested' });
  }

  const result = createOAuthClient(null, clientName, redirectUris, requestedScopes, ip, {
    isPublic,
    createdVia: 'dcr',
  });

  if (result.error) {
    return res.status(result.status || 400).json({ error: 'invalid_client_metadata', error_description: result.error });
  }

  const client = result.client!;
  const now = Math.floor(Date.now() / 1000);

  return res.status(201).json({
    client_id:                     client.client_id,
    ...(client.client_secret      ? { client_secret: client.client_secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at:           now,
    redirect_uris:                 client.redirect_uris,
    grant_types:                   ['authorization_code', 'refresh_token'],
    response_types:                ['code'],
    scope:                         (client.allowed_scopes as string[]).join(' '),
    client_name:                   client.name,
    token_endpoint_auth_method:    isPublic ? 'none' : 'client_secret_post',
  });
});

// Token revocation endpoint (RFC 7009)
oauthPublicRouter.post('/oauth/revoke', revokeLimiter, (req: Request, res: Response) => {
  // M2: return 404 when MCP is disabled
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();

  const body: Record<string, string> = typeof req.body === 'object' ? req.body : {};
  const { token, client_id, client_secret } = body;
  const ip = getClientIp(req);

  if (!token || !client_id) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'token and client_id are required' });
  }

  if (!authenticateClient(client_id, client_secret)) {
    logWarn(`[OAuth] Invalid client credentials on revoke for client_id=${client_id} ip=${ip ?? '-'}`);
    writeAudit({ userId: null, action: 'oauth.token.client_auth_failed', details: { client_id, endpoint: 'revoke' }, ip });
    return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
  }

  revokeToken(token, client_id, undefined, ip);
  // RFC 7009 §2.2: always respond 200 even if token was already revoked or not found
  return res.status(200).json({});
});

// ---------------------------------------------------------------------------
// API router: /api/oauth/* — authenticated endpoints used by the SPA
// ---------------------------------------------------------------------------

export const oauthApiRouter = express.Router();

// SPA calls this on page load to validate OAuth params before rendering consent UI
oauthApiRouter.get('/authorize/validate', validateLimiter, optionalAuth, (req: Request, res: Response) => {
  // M2 / H3: gate by addon; 404 prevents feature fingerprinting for anonymous callers
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(404).end();

  const params = req.query as Partial<AuthorizeParams>;
  const userId = (req as OptionalAuthRequest).user?.id ?? null;

  const result = validateAuthorizeRequest(
    {
      response_type:          params.response_type || '',
      client_id:              params.client_id || '',
      redirect_uri:           params.redirect_uri || '',
      scope:                  params.scope || '',
      state:                  params.state,
      code_challenge:         params.code_challenge || '',
      code_challenge_method:  params.code_challenge_method || '',
    },
    userId,
  );

  // H3: when caller is unauthenticated, strip client name / allowed_scopes from the response
  // (validateAuthorizeRequest already does this, but be explicit here)
  if (userId === null && result.valid) {
    return res.json({ valid: result.valid, loginRequired: true });
  }

  // For unauthenticated error cases return a generic error to prevent oracle enumeration
  if (userId === null && !result.valid) {
    return res.json({ valid: false, error: 'invalid_request', error_description: 'Invalid authorization request' });
  }

  return res.json(result);
});

// User submits consent (approve or deny) — requires cookie-only auth (M7)
oauthApiRouter.post('/authorize', requireCookieAuth, (req: Request, res: Response) => {
  const { user } = req as AuthRequest;
  const {
    client_id, redirect_uri, scope, state,
    code_challenge, code_challenge_method, approved,
  } = req.body as {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state?: string;
    code_challenge: string;
    code_challenge_method: string;
    approved: boolean;
  };
  const ip = getClientIp(req);

  if (!isAddonEnabled(ADDON_IDS.MCP)) {
    return res.status(403).json({ error: 'MCP is not enabled' });
  }

  if (!approved) {
    // User denied — redirect with error
    const url = new URL(redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the authorization request');
    if (state) url.searchParams.set('state', state);
    return res.json({ redirect: url.toString() });
  }

  // Re-validate all params (server-side re-check after user action)
  const params: AuthorizeParams = {
    response_type: 'code',
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
  };

  const validation = validateAuthorizeRequest(params, user.id);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, error_description: validation.error_description });
  }

  const scopes = validation.scopes!;

  // Store consent (union with any existing scopes)
  saveConsent(client_id, user.id, scopes, ip);

  // Issue auth code
  const code = createAuthCode({
    clientId: client_id,
    userId: user.id,
    redirectUri: redirect_uri,
    scopes,
    codeChallenge: code_challenge,
    codeChallengeMethod: 'S256',
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return res.json({ redirect: url.toString() });
});

// ---- OAuth client CRUD ----

oauthApiRouter.get('/clients', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  return res.json({ clients: listOAuthClients(user.id) });
});

oauthApiRouter.post('/clients', requireCookieAuth, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const { name, redirect_uris, allowed_scopes } = req.body as {
    name: string;
    redirect_uris: string[];
    allowed_scopes: string[];
  };

  const result = createOAuthClient(user.id, name, redirect_uris, allowed_scopes, getClientIp(req));
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.status(201).json(result);
});

oauthApiRouter.post('/clients/:id/rotate', requireCookieAuth, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = rotateOAuthClientSecret(user.id, req.params.id, getClientIp(req));
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ client_secret: result.client_secret });
});

oauthApiRouter.delete('/clients/:id', requireCookieAuth, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = deleteOAuthClient(user.id, req.params.id, getClientIp(req));
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ success: true });
});

// ---- Active OAuth sessions ----

oauthApiRouter.get('/sessions', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  return res.json({ sessions: listOAuthSessions(user.id) });
});

oauthApiRouter.delete('/sessions/:id', requireCookieAuth, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = revokeSession(user.id, Number(req.params.id), getClientIp(req));
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ success: true });
});
