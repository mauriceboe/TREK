import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { encrypt_api_key, decrypt_api_key } from '../../common/crypto/apiKeyCrypto';
import { applySettingDefaults, settingDefaults } from '../settings-defaults';
import { getAppUrl } from '../../../app-config';
import { isPrivateIp } from '../install/safe-fetch';
import { safeFetchAdminConfigured } from '../../../utils/ssrfGuard';

/**
 * Host-brokered outbound OAuth (#plugins). A plugin becomes an OAuth *client* of a
 * third-party service; the HOST runs the whole flow (authorize -> callback -> token
 * exchange -> refresh) with PKCE + state and HOLDS the tokens. The plugin only ever
 * triggers "connect" and reads a short-lived access token via `ctx.oauth.getAccessToken()`
 * — it never sees the refresh token or the client secret.
 *
 * Provider config (endpoints + client credentials) is the plugin's admin-owned
 * INSTANCE settings — a plugin declares these `scope:'instance'` fields and the admin
 * fills them in:
 *   oauth_authorize_url, oauth_token_url, oauth_scopes (optional), and the two secrets
 *   oauth_client_id, oauth_client_secret.
 * Tokens are per-user + encrypted at rest; the PKCE verifier/state row is short-lived.
 */
export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // an authorize round-trip must finish within 10 min
const REFRESH_SKEW_S = 60; // refresh a token expiring within a minute

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Cheap fast-fail for an obviously-internal token endpoint. This is a pre-check, not the
 * authoritative gate: the real SSRF defence is the DNS-resolving, IP-pinning guard inside
 * the fetch (tokenRequest), which blocks the cloud-metadata range even for a DNS name. This
 * rejects the literal loopback / link-local / metadata hosts (v4 AND v6) plus the internal
 * name suffixes, so a bracketed IPv6 literal or a `.internal` name can't slip past the
 * fast-fail. Private LAN (10./192.168./…) is deliberately left to the fetch policy so a
 * self-hosted internal IdP stays reachable. */
function assertSafeHttps(urlStr: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`${what} must be https`);
  const host = u.hostname.toLowerCase();
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const loopbackOrMeta =
    ip === '::1' || ip.startsWith('127.') || ip.startsWith('0.') ||
    ip.startsWith('169.254.') || /^fe[89ab][0-9a-f]:/.test(ip) || ip.startsWith('fd00:ec2:');
  if (loopbackOrMeta) throw new Error(`${what} may not point at a loopback or metadata address`);
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`${what} may not point at a local address`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIp(host)) throw new Error(`${what} may not point at a private address`);
  return u;
}

@Injectable()
export class PluginOAuthService {
  constructor(private readonly dbs: DatabaseService) {}

  private get db() {
    return this.dbs.connection;
  }

