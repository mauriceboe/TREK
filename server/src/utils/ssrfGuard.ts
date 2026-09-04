import dns from 'node:dns/promises';
import { Agent } from 'undici';
import { readEnv } from '../app-config';
import { embeddedTransitionIpv4, expandIpv6 } from './ipv6';

// Frozen at import on purpose (legacy timing; tests reload the module to change it).
const ALLOW_INTERNAL_NETWORK = readEnv().net.allowInternalNetwork;

export interface SsrfResult {
  allowed: boolean;
  resolvedIp?: string;
  isPrivate: boolean;
  error?: string;
}

/**
 * The IPv4 an IPv4-mapped address (`::ffff:a.b.c.d`) stands for, or null.
 *
 * Taken from the hextets rather than from the text, because `::ffff:127.0.0.1`
 * and `::ffff:7f00:1` are one address in two spellings and `dns.lookup` picks
 * which one comes back. The prefix regexes this replaces covered the dotted
 * spelling of two ranges; every other mapped address walked past them.
 */
function mappedIpv4(hextets: number[]): string | null {
  const g = hextets;
  if (g[0] || g[1] || g[2] || g[3] || g[4] || g[5] !== 0xffff) return null;
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

// Always blocked — no override possible
function isAlwaysBlocked(ip: string): boolean {
  // Strip IPv6 brackets
  const addr = ip.startsWith('[') ? ip.slice(1, -1) : ip;

  // Loopback
  if (addr.startsWith('127.') || addr === '::1') return true;
  // Unspecified
  if (addr.startsWith('0.')) return true;
  // Link-local / cloud metadata
  if (addr.startsWith('169.254.')) return true;

  const hextets = expandIpv6(addr);
  if (hextets) {
    // The IPv6 unspecified address. Connecting to it lands on loopback, so it
    // reaches a local service without naming one, and it has enough spellings
    // (`::`, `::0`, `0:0:0:0:0:0:0:0`) that only the expanded hextets settle it.
    // The `0.` check above never saw any of them: they begin with a colon.
    if (hextets.every(h => h === 0)) return true;
    // fe80::/10 spans fe80: through febf:, not just the four characters 'fe80'.
    if ((hextets[0] & 0xffc0) === 0xfe80) return true;
    // A mapped address inherits the verdict of the IPv4 it carries.
    const mapped = mappedIpv4(hextets);
    if (mapped) return isAlwaysBlocked(mapped);
  }
  // IPv6 transition addresses (NAT64/6to4/Teredo) embedding a hard-blocked IPv4.
  const embedded = embeddedTransitionIpv4(addr);
  if (embedded) return isAlwaysBlocked(embedded);

  return false;
}

// Blocked unless ALLOW_INTERNAL_NETWORK=true
function isPrivateNetwork(ip: string): boolean {
  const addr = ip.startsWith('[') ? ip.slice(1, -1) : ip;

  // RFC-1918 private ranges
  if (addr.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (addr.startsWith('192.168.')) return true;
  // CGNAT / Tailscale shared address space (100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return true;
  // IPv6 ULA (fc00::/7)
  if (/^f[cd]/i.test(addr)) return true;
  // A mapped address inherits the verdict of the IPv4 it carries. Deciding on the
  // hextets rather than on three `::ffff:`-prefix regexes also covers the hex
  // spelling and the CGNAT range those regexes never listed.
  const hextets = expandIpv6(addr);
  const mapped = hextets && mappedIpv4(hextets);
  if (mapped) return isPrivateNetwork(mapped);
  // IPv6 transition addresses (NAT64/6to4/Teredo) embedding a private IPv4.
  const embedded = embeddedTransitionIpv4(addr);
  if (embedded) return isPrivateNetwork(embedded);

  return false;
}

function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost';
}

export async function checkSsrf(rawUrl: string, bypassInternalIpAllowed: boolean = false): Promise<SsrfResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, isPrivate: false, error: 'Invalid URL' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { allowed: false, isPrivate: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }

  const hostname = url.hostname.toLowerCase();

  // Resolve hostname to IP
  let resolvedIp: string;
  try {
    const result = await dns.lookup(hostname);
    resolvedIp = result.address;
  } catch (error_) {
    const code = error_ instanceof Error && 'code' in error_ ? String(error_.code) : 'unknown';
    return { allowed: false, isPrivate: false, error: `Could not resolve hostname (${code})` };
  }

  if (isAlwaysBlocked(resolvedIp)) {
    return {
      allowed: false,
      isPrivate: true,
      resolvedIp,
      error: 'Requests to loopback and link-local addresses are not allowed',
    };
  }

  if (isPrivateNetwork(resolvedIp) || isInternalHostname(hostname)) {
    if (!ALLOW_INTERNAL_NETWORK || bypassInternalIpAllowed) {
      return {
        allowed: false,
        isPrivate: true,
        resolvedIp,
        error:
          'Requests to private/internal network addresses are not allowed. Set ALLOW_INTERNAL_NETWORK=true to permit this for self-hosted setups.',
      };
    }
    return { allowed: true, isPrivate: true, resolvedIp };
  }

  return { allowed: true, isPrivate: false, resolvedIp };
}

