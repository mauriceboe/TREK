import dns from 'dns/promises';
import http from 'http';
import https from 'https';

const ALLOW_INTERNAL_NETWORK = process.env.ALLOW_INTERNAL_NETWORK === 'true';

export interface SsrfResult {
  allowed: boolean;
  resolvedIp?: string;
  isPrivate: boolean;
  error?: string;
}

// Always blocked — no override possible
function isAlwaysBlocked(ip: string): boolean {
  // Strip IPv6 brackets
  const addr = ip.startsWith('[') ? ip.slice(1, -1) : ip;

  // Loopback
  if (/^127\./.test(addr) || addr === '::1') return true;
  // Unspecified
  if (/^0\./.test(addr)) return true;
  // Link-local / cloud metadata
  if (/^169\.254\./.test(addr) || /^fe80:/i.test(addr)) return true;
  // IPv4-mapped loopback / link-local: ::ffff:127.x.x.x, ::ffff:169.254.x.x
  if (/^::ffff:127\./i.test(addr) || /^::ffff:169\.254\./i.test(addr)) return true;

  return false;
}

// Blocked unless ALLOW_INTERNAL_NETWORK=true
function isPrivateNetwork(ip: string): boolean {
  const addr = ip.startsWith('[') ? ip.slice(1, -1) : ip;

  // RFC-1918 private ranges
  if (/^10\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  // CGNAT / Tailscale shared address space (100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return true;
  // IPv6 ULA (fc00::/7)
  if (/^f[cd]/i.test(addr)) return true;
  // IPv4-mapped RFC-1918
  if (/^::ffff:10\./i.test(addr)) return true;
  if (/^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(addr)) return true;
  if (/^::ffff:192\.168\./i.test(addr)) return true;

  return false;
}

function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost';
}

export async function checkSsrf(rawUrl: string): Promise<SsrfResult> {
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

  // Block internal hostname suffixes (no override — these are too easy to abuse)
  if (isInternalHostname(hostname) && hostname !== 'localhost') {
    return { allowed: false, isPrivate: false, error: 'Requests to .local/.internal domains are not allowed' };
  }

  // Resolve hostname to IP
  let resolvedIp: string;
  try {
    const result = await dns.lookup(hostname);
    resolvedIp = result.address;
  } catch {
    return { allowed: false, isPrivate: false, error: 'Could not resolve hostname' };
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
    if (!ALLOW_INTERNAL_NETWORK) {
      return {
        allowed: false,
        isPrivate: true,
        resolvedIp,
        error: 'Requests to private/internal network addresses are not allowed. Set ALLOW_INTERNAL_NETWORK=true to permit this for self-hosted setups.',
      };
    }
    return { allowed: true, isPrivate: true, resolvedIp };
  }

  return { allowed: true, isPrivate: false, resolvedIp };
}

/**
 * Returns an http/https Agent whose `lookup` function is pinned to the
 * already-validated IP. This prevents DNS rebinding (TOCTOU) by ensuring
 * the outbound connection goes to the IP we checked, not a re-resolved one.
 */
export function createPinnedAgent(resolvedIp: string, protocol: string): http.Agent | https.Agent {
  const options = {
    lookup: (_hostname: string, _opts: unknown, callback: (err: Error | null, addr: string, family: number) => void) => {
      // Determine address family from IP format
      const family = resolvedIp.includes(':') ? 6 : 4;
      callback(null, resolvedIp, family);
    },
  };
  return protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}
