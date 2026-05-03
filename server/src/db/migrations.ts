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
      const tripPhotosExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_photos'").get();
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
        const names = new Set(columns.map(c => c.name));
        const assetSource = names.has('asset_id') ? 'asset_id' : (names.has('immich_asset_id') ? 'immich_asset_id' : null);
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
      const linksExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_album_links'").get();
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
        const names = new Set(columns.map(c => c.name));
        const albumIdSource = names.has('album_id') ? 'album_id' : (names.has('immich_album_id') ? 'immich_album_id' : null);
        if (albumIdSource) {
          const providerExpr = names.has('provider')
            ? "CASE WHEN provider IS NULL OR provider = '' THEN 'immich' ELSE provider END"
            : "'immich'";
          const albumNameExpr = names.has('album_name') ? "COALESCE(album_name, '')" : "''";
          const syncEnabledExpr = names.has('sync_enabled') ? 'COALESCE(sync_enabled, 1)' : '1';
          const lastSyncedExpr = names.has('last_synced_at') ? 'last_synced_at' : 'NULL';
          const createdAtExpr = names.has('created_at') ? 'COALESCE(created_at, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';

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
      try { db.exec('ALTER TABLE users ADD COLUMN synology_url TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE users ADD COLUMN synology_username TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE users ADD COLUMN synology_password TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE users ADD COLUMN synology_sid TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    () => {
      // Seed Synology Photos provider and fields in existing databases
      try {
        db.prepare(`
          INSERT INTO photo_providers (id, name, description, icon, enabled, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            icon = excluded.icon,
            enabled = excluded.enabled,
            sort_order = excluded.sort_order
        `).run(
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
        insertField.run('synologyphotos', 'synology_url', 'providerUrl', 'url', 'https://synology.example.com', 1, 0, 'synology_url', 'synology_url', 0);
        insertField.run('synologyphotos', 'synology_username', 'providerUsername', 'text', 'Username', 1, 0, 'synology_username', 'synology_username', 1);
        insertField.run('synologyphotos', 'synology_password', 'providerPassword', 'password', 'Password', 1, 1, null, 'synology_password', 2);
      } catch (err: any) {
        if (!err.message?.includes('no such table')) throw err;
      }
    },
    () => {
      // Remove the stored config column from photo_providers now that it is generated from provider id.
      const columns = db.prepare("PRAGMA table_info('photo_providers')").all() as Array<{ name: string }>;
      const names = new Set(columns.map(c => c.name));
      if (!names.has('config')) return;

      db.exec('ALTER TABLE photo_providers DROP COLUMN config');
    },
    () => {
      const columns = db.prepare("PRAGMA table_info('trip_photos')").all() as Array<{ name: string }>;
      const names = new Set(columns.map(c => c.name));
      if (names.has('asset_id') && !names.has('immich_asset_id')) return;
      db.exec('ALTER TABLE `trip_photos` RENAME COLUMN immich_asset_id TO asset_id');
      db.exec('ALTER TABLE `trip_photos` ADD COLUMN provider TEXT NOT NULL DEFAULT "immich"');
      db.exec('ALTER TABLE `trip_album_links` ADD COLUMN provider TEXT NOT NULL DEFAULT "immich"');
      db.exec('ALTER TABLE `trip_album_links` RENAME COLUMN immich_album_id TO album_id');
    },
    () => {
      // Track which album link each photo was synced from
      try { db.exec("ALTER TABLE trip_photos ADD COLUMN album_link_id INTEGER REFERENCES trip_album_links(id) ON DELETE SET NULL DEFAULT NULL"); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try {db.exec("UPDATE addons SET enabled = 0 WHERE id = 'memories'");} catch (err) {}
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
      const tableExists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_preferences'").get() as { name: string } | undefined) != null;
      const oldPrefs: Array<Record<string, number>> = tableExists
        ? db.prepare('SELECT * FROM notification_preferences').all() as Array<Record<string, number>>
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
        'INSERT OR IGNORE INTO notification_channel_preferences (user_id, event_type, channel, enabled) VALUES (?, ?, ?, ?)'
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
      try { db.exec('ALTER TABLE budget_items ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    // Migration 74: Add quantity to packing_items + user_id to packing_bags + bag_members table
    () => {
      try { db.exec('ALTER TABLE packing_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE packing_bags ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      db.exec(`
        CREATE TABLE IF NOT EXISTS packing_bag_members (
          bag_id INTEGER NOT NULL REFERENCES packing_bags(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (bag_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_packing_bag_members_bag ON packing_bag_members(bag_id);
      `);
      // Migrate existing single user_id to bag_members
      const bagsWithUser = db.prepare('SELECT id, user_id FROM packing_bags WHERE user_id IS NOT NULL').all() as { id: number; user_id: number }[];
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
      const reservations = db.prepare('SELECT id, trip_id, reservation_time, reservation_end_time, day_plan_position FROM reservations WHERE day_plan_position IS NOT NULL').all() as any[];
      const ins = db.prepare('INSERT OR IGNORE INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)');
      for (const r of reservations) {
        const startDate = r.reservation_time?.split('T')[0];
        const endDate = r.reservation_end_time?.split('T')[0] || startDate;
        if (!startDate) continue;
        const matchingDays = db.prepare('SELECT id FROM days WHERE trip_id = ? AND date >= ? AND date <= ?').all(r.trip_id, startDate, endDate) as { id: number }[];
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
      const rows = db.prepare('SELECT DISTINCT trip_id, category FROM budget_items ORDER BY trip_id, category').all() as { trip_id: number; category: string }[];
      const ins = db.prepare('INSERT OR IGNORE INTO budget_category_order (trip_id, category, sort_order) VALUES (?, ?, ?)');
      let lastTripId = -1;
      let idx = 0;
      for (const r of rows) {
        if (r.trip_id !== lastTripId) { lastTripId = r.trip_id; idx = 0; }
        ins.run(r.trip_id, r.category, idx++);
      }
    },
    // Migration: Naver list import addon (default off)
    () => {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('naver_list_import', 'Naver List Import', 'Import places from shared Naver Maps lists', 'trip', 'Link2', 0, 13);
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
            db.exec(`INSERT INTO oauth_clients_new SELECT id, user_id, name, client_id, client_secret_hash, redirect_uris, allowed_scopes, created_at, is_public, created_via FROM oauth_clients`);
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
      if (!cols.some(c => c.name === 'hint')) {
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
      db.prepare(`
        INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, config, sort_order)
        VALUES ('journey', 'Journey', 'Trip tracking & travel journal — check-ins, photos, daily stories', 'global', 'Compass', 0, '{}', 35)
      `).run();

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
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN highlight_tags TEXT'); } catch {}
      try { db.exec("ALTER TABLE journey_entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN hero_photo_id TEXT'); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN color_accent TEXT'); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN place_name TEXT'); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN place_id INTEGER REFERENCES places(id) ON DELETE SET NULL'); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN lat REAL'); } catch {}
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN lng REAL'); } catch {}

      // Check-in: allow a single cover photo reference
      try { db.exec('ALTER TABLE journey_checkins ADD COLUMN photo_id TEXT'); } catch {}

      // Photos: add caption edit timestamp for gallery ordering
      try { db.exec('ALTER TABLE journey_photos ADD COLUMN width INTEGER'); } catch {}
      try { db.exec('ALTER TABLE journey_photos ADD COLUMN height INTEGER'); } catch {}
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
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch {}
      try { db.exec('ALTER TABLE journey_checkins ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch {}
    },
    // Migration 87: Journey rebuild — new schema with trip sync
    () => {
      // Migrate existing data from old tables into backup, then rebuild
      const hasOldJourneys = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='journeys'"
      ).get();

      let oldJourneys: any[] = [];
      let oldEntries: any[] = [];
      let oldPhotos: any[] = [];

      if (hasOldJourneys) {
        // Save existing data before dropping
        try { oldJourneys = db.prepare('SELECT * FROM journeys').all(); } catch {}
        try { oldEntries = db.prepare('SELECT * FROM journey_entries').all(); } catch {}
        try { oldPhotos = db.prepare('SELECT * FROM journey_photos').all(); } catch {}

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
          const res = db.prepare(`
            INSERT INTO journeys (user_id, title, subtitle, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            j.user_id,
            j.title || 'Untitled Journey',
            j.description || null,
            j.status || 'draft',
            j.created_at ? new Date(j.created_at).getTime() : ts,
            j.updated_at ? new Date(j.updated_at).getTime() : ts
          );
          journeyIdMap.set(j.id, Number(res.lastInsertRowid));

          // Add owner as contributor
          db.prepare(`
            INSERT OR IGNORE INTO journey_contributors (journey_id, user_id, role, added_at)
            VALUES (?, ?, 'owner', ?)
          `).run(Number(res.lastInsertRowid), j.user_id, ts);

          // Link trip if old journey had one
          if (j.trip_id) {
            try {
              db.prepare(`
                INSERT OR IGNORE INTO journey_trips (journey_id, trip_id, added_at)
                VALUES (?, ?, ?)
              `).run(Number(res.lastInsertRowid), j.trip_id, ts);
            } catch {}
          }
        }

        // Migrate entries
        const entryIdMap = new Map<string, number>();
        for (const e of oldEntries) {
          const newJourneyId = journeyIdMap.get(e.journey_id);
          if (!newJourneyId) continue;

          const res = db.prepare(`
            INSERT INTO journey_entries (journey_id, author_id, type, title, story, entry_date, entry_time, location_name, location_lat, location_lng, mood, weather, visibility, sort_order, created_at, updated_at)
            VALUES (?, ?, 'entry', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
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
            e.updated_at ? new Date(e.updated_at).getTime() : ts
          );
          entryIdMap.set(e.id, Number(res.lastInsertRowid));
        }

        // Migrate photos
        for (const p of oldPhotos) {
          const newEntryId = p.entry_id ? entryIdMap.get(p.entry_id) : null;
          if (!newEntryId || !p.file_path) continue;

          db.prepare(`
            INSERT INTO journey_photos (entry_id, file_path, thumbnail_path, caption, sort_order, width, height, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newEntryId,
            p.file_path,
            p.thumbnail_path || null,
            p.caption || null,
            p.sort_order || 0,
            p.width || null,
            p.height || null,
            p.created_at ? new Date(p.created_at).getTime() : ts
          );
        }

        console.log(`[DB] Journey migration: imported ${journeyIdMap.size} journeys, ${entryIdMap.size} entries, photos migrated`);
      }
    },
    // Migration 88: Journey photos — provider support (Immich/Synology)
    () => {
      try { db.exec("ALTER TABLE journey_photos ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'"); } catch {}
      try { db.exec('ALTER TABLE journey_photos ADD COLUMN asset_id TEXT'); } catch {}
      try { db.exec('ALTER TABLE journey_photos ADD COLUMN owner_id INTEGER REFERENCES users(id)'); } catch {}
      try { db.exec('ALTER TABLE journey_photos ADD COLUMN shared INTEGER NOT NULL DEFAULT 1'); } catch {}
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
        } catch {}
      }
    },
    // Migration 89: Journey cover image
    () => {
      try { db.exec('ALTER TABLE journeys ADD COLUMN cover_image TEXT'); } catch {}
    },
    // Migration 90: Pros/Cons for journey entries
    () => {
      try { db.exec('ALTER TABLE journey_entries ADD COLUMN pros_cons TEXT'); } catch {}
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
      try { db.exec("ALTER TABLE vacay_plans ADD COLUMN week_start INTEGER NOT NULL DEFAULT 1"); } catch {}
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
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_trek_photos_provider_asset ON trek_photos(provider, asset_id, owner_id) WHERE asset_id IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_trek_photos_owner ON trek_photos(owner_id)');

      // 2. Migrate trip_photos → trek_photos + photo_id FK
      const tripPhotosExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trip_photos'").get();
      if (tripPhotosExists) {
        // Detect schema variant: old (immich_asset_id) vs new (asset_id + provider)
        const tpCols = db.prepare("PRAGMA table_info('trip_photos')").all() as Array<{ name: string }>;
        const tpColNames = new Set(tpCols.map(c => c.name));
        const hasProvider = tpColNames.has('provider');
        const assetCol = tpColNames.has('asset_id') ? 'asset_id' : (tpColNames.has('immich_asset_id') ? 'immich_asset_id' : null);
        const hasAlbumLink = tpColNames.has('album_link_id');

        if (assetCol) {
          const providerExpr = hasProvider ? 'provider' : "'immich'";
          // Qualified alias needed in JOIN context where both trip_photos and trek_photos have provider
          const providerJoinExpr = hasProvider ? 'tp.provider' : "'immich'";
          const sharedExpr = tpColNames.has('shared') ? 'shared' : '1';
          const addedAtExpr = tpColNames.has('added_at') ? 'COALESCE(added_at, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';
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
      const journeyPhotosExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos'").get();
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
      try { db.exec('ALTER TABLE journey_contributors ADD COLUMN hide_skeletons INTEGER NOT NULL DEFAULT 0'); } catch {}
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
      try { db.exec('ALTER TABLE day_accommodations ADD COLUMN check_in_end TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE trip_album_links ADD COLUMN passphrase TEXT DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
      try { db.exec('ALTER TABLE trek_photos ADD COLUMN passphrase TEXT DEFAULT NULL'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
    { raw: () => {
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
    }},
    // Migration 108: Disk cache metadata for remote-provider photo thumbnails (Immich / Synology)
    () => db.exec(`
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_reservation_endpoints_reservation_id ON reservation_endpoints(reservation_id)');
      try { db.exec('ALTER TABLE reservations ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE users ADD COLUMN immich_auto_upload INTEGER NOT NULL DEFAULT 0'); }
      catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    // Migration 112: expose immich auto-upload toggle in the Settings UI (#730)
    // Runs after Immich provider seeding so the FK to photo_providers holds.
    () => {
      try {
        const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('photo_providers', 'photo_provider_fields')").all() as Array<{ name: string }>;
        const hasProviders = hasTable.some(t => t.name === 'photo_providers');
        const hasFields = hasTable.some(t => t.name === 'photo_provider_fields');
        if (hasProviders && hasFields) {
          const immichRow = db.prepare("SELECT 1 FROM photo_providers WHERE id = 'immich' LIMIT 1").get();
          if (immichRow) {
            db.prepare(`
              INSERT OR IGNORE INTO photo_provider_fields
                (provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order)
              VALUES
                ('immich', 'immich_auto_upload', 'immichAutoUpload', 'checkbox', NULL, 0, 0, 'auto_upload', 'auto_upload', 5)
            `).run();
          }
        }
      } catch (err: any) {
        if (!err.message?.includes('no such table') && !err.message?.includes('FOREIGN KEY')) throw err;
      }
    },
    // Migration: RFC 8707 resource indicators — audience-bind OAuth tokens to /mcp
    () => {
      try { db.exec('ALTER TABLE oauth_tokens ADD COLUMN audience TEXT'); }
      catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
    },
    // Migration: password reset — add password_version for session
    // invalidation, and a token table keyed by SHA-256 hash (raw tokens
    // never hit the DB).
    () => {
      try { db.exec('ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0'); }
      catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE todo_items ADD COLUMN reminded_at DATETIME'); }
      catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
      try { db.exec('ALTER TABLE share_tokens ADD COLUMN expires_at TEXT'); }
      catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }
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
        if (names.has('start_day_id')) db.exec('CREATE INDEX IF NOT EXISTS idx_day_accommodations_start_day_id ON day_accommodations(start_day_id)');
        if (names.has('end_day_id')) db.exec('CREATE INDEX IF NOT EXISTS idx_day_accommodations_end_day_id ON day_accommodations(end_day_id)');
      } catch { /* table may not exist on very old installs */ }
      try {
        // notifications schema has varied; probe before indexing.
        const cols = db.prepare("PRAGMA table_info('notifications')").all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        if (names.has('target') && names.has('scope')) {
          db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_target_scope ON notifications(target, scope)');
        }
      } catch { /* notifications table may not exist on very old installs */ }
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
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get();
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
      const hasOld = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos'"
      ).get();
      const hasBackup = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journey_photos_old'"
      ).get();
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
      db.prepare(
        "DELETE FROM journey_entries WHERE title IN ('Gallery', '[Trip Photos]')"
      ).run();

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
        'ON journey_entries(journey_id, entry_date, sort_order)'
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
      db.exec(`CREATE TABLE IF NOT EXISTS migrations (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL);`);
      db.exec(`INSERT INTO migrations (timestamp, name) VALUES (1777810195344, 'InitialSchema1777810195344');`);
      db.exec(`INSERT INTO app_settings (key, value) VALUES ('app_version', '${process.env.APP_VERSION || '3.0.14'}')`);
    },
  ];

  if (currentVersion < migrations.length) {
    for (let i = currentVersion; i < migrations.length; i++) {
      console.log(`[DB] Running migration ${i + 1}/${migrations.length}`);
      try {
        const migration = migrations[i];
        if (typeof migration === 'function') {
          db.transaction(migration)();
        } else {
          migration.raw();
        }
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
