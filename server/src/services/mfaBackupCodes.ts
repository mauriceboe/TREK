import crypto from 'crypto';
import bcrypt from 'bcryptjs';

/** Unambiguous charset (no 0/O, 1/I/L) */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MFA_BACKUP_CODE_COUNT = 10;

export function normalizeBackupCodeInput(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function randomBackupCodePlain(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Returns one-time plaintext codes and JSON array of bcrypt hashes for DB storage. */
export function generateBackupCodeSet(): { codes: string[]; hashesJson: string } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < MFA_BACKUP_CODE_COUNT; i++) {
    const plain = randomBackupCodePlain();
    codes.push(plain);
    hashes.push(bcrypt.hashSync(normalizeBackupCodeInput(plain), 10));
  }
  return { codes, hashesJson: JSON.stringify(hashes) };
}

export function countBackupCodes(hashesJson: string | null | undefined): number {
  if (!hashesJson) return 0;
  try {
    const arr = JSON.parse(hashesJson) as unknown;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * If input matches a stored hash, returns updated hashes JSON with that entry removed (one-time use).
 */
export function tryConsumeBackupCode(
  input: string,
  hashesJson: string | null | undefined
): { ok: true; newHashesJson: string } | { ok: false } {
  if (!hashesJson) return { ok: false };
  let hashes: string[];
  try {
    hashes = JSON.parse(hashesJson) as string[];
    if (!Array.isArray(hashes) || hashes.length === 0) return { ok: false };
  } catch {
    return { ok: false };
  }
  const norm = normalizeBackupCodeInput(input);
  if (norm.length < 8) return { ok: false };

  for (let i = 0; i < hashes.length; i++) {
    try {
      if (bcrypt.compareSync(norm, hashes[i])) {
        const next = hashes.filter((_, j) => j !== i);
        return { ok: true, newHashesJson: JSON.stringify(next) };
      }
    } catch {
      continue;
    }
  }
  return { ok: false };
}
