/**
 * Packing List integration tests.
 * Covers PACK-001 to PACK-014.
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
import { createUser, createTrip, createPackingItem, createPackingCategory, addTripMember } from '../helpers/factories';
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
// Create packing item
// ─────────────────────────────────────────────────────────────────────────────

describe('Create packing item', () => {
  it('PACK-001 — POST creates a packing item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Passport', category: 'Documents' });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe('Passport');
    expect(res.body.item.category).toBe('Documents');
    expect(res.body.item.checked).toBe(0);
  });

  it('PACK-001 — POST without name returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(user.id))
      .send({ category: 'Clothing' });
    expect(res.status).toBe(400);
  });

  it('PACK-014 — non-member cannot create packing item', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(other.id))
      .send({ name: 'Sunscreen' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List packing items
// ─────────────────────────────────────────────────────────────────────────────

describe('List packing items', () => {
  it('PACK-002 — GET /api/trips/:tripId/packing returns all items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createPackingItem(testDb, trip.id, { name: 'Toothbrush', category: 'Toiletries' });
    createPackingItem(testDb, trip.id, { name: 'Shirt', category: 'Clothing' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('PACK-002 — member can list packing items', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    createPackingItem(testDb, trip.id, { name: 'Jacket' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(member.id));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update packing item
// ─────────────────────────────────────────────────────────────────────────────

describe('Update packing item', () => {
  it('PACK-003 — PUT updates packing item (toggle checked)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createPackingItem(testDb, trip.id, { name: 'Camera' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/${item.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ checked: true });
    expect(res.status).toBe(200);
    expect(res.body.item.checked).toBe(1);
  });

  it('PACK-003 — PUT returns 404 for non-existent item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/99999`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete packing item
// ─────────────────────────────────────────────────────────────────────────────

describe('Delete packing item', () => {
  it('PACK-004 — DELETE removes packing item', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = createPackingItem(testDb, trip.id, { name: 'Sunglasses' });

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/packing/${item.id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.items).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk import
// ─────────────────────────────────────────────────────────────────────────────

describe('Bulk import packing items', () => {
  it('PACK-005 — POST /import creates multiple items at once', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/import`)
      .set('Cookie', authCookie(user.id))
      .send({
        items: [
          { name: 'Toothbrush', category: 'Toiletries' },
          { name: 'Shampoo', category: 'Toiletries' },
          { name: 'Socks', category: 'Clothing' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.count).toBe(3);
  });

  it('PACK-005 — POST /import with empty array returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/import`)
      .set('Cookie', authCookie(user.id))
      .send({ items: [] });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reorder
// ─────────────────────────────────────────────────────────────────────────────

describe('Reorder packing items', () => {
  it('PACK-006 — PUT /reorder reorders items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const i1 = createPackingItem(testDb, trip.id, { name: 'Item A' });
    const i2 = createPackingItem(testDb, trip.id, { name: 'Item B' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/reorder`)
      .set('Cookie', authCookie(user.id))
      .send({ orderedIds: [i2.id, i1.id] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = testDb
      .prepare('SELECT id, sort_order FROM packing_items WHERE trip_id = ? ORDER BY sort_order')
      .all(trip.id) as Array<{ id: number; sort_order: number }>;
    expect(rows[0].id).toBe(i2.id);
    expect(rows[1].id).toBe(i1.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bags
// ─────────────────────────────────────────────────────────────────────────────

describe('Bags', () => {
  it('PACK-008 — POST /bags creates a bag', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Carry-on', color: '#3b82f6' });
    expect(res.status).toBe(201);
    expect(res.body.bag.name).toBe('Carry-on');
  });

  it('PACK-008 — POST /bags without name returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ color: '#ff0000' });
    expect(res.status).toBe(400);
  });

  it('PACK-011 — GET /bags returns bags list', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Create a bag
    await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Main Bag' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.bags).toHaveLength(1);
  });

  it('PACK-009 — PUT /bags/:bagId updates bag', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Old Name' });
    const bagId = createRes.body.bag.id;

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/bags/${bagId}`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.bag.name).toBe('New Name');
  });

  it('PACK-010 — DELETE /bags/:bagId removes bag', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Temp Bag' });
    const bagId = createRes.body.bag.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/packing/bags/${bagId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Category assignees
// ─────────────────────────────────────────────────────────────────────────────

describe('Category assignees', () => {
  it('PACK-012 — PUT /category-assignees/:catId sets assignees on a shared category', async () => {
    const { user } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, member.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Clothing' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/category-assignees/${cat.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id, member.id] });
    expect(res.status).toBe(200);
    expect(res.body.assignees).toBeDefined();
    expect(res.body.assignees).toHaveLength(2);
  });

  it('PACK-012b — PUT /category-assignees/:catId on a personal category returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Mine', type: 'personal', ownerUserId: user.id });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/category-assignees/${cat.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id] });
    expect(res.status).toBe(400);
  });

  it('PACK-013 — GET /category-assignees returns all assignments keyed by category_id', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Electronics' });
    await request(app)
      .put(`/api/trips/${trip.id}/packing/category-assignees/${cat.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id] });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/packing/category-assignees`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.assignees).toBeDefined();
    expect(res.body.assignees[cat.id]).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Categories (shared/personal/private) and per-user check state
// ─────────────────────────────────────────────────────────────────────────────

describe('Packing categories', () => {
  it('PACK-016 — POST /categories creates a shared category', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/categories`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Tech', type: 'shared' });
    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe('Tech');
    expect(res.body.category.type).toBe('shared');
    expect(res.body.category.owner_user_id).toBeNull();
  });

  it('PACK-016b — POST /categories rejects unknown type', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/categories`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'X', type: 'global' });
    expect(res.status).toBe(400);
  });

  it('PACK-016c — duplicate shared category returns 409', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createPackingCategory(testDb, trip.id, { name: 'Dup' });
    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/categories`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Dup', type: 'shared' });
    expect(res.status).toBe(409);
  });

  it('PACK-017 — GET /categories hides other users\' private categories', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    createPackingCategory(testDb, trip.id, { name: 'Open', type: 'shared' });
    createPackingCategory(testDb, trip.id, { name: 'OwnerSecret', type: 'private', ownerUserId: owner.id });

    const ownerRes = await request(app)
      .get(`/api/trips/${trip.id}/packing/categories`)
      .set('Cookie', authCookie(owner.id));
    expect(ownerRes.body.categories.map((c: any) => c.name).sort()).toEqual(['Open', 'OwnerSecret']);

    const memberRes = await request(app)
      .get(`/api/trips/${trip.id}/packing/categories`)
      .set('Cookie', authCookie(member.id));
    expect(memberRes.body.categories.map((c: any) => c.name)).toEqual(['Open']);
  });

  it('PACK-018 — checking a personal item is per-user', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Mine', type: 'personal', ownerUserId: owner.id });
    const insertItem = testDb.prepare(
      'INSERT INTO packing_items (trip_id, name, category_id, checked) VALUES (?, ?, ?, 0)'
    ).run(trip.id, 'Toothbrush', cat.id);
    const itemId = Number(insertItem.lastInsertRowid);

    // Owner ticks it.
    const tick = await request(app)
      .put(`/api/trips/${trip.id}/packing/${itemId}`)
      .set('Cookie', authCookie(owner.id))
      .send({ checked: true });
    expect(tick.status).toBe(200);
    expect(tick.body.item.checked).toBe(1);

    // Member sees the same item as unchecked (per-user state).
    const memberList = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(member.id));
    const memberItem = memberList.body.items.find((i: any) => i.id === itemId);
    expect(memberItem?.checked).toBe(0);
  });

  it('PACK-019 — listing hides items in other users\' private categories', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Secret', type: 'private', ownerUserId: owner.id });
    testDb.prepare('INSERT INTO packing_items (trip_id, name, category_id, checked) VALUES (?, ?, ?, 0)')
      .run(trip.id, 'Hidden', cat.id);

    const memberList = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(member.id));
    expect(memberList.body.items.find((i: any) => i.name === 'Hidden')).toBeUndefined();

    const ownerList = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(owner.id));
    expect(ownerList.body.items.find((i: any) => i.name === 'Hidden')).toBeDefined();
  });

  it('PACK-020 — converting shared → personal carries the converting user\'s checked state', async () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Stuff' });
    // Insert a checked shared item.
    testDb.prepare(
      'INSERT INTO packing_items (trip_id, name, category_id, checked) VALUES (?, ?, ?, 1)'
    ).run(trip.id, 'Bag', cat.id);

    const res = await request(app)
      .patch(`/api/trips/${trip.id}/packing/categories/${cat.id}`)
      .set('Cookie', authCookie(owner.id))
      .send({ type: 'personal' });
    expect(res.status).toBe(200);
    expect(res.body.category.type).toBe('personal');
    expect(res.body.category.owner_user_id).toBe(owner.id);

    // The owner still sees it as checked through the per-user check row.
    const list = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(owner.id));
    expect(list.body.items[0].checked).toBe(1);
  });

  it('PACK-021 — DELETE /categories/:catId removes the category and its items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const cat = createPackingCategory(testDb, trip.id, { name: 'Tmp' });
    testDb.prepare('INSERT INTO packing_items (trip_id, name, category_id) VALUES (?, ?, ?)')
      .run(trip.id, 'Will be deleted', cat.id);

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/packing/categories/${cat.id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/packing`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.items).toHaveLength(0);
  });
});

describe('Packing — apply-template, bag members, save-as-template', () => {
  it('PACK-015 — POST /apply-template/:templateId applies template items to trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const tpl = testDb.prepare("INSERT INTO packing_templates (name, created_by) VALUES ('Beach', ?)").run(user.id);
    const cat = testDb.prepare("INSERT INTO packing_template_categories (template_id, name, sort_order) VALUES (?, 'Essentials', 0)").run(tpl.lastInsertRowid);
    testDb.prepare("INSERT INTO packing_template_items (category_id, name, sort_order) VALUES (?, 'Sunscreen', 0)").run(cat.lastInsertRowid);
    const templateId = tpl.lastInsertRowid;

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/apply-template/${templateId}`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.count).toBeGreaterThan(0);
  });

  it('PACK-015b — POST /apply-template/:id for empty template returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Template with no items
    const tpl = testDb.prepare("INSERT INTO packing_templates (name, created_by) VALUES ('Empty', ?)").run(user.id);
    const emptyTemplateId = tpl.lastInsertRowid;

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/apply-template/${emptyTemplateId}`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('PACK-016 — PUT /bags/:bagId/members sets bag members', async () => {
    const { user } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    addTripMember(testDb, trip.id, member.id);

    // Create a bag first
    const bagRes = await request(app)
      .post(`/api/trips/${trip.id}/packing/bags`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Carry-on' });
    expect(bagRes.status).toBe(201);
    const bagId = bagRes.body.bag.id;

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/bags/${bagId}/members`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id, member.id] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members.length).toBe(2);
  });

  it('PACK-016b — PUT /bags/:bagId/members for non-existent bag returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/packing/bags/999999/members`)
      .set('Cookie', authCookie(user.id))
      .send({ user_ids: [user.id] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('PACK-017 — POST /save-as-template saves packing list as a template', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Add an item so the trip has something to save
    createPackingItem(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/save-as-template`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'My Summer Template' });

    expect(res.status).toBe(201);
    expect(res.body.template).toBeDefined();
    expect(res.body.template.name).toBe('My Summer Template');
  });

  it('PACK-017b — POST /save-as-template without name returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/save-as-template`)
      .set('Cookie', authCookie(user.id))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('PACK-017c — POST /save-as-template when trip has no items returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/save-as-template`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Empty Trip Template' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('PACK-017e — apply-template recreates personal categories as personal owned by the applying user', async () => {
    const { user: author } = createUser(testDb);
    const { user: applier } = createUser(testDb);
    const sourceTrip = createTrip(testDb, author.id);
    const personalCat = createPackingCategory(testDb, sourceTrip.id, { name: 'Mine', type: 'personal', ownerUserId: author.id });
    const sharedCat = createPackingCategory(testDb, sourceTrip.id, { name: 'Common', type: 'shared' });
    testDb.prepare('INSERT INTO packing_items (trip_id, name, category_id) VALUES (?, ?, ?)').run(sourceTrip.id, 'Toothbrush', personalCat.id);
    testDb.prepare('INSERT INTO packing_items (trip_id, name, category_id) VALUES (?, ?, ?)').run(sourceTrip.id, 'Tent', sharedCat.id);

    // Author saves the template.
    const saveRes = await request(app)
      .post(`/api/trips/${sourceTrip.id}/packing/save-as-template`)
      .set('Cookie', authCookie(author.id))
      .send({ name: 'Round Trip' });
    expect(saveRes.status).toBe(201);
    const templateId = saveRes.body.template.id;

    // A different user applies it on a fresh trip.
    const targetTrip = createTrip(testDb, applier.id);
    const applyRes = await request(app)
      .post(`/api/trips/${targetTrip.id}/packing/apply-template/${templateId}`)
      .set('Cookie', authCookie(applier.id));
    expect(applyRes.status).toBe(200);

    // Toothbrush must land in a personal category owned by the applier.
    const cats = testDb.prepare('SELECT * FROM packing_categories WHERE trip_id = ? ORDER BY name').all(targetTrip.id) as any[];
    const mine = cats.find(c => c.name === 'Mine');
    const common = cats.find(c => c.name === 'Common');
    expect(mine).toBeDefined();
    expect(mine.type).toBe('personal');
    expect(mine.owner_user_id).toBe(applier.id);
    expect(common.type).toBe('shared');
    expect(common.owner_user_id).toBeNull();
  });

  it('PACK-017d — save-as-template includes shared + personal items but skips private', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const sharedCat = createPackingCategory(testDb, trip.id, { name: 'Shared', type: 'shared' });
    const personalCat = createPackingCategory(testDb, trip.id, { name: 'Mine', type: 'personal', ownerUserId: user.id });
    const privateCat = createPackingCategory(testDb, trip.id, { name: 'Secret', type: 'private', ownerUserId: user.id });
    const insertItem = testDb.prepare('INSERT INTO packing_items (trip_id, name, category_id) VALUES (?, ?, ?)');
    insertItem.run(trip.id, 'Tent', sharedCat.id);
    insertItem.run(trip.id, 'Toothbrush', personalCat.id);
    insertItem.run(trip.id, 'Diary', privateCat.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/packing/save-as-template`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Mixed Trip' });

    expect(res.status).toBe(201);
    // Walk the resulting template rows to confirm only shared+personal items landed.
    const templateId = res.body.template.id;
    const rows = testDb.prepare(`
      SELECT ti.name, tc.name AS category
      FROM packing_template_items ti
      JOIN packing_template_categories tc ON tc.id = ti.category_id
      WHERE tc.template_id = ?
    `).all(templateId) as Array<{ name: string; category: string }>;
    const names = rows.map(r => r.name).sort();
    expect(names).toEqual(['Tent', 'Toothbrush']);
    expect(names).not.toContain('Diary');
  });
});
