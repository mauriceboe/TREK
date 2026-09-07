import { DatabaseService } from '../database/database.service';
import { decrypt_api_key, maybe_encrypt_api_key } from '../common/crypto/apiKeyCrypto';

/**
 * The third-party keys that belong to the instance rather than to a person.
 *
 * Google Places and Unsplash bill the install, not the account that pasted the
 * key in, so the value is instance configuration — the same argument #1772 made
 * for the LLM endpoint (see llm-parse/llm-config.ts: instance-wide, admin-set,
 * wins; per-user as the fallback). Both keys used to be resolved out of the
 * `users` columns alone, which meant "the key of the admin with the lowest id"
 * for everyone else and produced #1939: the admin searched with the key they
 * had just saved, every other member searched with a stranger's and got a 403
 * from Google.
 *
 * Stored as an encrypted `app_settings` row under the name below, reusing
 * apiKeyCrypto, so the format matches what the users columns already hold and
 * a legacy plaintext value still reads back.
 */
export type InstanceApiKeyName = 'maps_api_key' | 'unsplash_api_key' | 'amap_api_key';

/** Instance names whose per-user column is still honoured as a last resort. */
export const INSTANCE_API_KEY_NAMES: readonly InstanceApiKeyName[] = [
  'maps_api_key',
  'unsplash_api_key',
  'amap_api_key',
];

/**
 * Where a resolved key came from. Logged beside a provider error so "works for
 * the admin, 403 for everyone else" is one line in the log rather than a
 * guessing game; the key itself is never logged.
 */
export type ApiKeySource = 'operator-env' | 'instance' | 'user-row';

// Full statements rather than an interpolated column: the name doubles as the
// users column AND the app_settings key, and identifiers only ever come from a
// literal allow-list.
const USER_ROW_SQL: Record<InstanceApiKeyName, string> = {
  maps_api_key: 'SELECT maps_api_key FROM users WHERE id = ?',
  unsplash_api_key: 'SELECT unsplash_api_key FROM users WHERE id = ?',
  amap_api_key: 'SELECT amap_api_key FROM users WHERE id = ?',
};

/** The instance-wide value in cleartext, or null when unset/cleared. */
export function readInstanceApiKey(db: DatabaseService, name: InstanceApiKeyName): string | null {
  const row = db.get<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', name);
  if (!row?.value) return null;
  return decrypt_api_key(row.value) || null;
}

/**
 * Store the instance-wide value, encrypted. A blank value stores '' rather than
 * deleting the row: an admin who clears the field means "this instance has no
 * key", and a missing row would let the resolver fall through to whatever old
 * value still sits in their own users column.
 */
export function writeInstanceApiKey(db: DatabaseService, name: InstanceApiKeyName, value: unknown): void {
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    name, maybe_encrypt_api_key(value) ?? ''
  );
}

/**
 * Resolve a key for one request: operator env → instance-wide → the caller's
 * own row.
 *
 * The caller's own row is last, not second, and no other user's row is ever
 * read — falling back to a stranger's key is what server/CLAUDE.md forbids and
 * what #1939 reported. It stays as a fallback because `PUT /me/api-keys` has
 * always accepted a personal key and dropping it would break the installs where
 * each member pays for their own.
 *
 * `userId` 0 means "nobody is asking" (the unauthenticated app-config read):
 * there is no personal key to find, so the chain ends at the instance.
 */
export function resolveApiKey(
  db: DatabaseService,
  name: InstanceApiKeyName,
  userId: number,
  operatorKey: string | undefined,
): { key: string | null; source: ApiKeySource | null } {
  if (operatorKey) return { key: operatorKey, source: 'operator-env' };

  const instance = readInstanceApiKey(db, name);
  if (instance) return { key: instance, source: 'instance' };
  if (!userId) return { key: null, source: null };

  const row = db.get<Record<string, string | null>>(USER_ROW_SQL[name], userId);
  const own = decrypt_api_key(row?.[name]) || null;
  return own ? { key: own, source: 'user-row' } : { key: null, source: null };
}
