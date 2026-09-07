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

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');

  // The rollback copy has to be a consistent snapshot, not a plain file copy:
  // this script is documented as running against a live server, so in WAL mode
  // the committed tail sits in the -wal sidecar a copy would leave behind.
  // VACUUM INTO snapshots even while the server writes; the checkpoint plus
  // copy is only the fallback for when it cannot (disk, lock).
  try {
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } catch {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, backupPath);
  }
  console.log(`\nBackup created: ${backupPath}`);

  // journal_mode lives in the file header, so hardcoding WAL here would quietly
  // undo a deliberate DELETE/TRUNCATE setup (network storage) on the first key
  // rotation. This script ships without src/ in the image and cannot import
  // src/app-config, so it reads the same variables directly — keep the defaults
  // in step with parsers.resolveDurability().
  const journalModes = ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF'];
  const syncLevels = ['OFF', 'NORMAL', 'FULL', 'EXTRA'];

  const wantedJournal = (process.env.TREK_DB_JOURNAL_MODE ?? '').trim().toUpperCase();
  const journalMode = journalModes.includes(wantedJournal) ? wantedJournal : 'WAL';
  if (wantedJournal && journalMode !== wantedJournal) {
    console.warn(`TREK_DB_JOURNAL_MODE="${process.env.TREK_DB_JOURNAL_MODE}" is not a SQLite journal mode — using ${journalMode}.`);
  }

  const wantedSync = (process.env.TREK_DB_SYNCHRONOUS ?? '').trim().toUpperCase();
  const defaultSync = journalMode === 'WAL' ? 'NORMAL' : 'FULL';
  const synchronous = syncLevels.includes(wantedSync) ? wantedSync : defaultSync;
  if (wantedSync && synchronous !== wantedSync) {
    console.warn(`TREK_DB_SYNCHRONOUS="${process.env.TREK_DB_SYNCHRONOUS}" is not a SQLite synchronous level — using ${synchronous}.`);
  }

  db.pragma(`journal_mode = ${journalMode}`);
  db.pragma(`synchronous = ${synchronous}`);
  console.log(`Journal mode: ${db.pragma('journal_mode', { simple: true })}\n`);

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
    // --- app_settings: oidc_client_secret, smtp_pass, admin_webhook_url, admin_ntfy_token,
    // plus the instance-wide provider keys (#1939) ---
    //
    // The last two mirror INSTANCE_API_KEY_NAMES in
    // src/nest/settings/instance-api-keys.ts. Spelled out rather than imported,
    // because that module pulls in DatabaseService and this script deliberately
    // stays independent of src/ (see the crypto note above). Miss one and a
    // rotation leaves it encrypted under the old key, which reads back as "no
    // key" and silently drops the install to OpenStreetMap, so the copy is
    // pinned by tests/unit/db/migrate-encryption-parity.test.ts.
    for (const key of [
      'oidc_client_secret',
      'smtp_pass',
      'admin_webhook_url',
      'admin_ntfy_token',
      'maps_api_key',
      'unsplash_api_key',
      'amap_api_key',
    ]) {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row?.value) continue;
      const newVal = migrateApiKeyValue(row.value, `app_settings.${key}`);
      if (newVal !== null) {
        db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(newVal, key);
      }
    }

    // --- users: api key columns + synology credentials ---
    // unsplash_api_key was missing here for as long as the column has existed. It
    // matters now that the resolver reads it as the per-user fallback (#1939): left
    // out of a rotation it stays encrypted under the old key and reads back as unset.
    // airtrail_api_key arrived with a later migration, so an older database may
    // not have the column at all — filter the list against the real table rather
    // than letting one missing column throw the whole rotation.
    const userColumns = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]).map((r) => r.name),
    );
    const apiKeyColumns = [
      'maps_api_key',
      'unsplash_api_key',
      // Added with the Amap provider; filtered against the real table below, so a
      // database that has not run that migration yet is not a rotation failure.
      'amap_api_key',
      'openweather_api_key',
      'immich_api_key',
      'synology_password',
      'synology_sid',
      'synology_did',
      'airtrail_api_key',
    ].filter((c) => userColumns.has(c));
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

    // --- app_settings: storage.backends ---
    // Storage backend secrets live encrypted INSIDE the storage.backends JSON
    // array (BACKENDS_KEY in src/nest/storage/storage-registry.service.ts is
    // its own app_settings row — 'storage.categories' is a sibling row with no
    // secrets), on the fields the shared type registry marks `secret` (only
    // options.secretAccessKey for s3 today; src/nest/storage/storage-secrets.ts
    // encrypts it with the same enc:v1: scheme as the api-key columns above).
    // This script can't import storageSecretFields from @trek/shared (kept
    // independent of the app, see the header note), so the field list per
    // backend type is pinned here. Miss one and that backend's secret stays
    // encrypted under the old key after rotation, then fails to decrypt on the
    // next read (StorageBackendError) — pinned by
    // tests/unit/db/migrate-encryption-parity.test.ts.
    const STORAGE_BACKEND_SECRET_FIELDS: Record<string, readonly string[]> = {
      s3: ['secretAccessKey'],
    };
    {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'storage.backends'").get() as
        | { value: string }
        | undefined;
      if (row?.value) {
        let backends: unknown;
        try {
          backends = JSON.parse(row.value);
        } catch {
          result.errors.push('app_settings.storage.backends: invalid JSON — skipping');
          backends = undefined;
        }
        if (backends !== undefined) {
          if (Array.isArray(backends)) {
            let changed = false;
            for (const backend of backends as Record<string, unknown>[]) {
              if (!backend || typeof backend !== 'object') continue;
              const type = typeof backend.type === 'string' ? backend.type : undefined;
              const fields = type ? STORAGE_BACKEND_SECRET_FIELDS[type] : undefined;
              if (!fields || fields.length === 0) continue;
              const options = backend.options;
              if (!options || typeof options !== 'object') continue;
              const name = typeof backend.name === 'string' ? backend.name : '?';
              for (const field of fields) {
                const raw = (options as Record<string, unknown>)[field];
                if (typeof raw !== 'string' || !raw) continue;
                const newVal = migrateApiKeyValue(raw, `app_settings.storage.backends[${name}].${field}`);
                if (newVal !== null) {
                  (options as Record<string, unknown>)[field] = newVal;
                  changed = true;
                }
              }
            }
            if (changed) {
              db.prepare("UPDATE app_settings SET value = ? WHERE key = 'storage.backends'").run(
                JSON.stringify(backends),
              );
            }
          } else {
            result.errors.push('app_settings.storage.backends: not an array — skipping');
          }
        }
      }
    }

    // --- settings: per-user encrypted keys ---
    const encryptedSettingKeys = ['webhook_url', 'ntfy_token', 'mapbox_access_token', 'carto_api_key', 'llm_api_key'];
    const settingRows = db.prepare(
      `SELECT user_id, key, value FROM settings WHERE key IN (${encryptedSettingKeys.map(() => '?').join(', ')})`
    ).all(...encryptedSettingKeys) as { user_id: number; key: string; value: string }[];

    for (const row of settingRows) {
      if (!row.value) continue;
      const newVal = migrateApiKeyValue(row.value, `settings[user=${row.user_id}].${row.key}`);
      if (newVal !== null) {
        db.prepare('UPDATE settings SET value = ? WHERE user_id = ? AND key = ?').run(newVal, row.user_id, row.key);
      }
    }

    // --- plugins: OAuth tokens and secret settings fields ---
    // The plugin host encrypts with the same enc:v1: scheme as everything above:
    // plugin-oauth.service stores both tokens encrypted, and plugins.service
    // encrypts every settings field the manifest marked secret (instance scope in
    // plugins.config, user scope in plugin_user_config.config). Left out of a
    // rotation, a connected plugin reads back as "not connected" and a secret
    // setting as unset, with nothing in the log to say why. Every table here
    // arrived with a later migration, so each block checks that it exists.
    const tableExists = (name: string): boolean =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

    if (tableExists('plugin_oauth_tokens')) {
      const tokenRows = db
        .prepare('SELECT plugin_id, user_id, access_token, refresh_token FROM plugin_oauth_tokens')
        .all() as { plugin_id: string; user_id: number; access_token: string | null; refresh_token: string | null }[];
      for (const row of tokenRows) {
        for (const col of ['access_token', 'refresh_token'] as const) {
          const raw = row[col];
          if (!raw) continue;
          const newVal = migrateApiKeyValue(raw, `plugin_oauth_tokens[${row.plugin_id},${row.user_id}].${col}`);
          if (newVal !== null) {
            db.prepare(`UPDATE plugin_oauth_tokens SET ${col} = ? WHERE plugin_id = ? AND user_id = ?`).run(
              newVal,
              row.plugin_id,
              row.user_id,
            );
          }
        }
      }
    }

    if (tableExists('plugin_settings_fields')) {
      // Which keys are secret is per plugin and per scope, and it lives in the DB
      // rather than in this script, so nothing has to be pinned by hand here.
      const secretFields = db
        .prepare("SELECT plugin_id, field_key, scope FROM plugin_settings_fields WHERE secret = 1")
        .all() as { plugin_id: string; field_key: string; scope: string | null }[];
      const secretKeysFor = (pluginId: string, scope: string): string[] =>
        secretFields
          .filter((f) => f.plugin_id === pluginId && (f.scope ?? 'instance') === scope)
          .map((f) => f.field_key);

      const migrateConfigJson = (raw: string | null, keys: string[], label: string): string | null => {
        if (!raw || keys.length === 0) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          result.errors.push(`${label}: invalid JSON — skipping`);
          return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          result.errors.push(`${label}: not an object — skipping`);
          return null;
        }
        const config = parsed as Record<string, unknown>;
        let changed = false;
        for (const key of keys) {
          const value = config[key];
          if (typeof value !== 'string' || !value) continue;
          const newVal = migrateApiKeyValue(value, `${label}.${key}`);
          if (newVal !== null) {
            config[key] = newVal;
            changed = true;
          }
        }
        return changed ? JSON.stringify(config) : null;
      };

      if (tableExists('plugins')) {
        const pluginRows = db.prepare('SELECT id, config FROM plugins').all() as { id: string; config: string | null }[];
        for (const row of pluginRows) {
          const next = migrateConfigJson(row.config, secretKeysFor(row.id, 'instance'), `plugins[${row.id}].config`);
          if (next !== null) {
            db.prepare('UPDATE plugins SET config = ? WHERE id = ?').run(next, row.id);
          }
        }
      }

      if (tableExists('plugin_user_config')) {
        const userConfigRows = db
          .prepare('SELECT plugin_id, user_id, config FROM plugin_user_config')
          .all() as { plugin_id: string; user_id: number; config: string | null }[];
        for (const row of userConfigRows) {
          const next = migrateConfigJson(
            row.config,
            secretKeysFor(row.plugin_id, 'user'),
            `plugin_user_config[${row.plugin_id},${row.user_id}].config`,
          );
          if (next !== null) {
            db.prepare('UPDATE plugin_user_config SET config = ? WHERE plugin_id = ? AND user_id = ?').run(
              next,
              row.plugin_id,
              row.user_id,
            );
          }
        }
      }
    }

    // --- trip_album_links: passphrase ---
    const albumLinks = db.prepare('SELECT id, passphrase FROM trip_album_links WHERE passphrase IS NOT NULL').all() as { id: number; passphrase: string }[];
    for (const row of albumLinks) {
      const newVal = migrateApiKeyValue(row.passphrase, `trip_album_links[${row.id}].passphrase`);
      if (newVal !== null) {
        db.prepare('UPDATE trip_album_links SET passphrase = ? WHERE id = ?').run(newVal, row.id);
      }
    }

    // --- trek_photos: passphrase ---
    const photos = db.prepare('SELECT id, passphrase FROM trek_photos WHERE passphrase IS NOT NULL').all() as { id: number; passphrase: string }[];
    for (const row of photos) {
      const newVal = migrateApiKeyValue(row.passphrase, `trek_photos[${row.id}].passphrase`);
      if (newVal !== null) {
        db.prepare('UPDATE trek_photos SET passphrase = ? WHERE id = ?').run(newVal, row.id);
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
