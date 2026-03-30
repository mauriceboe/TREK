import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../db/schema';
import { runMigrations } from '../../db/migrations';

/**
 * SQL contract tests for the trip access-control queries and schema constraints.
 *
 * NOTE: canAccessTrip/isOwner are reimplemented here with the same SQL as
 * database.ts because the production functions reference a module-level _db
 * variable that can't be swapped without refactoring. These tests validate
 * that the SQL + schema work correctly together (catching migration regressions,
 * JOIN logic errors, cascade behavior) — but they do NOT guarantee the
 * production functions stay in sync. If the SQL in database.ts changes,
 * these tests must be updated to match.
 */

let db: Database.Database;

// Reimplement canAccessTrip/isOwner with explicit db param (same SQL as database.ts)
function canAccessTrip(testDb: Database.Database, tripId: number, userId: number) {
  return testDb.prepare(`
    SELECT t.id, t.user_id FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
  `).get(userId, tripId, userId) as { id: number; user_id: number } | undefined;
}

function isOwner(testDb: Database.Database, tripId: number, userId: number): boolean {
  return !!testDb.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

function insertUser(overrides: { username?: string; email?: string; role?: string } = {}) {
  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(
    overrides.username ?? 'user',
    overrides.email ?? 'user@test.com',
    '$2a$12$fake',
    overrides.role ?? 'user'
  );
  return Number(result.lastInsertRowid);
}

function insertTrip(userId: number, title = 'Trip') {
  const result = db.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(userId, title);
  return Number(result.lastInsertRowid);
}

function addMember(tripId: number, userId: number) {
  db.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, userId);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db);
});

describe('canAccessTrip', () => {
  it('returns trip data when user is the owner', () => {
    const userId = insertUser();
    const tripId = insertTrip(userId);
    const result = canAccessTrip(db, tripId, userId);
    expect(result).toBeDefined();
    expect(result!.id).toBe(tripId);
    expect(result!.user_id).toBe(userId);
  });

  it('returns trip data when user is a member', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const tripId = insertTrip(owner);
    addMember(tripId, member);

    const result = canAccessTrip(db, tripId, member);
    expect(result).toBeDefined();
    expect(result!.id).toBe(tripId);
  });

  it('returns undefined for non-member, non-owner', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const stranger = insertUser({ username: 'stranger', email: 'stranger@test.com' });
    const tripId = insertTrip(owner);

    const result = canAccessTrip(db, tripId, stranger);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent trip', () => {
    const userId = insertUser();
    const result = canAccessTrip(db, 9999, userId);
    expect(result).toBeUndefined();
  });

  it('owner can access without being in trip_members', () => {
    const owner = insertUser();
    const tripId = insertTrip(owner);
    // No entry in trip_members — owner should still access
    const result = canAccessTrip(db, tripId, owner);
    expect(result).toBeDefined();
  });

  it('member of one trip cannot access another trip', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const trip1 = insertTrip(owner, 'Trip 1');
    const trip2 = insertTrip(owner, 'Trip 2');
    addMember(trip1, member);

    expect(canAccessTrip(db, trip1, member)).toBeDefined();
    expect(canAccessTrip(db, trip2, member)).toBeUndefined();
  });
});

describe('isOwner', () => {
  it('returns true when user owns the trip', () => {
    const userId = insertUser();
    const tripId = insertTrip(userId);
    expect(isOwner(db, tripId, userId)).toBe(true);
  });

  it('returns false when user is a member but not owner', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const tripId = insertTrip(owner);
    addMember(tripId, member);
    expect(isOwner(db, tripId, member)).toBe(false);
  });

  it('returns false for non-existent trip', () => {
    const userId = insertUser();
    expect(isOwner(db, 9999, userId)).toBe(false);
  });

  it('returns false for non-existent user', () => {
    const owner = insertUser();
    const tripId = insertTrip(owner);
    expect(isOwner(db, tripId, 9999)).toBe(false);
  });
});

describe('trip cascade deletes', () => {
  it('deleting a trip removes its members', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const tripId = insertTrip(owner);
    addMember(tripId, member);

    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    const members = db.prepare('SELECT * FROM trip_members WHERE trip_id = ?').all(tripId);
    expect(members).toHaveLength(0);
  });

  it('deleting a user removes their trip memberships', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const tripId = insertTrip(owner);
    addMember(tripId, member);

    db.prepare('DELETE FROM users WHERE id = ?').run(member);
    const members = db.prepare('SELECT * FROM trip_members WHERE user_id = ?').all(member);
    expect(members).toHaveLength(0);
  });

  it('deleting a trip cascades to days', () => {
    const owner = insertUser();
    const tripId = insertTrip(owner);
    db.prepare('INSERT INTO days (trip_id, day_number) VALUES (?, ?)').run(tripId, 1);

    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    const days = db.prepare('SELECT * FROM days WHERE trip_id = ?').all(tripId);
    expect(days).toHaveLength(0);
  });

  it('deleting a trip cascades to places', () => {
    const owner = insertUser();
    const tripId = insertTrip(owner);
    db.prepare('INSERT INTO places (trip_id, name) VALUES (?, ?)').run(tripId, 'Eiffel Tower');

    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    const places = db.prepare('SELECT * FROM places WHERE trip_id = ?').all(tripId);
    expect(places).toHaveLength(0);
  });
});

describe('schema constraints', () => {
  it('enforces unique email on users', () => {
    insertUser({ username: 'u1', email: 'same@test.com' });
    expect(() =>
      insertUser({ username: 'u2', email: 'same@test.com' })
    ).toThrow();
  });

  it('enforces unique username on users', () => {
    insertUser({ username: 'same', email: 'e1@test.com' });
    expect(() =>
      insertUser({ username: 'same', email: 'e2@test.com' })
    ).toThrow();
  });

  it('enforces unique (trip_id, day_number) on days', () => {
    const owner = insertUser();
    const tripId = insertTrip(owner);
    db.prepare('INSERT INTO days (trip_id, day_number) VALUES (?, ?)').run(tripId, 1);
    expect(() =>
      db.prepare('INSERT INTO days (trip_id, day_number) VALUES (?, ?)').run(tripId, 1)
    ).toThrow();
  });

  it('enforces unique (trip_id, user_id) on trip_members', () => {
    const owner = insertUser({ username: 'owner', email: 'owner@test.com' });
    const member = insertUser({ username: 'member', email: 'member@test.com' });
    const tripId = insertTrip(owner);
    addMember(tripId, member);
    expect(() => addMember(tripId, member)).toThrow();
  });

  it('enforces foreign key on trips.user_id', () => {
    expect(() =>
      db.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(9999, 'Bad Trip')
    ).toThrow();
  });
});
