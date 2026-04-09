/**
 * Test data factories.
 * Each factory inserts a row into the provided in-memory DB and returns the created object.
 * Passwords are stored as bcrypt hashes (cost factor 4 for speed in tests).
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { encryptMfaSecret } from '../../src/services/mfaCrypto';
import { encrypt_api_key } from '../../src/services/apiKeyCrypto';

let _userSeq = 0;
let _tripSeq = 0;
let _categorySeq = 0;
let _tagSeq = 0;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface TestUser {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  password_hash: string;
}

export function createUser(
  db: Database.Database,
  overrides: Partial<{ username: string; email: string; password: string; role: 'admin' | 'user' }> = {}
): { user: TestUser; password: string } {
  _userSeq++;
  const password = overrides.password ?? `TestPass${_userSeq}!`;
  const email = overrides.email ?? `user${_userSeq}@test.example.com`;
  const username = overrides.username ?? `testuser${_userSeq}`;
  const role = overrides.role ?? 'user';
  const hash = bcrypt.hashSync(password, 4); // cost 4 for test speed

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(username, email, hash, role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as TestUser;
  return { user, password };
}

export function createAdmin(
  db: Database.Database,
  overrides: Partial<{ username: string; email: string; password: string }> = {}
): { user: TestUser; password: string } {
  return createUser(db, { ...overrides, role: 'admin' });
}

/**
 * Creates a user with MFA already enabled (directly in DB, bypasses rate-limited HTTP endpoints).
 * Returns the user, password, and the TOTP secret so tests can generate valid codes.
 */
const KNOWN_MFA_SECRET = 'JBSWY3DPEHPK3PXP'; // fixed base32 secret for deterministic tests
export function createUserWithMfa(
  db: Database.Database,
  overrides: Partial<{ username: string; email: string; password: string; role: 'admin' | 'user' }> = {}
): { user: TestUser; password: string; totpSecret: string } {
  const { user, password } = createUser(db, overrides);
  const encryptedSecret = encryptMfaSecret(KNOWN_MFA_SECRET);
  db.prepare(
    'UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?'
  ).run(encryptedSecret, user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as TestUser;
  return { user: updated, password, totpSecret: KNOWN_MFA_SECRET };
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export interface TestTrip {
  id: number;
  user_id: number;
  title: string;
  start_date: string | null;
  end_date: string | null;
}

export function createTrip(
  db: Database.Database,
  userId: number,
  overrides: Partial<{ title: string; start_date: string; end_date: string; description: string }> = {}
): TestTrip {
  _tripSeq++;
  const title = overrides.title ?? `Test Trip ${_tripSeq}`;
  const result = db.prepare(
    'INSERT INTO trips (user_id, title, description, start_date, end_date) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, title, overrides.description ?? null, overrides.start_date ?? null, overrides.end_date ?? null);

  // Auto-generate days if dates are provided
  if (overrides.start_date && overrides.end_date) {
    const start = new Date(overrides.start_date);
    const end = new Date(overrides.end_date);
    const tripId = result.lastInsertRowid as number;
    let dayNumber = 1;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)').run(tripId, dayNumber++, dateStr);
    }
  }

  return db.prepare('SELECT * FROM trips WHERE id = ?').get(result.lastInsertRowid) as TestTrip;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export interface TestDay {
  id: number;
  trip_id: number;
  day_number: number;
  date: string | null;
  title: string | null;
}

export function createDay(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ date: string; title: string; day_number: number }> = {}
): TestDay {
  // Find the next day_number for this trip if not provided
  const maxDay = db.prepare('SELECT MAX(day_number) as max FROM days WHERE trip_id = ?').get(tripId) as { max: number | null };
  const dayNumber = overrides.day_number ?? (maxDay.max ?? 0) + 1;
  const result = db.prepare(
    'INSERT INTO days (trip_id, day_number, date, title) VALUES (?, ?, ?, ?)'
  ).run(tripId, dayNumber, overrides.date ?? null, overrides.title ?? null);
  return db.prepare('SELECT * FROM days WHERE id = ?').get(result.lastInsertRowid) as TestDay;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface TestPlace {
  id: number;
  trip_id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  category_id: number | null;
}

export function createPlace(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ name: string; lat: number; lng: number; category_id: number; description: string }> = {}
): TestPlace {
  // Get first available category if none provided
  const defaultCat = db.prepare('SELECT id FROM categories LIMIT 1').get() as { id: number } | undefined;
  const categoryId = overrides.category_id ?? defaultCat?.id ?? null;

  const result = db.prepare(
    'INSERT INTO places (trip_id, name, lat, lng, category_id, description) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    tripId,
    overrides.name ?? 'Test Place',
    overrides.lat ?? 48.8566,
    overrides.lng ?? 2.3522,
    categoryId,
    overrides.description ?? null
  );
  return db.prepare('SELECT * FROM places WHERE id = ?').get(result.lastInsertRowid) as TestPlace;
}

// ---------------------------------------------------------------------------
// Trip Members
// ---------------------------------------------------------------------------

export function addTripMember(db: Database.Database, tripId: number, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, userId);
}

