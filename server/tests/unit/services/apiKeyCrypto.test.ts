import { describe, it, expect, vi } from 'vitest';

// Inline factory to avoid vi.mock hoisting issue (no imported vars allowed)
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { encrypt_api_key, decrypt_api_key, maybe_encrypt_api_key } from '../../../src/services/apiKeyCrypto';

describe('apiKeyCrypto', () => {
  const PLAINTEXT_KEY = 'my-secret-api-key-12345';
  const ENC_PREFIX = 'enc:v1:';

  // SEC-008 — Encrypted API keys not returned in plaintext
  describe('encrypt_api_key', () => {
    it('SEC-008: returns encrypted string with enc:v1: prefix', () => {
      const encrypted = encrypt_api_key(PLAINTEXT_KEY);
      expect(encrypted).toMatch(/^enc:v1:/);
    });

    it('different calls produce different ciphertext (random IV)', () => {
      const enc1 = encrypt_api_key(PLAINTEXT_KEY);
      const enc2 = encrypt_api_key(PLAINTEXT_KEY);
      expect(enc1).not.toBe(enc2);
    });

    it('encrypted value does not contain the plaintext', () => {
      const encrypted = encrypt_api_key(PLAINTEXT_KEY);
      expect(encrypted).not.toContain(PLAINTEXT_KEY);
    });
  });

  describe('decrypt_api_key', () => {
    it('SEC-008: decrypts an encrypted key back to original', () => {
      const encrypted = encrypt_api_key(PLAINTEXT_KEY);
      const decrypted = decrypt_api_key(encrypted);
      expect(decrypted).toBe(PLAINTEXT_KEY);
    });

    it('returns null for null input', () => {
      expect(decrypt_api_key(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(decrypt_api_key('')).toBeNull();
    });

    it('returns plaintext as-is if not prefixed (legacy)', () => {
      expect(decrypt_api_key('plain-legacy-key')).toBe('plain-legacy-key');
    });

    it('returns null for tampered ciphertext', () => {
      const encrypted = encrypt_api_key(PLAINTEXT_KEY);
      const tampered = encrypted.replace(ENC_PREFIX, ENC_PREFIX) + 'TAMPER';
      expect(decrypt_api_key(tampered)).toBeNull();
    });
  });

  describe('maybe_encrypt_api_key', () => {
    it('encrypts a new plaintext value', () => {
      const result = maybe_encrypt_api_key('my-key');
      expect(result).toMatch(/^enc:v1:/);
    });

    it('returns null for empty/falsy values', () => {
      expect(maybe_encrypt_api_key('')).toBeNull();
      expect(maybe_encrypt_api_key(null)).toBeNull();
      expect(maybe_encrypt_api_key(undefined)).toBeNull();
    });

    it('returns already-encrypted value as-is (no double-encryption)', () => {
      const encrypted = encrypt_api_key(PLAINTEXT_KEY);
      const result = maybe_encrypt_api_key(encrypted);
      expect(result).toBe(encrypted);
    });
  });
});
