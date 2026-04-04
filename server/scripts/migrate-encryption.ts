/**
 * Encryption key migration script.
 *
 * Re-encrypts all at-rest secrets in the TREK database from one ENCRYPTION_KEY
 * to another without requiring the application to be running.
 *
 * Usage (host):
 *   cd server
 *   node --import tsx scripts/migrate-encryption.ts
 *
 * Usage (Docker):
 *   docker exec -it trek node --import tsx scripts/migrate-encryption.ts
 *
 * The script will prompt for the old and new keys interactively so they never
 * appear in shell history, process arguments, or log output.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Crypto helpers — mirrors apiKeyCrypto.ts and mfaCrypto.ts but with
// explicit key arguments so the script is independent of config.ts / env vars.
// ---------------------------------------------------------------------------

const ENCRYPTED_PREFIX = 'enc:v1:';

function apiKey(encryptionKey: string): Buffer {
  return crypto.createHash('sha256').update(`${encryptionKey}:api_keys:v1`).digest();
}

function mfaKey(encryptionKey: string): Buffer {
  return crypto.createHash('sha256').update(`${encryptionKey}:mfa:v1`).digest();
}

function encryptApiKey(plain: string, encryptionKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', apiKey(encryptionKey), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

function decryptApiKey(value: string, encryptionKey: string): string | null {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return null;
  try {
    const buf = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', apiKey(encryptionKey), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function encryptMfa(plain: string, encryptionKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mfaKey(encryptionKey), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptMfa(value: string, encryptionKey: string): string | null {
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length < 28) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', mfaKey(encryptionKey), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
// A single readline interface is shared for the entire script lifetime so
// stdin is never paused between prompts.
//
// Lines are collected into a queue as soon as readline emits them — this
// prevents the race where a line event fires before the next listener is
// registered (common with piped / pasted input that arrives all at once).

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const lineQueue: string[] = [];
const lineWaiters: ((line: string) => void)[] = [];

rl.on('line', (line) => {
  if (lineWaiters.length > 0) {
    lineWaiters.shift()!(line);
  } else {
    lineQueue.push(line);
  }
});

function nextLine(): Promise<string> {
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift()!);
    } else {
      lineWaiters.push(resolve);
    }
  });
}

// Muted prompt — typed/pasted characters are not echoed.
// _writeToOutput is suppressed only while waiting for this line.
async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  (rl as any)._writeToOutput = () => {};
  const line = await nextLine();
  (rl as any)._writeToOutput = (s: string) => process.stdout.write(s);
  process.stdout.write('\n');
  return line.trim();
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  const line = await nextLine();
  return line.trim();
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

interface MigrationResult {
  migrated: number;
  alreadyMigrated: number;
  skipped: number;
  errors: string[];
}

async function main() {
  console.log('=== TREK Encryption Key Migration ===\n');
  console.log('This script re-encrypts all stored secrets under a new ENCRYPTION_KEY.');
  console.log('A backup of the database will be created before any changes are made.\n');

  // Resolve DB path
  const dbPath = path.resolve(
    process.env.DB_PATH ?? path.join(__dirname, '../data/travel.db')
  );

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    console.error('Set DB_PATH env var if your database is in a non-standard location.');
    process.exit(1);
  }

  console.log(`Database: ${dbPath}\n`);

  // Collect keys interactively
  const oldKey = await promptSecret('Old ENCRYPTION_KEY: ');
  const newKey = await promptSecret('New ENCRYPTION_KEY: ');

  if (!oldKey || !newKey) {
    rl.close();
    console.error('Both keys are required.');
    process.exit(1);
  }

  if (oldKey === newKey) {
    rl.close();
    console.error('Old and new keys are identical — nothing to do.');
    process.exit(0);
  }

  // Confirm
  const confirm = await prompt('\nProceed with migration? This will modify the database. Type "yes" to confirm: ');
  if (confirm.trim().toLowerCase() !== 'yes') {
    rl.close();
    console.log('Aborted.');
    process.exit(0);
  }

  // Backup
  const backupPath = `${dbPath}.backup-${Date.now()}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`\nBackup created: ${backupPath}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const result: MigrationResult = { migrated: 0, alreadyMigrated: 0, skipped: 0, errors: [] };

  // Helper: migrate a single api-key-style value (enc:v1: prefix)
  function migrateApiKeyValue(raw: string, label: string): string | null {
    if (!raw || !raw.startsWith(ENCRYPTED_PREFIX)) {
      result.skipped++;
      console.warn(`  SKIP ${label}: not an encrypted value (missing enc:v1: prefix)`);
      return null;
    }

    const plain = decryptApiKey(raw, oldKey);
    if (plain !== null) {
      result.migrated++;
      return encryptApiKey(plain, newKey);
    }

    // Try new key — already migrated?
    const check = decryptApiKey(raw, newKey);
    if (check !== null) {
      result.alreadyMigrated++;
      return null; // no change needed
    }

    result.errors.push(`${label}: decryption failed with both keys`);
    console.error(`  ERROR ${label}: could not decrypt with either key — skipping`);
    return null;
  }

  // Helper: migrate a single MFA value (no prefix, raw base64)
  function migrateMfaValue(raw: string, label: string): string | null {
    if (!raw) { result.skipped++; return null; }

    const plain = decryptMfa(raw, oldKey);
    if (plain !== null) {
      result.migrated++;
      return encryptMfa(plain, newKey);
    }

    const check = decryptMfa(raw, newKey);
    if (check !== null) {
      result.alreadyMigrated++;
      return null;
    }

    result.errors.push(`${label}: decryption failed with both keys`);
    console.error(`  ERROR ${label}: could not decrypt with either key — skipping`);
    return null;
  }

  db.transaction(() => {
    // --- app_settings: oidc_client_secret, smtp_pass ---
    for (const key of ['oidc_client_secret', 'smtp_pass']) {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row?.value) continue;
      const newVal = migrateApiKeyValue(row.value, `app_settings.${key}`);
      if (newVal !== null) {
        db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(newVal, key);
      }
    }

    // --- users: maps_api_key, openweather_api_key, immich_api_key ---
    const apiKeyColumns = ['maps_api_key', 'openweather_api_key', 'immich_api_key'];
    const users = db.prepare('SELECT id FROM users').all() as { id: number }[];

    for (const user of users) {
      const row = db.prepare(`SELECT ${apiKeyColumns.join(', ')} FROM users WHERE id = ?`).get(user.id) as Record<string, string>;

      for (const col of apiKeyColumns) {
        if (!row[col]) continue;
        const newVal = migrateApiKeyValue(row[col], `users[${user.id}].${col}`);
        if (newVal !== null) {
          db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(newVal, user.id);
        }
      }

      // mfa_secret (mfa crypto)
      const mfaRow = db.prepare('SELECT mfa_secret FROM users WHERE id = ? AND mfa_secret IS NOT NULL').get(user.id) as { mfa_secret: string } | undefined;
      if (mfaRow?.mfa_secret) {
        const newVal = migrateMfaValue(mfaRow.mfa_secret, `users[${user.id}].mfa_secret`);
        if (newVal !== null) {
          db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(newVal, user.id);
        }
      }
    }
  })();

  db.close();
  rl.close();

  console.log('\n=== Migration complete ===');
  console.log(`  Migrated:        ${result.migrated}`);
  console.log(`  Already on new key: ${result.alreadyMigrated}`);
  console.log(`  Skipped (empty): ${result.skipped}`);
  if (result.errors.length > 0) {
    console.warn(`  Errors:          ${result.errors.length}`);
    result.errors.forEach(e => console.warn(`    - ${e}`));
    console.warn('\nSome secrets could not be migrated. Check the errors above.');
    console.warn(`Your original database is backed up at: ${backupPath}`);
    process.exit(1);
  } else {
    console.log('\nAll secrets successfully re-encrypted.');
    console.log(`Backup retained at: ${backupPath}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