/** Link-local / cloud-metadata addresses — never a legitimate model host. */
function isLinkLocal(ip: string): boolean {
  const addr = (ip.startsWith('[') ? ip.slice(1, -1) : ip).toLowerCase();
  // IPv4 link-local — AWS, GCP, Azure and OpenStack all serve credentials from 169.254.169.254.
  if (addr.startsWith('169.254.')) return true;
  // IPv4-mapped (::ffff:169.254.x) and IPv4-compatible (::a9fe:xxxx = ::169.254.x) spellings.
  if (/^::ffff:169\.254\./.test(addr) || /^::(ffff:)?a9fe:/.test(addr)) return true;
  // IPv6 link-local fe80::/10 — the whole range (fe80: … febf:), not just the fe80: prefix.
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  // AWS IMDSv6 sits in a fixed ULA slot; block it specifically while leaving the rest of
  // fc00::/7 reachable (a self-hosted model server may legitimately sit on a ULA address).
  if (addr === 'fd00:ec2::254' || addr.startsWith('fd00:ec2:')) return true;
  // Alibaba Cloud ECS metadata (100.100.100.200, and .100) lives in CGNAT space
  // (100.64.0.0/10), which safeFetchLlm otherwise allows for a LAN model server —
  // so block the specific metadata IPs directly rather than the whole range.
  if (addr === '100.100.100.200' || addr === '100.100.100.100') return true;
  // NAT64/6to4/Teredo embedding one of the above link-local/metadata IPs — extract
  // the embedded IPv4 and re-check. A transition address to a public or LAN IPv4
  // stays allowed (safeFetchLlm deliberately permits private/loopback targets).
  const embedded = embeddedTransitionIpv4(addr);
  if (embedded) return isLinkLocal(embedded);
  return false;
}

/**
 * SSRF-safe fetch for a user-configurable LLM endpoint. Unlike safeFetch() this
 * deliberately ALLOWS loopback and private/LAN targets — a local Ollama on
 * localhost or a model server on the LAN is the normal, supported config, so
 * blocking them would break a legitimate setup. It blocks only the link-local /
 * cloud-metadata range (169.254.0.0/16, fe80::/10, the AWS/Alibaba metadata IPs),
 * which is never a real LLM host but is the credential-theft SSRF target.
 *
 * Redirects are followed MANUALLY and re-validated on every hop. Checking only the
 * initial URL is not enough: a validated public endpoint can 302 to
 * `http://169.254.169.254/…`, and the DNS pin does NOT cover that hop — Node's
 * net.connect skips the pinned `lookup` for an IP-literal host, so a redirect to a
 * literal metadata IP would connect straight through. Following manually (like
 * safeFetchFollow) means each hop is re-resolved, re-checked against isLinkLocal,
 * and re-pinned. An http→https upgrade or a proxy redirect between LAN hosts still
 * works because the check re-runs per hop rather than locking to the first IP.
 *
 * `responseTimeoutMs` raises undici's own five-minute ceiling for callers that
 * legitimately wait longer (see safeFetchLlm). Left unset it keeps undici's
 * default, which is what every other admin-configured endpoint wants.
 */
