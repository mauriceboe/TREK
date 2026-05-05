import { db, canAccessTrip } from '../db/database';
import { avatarUrl } from './authService';

const BAG_COLORS = ['#6366f1', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#f59e0b'];

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

// ── Categories ─────────────────────────────────────────────────────────────

function getOrCreateSharedCategory(tripId: string | number, name: string): number {
  const existing = db.prepare(
    `SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'shared'`
  ).get(tripId, name) as { id: number } | undefined;
  if (existing) return existing.id;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_categories WHERE trip_id = ?').get(tripId) as { max: number | null };
  const result = db.prepare(
    `INSERT INTO packing_categories (trip_id, name, type, owner_user_id, sort_order) VALUES (?, ?, 'shared', NULL, ?)`
  ).run(tripId, name, (maxOrder.max ?? -1) + 1);
  return result.lastInsertRowid as number;
}

export function listCategories(tripId: string | number, userId: number) {
  return db.prepare(`
    SELECT * FROM packing_categories
    WHERE trip_id = ? AND (type != 'private' OR owner_user_id = ?)
    ORDER BY sort_order, id
  `).all(tripId, userId);
}

export function createCategory(tripId: string | number, userId: number, data: { name: string; type: 'shared' | 'personal' | 'private' }) {
  const ownerUserId = data.type === 'shared' ? null : userId;
  const name = data.name.trim();

  const existing = data.type === 'shared'
    ? db.prepare(`SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'shared'`).get(tripId, name)
    : db.prepare(`SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = ? AND owner_user_id = ?`).get(tripId, name, data.type, ownerUserId);
  if (existing) return { error: 'duplicate' };

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_categories WHERE trip_id = ?').get(tripId) as { max: number | null };
  const result = db.prepare(
    `INSERT INTO packing_categories (trip_id, name, type, owner_user_id, sort_order) VALUES (?, ?, ?, ?, ?)`
  ).run(tripId, name, data.type, ownerUserId, (maxOrder.max ?? -1) + 1);
  return db.prepare('SELECT * FROM packing_categories WHERE id = ?').get(result.lastInsertRowid);
}

export function updateCategory(
  tripId: string | number,
  catId: string | number,
  userId: number,
  data: { name?: string; type?: 'shared' | 'personal' | 'private' }
) {
  const cat = db.prepare('SELECT * FROM packing_categories WHERE id = ? AND trip_id = ?').get(catId, tripId) as any;
  if (!cat) return null;
  if (cat.type !== 'shared' && cat.owner_user_id !== userId) return null;

  const newType = data.type ?? cat.type;
  const newOwner = newType === 'shared' ? null : (cat.owner_user_id ?? userId);

  if (data.type && data.type !== cat.type) {
    if (cat.type === 'shared' && data.type !== 'shared') {
      // Carry the global checked state into the converting user's per-user row, then reset for others.
      const checkedItems = db.prepare('SELECT id FROM packing_items WHERE category_id = ? AND checked = 1').all(catId) as { id: number }[];
      const ins = db.prepare('INSERT OR IGNORE INTO packing_item_checks (item_id, user_id) VALUES (?, ?)');
      for (const item of checkedItems) ins.run(item.id, userId);
      db.prepare('UPDATE packing_items SET checked = 0 WHERE category_id = ?').run(catId);
    } else if (cat.type !== 'shared' && data.type === 'shared') {
      // No fair way to collapse N users' check states into one flag; discard.
      db.prepare('DELETE FROM packing_item_checks WHERE item_id IN (SELECT id FROM packing_items WHERE category_id = ?)').run(catId);
    }
  }

  db.prepare('UPDATE packing_categories SET name = COALESCE(?, name), type = ?, owner_user_id = ? WHERE id = ?')
    .run(data.name?.trim() || null, newType, newOwner, catId);
  return db.prepare('SELECT * FROM packing_categories WHERE id = ?').get(catId);
}

export function deleteCategory(tripId: string | number, catId: string | number, userId: number) {
  const cat = db.prepare('SELECT * FROM packing_categories WHERE id = ? AND trip_id = ?').get(catId, tripId) as any;
  if (!cat) return false;
  if (cat.type !== 'shared' && cat.owner_user_id !== userId) return false;
  db.prepare('DELETE FROM packing_items WHERE category_id = ?').run(catId);
  db.prepare('DELETE FROM packing_categories WHERE id = ?').run(catId);
  return true;
}

// Returns the category type for an item, or null if the item or category
// doesn't exist. Used by routes to decide broadcast scope.
export function getItemCategoryType(itemId: string | number): 'shared' | 'personal' | 'private' | null {
  const row = db.prepare(`
    SELECT c.type FROM packing_items i
    LEFT JOIN packing_categories c ON c.id = i.category_id
    WHERE i.id = ?
  `).get(itemId) as { type: string | null } | undefined;
  if (!row) return null;
  return (row.type as any) ?? 'shared';
}

// ── Items ──────────────────────────────────────────────────────────────────

const ITEM_SELECT = `
  i.id, i.trip_id, i.name, i.sort_order, i.created_at,
  i.weight_grams, i.bag_id, i.quantity, i.category_id,
  c.name AS category,
  c.type AS category_type,
  c.owner_user_id AS category_owner_id`;

export function listItems(tripId: string | number, userId: number) {
  return db.prepare(`
    SELECT ${ITEM_SELECT},
      CASE
        WHEN c.type IS NULL OR c.type = 'shared' THEN i.checked
        ELSE (SELECT COUNT(*) FROM packing_item_checks WHERE item_id = i.id AND user_id = ?)
      END AS checked
    FROM packing_items i
    LEFT JOIN packing_categories c ON c.id = i.category_id
    WHERE i.trip_id = ?
      AND (c.id IS NULL OR c.type != 'private' OR c.owner_user_id = ?)
    ORDER BY COALESCE(c.sort_order, 999) ASC, i.sort_order ASC, i.created_at ASC
  `).all(userId, tripId, userId);
}

function getItemForUser(itemId: string | number, userId: number) {
  return db.prepare(`
    SELECT ${ITEM_SELECT},
      CASE WHEN c.type IS NULL OR c.type = 'shared' THEN i.checked
           ELSE (SELECT COUNT(*) FROM packing_item_checks WHERE item_id = i.id AND user_id = ?) END AS checked
    FROM packing_items i LEFT JOIN packing_categories c ON c.id = i.category_id
    WHERE i.id = ?
  `).get(userId, itemId);
}

export function createItem(
  tripId: string | number,
  data: { name: string; category_id?: number | null; category?: string; checked?: boolean; quantity?: number },
  userId?: number
) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;
  const qty = Math.max(1, Math.min(999, Number(data.quantity) || 1));

  let catId: number | null = data.category_id ?? null;
  if (!catId) {
    catId = getOrCreateSharedCategory(tripId, data.category || 'General');
  }

  const result = db.prepare(
    'INSERT INTO packing_items (trip_id, name, checked, category_id, sort_order, quantity) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tripId, data.name, data.checked ? 1 : 0, catId, sortOrder, qty);

  return getItemForUser(result.lastInsertRowid as number, userId ?? 0);
}

export function updateItem(
  tripId: string | number,
  id: string | number,
  data: { name?: string; category_id?: number | null; weight_grams?: number | null; bag_id?: number | null; quantity?: number },
  bodyKeys: string[],
  userId?: number
) {
  const item = db.prepare('SELECT * FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return null;

  db.prepare(`
    UPDATE packing_items SET
      name = COALESCE(?, name),
      category_id = CASE WHEN ? THEN ? ELSE category_id END,
      weight_grams = CASE WHEN ? THEN ? ELSE weight_grams END,
      bag_id = CASE WHEN ? THEN ? ELSE bag_id END,
      quantity = CASE WHEN ? THEN ? ELSE quantity END
    WHERE id = ?
  `).run(
    data.name || null,
    bodyKeys.includes('category_id') ? 1 : 0,
    data.category_id ?? null,
    bodyKeys.includes('weight_grams') ? 1 : 0,
    data.weight_grams ?? null,
    bodyKeys.includes('bag_id') ? 1 : 0,
    data.bag_id ?? null,
    bodyKeys.includes('quantity') ? 1 : 0,
    data.quantity ? Math.max(1, Math.min(999, Number(data.quantity))) : 1,
    id
  );

  return getItemForUser(id, userId ?? 0);
}

export function toggleCheck(tripId: string | number, itemId: string | number, userId: number, checked: boolean) {
  const row = db.prepare(`
    SELECT i.id, c.type AS category_type
    FROM packing_items i
    LEFT JOIN packing_categories c ON c.id = i.category_id
    WHERE i.id = ? AND i.trip_id = ?
  `).get(itemId, tripId) as { id: number; category_type: string | null } | undefined;
  if (!row) return null;

  if (!row.category_type || row.category_type === 'shared') {
    db.prepare('UPDATE packing_items SET checked = ? WHERE id = ?').run(checked ? 1 : 0, itemId);
  } else {
    if (checked) {
      db.prepare('INSERT OR IGNORE INTO packing_item_checks (item_id, user_id) VALUES (?, ?)').run(itemId, userId);
    } else {
      db.prepare('DELETE FROM packing_item_checks WHERE item_id = ? AND user_id = ?').run(itemId, userId);
    }
  }

  return getItemForUser(itemId, userId);
}

export function deleteItem(tripId: string | number, id: string | number) {
  const item = db.prepare('SELECT id FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return false;
  db.prepare('DELETE FROM packing_items WHERE id = ?').run(id);
  return true;
}

// ── Bulk Import ────────────────────────────────────────────────────────────

interface ImportItem {
  name?: string;
  checked?: boolean;
  category?: string;
  weight_grams?: string | number;
  bag?: string;
}

export function bulkImport(tripId: string | number, items: ImportItem[], userId?: number) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  let sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const stmt = db.prepare('INSERT INTO packing_items (trip_id, name, checked, category_id, weight_grams, bag_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const created: any[] = [];

  const insertAll = db.transaction(() => {
    for (const item of items) {
      if (!item.name?.trim()) continue;
      const checked = item.checked ? 1 : 0;
      const weight = item.weight_grams ? parseInt(String(item.weight_grams)) || null : null;
      const catId = getOrCreateSharedCategory(tripId, item.category?.trim() || 'Other');

      let bagId = null;
      if (item.bag?.trim()) {
        const bagName = item.bag.trim();
        const existing = db.prepare('SELECT id FROM packing_bags WHERE trip_id = ? AND name = ?').get(tripId, bagName) as { id: number } | undefined;
        if (existing) {
          bagId = existing.id;
        } else {
          const bagCount = (db.prepare('SELECT COUNT(*) as c FROM packing_bags WHERE trip_id = ?').get(tripId) as { c: number }).c;
          const newBag = db.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(tripId, bagName, BAG_COLORS[bagCount % BAG_COLORS.length]);
          bagId = newBag.lastInsertRowid;
        }
      }

      const result = stmt.run(tripId, item.name.trim(), checked, catId, weight, bagId, sortOrder++);
      created.push(getItemForUser(result.lastInsertRowid as number, userId ?? 0));
    }
  });

  insertAll();
  return created;
}

// ── Bags ───────────────────────────────────────────────────────────────────

export function listBags(tripId: string | number) {
  const bags = db.prepare('SELECT * FROM packing_bags WHERE trip_id = ? ORDER BY sort_order, id').all(tripId) as any[];
  const members = db.prepare(`
    SELECT bm.bag_id, bm.user_id, u.username, u.avatar
    FROM packing_bag_members bm
    JOIN users u ON bm.user_id = u.id
    JOIN packing_bags b ON bm.bag_id = b.id
    WHERE b.trip_id = ?
  `).all(tripId) as { bag_id: number; user_id: number; username: string; avatar: string | null }[];
  const membersByBag = new Map<number, typeof members>();
  for (const m of members) {
    if (!membersByBag.has(m.bag_id)) membersByBag.set(m.bag_id, []);
    membersByBag.get(m.bag_id)!.push(m);
  }
  return bags.map(b => ({
    ...b,
    members: (membersByBag.get(b.id) || []).map(m => ({ ...m, avatar: avatarUrl(m) })),
  }));
}

export function setBagMembers(tripId: string | number, bagId: string | number, userIds: number[]) {
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
  if (!bag) return null;
  db.prepare('DELETE FROM packing_bag_members WHERE bag_id = ?').run(bagId);
  const ins = db.prepare('INSERT OR IGNORE INTO packing_bag_members (bag_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(bagId, uid);
  const rows = db.prepare(`
    SELECT bm.user_id, u.username, u.avatar
    FROM packing_bag_members bm JOIN users u ON bm.user_id = u.id
    WHERE bm.bag_id = ?
  `).all(bagId) as { user_id: number; username: string; avatar: string | null }[];
  return rows.map(m => ({ ...m, avatar: avatarUrl(m) }));
}

export function createBag(tripId: string | number, data: { name: string; color?: string }) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_bags WHERE trip_id = ?').get(tripId) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_bags (trip_id, name, color, sort_order) VALUES (?, ?, ?, ?)').run(
    tripId, data.name.trim(), data.color || '#6366f1', (maxOrder.max ?? -1) + 1
  );
  return db.prepare('SELECT * FROM packing_bags WHERE id = ?').get(result.lastInsertRowid);
}

export function updateBag(
  tripId: string | number,
  bagId: string | number,
  data: { name?: string; color?: string; weight_limit_grams?: number | null; user_id?: number | null },
  bodyKeys?: string[]
) {
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
  if (!bag) return null;

  db.prepare(`UPDATE packing_bags SET
    name = COALESCE(?, name),
    color = COALESCE(?, color),
    weight_limit_grams = ?,
    user_id = CASE WHEN ? THEN ? ELSE user_id END
    WHERE id = ?`).run(
    data.name?.trim() || null,
    data.color || null,
    data.weight_limit_grams ?? (bag as any).weight_limit_grams ?? null,
    bodyKeys?.includes('user_id') ? 1 : 0,
    data.user_id ?? null,
    bagId
  );
  return db.prepare('SELECT b.*, u.username as assigned_username FROM packing_bags b LEFT JOIN users u ON b.user_id = u.id WHERE b.id = ?').get(bagId);
}

export function deleteBag(tripId: string | number, bagId: string | number) {
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
  if (!bag) return false;
  db.prepare('DELETE FROM packing_bags WHERE id = ?').run(bagId);
  return true;
}

// ── Apply Template ─────────────────────────────────────────────────────────

export function applyTemplate(tripId: string | number, templateId: string | number, userId?: number) {
  const templateItems = db.prepare(`
    SELECT ti.name, tc.id AS template_category_id, tc.name AS category, tc.type AS category_type
    FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ?
    ORDER BY tc.sort_order, ti.sort_order
  `).all(templateId) as { name: string; template_category_id: number; category: string; category_type: string }[];

  if (templateItems.length === 0) return null;

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  let sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  // template_category_id → trip category id; personal is owned by the applying user.
  const catCache = new Map<number, number>();
  const resolveCategory = (tc: { template_category_id: number; category: string; category_type: string }): number => {
    const cached = catCache.get(tc.template_category_id);
    if (cached !== undefined) return cached;
    let catId: number;
    if (tc.category_type === 'personal' && userId) {
      const ownerUserId = userId;
      const existing = db.prepare(
        `SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'personal' AND owner_user_id = ?`
      ).get(tripId, tc.category, ownerUserId) as { id: number } | undefined;
      if (existing) {
        catId = existing.id;
      } else {
        const maxCatOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_categories WHERE trip_id = ?').get(tripId) as { max: number | null };
        const r = db.prepare(
          `INSERT INTO packing_categories (trip_id, name, type, owner_user_id, sort_order) VALUES (?, ?, 'personal', ?, ?)`
        ).run(tripId, tc.category, ownerUserId, (maxCatOrder.max ?? -1) + 1);
        catId = r.lastInsertRowid as number;
      }
    } else {
      catId = getOrCreateSharedCategory(tripId, tc.category);
    }
    catCache.set(tc.template_category_id, catId);
    return catId;
  };

  const insert = db.prepare('INSERT INTO packing_items (trip_id, name, checked, category_id, sort_order) VALUES (?, ?, 0, ?, ?)');
  const added: any[] = [];
  for (const ti of templateItems) {
    const catId = resolveCategory(ti);
    const result = insert.run(tripId, ti.name, catId, sortOrder++);
    added.push(getItemForUser(result.lastInsertRowid as number, userId ?? 0));
  }

  return added;
}

// ── Save as Template ──────────────────────────────────────────────────────

export function saveAsTemplate(tripId: string | number, userId: number, templateName: string) {
  // Capture type so applyTemplate can recreate personal categories as personal. Private is never templated.
  const items = db.prepare(`
    SELECT i.name, COALESCE(c.name, 'Other') AS category, COALESCE(c.type, 'shared') AS category_type
    FROM packing_items i
    LEFT JOIN packing_categories c ON c.id = i.category_id
    WHERE i.trip_id = ? AND (c.type IS NULL OR c.type != 'private')
    ORDER BY i.sort_order ASC
  `).all(tripId) as { name: string; category: string; category_type: string }[];

  if (items.length === 0) return null;

  const result = db.prepare('INSERT INTO packing_templates (name, created_by) VALUES (?, ?)').run(templateName, userId);
  const templateId = result.lastInsertRowid;

  // (name + type) — same name across types stays distinct.
  const groupKey = (i: { category: string; category_type: string }) => `${i.category_type}|${i.category}`;
  const seen = new Set<string>();
  const ordered: { category: string; category_type: string }[] = [];
  for (const it of items) {
    const k = groupKey(it);
    if (!seen.has(k)) { seen.add(k); ordered.push({ category: it.category, category_type: it.category_type }); }
  }

  const catIdMap = new Map<string, number | bigint>();
  for (let i = 0; i < ordered.length; i++) {
    const { category, category_type } = ordered[i];
    const catResult = db.prepare('INSERT INTO packing_template_categories (template_id, name, type, sort_order) VALUES (?, ?, ?, ?)')
      .run(templateId, category, category_type, i);
    catIdMap.set(groupKey(ordered[i]), catResult.lastInsertRowid);
  }

  const itemsByCategory = new Map<string, number>();
  for (const item of items) {
    const k = groupKey(item);
    const catId = catIdMap.get(k)!;
    const order = itemsByCategory.get(k) || 0;
    db.prepare('INSERT INTO packing_template_items (category_id, name, sort_order) VALUES (?, ?, ?)').run(catId, item.name, order);
    itemsByCategory.set(k, order + 1);
  }

  return { id: Number(templateId), name: templateName, categoryCount: ordered.length, itemCount: items.length };
}

// ── Category Assignees ─────────────────────────────────────────────────────

export function getCategoryAssignees(tripId: string | number) {
  const rows = db.prepare(`
    SELECT pca.category_id, pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    JOIN packing_categories c ON c.id = pca.category_id
    WHERE pca.trip_id = ? AND c.type = 'shared'
  `).all(tripId);

  const assignees: Record<number, { user_id: number; username: string; avatar: string | null }[]> = {};
  for (const row of rows as any[]) {
    if (!assignees[row.category_id]) assignees[row.category_id] = [];
    assignees[row.category_id].push({ user_id: row.user_id, username: row.username, avatar: avatarUrl(row) });
  }

  return assignees;
}

export function updateCategoryAssignees(tripId: string | number, categoryId: string | number, userIds: number[] | undefined) {
  // Only allow assignees on shared categories — personal/private are by definition single-user.
  const cat = db.prepare(`SELECT id, type FROM packing_categories WHERE id = ? AND trip_id = ?`).get(categoryId, tripId) as { id: number; type: string } | undefined;
  if (!cat || cat.type !== 'shared') return null;

  db.prepare('DELETE FROM packing_category_assignees WHERE category_id = ?').run(categoryId);

  if (Array.isArray(userIds) && userIds.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO packing_category_assignees (trip_id, category_id, user_id) VALUES (?, ?, ?)');
    for (const uid of userIds) insert.run(tripId, categoryId, uid);
  }

  const updated = db.prepare(`
    SELECT pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    WHERE pca.category_id = ?
  `).all(categoryId) as { user_id: number; username: string; avatar: string | null }[];
  return updated.map(m => ({ ...m, avatar: avatarUrl(m) }));
}

// ── Reorder ────────────────────────────────────────────────────────────────

export function reorderItems(tripId: string | number, orderedIds: number[]) {
  const update = db.prepare('UPDATE packing_items SET sort_order = ? WHERE id = ? AND trip_id = ?');
  const updateMany = db.transaction((ids: number[]) => {
    ids.forEach((id, index) => {
      update.run(index, id, tripId);
    });
  });
  updateMany(orderedIds);
}
