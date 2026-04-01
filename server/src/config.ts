import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(__dirname, '../data');

// JWT_SECRET is always managed by the server — auto-generated on first start and
// persisted to data/.jwt_secret. Use the admin panel to rotate it; do not set it
// via environment variable (env var would override a rotation on next restart).
const jwtSecretFile = path.join(dataDir, '.jwt_secret');
let _jwtSecret: string;

try {
  _jwtSecret = fs.readFileSync(jwtSecretFile, 'utf8').trim();
} catch {
  _jwtSecret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(jwtSecretFile, _jwtSecret, { mode: 0o600 });
    console.log('Generated and saved JWT secret to', jwtSecretFile);
  } catch (writeErr: unknown) {
    console.warn('WARNING: Could not persist JWT secret to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
    console.warn('Sessions will reset on server restart.');
  }
}

// export let so TypeScript's CJS output keeps exports.JWT_SECRET live
// (generates `exports.JWT_SECRET = JWT_SECRET = newVal` inside updateJwtSecret)
export let JWT_SECRET = _jwtSecret;

// Called by the admin rotate-jwt-secret endpoint to update the in-process
// binding that all middleware and route files reference.
export function updateJwtSecret(newSecret: string): void {
  JWT_SECRET = newSecret;
}

// ENCRYPTION_KEY is used to derive at-rest encryption keys for stored secrets
// (API keys, MFA TOTP secrets, SMTP password, OIDC client secret, etc.).
// Keeping it separate from JWT_SECRET means you can rotate session tokens without
// invalidating all stored encrypted data, and vice-versa.
//
// Resolution order:
//   1. ENCRYPTION_KEY env var — explicit, always takes priority.
//   2. data/.encryption_key file — present on any install that has started at
//      least once (written automatically by cases 1b and 3 below).
//   3. data/.jwt_secret — one-time fallback for existing installs upgrading
//      without a pre-set ENCRYPTION_KEY. The value is immediately persisted to
//      data/.encryption_key so JWT rotation can never break decryption later.
//   4. Auto-generated — fresh install with none of the above; persisted to
//      data/.encryption_key.
const encKeyFile = path.join(dataDir, '.encryption_key');
let _encryptionKey: string = process.env.ENCRYPTION_KEY || '';

if (_encryptionKey) {
  // Env var is set explicitly — persist it to file so the value survives
  // container restarts even if the env var is later removed.
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(encKeyFile, _encryptionKey, { mode: 0o600 });
  } catch {
    // Non-fatal: env var is the source of truth when set.
  }
} else {
  // Try the dedicated key file first (covers all installs after first start).
  try {
    _encryptionKey = fs.readFileSync(encKeyFile, 'utf8').trim();
  } catch {
    // File not found — first start on an existing or fresh install.
  }

  if (!_encryptionKey) {
    // One-time migration: existing install upgrading for the first time.
    // Use the JWT secret as the encryption key and immediately write it to
    // .encryption_key so future JWT rotations cannot break decryption.
    try {
      _encryptionKey = fs.readFileSync(jwtSecretFile, 'utf8').trim();
      console.warn('WARNING: ENCRYPTION_KEY is not set. Falling back to JWT secret for at-rest encryption.');
      console.warn('The value has been persisted to data/.encryption_key — JWT rotation is now safe.');
    } catch {
      // JWT secret not found — must be a fresh install.
    }
  }

  if (!_encryptionKey) {
    // Fresh install — auto-generate a dedicated key.
    _encryptionKey = crypto.randomBytes(32).toString('hex');
  }

  // Persist whatever key was resolved so subsequent starts skip the fallback chain.
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(encKeyFile, _encryptionKey, { mode: 0o600 });
    console.log('Encryption key persisted to', encKeyFile);
  } catch (writeErr: unknown) {
    console.warn('WARNING: Could not persist encryption key to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
    console.warn('Set ENCRYPTION_KEY env var to avoid losing access to encrypted secrets on restart.');
  }
}

export const ENCRYPTION_KEY = _encryptionKey;
