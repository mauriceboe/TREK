import Database from 'better-sqlite3';
import { encrypt_api_key } from '../services/apiKeyCrypto';

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const versionRow = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let currentVersion = versionRow?.version ?? 0;

  if (currentVersion === 0) {
    const hasUnsplash = db.prepare(
      "SELECT 1 FROM pragma_table_info('users') WHERE name = 'unsplash_api_key'"
    ).get();
    if (hasUnsplash) {
      currentVersion = 19;
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentVersion);
      console.log('[DB] Schema already up-to-date, setting version to', currentVersion);
    } else {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(0);
    }
  }

  const migrations: Array<() => void> = [
    () => db.exec('ALTER TABLE users ADD COLUMN unsplash_api_key TEXT'),
    () => db.exec('ALTER TABLE users ADD COLUMN openweather_api_key TEXT'),
    () => db.exec('ALTER TABLE places ADD COLUMN duration_minutes INTEGER DEFAULT 60'),
    () => db.exec('ALTER TABLE places ADD COLUMN notes TEXT'),
    () => db.exec('ALTER TABLE places ADD COLUMN image_url TEXT'),
    () => db.exec("ALTER TABLE places ADD COLUMN transport_mode TEXT DEFAULT 'walking'"),
    () => db.exec('ALTER TABLE days ADD COLUMN title TEXT'),
    () => db.exec("ALTER TABLE reservations ADD COLUMN status TEXT DEFAULT 'pending'"),
    () => db.exec('ALTER TABLE trip_files ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL'),
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
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_items'").get() as { sql: string } | undefined;
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
      try { db.exec('ALTER TABLE day_accommodations ADD COLUMN check_in TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE day_accommodations ADD COLUMN check_out TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE day_accommodations ADD COLUMN confirmation TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE places ADD COLUMN end_time TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_status TEXT DEFAULT \'none\''); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_notes TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_datetime TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE reservations ADD COLUMN assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
        db.prepare("INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES ('collab', 'Collab', 'Notes, polls, and live chat for trip collaboration', 'trip', 'Users', 1, 6)").run();
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    () => {
      try { db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_time TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_end_time TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE collab_messages ADD COLUMN deleted INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE trip_files ADD COLUMN note_id INTEGER REFERENCES collab_notes(id) ON DELETE SET NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE collab_notes ADD COLUMN website TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE reservations ADD COLUMN reservation_end_time TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE places ADD COLUMN osm_id TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE trip_files ADD COLUMN uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE trip_files ADD COLUMN starred INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE trip_files ADD COLUMN deleted_at TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE reservations ADD COLUMN accommodation_id INTEGER REFERENCES day_accommodations(id) ON DELETE SET NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE reservations ADD COLUMN metadata TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('DROP TABLE IF EXISTS packing_template_items'); } catch (err: any) {
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
      try { db.exec('ALTER TABLE packing_items ADD COLUMN weight_grams INTEGER'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE packing_items ADD COLUMN bag_id INTEGER REFERENCES packing_bags(id) ON DELETE SET NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec("ALTER TABLE vacay_plans ADD COLUMN weekend_days TEXT DEFAULT '0,6'"); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      // Immich integration
      try { db.exec("ALTER TABLE users ADD COLUMN immich_url TEXT"); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec("ALTER TABLE users ADD COLUMN immich_api_key TEXT"); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
        db.prepare("INSERT INTO addons (id, name, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)").run('memories', 'Photos', 'trip', 'Image', 0, 7);
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
      try { db.exec('ALTER TABLE reservations ADD COLUMN day_plan_position REAL DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      // Add paid_by_user_id to budget_items for expense tracking / settlement
      try { db.exec('ALTER TABLE budget_items ADD COLUMN paid_by_user_id INTEGER REFERENCES users(id)'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      // Add target_date to bucket_list for optional visit planning
      try { db.exec('ALTER TABLE bucket_list ADD COLUMN target_date TEXT DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_vacay_invite INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_photos_shared INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_collab_message INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE notification_preferences ADD COLUMN notify_packing_tagged INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN share_map INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN share_bookings INTEGER DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN share_packing INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN share_budget INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN share_collab INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    // MCP long-lived API tokens
    () => db.exec(`
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
        db.prepare("INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run('mcp', 'MCP', 'Model Context Protocol for AI assistant integration', 'integration', 'Terminal', 0, 12);
      } catch (err: any) {
        console.warn('[migrations] Non-fatal migration step failed:', err);
      }
    },
    // Index on mcp_tokens.token_hash
    () => db.exec(`
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
      try { db.exec('ALTER TABLE places ADD COLUMN route_geometry TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      try { db.exec('ALTER TABLE trips ADD COLUMN reminder_days INTEGER DEFAULT 3'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    // Encrypt any plaintext oidc_client_secret left in app_settings
    () => {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_secret'").get() as { value: string } | undefined;
      if (row?.value && !row.value.startsWith('enc:v1:')) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'oidc_client_secret'").run(encrypt_api_key(row.value));
      }
    },
    // Encrypt any plaintext smtp_pass left in app_settings
    () => {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'smtp_pass'").get() as { value: string } | undefined;
      if (row?.value && !row.value.startsWith('enc:v1:')) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'smtp_pass'").run(encrypt_api_key(row.value));
      }
    },
    // Encrypt any plaintext immich_api_key values in the users table
    () => {
      const rows = db.prepare(
        "SELECT id, immich_api_key FROM users WHERE immich_api_key IS NOT NULL AND immich_api_key != '' AND immich_api_key NOT LIKE 'enc:v1:%'"
      ).all() as { id: number; immich_api_key: string }[];
      for (const row of rows) {
        db.prepare('UPDATE users SET immich_api_key = ? WHERE id = ?').run(encrypt_api_key(row.immich_api_key), row.id);
      }
    },
    () => {
      try { db.exec('ALTER TABLE budget_items ADD COLUMN expense_date TEXT DEFAULT NULL'); } catch {}
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
  ];

  if (currentVersion < migrations.length) {
    for (let i = currentVersion; i < migrations.length; i++) {
      console.log(`[DB] Running migration ${i + 1}/${migrations.length}`);
      try {
        db.transaction(() => migrations[i]())();
      } catch (err) {
        console.error(`[migrations] FATAL: Migration ${i + 1} failed, rolled back:`, err);
        process.exit(1);
      }
      db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
    }
    console.log(`[DB] Migrations complete — schema version ${migrations.length}`);
  }
}

export { runMigrations };