// ---------------------------------------------------------------------------
// Budget Items
// ---------------------------------------------------------------------------

export interface TestBudgetItem {
  id: number;
  trip_id: number;
  name: string;
  category: string;
  total_price: number;
}

export function createBudgetItem(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ name: string; category: string; total_price: number }> = {}
): TestBudgetItem {
  const result = db.prepare(
    'INSERT INTO budget_items (trip_id, name, category, total_price) VALUES (?, ?, ?, ?)'
  ).run(
    tripId,
    overrides.name ?? 'Test Budget Item',
    overrides.category ?? 'Transport',
    overrides.total_price ?? 100
  );
  return db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid) as TestBudgetItem;
}

// ---------------------------------------------------------------------------
// Packing Items
// ---------------------------------------------------------------------------

export interface TestPackingItem {
  id: number;
  trip_id: number;
  name: string;
  category: string;
  checked: number;
}

export function createPackingItem(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ name: string; category: string }> = {}
): TestPackingItem {
  const result = db.prepare(
    'INSERT INTO packing_items (trip_id, name, category, checked) VALUES (?, ?, ?, 0)'
  ).run(tripId, overrides.name ?? 'Test Item', overrides.category ?? 'Clothing');
  return db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid) as TestPackingItem;
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export interface TestReservation {
  id: number;
  trip_id: number;
  title: string;
  type: string;
}

export function createReservation(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ title: string; type: string; day_id: number }> = {}
): TestReservation {
  const result = db.prepare(
    'INSERT INTO reservations (trip_id, title, type, day_id) VALUES (?, ?, ?, ?)'
  ).run(tripId, overrides.title ?? 'Test Reservation', overrides.type ?? 'flight', overrides.day_id ?? null);
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid) as TestReservation;
}

// ---------------------------------------------------------------------------
// Invite Tokens
// ---------------------------------------------------------------------------

