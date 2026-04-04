import { describe, it, expect, vi } from 'vitest';

// Inline factory to avoid vi.mock hoisting issue (no imported vars allowed)
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { encryptMfaSecret, decryptMfaSecret } from '../../../src/services/mfaCrypto';

describe('mfaCrypto', () => {
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // typical base32 TOTP secret

  // SEC-009 — Encrypted MFA secrets not exposed
  describe('encryptMfaSecret', () => {
    it('SEC-009: returns a base64 string (not the plaintext)', () => {
      const encrypted = encryptMfaSecret(TOTP_SECRET);
      expect(encrypted).not.toBe(TOTP_SECRET);
      // Should be valid base64
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
    });

    it('different calls produce different ciphertext (random IV)', () => {
      const enc1 = encryptMfaSecret(TOTP_SECRET);
      const enc2 = encryptMfaSecret(TOTP_SECRET);
      expect(enc1).not.toBe(enc2);
    });

    it('encrypted value does not contain plaintext', () => {
      const encrypted = encryptMfaSecret(TOTP_SECRET);
      expect(encrypted).not.toContain(TOTP_SECRET);
    });
  });

  describe('decryptMfaSecret', () => {
    it('SEC-009: roundtrip — decrypt returns original secret', () => {
      const encrypted = encryptMfaSecret(TOTP_SECRET);
      const decrypted = decryptMfaSecret(encrypted);
      expect(decrypted).toBe(TOTP_SECRET);
    });

    it('handles secrets of varying lengths', () => {
      const short = 'ABC123';
      const long = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      expect(decryptMfaSecret(encryptMfaSecret(short))).toBe(short);
      expect(decryptMfaSecret(encryptMfaSecret(long))).toBe(long);
    });

    it('throws or returns garbage on tampered ciphertext', () => {
      const encrypted = encryptMfaSecret(TOTP_SECRET);
      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 1] ^= 0xff; // flip last byte
      const tampered = buf.toString('base64');
      expect(() => decryptMfaSecret(tampered)).toThrow();
    });
  });
});