export async function safeFetchAdminConfigured(
  url: string,
  init?: RequestInit,
  maxRedirects = 5,
  responseTimeoutMs?: number,
): Promise<Response> {
  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SsrfBlockedError('Invalid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new SsrfBlockedError('Only HTTP and HTTPS URLs are allowed');
    }
    let resolvedIp: string;
    try {
      resolvedIp = (await dns.lookup(parsed.hostname)).address;
    } catch (error_) {
      const code = error_ instanceof Error && 'code' in error_ ? String(error_.code) : 'unknown';
      throw new SsrfBlockedError(`Could not resolve hostname (${code})`);
    }
    if (isLinkLocal(resolvedIp)) {
      throw new SsrfBlockedError('Requests to link-local / cloud-metadata addresses are not allowed');
    }

    const dispatcher = createPinnedDispatcher(resolvedIp, true, responseTimeoutMs);
    const response = await fetch(currentUrl, { ...init, redirect: 'manual', dispatcher } as any);

    // Only a 3xx WITH a Location header is a redirect we follow; anything else
    // (2xx/4xx/5xx, or a 3xx with no Location) is the final response.
    const status = typeof response.status === 'number' ? response.status : 0;
    const location = status >= 300 && status < 400 ? (response.headers?.get('location') ?? null) : null;
    if (!location) return response;

    if (hop >= maxRedirects) {
      throw new SsrfBlockedError('Too many redirects');
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new SsrfBlockedError('Invalid redirect location');
    }
    // Drain the redirect body so the connection can be reused/closed, then loop
    // to re-resolve + re-check + re-pin the next hop.
    void response.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
}

/**
 * The original name, now the model lane specifically: the same guard as
 * safeFetchAdminConfigured — an endpoint an admin configured, which may
 * legitimately live on loopback or the LAN, and must still never reach
 * link-local or a cloud metadata service — with LLM_TIMEOUT_MS as the response
 * ceiling instead of undici's five minutes, so one setting governs the whole
 * call rather than being overruled by a default nobody chose.
 *
 * The ceiling is read once per call rather than per hop, so a redirect chain is
 * measured against one value even if the variable changes mid-chain.
 */
export function safeFetchLlm(url: string, init?: RequestInit, maxRedirects = 5): Promise<Response> {
  return safeFetchAdminConfigured(url, init, maxRedirects, readEnv().integrations.llmTimeoutMs);
}

/**
 * Thrown by safeFetch() when the URL is blocked by the SSRF guard.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface SafeFetchOptions {
  rejectUnauthorized?: boolean;
}

/**
 * SSRF-safe fetch wrapper. Validates the URL with checkSsrf(), then makes
 * the request using a DNS-pinned dispatcher so the resolved IP cannot change
 * between the check and the actual connection (DNS rebinding prevention).
 *
 * Pass `{ rejectUnauthorized: false }` for targets that use self-signed TLS
 * certificates (e.g. a Synology NAS on a local network). The SSRF guard still
 * applies — only the TLS certificate check is relaxed.
 */
export async function safeFetch(url: string, init?: RequestInit, options?: SafeFetchOptions): Promise<Response> {
  const ssrf = await checkSsrf(url);
  if (!ssrf.allowed) {
    throw new SsrfBlockedError(ssrf.error ?? 'Request blocked by SSRF guard');
  }
  const dispatcher = createPinnedDispatcher(ssrf.resolvedIp!, options?.rejectUnauthorized ?? true);
  return fetch(url, { ...init, dispatcher } as any);
}

