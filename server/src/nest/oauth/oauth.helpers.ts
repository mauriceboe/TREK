import crypto, { createHash, randomBytes } from 'crypto';

/** Pure helpers and row shapes for the OAuth 2.1 domain — no DB, no DI. */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL_S = 60 * 60;                  // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days rolling

/**
 * How long a just-rotated refresh token still counts as "in flight" rather than
 * as a replay (#1007).
 *
 * Rotation is a race by construction: two clients sharing one token — several
 * MCP sessions, a client that retried after a timeout — can present it within
 * the same second. Without leeway the second one is read as theft and the whole
 * chain is revoked, which is why a handful of MCP tabs would all pop a login
 * window every day. RFC 9700 §4.14.2 names exactly this and asks for a short
 * grace period. Short is the point: it is measured from the *first* rotation and
 * does not slide, so a stolen token still gets caught as soon as it is used
 * outside the window.
 */
export const REFRESH_ROTATION_GRACE_MS = 30 * 1000;

/** SQLite writes CURRENT_TIMESTAMP as UTC without a zone; JS would read it as local. */
export function parseSqliteUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const iso = ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// PKCE format (RFC 7636)
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

// ---------------------------------------------------------------------------
// Redirect URI validation (RFC 8252)
// ---------------------------------------------------------------------------

/**
 * The three loopback hosts of RFC 8252 §7.3, and exactly the set the MCP SDK's
 * authorize handler matches on. Registration and authorization have to agree on
 * this list or a client registers a URI it can never authorize with (#2227).
 */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Schemes a browser must never be redirected to: script-executing
 * (javascript:, vbscript:, data:), local-resource (file:, filesystem:,
 * resource:, jar:, view-source:, blob:, about:), and extension or OS handlers
 * that reach code outside the page (chrome-extension:, moz-extension:,
 * safari-extension:, ms-msdt:, which is the Follina handler).
 *
 * Most of these were only ever blocked as a side effect of the old "a custom
 * scheme must contain a dot" rule; dropping that rule to admit workbuddy://
 * (#2227) would otherwise have admitted them too. `intent:` is denied with
 * them: Chrome follows its S.browser_fallback_url parameter, which turns any
 * accepted intent:// redirect into an open redirect. Android apps that need a
 * redirect register a private-use scheme or an https App Link instead.
 */
const DANGEROUS_REDIRECT_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'chrome:', 'chrome-extension:',
  'view-source:', 'filesystem:', 'resource:', 'jar:', 'moz-extension:', 'safari-extension:',
  'chrome-search:', 'chrome-untrusted:', 'ms-browser-extension:', 'ms-msdt:', 'android-app:',
  'intent:', 'search-ms:', 'shell:', 'microsoft-edge:', 'itms-services:',
]);

/**
 * Everything under `ms-` is a Windows protocol handler (ms-settings:,
 * ms-search:, ms-officecmd:, …), never a redirect target, and the namespace
 * grows with every Windows release, so deny the prefix rather than chase it.
 * Microsoft's own identity redirects use msauth:/msal…: and stay allowed.
 */
const DANGEROUS_SCHEME_PREFIX = 'ms-';

/** Transports that are not browser navigations, so never a redirect target. */
const NON_REDIRECT_SCHEMES = new Set([
  'ws:', 'wss:', 'ftp:', 'ftps:', 'mailto:', 'tel:', 'sms:', 'urn:',
]);

export type RedirectUriVerdict = 'ok' | 'malformed' | 'dangerous' | 'not_allowed';

/**
 * The single redirect_uri policy for both registration paths, DCR
 * (POST /oauth/register) and the settings UI (POST /api/oauth/clients), which
 * used to disagree: DCR refused every single-label private-use scheme while the
 * settings route accepted javascript://localhost/… (#2227).
 *
 * Decisions are made on `url.protocol`, never on the raw string: the WHATWG
 * parser lowercases the scheme and strips tabs, newlines and leading spaces, so
 * 'JavaScript:', 'java\tscript:' and ' javascript:' all normalise into the
 * deny-list instead of sliding past it.
 */
export function classifyRedirectUri(uri: string): RedirectUriVerdict {
  let url: URL;
  try { url = new URL(uri); } catch { return 'malformed'; }

  const protocol = url.protocol;
  if (DANGEROUS_REDIRECT_SCHEMES.has(protocol) || protocol.startsWith(DANGEROUS_SCHEME_PREFIX)) return 'dangerous';
  if (NON_REDIRECT_SCHEMES.has(protocol)) return 'not_allowed';
  if (protocol === 'https:') return 'ok';
  if (protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? 'ok' : 'not_allowed';

  // Private-use schemes (RFC 8252 §7.1). The reverse-domain form is a SHOULD,
  // not a MUST, and requiring a dot bought nothing: 'javascript.evil://x'
  // passed it while 'workbuddy://…' did not. Two characters minimum so a
  // Windows path (c:\tmp\cb) is not read as a scheme.
  const scheme = protocol.slice(0, -1);
  return /^[a-z][a-z0-9+.-]+$/i.test(scheme) ? 'ok' : 'not_allowed';
}

/**
 * Byte-exact, with the one relaxation RFC 8252 §7.3 requires: a native client
 * registers a loopback URI with a placeholder port and then authorizes on the
 * port the OS handed it, so the port (and only the port) is ignored when both
 * sides are loopback HTTP. The MCP SDK's authorize handler already relaxes it;
 * TREK's matcher did not, so the SDK redirected to consent and the validate
 * route then answered invalid_redirect_uri for the same request (#2227).
 *
 * Nothing else is normalised anywhere in the chain: the stored URI is compared
 * as it was registered, percent-encoding included.
 */
export function redirectUriMatches(allowed: string, requested: string): boolean {
  if (allowed === requested) return true;

  let a: URL, r: URL;
  try {
    a = new URL(allowed);
    r = new URL(requested);
  } catch { return false; }

  if (a.protocol !== 'http:' || r.protocol !== 'http:') return false;
  if (!LOOPBACK_HOSTS.has(a.hostname) || !LOOPBACK_HOSTS.has(r.hostname)) return false;
  // Only the port is free. The RFC does not allow localhost↔127.0.0.1 either, and
  // userinfo and fragment are compared too: the URL parser would otherwise drop
  // them silently and let 'http://attacker@127.0.0.1:1/cb#x' match a bare
  // 'http://127.0.0.1:8080/cb'.
  return a.hostname === r.hostname
    && a.pathname === r.pathname
    && a.search === r.search
    && a.hash === r.hash
    && a.username === r.username
    && a.password === r.password;
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

export interface OAuthClientRow {
  id: string;
  user_id: number;
  name: string;
  client_id: string;
  client_secret_hash: string;
  redirect_uris: string;   // JSON array
  allowed_scopes: string;  // JSON array
  created_at: string;
  is_public: number;       // 0 | 1 (SQLite boolean)
  created_via: string;     // 'settings_ui' | 'browser-registration'
  allows_client_credentials: number; // 0 | 1
}

export interface OAuthTokenRow {
  id: number;
  client_id: string;
  user_id: number;
  access_token_hash: string;
  refresh_token_hash: string;
  scopes: string;           // JSON array
  audience: string | null;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  revoked_at: string | null;
  parent_token_id: number | null;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Constant-time comparison of two hex-encoded SHA-256 hashes. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch { return false; }
}

export function generateAccessToken(): string {
  return 'trekoa_' + randomBytes(32).toString('hex');
}

export function generateRefreshToken(): string {
  return 'trekrf_' + randomBytes(32).toString('hex');
}
