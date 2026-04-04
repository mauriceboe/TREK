const COMMON_PASSWORDS = new Set([
  'password', '12345678', '123456789', '1234567890', 'password1',
  'qwerty123', 'iloveyou', 'admin123', 'letmein12', 'welcome1',
  'monkey123', 'dragon12', 'master12', 'qwerty12', 'abc12345',
  'trustno1', 'baseball', 'football', 'shadow12', 'michael1',
  'jennifer', 'superman', 'abcdefgh', 'abcd1234', 'password123',
  'admin1234', 'changeme', 'welcome123', 'passw0rd', 'p@ssword',
]);

export function validatePassword(password: string): { ok: boolean; reason?: string } {
  if (password.length < 8) return { ok: false, reason: 'Password must be at least 8 characters' };

  if (/^(.)\1+$/.test(password)) {
    return { ok: false, reason: 'Password is too repetitive' };
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'Password is too common. Please choose a unique password.' };
  }

  const requirementsMessage = 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character';
  if (!/[A-Z]/.test(password)) return { ok: false, reason: requirementsMessage };
  if (!/[a-z]/.test(password)) return { ok: false, reason: requirementsMessage };
  if (!/[0-9]/.test(password)) return { ok: false, reason: requirementsMessage };
  if (!/[^A-Za-z0-9]/.test(password)) return { ok: false, reason: requirementsMessage };

  return { ok: true };
}
