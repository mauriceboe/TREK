/**
 * Admin integration tests.
 * Covers ADMIN-001 to ADMIN-022.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createAdmin, createInviteToken, createTrip, createBudgetItem, createJourney, createJourneyEntry, addJourneyContributor, addTripPhoto, createCategory, createTag, createTodoItem, createMcpToken, createBucketListItem, createVisitedCountry, createCollabNote, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Access control
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin access control', () => {
  it('ADMIN-022 — non-admin cannot access admin routes', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(403);
  });

  it('ADMIN-022 — unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// User management
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin user management', () => {
  it('ADMIN-001 — GET /admin/users lists all users', async () => {
    const { user: admin } = createAdmin(testDb);
    createUser(testDb);
    createUser(testDb);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(3);
  });

  it('ADMIN-002 — POST /admin/users creates a user', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/admin/users')
      .set('Cookie', authCookie(admin.id))
      .send({ username: 'newuser', email: 'newuser@example.com', password: 'Secure1234!', role: 'user' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('newuser@example.com');
  });

  it('ADMIN-003 — POST /admin/users with duplicate email returns 409', async () => {
    const { user: admin } = createAdmin(testDb);
    const { user: existing } = createUser(testDb);

    const res = await request(app)
      .post('/api/admin/users')
      .set('Cookie', authCookie(admin.id))
      .send({ username: 'duplicate', email: existing.email, password: 'Secure1234!' });
    expect(res.status).toBe(409);
  });

  it('ADMIN-004 — PUT /admin/users/:id updates user', async () => {
    const { user: admin } = createAdmin(testDb);
    const { user } = createUser(testDb);

    const res = await request(app)
      .put(`/api/admin/users/${user.id}`)
      .set('Cookie', authCookie(admin.id))
      .send({ username: 'updated_username' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('updated_username');
  });

  it('ADMIN-005 — DELETE /admin/users/:id removes user', async () => {
    const { user: admin } = createAdmin(testDb);
    const { user } = createUser(testDb);

    const res = await request(app)
      .delete(`/api/admin/users/${user.id}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify the row is actually gone from the DB
    const deleted = testDb.prepare('SELECT id FROM users WHERE id = ?').get(user.id);
    expect(deleted).toBeUndefined();
  });

  it('ADMIN-005b — DELETE /admin/users/:id succeeds when user has FK references', async () => {
    const { user: admin } = createAdmin(testDb);
    const { user: target } = createUser(testDb);
    const { user: otherUser } = createUser(testDb);
    const { user: thirdUser } = createUser(testDb);

    // trip_members.invited_by: target invited thirdUser to otherUser's trip
    // (trip survives deletion; only invited_by should become NULL)
    const otherTrip = createTrip(testDb, otherUser.id);
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(otherTrip.id, thirdUser.id, target.id);

    // share_tokens.created_by: target created a share token for otherUser's trip
    testDb.prepare("INSERT INTO share_tokens (trip_id, token, created_by) VALUES (?, 'tok-admin-test', ?)").run(otherTrip.id, target.id);

    // budget_items.paid_by_user_id: target paid for an expense on otherUser's trip
    const budgetItem = createBudgetItem(testDb, otherTrip.id);
    testDb.prepare('UPDATE budget_items SET paid_by_user_id = ? WHERE id = ?').run(target.id, budgetItem.id);

    // journey_contributors: target is a contributor on otherUser's journey
    const otherJourney = createJourney(testDb, otherUser.id);
    addJourneyContributor(testDb, otherJourney.id, target.id);

    // journey_entries: target authored an entry on otherUser's journey
    createJourneyEntry(testDb, otherJourney.id, target.id);

    // journey_share_tokens: target created a share token for otherUser's journey
    testDb.prepare("INSERT INTO journey_share_tokens (journey_id, token, created_by) VALUES (?, 'jst-admin-test', ?)").run(otherJourney.id, target.id);

    // notifications.sender_id (SET NULL): target sent a notification to otherUser
    const sentNotif = testDb.prepare(
      "INSERT INTO notifications (type, scope, target, sender_id, recipient_id, title_key, text_key) VALUES ('simple', 'trip', ?, ?, ?, 'k', 'k')"
    ).run(otherTrip.id, target.id, otherUser.id);
    // notifications.recipient_id (CASCADE): otherUser sent a notification to target
    testDb.prepare(
      "INSERT INTO notifications (type, scope, target, sender_id, recipient_id, title_key, text_key) VALUES ('simple', 'trip', ?, ?, ?, 'k', 'k')"
    ).run(otherTrip.id, otherUser.id, target.id);

    // user_notice_dismissals (CASCADE): target dismissed a notice
    testDb.prepare(
      "INSERT INTO user_notice_dismissals (user_id, notice_id, dismissed_at) VALUES (?, 'test-notice', ?)"
    ).run(target.id, Date.now());

    // owned journey: target owns a journey with an entry (cascade-deletes on journey deletion)
    const ownedJourney = createJourney(testDb, target.id);
    createJourneyEntry(testDb, ownedJourney.id, target.id);

    // trip_files.uploaded_by (SET NULL): target uploaded a file to otherUser's trip
    const fileRow = testDb.prepare(
      "INSERT INTO trip_files (trip_id, filename, original_name, uploaded_by) VALUES (?, 'f.pdf', 'file.pdf', ?)"
    ).run(otherTrip.id, target.id);

    // trek_photos.owner_id (SET NULL): target owns a photo in the central registry
    const trekPhotoRow = testDb.prepare(
      "INSERT INTO trek_photos (provider, asset_id, owner_id) VALUES ('immich', 'asset-admin-test', ?)"
    ).run(target.id);

    // trip_photos.user_id (CASCADE): target added a photo to otherUser's trip
    addTripPhoto(testDb, otherTrip.id, target.id, 'asset-tp-admin', 'immich');

    // trips.user_id (CASCADE): target owns a trip
    const ownedTrip = createTrip(testDb, target.id);

    // trip_members.user_id (CASCADE): target is a member of otherUser's trip
    addTripMember(testDb, otherTrip.id, target.id);

    // categories.user_id (SET NULL): target created a category
    const userCategory = createCategory(testDb, { user_id: target.id });

    // tags.user_id (CASCADE): target created a tag
    const userTag = createTag(testDb, target.id);

    // todo_items.assigned_user_id (SET NULL): target is assigned to a todo on otherUser's trip
    const todoItem = createTodoItem(testDb, otherTrip.id);
    testDb.prepare('UPDATE todo_items SET assigned_user_id = ? WHERE id = ?').run(target.id, todoItem.id);

    // packing_bags.user_id (SET NULL): target owns a packing bag on otherUser's trip
    const packBagRow = testDb.prepare(
      "INSERT INTO packing_bags (trip_id, name, color, user_id) VALUES (?, 'Bag', '#ff0000', ?)"
    ).run(otherTrip.id, target.id);

    // mcp_tokens.user_id (CASCADE): target has an MCP API token
    createMcpToken(testDb, target.id);

    // oauth_tokens/consents.user_id (CASCADE): target has tokens from otherUser's OAuth client
    testDb.prepare(
      "INSERT INTO oauth_clients (id, user_id, name, client_id, client_secret_hash) VALUES ('cl-admin-test', ?, 'App', 'cid-admin-test', 'h')"
    ).run(otherUser.id);
    testDb.prepare(
      "INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, refresh_token_hash, access_token_expires_at, refresh_token_expires_at) VALUES ('cid-admin-test', ?, 'ath-admin', 'rth-admin', datetime('now','+1 hour'), datetime('now','+30 days'))"
    ).run(target.id);
    testDb.prepare(
      "INSERT INTO oauth_consents (client_id, user_id) VALUES ('cid-admin-test', ?)"
    ).run(target.id);

    // vacay_plans.owner_id (CASCADE): target owns a vacation plan
    const vacayPlanRow = testDb.prepare("INSERT INTO vacay_plans (owner_id) VALUES (?)").run(target.id);

    // vacay_plan_members.user_id (CASCADE): target is a member of otherUser's vacay plan
    const otherVacayPlanRow = testDb.prepare("INSERT INTO vacay_plans (owner_id) VALUES (?)").run(otherUser.id);
    testDb.prepare("INSERT INTO vacay_plan_members (plan_id, user_id) VALUES (?, ?)").run(otherVacayPlanRow.lastInsertRowid, target.id);

    // bucket_list.user_id (CASCADE): target has a bucket list item
    createBucketListItem(testDb, target.id);

    // visited_countries.user_id (CASCADE): target has visited a country
    createVisitedCountry(testDb, target.id, 'JP');

    // visited_regions.user_id (CASCADE): target has visited a region
    testDb.prepare(
      "INSERT INTO visited_regions (user_id, region_code, region_name, country_code) VALUES (?, 'JP-13', 'Tokyo', 'JP')"
    ).run(target.id);

    // packing_templates.created_by (CASCADE): target created a packing template
    const packTemplateRow = testDb.prepare(
      "INSERT INTO packing_templates (name, created_by) VALUES ('My Template', ?)"
    ).run(target.id);

    // invite_tokens.created_by (CASCADE): target created an invite token
    createInviteToken(testDb, { created_by: target.id });

    // collab_notes.user_id (CASCADE): target authored a collab note on otherUser's trip
    createCollabNote(testDb, otherTrip.id, target.id);

    // settings.user_id (CASCADE): target has a user setting
    testDb.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'theme', 'dark')").run(target.id);

    // password_reset_tokens.user_id (CASCADE): target has a pending password reset
    testDb.prepare(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, 'prt-hash-admin', datetime('now','+1 hour'))"
    ).run(target.id);

    // audit_log.user_id (SET NULL): target performed an audited action
    const auditRow = testDb.prepare(
      "INSERT INTO audit_log (user_id, action, ip) VALUES (?, 'test.action', '127.0.0.1')"
    ).run(target.id);

    // notification_channel_preferences.user_id (CASCADE): target has notification preferences
    testDb.prepare("INSERT OR IGNORE INTO notification_channel_preferences (user_id, event_type, channel) VALUES (?, 'trip_invite', 'email')").run(target.id);

    const res = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(testDb.prepare('SELECT id FROM users WHERE id = ?').get(target.id)).toBeUndefined();
    // trip_members row survives but invited_by is now NULL
    expect((testDb.prepare('SELECT invited_by FROM trip_members WHERE trip_id = ? AND user_id = ?').get(otherTrip.id, thirdUser.id) as any).invited_by).toBeNull();
    expect(testDb.prepare('SELECT id FROM share_tokens WHERE created_by = ?').get(target.id)).toBeUndefined();
    expect((testDb.prepare('SELECT paid_by_user_id FROM budget_items WHERE id = ?').get(budgetItem.id) as any).paid_by_user_id).toBeNull();
    expect(testDb.prepare('SELECT user_id FROM journey_contributors WHERE journey_id = ? AND user_id = ?').get(otherJourney.id, target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM journey_entries WHERE author_id = ?').get(target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM journey_share_tokens WHERE created_by = ?').get(target.id)).toBeUndefined();
    // sent notification survives but sender_id becomes NULL
    expect((testDb.prepare('SELECT sender_id FROM notifications WHERE id = ?').get(sentNotif.lastInsertRowid) as any).sender_id).toBeNull();
    // received notification is cascade-deleted
    expect(testDb.prepare('SELECT id FROM notifications WHERE recipient_id = ?').get(target.id)).toBeUndefined();
    // notice dismissals are cascade-deleted
    expect(testDb.prepare("SELECT user_id FROM user_notice_dismissals WHERE user_id = ? AND notice_id = 'test-notice'").get(target.id)).toBeUndefined();
    // owned journey and its entries are cascade-deleted
    expect(testDb.prepare('SELECT id FROM journeys WHERE user_id = ?').get(target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM journey_entries WHERE journey_id = ?').get(ownedJourney.id)).toBeUndefined();
    // uploaded file survives but uploaded_by is now NULL
    expect((testDb.prepare('SELECT uploaded_by FROM trip_files WHERE id = ?').get(fileRow.lastInsertRowid) as any).uploaded_by).toBeNull();
    // trek_photos row survives but owner_id is now NULL
    expect((testDb.prepare('SELECT owner_id FROM trek_photos WHERE id = ?').get(trekPhotoRow.lastInsertRowid) as any).owner_id).toBeNull();
    // trip_photos row for target is cascade-deleted
    expect(testDb.prepare("SELECT id FROM trip_photos WHERE trip_id = ? AND user_id = ?").get(otherTrip.id, target.id)).toBeUndefined();
    // owned trip is cascade-deleted
    expect(testDb.prepare('SELECT id FROM trips WHERE id = ?').get(ownedTrip.id)).toBeUndefined();
    // trip membership on others' trips is removed
    expect(testDb.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(otherTrip.id, target.id)).toBeUndefined();
    // category survives but user_id is NULL
    expect((testDb.prepare('SELECT user_id FROM categories WHERE id = ?').get(userCategory.id) as any).user_id).toBeNull();
    // tag is deleted
    expect(testDb.prepare('SELECT id FROM tags WHERE id = ?').get(userTag.id)).toBeUndefined();
    // todo assigned_user_id is NULL
    expect((testDb.prepare('SELECT assigned_user_id FROM todo_items WHERE id = ?').get(todoItem.id) as any).assigned_user_id).toBeNull();
    // packing bag survives but user_id is NULL
    expect((testDb.prepare('SELECT user_id FROM packing_bags WHERE id = ?').get(packBagRow.lastInsertRowid) as any).user_id).toBeNull();
    // MCP tokens are deleted
    expect(testDb.prepare('SELECT id FROM mcp_tokens WHERE user_id = ?').get(target.id)).toBeUndefined();
    // OAuth tokens and consents are deleted
    expect(testDb.prepare('SELECT id FROM oauth_tokens WHERE user_id = ?').get(target.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM oauth_consents WHERE user_id = ?').get(target.id)).toBeUndefined();
    // owned vacay plan is deleted
    expect(testDb.prepare('SELECT id FROM vacay_plans WHERE id = ?').get(vacayPlanRow.lastInsertRowid)).toBeUndefined();
    // vacay plan membership on others' plans is removed
    expect(testDb.prepare('SELECT id FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(otherVacayPlanRow.lastInsertRowid, target.id)).toBeUndefined();
    // bucket list items are deleted
    expect(testDb.prepare('SELECT id FROM bucket_list WHERE user_id = ?').get(target.id)).toBeUndefined();
    // travel history is deleted
    expect(testDb.prepare('SELECT user_id FROM visited_countries WHERE user_id = ? AND country_code = ?').get(target.id, 'JP')).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM visited_regions WHERE user_id = ?').get(target.id)).toBeUndefined();
    // packing template is deleted
    expect(testDb.prepare('SELECT id FROM packing_templates WHERE id = ?').get(packTemplateRow.lastInsertRowid)).toBeUndefined();
    // invite tokens created by target are deleted
    expect(testDb.prepare('SELECT id FROM invite_tokens WHERE created_by = ?').get(target.id)).toBeUndefined();
    // collab content is deleted
    expect(testDb.prepare('SELECT id FROM collab_notes WHERE user_id = ? AND trip_id = ?').get(target.id, otherTrip.id)).toBeUndefined();
    // user settings are deleted
    expect(testDb.prepare("SELECT id FROM settings WHERE user_id = ?").get(target.id)).toBeUndefined();
    // password reset tokens are deleted
    expect(testDb.prepare('SELECT id FROM password_reset_tokens WHERE user_id = ?').get(target.id)).toBeUndefined();
    // audit log entry survives but user_id is NULL
    expect((testDb.prepare('SELECT user_id FROM audit_log WHERE id = ?').get(auditRow.lastInsertRowid) as any).user_id).toBeNull();
    // notification channel preferences are deleted
    expect(testDb.prepare("SELECT user_id FROM notification_channel_preferences WHERE user_id = ? AND event_type = 'trip_invite'").get(target.id)).toBeUndefined();
  });

  it('ADMIN-006 — admin cannot delete their own account', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .delete(`/api/admin/users/${admin.id}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// System stats
// ─────────────────────────────────────────────────────────────────────────────

describe('System stats', () => {
  it('ADMIN-007 — GET /admin/stats returns system statistics', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalUsers');
    expect(res.body).toHaveProperty('totalTrips');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────────────────────────────────────

describe('Permissions management', () => {
  it('ADMIN-008 — GET /admin/permissions returns permission config', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/permissions')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('permissions');
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('ADMIN-008 — PUT /admin/permissions updates permissions and change persists', async () => {
    const { user: admin } = createAdmin(testDb);

    // Change trip_create from its default ('everybody') to 'admin'
    const res = await request(app)
      .put('/api/admin/permissions')
      .set('Cookie', authCookie(admin.id))
      .send({ permissions: { trip_create: 'admin' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Re-fetch and verify the change persisted
    const getRes = await request(app)
      .get('/api/admin/permissions')
      .set('Cookie', authCookie(admin.id));
    expect(getRes.status).toBe(200);
    const tripCreatePerm = getRes.body.permissions.find((p: any) => p.key === 'trip_create');
    expect(tripCreatePerm).toBeDefined();
    expect(tripCreatePerm.level).toBe('admin');
  });

  it('ADMIN-008 — PUT /admin/permissions without object returns 400', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .put('/api/admin/permissions')
      .set('Cookie', authCookie(admin.id))
      .send({ permissions: null });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit log', () => {
  it('ADMIN-009 — GET /admin/audit-log returns log entries', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/audit-log')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Addon management
// ─────────────────────────────────────────────────────────────────────────────

describe('Addon management', () => {
  it('ADMIN-011 — PUT /admin/addons/:id disables an addon', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .put('/api/admin/addons/atlas')
      .set('Cookie', authCookie(admin.id))
      .send({ enabled: false });
    expect(res.status).toBe(200);
  });

  it('ADMIN-012 — PUT /admin/addons/:id re-enables an addon', async () => {
    const { user: admin } = createAdmin(testDb);

    await request(app)
      .put('/api/admin/addons/atlas')
      .set('Cookie', authCookie(admin.id))
      .send({ enabled: false });

    const res = await request(app)
      .put('/api/admin/addons/atlas')
      .set('Cookie', authCookie(admin.id))
      .send({ enabled: true });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invite tokens
// ─────────────────────────────────────────────────────────────────────────────

describe('Invite token management', () => {
  it('ADMIN-013 — POST /admin/invites creates an invite token', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/admin/invites')
      .set('Cookie', authCookie(admin.id))
      .send({ max_uses: 5 });
    expect(res.status).toBe(201);
    expect(res.body.invite.token).toBeDefined();
  });

  it('ADMIN-014 — DELETE /admin/invites/:id removes invite', async () => {
    const { user: admin } = createAdmin(testDb);
    const invite = createInviteToken(testDb, { created_by: admin.id });

    const res = await request(app)
      .delete(`/api/admin/invites/${invite.id}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Packing templates
// ─────────────────────────────────────────────────────────────────────────────

describe('Packing templates', () => {
  it('ADMIN-015 — POST /admin/packing-templates creates a template', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/admin/packing-templates')
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Beach Trip', description: 'Beach essentials' });
    expect(res.status).toBe(201);
    expect(res.body.template.name).toBe('Beach Trip');
  });

  it('ADMIN-016 — DELETE /admin/packing-templates/:id removes template', async () => {
    const { user: admin } = createAdmin(testDb);
    const create = await request(app)
      .post('/api/admin/packing-templates')
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Temp Template' });
    const templateId = create.body.template.id;

    const res = await request(app)
      .delete(`/api/admin/packing-templates/${templateId}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bag tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('Bag tracking', () => {
  it('ADMIN-017 — PUT /admin/bag-tracking toggles bag tracking', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .put('/api/admin/bag-tracking')
      .set('Cookie', authCookie(admin.id))
      .send({ enabled: true });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT rotation
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT rotation', () => {
  it('ADMIN-018 — POST /admin/rotate-jwt-secret rotates the JWT secret', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/admin/rotate-jwt-secret')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Packing template CRUD (full)
// ─────────────────────────────────────────────────────────────────────────────

describe('Packing template CRUD (full)', () => {
  async function makeTemplate(admin: any) {
    const res = await request(app)
      .post('/api/admin/packing-templates')
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Test Template' });
    return res.body.template;
  }

  it('ADMIN-019 — GET /admin/packing-templates/:id returns template', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);

    const res = await request(app)
      .get(`/api/admin/packing-templates/${template.id}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.template.id).toBe(template.id);
    expect(res.body.template.name).toBe('Test Template');
  });

  it('ADMIN-019b — GET /admin/packing-templates/:id returns 404 for missing', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/packing-templates/99999')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(404);
  });

  it('ADMIN-020 — PUT /admin/packing-templates/:id updates name', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);

    const res = await request(app)
      .put(`/api/admin/packing-templates/${template.id}`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('Updated Name');
  });

  it('ADMIN-021 — POST /admin/packing-templates/:id/categories adds a category', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);

    const res = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Clothing' });
    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe('Clothing');
  });

  it('ADMIN-021b — PUT /admin/packing-templates/:templateId/categories/:catId updates category', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);
    const catRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Clothing' });
    const catId = catRes.body.category.id;

    const res = await request(app)
      .put(`/api/admin/packing-templates/${template.id}/categories/${catId}`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Apparel' });
    expect(res.status).toBe(200);
    expect(res.body.category.name).toBe('Apparel');
  });

  it('ADMIN-021c — DELETE /admin/packing-templates/:templateId/categories/:catId removes category', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);
    const catRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Toiletries' });
    const catId = catRes.body.category.id;

    const res = await request(app)
      .delete(`/api/admin/packing-templates/${template.id}/categories/${catId}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('ADMIN-021d — POST .../categories/:catId/items adds an item to category', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);
    const catRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Clothing' });
    const catId = catRes.body.category.id;

    const res = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories/${catId}/items`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'T-Shirt' });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe('T-Shirt');
  });

  it('ADMIN-021e — PUT /admin/packing-templates/:templateId/items/:itemId updates item', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);
    const catRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Clothing' });
    const catId = catRes.body.category.id;
    const itemRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories/${catId}/items`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'T-Shirt' });
    const itemId = itemRes.body.item.id;

    const res = await request(app)
      .put(`/api/admin/packing-templates/${template.id}/items/${itemId}`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Polo Shirt' });
    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe('Polo Shirt');
  });

  it('ADMIN-021f — DELETE /admin/packing-templates/:templateId/items/:itemId removes item', async () => {
    const { user: admin } = createAdmin(testDb);
    const template = await makeTemplate(admin);
    const catRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'Clothing' });
    const catId = catRes.body.category.id;
    const itemRes = await request(app)
      .post(`/api/admin/packing-templates/${template.id}/categories/${catId}/items`)
      .set('Cookie', authCookie(admin.id))
      .send({ name: 'T-Shirt' });
    const itemId = itemRes.body.item.id;

    const res = await request(app)
      .delete(`/api/admin/packing-templates/${template.id}/items/${itemId}`)
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP token management
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP token management', () => {
  it('ADMIN-023 — GET /admin/mcp-tokens returns list', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/mcp-tokens')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
  });

  it('ADMIN-024 — DELETE /admin/mcp-tokens/:id returns 404 for missing token', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .delete('/api/admin/mcp-tokens/99999')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('OAuth sessions', () => {
  it('ADMIN-025 — GET /admin/oauth-sessions returns list', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/oauth-sessions')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it('ADMIN-026 — DELETE /admin/oauth-sessions/:id returns 404 for missing session', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .delete('/api/admin/oauth-sessions/99999')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OIDC settings
// ─────────────────────────────────────────────────────────────────────────────

describe('OIDC settings', () => {
  it('ADMIN-027 — GET /admin/oidc returns OIDC configuration', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/oidc')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
  });

  it('ADMIN-028 — PUT /admin/oidc updates OIDC settings', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .put('/api/admin/oidc')
      .set('Cookie', authCookie(admin.id))
      .send({ issuer: 'https://accounts.example.com', client_id: 'my-client', oidc_only: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Demo baseline
// ─────────────────────────────────────────────────────────────────────────────

describe('Demo baseline', () => {
  it('ADMIN-029 — POST /admin/save-demo-baseline returns 404 when DEMO_MODE is not set', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .post('/api/admin/save-demo-baseline')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitHub releases / version check
// ─────────────────────────────────────────────────────────────────────────────

describe('GitHub releases and version check', () => {
  it('ADMIN-030 — GET /admin/github-releases returns array (even if GitHub unreachable)', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/github-releases?per_page=5&page=1')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('ADMIN-031 — GET /admin/version-check returns version info', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/version-check')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('current');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional list routes
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin list routes', () => {
  it('ADMIN-032 — GET /admin/invites lists invites', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/invites')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invites)).toBe(true);
  });

  it('ADMIN-033 — GET /admin/bag-tracking returns bag tracking setting', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/bag-tracking')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
  });

  it('ADMIN-034 — GET /admin/packing-templates lists templates', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/packing-templates')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });

  it('ADMIN-035 — GET /admin/addons lists addons', async () => {
    const { user: admin } = createAdmin(testDb);

    const res = await request(app)
      .get('/api/admin/addons')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.addons)).toBe(true);
  });
});