export interface SafeFetchFollowOptions extends SafeFetchOptions {
  /** Maximum number of redirects to follow before giving up. Defaults to 5. */
  maxRedirects?: number;
  /**
   * When true, private/internal IPs that ALLOW_INTERNAL_NETWORK would normally
   * permit are still blocked (matches `checkSsrf(url, true)`). Loopback and
   * link-local are always blocked regardless. Defaults to false.
   */
  bypassInternalIpAllowed?: boolean;
}

/**
 * SSRF-safe fetch that follows redirects MANUALLY, re-validating every hop.
 *
 * `safeFetch()` (and a one-shot `checkSsrf()` + `fetch(redirect:'follow')`) only
 * guards the INITIAL URL: a validated public URL can 302-redirect to an internal
 * IP that the platform fetch would then follow unchecked (redirect TOCTOU). This
 * helper instead requests with `redirect: 'manual'`, and on every 3xx it resolves
 * the `Location` header against the current URL, runs `checkSsrf()` on the new
 * target, and only then fetches the next hop through a dispatcher pinned to THAT
 * hop's resolved IP. Each hop is therefore SSRF-checked + DNS-pinned, while
 * legitimate cross-host redirects (e.g. goo.gl → maps.google.com) still resolve
 * because the dispatcher is re-pinned per hop rather than locked to the first IP.
 *
 * The returned Response is the first non-redirect response (or the last redirect
 * if the hop limit is reached). `response.url` reflects the final hop so callers
 * relying on the resolved URL keep working.
 */
export async function safeFetchFollow(
  url: string,
  init?: RequestInit,
  options?: SafeFetchFollowOptions,
): Promise<Response> {
  const maxRedirects = options?.maxRedirects ?? 5;
  const rejectUnauthorized = options?.rejectUnauthorized ?? true;
  const bypassInternalIpAllowed = options?.bypassInternalIpAllowed ?? false;

  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    const ssrf = await checkSsrf(currentUrl, bypassInternalIpAllowed);
    if (!ssrf.allowed) {
      throw new SsrfBlockedError(ssrf.error ?? 'Request blocked by SSRF guard');
    }

    const dispatcher = createPinnedDispatcher(ssrf.resolvedIp!, rejectUnauthorized);
    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
      dispatcher,
    } as any);

    // Only a 3xx WITH a Location header is a redirect we follow; anything else
    // (2xx/4xx/5xx, or a 3xx with no Location) is the final response.
    const status = typeof response.status === 'number' ? response.status : 0;
    const isRedirectStatus = status >= 300 && status < 400;
    const location = isRedirectStatus ? (response.headers?.get('location') ?? null) : null;
    if (!location) {
      return response;
    }

    if (hop >= maxRedirects) {
      throw new SsrfBlockedError('Too many redirects');
    }

    // Resolve relative redirects against the current URL, then loop to
    // re-check + re-pin on the next iteration. Drain the body so the
    // connection can be reused/closed.
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new SsrfBlockedError('Invalid redirect location');
    }
    void response.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
}

/**
 * Returns an undici Agent whose connect.lookup is pinned to the already-validated
 * IP. This prevents DNS rebinding (TOCTOU) by ensuring the outbound connection
 * goes to the IP we checked, not a re-resolved one.
 */
export function createPinnedDispatcher(resolvedIp: string, rejectUnauthorized = true, responseTimeoutMs?: number): Agent {
  return new Agent({
    // undici caps the wait for response headers at 5 minutes by default, and
    // that cap is invisible from the call site: an AbortController set to
    // fifteen still dies at five.
    ...(responseTimeoutMs
      ? { headersTimeout: responseTimeoutMs, bodyTimeout: responseTimeoutMs }
      : {}),
    connect: {
      rejectUnauthorized,
      lookup: (_hostname: string, opts: Record<string, unknown>, callback: Function) => {
        const family = resolvedIp.includes(':') ? 6 : 4;
        // Node.js 18+ may call lookup with `all: true`, expecting an array of address objects
        if (opts?.all) {
          callback(null, [{ address: resolvedIp, family }]);
        } else {
          callback(null, resolvedIp, family);
        }
      },
    },
  });
}
