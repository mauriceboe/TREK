import { readEnv } from '../app-config';
import { encrypt_api_key } from '../nest/common/crypto/apiKeyCrypto';

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** Returns true if any collision was encountered (renamed row). */
export function trimUserWhitespace(db: Database.Database): boolean {
  type DirtyRow = { id: number; username?: string; email?: string };
  let hadCollision = false;

  const dirtyUsernames = db
    .prepare(`SELECT id, username FROM users WHERE username != TRIM(username)`)
    .all() as DirtyRow[];

  for (const row of dirtyUsernames) {
    const trimmed = row.username!.trim();
    const collision = db
      .prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?`)
      .get(trimmed, row.id) as { id: number } | undefined;

    const final = collision ? `${trimmed}__migrated_${row.id}` : trimmed;
    if (collision) {
      hadCollision = true;
      console.warn(
        `[migration] WHITESPACE COLLISION username: user id=${row.id} ` +
          `original=${JSON.stringify(row.username)} trimmed="${trimmed}" ` +
          `collides with user id=${collision.id}. Renamed to "${final}". ` +
          `Manual review required.`,
      );
    } else {
      console.warn(
        `[migration] Trimmed username for user id=${row.id}: ` + `${JSON.stringify(row.username)} → "${final}"`,
      );
    }
    db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(final, row.id);
  }

  const dirtyEmails = db.prepare(`SELECT id, email FROM users WHERE email != TRIM(email)`).all() as DirtyRow[];

  for (const row of dirtyEmails) {
    const trimmed = row.email!.trim();
    const collision = db
      .prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?`)
      .get(trimmed, row.id) as { id: number } | undefined;

    let final = trimmed;
    if (collision) {
      hadCollision = true;
      const at = trimmed.lastIndexOf('@');
      final =
        at > 0 ? `${trimmed.slice(0, at)}__migrated_${row.id}${trimmed.slice(at)}` : `${trimmed}__migrated_${row.id}`;
      console.warn(
        `[migration] WHITESPACE COLLISION email: user id=${row.id} ` +
          `original=${JSON.stringify(row.email)} trimmed="${trimmed}" ` +
          `collides with user id=${collision.id}. Renamed to "${final}". ` +
          `User cannot sign in with this email until manually corrected.`,
      );
    } else {
      console.warn(`[migration] Trimmed email for user id=${row.id}: ` + `${JSON.stringify(row.email)} → "${final}"`);
    }
    db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(final, row.id);
  }

  return hadCollision;
}

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const versionRow = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let currentVersion = versionRow?.version ?? 0;

  if (currentVersion === 0) {
    const hasUnsplash = db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'unsplash_api_key'").get();
    if (hasUnsplash) {
      currentVersion = 19;
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentVersion);
      console.log('[DB] Schema already up-to-date, setting version to', currentVersion);
    } else {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(0);
    }
  }

  type Migration = (() => void) | { raw: () => void };
  const migrations: Migration[] = [
    () => db.exec('ALTER TABLE users ADD COLUMN unsplash_api_key TEXT'),
    () => db.exec('ALTER TABLE users ADD COLUMN openweather_api_key TEXT'),
    () => db.exec('ALTER TABLE places ADD COLUMN duration_minutes INTEGER DEFAULT 60'),
    () => db.exec('ALTER TABLE places ADD COLUMN notes TEXT'),
    () => db.exec('ALTER TABLE places ADD COLUMN image_url TEXT'),
    () => db.exec("ALTER TABLE places ADD COLUMN transport_mode TEXT DEFAULT 'walking'"),
    () => db.exec('ALTER TABLE days ADD COLUMN title TEXT'),
    () => db.exec("ALTER TABLE reservations ADD COLUMN status TEXT DEFAULT 'pending'"),
    () =>
      db.exec(
        'ALTER TABLE trip_files ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL',
      ),
    () => db.exec("ALTER TABLE reservations ADD COLUMN type TEXT DEFAULT 'other'"),
    () => db.exec('ALTER TABLE trips ADD COLUMN cover_image TEXT'),
    () => db.exec("ALTER TABLE day_notes ADD COLUMN icon TEXT DEFAULT '📝'"),
    () => db.exec('ALTER TABLE trips ADD COLUMN is_archived INTEGER DEFAULT 0'),
    () => db.exec('ALTER TABLE categories ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'),
    () => db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'),
    () => db.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT'),
    () => db.exec('ALTER TABLE users ADD COLUMN oidc_issuer TEXT'),
    () => db.exec('ALTER TABLE users ADD COLUMN last_login DATETIME'),
    () => {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_items'").get() as
        | { sql: string }
        | undefined;
      if (schema?.sql?.includes('NOT NULL DEFAULT 1')) {
        db.exec(`
          CREATE TABLE budget_items_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            category TEXT NOT NULL DEFAULT 'Other',
            name TEXT NOT NULL,
            total_price REAL NOT NULL DEFAULT 0,
            persons INTEGER DEFAULT NULL,
            days INTEGER DEFAULT NULL,
            note TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO budget_items_new SELECT * FROM budget_items;
          DROP TABLE budget_items;
          ALTER TABLE budget_items_new RENAME TO budget_items;
        `);
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE day_accommodations ADD COLUMN check_in TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE day_accommodations ADD COLUMN check_out TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE day_accommodations ADD COLUMN confirmation TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE places ADD COLUMN end_time TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec("ALTER TABLE day_assignments ADD COLUMN reservation_status TEXT DEFAULT 'none'");
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_notes TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_datetime TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec(`
          UPDATE day_assignments SET
            reservation_status = (SELECT reservation_status FROM places WHERE places.id = day_assignments.place_id),
            reservation_notes = (SELECT reservation_notes FROM places WHERE places.id = day_assignments.place_id),
            reservation_datetime = (SELECT reservation_datetime FROM places WHERE places.id = day_assignments.place_id)
          WHERE place_id IN (SELECT id FROM places WHERE reservation_status IS NOT NULL AND reservation_status != 'none')
        `);
        console.log('[DB] Migrated reservation data from places to day_assignments');
      } catch (e: unknown) {
        console.error('[DB] Migration 22 data copy error:', e instanceof Error ? e.message : e);
      }
    },
    () => {
      try {
        db.exec(
          'ALTER TABLE reservations ADD COLUMN assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL',
        );
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assignment_participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          assignment_id INTEGER NOT NULL REFERENCES day_assignments(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(assignment_id, user_id)
        )
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collab_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          category TEXT DEFAULT 'General',
          title TEXT NOT NULL,
          content TEXT,
          color TEXT DEFAULT '#6366f1',
          pinned INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS collab_polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          options TEXT NOT NULL,
          multiple INTEGER DEFAULT 0,
          closed INTEGER DEFAULT 0,
          deadline TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS collab_poll_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_id INTEGER NOT NULL REFERENCES collab_polls(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          option_index INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(poll_id, user_id, option_index)
        );
        CREATE TABLE IF NOT EXISTS collab_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          reply_to INTEGER REFERENCES collab_messages(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_collab_notes_trip ON collab_notes(trip_id);
        CREATE INDEX IF NOT EXISTS idx_collab_polls_trip ON collab_polls(trip_id);
        CREATE INDEX IF NOT EXISTS idx_collab_messages_trip ON collab_messages(trip_id);
      `);
      try {
        db.prepare(
          "INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES ('collab', 'Collab', 'Notes, polls, and live chat for trip collaboration', 'trip', 'Users', 1, 6)",
        ).run();
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_time TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_end_time TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec(`
          UPDATE day_assignments SET
            assignment_time = (SELECT place_time FROM places WHERE places.id = day_assignments.place_id),
            assignment_end_time = (SELECT end_time FROM places WHERE places.id = day_assignments.place_id)
        `);
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_item_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          budget_item_id INTEGER NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          paid INTEGER NOT NULL DEFAULT 0,
          UNIQUE(budget_item_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_budget_item_members_item ON budget_item_members(budget_item_id);
        CREATE INDEX IF NOT EXISTS idx_budget_item_members_user ON budget_item_members(user_id);
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collab_message_reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES collab_messages(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(message_id, user_id, emoji)
        );
        CREATE INDEX IF NOT EXISTS idx_collab_reactions_msg ON collab_message_reactions(message_id);
      `);
    },
    () => {
      try {
        db.exec('ALTER TABLE collab_messages ADD COLUMN deleted INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE trip_files ADD COLUMN note_id INTEGER REFERENCES collab_notes(id) ON DELETE SET NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE collab_notes ADD COLUMN website TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN reservation_end_time TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE places ADD COLUMN osm_id TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE trip_files ADD COLUMN uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE trip_files ADD COLUMN starred INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE trip_files ADD COLUMN deleted_at TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec(
          'ALTER TABLE reservations ADD COLUMN accommodation_id INTEGER REFERENCES day_accommodations(id) ON DELETE SET NULL',
        );
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN metadata TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS invite_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    },
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS packing_category_assignees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        category_name TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(trip_id, category_name, user_id)
      )`);
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS packing_template_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES packing_templates(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`);
      // Recreate items table with category_id FK (replaces old template_id-based schema)
      try {
        db.exec('DROP TABLE IF EXISTS packing_template_items');
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      db.exec(`CREATE TABLE packing_template_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES packing_template_categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`);
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS packing_bags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6366f1',
        weight_limit_grams INTEGER,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      try {
        db.exec('ALTER TABLE packing_items ADD COLUMN weight_grams INTEGER');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE packing_items ADD COLUMN bag_id INTEGER REFERENCES packing_bags(id) ON DELETE SET NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS visited_countries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        country_code TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, country_code)
      )`);
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS bucket_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        lat REAL,
        lng REAL,
        country_code TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    },
    () => {
      // Configurable weekend days
      try {
        db.exec("ALTER TABLE vacay_plans ADD COLUMN weekend_days TEXT DEFAULT '0,6'");
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Immich integration
      try {
        db.exec('ALTER TABLE users ADD COLUMN immich_url TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN immich_api_key TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec(`CREATE TABLE IF NOT EXISTS trip_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        immich_asset_id TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 1,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trip_id, user_id, immich_asset_id)
      )`);
      // Add memories addon
      try {
        db.prepare('INSERT INTO addons (id, name, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
          'memories',
          'Photos',
          'trip',
          'Image',
          0,
          7,
        );
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      // Allow files to be linked to multiple reservations/assignments
      db.exec(`CREATE TABLE IF NOT EXISTS file_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES trip_files(id) ON DELETE CASCADE,
        reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
        assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE CASCADE,
        place_id INTEGER REFERENCES places(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(file_id, reservation_id),
        UNIQUE(file_id, assignment_id),
        UNIQUE(file_id, place_id)
      )`);
    },
    () => {
      // Add day_plan_position to reservations for persistent transport ordering in day timeline
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN day_plan_position REAL DEFAULT NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Add paid_by_user_id to budget_items for expense tracking / settlement
      try {
        db.exec('ALTER TABLE budget_items ADD COLUMN paid_by_user_id INTEGER REFERENCES users(id)');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Add target_date to bucket_list for optional visit planning
      try {
        db.exec('ALTER TABLE bucket_list ADD COLUMN target_date TEXT DEFAULT NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Notification preferences per user
      db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notify_trip_invite INTEGER DEFAULT 1,
        notify_booking_change INTEGER DEFAULT 1,
        notify_trip_reminder INTEGER DEFAULT 1,
        notify_vacay_invite INTEGER DEFAULT 1,
        notify_photos_shared INTEGER DEFAULT 1,
        notify_collab_message INTEGER DEFAULT 1,
        notify_packing_tagged INTEGER DEFAULT 1,
        notify_webhook INTEGER DEFAULT 0,
        UNIQUE(user_id)
      )`);
    },
    () => {
      // Add missing notification preference columns for existing tables
      try {
        db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_vacay_invite INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_photos_shared INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_collab_message INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_packing_tagged INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Public share links for read-only trip access
      db.exec(`CREATE TABLE IF NOT EXISTS share_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        created_by INTEGER NOT NULL REFERENCES users(id),
        share_map INTEGER DEFAULT 1,
        share_bookings INTEGER DEFAULT 1,
        share_packing INTEGER DEFAULT 0,
        share_budget INTEGER DEFAULT 0,
        share_collab INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    },
    () => {
      // Add permission columns to share_tokens
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN share_map INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN share_bookings INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN share_packing INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN share_budget INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN share_collab INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Audit log
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
      `);
    },
    () => {
      // MFA backup/recovery codes
      try {
        db.exec('ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // MCP long-lived API tokens
    () =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )
    `),
    // MCP addon entry
    () => {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run('mcp', 'MCP', 'Model Context Protocol for AI assistant integration', 'integration', 'Terminal', 0, 12);
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Index on mcp_tokens.token_hash
    () =>
      db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash)
    `),
    // Ensure MCP addon type is 'integration'
    () => {
      try {
        db.prepare("UPDATE addons SET type = 'integration' WHERE id = 'mcp'").run();
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE places ADD COLUMN route_geometry TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE trips ADD COLUMN reminder_days INTEGER DEFAULT 3');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Encrypt any plaintext oidc_client_secret left in app_settings
    () => {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_secret'").get() as
        | { value: string }
        | undefined;
      if (row?.value && !row.value.startsWith('enc:v1:')) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'oidc_client_secret'").run(
          encrypt_api_key(row.value),
        );
      }
    },
    // Encrypt any plaintext smtp_pass left in app_settings
    () => {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'smtp_pass'").get() as
        | { value: string }
        | undefined;
      if (row?.value && !row.value.startsWith('enc:v1:')) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'smtp_pass'").run(encrypt_api_key(row.value));
      }
    },
    // Encrypt any plaintext immich_api_key values in the users table
    () => {
      const rows = db
        .prepare(
          "SELECT id, immich_api_key FROM users WHERE immich_api_key IS NOT NULL AND immich_api_key != '' AND immich_api_key NOT LIKE 'enc:v1:%'",
        )
        .all() as { id: number; immich_api_key: string }[];
      for (const row of rows) {
        db.prepare('UPDATE users SET immich_api_key = ? WHERE id = ?').run(encrypt_api_key(row.immich_api_key), row.id);
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE budget_items ADD COLUMN expense_date TEXT DEFAULT NULL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trip_album_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          immich_album_id TEXT NOT NULL,
          album_name TEXT NOT NULL DEFAULT '',
          sync_enabled INTEGER NOT NULL DEFAULT 1,
          last_synced_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(trip_id, user_id, immich_album_id)
        );
        CREATE INDEX IF NOT EXISTS idx_trip_album_links_trip ON trip_album_links(trip_id);
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('simple', 'boolean', 'navigate')),
          scope TEXT NOT NULL CHECK(scope IN ('trip', 'user', 'admin')),
          target INTEGER NOT NULL,
          sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title_key TEXT NOT NULL,
          title_params TEXT DEFAULT '{}',
          text_key TEXT NOT NULL,
          text_params TEXT DEFAULT '{}',
          positive_text_key TEXT,
          negative_text_key TEXT,
          positive_callback TEXT,
          negative_callback TEXT,
          response TEXT CHECK(response IN ('positive', 'negative')),
          navigate_text_key TEXT,
          navigate_target TEXT,
          is_read INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, is_read, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_id, created_at DESC);
      `);
    },
    () => {
      // Normalize trip_photos to provider-based schema used by current routes
      const tripPhotosExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_photos'")
        .get();
      if (!tripPhotosExists) {
        db.exec(`
          CREATE TABLE trip_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'immich',
            shared INTEGER NOT NULL DEFAULT 1,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(trip_id, user_id, asset_id, provider)
          );
          CREATE INDEX IF NOT EXISTS idx_trip_photos_trip ON trip_photos(trip_id);
        `);
      } else {
        const columns = db.prepare("PRAGMA table_info('trip_photos')").all() as Array<{ name: string }>;
        const names = new Set(columns.map((c) => c.name));
        const assetSource = names.has('asset_id')
          ? 'asset_id'
          : names.has('immich_asset_id')
            ? 'immich_asset_id'
            : null;
        if (assetSource) {
          const providerExpr = names.has('provider')
            ? "CASE WHEN provider IS NULL OR provider = '' THEN 'immich' ELSE provider END"
            : "'immich'";
          const sharedExpr = names.has('shared') ? 'COALESCE(shared, 1)' : '1';
          const addedAtExpr = names.has('added_at') ? 'COALESCE(added_at, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';

          db.exec(`
            CREATE TABLE trip_photos_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              asset_id TEXT NOT NULL,
              provider TEXT NOT NULL DEFAULT 'immich',
              shared INTEGER NOT NULL DEFAULT 1,
              added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(trip_id, user_id, asset_id, provider)
            );
          `);

          db.exec(`
            INSERT OR IGNORE INTO trip_photos_new (trip_id, user_id, asset_id, provider, shared, added_at)
            SELECT trip_id, user_id, ${assetSource}, ${providerExpr}, ${sharedExpr}, ${addedAtExpr}
            FROM trip_photos
            WHERE ${assetSource} IS NOT NULL AND TRIM(${assetSource}) != ''
          `);

          db.exec('DROP TABLE trip_photos');
          db.exec('ALTER TABLE trip_photos_new RENAME TO trip_photos');
          db.exec('CREATE INDEX IF NOT EXISTS idx_trip_photos_trip ON trip_photos(trip_id)');
        }
      }
    },
    () => {
      // Normalize trip_album_links to provider + album_id schema used by current routes
      const linksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_album_links'")
        .get();
      if (!linksExists) {
        db.exec(`
          CREATE TABLE trip_album_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            album_id TEXT NOT NULL,
            album_name TEXT NOT NULL DEFAULT '',
            sync_enabled INTEGER NOT NULL DEFAULT 1,
            last_synced_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(trip_id, user_id, provider, album_id)
          );
          CREATE INDEX IF NOT EXISTS idx_trip_album_links_trip ON trip_album_links(trip_id);
        `);
      } else {
        const columns = db.prepare("PRAGMA table_info('trip_album_links')").all() as Array<{ name: string }>;
        const names = new Set(columns.map((c) => c.name));
        const albumIdSource = names.has('album_id')
          ? 'album_id'
          : names.has('immich_album_id')
            ? 'immich_album_id'
            : null;
        if (albumIdSource) {
          const providerExpr = names.has('provider')
            ? "CASE WHEN provider IS NULL OR provider = '' THEN 'immich' ELSE provider END"
            : "'immich'";
          const albumNameExpr = names.has('album_name') ? "COALESCE(album_name, '')" : "''";
          const syncEnabledExpr = names.has('sync_enabled') ? 'COALESCE(sync_enabled, 1)' : '1';
          const lastSyncedExpr = names.has('last_synced_at') ? 'last_synced_at' : 'NULL';
          const createdAtExpr = names.has('created_at')
            ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
            : 'CURRENT_TIMESTAMP';

          db.exec(`
            CREATE TABLE trip_album_links_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              provider TEXT NOT NULL,
              album_id TEXT NOT NULL,
              album_name TEXT NOT NULL DEFAULT '',
              sync_enabled INTEGER NOT NULL DEFAULT 1,
              last_synced_at DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(trip_id, user_id, provider, album_id)
            );
          `);

          db.exec(`
            INSERT OR IGNORE INTO trip_album_links_new (trip_id, user_id, provider, album_id, album_name, sync_enabled, last_synced_at, created_at)
            SELECT trip_id, user_id, ${providerExpr}, ${albumIdSource}, ${albumNameExpr}, ${syncEnabledExpr}, ${lastSyncedExpr}, ${createdAtExpr}
            FROM trip_album_links
            WHERE ${albumIdSource} IS NOT NULL AND TRIM(${albumIdSource}) != ''
          `);

          db.exec('DROP TABLE trip_album_links');
          db.exec('ALTER TABLE trip_album_links_new RENAME TO trip_album_links');
          db.exec('CREATE INDEX IF NOT EXISTS idx_trip_album_links_trip ON trip_album_links(trip_id)');
        }
      }
    },
    () => {
      // Add Synology credential columns for existing databases
      try {
        db.exec('ALTER TABLE users ADD COLUMN synology_url TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN synology_username TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN synology_password TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN synology_sid TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // Seed Synology Photos provider and fields in existing databases
      try {
        db.prepare(
          `
          INSERT INTO photo_providers (id, name, description, icon, enabled, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            icon = excluded.icon,
            enabled = excluded.enabled,
            sort_order = excluded.sort_order
        `,
        ).run(
          'synologyphotos',
          'Synology Photos',
          'Synology Photos integration with separate account settings',
          'Image',
          0,
          1,
        );
      } catch (err: any) {
        if (!err.message?.includes('no such table')) throw err;
      }
      try {
        const insertField = db.prepare(`
          INSERT INTO photo_provider_fields
          (provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_id, field_key) DO UPDATE SET
            label = excluded.label,
            input_type = excluded.input_type,
            placeholder = excluded.placeholder,
            required = excluded.required,
            secret = excluded.secret,
            settings_key = excluded.settings_key,
            payload_key = excluded.payload_key,
            sort_order = excluded.sort_order
        `);
        insertField.run(
          'synologyphotos',
          'synology_url',
          'providerUrl',
          'url',
          'https://synology.example.com',
          1,
          0,
          'synology_url',
          'synology_url',
          0,
        );
        insertField.run(
          'synologyphotos',
          'synology_username',
          'providerUsername',
          'text',
          'Username',
          1,
          0,
          'synology_username',
          'synology_username',
          1,
        );
        insertField.run(
          'synologyphotos',
          'synology_password',
          'providerPassword',
          'password',
          'Password',
          1,
          1,
          null,
          'synology_password',
          2,
        );
      } catch (err: any) {
        if (!err.message?.includes('no such table')) throw err;
      }
    },
    () => {
      // Remove the stored config column from photo_providers now that it is generated from provider id.
      const columns = db.prepare("PRAGMA table_info('photo_providers')").all() as Array<{ name: string }>;
      const names = new Set(columns.map((c) => c.name));
      if (!names.has('config')) return;

      db.exec('ALTER TABLE photo_providers DROP COLUMN config');
    },
    () => {
      const columns = db.prepare("PRAGMA table_info('trip_photos')").all() as Array<{ name: string }>;
      const names = new Set(columns.map((c) => c.name));
      if (names.has('asset_id') && !names.has('immich_asset_id')) return;
      db.exec('ALTER TABLE `trip_photos` RENAME COLUMN immich_asset_id TO asset_id');
      db.exec('ALTER TABLE `trip_photos` ADD COLUMN provider TEXT NOT NULL DEFAULT "immich"');
      db.exec('ALTER TABLE `trip_album_links` ADD COLUMN provider TEXT NOT NULL DEFAULT "immich"');
      db.exec('ALTER TABLE `trip_album_links` RENAME COLUMN immich_album_id TO album_id');
    },
    () => {
      // Track which album link each photo was synced from
      try {
        db.exec(
          'ALTER TABLE trip_photos ADD COLUMN album_link_id INTEGER REFERENCES trip_album_links(id) ON DELETE SET NULL DEFAULT NULL',
        );
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_trip_photos_album_link ON trip_photos(album_link_id)');
    },
    // Migration 68: Todo items
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS todo_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          checked INTEGER DEFAULT 0,
          category TEXT,
          sort_order INTEGER DEFAULT 0,
          due_date TEXT,
          description TEXT,
          assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          priority INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_todo_items_trip_id ON todo_items(trip_id);

        CREATE TABLE IF NOT EXISTS todo_category_assignees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          category_name TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(trip_id, category_name, user_id)
        );
      `);
    },
    () => {
      try {
        db.exec("UPDATE addons SET enabled = 0 WHERE id = 'memories'");
      } catch (err) {
        // Non-fatal: the addons table may not exist yet on very old databases.
        // Disabling the legacy memories addon is best-effort, but we no longer
        // swallow the error silently.
        console.warn("[migrations] Non-fatal: failed to disable legacy 'memories' addon:", err);
      }
    },
    // Migration 69: Place region cache for sub-national Atlas regions
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS place_regions (
          place_id INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
          country_code TEXT NOT NULL,
          region_code TEXT NOT NULL,
          region_name TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_place_regions_country ON place_regions(country_code);
        CREATE INDEX IF NOT EXISTS idx_place_regions_region ON place_regions(region_code);
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS visited_regions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          region_code TEXT NOT NULL,
          region_name TEXT NOT NULL,
          country_code TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, region_code)
        );
        CREATE INDEX IF NOT EXISTS idx_visited_regions_country ON visited_regions(country_code);
      `);
    },
    // Migration 71: Normalized per-user per-channel notification preferences
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_channel_preferences (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          channel TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (user_id, event_type, channel)
        );
        CREATE INDEX IF NOT EXISTS idx_ncp_user ON notification_channel_preferences(user_id);
      `);

      // Migrate data from old notification_preferences table (may not exist on fresh installs)
      const tableExists =
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_preferences'").get() as
          | { name: string }
          | undefined) != null;
      const oldPrefs: Array<Record<string, number>> = tableExists
        ? (db.prepare('SELECT * FROM notification_preferences').all() as Array<Record<string, number>>)
        : [];
      const eventCols: Record<string, string> = {
        trip_invite: 'notify_trip_invite',
        booking_change: 'notify_booking_change',
        trip_reminder: 'notify_trip_reminder',
        vacay_invite: 'notify_vacay_invite',
        photos_shared: 'notify_photos_shared',
        collab_message: 'notify_collab_message',
        packing_tagged: 'notify_packing_tagged',
      };
      const insert = db.prepare(
        'INSERT OR IGNORE INTO notification_channel_preferences (user_id, event_type, channel, enabled) VALUES (?, ?, ?, ?)',
      );
      const insertMany = db.transaction((rows: Array<[number, string, string, number]>) => {
        for (const [userId, eventType, channel, enabled] of rows) {
          insert.run(userId, eventType, channel, enabled);
        }
      });

      for (const row of oldPrefs) {
        const userId = row.user_id as number;
        const webhookEnabled = (row.notify_webhook as number) ?? 0;
        const rows: Array<[number, string, string, number]> = [];
        for (const [eventType, col] of Object.entries(eventCols)) {
          const emailEnabled = (row[col] as number) ?? 1;
          // Only insert if disabled (no row = enabled is our default)
          if (!emailEnabled) rows.push([userId, eventType, 'email', 0]);
          if (!webhookEnabled) rows.push([userId, eventType, 'webhook', 0]);
        }
        if (rows.length > 0) insertMany(rows);
      }

      // Copy existing single-channel setting to new plural key
      db.exec(`
        INSERT OR IGNORE INTO app_settings (key, value)
          SELECT 'notification_channels', value FROM app_settings WHERE key = 'notification_channel';
      `);
    },
    // Migration 72: Drop the old notification_preferences table (data migrated to notification_channel_preferences in migration 71)
    () => {
      db.exec('DROP TABLE IF EXISTS notification_preferences;');
    },
    // Migration 73: Add reservation_id to budget_items for linking budget entries to reservations
    () => {
      try {
        db.exec(
          'ALTER TABLE budget_items ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL DEFAULT NULL',
        );
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration 74: Add quantity to packing_items + user_id to packing_bags + bag_members table
    () => {
      try {
        db.exec('ALTER TABLE packing_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec(
          'ALTER TABLE packing_bags ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL DEFAULT NULL',
        );
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS packing_bag_members (
          bag_id INTEGER NOT NULL REFERENCES packing_bags(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (bag_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_packing_bag_members_bag ON packing_bag_members(bag_id);
      `);
      // Migrate existing single user_id to bag_members
      const bagsWithUser = db.prepare('SELECT id, user_id FROM packing_bags WHERE user_id IS NOT NULL').all() as {
        id: number;
        user_id: number;
      }[];
      const ins = db.prepare('INSERT OR IGNORE INTO packing_bag_members (bag_id, user_id) VALUES (?, ?)');
      for (const b of bagsWithUser) ins.run(b.id, b.user_id);
    },
    // Migration: Per-day positions for multi-day reservations
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reservation_day_positions (
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
          day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
          position REAL NOT NULL,
          PRIMARY KEY (reservation_id, day_id)
        );
      `);
      // Migrate existing global positions to per-day entries
      const reservations = db
        .prepare(
          'SELECT id, trip_id, reservation_time, reservation_end_time, day_plan_position FROM reservations WHERE day_plan_position IS NOT NULL',
        )
        .all() as any[];
      const ins = db.prepare(
        'INSERT OR IGNORE INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)',
      );
      for (const r of reservations) {
        const startDate = r.reservation_time?.split('T')[0];
        const endDate = r.reservation_end_time?.split('T')[0] || startDate;
        if (!startDate) continue;
        const matchingDays = db
          .prepare('SELECT id FROM days WHERE trip_id = ? AND date >= ? AND date <= ?')
          .all(r.trip_id, startDate, endDate) as { id: number }[];
        for (const d of matchingDays) ins.run(r.id, d.id, r.day_plan_position);
      }
    },
    // Migration: Budget category ordering
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_category_order (
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (trip_id, category)
        );
      `);
      // Seed existing categories with alphabetical order
      const rows = db
        .prepare('SELECT DISTINCT trip_id, category FROM budget_items ORDER BY trip_id, category')
        .all() as { trip_id: number; category: string }[];
      const ins = db.prepare(
        'INSERT OR IGNORE INTO budget_category_order (trip_id, category, sort_order) VALUES (?, ?, ?)',
      );
      let lastTripId = -1;
      let idx = 0;
      for (const r of rows) {
        if (r.trip_id !== lastTripId) {
          lastTripId = r.trip_id;
          idx = 0;
        }
        ins.run(r.trip_id, r.category, idx++);
      }
    },
    // Migration: Naver list import addon (default off)
    () => {
      try {
        db.prepare(
          `
          INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          'naver_list_import',
          'Naver List Import',
          'Import places from shared Naver Maps lists',
          'trip',
          'Link2',
          0,
          13,
        );
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration: OAuth 2.1 clients, consents, and tokens for MCP
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_clients (
          id                 TEXT PRIMARY KEY,
          user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name               TEXT NOT NULL,
          client_id          TEXT UNIQUE NOT NULL,
          client_secret_hash TEXT NOT NULL,
          redirect_uris      TEXT NOT NULL DEFAULT '[]',
          allowed_scopes     TEXT NOT NULL DEFAULT '[]',
          created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_clients_user ON oauth_clients(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

        CREATE TABLE IF NOT EXISTS oauth_consents (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scopes     TEXT NOT NULL DEFAULT '[]',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(client_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS oauth_tokens (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id                 TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_token_hash         TEXT UNIQUE NOT NULL,
          refresh_token_hash        TEXT UNIQUE NOT NULL,
          scopes                    TEXT NOT NULL DEFAULT '[]',
          access_token_expires_at   DATETIME NOT NULL,
          refresh_token_expires_at  DATETIME NOT NULL,
          revoked_at                DATETIME,
          created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_access  ON oauth_tokens(access_token_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
      `);
    },
    // Migration: Refresh-token rotation chain tracking for replay detection
    () => {
      db.exec(`
        ALTER TABLE oauth_tokens ADD COLUMN parent_token_id INTEGER REFERENCES oauth_tokens(id);
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_parent ON oauth_tokens(parent_token_id);
      `);
    },
    // Migration: Public client support for browser-initiated dynamic registration (DCR)
    () => {
      db.exec(`
        ALTER TABLE oauth_clients ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE oauth_clients ADD COLUMN created_via TEXT NOT NULL DEFAULT 'settings_ui';
      `);
    },
    // Migration: Make oauth_clients.user_id nullable to support anonymous RFC 7591 DCR clients
    // (must run outside a transaction because PRAGMA foreign_keys cannot change mid-transaction)
    {
      raw: () => {
        db.exec('PRAGMA foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(`
              CREATE TABLE IF NOT EXISTS oauth_clients_new (
                id                 TEXT PRIMARY KEY,
                user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name               TEXT NOT NULL,
                client_id          TEXT UNIQUE NOT NULL,
                client_secret_hash TEXT NOT NULL,
                redirect_uris      TEXT NOT NULL DEFAULT '[]',
                allowed_scopes     TEXT NOT NULL DEFAULT '[]',
                created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_public          INTEGER NOT NULL DEFAULT 0,
                created_via        TEXT NOT NULL DEFAULT 'settings_ui'
              )
            `);
            db.exec(
              `INSERT INTO oauth_clients_new SELECT id, user_id, name, client_id, client_secret_hash, redirect_uris, allowed_scopes, created_at, is_public, created_via FROM oauth_clients`,
            );
            db.exec(`DROP TABLE oauth_clients`);
            db.exec(`ALTER TABLE oauth_clients_new RENAME TO oauth_clients`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_clients_user ON oauth_clients(user_id)`);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id)`);
          })();
        } finally {
          db.exec('PRAGMA foreign_keys = ON');
        }
      },
    },
    // Migration: Add OTP field, skip_ssl column, device_id (did) column, and hint column for Synology Photos
    () => {
      const cols = db.prepare('PRAGMA table_info(photo_provider_fields)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'hint')) {
        db.exec(`ALTER TABLE photo_provider_fields ADD COLUMN hint TEXT`);
      }
      db.exec(`
        INSERT OR IGNORE INTO photo_provider_fields
          (provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order)
        VALUES
          ('synologyphotos', 'synology_otp', 'providerOTP', 'text', '123456', 0, 0, NULL, 'synology_otp', 3)
      `);
      db.exec(`ALTER TABLE users ADD COLUMN synology_skip_ssl INTEGER NOT NULL DEFAULT 0`);
      db.exec(`ALTER TABLE users ADD COLUMN synology_did TEXT`);
      db.exec(`
        INSERT OR IGNORE INTO photo_provider_fields
          (provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order)
        VALUES
          ('synologyphotos', 'synology_skip_ssl', 'skipSSLVerification', 'checkbox', NULL, 0, 0, 'synology_skip_ssl', 'synology_skip_ssl', 4)
      `);
      db.exec(`
        UPDATE photo_provider_fields
        SET hint = 'providerUrlHintSynology'
        WHERE provider_id = 'synologyphotos' AND field_key = 'synology_url'
      `);
    },
    // Migration 84: Journey addon — trip tracking & travel journal
    () => {
      // Register addon (disabled by default — opt-in)
      db.prepare(
        `
        INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, config, sort_order)
        VALUES ('journey', 'Journey', 'Trip tracking & travel journal — check-ins, photos, daily stories', 'global', 'Compass', 0, '{}', 35)
      `,
      ).run();

      // Core journey table
      db.exec(`
        CREATE TABLE IF NOT EXISTS journeys (
          id TEXT PRIMARY KEY,
          trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          cover_image TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          started_at TEXT,
          ended_at TEXT,
          is_public INTEGER NOT NULL DEFAULT 0,
          public_token TEXT UNIQUE,
          settings TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
      `);

      // Check-ins — visited locations
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_checkins (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          lat REAL,
          lng REAL,
          address TEXT,
          country_code TEXT,
          notes TEXT,
          checked_in_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
      `);

      // Journal entries — daily stories
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_entries (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          checkin_id TEXT REFERENCES journey_checkins(id) ON DELETE SET NULL,
          entry_date TEXT NOT NULL,
          title TEXT,
          body TEXT,
          mood TEXT,
          weather TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
      `);

      // Photos — local uploads + provider references (Immich/Synology)
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_photos (
          id TEXT PRIMARY KEY,
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          checkin_id TEXT REFERENCES journey_checkins(id) ON DELETE SET NULL,
          entry_id TEXT REFERENCES journey_entries(id) ON DELETE SET NULL,
          storage_type TEXT NOT NULL DEFAULT 'local',
          asset_id TEXT,
          file_path TEXT,
          thumbnail_path TEXT,
          original_name TEXT,
          mime_type TEXT,
          size_bytes INTEGER,
          caption TEXT,
          taken_at TEXT,
          lat REAL,
          lng REAL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
      `);

      // GPS trail points (Dawarich integration)
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_location_trail (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          altitude REAL,
          accuracy REAL,
          recorded_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'dawarich'
        )
      `);

      // Indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_journeys_user ON journeys(user_id);
        CREATE INDEX IF NOT EXISTS idx_journeys_trip ON journeys(trip_id);
        CREATE INDEX IF NOT EXISTS idx_journeys_public_token ON journeys(public_token);
        CREATE INDEX IF NOT EXISTS idx_journey_checkins_journey ON journey_checkins(journey_id, checked_in_at);
        CREATE INDEX IF NOT EXISTS idx_journey_entries_journey_date ON journey_entries(journey_id, entry_date);
        CREATE INDEX IF NOT EXISTS idx_journey_photos_journey ON journey_photos(journey_id);
        CREATE INDEX IF NOT EXISTS idx_journey_photos_checkin ON journey_photos(checkin_id);
        CREATE INDEX IF NOT EXISTS idx_journey_photos_entry ON journey_photos(entry_id);
        CREATE INDEX IF NOT EXISTS idx_journey_trail_journey_time ON journey_location_trail(journey_id, recorded_at);
      `);
    },
    // Migration 85: Journal — richer entry fields for magazine-style design
    () => {
      // Highlight tags (JSON array), visibility control, hero photo, color accent
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN highlight_tags TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec("ALTER TABLE journey_entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN hero_photo_id TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN color_accent TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN place_name TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN place_id INTEGER REFERENCES places(id) ON DELETE SET NULL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN lat REAL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN lng REAL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }

      // Check-in: allow a single cover photo reference
      try {
        db.exec('ALTER TABLE journey_checkins ADD COLUMN photo_id TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }

      // Photos: add caption edit timestamp for gallery ordering
      try {
        db.exec('ALTER TABLE journey_photos ADD COLUMN width INTEGER');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_photos ADD COLUMN height INTEGER');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration 86: Journey multi-trip support + sharing/collaboration
    () => {
      // Junction table: journey can include multiple trips
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_trips (
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          PRIMARY KEY (journey_id, trip_id)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_journey_trips_journey ON journey_trips(journey_id)');

      // Sharing: invite users to a journey
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'viewer',
          invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          UNIQUE(journey_id, user_id)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_journey_members_user ON journey_members(user_id)');

      // author tracking on entries and checkins
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_checkins ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration 87: Journey rebuild — new schema with trip sync
    () => {
      // Migrate existing data from old tables into backup, then rebuild
      const hasOldJourneys = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journeys'").get();

      let oldJourneys: any[] = [];
      let oldEntries: any[] = [];
      let oldPhotos: any[] = [];

      if (hasOldJourneys) {
        // Save existing data before dropping
        try {
          oldJourneys = db.prepare('SELECT * FROM journeys').all();
        } catch (err) {
          console.warn('[migrations] Non-fatal migration step failed:', err);
        }
        try {
          oldEntries = db.prepare('SELECT * FROM journey_entries').all();
        } catch (err) {
          console.warn('[migrations] Non-fatal migration step failed:', err);
        }
        try {
          oldPhotos = db.prepare('SELECT * FROM journey_photos').all();
        } catch (err) {
          console.warn('[migrations] Non-fatal migration step failed:', err);
        }

        // Drop all old journey tables
        db.exec('DROP TABLE IF EXISTS journey_location_trail');
        db.exec('DROP TABLE IF EXISTS journey_photos');
        db.exec('DROP TABLE IF EXISTS journey_entries');
        db.exec('DROP TABLE IF EXISTS journey_checkins');
        db.exec('DROP TABLE IF EXISTS journey_members');
        db.exec('DROP TABLE IF EXISTS journey_trips');
        db.exec('DROP TABLE IF EXISTS journeys');
      }

      // New schema
      db.exec(`
        CREATE TABLE journeys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          subtitle TEXT,
          cover_gradient TEXT,
          status TEXT DEFAULT 'draft',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      db.exec(`
        CREATE TABLE journey_trips (
          journey_id INTEGER NOT NULL,
          trip_id INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (journey_id, trip_id),
          FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE,
          FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE journey_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id INTEGER NOT NULL,
          source_trip_id INTEGER,
          source_place_id INTEGER,
          author_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT,
          story TEXT,
          entry_date TEXT NOT NULL,
          entry_time TEXT,
          location_name TEXT,
          location_lat REAL,
          location_lng REAL,
          mood TEXT,
          weather TEXT,
          tags TEXT,
          visibility TEXT DEFAULT 'private',
          sort_order INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE,
          FOREIGN KEY (source_trip_id) REFERENCES trips(id) ON DELETE SET NULL,
          FOREIGN KEY (source_place_id) REFERENCES places(id) ON DELETE SET NULL,
          FOREIGN KEY (author_id) REFERENCES users(id)
        )
      `);

      db.exec(`
        CREATE TABLE journey_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          thumbnail_path TEXT,
          caption TEXT,
          sort_order INTEGER DEFAULT 0,
          width INTEGER,
          height INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (entry_id) REFERENCES journey_entries(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE journey_contributors (
          journey_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (journey_id, user_id),
          FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Indexes
      db.exec(`
        CREATE INDEX idx_journeys_user ON journeys(user_id);
        CREATE INDEX idx_journey_entries_journey ON journey_entries(journey_id, entry_date);
        CREATE INDEX idx_journey_entries_source ON journey_entries(source_place_id);
        CREATE INDEX idx_journey_photos_entry ON journey_photos(entry_id);
        CREATE INDEX idx_journey_trips_journey ON journey_trips(journey_id);
        CREATE INDEX idx_journey_contributors_user ON journey_contributors(user_id);
      `);

      // Re-import old data if it existed
      if (oldJourneys.length > 0) {
        const ts = Date.now();
        const journeyIdMap = new Map<string, number>(); // old TEXT id -> new INTEGER id

        for (const j of oldJourneys) {
          const res = db
            .prepare(
              `
            INSERT INTO journeys (user_id, title, subtitle, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
            )
            .run(
              j.user_id,
              j.title || 'Untitled Journey',
              j.description || null,
              j.status || 'draft',
              j.created_at ? new Date(j.created_at).getTime() : ts,
              j.updated_at ? new Date(j.updated_at).getTime() : ts,
            );
          journeyIdMap.set(j.id, Number(res.lastInsertRowid));

          // Add owner as contributor
          db.prepare(
            `
            INSERT OR IGNORE INTO journey_contributors (journey_id, user_id, role, added_at)
            VALUES (?, ?, 'owner', ?)
          `,
          ).run(Number(res.lastInsertRowid), j.user_id, ts);

          // Link trip if old journey had one
          if (j.trip_id) {
            try {
              db.prepare(
                `
                INSERT OR IGNORE INTO journey_trips (journey_id, trip_id, added_at)
                VALUES (?, ?, ?)
              `,
              ).run(Number(res.lastInsertRowid), j.trip_id, ts);
            } catch (err) {
              console.warn('[migrations] Non-fatal migration step failed:', err);
            }
          }
        }

        // Migrate entries
        const entryIdMap = new Map<string, number>();
        for (const e of oldEntries) {
          const newJourneyId = journeyIdMap.get(e.journey_id);
          if (!newJourneyId) continue;

          const res = db
            .prepare(
              `
            INSERT INTO journey_entries (journey_id, author_id, type, title, story, entry_date, entry_time, location_name, location_lat, location_lng, mood, weather, visibility, sort_order, created_at, updated_at)
            VALUES (?, ?, 'entry', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            )
            .run(
              newJourneyId,
              e.user_id || oldJourneys.find((j: any) => j.id === e.journey_id)?.user_id || 1,
              e.title || null,
              e.body || null,
              e.entry_date || new Date().toISOString().split('T')[0],
              e.place_name || null,
              e.lat || null,
              e.lng || null,
              e.mood || null,
              e.weather || null,
              e.visibility || 'private',
              e.sort_order || 0,
              e.created_at ? new Date(e.created_at).getTime() : ts,
              e.updated_at ? new Date(e.updated_at).getTime() : ts,
            );
          entryIdMap.set(e.id, Number(res.lastInsertRowid));
        }

        // Migrate photos
        for (const p of oldPhotos) {
          const newEntryId = p.entry_id ? entryIdMap.get(p.entry_id) : null;
          if (!newEntryId || !p.file_path) continue;

          db.prepare(
            `
            INSERT INTO journey_photos (entry_id, file_path, thumbnail_path, caption, sort_order, width, height, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          ).run(
            newEntryId,
            p.file_path,
            p.thumbnail_path || null,
            p.caption || null,
            p.sort_order || 0,
            p.width || null,
            p.height || null,
            p.created_at ? new Date(p.created_at).getTime() : ts,
          );
        }

        console.log(
          `[DB] Journey migration: imported ${journeyIdMap.size} journeys, ${entryIdMap.size} entries, photos migrated`,
        );
      }
    },
    // Migration 88: Journey photos — provider support (Immich/Synology)
    () => {
      try {
        db.exec("ALTER TABLE journey_photos ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'");
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_photos ADD COLUMN asset_id TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_photos ADD COLUMN owner_id INTEGER REFERENCES users(id)');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        db.exec('ALTER TABLE journey_photos ADD COLUMN shared INTEGER NOT NULL DEFAULT 1');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      // file_path was NOT NULL — recreate table to make it nullable
      const hasProvider = db.prepare("SELECT 1 FROM pragma_table_info('journey_photos') WHERE name = 'provider'").get();
      if (hasProvider) {
        // Already has the column, just ensure file_path is nullable by recreating
        try {
          db.exec(`
            CREATE TABLE journey_photos_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              entry_id INTEGER NOT NULL,
              provider TEXT NOT NULL DEFAULT 'local',
              asset_id TEXT,
              owner_id INTEGER REFERENCES users(id),
              file_path TEXT,
              thumbnail_path TEXT,
              caption TEXT,
              sort_order INTEGER DEFAULT 0,
              width INTEGER,
              height INTEGER,
              shared INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (entry_id) REFERENCES journey_entries(id) ON DELETE CASCADE
            );
            INSERT INTO journey_photos_new SELECT id, entry_id, provider, asset_id, owner_id, file_path, thumbnail_path, caption, sort_order, width, height, shared, created_at FROM journey_photos;
            DROP TABLE journey_photos;
            ALTER TABLE journey_photos_new RENAME TO journey_photos;
            CREATE INDEX idx_journey_photos_entry ON journey_photos(entry_id);
          `);
        } catch (err) {
          console.warn('[migrations] Non-fatal migration step failed:', err);
        }
      }
    },
    // Migration 89: Journey cover image
    () => {
      try {
        db.exec('ALTER TABLE journeys ADD COLUMN cover_image TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration 90: Pros/Cons for journey entries
    () => {
      try {
        db.exec('ALTER TABLE journey_entries ADD COLUMN pros_cons TEXT');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration 91: Journey share tokens
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_share_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id INTEGER NOT NULL,
          token TEXT NOT NULL UNIQUE,
          created_by INTEGER NOT NULL,
          share_timeline INTEGER DEFAULT 1,
          share_gallery INTEGER DEFAULT 1,
          share_map INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_share_journey ON journey_share_tokens(journey_id)');
    },
    // Migration: Vacay week_start setting (0=Sunday, 1=Monday default)
    () => {
      try {
        db.exec('ALTER TABLE vacay_plans ADD COLUMN week_start INTEGER NOT NULL DEFAULT 1');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration: Unified Photo Provider Abstraction Layer (#584)
    // Central trek_photos registry; trip_photos + journey_photos reference via photo_id
    () => {
      // 1. Create the central photo registry
      db.exec(`
        CREATE TABLE IF NOT EXISTS trek_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          asset_id TEXT,
          owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          file_path TEXT,
          thumbnail_path TEXT,
          width INTEGER,
          height INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_trek_photos_provider_asset ON trek_photos(provider, asset_id, owner_id) WHERE asset_id IS NOT NULL',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_trek_photos_owner ON trek_photos(owner_id)');

      // 2. Migrate trip_photos → trek_photos + photo_id FK
      const tripPhotosExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_photos'")
        .get();
      if (tripPhotosExists) {
        // Detect schema variant: old (immich_asset_id) vs new (asset_id + provider)
        const tpCols = db.prepare("PRAGMA table_info('trip_photos')").all() as Array<{ name: string }>;
        const tpColNames = new Set(tpCols.map((c) => c.name));
        const hasProvider = tpColNames.has('provider');
        const assetCol = tpColNames.has('asset_id')
          ? 'asset_id'
          : tpColNames.has('immich_asset_id')
            ? 'immich_asset_id'
            : null;
        const hasAlbumLink = tpColNames.has('album_link_id');

        if (assetCol) {
          const providerExpr = hasProvider ? 'provider' : "'immich'";
          // Qualified alias needed in JOIN context where both trip_photos and trek_photos have provider
          const providerJoinExpr = hasProvider ? 'tp.provider' : "'immich'";
          const sharedExpr = tpColNames.has('shared') ? 'shared' : '1';
          const addedAtExpr = tpColNames.has('added_at')
            ? 'COALESCE(added_at, CURRENT_TIMESTAMP)'
            : 'CURRENT_TIMESTAMP';
          const albumLinkExpr = hasAlbumLink ? 'album_link_id' : 'NULL';

          // Insert existing trip photo references into trek_photos
          db.exec(`
            INSERT OR IGNORE INTO trek_photos (provider, asset_id, owner_id, created_at)
            SELECT DISTINCT ${providerExpr}, ${assetCol}, user_id, ${addedAtExpr}
            FROM trip_photos
            WHERE ${assetCol} IS NOT NULL AND TRIM(${assetCol}) != ''
          `);

          // Recreate trip_photos with photo_id FK
          db.exec(`
            CREATE TABLE trip_photos_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              photo_id INTEGER NOT NULL REFERENCES trek_photos(id) ON DELETE CASCADE,
              shared INTEGER NOT NULL DEFAULT 1,
              album_link_id INTEGER REFERENCES trip_album_links(id) ON DELETE SET NULL,
              added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(trip_id, user_id, photo_id)
            )
          `);
          db.exec(`
            INSERT OR IGNORE INTO trip_photos_new (trip_id, user_id, photo_id, shared, album_link_id, added_at)
            SELECT tp.trip_id, tp.user_id, tkp.id, ${sharedExpr}, ${albumLinkExpr}, ${addedAtExpr}
            FROM trip_photos tp
            JOIN trek_photos tkp ON tkp.provider = ${providerJoinExpr} AND tkp.asset_id = tp.${assetCol} AND tkp.owner_id = tp.user_id
          `);
        } else {
          // No asset column at all — just recreate empty
          db.exec(`
            CREATE TABLE trip_photos_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              photo_id INTEGER NOT NULL REFERENCES trek_photos(id) ON DELETE CASCADE,
              shared INTEGER NOT NULL DEFAULT 1,
              album_link_id INTEGER REFERENCES trip_album_links(id) ON DELETE SET NULL,
              added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(trip_id, user_id, photo_id)
            )
          `);
        }
        db.exec('DROP TABLE trip_photos');
        db.exec('ALTER TABLE trip_photos_new RENAME TO trip_photos');
        db.exec('CREATE INDEX IF NOT EXISTS idx_trip_photos_trip ON trip_photos(trip_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_trip_photos_photo ON trip_photos(photo_id)');
      }

      // 3. Migrate journey_photos → trek_photos + photo_id FK
      const journeyPhotosExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos'")
        .get();
      if (journeyPhotosExists) {
        // Insert provider-based journey photos into trek_photos
        db.exec(`
          INSERT OR IGNORE INTO trek_photos (provider, asset_id, owner_id, width, height, created_at)
          SELECT DISTINCT provider, asset_id, owner_id, width, height, created_at
          FROM journey_photos
          WHERE provider != 'local' AND asset_id IS NOT NULL AND TRIM(asset_id) != ''
        `);
        // Insert local journey photos into trek_photos (each is unique)
        db.exec(`
          INSERT INTO trek_photos (provider, file_path, thumbnail_path, width, height, created_at)
          SELECT 'local', file_path, thumbnail_path, width, height, created_at
          FROM journey_photos
          WHERE provider = 'local' AND file_path IS NOT NULL
        `);

        // Recreate journey_photos with photo_id FK
        db.exec(`
          CREATE TABLE journey_photos_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL,
            photo_id INTEGER NOT NULL REFERENCES trek_photos(id) ON DELETE CASCADE,
            caption TEXT,
            sort_order INTEGER DEFAULT 0,
            shared INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES journey_entries(id) ON DELETE CASCADE
          )
        `);
        // Migrate provider photos
        db.exec(`
          INSERT INTO journey_photos_new (entry_id, photo_id, caption, sort_order, shared, created_at)
          SELECT jp.entry_id, tkp.id, jp.caption, jp.sort_order, jp.shared, jp.created_at
          FROM journey_photos jp
          JOIN trek_photos tkp ON tkp.provider = jp.provider AND tkp.asset_id = jp.asset_id AND tkp.owner_id = jp.owner_id
          WHERE jp.provider != 'local' AND jp.asset_id IS NOT NULL
        `);
        // Migrate local photos (match by file_path)
        db.exec(`
          INSERT INTO journey_photos_new (entry_id, photo_id, caption, sort_order, shared, created_at)
          SELECT jp.entry_id, tkp.id, jp.caption, jp.sort_order, jp.shared, jp.created_at
          FROM journey_photos jp
          JOIN trek_photos tkp ON tkp.provider = 'local' AND tkp.file_path = jp.file_path
          WHERE jp.provider = 'local' AND jp.file_path IS NOT NULL
        `);
        db.exec('DROP TABLE journey_photos');
        db.exec('ALTER TABLE journey_photos_new RENAME TO journey_photos');
        db.exec('CREATE INDEX IF NOT EXISTS idx_journey_photos_entry ON journey_photos(entry_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_journey_photos_photo ON journey_photos(photo_id)');
      }
    },
    // Migration 99: hide_skeletons per-user setting on journey_contributors
    () => {
      try {
        db.exec('ALTER TABLE journey_contributors ADD COLUMN hide_skeletons INTEGER NOT NULL DEFAULT 0');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration 100: Idempotency keys for offline mutation replay
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key         TEXT NOT NULL,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          method      TEXT NOT NULL,
          path        TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (key, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
      `);
    },

    // Migration 101: Enable naver_list_import by default
    () => {
      db.prepare("UPDATE addons SET enabled = 1 WHERE id = 'naver_list_import'").run();
    },

    // Migration 102: Add check_in_end column for check-in time ranges
    () => {
      try {
        db.exec('ALTER TABLE day_accommodations ADD COLUMN check_in_end TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration 103: System notices — user tracking columns + dismissals table
    () => {
      db.exec(`ALTER TABLE users ADD COLUMN first_seen_version TEXT NOT NULL DEFAULT '0.0.0'`);
      db.exec(`ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_notice_dismissals (
          user_id      INTEGER NOT NULL,
          notice_id    TEXT    NOT NULL,
          dismissed_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, notice_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    },
    // Migration 104: Passphrase support for Synology shared-album links (#689)
    () => {
      try {
        db.exec('ALTER TABLE trip_album_links ADD COLUMN passphrase TEXT DEFAULT NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE trek_photos ADD COLUMN passphrase TEXT DEFAULT NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration 105: Persistent Google place photo disk cache registry
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS google_place_photo_meta (
          place_id   TEXT    PRIMARY KEY,
          attribution TEXT,
          fetched_at INTEGER NOT NULL,
          error_at   INTEGER
        )
      `);
    },
    // Migration 106: Persistent Place Details row cache
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS place_details_cache (
          place_id   TEXT    NOT NULL,
          lang       TEXT    NOT NULL DEFAULT '',
          expanded   INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT  NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (place_id, lang, expanded)
        )
      `);
    },
    // Migration 107: Backfill expired signed Google photo URLs to stable proxy URLs
    {
      raw: () => {
        db.exec(`
        UPDATE places
        SET image_url = '/api/maps/place-photo/' || google_place_id || '/bytes',
            updated_at = CURRENT_TIMESTAMP
        WHERE google_place_id IS NOT NULL
          AND image_url IS NOT NULL
          AND image_url != ''
          AND (
            (image_url LIKE '%googleusercontent.com%' AND image_url LIKE '%/places/%/photos/%')
            OR (image_url LIKE '%places.googleapis.com%' AND image_url LIKE '%/places/%/photos/%')
          )
      `);
      },
    },
    // Migration 108: Disk cache metadata for remote-provider photo thumbnails (Immich / Synology)
    () =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS trek_photo_cache_meta (
        cache_key  TEXT    PRIMARY KEY,
        content_type TEXT  NOT NULL DEFAULT 'image/jpeg',
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trek_photo_cache_meta_fetched_at ON trek_photo_cache_meta (fetched_at);
    `),
    // Migration 109: Reservation endpoints (from/to points for flights, trains, ferries, car rentals) — #384 + #587
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reservation_endpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          code TEXT,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          timezone TEXT,
          local_time TEXT,
          local_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_reservation_endpoints_reservation_id ON reservation_endpoints(reservation_id)',
      );
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration 110 — link transport reservations to days via day_id / end_day_id
    () => {
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN end_day_id INTEGER REFERENCES days(id) ON DELETE SET NULL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }

      db.exec(`
        UPDATE reservations
        SET day_id = (
          SELECT d.id FROM days d
          WHERE d.trip_id = reservations.trip_id
            AND d.date = substr(reservations.reservation_time, 1, 10)
          LIMIT 1
        )
        WHERE type IN ('flight','train','car','cruise','bus')
          AND reservation_time IS NOT NULL
          AND day_id IS NULL
      `);

      db.exec(`
        UPDATE reservations
        SET end_day_id = (
          SELECT d.id FROM days d
          WHERE d.trip_id = reservations.trip_id
            AND d.date = substr(reservations.reservation_end_time, 1, 10)
          LIMIT 1
        )
        WHERE type IN ('flight','train','car','cruise','bus')
          AND reservation_end_time IS NOT NULL
          AND end_day_id IS NULL
          AND substr(reservations.reservation_end_time, 1, 10) != substr(reservations.reservation_time, 1, 10)
      `);
    },
    // Migration 111: opt-in Immich auto-upload — users column only (#730)
    // Default is off — uploading to Immich must be an explicit choice, not a
    // side effect of having a writable API key.
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN immich_auto_upload INTEGER NOT NULL DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration 112: expose immich auto-upload toggle in the Settings UI (#730)
    // Runs after Immich provider seeding so the FK to photo_providers holds.
    () => {
      try {
        const hasTable = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('photo_providers', 'photo_provider_fields')",
          )
          .all() as Array<{ name: string }>;
        const hasProviders = hasTable.some((t) => t.name === 'photo_providers');
        const hasFields = hasTable.some((t) => t.name === 'photo_provider_fields');
        if (hasProviders && hasFields) {
          const immichRow = db.prepare("SELECT 1 FROM photo_providers WHERE id = 'immich' LIMIT 1").get();
          if (immichRow) {
            db.prepare(
              `
              INSERT OR IGNORE INTO photo_provider_fields
                (provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order)
              VALUES
                ('immich', 'immich_auto_upload', 'immichAutoUpload', 'checkbox', NULL, 0, 0, 'auto_upload', 'auto_upload', 5)
            `,
            ).run();
          }
        }
      } catch (err: any) {
        if (!err.message?.includes('no such table') && !err.message?.includes('FOREIGN KEY')) throw err;
      }
    },
    // Migration: RFC 8707 resource indicators — audience-bind OAuth tokens to /mcp
    () => {
      try {
        db.exec('ALTER TABLE oauth_tokens ADD COLUMN audience TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration: password reset — add password_version for session
    // invalidation, and a token table keyed by SHA-256 hash (raw tokens
    // never hit the DB).
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          consumed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_ip TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_prt_hash ON password_reset_tokens(token_hash);
      `);
    },
    // Migration: todo due-date reminders — track when we last sent a
    // reminder for each todo so we don't spam the same notification
    // every day the scheduler runs.
    () => {
      try {
        db.exec('ALTER TABLE todo_items ADD COLUMN reminded_at DATETIME');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Migration: security audit batch 1 — columns + indexes required
    // by several fixes bundled into one PR.
    // - share_tokens.expires_at: public share links now get a 90-day
    //   TTL by default; existing rows stay NULL (= no expiry) to avoid
    //   silently breaking already-published links.
    // - Missing indexes on high-cardinality query paths (see PERF-H1
    //   in the audit): every listTrips() used to full-scan trips on
    //   user_id, and notifications/photos/reservations had similar
    //   gaps.
    () => {
      try {
        db.exec('ALTER TABLE share_tokens ADD COLUMN expires_at TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);
        CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_photos_day_id ON photos(day_id);
        CREATE INDEX IF NOT EXISTS idx_photos_place_id ON photos(place_id);
        CREATE INDEX IF NOT EXISTS idx_reservations_day_id ON reservations(day_id);
        CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON share_tokens(token);
      `);
      try {
        // day_accommodations may have either start_day_id/end_day_id or a
        // single day_id depending on how far the schema has evolved;
        // build whichever index makes sense for the live columns.
        const cols = db.prepare("PRAGMA table_info('day_accommodations')").all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        if (names.has('start_day_id'))
          db.exec('CREATE INDEX IF NOT EXISTS idx_day_accommodations_start_day_id ON day_accommodations(start_day_id)');
        if (names.has('end_day_id'))
          db.exec('CREATE INDEX IF NOT EXISTS idx_day_accommodations_end_day_id ON day_accommodations(end_day_id)');
      } catch (err) {
        // Non-fatal: day_accommodations may not exist on very old installs.
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
      try {
        // notifications schema has varied; probe before indexing.
        const cols = db.prepare("PRAGMA table_info('notifications')").all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        if (names.has('target') && names.has('scope')) {
          db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_target_scope ON notifications(target, scope)');
        }
      } catch (err) {
        // Non-fatal: notifications table may not exist on very old installs.
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Migration: widen idempotency_keys primary key to (key, user_id,
    // method, path). The middleware lookup was widened in the same audit
    // batch so a reused X-Idempotency-Key against a different endpoint
    // does not replay the cached body of an unrelated request. The old
    // PK was only (key, user_id), so the `INSERT OR IGNORE` on the
    // second endpoint silently skipped — the cache never stored request
    // B's response and replays re-executed the handler. Rebuild the
    // table with the widened PK, preserving existing rows (the old PK
    // guarantees no conflicts in the new, strictly looser unique key).
    () => {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'")
        .get();
      if (!hasTable) return;
      db.exec(`
        CREATE TABLE idempotency_keys_new (
          key         TEXT NOT NULL,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          method      TEXT NOT NULL,
          path        TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (key, user_id, method, path)
        );
        INSERT INTO idempotency_keys_new (key, user_id, method, path, status_code, response_body, created_at)
          SELECT key, user_id, method, path, status_code, response_body, created_at FROM idempotency_keys;
        DROP TABLE idempotency_keys;
        ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
      `);
    },
    // SEC-H6: revoke all OAuth tokens issued before audience binding was
    // enforced. mcp/index.ts now unconditionally checks audience; tokens
    // with audience=null would be permanently rejected by the check, so
    // removing them here avoids leaving dead rows and makes the intent clear.
    () => {
      const hasCol = db.prepare("SELECT name FROM pragma_table_info('oauth_tokens') WHERE name = 'audience'").get();
      if (!hasCol) return;
      db.prepare('DELETE FROM oauth_tokens WHERE audience IS NULL').run();
    },
    // Remove NOT NULL constraint on day_accommodations.place_id so hotel
    // reservations created from the Bookings tab without a linked place can
    // still persist their date range. Change ON DELETE CASCADE → SET NULL so
    // deleting a place orphans the accommodation row instead of cascading.
    () => {
      db.exec(`
        CREATE TABLE day_accommodations_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          place_id     INTEGER REFERENCES places(id) ON DELETE SET NULL,
          start_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
          end_day_id   INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
          check_in     TEXT,
          check_in_end TEXT,
          check_out    TEXT,
          confirmation TEXT,
          notes        TEXT,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO day_accommodations_new
          SELECT id, trip_id, place_id, start_day_id, end_day_id,
                 check_in, check_in_end, check_out, confirmation, notes, created_at
          FROM day_accommodations;
        DROP TABLE day_accommodations;
        ALTER TABLE day_accommodations_new RENAME TO day_accommodations;
        CREATE INDEX IF NOT EXISTS idx_day_accommodations_trip_id ON day_accommodations(trip_id);
        CREATE INDEX IF NOT EXISTS idx_day_accommodations_start_day_id ON day_accommodations(start_day_id);
        CREATE INDEX IF NOT EXISTS idx_day_accommodations_end_day_id ON day_accommodations(end_day_id);
      `);
    },
    // Migration: null out proxy image_url entries that have no backing disk cache.
    // Migrations 107 and the migration below wrote /api/maps/place-photo/<id>/bytes
    // into places.image_url without actually fetching/caching the photo bytes. The
    // photoService short-circuits on that prefix and hits /bytes directly → 404.
    // Rows with a confirmed disk cache entry in google_place_photo_meta are left alone;
    // only stale proxy URLs (never actually fetched) are cleared so the normal
    // fetch-and-cache flow can repopulate them.
    () => {
      db.exec(`
        UPDATE places
        SET image_url = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE image_url LIKE '/api/maps/place-photo/%/bytes'
          AND google_place_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM google_place_photo_meta
            WHERE place_id = places.google_place_id
              AND error_at IS NULL
          )
      `);
    },
    // Migration: clear legacy Google photo URLs missed by Migration 107.
    // Migration 107 matched /places/%/photos/% only; lh3.googleusercontent.com URLs use
    // /place-photos/ or /places/<opaque-id> paths and were skipped. NULL those stale URLs
    // so the normal fetch-and-cache flow repopulates image_url with a real proxy URL.
    () => {
      db.exec(`
        UPDATE places
        SET image_url   = NULL,
            updated_at  = CURRENT_TIMESTAMP
        WHERE image_url IS NOT NULL
          AND image_url != ''
          AND image_url NOT LIKE '/api/maps/place-photo/%'
          AND (
                image_url LIKE 'http://%googleusercontent.com/%'
             OR image_url LIKE 'https://%googleusercontent.com/%'
             OR image_url LIKE 'http://%places.googleapis.com/%'
             OR image_url LIKE 'https://%places.googleapis.com/%'
          )
      `);
    },
    // Migration 121: Journey gallery refactor — decouple photo ownership from
    // entries. journey_photos becomes a per-journey gallery (one row per unique
    // photo per journey). A new junction table journey_entry_photos links
    // gallery photos to the entries that reference them, allowing the same
    // photo to appear in multiple entries without duplication. Synthetic
    // wrapper entries ('Gallery', '[Trip Photos]') created by the old model
    // are removed — the gallery table replaces them.
    () => {
      const hasOld = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos'").get();
      const hasBackup = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos_old'")
        .get();
      if (hasOld && !hasBackup) {
        db.exec('ALTER TABLE journey_photos RENAME TO journey_photos_old');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_photos (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id  INTEGER NOT NULL REFERENCES journeys(id)    ON DELETE CASCADE,
          photo_id    INTEGER NOT NULL REFERENCES trek_photos(id) ON DELETE CASCADE,
          caption     TEXT,
          shared      INTEGER DEFAULT 0,
          sort_order  INTEGER DEFAULT 0,
          provider    TEXT,
          asset_id    TEXT,
          owner_id    INTEGER,
          created_at  INTEGER NOT NULL,
          UNIQUE(journey_id, photo_id)
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_entry_photos (
          entry_id          INTEGER NOT NULL REFERENCES journey_entries(id) ON DELETE CASCADE,
          journey_photo_id  INTEGER NOT NULL REFERENCES journey_photos(id)  ON DELETE CASCADE,
          sort_order        INTEGER DEFAULT 0,
          created_at        INTEGER NOT NULL,
          PRIMARY KEY(entry_id, journey_photo_id)
        )
      `);

      if (hasOld || hasBackup) {
        // Backfill gallery: deduplicate by (journey_id, photo_id), keeping
        // the earliest row (MIN(id) = earliest created_at on AUTOINCREMENT).
        db.exec(`
          INSERT OR IGNORE INTO journey_photos
            (journey_id, photo_id, caption, shared, sort_order, created_at)
          SELECT
            je.journey_id,
            jpo.photo_id,
            jpo.caption,
            jpo.shared,
            jpo.sort_order,
            jpo.created_at
          FROM journey_photos_old jpo
          JOIN journey_entries je ON je.id = jpo.entry_id
          WHERE jpo.id IN (
            SELECT MIN(jpo2.id)
            FROM journey_photos_old jpo2
            JOIN journey_entries je2 ON je2.id = jpo2.entry_id
            GROUP BY je2.journey_id, jpo2.photo_id
          )
        `);

        // Backfill junction: one row per (entry_id, photo_id), resolved to
        // the new gallery ids.
        db.exec(`
          INSERT OR IGNORE INTO journey_entry_photos
            (entry_id, journey_photo_id, sort_order, created_at)
          SELECT
            jpo.entry_id,
            jp.id,
            jpo.sort_order,
            jpo.created_at
          FROM journey_photos_old jpo
          JOIN journey_entries je ON je.id = jpo.entry_id
          JOIN journey_photos   jp
            ON jp.journey_id = je.journey_id
           AND jp.photo_id   = jpo.photo_id
        `);

        db.exec('DROP TABLE journey_photos_old');
      }

      // Remove synthetic wrapper entries replaced by the gallery model.
      // ON DELETE CASCADE on journey_entry_photos cleans up junction rows.
      db.prepare("DELETE FROM journey_entries WHERE title IN ('Gallery', '[Trip Photos]')").run();

      db.exec('CREATE INDEX IF NOT EXISTS idx_journey_photos_journey       ON journey_photos(journey_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_journey_entry_photos_entry   ON journey_entry_photos(entry_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_journey_entry_photos_photo   ON journey_entry_photos(journey_photo_id)');
    },
    // Migration 122: Correct stale day_id / end_day_id on non-transport
    // reservations. Migration 110 only backfilled transport types; tours,
    // restaurants, events and "other" bookings kept a stale day_id from
    // older code paths that often defaulted to the first day of the trip.
    // Starting with v3.0.0 the planner renders reservations by day_id
    // instead of reservation_time, so those stale rows show up on the
    // wrong day. This migration nulls out day_id / end_day_id values that
    // don't match the reservation's time and then backfills them from
    // reservation_time / reservation_end_time.
    () => {
      db.exec(`
        UPDATE reservations
        SET day_id = NULL
        WHERE reservation_time IS NOT NULL
          AND day_id IS NOT NULL
          AND type != 'hotel'
          AND NOT EXISTS (
            SELECT 1 FROM days d
            WHERE d.id = reservations.day_id
              AND d.date = substr(reservations.reservation_time, 1, 10)
          )
      `);

      db.exec(`
        UPDATE reservations
        SET end_day_id = NULL
        WHERE reservation_end_time IS NOT NULL
          AND end_day_id IS NOT NULL
          AND type != 'hotel'
          AND NOT EXISTS (
            SELECT 1 FROM days d
            WHERE d.id = reservations.end_day_id
              AND d.date = substr(reservations.reservation_end_time, 1, 10)
          )
      `);

      db.exec(`
        UPDATE reservations
        SET day_id = (
          SELECT d.id FROM days d
          WHERE d.trip_id = reservations.trip_id
            AND d.date = substr(reservations.reservation_time, 1, 10)
          LIMIT 1
        )
        WHERE type != 'hotel'
          AND reservation_time IS NOT NULL
          AND day_id IS NULL
      `);

      db.exec(`
        UPDATE reservations
        SET end_day_id = (
          SELECT d.id FROM days d
          WHERE d.trip_id = reservations.trip_id
            AND d.date = substr(reservations.reservation_end_time, 1, 10)
          LIMIT 1
        )
        WHERE type != 'hotel'
          AND reservation_end_time IS NOT NULL
          AND end_day_id IS NULL
          AND substr(reservations.reservation_end_time, 1, 10)
              != substr(reservations.reservation_time, 1, 10)
      `);
    },
    // #846: make sort_order authoritative within a day. Previous ORDER BY put
    // entry_time before sort_order, silently ignoring reorder clicks when two
    // same-date entries had different times. Backfill renumbers using the old
    // effective key (entry_time ASC, id ASC) so existing journeys retain their
    // current visual order.
    () => {
      db.exec(`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY journey_id, entry_date
                   ORDER BY entry_time ASC, id ASC
                 ) - 1 AS rn
          FROM journey_entries
        )
        UPDATE journey_entries
        SET sort_order = (SELECT rn FROM ranked WHERE ranked.id = journey_entries.id)
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_journey_entries_order ' +
          'ON journey_entries(journey_id, entry_date, sort_order)',
      );
    },
    // Swap inverted start_day_id/end_day_id pairs in day_accommodations caused
    // by the old Math.min/Math.max picker bug (pre-8e05ba7) which used raw IDs
    // instead of positional order on trips with non-monotonic day ID layouts.
    () => {
      db.exec(`
        UPDATE day_accommodations
        SET start_day_id = end_day_id, end_day_id = start_day_id
        WHERE (SELECT day_number FROM days WHERE id = start_day_id)
            > (SELECT day_number FROM days WHERE id = end_day_id)
      `);
    },
    // prepare migration to nest + typeorm
    () => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS migrations (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL);`,
      );
      db.exec(`INSERT INTO migrations (timestamp, name) VALUES (1777810195344, 'InitialSchema1777810195344');`);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('app_version', ?)").run(
        readEnv().app.appVersion || '3.0.14',
      );
    },
    // trim leading/trailing whitespace from stored usernames and emails
    () => {
      const hadCollision = trimUserWhitespace(db);
      if (hadCollision) {
        db.prepare(
          "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('whitespace_migration_collision', 'true')",
        ).run();
      }
    },
    () => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS schema_version_new (id INTEGER PRIMARY KEY AUTOINCREMENT,version INTEGER NOT NULL)`,
      );
      db.exec(`INSERT INTO schema_version_new (version) SELECT version FROM schema_version`);
      db.exec(`DROP TABLE schema_version`);
      db.exec(`ALTER TABLE schema_version_new RENAME TO schema_version`);
      db.prepare("UPDATE app_settings SET value = ? WHERE key = 'app_version'").run(
        readEnv().app.appVersion || '3.0.15',
      );
    },
    // Migration: OAuth 2.0 client_credentials grant — allow user-owned confidential
    // clients to skip the browser consent flow entirely and obtain tokens directly
    // via client_id + client_secret. Flag is immutable after creation so existing
    // authorization-code clients are not silently upgraded.
    () => {
      try {
        db.exec('ALTER TABLE oauth_clients ADD COLUMN allows_client_credentials INTEGER NOT NULL DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Drop stale atlas cache rows for territories that used to resolve to their
    // surrounding country (Hong Kong/Macau as China, San Marino/Vatican as Italy,
    // etc.) before their own bounding boxes existed. The next atlas stats request
    // re-resolves any place inside these boxes with the corrected country code.
    () => {
      const enclaveBoxes: [number, number, number, number][] = [
        [113.83, 22.15, 114.43, 22.56], // HK
        [113.53, 22.1, 113.6, 22.21], // MO
        [12.4, 43.89, 12.52, 43.99], // SM
        [12.44, 41.9, 12.46, 41.91], // VA
        [7.4, 43.72, 7.44, 43.75], // MC
        [9.47, 47.05, 9.64, 47.27], // LI
        [-5.36, 36.11, -5.33, 36.16], // GI
        [-67.3, 17.88, -65.22, 18.53], // PR
      ];
      try {
        const del = db.prepare(
          `DELETE FROM place_regions WHERE place_id IN (
             SELECT id FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
           )`,
        );
        for (const [minLng, minLat, maxLng, maxLat] of enclaveBoxes) {
          del.run(minLat, maxLat, minLng, maxLng);
        }
      } catch (err: any) {
        if (!err.message?.includes('no such table')) throw err;
      }
    },
    // Costs rework (budget → "Costs", Tricount/Splitwise style). Adds, additively
    // and without touching existing rows:
    //  - per-expense currency + exchange_rate, so an expense can be entered in a
    //    foreign currency and converted to the trip base currency (NULL currency =
    //    base currency; rate 1.0). Closes the multi-currency request (#551).
    //  - budget_item_payers: several people can each have paid part of one expense
    //    (amounts in the expense currency), replacing the single paid_by_user_id.
    //  - budget_settlements: persisted "X paid Y" transfers so the settle-up
    //    history (with undo) is shared across all trip members.
    // The equal-split participants stay in budget_item_members. The single legacy
    // payer is backfilled into budget_item_payers as one payer covering the total.
    () => {
      try {
        db.exec('ALTER TABLE budget_items ADD COLUMN currency TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE budget_items ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_item_payers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          budget_item_id INTEGER NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount REAL NOT NULL DEFAULT 0,
          UNIQUE(budget_item_id, user_id)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_budget_item_payers_item ON budget_item_payers(budget_item_id)');

      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount REAL NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by_user_id INTEGER REFERENCES users(id)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_budget_settlements_trip ON budget_settlements(trip_id)');

      // Backfill the legacy single payer: that person paid the full total of the
      // expense, in the (base) currency the existing amount was already stored in.
      try {
        db.exec(`
          INSERT OR IGNORE INTO budget_item_payers (budget_item_id, user_id, amount)
          SELECT id, paid_by_user_id, total_price
          FROM budget_items
          WHERE paid_by_user_id IS NOT NULL
        `);
      } catch (err: any) {
        if (!err.message?.includes('no such column')) throw err;
      }
    },
    // Rename the "Budget Planner" addon to "Costs" in the admin add-on list. This
    // is a display rename only — the addon id, tables, permissions and MCP tools
    // all stay 'budget'. Scoped to the default name so a customised one is kept.
    () => {
      db.prepare(
        "UPDATE addons SET name = 'Costs', description = 'Track and split trip expenses' WHERE id = 'budget' AND name = 'Budget Planner'",
      ).run();
    },
    // WebAuthn / passkey support: per-user credentials + single-use login
    // challenges. Additive (CREATE TABLE IF NOT EXISTS) so existing installs are
    // untouched; both tables also live in schema.ts for fresh installs.
    () =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_type TEXT,
        backed_up INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        aaguid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
    `),
    // Atlas dropped Natural Earth for geoBoundaries. Manually-marked sub-national
    // regions (`visited_regions`) stored the OLD Natural Earth ISO-3166-2 codes; some no
    // longer match any polygon in the new bundle and would stop highlighting. Reconcile
    // every row against the ACTUAL shipped admin-1 bundle so this covers *all* countries,
    // not just one hand-listed reform:
    //   1. code still present in the new bundle      → leave it (already correct);
    //   2. else a region in the same country shares  → adopt that region's code+name
    //      the stored region_name (case-insensitive)   (handles code re-spellings, e.g.
    //                                                    ES-AN → ES_AND, names unchanged);
    //   3. else a curated merge crosswalk maps it    → adopt the merged region (handles
    //      (region absorbed into a *renamed* one)       reforms where the name changed,
    //                                                    which step 2 cannot catch);
    //   4. else → leave as-is (cannot be resolved; the client's name fallback may still
    //      highlight it, and nothing is destroyed).
    // Other Atlas tables need NO remap: `visited_countries` / `bucket_list` hold only
    // ISO-3166-1 alpha-2 codes (invariant across the swap), `bucket_list.name` is free
    // text we must not auto-rewrite, and `place_regions` is a re-derivable Nominatim cache.
    () => {
      type Row = { id: number; region_code: string; region_name: string; country_code: string };
      const rows = db.prepare('SELECT id, region_code, region_name, country_code FROM visited_regions').all() as Row[];
      if (rows.length === 0) return; // nothing marked → skip the bundle read entirely

      // Index the shipped admin-1 bundle: valid codes, name→code per country, code→name.
      // __dirname resolves ../../assets under both dist (dist/db) and tests (src/db).
      let features: { properties?: { iso_a2?: string; iso_3166_2?: string; name?: string } }[];
      try {
        const file = path.join(__dirname, '..', '..', 'assets', 'atlas', 'admin1.geojson.gz');
        features = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')).features || [];
      } catch {
        features = []; // bundle missing → degrade to the curated crosswalk below
      }
      const validCodes = new Set<string>();
      const nameToCode = new Map<string, string>(); // `${A2}|${nameLower}` → code
      const codeToName = new Map<string, string>();
      for (const f of features) {
        const a2 = (f.properties?.iso_a2 || '').toUpperCase();
        const code = f.properties?.iso_3166_2 || '';
        const name = f.properties?.name || '';
        if (!code) continue;
        validCodes.add(code);
        if (!codeToName.has(code)) codeToName.set(code, name);
        if (a2 && name) nameToCode.set(`${a2}|${name.toLowerCase()}`, code);
      }

      // Curated crosswalk for regions absorbed into a *renamed* successor (step 2 can't
      // match these because the name changed). Norway's 2018/2020 reforms; extend as the
      // pinned geoBoundaries dataset gains further reforms.
      const MERGE_CROSSWALK: Record<string, string> = {
        'NO-04': 'NO-34',
        'NO-05': 'NO-34', // Hedmark, Oppland → Innlandet
        'NO-12': 'NO-46',
        'NO-14': 'NO-46', // Hordaland, Sogn og Fjordane → Vestland
        'NO-09': 'NO-42',
        'NO-10': 'NO-42', // Aust-/Vest-Agder → Agder
        'NO-01': 'NO-30',
        'NO-02': 'NO-30',
        'NO-06': 'NO-30', // Østfold/Akershus/Buskerud → Viken
        'NO-07': 'NO-38',
        'NO-08': 'NO-38', // Vestfold, Telemark → Vestfold og Telemark
        'NO-19': 'NO-54',
        'NO-20': 'NO-54', // Troms, Finnmark → Troms og Finnmark
        'NO-16': 'NO-50',
        'NO-17': 'NO-50', // Sør-/Nord-Trøndelag → Trøndelag
      };

      const resolve = (row: Row): string | null => {
        if (validCodes.has(row.region_code)) return null; // already valid
        const a2 = (row.country_code || '').toUpperCase();
        const byName = nameToCode.get(`${a2}|${(row.region_name || '').toLowerCase()}`);
        if (byName) return byName;
        const merged = MERGE_CROSSWALK[row.region_code];
        // Only trust the crosswalk target if it actually exists in the bundle (or the
        // bundle was unreadable, in which case we apply the curated map blindly).
        if (merged && (validCodes.size === 0 || validCodes.has(merged))) return merged;
        return null;
      };

      const update = db.prepare('UPDATE OR IGNORE visited_regions SET region_code = ?, region_name = ? WHERE id = ?');
      const del = db.prepare('DELETE FROM visited_regions WHERE id = ?');
      for (const row of rows) {
        const newCode = resolve(row);
        if (!newCode || newCode === row.region_code) continue;
        const newName = codeToName.get(newCode) || row.region_name;
        update.run(newCode, newName, row.id);
        // UNIQUE(user_id, region_code): if the user already had the target code the
        // UPDATE was IGNORED and this row still carries the old code → drop the duplicate.
        const after = db.prepare('SELECT region_code FROM visited_regions WHERE id = ?').get(row.id) as
          | { region_code: string }
          | undefined;
        if (after && after.region_code === row.region_code) del.run(row.id);
      }
    },
    () => {
      // AirTrail integration addon — disabled by default (opt-in). Per-user connection
      // lives in Settings → Integrations; this row is only the admin-level global toggle.
      try {
        db.prepare(
          'INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          'airtrail',
          'AirTrail',
          'Sync flights from your self-hosted AirTrail instance',
          'integration',
          'Plane',
          0,
          14,
        );
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      // AirTrail per-user connection (mirrors the Immich integration columns).
      try {
        db.exec('ALTER TABLE users ADD COLUMN airtrail_url TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN airtrail_api_key TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN airtrail_allow_insecure_tls INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      // AirTrail flight linkage on reservations (#214) — lets a TREK transport
      // remember its AirTrail origin so the two-way sync can match + update it.
      // sync_enabled flips to 0 when the AirTrail flight is deleted (row kept).
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN external_source TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN external_id TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN external_owner_user_id INTEGER');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN external_synced_at TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN sync_enabled INTEGER DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN external_hash TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      // NULLs compare distinct in SQLite, so non-linked reservations don't collide.
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_external ON reservations(external_source, external_id, trip_id)',
      );
    },
    () => {
      // Per-user opt-in for writing TREK edits back to AirTrail (#1240). Default
      // off: AirTrail is the source of truth and TREK never writes unless asked.
      try {
        db.exec('ALTER TABLE users ADD COLUMN airtrail_write_enabled INTEGER DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Store Google Maps feature IDs separately from real Google Places API IDs.
    () => {
      try {
        db.exec('ALTER TABLE places ADD COLUMN google_ftid TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Remember the app version a notice was dismissed at, so per-version recurring
    // notices (e.g. the thank-you) re-appear on the next install/upgrade.
    () => {
      try {
        db.exec('ALTER TABLE user_notice_dismissals ADD COLUMN dismissed_app_version TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE budget_item_members ADD COLUMN amount REAL');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Calendar feed tokens — subscribable ICS links for per-trip and all-trips feeds
    () => {
      try {
        db.exec('ALTER TABLE trips ADD COLUMN feed_token TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE users ADD COLUMN feed_token TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_feed_token ON trips(feed_token) WHERE feed_token IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feed_token ON users(feed_token) WHERE feed_token IS NOT NULL');
    },
    // Optimistic-concurrency token for offline conflict detection (#1135).
    // packing_items had only created_at, so an offline edit could not be checked
    // against a concurrent server change. SQLite forbids a non-constant DEFAULT on
    // ALTER ADD COLUMN, so add it nullable and backfill from created_at; new rows
    // set it explicitly (packingService). Additive: a request without the
    // X-Base-Updated-At header keeps the old last-write-wins behaviour.
    () => {
      try {
        db.exec('ALTER TABLE packing_items ADD COLUMN updated_at DATETIME');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec('UPDATE packing_items SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL');
    },
    // Video support (#823): the trek_photos registry held only images. media_type
    // discriminates image vs video so the gallery, lightbox and provider proxy can
    // branch; duration_ms is optional metadata for the player. Additive — existing
    // rows default to 'image'.
    () => {
      for (const stmt of [
        "ALTER TABLE trek_photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'",
        'ALTER TABLE trek_photos ADD COLUMN duration_ms INTEGER',
      ]) {
        try {
          db.exec(stmt);
        } catch (err: any) {
          if (!err.message?.includes('duplicate column name')) throw err;
        }
      }
    },
    // Dedicated booking URL (#935) — users previously stuffed links into notes.
    // Additive nullable TEXT; existing rows default to NULL.
    () => {
      try {
        db.exec('ALTER TABLE reservations ADD COLUMN url TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Private packing items (#858): an item can be hidden from other trip members.
    // is_private toggles the visibility; owner_id records who it belongs to so the
    // listing can show it only to them. owner_id is NULL on legacy rows (shared).
    () => {
      for (const stmt of [
        'ALTER TABLE packing_items ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE packing_items ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
      ]) {
        try {
          db.exec(stmt);
        } catch (err: any) {
          if (!err.message?.includes('duplicate column name')) throw err;
        }
      }
    },
    // Guest members (#1362): people added to a trip without an account. A guest is a
    // users row flagged is_guest=1 (no usable credentials) joined into trip_members,
    // so it's assignable everywhere a member is — but must never authenticate or show
    // up in the global user directory. The flag is the discriminator for those guards.
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Three-tier packing sharing (#858 follow-up): an item is Common (is_private=0,
    // every existing item — non-breaking), Personal (is_private=1, owner only) or
    // Shared-with-people (is_private=1 + recipient rows). owner_id is the "bringer".
    // Contributors are extra people who said "I can bring that too" on a Common item
    // (status 'pending' until the owner accepts).
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS packing_item_recipients (
          item_id INTEGER NOT NULL REFERENCES packing_items(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (item_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_packing_item_recipients_user ON packing_item_recipients(user_id);
        CREATE TABLE IF NOT EXISTS packing_item_contributors (
          item_id INTEGER NOT NULL REFERENCES packing_items(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'accepted',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (item_id, user_id)
        );
      `);
    },
    // Migration 150: Collections addon — personal place library (#1081).
    // Multi-list + per-place status (idea/want/visited) + fusion sharing.
    // (150 = migrations.length of this array after appending — the runner uses
    //  migrations.length, not this comment; the label is cosmetic.)
    () => {
      db.prepare(
        `
        INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, config, sort_order)
        VALUES ('collections', 'Collections', 'Personal place library — save places across trips into named lists, copy into any trip, share with others', 'global', 'Bookmark', 0, '{}', 16)
      `,
      ).run();

      db.exec(`
        CREATE TABLE IF NOT EXISTS collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          color TEXT DEFAULT '#6366f1',
          icon TEXT DEFAULT 'Bookmark',
          cover_image TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS collection_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(collection_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS collection_places (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          description TEXT,
          lat REAL,
          lng REAL,
          address TEXT,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          price REAL,
          currency TEXT,
          notes TEXT,
          image_url TEXT,
          google_place_id TEXT,
          google_ftid TEXT,
          osm_id TEXT,
          website TEXT,
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'idea',
          source_trip_id INTEGER,
          source_place_id INTEGER,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS collection_place_tags (
          collection_place_id INTEGER NOT NULL REFERENCES collection_places(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (collection_place_id, tag_id)
        );

        CREATE INDEX IF NOT EXISTS idx_collection_places_collection ON collection_places(collection_id);
        CREATE INDEX IF NOT EXISTS idx_collection_members_user ON collection_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_collection_place_tags_place ON collection_place_tags(collection_place_id);
        CREATE INDEX IF NOT EXISTS idx_collection_place_tags_tag ON collection_place_tags(tag_id);
      `);
    },

    // Migration 151: user-added links on collections + saved places (JSON text)
    () => {
      try { db.exec('ALTER TABLE collections ADD COLUMN links TEXT'); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
      try { db.exec('ALTER TABLE collection_places ADD COLUMN links TEXT'); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 152: per-member permission role on a shared list. Existing
    // accepted members default to 'editor' so nothing regresses.
    () => {
      try { db.exec("ALTER TABLE collection_members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'"); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 153: per-trip invite links (#1143). One rotating token per trip;
    // a logged-in existing user who opens the link joins the trip as a member.
    // Deleting the trip drops the token (CASCADE); the creator is nulled if their
    // account is removed so the link keeps working.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trip_invite_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
          token TEXT UNIQUE NOT NULL,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          expires_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_trip_invite_tokens_token ON trip_invite_tokens(token);
      `);
    },
    // Migration 154: optional trip binding on an admin invite link (#1402). A user
    // who REGISTERS via the link is auto-added to the trip. Nullable for backward
    // compatibility; ON DELETE SET NULL so removing the trip just unbinds the invite.
    () => {
      try { db.exec('ALTER TABLE invite_tokens ADD COLUMN trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL'); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 155: plugin system scaffold (#plugins). A plugin is a row here;
    // its code lives on the /plugins volume and (once the runtime lands) runs in
    // an isolated child process. This migration only lays down the registry
    // tables — nothing executes yet. Own data lives in a per-plugin sqlite file
    // under /plugins-data, never in these tables.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          type TEXT NOT NULL DEFAULT 'integration',
          icon TEXT DEFAULT 'Blocks',
          version TEXT,
          api_version INTEGER DEFAULT 1,
          min_trek_version TEXT,
          permissions TEXT DEFAULT '[]',
          granted_permissions TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'inactive',
          config TEXT DEFAULT '{}',
          source_repo TEXT,
          source_commit TEXT,
          sha256 TEXT,
          crash_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          reviewed_at TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS plugin_meta_migrations (
          plugin_id TEXT NOT NULL,
          migration_id TEXT NOT NULL,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (plugin_id, migration_id)
        );
        CREATE TABLE IF NOT EXISTS plugin_error_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          ts DATETIME DEFAULT CURRENT_TIMESTAMP,
          level TEXT NOT NULL DEFAULT 'error',
          message TEXT,
          stack TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_error_log_plugin ON plugin_error_log(plugin_id, ts);
        CREATE TABLE IF NOT EXISTS plugin_settings_fields (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          field_key TEXT NOT NULL,
          label TEXT,
          input_type TEXT NOT NULL DEFAULT 'text',
          placeholder TEXT,
          hint TEXT,
          required INTEGER NOT NULL DEFAULT 0,
          secret INTEGER NOT NULL DEFAULT 0,
          scope TEXT NOT NULL DEFAULT 'instance',
          options TEXT,
          oauth_config TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          UNIQUE (plugin_id, field_key)
        );
      `);
    },
    // Migration 156: separate the admin's ON/OFF intent (`enabled`) from the
    // runtime health (`status`). A crash used to flip status to 'error', which
    // erased the "keep it on" intent, so the plugin never rebooted after a deploy.
    // Boot now retries every enabled plugin regardless of last status.
    () => {
      try {
        db.exec("ALTER TABLE plugins ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;");
        // Anything not explicitly deactivated was meant to be on ('inactive' is the
        // only status deactivate() sets; a crash/shutdown could leave error/stopped/starting).
        db.exec("UPDATE plugins SET enabled = 1 WHERE status != 'inactive';");
      } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 157: plugin capabilities (from trek-plugin.json) — the client
    // needs them to place widgets (e.g. widget.slot 'hero' renders as an overlay
    // on the boarding-pass bar instead of the dashboard sidebar).
    () => {
      try { db.exec("ALTER TABLE plugins ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{}';"); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 158: TOFU pin for a plugin's author signing key (#plugins, #4).
    // Set on first install of a signed plugin; a later install whose registry key
    // differs is a hard stop (author change / key rotation / attack) unless an
    // admin re-trusts. NULL for unsigned plugins (signing is opt-in).
    () => {
      try { db.exec("ALTER TABLE plugins ADD COLUMN author_pubkey TEXT;"); } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 159: hash-chained capability audit log (#plugins, L1 hardening).
    // Every host-mediated capability call the plugin makes is recorded at the RPC
    // boundary (where the plugin provably can't reach) with the host-bound acting
    // user and a per-plugin hash chain, so wide data grants stay attributable +
    // tamper-evident + user-visible.
    () => {
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS plugin_capability_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          acting_user_id INTEGER,
          method TEXT NOT NULL,
          resource TEXT,
          code TEXT NOT NULL,
          ts TEXT NOT NULL DEFAULT (datetime('now')),
          prev_hash TEXT,
          hash TEXT NOT NULL
        );`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin ON plugin_capability_audit (plugin_id, id);');
      } catch (err) { console.warn('[migrations] Non-fatal migration step failed:', err); }
    },
    // Migration 160: per-collection custom labels (#collections). Each list owns
    // its own label set (unlike the instance-wide `tags` table), and a place can
    // carry several labels. Used for grouping + filtering places within a list.
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS collection_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#6366f1',
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );`);
      db.exec(`CREATE TABLE IF NOT EXISTS collection_place_labels (
        collection_place_id INTEGER NOT NULL REFERENCES collection_places(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES collection_labels(id) ON DELETE CASCADE,
        PRIMARY KEY (collection_place_id, label_id)
      );`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_collection_labels_collection ON collection_labels(collection_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_collection_place_labels_place ON collection_place_labels(collection_place_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_collection_place_labels_label ON collection_place_labels(label_id);');
    },
    // Migration 161: plugin-owned metadata on core entities (#1429). A namespaced
    // key/value store so a plugin can attach data to a trip/place/day WITHOUT
    // forking the core schema. One row per (plugin, entity, key); a plugin only
    // ever sees its own rows. entity_type is polymorphic (no cross-table FK), so
    // rows are purged by plugin_id on uninstall; entity deletes leave harmless
    // orphans that the plugin's own reads never surface.
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS plugin_entity_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (plugin_id, entity_type, entity_id, key)
      );`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_plugin_meta_entity ON plugin_entity_metadata (plugin_id, entity_type, entity_id);');
    },

    // Freeze the FX rate on settle-up transfers too (#1445). budget_settlements
    // stored only a bare `amount` in whatever display currency the payer was
    // viewing, so a later live-rate drift re-opened an already-settled position
    // with a few-cent residual. Capture the display `currency` and the rate frozen
    // at settle time (units of that currency per 1 trip currency), mirroring the
    // budget_items columns. Legacy rows keep currency = NULL / rate = 1 and stay on
    // live rates until re-edited.
    () => {
      try {
        db.exec('ALTER TABLE budget_settlements ADD COLUMN currency TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE budget_settlements ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },

    // #1446: guests are per-trip people, but their display name lived in the globally
    // UNIQUE users.username, so a second "Jake" on another trip was auto-renamed to
    // "Jake 2". Add a non-unique display_name; new guests store the human name here and
    // get a uuid-based username that is never shown (the member views COALESCE to it).
    () => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },

    // Plugin dependencies (#plugins): a plugin's trek-plugin.json can now declare
    // `requiredAddons` (addon ids that must be enabled to activate) and
    // `pluginDependencies` ({id, version-range} of other plugins that must be
    // installed + satisfied). Stored as one JSON blob and populated by the
    // discovery upsert on every install path. Legacy rows default to '{}' (no deps).
    () => {
      try {
        db.exec("ALTER TABLE plugins ADD COLUMN dependencies TEXT NOT NULL DEFAULT '{}'");
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // Per-user plugin settings (#plugins). A plugin can declare `scope:'user'`
    // settings fields (e.g. an API key or a personal preference); each USER stores
    // their own values here, separate from the admin-owned instance `plugins.config`.
    // Secrets are encrypted with the same apiKeyCrypto as instance secrets and are
    // never echoed back to the client (masked). Runtime reads the acting user's row.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_user_config (
          plugin_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (plugin_id, user_id)
        );
      `);
    },
    // Host-brokered outbound OAuth (#plugins). A plugin becomes an OAuth *client* of a
    // third-party service; the HOST runs authorize->callback->token->refresh with
    // PKCE+state and owns the tokens — the plugin never sees the refresh token. Tokens
    // are per-user + encrypted at rest; the in-flight PKCE verifier/state is short-lived.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_oauth_tokens (
          plugin_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          access_token TEXT,
          refresh_token TEXT,
          expires_at INTEGER,
          scope TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (plugin_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS plugin_oauth_state (
          state TEXT PRIMARY KEY,
          plugin_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          verifier TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    },
    // Persistent plugin scheduler (#plugins). A plugin with the existing `jobs:run`
    // grant can schedule a userless callback to fire at a future time (once, or
    // recurring), surviving server restarts because the entry lives here. Same risk
    // class as cron jobs (no user, no trip reads, own db + declared egress only) —
    // so it rides on `jobs:run`, no new consent. UNIQUE(plugin_id, name) makes
    // scheduler.set an upsert and cancel deterministic. Rows are purged on uninstall.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          name TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          payload TEXT NOT NULL DEFAULT 'null',
          every_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (plugin_id, name)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_plugin_sched_due ON plugin_scheduled_tasks (due_at);');
    },
    // Durable GDPR erasure queue (#plugins). When a TREK account is deleted, every
    // installed plugin holding `hook:user-data` gets a pending row here so its own
    // deleteUserData handler runs even if the plugin was offline at delete time —
    // erasure must not be lost across a restart, so it is persisted (unlike the
    // best-effort event buffer). The row is removed once the plugin acknowledges,
    // and all of a plugin's rows are purged on uninstall. UNIQUE(plugin_id, user_id)
    // makes re-enqueue idempotent.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_user_erasure_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (plugin_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_plugin_erasure_plugin ON plugin_user_erasure_queue (plugin_id);');
    },

    // Tombstones for Atlas countries the user has explicitly removed (#1490).
    // Atlas derives visited countries from trip places and transport endpoints on every
    // request, so those countries have no row to delete — "Remove" deleted from
    // visited_countries (which never had the row), the client hid it optimistically, and
    // the next getStats re-derived it. Recording the removal here lets getStats suppress
    // a derived country. Re-marking a country deletes its tombstone.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hidden_countries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          country_code TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (user_id, country_code)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_hidden_countries_user ON hidden_countries (user_id);');
    },

    // Operator-supplied egress hosts for a plugin (#plugins).
    // A plugin's egress allow-list is fixed in its manifest at publish time, but a plugin
    // that talks to a SELF-HOSTED service (Gotify, ntfy, …) cannot know the operator's
    // hostname — so a community plugin could serve nobody. These rows let the ADMIN add
    // hosts post-install; the runtime unions them into the child's allow-list at spawn.
    // Consent stays with the admin (never the end user), exactly as for manifest egress.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_egress_hosts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          host TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (plugin_id, host)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_plugin_egress_hosts_plugin ON plugin_egress_hosts (plugin_id);');
      // Whether the plugin DECLARED that it needs operator-supplied hosts. Only such a
      // plugin may have hosts added — an admin can never widen egress for a plugin that
      // never asked for it, so the install-time consent still bounds what's possible.
      const columns = db.prepare("PRAGMA table_info('plugins')").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'operator_egress')) {
        db.exec('ALTER TABLE plugins ADD COLUMN operator_egress INTEGER NOT NULL DEFAULT 0;');
      }
    },

    // Settings-page action buttons a plugin contributes ("Test connection", "Sync now").
    // Descriptors only — the handler lives in the plugin's code and is invoked host-side
    // with the CLICKING user bound, so it can read that user's own settings.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_actions (
          plugin_id TEXT NOT NULL,
          action_key TEXT NOT NULL,
          label TEXT NOT NULL,
          hint TEXT,
          danger INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (plugin_id, action_key)
        );
      `);
    },

    // Why a plugin's update was REFUSED by the signature check (#plugins). A refused
    // update leaves a working plugin pinned at its old version — previously the reason
    // lived only in a transient toast, so the plugin quietly stopped updating and the
    // admin had to re-attempt an update to rediscover why. Record it instead.
    //
    // `update_block_version` is the registry version that was refused: once the registry
    // offers something NEWER, the block describes an artifact nobody is being offered
    // anymore, so it reads as stale and the admin can just re-attempt (the next install
    // re-verifies and either succeeds or re-blocks with fresh values). Deliberately no
    // `status = 'error'` — the plugin still runs fine on its old code.
    () => {
      for (const col of ['update_block_code TEXT', 'update_block_detail TEXT', 'update_block_version TEXT']) {
        try {
          db.exec(`ALTER TABLE plugins ADD COLUMN ${col};`);
        } catch (err) {
          console.warn('[migrations] Non-fatal migration step failed:', err);
        }
      }
    },

    // The semver RANGE of TREK versions a plugin declares it supports (its manifest's
    // `trek`, e.g. ">=3.2.0 <4.0.0"). The existing `min_trek_version` only carries the
    // lower bound, so it cannot express "stops working at 4.0" — which is precisely the
    // case the activation gate has to catch after a TREK upgrade. Kept nullable: a plugin
    // installed before this column existed has no range recorded, and the gate refuses to
    // activate it rather than guessing (see TREK_VERSION_UNKNOWN).
    () => {
      try {
        db.exec('ALTER TABLE plugins ADD COLUMN trek_range TEXT;');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },

    // `place_regions` is a re-derivable Nominatim cache, only ever populated for a place ID
    // that isn't already cached — so a wrong row, once written, was permanent. Region
    // resolution now resolves a place's lat/lng directly against the bundled admin1 polygons
    // (the same ones the client renders) instead of trusting Nominatim's address level, which
    // could name a subdivision level the bundle doesn't carry (Barcelona's ES-B province vs
    // the bundle's ES-CT autonomous community) and never highlight. That fix only helps
    // places re-resolved after it, so clear the cache once and let every place re-resolve on
    // the next Atlas load. The country_code stored alongside is cleared too, which also drops
    // the old wrong-country rows a US-state-abbreviation address used to produce.
    () => {
      try {
        db.exec('DELETE FROM place_regions');
      } catch (err) {
        // place_regions is created by an earlier migration; tolerate its absence on an
        // unusual partial DB rather than aborting startup.
        if (!(err instanceof Error) || !err.message.includes('no such table')) throw err;
      }
    },

    // Tombstones for Atlas regions the user has explicitly removed — the region-level
    // counterpart to hidden_countries above (#1490). A visited region is normally derived
    // fresh from place_regions/visited_regions on every request, so "removing" it has
    // nothing to delete; recording it here lets getVisitedRegions suppress a derived region
    // the same way getStats already suppresses a derived country. Unlike the country-level
    // tombstone (originally only reachable for a manually-marked or zero-count country),
    // this also covers a region derived from real place data — e.g. one that ended up on
    // the wrong side of a border-simplification gap and the user just wants gone.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hidden_regions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          region_code TEXT NOT NULL,
          country_code TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (user_id, region_code)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_hidden_regions_user ON hidden_regions (user_id);');
    },
    // Half vacation days (#552): a vacay entry can now count as a full day (1) or
    // a half day (0.5) toward the entitlement. Existing entries default to a full
    // day, so the entitlement maths are unchanged for everyone already using vacay.
    // Guarded so re-running the migration tail (e.g. the crosswalk test) is a no-op.
    () => {
      const hasFraction = db.prepare("SELECT 1 FROM pragma_table_info('vacay_entries') WHERE name = 'fraction'").get();
      if (!hasFraction) db.exec('ALTER TABLE vacay_entries ADD COLUMN fraction REAL NOT NULL DEFAULT 1');
    },
    // Read-only vacay calendar sharing (#444/#667): a user can let other users
    // view their vacation calendar without fusing plans. owner_id is the sharing
    // user, user_id the viewer; hidden lets the viewer hide the overlay without
    // removing the share. Follows the person, not the plan, so it survives
    // fusion and dissolution.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vacay_shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (owner_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_vacay_shares_user ON vacay_shares (user_id);');
    },
    // Collaborative place ratings (#1435): every trip member can rate a trip
    // place 1-5, every collection member a saved place; the displayed value is
    // the average. One row per user and place, mirroring collab_poll_votes.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS place_ratings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(place_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_place_ratings_place ON place_ratings (place_id);');
      db.exec(`
        CREATE TABLE IF NOT EXISTS collection_place_ratings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection_place_id INTEGER NOT NULL REFERENCES collection_places(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(collection_place_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_collection_place_ratings_place ON collection_place_ratings (collection_place_id);');
    },
    // Per-segment travel mode (#1281): the day-plan route can use a different
    // transport mode for each leg. leg_transport_mode on an assignment is the mode
    // of the leg LEAVING that stop (NULL = inherit the day default); days gains a
    // persisted default_transport_mode so the whole-day choice survives a reload.
    // Both nullable → existing itineraries keep today's single-mode behaviour.
    () => {
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN leg_transport_mode TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      try {
        db.exec('ALTER TABLE days ADD COLUMN default_transport_mode TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // School holidays are a visual Vacay calendar layer. Keep them separate from
    // public holidays so applyHolidayCalendars never removes vacation entries for
    // school-break dates. Appended LAST: this branch was cut before #1435/#1281
    // landed on dev, so an existing DB is already past their slots — only a
    // trailing migration re-runs on upgrade and actually adds these columns.
    () => {
      const planCols = db.prepare("PRAGMA table_info('vacay_plans')").all() as Array<{ name: string }>;
      if (!planCols.some(col => col.name === 'school_holidays_enabled')) {
        db.exec('ALTER TABLE vacay_plans ADD COLUMN school_holidays_enabled INTEGER DEFAULT 0');
      }
      const calendarCols = db.prepare("PRAGMA table_info('vacay_holiday_calendars')").all() as Array<{ name: string }>;
      if (!calendarCols.some(col => col.name === 'type')) {
        db.exec("ALTER TABLE vacay_holiday_calendars ADD COLUMN type TEXT NOT NULL DEFAULT 'public_holiday'");
      }
    },
    // #1517 — assign trip members / named guests to a reservation (mirrors budget_item_members).
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reservation_travelers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(reservation_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reservation_travelers_res ON reservation_travelers(reservation_id);
        CREATE INDEX IF NOT EXISTS idx_reservation_travelers_user ON reservation_travelers(user_id);
      `);
    },
    // Comp/Flex days (#1074): a vacay entry is either a vacation day (counts toward
    // the entitlement) or a comp/flex day (kind='comp', costs 0 — flextime/overtime
    // offset). Orthogonal to fraction, so a half comp day is kind='comp' + fraction=0.5.
    () => {
      const hasKind = db.prepare("SELECT 1 FROM pragma_table_info('vacay_entries') WHERE name = 'kind'").get();
      if (!hasKind) db.exec("ALTER TABLE vacay_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'vacation'");
    },
    // Configurable vacation year (#737): per-user leave-year window. 'calendar' keeps
    // the Jan 1–Dec 31 default (unchanged for everyone); 'fiscal' starts on a fixed
    // month/day; 'anniversary' starts on the month/day of the hire date. The year
    // integer still names a period; the service resolves it to a [start,end) range.
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vacay_user_settings (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          year_type TEXT NOT NULL DEFAULT 'calendar',
          year_start_month INTEGER NOT NULL DEFAULT 1,
          year_start_day INTEGER NOT NULL DEFAULT 1,
          hire_date TEXT
        );
      `);
    },
    // Manual GPX track colour (#776): imported tracks all render in the same blue
    // because the importer never assigns a category, so several walks in the same
    // area are indistinguishable. NULL keeps the old behaviour (category colour,
    // then the #3b82f6 fallback) for every existing row.
    () => {
      const hasRouteColor = db.prepare("SELECT 1 FROM pragma_table_info('places') WHERE name = 'route_color'").get();
      if (!hasRouteColor) db.exec('ALTER TABLE places ADD COLUMN route_color TEXT');
    },

    // Backfill the three places feature toggles before their read flips from
    // fail-open (`value !== 'false'`) to fail-closed (`value === 'true'`), so
    // existing installs that never touched the admin switches keep the features
    // they have today. A row that already says 'false' is left alone.
    () => {
      const insert = db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'true')");
      for (const key of ['places_photos_enabled', 'places_autocomplete_enabled', 'places_details_enabled']) {
        insert.run(key);
      }
    },

    // Free the `note` column on budget items for its actual purpose (#1658).
    // The costs UI stores an itemized receipt in it as `TICKETJSON:{...}`, which
    // means an expense split by receipt can never carry a written note, and
    // saving an expense any other way wipes whatever was typed in the budget
    // table. The receipt moves to its own column and note becomes text again.
    // GLOB, not LIKE: LIKE is case-insensitive in SQLite, so a hand-written note
    // starting "ticketjson:" would be chopped up and its text dropped.
    () => {
      const hasTicket = db.prepare("SELECT 1 FROM pragma_table_info('budget_items') WHERE name = 'ticket_json'").get();
      if (!hasTicket) db.exec('ALTER TABLE budget_items ADD COLUMN ticket_json TEXT');
      db.exec(`
        UPDATE budget_items
           SET ticket_json = substr(note, 12), note = NULL
         WHERE note GLOB 'TICKETJSON:*'
      `);
    },

    // Note colours (#1629). A day note is a label as much as a reminder — "watch
    // out", "must see", "already booked" — and a wall of identical grey cards
    // makes that impossible to see at a glance. NULL keeps the neutral card
    // every existing note has today.
    () => {
      const hasColor = db.prepare("SELECT 1 FROM pragma_table_info('day_notes') WHERE name = 'color'").get();
      if (!hasColor) db.exec('ALTER TABLE day_notes ADD COLUMN color TEXT');
    },

    // Per-segment travel mode for boundary legs: a leg whose ORIGIN is not a place
    // (booking arrival, morning hotel) stores its mode on the DESTINATION stop.
    // NULL = inherit the day default. INERT whenever the previous timeline element
    // is itself a place (that place's outgoing leg_transport_mode wins).
    // Appended LAST: the array is index-addressed against schema_version, so a slot
    // inserted anywhere above this line is simply skipped on every existing database.
    () => {
      try {
        db.exec('ALTER TABLE day_assignments ADD COLUMN incoming_leg_transport_mode TEXT');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
    },
    // #1298 — an expense can hang off a place, exactly as it already hangs off a
    // reservation. Same nullable FK, same ON DELETE SET NULL: the delete paths
    // take the linked expense with the place themselves, so the constraint is a
    // backstop for anything that removes a place without going through them.
    // Appended LAST: the array is index-addressed against schema_version, so a
    // slot inserted above this line never runs on an existing database.
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('budget_items')").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'place_id')) {
        db.exec('ALTER TABLE budget_items ADD COLUMN place_id INTEGER REFERENCES places(id) ON DELETE SET NULL DEFAULT NULL');
      }
    },
    // A reservation_day_positions row only makes sense when its reservation and
    // its day are on the same trip. The table carries no trip_id and its two
    // foreign keys only ask that the ids exist, so pairs that never belonged
    // together could accumulate; the writer refuses them now, and this clears
    // whatever an older build let through. This slot keeps the index it shipped
    // with on dev — the array is index-addressed against schema_version.
    () => {
      db.exec(`
        DELETE FROM reservation_day_positions
         WHERE rowid IN (
           SELECT rdp.rowid
             FROM reservation_day_positions rdp
             JOIN reservations r ON r.id = rdp.reservation_id
             JOIN days d ON d.id = rdp.day_id
            WHERE d.trip_id <> r.trip_id
         )
      `);
    },
    // #1939 — the Google Places and Unsplash keys are instance configuration and
    // now resolve out of app_settings (nest/settings/instance-api-keys.ts). This
    // carries the value the old resolver would have handed out — the lowest-id
    // admin who has one — into that row, so an install that upgrades keeps the
    // key it was searching with instead of falling back to OpenStreetMap.
    // Only where that key already was the whole install's, though. The resolver
    // reads the instance row before the caller's own column, so promoting a
    // personal key while a second row still holds one would move that member
    // onto a stranger's key and a stranger's bill without anyone saying so. As
    // soon as another row has a value for the same column nothing is written:
    // everybody keeps resolving what they resolved before, and a member with no
    // key of their own searches via OpenStreetMap until an admin saves the
    // instance key once in the panel. Handing a key to the whole instance is the
    // admin's call, not a migration's.
    // The users columns are left alone: they are still the per-user fallback,
    // and nothing here can lose a value. Stored blobs are copied verbatim; both
    // sides use the same apiKeyCrypto format, legacy plaintext included.
    // Appended LAST — the array is index-addressed against schema_version.
    () => {
      const upsert = db.prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      for (const column of ['maps_api_key', 'unsplash_api_key'] as const) {
        const existing = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(column) as
          | { value: string | null }
          | undefined;
        if (existing?.value) continue;
        const row = db
          .prepare(
            `SELECT id, ${column} AS value FROM users
              WHERE role = 'admin' AND ${column} IS NOT NULL AND ${column} != ''
              ORDER BY id ASC LIMIT 1`
          )
          .get() as { id: number; value: string } | undefined;
        if (!row?.value) continue;
        const otherHolder = db
          .prepare(
            `SELECT 1 FROM users
              WHERE id != ? AND ${column} IS NOT NULL AND ${column} != '' LIMIT 1`
          )
          .get(row.id);
        if (otherHolder) continue;
        upsert.run(column, row.value);
      }
    },
    // Capture metadata on the photo itself (#1614): when it was taken and where.
    // Both are needed before photos can sit on the Journey map by their own
    // coordinates, and before a gallery can be ordered by when a picture was
    // taken rather than when it happened to be added. Nullable throughout —
    // most providers answer with neither, and a photo without them is normal.
    // Guarded so re-running the migration tail is a no-op.
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('trek_photos')").all() as Array<{ name: string }>;
      const has = (name: string) => cols.some(c => c.name === name);
      if (!has('taken_at')) db.exec('ALTER TABLE trek_photos ADD COLUMN taken_at TEXT');
      if (!has('lat')) db.exec('ALTER TABLE trek_photos ADD COLUMN lat REAL');
      if (!has('lng')) db.exec('ALTER TABLE trek_photos ADD COLUMN lng REAL');
      // Answering "which photos of this journey have coordinates" without a scan.
      db.exec('CREATE INDEX IF NOT EXISTS idx_trek_photos_geo ON trek_photos(lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL');
    },
    // A journey shared while the trip is still running reads like a blog, and a
    // blog puts the newest entry first (#1614). The owner decides per share link,
    // because it is a property of how the link is meant to be read, not of the
    // journey. Off by default: an already-published link must not reorder itself
    // under its readers.
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('journey_share_tokens')").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'newest_first')) {
        db.exec('ALTER TABLE journey_share_tokens ADD COLUMN newest_first INTEGER NOT NULL DEFAULT 0');
      }
    },
    /*
     * TREK Studio books (#1973).
     *
     * One row per book, the document itself stored as JSON. A book is a
     * document rather than a graph of records: the editor loads it whole, the
     * renderer prints it whole, and nothing ever queries "which books contain a
     * heart-shaped frame". Normalising spreads and elements into tables would
     * buy queries nobody makes and cost a join on every open plus a schema
     * migration for every new element kind.
     *
     * `updated_at` and `version` are what make concurrent editing possible:
     * the version increments on every write, and a client that saves against a
     * version it did not read gets told rather than silently overwriting.
     */
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journey_books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT '',
          document TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_journey_books_journey ON journey_books(journey_id);
      `);
    },
    /*
     * Great Britain gained its counties and boroughs back (#1974).
     *
     * geoBoundaries' GBR ADM1 is the four constituent countries, so since 3.1.0
     * the atlas had no polygon below "England" and a London borough marked as
     * visited had nothing to light up. The bundle now ships GB at ADM2, which is
     * the granularity the rest of the world gets and the granularity the
     * pre-3.1.0 Natural Earth layer had.
     *
     * Two things need saying to the data that already exists:
     *
     * `visited_regions` rows marked before 3.1.0 hold the old Natural Earth
     * borough codes. They are reconciled by name within the same country,
     * exactly as the 3.1.1 step above does for every other country — a row that
     * still cannot be resolved is left alone rather than destroyed, and the
     * client's name fallback may well still highlight it.
     *
     * `place_regions` is a re-derivable cache, and it is full of GB-ENG rows
     * that were correct under the old bundle. Nothing re-derives a row that is
     * already there, so without clearing them every English place would keep
     * reporting "England" forever.
     */
    () => {
      db.exec(`DELETE FROM place_regions WHERE UPPER(COALESCE(country_code, '')) = 'GB'`);

      type Row = { id: number; region_code: string; region_name: string; country_code: string };
      const rows = db
        .prepare(`SELECT id, region_code, region_name, country_code FROM visited_regions WHERE UPPER(COALESCE(country_code, '')) = 'GB'`)
        .all() as Row[];
      if (rows.length === 0) return;

      let features: { properties?: { iso_a2?: string; iso_3166_2?: string; name?: string } }[];
      try {
        const file = path.join(__dirname, '..', '..', 'assets', 'atlas', 'admin1.geojson.gz');
        features = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')).features || [];
      } catch {
        return; // bundle unreadable — leave the rows untouched rather than guessing
      }

      const validCodes = new Set<string>();
      const nameToCode = new Map<string, string>();
      for (const f of features) {
        const p = f.properties || {};
        if ((p.iso_a2 || '').toUpperCase() !== 'GB' || !p.iso_3166_2) continue;
        validCodes.add(p.iso_3166_2);
        if (p.name) nameToCode.set(p.name.toLowerCase(), p.iso_3166_2);
      }
      if (validCodes.size === 0) return;

      const update = db.prepare('UPDATE OR IGNORE visited_regions SET region_code = ? WHERE id = ?');
      for (const row of rows) {
        if (validCodes.has(row.region_code)) continue;
        const byName = nameToCode.get((row.region_name || '').toLowerCase());
        if (byName) update.run(byName, row.id);
      }
    },
    // Storage slice 2 — collab note attachments historically stored 'files/<name>'
    // in trip_files.filename while the file manager stored bare names in the same
    // column; the storage layer addresses objects as category + bare name, so
    // normalize the legacy rows. substr is 1-indexed: 7 drops the six chars of
    // 'files/'. The LIKE guard makes it a no-op on already-bare rows.
    //
    // Appended LAST again, and for the same reason as the note this replaces:
    // the array is index-addressed against schema_version, so a slot that has
    // shipped in dev keeps the index it shipped with and anything from this
    // branch goes after it. A database that already ran this migration at its
    // pre-merge index replays it harmlessly (the LIKE guard) but skips whatever
    // now occupies that index. Acceptable only because this branch has never
    // been published; never do this with a released slot.
    () => {
      db.exec("UPDATE trip_files SET filename = substr(filename, 7) WHERE filename LIKE 'files/%'");
    },
    // Give back the notes the TICKETJSON step chopped up (#1658).
    //
    // That step matched with LIKE, which is case-insensitive in SQLite, so a
    // note somebody had typed starting "ticketjson:" was read as a receipt: the
    // first eleven characters were dropped, the rest was moved into ticket_json
    // and the note was set to NULL. The step now matches with GLOB, but that
    // only helps a fresh install — the array is index-addressed against
    // schema_version, so a repaired step never runs again on a database that
    // already applied it.
    //
    // A receipt comes out of JSON.stringify and always parses; typed text does
    // not. So a row moves back only when its ticket_json fails to parse AND the
    // note is still empty — anything that parses, and any row someone has
    // written a note on since, is left exactly as it is. The eleven marker
    // characters themselves are gone for good: their case was the only thing
    // separating a receipt from a note, and writing "TICKETJSON:" back would
    // hand the row straight to the reader that reads that prefix as a receipt.
    // Appended LAST — the array is index-addressed against schema_version.
    () => {
      const rows = db
        .prepare(
          `SELECT id, ticket_json FROM budget_items
            WHERE ticket_json IS NOT NULL AND ticket_json != '' AND COALESCE(note, '') = ''`
        )
        .all() as Array<{ id: number; ticket_json: string }>;
      const restore = db.prepare('UPDATE budget_items SET note = ?, ticket_json = NULL WHERE id = ?');
      for (const row of rows) {
        try {
          JSON.parse(row.ticket_json);
        } catch {
          restore.run(row.ticket_json, row.id);
        }
      }
    },

    // A deliberate non-latest plugin install sets `update_hold`: the row leaves the
    // update banner and "Update all" until the admin resumes updates, or until an
    // install lands back on the newest compatible version. Only an EXPLICIT version
    // pick ever sets it — dependency resolution pins versions too, but never
    // deliberately. Appended LAST — the array is index-addressed against schema_version.
    () => {
      try {
        db.exec('ALTER TABLE plugins ADD COLUMN update_hold INTEGER NOT NULL DEFAULT 0;');
      } catch (err) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },

    // Reservations an automated ingest parked for review are 'staged' and stay
    // out of the two anonymous exports (ICS feed, shared trip) until a person
    // confirms them. Nothing writes 'staged' yet; this is the gate the mail
    // ingest writes through.
    //
    // 'live' as the default is what keeps this from being a breaking change:
    // SQLite fills every existing row on the ALTER, and no current writer names
    // the column, so every booking that is visible today stays visible.
    // Appended LAST, the array is index-addressed against schema_version.
    () => {
      const hasColumn = db
        .prepare("SELECT 1 FROM pragma_table_info('reservations') WHERE name = 'ingest_state'")
        .get();
      if (!hasColumn) {
        db.exec("ALTER TABLE reservations ADD COLUMN ingest_state TEXT NOT NULL DEFAULT 'live'");
      }
    },

    /*
     * Separate an integration key from an MCP token (#2089).
     *
     * Both live in mcp_tokens and until now both opened everything a token can
     * open. That was fine while /mcp was the only consumer; with a public REST
     * surface it means a key somebody minted for a chat client also reads their
     * trips over HTTP, and a key minted for an integration can drive every MCP
     * tool. One credential, two very different blast radii.
     *
     * `kind` splits them, and every existing row becomes 'mcp' — that is what
     * they were issued for, and silently widening a key that is already in
     * somebody's config would be the opposite of what this migration is for.
     *
     * Appended LAST: the array is index-addressed against schema_version.
     */
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('mcp_tokens')").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'kind')) {
        db.exec("ALTER TABLE mcp_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'mcp'");
      }
    },
    /**
     * `naver_list_import` was typed 'trip', but a trip addon is one that earns its own
     * tab inside a trip — this one has no tab (it is not in tripTabs.ts) and no page. It
     * calls an external service to pull places into the sidebar, which is exactly what
     * 'integration' means here.
     *
     * The type is presentational: only `type === 'global'` is read anywhere
     * (client navItems.ts), so this moves the tile between admin groups and changes
     * nothing about how the import behaves.
     *
     * Appended LAST: the array is index-addressed against schema_version.
     */
    () => {
      db.prepare("UPDATE addons SET type = 'integration' WHERE id = 'naver_list_import'").run();
    },
    /**
     * Whether a journey's map draws the GPX tracks of the trips behind it (#2194).
     *
     * #1260 added those tracks unconditionally and with nothing to switch off,
     * on the reasoning that a route imported into a linked trip is part of the
     * journey's story. For a trip carrying a season of recorded drives it is
     * instead a map nobody asked for, drawn from places that never became an
     * entry — so it becomes a journey-level setting.
     *
     * DEFAULT 0, i.e. off: the tracks are opt-in from here on. That is a
     * deliberate behaviour change rather than a preserved default — a journal
     * should show what its author put in it, and #1260's set is everything the
     * linked trips happen to contain. Owners who want them back have one
     * switch in Journey Settings.
     */
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('journeys')").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'show_trip_tracks')) {
        db.exec('ALTER TABLE journeys ADD COLUMN show_trip_tracks INTEGER NOT NULL DEFAULT 0');
      }
    },
    /**
     * Settings-field defaults (#plugins, PR-87 feedback). A manifest `default` is the
     * field's effective value when nothing is stored — the settings form pre-fills it and
     * the runtime resolves it (settings-defaults.ts); it was previously accepted by the
     * manifest and silently dropped here. JSON-encoded so string/number/boolean round-trip.
     *
     * Appended LAST: the array is index-addressed against schema_version.
     */
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('plugin_settings_fields')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'default_value')) {
        db.exec('ALTER TABLE plugin_settings_fields ADD COLUMN default_value TEXT');
      }
    },

    // Settings-form actions gain a scope (#plugins): 'user' renders on the user Settings
    // tab, 'instance' in the admin instance-settings dialog. Existing rows predate the
    // column and were all user-tab buttons, so the default keeps them where they were.
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('plugin_actions')").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === 'scope')) {
        db.exec("ALTER TABLE plugin_actions ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'");
      }
    },
    /**
     * A journal entry that is not a stop (discussion #2064).
     *
     * Studio draws its route and prints its distance from every entry that
     * carries coordinates, and that is right until the journal starts at the
     * home airport: the night before the flight, the stopover, the place the
     * trip was planned from all become stops, and the distance counts the legs
     * to and from them. The traveller knows which of those are the journey and
     * which are the way there, so the switch sits on the entry. The entry stays
     * in the journal; it is only left out of the arithmetic.
     *
     * DEFAULT 0: every existing entry keeps counting, which is what it did.
     *
     * Appended LAST: the array is index-addressed against schema_version.
     */
    () => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('journey_entries')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'stats_excluded')) {
        db.exec('ALTER TABLE journey_entries ADD COLUMN stats_excluded INTEGER NOT NULL DEFAULT 0');
      }
    },
    () => {
      try {
        db.exec('ALTER TABLE trip_files ADD COLUMN message_id INTEGER REFERENCES collab_messages(id) ON DELETE CASCADE');
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) throw err;
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_trip_files_message_id ON trip_files(message_id)');
    },
    () => {
      db.exec(`CREATE TABLE IF NOT EXISTS collab_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, url TEXT NOT NULL, pinned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_collab_links_trip ON collab_links(trip_id)');
    },
  ];

  if (currentVersion < migrations.length) {
    for (let i = currentVersion; i < migrations.length; i++) {
      console.log(`[DB] Running migration ${i + 1}/${migrations.length}`);
      try {
        const migration = migrations[i];
        if (typeof migration === 'function') {
          // The version bump has to commit together with the migration. Bumped
          // afterwards, a crash in between leaves the schema advanced and the
          // version stale, and the next boot replays a step that is not
          // idempotent, exits 1, and turns one crash into a permanent boot loop.
          db.transaction(() => {
            migration();
            db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
          })();
        } else {
          // raw steps run outside a transaction on purpose (see PRAGMA
          // foreign_keys above), so the bump stays a separate statement.
          migration.raw();
          db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
        }
      } catch (err) {
        console.error(`[migrations] FATAL: Migration ${i + 1} failed, rolled back:`, err);
        process.exit(1);
      }
    }
    console.log(`[DB] Migrations complete — schema version ${migrations.length}`);
  }
}

export { runMigrations };
