import { TRANSIT_PROVIDERS, type TransitProvider } from '@trek/shared';
import type { DatabaseService } from '../database/database.service';

/**
 * Which backend answers /api/transit (#1699), stored as one `app_settings` row.
 *
 * Kept as plain functions rather than a service (the instance-api-keys.ts
 * precedent) because two modules need the value and neither should own the
 * other: AddonsService writes it from the admin panel, TransitService reads it
 * per request. One reader, one writer, one key — no mirrored copy.
 */
export const TRANSIT_PROVIDER_SETTING = 'transit_provider';

/** Free, keyless, and what every install has today. Also the fallback. */
export const DEFAULT_TRANSIT_PROVIDER: TransitProvider = 'transitous';

function isTransitProvider(value: unknown): value is TransitProvider {
  return typeof value === 'string' && (TRANSIT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Reads fail-safe: a missing row, or a value written by a newer version that
 * this one does not know, resolves to Transitous. The alternative is billing an
 * admin's Google key because a string did not parse.
 */
export function readTransitProvider(db: DatabaseService): TransitProvider {
  const row = db.get<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', TRANSIT_PROVIDER_SETTING);
  return isTransitProvider(row?.value) ? row.value : DEFAULT_TRANSIT_PROVIDER;
}

export function writeTransitProvider(db: DatabaseService, provider: TransitProvider): TransitProvider {
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    TRANSIT_PROVIDER_SETTING, provider
  );
  return provider;
}
