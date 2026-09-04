import crypto, { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ADDON_IDS } from '../../addons';
import { getMcpSafeUrl } from '../../app-config';
// Import from scopes/sessionManager directly, NOT the ../../mcp barrel: the
// barrel pulls the whole tools fan-out (and via the domain bridges, the Nest
// services) into every consumer of this module — a nest→mcp→nest module cycle.
// Both files themselves are back-edge free (scopes has no imports at all,
// sessionManager only the MCP SDK).
import { validateScopes } from '../../mcp/scopes';
import { revokeUserSessionsForClient } from '../../mcp/sessionManager';
import { User } from '../../types';
import { AddonsService } from '../addons/addons.service';
import { AuditService } from '../audit/audit.service';
import { logWarn } from '../audit/audit-log.logger';
import { DatabaseService } from '../database/database.service';
import {
  ACCESS_TOKEN_TTL_S,
  CODE_CHALLENGE_RE,
  CODE_VERIFIER_RE,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  classifyRedirectUri,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  parseSqliteUtc,
  redirectUriMatches,
  timingSafeEqualHex,
  type OAuthClientRow,
  type OAuthTokenRow,
} from './oauth.helpers';
import { AUTH_CODE_TTL_MS, putPendingCode, takePendingCode, type PendingCode } from './oauth.pending-codes';

export type { OAuthClientRow, OAuthTokenRow } from './oauth.helpers';
export type { PendingCode } from './oauth.pending-codes';

export interface OAuthTokenInfo {
  user: User;
  scopes: string[];
  clientId: string;
  audience: string | null;
}

export interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
}

export interface ValidateAuthorizeResult {
  valid: boolean;
  error?: string;
  error_description?: string;
  client?: { name: string; allowed_scopes: string[] };
  scopes?: string[];
  resource?: string | null;
  /** true when user is logged in but consent UI must be shown */
  consentRequired?: boolean;
  /** true when the request is valid but user is not authenticated */
  loginRequired?: boolean;
  /** true when the client was registered via machine DCR — user may adjust scopes on the consent screen */
  scopeSelectable?: boolean;
}

/**
 * OAuth 2.1 server for MCP: client management, the authorization-code grant
 * with PKCE, consent storage, token issue/refresh/revoke with rotation and
 * replay detection, and the client_credentials grant.
 *
 * The authorization-code store lives in oauth.pending-codes.ts rather than on
 * this instance — the SDK-mounted /oauth/authorize path reaches it through
 * oauth.bridge.ts, outside the container, and must see the same map.
 */
