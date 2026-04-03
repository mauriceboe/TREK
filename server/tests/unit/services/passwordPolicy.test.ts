import { describe, it, expect } from 'vitest';
import { validatePassword } from '../../../src/services/passwordPolicy';

describe('validatePassword', () => {
  // AUTH-006 — Registration with weak password
  describe('length requirement', () => {
    it('AUTH-006: rejects passwords shorter than 8 characters', () => {
      expect(validatePassword('Ab1!')).toEqual({ ok: false, reason: expect.stringContaining('8 characters') });
      expect(validatePassword('Ab1!456')).toEqual({ ok: false, reason: expect.stringContaining('8 characters') });
    });

    it('accepts passwords of exactly 8 characters that meet all requirements', () => {
      expect(validatePassword('Ab1!abcd')).toEqual({ ok: true });
    });
  });

  describe('complexity requirements', () => {
    it('AUTH-006: rejects password missing uppercase letter', () => {
      const result = validatePassword('abcd1234!');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('uppercase');
    });

    it('AUTH-006: rejects password missing lowercase letter', () => {
      const result = validatePassword('ABCD1234!');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('lowercase');
    });

    it('AUTH-006: rejects password missing a number', () => {
      const result = validatePassword('Abcdefg!');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('number');
    });

    it('AUTH-006: rejects password missing a special character', () => {
      // 'TrekApp1' — has upper, lower, number, NO special char, NOT in blocklist
      const result = validatePassword('TrekApp1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('special character');
    });
  });

  // AUTH-007 — Registration with common password
  describe('common password blocklist', () => {
    it('AUTH-007: rejects password matching exact blocklist entry (case-insensitive)', () => {
      // 'password1' is in the blocklist. A capitalised+special variant still matches
      // because the check is COMMON_PASSWORDS.has(password.toLowerCase()).
      // However, 'Password1!' lowercased is 'password1!' which is NOT in the set.
      // We must use a password whose lowercase is exactly in the set:
      // 'Iloveyou1!' — lowercased: 'iloveyou1!' — NOT in set.
      // Use a password whose *lowercase* IS in set: 'changeme' → 'Changeme' is 8 chars
      // but lacks uppercase/number/special — test blocklist with full complex variants:
      // 'ILoveyou1!' lowercased = 'iloveyou1!' — not in set.
      // Just test exact matches that satisfy complexity: use blocklist entry itself.
      // 'Iloveyou' is 8 chars, no number/special → fails complexity, not blocklist.
      // Better: pick a blocklist entry that, when capitalised + special added, still matches.
      // The check is: COMMON_PASSWORDS.has(password.toLowerCase())
      // So 'FOOTBALL!' lowercased = 'football!' — not in set ('football' is in set).
      // We need password.toLowerCase() to equal a set entry exactly:
      // 'football' → add uppercase → 'Football' is still 8 chars, no number, no special → fails complexity first
      // The blocklist check happens BEFORE complexity checks, after length + repetitive checks.
      // So any 8+ char string whose lowercase is in the blocklist gets caught first.
      // 'Password1' lowercased = 'password1' → in blocklist! ✓ (length ok, not repetitive)
      expect(validatePassword('Password1')).toEqual({
        ok: false,
        reason: expect.stringContaining('common'),
      });
    });

    it('AUTH-007: rejects "Changeme" whose lowercase is in the blocklist', () => {
      // 'changeme' is in the set; 'Changeme'.toLowerCase() === 'changeme' ✓
      expect(validatePassword('Changeme')).toEqual({
        ok: false,
        reason: expect.stringContaining('common'),
      });
    });

    it('accepts a strong password that is not in the blocklist', () => {
      expect(validatePassword('MyUniq!1Trek')).toEqual({ ok: true });
    });
  });

  describe('repetitive password', () => {
    it('rejects passwords made of a single repeated character', () => {
      const result = validatePassword('AAAAAAAA');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('repetitive');
    });
  });

  describe('valid passwords', () => {
    it('accepts a strong unique password', () => {
      expect(validatePassword('Tr3k!SecurePass')).toEqual({ ok: true });
    });

    it('accepts a strong password with special characters', () => {
      expect(validatePassword('MyP@ss#2024')).toEqual({ ok: true });
    });
  });
});