  /** The plugin's decrypted OAuth provider config from its INSTANCE settings, or null
   *  when any required piece is missing/blank. */
  providerConfig(pluginId: string): OAuthProviderConfig | null {
    const row = this.db.prepare('SELECT config FROM plugins WHERE id = ?').get(pluginId) as { config: string } | undefined;
    if (!row) return null;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.config || '{}');
    } catch {
      return null;
    }
    // A provider plugin ships its endpoints/scopes as manifest defaults; the admin types
    // only the client id/secret (secrets — never defaulted).
    cfg = applySettingDefaults(cfg, settingDefaults(this.db, pluginId, 'instance'));
    const authorizeUrl = String(cfg.oauth_authorize_url ?? '').trim();
    const tokenUrl = String(cfg.oauth_token_url ?? '').trim();
    const clientId = cfg.oauth_client_id ? String(decrypt_api_key(cfg.oauth_client_id)) : '';
    const clientSecret = cfg.oauth_client_secret ? String(decrypt_api_key(cfg.oauth_client_secret)) : '';
    const scopes = String(cfg.oauth_scopes ?? '').trim();
    if (!authorizeUrl || !tokenUrl || !clientId || !clientSecret) return null;
    return { authorizeUrl, tokenUrl, scopes, clientId, clientSecret };
  }

  private redirectUri(pluginId: string): string {
    return `${getAppUrl()}/api/plugin-oauth/${pluginId}/callback`;
  }

  /** Whether the acting user has a stored token for this plugin. */
  status(pluginId: string, userId: number): { configured: boolean; connected: boolean } {
    const configured = this.providerConfig(pluginId) !== null;
    const tok = this.db.prepare('SELECT 1 FROM plugin_oauth_tokens WHERE plugin_id = ? AND user_id = ? AND access_token IS NOT NULL').get(pluginId, userId);
    return { configured, connected: !!tok };
  }

  /** Begin the authorize flow: mint PKCE + state, persist them, return the provider URL. */
  startConnect(pluginId: string, userId: number, nowMs: number): string {
    const cfg = this.providerConfig(pluginId);
    if (!cfg) throw new Error('OAuth is not configured for this plugin');
    const authorize = assertSafeHttps(cfg.authorizeUrl, 'authorize_url');
    assertSafeHttps(cfg.tokenUrl, 'token_url'); // fail fast if the token endpoint is unsafe too

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));

    // Drop this user's stale states for the plugin, then store the fresh one.
    this.db.prepare('DELETE FROM plugin_oauth_state WHERE plugin_id = ? AND user_id = ?').run(pluginId, userId);
    this.db.prepare('INSERT INTO plugin_oauth_state (state, plugin_id, user_id, verifier, created_at) VALUES (?, ?, ?, ?, ?)').run(
      state,
      pluginId,
      userId,
      verifier,
      nowMs,
    );

    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', cfg.clientId);
    authorize.searchParams.set('redirect_uri', this.redirectUri(pluginId));
    if (cfg.scopes) authorize.searchParams.set('scope', cfg.scopes);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    return authorize.toString();
  }

  /** Complete the callback: verify state, exchange the code, store the tokens. */
  async completeCallback(pluginId: string, userId: number, code: string, state: string, nowMs: number): Promise<void> {
    const row = this.db.prepare('SELECT verifier, user_id, created_at FROM plugin_oauth_state WHERE state = ? AND plugin_id = ?').get(state, pluginId) as
      | { verifier: string; user_id: number; created_at: number }
      | undefined;
    // State must exist, belong to THIS user, and be fresh — this binds the callback to
    // the connect request and blocks CSRF / a replayed/foreign state.
    if (!row || row.user_id !== userId || nowMs - row.created_at > STATE_TTL_MS) {
      this.db.prepare('DELETE FROM plugin_oauth_state WHERE state = ?').run(state);
      throw new Error('invalid or expired OAuth state');
    }
    this.db.prepare('DELETE FROM plugin_oauth_state WHERE state = ?').run(state); // single-use

    const cfg = this.providerConfig(pluginId);
    if (!cfg) throw new Error('OAuth is not configured for this plugin');

    const token = await this.tokenRequest(cfg, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(pluginId),
      code_verifier: row.verifier,
    });
    this.storeToken(pluginId, userId, token, nowMs);
  }

  /** A valid access token for the acting user, refreshing it if it is expiring. Null when
   *  the user hasn't connected. The plugin never receives the refresh token. */
  async getAccessToken(pluginId: string, userId: number, nowMs: number): Promise<string | null> {
    const row = this.db.prepare('SELECT access_token, refresh_token, expires_at FROM plugin_oauth_tokens WHERE plugin_id = ? AND user_id = ?').get(pluginId, userId) as
      | { access_token: string | null; refresh_token: string | null; expires_at: number | null }
      | undefined;
    if (!row || !row.access_token) return null;

    const notExpiring = row.expires_at == null || row.expires_at - REFRESH_SKEW_S * 1000 > nowMs;
    if (notExpiring) return decrypt_api_key(row.access_token) as string;

    if (!row.refresh_token) return decrypt_api_key(row.access_token) as string; // no refresh token — hand back what we have
    const cfg = this.providerConfig(pluginId);
    if (!cfg) return null;
    const token = await this.tokenRequest(cfg, {
      grant_type: 'refresh_token',
      refresh_token: decrypt_api_key(row.refresh_token) as string,
    });
    // Some providers omit a new refresh_token on refresh — keep the existing one.
    if (!token.refresh_token) token.refresh_token = decrypt_api_key(row.refresh_token) as string;
    this.storeToken(pluginId, userId, token, nowMs);
    return token.access_token ?? null;
  }

  disconnect(pluginId: string, userId: number): void {
    this.db.prepare('DELETE FROM plugin_oauth_tokens WHERE plugin_id = ? AND user_id = ?').run(pluginId, userId);
    this.db.prepare('DELETE FROM plugin_oauth_state WHERE plugin_id = ? AND user_id = ?').run(pluginId, userId);
  }

  // --- internals ---

  private async tokenRequest(cfg: OAuthProviderConfig, params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    assertSafeHttps(cfg.tokenUrl, 'token_url');
    const body = new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret });
    // Route the server-side token POST through the SSRF guard: it resolves the host
    // and refuses the link-local / cloud-metadata range (169.254/fe80/IMDSv6) while
    // pinning the connection to the resolved IP, so a token_url that is a DNS name
    // (or IPv6 literal) pointing at metadata can't reach it and can't DNS-rebind.
    // Loopback/LAN stay reachable so a self-hosted internal IdP keeps working.
    const resp = await safeFetchAdminConfigured(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`token endpoint returned ${resp.status}`);
    const json = (await resp.json()) as Record<string, unknown>;
    return {
      access_token: typeof json.access_token === 'string' ? json.access_token : undefined,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
      scope: typeof json.scope === 'string' ? json.scope : undefined,
    };
  }

  private storeToken(pluginId: string, userId: number, token: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }, nowMs: number): void {
    if (!token.access_token) throw new Error('token endpoint returned no access_token');
    const expiresAt = token.expires_in ? nowMs + token.expires_in * 1000 : null;
    this.db.prepare(
      `INSERT INTO plugin_oauth_tokens (plugin_id, user_id, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(plugin_id, user_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, plugin_oauth_tokens.refresh_token),
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
    ).run(
      pluginId,
      userId,
      encrypt_api_key(token.access_token),
      token.refresh_token ? encrypt_api_key(token.refresh_token) : null,
      expiresAt,
      token.scope ?? null,
    );
  }
}
