import { db } from '../db/database';

export function getUserSettings(userId: number): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as { key: string; value: string }[];
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

export function upsertSetting(userId: number, key: string, value: unknown) {
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, serialized);
}

export function bulkUpsertSettings(userId: number, settings: Record<string, unknown>) {
  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(settings)) {
      const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
      upsert.run(userId, key, serialized);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return Object.keys(settings).length;
}