@Injectable()
export class OauthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly addons: AddonsService,
    private readonly audit: AuditService,
  ) {}

  mcpEnabled(): boolean { return this.addons.isAddonEnabled(ADDON_IDS.MCP); }
  mcpSafeUrl(): string { return getMcpSafeUrl(); }

  // -------------------------------------------------------------------------
  // Client management (self-service, gated by MCP addon)
  // -------------------------------------------------------------------------

  listOAuthClients(userId: number): Record<string, unknown>[] {
    const rows = this.db.all<OAuthClientRow>(
      'SELECT id, user_id, name, client_id, redirect_uris, allowed_scopes, created_at, is_public, created_via, allows_client_credentials FROM oauth_clients WHERE user_id = ? ORDER BY created_at DESC',
      userId,
    );
    return rows.map(r => ({
      ...r,
      is_public: Boolean(r.is_public),
      allows_client_credentials: Boolean(r.allows_client_credentials),
      redirect_uris: JSON.parse(r.redirect_uris),
      allowed_scopes: JSON.parse(r.allowed_scopes),
    }));
  }

  createOAuthClient(
    userId: number | null,
    name: string,
    redirectUris: string[],
    allowedScopes: string[],
    ip?: string | null,
    options?: { isPublic?: boolean; createdVia?: string; allowsClientCredentials?: boolean },
  ): { error?: string; status?: number; client?: Record<string, unknown> } {
    if (!name?.trim()) return { error: 'Name is required', status: 400 };
    if (name.trim().length > 100) return { error: 'Name must be 100 characters or less', status: 400 };
    const isMachineClient = Boolean(options?.allowsClientCredentials);
    if (!isMachineClient && (!redirectUris || redirectUris.length === 0)) return { error: 'At least one redirect URI is required', status: 400 };
    if (redirectUris.length > 10) return { error: 'Maximum 10 redirect URIs per client', status: 400 };

    // Same policy as the DCR path (#2227). This used to exempt any host named
    // localhost or 127.0.0.1 regardless of scheme, which let the settings UI
    // register javascript://localhost/…, and the consent flow then assigns that
    // stored URI to window.location.href.
    for (const uri of redirectUris) {
      const verdict = classifyRedirectUri(uri);
      if (verdict === 'malformed') return { error: `Invalid redirect URI: ${uri}`, status: 400 };
      if (verdict === 'dangerous') return { error: `Dangerous redirect URI scheme: ${uri}`, status: 400 };
      if (verdict === 'not_allowed') return { error: `Redirect URI must use HTTPS, loopback HTTP, or a private custom scheme: ${uri}`, status: 400 };
    }

    if (!allowedScopes || allowedScopes.length === 0) return { error: 'At least one scope is required', status: 400 };
    const { valid, invalid } = validateScopes(allowedScopes);
    if (!valid) return { error: `Invalid scopes: ${invalid.join(', ')}`, status: 400 };

    if (userId !== null) {
      const count = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM oauth_clients WHERE user_id = ?', userId)!.count;
      if (count >= 10) return { error: 'Maximum of 10 OAuth clients per user', status: 400 };
    } else {
      // Anonymous DCR clients: enforce a global cap to prevent unbounded registration abuse
      const count = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM oauth_clients WHERE user_id IS NULL')!.count;
      if (count >= 500) return { error: 'server_error', status: 503 };
    }

    // Machine clients (client_credentials) must always be confidential — ignore isPublic for them.
    const isPublic    = isMachineClient ? false : (options?.isPublic ?? false);
    const createdVia  = options?.createdVia ?? 'settings_ui';
    const id          = randomUUID();
    const clientId    = randomUUID();
    // Public clients have no usable secret; store an opaque random value to satisfy NOT NULL.
    const rawSecret   = isPublic ? null : 'trekcs_' + randomBytes(24).toString('hex');
    const secretHash  = rawSecret ? hashToken(rawSecret) : randomBytes(32).toString('hex');

    this.db.run(
      'INSERT INTO oauth_clients (id, user_id, name, client_id, client_secret_hash, redirect_uris, allowed_scopes, is_public, created_via, allows_client_credentials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, name.trim(), clientId, secretHash, JSON.stringify(redirectUris), JSON.stringify(allowedScopes), isPublic ? 1 : 0, createdVia, isMachineClient ? 1 : 0,
    );

    const row = this.db.get<OAuthClientRow>(
      'SELECT id, user_id, name, client_id, redirect_uris, allowed_scopes, created_at, is_public, created_via, allows_client_credentials FROM oauth_clients WHERE id = ?',
      id,
    )!;

    this.audit.writeAudit({ userId, action: 'oauth.client.create', details: { client_id: clientId, name: name.trim(), is_public: isPublic, allows_client_credentials: isMachineClient }, ip });

    return {
      client: {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        client_id: row.client_id,
        redirect_uris: JSON.parse(row.redirect_uris),
        allowed_scopes: JSON.parse(row.allowed_scopes),
        created_at: row.created_at,
        is_public: Boolean(row.is_public),
        allows_client_credentials: Boolean(row.allows_client_credentials),
        created_via: row.created_via,
        // client_secret only present for confidential clients — shown once, not stored in plain text
        ...(rawSecret ? { client_secret: rawSecret } : {}),
      },
    };
  }

  rotateOAuthClientSecret(
    userId: number,
    clientRowId: string,
    ip?: string | null,
  ): { error?: string; status?: number; client_secret?: string } {
    const row = this.db.get<OAuthClientRow>('SELECT id, client_id, is_public FROM oauth_clients WHERE id = ? AND user_id = ?', clientRowId, userId);
    if (!row) return { error: 'Client not found', status: 404 };
    if (row.is_public) return { error: 'Public clients do not use a client secret', status: 400 };

    const rawSecret  = 'trekcs_' + randomBytes(24).toString('hex');
    const secretHash = hashToken(rawSecret);

    this.db.run('UPDATE oauth_clients SET client_secret_hash = ? WHERE id = ?', secretHash, clientRowId);

    // Revoke all existing tokens for this client so old sessions are invalidated
    this.db.run("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE client_id = ? AND revoked_at IS NULL", row.client_id);

    // Terminate active MCP sessions for this (user, client) pair
    revokeUserSessionsForClient(userId, row.client_id);

    this.audit.writeAudit({ userId, action: 'oauth.client.rotate_secret', details: { client_id: row.client_id }, ip });

    return { client_secret: rawSecret };
  }

  deleteOAuthClient(
    userId: number,
    clientRowId: string,
    ip?: string | null,
  ): { error?: string; status?: number; success?: boolean } {
    const row = this.db.get<OAuthClientRow>('SELECT id, client_id FROM oauth_clients WHERE id = ? AND user_id = ?', clientRowId, userId);
    if (!row) return { error: 'Client not found', status: 404 };
    this.db.run('DELETE FROM oauth_clients WHERE id = ?', clientRowId);
    this.audit.writeAudit({ userId, action: 'oauth.client.delete', details: { client_id: row.client_id }, ip });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Auth code (in-memory, 2-minute TTL)
  // -------------------------------------------------------------------------

  createAuthCode(params: {
    clientId: string;
    userId: number;
    redirectUri: string;
    scopes: string[];
    resource: string | null;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
  }): string | null {
    const rawCode = randomBytes(32).toString('hex');
    const stored = putPendingCode(rawCode, { ...params, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
    return stored ? rawCode : null;
  }

  consumeAuthCode(code: string): PendingCode | null {
    return takePendingCode(code);
  }

  // -------------------------------------------------------------------------
  // Consent management
  // -------------------------------------------------------------------------

  getConsent(clientId: string, userId: number): string[] | null {
    const row = this.db.get<{ scopes: string }>(
      'SELECT scopes FROM oauth_consents WHERE client_id = ? AND user_id = ?', clientId, userId,
    );
    return row ? JSON.parse(row.scopes) : null;
  }

  saveConsent(clientId: string, userId: number, scopes: string[], ip?: string | null): void {
    // Union existing consent with newly approved scopes (M5: never narrow stored consent)
    const existing = this.getConsent(clientId, userId) ?? [];
    const merged = Array.from(new Set([...existing, ...scopes]));
    this.db.run(
      'INSERT OR REPLACE INTO oauth_consents (client_id, user_id, scopes, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      clientId, userId, JSON.stringify(merged),
    );
    this.audit.writeAudit({ userId, action: 'oauth.consent.grant', details: { client_id: clientId, scopes: merged }, ip });
  }

  isConsentSufficient(existingScopes: string[], requestedScopes: string[]): boolean {
    return requestedScopes.every(s => existingScopes.includes(s));
  }

  // -------------------------------------------------------------------------
  // Token issuance
  // -------------------------------------------------------------------------

  issueTokens(
    clientId: string,
    userId: number,
    scopes: string[],
    parentTokenId: number | null = null,
    audience: string | null = null,
  ): {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    scope: string;
  } {
    const rawAccess   = generateAccessToken();
    const rawRefresh  = generateRefreshToken();
    const accessHash  = hashToken(rawAccess);
    const refreshHash = hashToken(rawRefresh);

    const now           = new Date();
    const accessExpiry  = new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000);
    const refreshExpiry = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    this.db.run(`
      INSERT INTO oauth_tokens
        (client_id, user_id, access_token_hash, refresh_token_hash, scopes, audience, access_token_expires_at, refresh_token_expires_at, parent_token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, clientId, userId, accessHash, refreshHash, JSON.stringify(scopes), audience, accessExpiry.toISOString(), refreshExpiry.toISOString(), parentTokenId);

    return {
      access_token:  rawAccess,
      refresh_token: rawRefresh,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL_S,
      scope:         scopes.join(' '),
    };
  }

  /**
   * Issues an access token only — no refresh token (RFC 6749 §4.4.3).
   * Used exclusively for the client_credentials grant. A random opaque hash is
   * stored in refresh_token_hash to satisfy the NOT NULL/UNIQUE constraint; it
   * can never be presented as a valid refresh token (same precedent as public
   * client secret hashes stored in client_secret_hash).
   */
  issueClientCredentialsToken(
    clientId: string,
    userId: number,
    scopes: string[],
    audience: string,
  ): {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    scope: string;
  } {
    const rawAccess       = generateAccessToken();
    const accessHash      = hashToken(rawAccess);
    const placeholderHash = randomBytes(32).toString('hex');

    const now         = new Date();
    const accessExpiry = new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000);

    this.db.run(`
      INSERT INTO oauth_tokens
        (client_id, user_id, access_token_hash, refresh_token_hash, scopes, audience, access_token_expires_at, refresh_token_expires_at, parent_token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, clientId, userId, accessHash, placeholderHash, JSON.stringify(scopes), audience, accessExpiry.toISOString(), now.toISOString(), null);

    return {
      access_token: rawAccess,
      token_type:   'Bearer',
      expires_in:   ACCESS_TOKEN_TTL_S,
      scope:        scopes.join(' '),
    };
  }

  // -------------------------------------------------------------------------
  // Token verification (used by MCP handler on every request)
  // -------------------------------------------------------------------------

  /** SDK clients-store read: the exact row shape the MCP SDK adapter
   *  (oauth-sdk.provider.ts) maps to OAuthClientInformationFull. */
  getSdkClient(clientId: string): {
    client_id: string;
    name: string;
    redirect_uris: string;
    allowed_scopes: string;
    is_public: number;
    created_via: string;
  } | undefined {
    return this.db.get(
      'SELECT client_id, name, redirect_uris, allowed_scopes, is_public, created_via FROM oauth_clients WHERE client_id = ?',
      clientId,
    );
  }

  getUserByAccessToken(rawToken: string): OAuthTokenInfo | null {
    const hash = hashToken(rawToken);
    const row = this.db.get<OAuthTokenRow & { username: string; email: string; role: string }>(`
      SELECT ot.scopes, ot.audience, ot.revoked_at, ot.access_token_expires_at,
             ot.user_id, ot.client_id, u.username, u.email, u.role
      FROM oauth_tokens ot
      JOIN users u ON ot.user_id = u.id
      WHERE ot.access_token_hash = ?
    `, hash);

    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.access_token_expires_at) < new Date()) return null;

    return {
      user: { id: row.user_id, username: row.username, email: row.email, role: row.role as 'admin' | 'user' },
      scopes: JSON.parse(row.scopes),
      clientId: row.client_id,
      audience: row.audience ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Token refresh (rotation + replay detection)
  // -------------------------------------------------------------------------

  /** Walk parent_token_id upward to find the root token id of this rotation chain. */
  private findChainRoot(tokenId: number): number {
    let current = tokenId;
    for (let i = 0; i < 100; i++) {
      const row = this.db.get<{ id: number; parent_token_id: number | null }>('SELECT id, parent_token_id FROM oauth_tokens WHERE id = ?', current);
      if (!row || row.parent_token_id === null) return current;
      current = row.parent_token_id;
    }
    return current;
  }

  /** Revoke all tokens in the rotation chain rooted at rootId. Returns affected ids. */
  private revokeChain(rootId: number): number[] {
    const rows = this.db.all<{ id: number }>(`
      WITH RECURSIVE chain(id) AS (
        SELECT id FROM oauth_tokens WHERE id = ?
        UNION ALL
        SELECT t.id FROM oauth_tokens t JOIN chain c ON t.parent_token_id = c.id
      )
      SELECT id FROM chain
    `, rootId);
    const ids = rows.map(r => r.id);
    if (ids.length > 0) {
      this.db.run(
        `UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')}) AND revoked_at IS NULL`,
        ...ids,
      );
    }
    return ids;
  }

  /**
   * True when a revoked refresh token is the loser of a concurrent rotation
   * rather than a replayed one.
   *
   * Two conditions, and both matter. The revocation has to be recent, and it has
   * to have produced a successor that is still alive. The second one is what
   * keeps the window from re-opening a session someone deliberately closed: an
   * explicit revoke leaves no live child, and a chain revoked after a real replay
   * has every child revoked with it, so neither can slip through here.
   */
  private isConcurrentRotation(row: OAuthTokenRow): boolean {
    const revokedAt = parseSqliteUtc(row.revoked_at);
    if (!revokedAt) return false;
    if (Date.now() - revokedAt.getTime() > REFRESH_ROTATION_GRACE_MS) return false;
    const successor = this.db.get<{ id: number }>(
      'SELECT id FROM oauth_tokens WHERE parent_token_id = ? AND revoked_at IS NULL LIMIT 1',
      row.id,
    );
    return !!successor;
  }

  refreshTokens(
    rawRefreshToken: string,
    clientId: string,
    clientSecret: string | undefined,
    ip?: string | null,
  ): { error?: string; status?: number; tokens?: ReturnType<OauthService['issueTokens']> } {
    const client = this.db.get<OAuthClientRow>('SELECT client_id, client_secret_hash, is_public FROM oauth_clients WHERE client_id = ?', clientId);
    if (!client) return { error: 'invalid_client', status: 401 };
    if (!client.is_public) {
      if (!clientSecret || !timingSafeEqualHex(hashToken(clientSecret), client.client_secret_hash)) {
        return { error: 'invalid_client', status: 401 };
      }
    }

    const hash = hashToken(rawRefreshToken);
    const row = this.db.get<OAuthTokenRow>(`
      SELECT id, client_id, user_id, scopes, audience, refresh_token_expires_at, revoked_at, parent_token_id
      FROM oauth_tokens WHERE refresh_token_hash = ?
    `, hash);

    if (!row) return { error: 'invalid_grant', status: 400 };
    if (row.client_id !== clientId) return { error: 'invalid_grant', status: 400 };

    // ---- Replay detection (C3) ----
    if (row.revoked_at) {
      // …unless the rotation that revoked it happened seconds ago and produced a
      // successor that is still alive. That is two clients refreshing at once,
      // not theft (#1007): they share one token, both post it, and the loser used
      // to take the whole chain down with it. Issue a sibling pair off the same
      // parent so each client walks away with its own token.
      if (this.isConcurrentRotation(row)) {
        const tokens = this.issueTokens(clientId, row.user_id, JSON.parse(row.scopes), row.id, row.audience ?? null);
        this.audit.writeAudit({
          userId: row.user_id,
          action: 'oauth.token.refresh',
          details: { client_id: clientId, concurrent: true },
          ip,
        });
        return { tokens };
      }

      // A revoked refresh token was replayed — assume token theft. Cascade-revoke the chain.
      const rootId = this.findChainRoot(row.id);
      this.revokeChain(rootId);

      revokeUserSessionsForClient(row.user_id, clientId);

      this.audit.writeAudit({
        userId: row.user_id,
        action: 'oauth.token.replay_detected',
        details: { client_id: clientId },
        ip,
      });
      logWarn(`[OAuth] Refresh token replay detected for user=${row.user_id} client=${clientId} ip=${ip ?? '-'}`);

      return { error: 'invalid_grant', status: 400 };
    }

    if (new Date(row.refresh_token_expires_at) < new Date()) return { error: 'invalid_grant', status: 400 };

    // Revoke old pair immediately (rotation) and issue new pair linked to old row.
    // Do NOT revoke active MCP sessions here: a legitimate refresh isn't a security
    // event (that's handled above, in the replay-detection branch), and mcpHandler
    // already re-validates session.userId/clientId against the new token on every
    // request. Killing the session on every routine hourly refresh broke long-lived
    // MCP connections (#1475).
    this.db.run('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);

    const tokens = this.issueTokens(clientId, row.user_id, JSON.parse(row.scopes), row.id, row.audience ?? null);
    this.audit.writeAudit({ userId: row.user_id, action: 'oauth.token.refresh', details: { client_id: clientId }, ip });

    return { tokens };
  }

  // -------------------------------------------------------------------------
  // Token revocation
  // -------------------------------------------------------------------------

  revokeToken(rawToken: string, clientId: string, userId?: number, ip?: string | null): void {
    const hash = hashToken(rawToken);

    // Get the user_id for the token so we can revoke its MCP sessions
    const row = this.db.get<{ user_id: number }>(
      'SELECT user_id FROM oauth_tokens WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND client_id = ?',
      hash, hash, clientId,
    );

    this.db.run(`
      UPDATE oauth_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND client_id = ?
    `, hash, hash, clientId);

    const affectedUserId = row?.user_id ?? userId;
    if (affectedUserId) {
      revokeUserSessionsForClient(affectedUserId, clientId);
      this.audit.writeAudit({ userId: affectedUserId, action: 'oauth.token.revoke', details: { client_id: clientId, method: 'token' }, ip });
    }
  }

  // -------------------------------------------------------------------------
  // Active session listing (for user settings page)
  // -------------------------------------------------------------------------

  listOAuthSessions(userId: number): Record<string, unknown>[] {
    const rows = this.db.all<Record<string, unknown>>(`
      SELECT ot.id, ot.client_id, oc.name AS client_name, ot.scopes,
             ot.access_token_expires_at, ot.refresh_token_expires_at, ot.created_at
      FROM oauth_tokens ot
      JOIN oauth_clients oc ON ot.client_id = oc.client_id
      WHERE ot.user_id = ?
        AND ot.revoked_at IS NULL
        AND ot.refresh_token_expires_at > CURRENT_TIMESTAMP
      ORDER BY ot.created_at DESC
    `, userId);
    return rows.map(r => ({ ...r, scopes: JSON.parse(r.scopes as string) }));
  }

  revokeSession(
    userId: number,
    sessionId: number,
    ip?: string | null,
  ): { error?: string; status?: number; success?: boolean } {
    const row = this.db.get<{ id: number; client_id: string }>('SELECT id, client_id FROM oauth_tokens WHERE id = ? AND user_id = ?', sessionId, userId);
    if (!row) return { error: 'Session not found', status: 404 };

    this.db.run('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', sessionId);

    revokeUserSessionsForClient(userId, row.client_id);

    this.audit.writeAudit({ userId, action: 'oauth.token.revoke', details: { client_id: row.client_id, method: 'session' }, ip });

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Authorize request validation (option A: called by SPA via GET /api/oauth/authorize/validate)
  // -------------------------------------------------------------------------

  validateAuthorizeRequest(
    params: AuthorizeParams,
    userId: number | null,
  ): ValidateAuthorizeResult {
    if (!this.addons.isAddonEnabled(ADDON_IDS.MCP)) {
      return { valid: false, error: 'mcp_disabled', error_description: 'MCP is not enabled on this server' };
    }

    if (params.response_type !== 'code') {
      return { valid: false, error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' };
    }

    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      return { valid: false, error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required (OAuth 2.1)' };
    }

    // H1: Enforce code_challenge format (RFC 7636 §4.2)
    if (!CODE_CHALLENGE_RE.test(params.code_challenge)) {
      return { valid: false, error: 'invalid_request', error_description: 'code_challenge must be 43 base64url characters (S256)' };
    }

    if (!params.client_id) {
      return { valid: false, error: 'invalid_request', error_description: 'client_id is required' };
    }

    const client = this.db.get<OAuthClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', params.client_id);
    if (!client) {
      return { valid: false, error: 'invalid_client', error_description: 'Unknown client_id' };
    }

    const allowedUris: string[] = JSON.parse(client.redirect_uris);
    // Exact match except for the loopback port, which RFC 8252 §7.3 leaves to
    // the OS, and which the SDK's authorize handler already relaxes, so a
    // native client got a 302 to consent and an invalid_redirect_uri from this
    // route for one and the same request (#2227).
    const requestedUri = params.redirect_uri;
    if (!requestedUri || !allowedUris.some(allowed => redirectUriMatches(allowed, requestedUri))) {
      return { valid: false, error: 'invalid_redirect_uri', error_description: 'redirect_uri does not match any registered URI' };
    }

    // RFC 8707 resource indicator: if provided, must identify the TREK
    // MCP endpoint exactly. If the client didn't supply `resource`, we
    // bind the token to the MCP endpoint by default — previously this
    // left `audience = null`, and the audience-bind check on MCP requests
    // then treated a null audience as "valid for any resource".
    // The lookbehind matches only the first slash of the trailing run. Without it the
    // engine retries from every slash, which is quadratic on a slash-heavy value.
    const mcpResource = `${getMcpSafeUrl().replace(/(?<!\/)\/+$/, '')}/mcp`;
    const resource = params.resource
      ? params.resource.replace(/(?<!\/)\/+$/, '')
      : mcpResource;
    if (resource !== mcpResource) {
      return { valid: false, error: 'invalid_target', error_description: 'Requested resource must be the TREK MCP endpoint' };
    }

    const requestedScopes = (params.scope || '').split(' ').filter(Boolean);
    if (requestedScopes.length === 0) {
      return { valid: false, error: 'invalid_scope', error_description: 'At least one scope is required' };
    }

    const allowedScopes: string[] = JSON.parse(client.allowed_scopes);
    // Narrow to the intersection: drop scopes the client isn't permitted for rather
    // than rejecting the whole request (per OAuth 2.0 §3.3 scope narrowing).
    const grantedScopes = requestedScopes.filter(s => allowedScopes.includes(s));
    if (grantedScopes.length === 0) {
      return { valid: false, error: 'invalid_scope', error_description: 'None of the requested scopes are permitted for this client' };
    }

    if (userId === null) {
      // H3: return only the minimum required fields — do NOT expose scopes, client.name, or
      // allowed_scopes to unauthenticated callers to prevent client enumeration.
      return { valid: true, loginRequired: true };
    }

    const existingConsent = this.getConsent(params.client_id, userId);
    const consentRequired = !existingConsent || !this.isConsentSufficient(existingConsent, grantedScopes);

    return {
      valid: true,
      client: { name: client.name, allowed_scopes: allowedScopes },
      scopes: grantedScopes,
      resource: resource ?? mcpResource,
      consentRequired,
      scopeSelectable: client.created_via === 'dcr',
    };
  }

  // -------------------------------------------------------------------------
  // PKCE verification
  // -------------------------------------------------------------------------

  verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
    // H1: validate code_verifier format before hashing
    if (!CODE_VERIFIER_RE.test(codeVerifier)) return false;

    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    // Constant-time compare (both are base64url strings of equal length for S256)
    if (expected.length !== codeChallenge.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(codeChallenge));
    } catch { return false; }
  }

  // -------------------------------------------------------------------------
  // Client authentication (for token endpoint)
  // -------------------------------------------------------------------------

  authenticateClient(clientId: string, clientSecret: string | undefined): OAuthClientRow | null {
    const client = this.db.get<OAuthClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
    if (!client) return null;
    if (client.is_public) {
      // Public clients are identified by client_id alone — PKCE provides the security guarantee.
      return client;
    }
    // H4: constant-time comparison to prevent timing side-channel
    if (!clientSecret) return null;
    if (!timingSafeEqualHex(hashToken(clientSecret), client.client_secret_hash)) return null;
    return client;
  }
  // ---------------------------------------------------------------------------
  // Admin view of live sessions
  //
  // Moved from AdminService, which owned the oauth_tokens SQL only because the
  // panel route is under /api/admin. The route keeps its path and its guard.
  // ---------------------------------------------------------------------------

  listAllOAuthSessions() {
    const rows = this.db.all<Record<string, unknown> & { scopes: string }>(`
    SELECT ot.id, ot.client_id, oc.name AS client_name, ot.user_id, u.username,
           ot.scopes, ot.access_token_expires_at, ot.refresh_token_expires_at, ot.created_at
    FROM oauth_tokens ot
    JOIN oauth_clients oc ON ot.client_id = oc.client_id
    JOIN users u ON u.id = ot.user_id
    WHERE ot.revoked_at IS NULL
      AND ot.refresh_token_expires_at > CURRENT_TIMESTAMP
    ORDER BY ot.created_at DESC
  `);
    // One malformed row must not 500 the whole admin OAuth-sessions panel.
    return rows.map((r) => {
      let scopes: unknown;
      try {
        scopes = JSON.parse(r.scopes);
      } catch {
        scopes = null;
      }
      return { ...r, scopes };
    });
  }

  adminRevokeOAuthSession(id: string) {
    const row = this.db.get<{ id: number; user_id: number; client_id: string }>(
      'SELECT id, user_id, client_id FROM oauth_tokens WHERE id = ?', id,
    );
    if (!row) return { error: 'Session not found', status: 404 };
    this.db.run('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', id);
    revokeUserSessionsForClient(row.user_id, row.client_id);
    return {};
  }
}