export interface TestInviteToken {
  id: number;
  token: string;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Day Notes
// ---------------------------------------------------------------------------

export interface TestDayNote {
  id: number;
  day_id: number;
  trip_id: number;
  text: string;
  time: string | null;
  icon: string;
}

export function createDayNote(
  db: Database.Database,
  dayId: number,
  tripId: number,
  overrides: Partial<{ text: string; time: string; icon: string }> = {}
): TestDayNote {
  const result = db.prepare(
    'INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order) VALUES (?, ?, ?, ?, ?, 9999)'
  ).run(dayId, tripId, overrides.text ?? 'Test note', overrides.time ?? null, overrides.icon ?? '📝');
  return db.prepare('SELECT * FROM day_notes WHERE id = ?').get(result.lastInsertRowid) as TestDayNote;
}

// ---------------------------------------------------------------------------
// Collab Notes
// ---------------------------------------------------------------------------

export interface TestCollabNote {
  id: number;
  trip_id: number;
  user_id: number;
  title: string;
  content: string | null;
  category: string;
  color: string;
  pinned: number;
}

export function createCollabNote(
  db: Database.Database,
  tripId: number,
  userId: number,
  overrides: Partial<{ title: string; content: string; category: string; color: string }> = {}
): TestCollabNote {
  const result = db.prepare(
    'INSERT INTO collab_notes (trip_id, user_id, title, content, category, color) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    tripId,
    userId,
    overrides.title ?? 'Test Note',
    overrides.content ?? null,
    overrides.category ?? 'General',
    overrides.color ?? '#6366f1'
  );
  return db.prepare('SELECT * FROM collab_notes WHERE id = ?').get(result.lastInsertRowid) as TestCollabNote;
}

// ---------------------------------------------------------------------------
// Todo Items
// ---------------------------------------------------------------------------

export interface TestTodoItem {
  id: number;
  trip_id: number;
  name: string;
  checked: number;
  category: string | null;
  sort_order: number;
}

export function createTodoItem(
  db: Database.Database,
  tripId: number,
  overrides: Partial<{ name: string; category: string; checked: number }> = {}
): TestTodoItem {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM todo_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
  const result = db.prepare(
    'INSERT INTO todo_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(tripId, overrides.name ?? 'Test Todo', overrides.checked ?? 0, overrides.category ?? null, sortOrder);
  return db.prepare('SELECT * FROM todo_items WHERE id = ?').get(result.lastInsertRowid) as TestTodoItem;
}

// ---------------------------------------------------------------------------
// Day Assignments
// ---------------------------------------------------------------------------

export interface TestDayAssignment {
  id: number;
  day_id: number;
  place_id: number;
  order_index: number;
  notes: string | null;
}

export function createDayAssignment(
  db: Database.Database,
  dayId: number,
  placeId: number,
  overrides: Partial<{ order_index: number; notes: string }> = {}
): TestDayAssignment {
  const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM day_assignments WHERE day_id = ?').get(dayId) as { max: number | null };
  const orderIndex = overrides.order_index ?? (maxOrder.max !== null ? maxOrder.max + 1 : 0);
  const result = db.prepare(
    'INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, ?, ?)'
  ).run(dayId, placeId, orderIndex, overrides.notes ?? null);
  return db.prepare('SELECT * FROM day_assignments WHERE id = ?').get(result.lastInsertRowid) as TestDayAssignment;
}

// ---------------------------------------------------------------------------
// Bucket List
// ---------------------------------------------------------------------------

export interface TestBucketListItem {
  id: number;
  user_id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  country_code: string | null;
  notes: string | null;
}

export function createBucketListItem(
  db: Database.Database,
  userId: number,
  overrides: Partial<{ name: string; lat: number; lng: number; country_code: string; notes: string }> = {}
): TestBucketListItem {
  const result = db.prepare(
    'INSERT INTO bucket_list (user_id, name, lat, lng, country_code, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    userId,
    overrides.name ?? 'Test Destination',
    overrides.lat ?? null,
    overrides.lng ?? null,
    overrides.country_code ?? null,
    overrides.notes ?? null
  );
  return db.prepare('SELECT * FROM bucket_list WHERE id = ?').get(result.lastInsertRowid) as TestBucketListItem;
}

// ---------------------------------------------------------------------------
// Visited Countries
// ---------------------------------------------------------------------------

export function createVisitedCountry(
  db: Database.Database,
  userId: number,
  countryCode: string
): void {
  db.prepare('INSERT OR IGNORE INTO visited_countries (user_id, country_code) VALUES (?, ?)').run(userId, countryCode.toUpperCase());
}

// ---------------------------------------------------------------------------
// Day Accommodations
// ---------------------------------------------------------------------------

export interface TestDayAccommodation {
  id: number;
  trip_id: number;
  place_id: number;
  start_day_id: number;
  end_day_id: number;
  check_in: string | null;
  check_out: string | null;
}

export function createDayAccommodation(
  db: Database.Database,
  tripId: number,
  placeId: number,
  startDayId: number,
  endDayId: number,
  overrides: Partial<{ check_in: string; check_out: string; confirmation: string }> = {}
): TestDayAccommodation {
  const result = db.prepare(
    'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    tripId,
    placeId,
    startDayId,
    endDayId,
    overrides.check_in ?? null,
    overrides.check_out ?? null,
    overrides.confirmation ?? null
  );
  return db.prepare('SELECT * FROM day_accommodations WHERE id = ?').get(result.lastInsertRowid) as TestDayAccommodation;
}

// ---------------------------------------------------------------------------
// MCP Tokens
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

export interface TestMcpToken {
  id: number;
  tokenHash: string;
  rawToken: string;
}

export function createMcpToken(
  db: Database.Database,
  userId: number,
  overrides: Partial<{ name: string; rawToken: string }> = {}
): TestMcpToken {
  const rawToken = overrides.rawToken ?? `trek_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.slice(0, 12);
  const result = db.prepare(
    'INSERT INTO mcp_tokens (user_id, token_hash, token_prefix, name) VALUES (?, ?, ?, ?)'
  ).run(userId, tokenHash, tokenPrefix, overrides.name ?? 'Test Token');
  return { id: result.lastInsertRowid as number, tokenHash, rawToken };
}

// ---------------------------------------------------------------------------
// Invite Tokens
// ---------------------------------------------------------------------------

export function createInviteToken(
  db: Database.Database,
  overrides: Partial<{ token: string; max_uses: number; expires_at: string; created_by: number }> = {}
): TestInviteToken {
  const token = overrides.token ?? `test-invite-${Date.now()}`;
  // created_by is required by the schema; use an existing admin or create one
  let createdBy = overrides.created_by;
  if (!createdBy) {
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: number } | undefined;
    if (admin) {
      createdBy = admin.id;
    } else {
      const any = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number } | undefined;
      if (any) {
        createdBy = any.id;
      } else {
        const r = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('invite_creator', 'invite_creator@test.example.com', 'x', 'admin')").run();
        createdBy = r.lastInsertRowid as number;
      }
    }
  }
  const result = db.prepare(
    'INSERT INTO invite_tokens (token, max_uses, used_count, expires_at, created_by) VALUES (?, ?, 0, ?, ?)'
  ).run(token, overrides.max_uses ?? 1, overrides.expires_at ?? null, createdBy);
  return db.prepare('SELECT * FROM invite_tokens WHERE id = ?').get(result.lastInsertRowid) as TestInviteToken;
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

/** Upsert a key/value pair into app_settings. */
export function setAppSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

/** Set the active notification channels (e.g. 'email', 'webhook', 'email,webhook', 'none'). */
export function setNotificationChannels(db: Database.Database, channels: string): void {
  setAppSetting(db, 'notification_channels', channels);
}

/** Explicitly disable a per-user notification preference for a given event+channel combo. */
export function disableNotificationPref(
  db: Database.Database,
  userId: number,
  eventType: string,
  channel: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO notification_channel_preferences (user_id, event_type, channel, enabled) VALUES (?, ?, ?, 0)'
  ).run(userId, eventType, channel);
}

// ---------------------------------------------------------------------------
// Photo integration helpers
// ---------------------------------------------------------------------------

export interface TestTripPhoto {
  id: number;
  trip_id: number;
  user_id: number;
  asset_id: string;
  provider: string;
  shared: number;
  album_link_id: number | null;
}

export function addTripPhoto(
  db: Database.Database,
  tripId: number,
  userId: number,
  assetId: string,
  provider: string,
  opts: { shared?: boolean; albumLinkId?: number } = {}
): TestTripPhoto {
  const result = db.prepare(
    'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared, album_link_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tripId, userId, assetId, provider, opts.shared ? 1 : 0, opts.albumLinkId ?? null);
  return db.prepare('SELECT * FROM trip_photos WHERE id = ?').get(result.lastInsertRowid) as TestTripPhoto;
}

export interface TestAlbumLink {
  id: number;
  trip_id: number;
  user_id: number;
  provider: string;
  album_id: string;
  album_name: string;
}

export function addAlbumLink(
  db: Database.Database,
  tripId: number,
  userId: number,
  provider: string,
  albumId: string,
  albumName = 'Test Album'
): TestAlbumLink {
  const result = db.prepare(
    'INSERT INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
  ).run(tripId, userId, provider, albumId, albumName);
  return db.prepare('SELECT * FROM trip_album_links WHERE id = ?').get(result.lastInsertRowid) as TestAlbumLink;
}

export function setImmichCredentials(
  db: Database.Database,
  userId: number,
  url: string,
  apiKey: string
): void {
  db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?')
    .run(url, encrypt_api_key(apiKey), userId);
}

export function setSynologyCredentials(
  db: Database.Database,
  userId: number,
  url: string,
  username: string,
  password: string
): void {
  db.prepare('UPDATE users SET synology_url = ?, synology_username = ?, synology_password = ? WHERE id = ?')
    .run(url, username, encrypt_api_key(password), userId);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function createCategory(
  db: Database.Database,
  overrides: { name?: string; color?: string; icon?: string; user_id?: number | null } = {}
) {
  const name = overrides.name ?? `Test Category ${++_categorySeq}`;
  const color = overrides.color ?? '#6366f1';
  const icon = overrides.icon ?? '📍';
  const userId = overrides.user_id ?? null;
  const result = db.prepare('INSERT INTO categories (name, color, icon, user_id) VALUES (?, ?, ?, ?)').run(name, color, icon, userId);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid) as { id: number; name: string; color: string; icon: string; user_id: number | null };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function createTag(
  db: Database.Database,
  userId: number,
  overrides: { name?: string; color?: string } = {}
) {
  const name = overrides.name ?? `Test Tag ${++_tagSeq}`;
  const color = overrides.color ?? '#10b981';
  const result = db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').run(userId, name, color);
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid) as { id: number; user_id: number; name: string; color: string };
}
