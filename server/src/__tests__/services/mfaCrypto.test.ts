import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing mfaCrypto so it uses a stable test secret
vi.mock('../../config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-mfa-crypto-tests',
}));

import { encryptMfaSecret, decryptMfaSecret } from '../../services/mfaCrypto';

describe('mfaCrypto', () => {
  describe('encrypt/decrypt roundtrip', () => {
    it('decrypts back to the original plaintext', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const encrypted = encryptMfaSecret(secret);
      const decrypted = decryptMfaSecret(encrypted);
      expect(decrypted).toBe(secret);
    });

    it('handles empty string', () => {
      const encrypted = encryptMfaSecret('');
      const decrypted = decryptMfaSecret(encrypted);
      expect(decrypted).toBe('');
    });

    it('handles long secrets', () => {
      const secret = 'A'.repeat(256);
      const encrypted = encryptMfaSecret(secret);
      expect(decryptMfaSecret(encrypted)).toBe(secret);
    });

    it('handles unicode characters', () => {
      const secret = '🔐秘密のキー';
      const encrypted = encryptMfaSecret(secret);
      expect(decryptMfaSecret(encrypted)).toBe(secret);
    });
  });

  describe('encryption properties', () => {
    it('produces base64-encoded output', () => {
      const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP');
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
      // Re-encoding should produce the same string (valid base64)
      expect(Buffer.from(encrypted, 'base64').toString('base64')).toBe(encrypted);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const encrypted1 = encryptMfaSecret(secret);
      const encrypted2 = encryptMfaSecret(secret);
      expect(encrypted1).not.toBe(encrypted2);

      // Both should still decrypt to the same value
      expect(decryptMfaSecret(encrypted1)).toBe(secret);
      expect(decryptMfaSecret(encrypted2)).toBe(secret);
    });

    it('ciphertext differs from plaintext', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const encrypted = encryptMfaSecret(secret);
      expect(encrypted).not.toBe(secret);
    });
  });

  describe('tamper detection', () => {
    it('throws on corrupted ciphertext', () => {
      const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP');
      const buf = Buffer.from(encrypted, 'base64');
      // Flip a byte in the encrypted data portion (after IV + auth tag = 28 bytes)
      if (buf.length > 28) {
        buf[28] ^= 0xff;
      }
      const tampered = buf.toString('base64');
      expect(() => decryptMfaSecret(tampered)).toThrow();
    });

    it('throws on truncated ciphertext', () => {
      const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP');
      const truncated = encrypted.slice(0, 10);
      expect(() => decryptMfaSecret(truncated)).toThrow();
    });

    it('throws on invalid base64', () => {
      expect(() => decryptMfaSecret('not-valid-base64!!!')).toThrow();
    });
  });
});
