import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reset module between tests that need a fresh token store
beforeEach(() => {
  vi.resetModules();
});

describe('ephemeralTokens', () => {
  async function getModule() {
    return import('../../../src/services/ephemeralTokens');
  }

  // AUTH-030 — Resource token creation (single-use)
  describe('createEphemeralToken', () => {
    it('AUTH-030: creates a token and returns a hex string', async () => {
      const { createEphemeralToken } = await getModule();
      const token = createEphemeralToken(1, 'download');
      expect(token).not.toBeNull();
      expect(typeof token).toBe('string');
      expect(token!.length).toBe(64); // 32 bytes hex
    });

    it('AUTH-030: different calls produce different tokens', async () => {
      const { createEphemeralToken } = await getModule();
      const t1 = createEphemeralToken(1, 'download');
      const t2 = createEphemeralToken(1, 'download');
      expect(t1).not.toBe(t2);
    });
  });

  // AUTH-029 — WebSocket token expiry (single-use)
  describe('consumeEphemeralToken', () => {
    it('AUTH-030: token is consumed and returns userId on first use', async () => {
      const { createEphemeralToken, consumeEphemeralToken } = await getModule();
      const token = createEphemeralToken(42, 'download')!;
      const userId = consumeEphemeralToken(token, 'download');
      expect(userId).toBe(42);
    });

    it('AUTH-030: token is single-use — second consume returns null', async () => {
      const { createEphemeralToken, consumeEphemeralToken } = await getModule();
      const token = createEphemeralToken(42, 'download')!;
      consumeEphemeralToken(token, 'download'); // first use
      const second = consumeEphemeralToken(token, 'download'); // second use
      expect(second).toBeNull();
    });

    it('AUTH-029: purpose mismatch returns null', async () => {
      const { createEphemeralToken, consumeEphemeralToken } = await getModule();
      const token = createEphemeralToken(42, 'ws')!;
      const result = consumeEphemeralToken(token, 'download');
      expect(result).toBeNull();
    });

    it('AUTH-029: expired token returns null', async () => {
      vi.useFakeTimers();
      const { createEphemeralToken, consumeEphemeralToken } = await getModule();
      const token = createEphemeralToken(42, 'ws')!; // 30s TTL
      vi.advanceTimersByTime(31_000); // advance past expiry
      const result = consumeEphemeralToken(token, 'ws');
      expect(result).toBeNull();
      vi.useRealTimers();
    });

    it('returns null for unknown token', async () => {
      const { consumeEphemeralToken } = await getModule();
      const result = consumeEphemeralToken('nonexistent-token', 'download');
      expect(result).toBeNull();
    });
  });
});
