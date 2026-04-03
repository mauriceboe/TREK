/**
 * Test data factories.
 * Each factory inserts a row into the provided in-memory DB and returns the created object.
 * Passwords are stored as bcrypt hashes (cost factor 4 for speed in tests).
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { encryptMfaSecret } from '../../src/services/mfaCrypto';

let _userSeq = 0;
let _tripSeq = 0;

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
