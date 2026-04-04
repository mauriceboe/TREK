import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dns/promises to avoid real DNS lookups in unit tests
vi.mock('dns/promises', () => ({
  default: { lookup: vi.fn() },
  lookup: vi.fn(),
}));

import dns from 'dns/promises';
import { checkSsrf } from '../../../src/utils/ssrfGuard';

const mockLookup = vi.mocked(dns.lookup);

function mockIp(ip: string) {
  mockLookup.mockResolvedValue({ address: ip, family: ip.includes(':') ? 6 : 4 });
}

describe('checkSsrf', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // SEC-001 — Loopback always blocked
  describe('loopback addresses (always blocked)', () => {
    it('SEC-001: blocks 127.0.0.1', async () => {
      mockIp('127.0.0.1');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
      expect(result.isPrivate).toBe(true);
    });

    it('SEC-001: blocks ::1 (IPv6 loopback)', async () => {
      mockIp('::1');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
    });

    it('SEC-001: blocks 127.x.x.x range', async () => {
      mockIp('127.0.0.2');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
    });
  });

  // SEC-002 — Link-local (AWS metadata) always blocked
  describe('link-local addresses (always blocked)', () => {
    it('SEC-002: blocks 169.254.169.254 (AWS metadata)', async () => {
      mockIp('169.254.169.254');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
      expect(result.isPrivate).toBe(true);
    });

    it('SEC-002: blocks any 169.254.x.x address', async () => {
      mockIp('169.254.0.1');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
    });
  });

  // SEC-003 — Private network blocked when ALLOW_INTERNAL_NETWORK is false
  describe('private network addresses (conditionally blocked)', () => {
    beforeEach(() => {
      vi.stubEnv('ALLOW_INTERNAL_NETWORK', 'false');
    });

    it('SEC-003: blocks 10.x.x.x (RFC-1918)', async () => {
      mockIp('10.0.0.1');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
      expect(result.isPrivate).toBe(true);
    });

    it('SEC-003: blocks 192.168.x.x (RFC-1918)', async () => {
      mockIp('192.168.1.100');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
    });

    it('SEC-003: blocks 172.16.x.x through 172.31.x.x (RFC-1918)', async () => {
      mockIp('172.16.0.1');
      const result = await checkSsrf('http://example.com');
      expect(result.allowed).toBe(false);
    });
  });

  // SEC-004 — Private network allowed with ALLOW_INTERNAL_NETWORK=true
  describe('ALLOW_INTERNAL_NETWORK=true', () => {
    it('SEC-004: allows private IP when flag is set', async () => {
      vi.stubEnv('ALLOW_INTERNAL_NETWORK', 'true');
      mockIp('192.168.1.100');
      // Need to reload module since ALLOW_INTERNAL_NETWORK is read at module load time
      vi.resetModules();
      const { checkSsrf: checkSsrfFresh } = await import('../../../src/utils/ssrfGuard');
      const { lookup: freshLookup } = await import('dns/promises');
      vi.mocked(freshLookup).mockResolvedValue({ address: '192.168.1.100', family: 4 });
      const result = await checkSsrfFresh('http://example.com');
      expect(result.allowed).toBe(true);
      expect(result.isPrivate).toBe(true);
    });
  });

  describe('protocol restrictions', () => {
    it('rejects non-HTTP/HTTPS protocols', async () => {
      const result = await checkSsrf('ftp://example.com');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('HTTP');
    });

    it('rejects file:// protocol', async () => {
      const result = await checkSsrf('file:///etc/passwd');
      expect(result.allowed).toBe(false);
    });
  });

  describe('invalid URLs', () => {
    it('rejects malformed URLs', async () => {
      const result = await checkSsrf('not-a-url');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });
  });

  describe('public URLs', () => {
    it('allows a normal public IP', async () => {
      mockIp('8.8.8.8');
      const result = await checkSsrf('https://example.com');
      expect(result.allowed).toBe(true);
      expect(result.isPrivate).toBe(false);
      expect(result.resolvedIp).toBe('8.8.8.8');
    });
  });

  describe('internal hostname suffixes', () => {
    it('blocks .local domains', async () => {
      const result = await checkSsrf('http://myserver.local');
      expect(result.allowed).toBe(false);
    });

    it('blocks .internal domains', async () => {
      const result = await checkSsrf('http://service.internal');
      expect(result.allowed).toBe(false);
    });
  });
});
