import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';

const router = express.Router({ mergeParams: true });

function verifyTripOwnership(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const items = db.prepare(
    'SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(tripId);

  res.json({ items });
});

// Bulk import packing items (must be before /:id)
router.post('/import', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { items } = req.body; // [{ name, category?, quantity? }]

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items must be a non-empty array' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  let sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const stmt = db.prepare('INSERT INTO packing_items (trip_id, name, checked, category, weight_grams, bag_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const created: any[] = [];
  const insertAll = db.transaction(() => {
    for (const item of items) {
      if (!item.name?.trim()) continue;
      const checked = item.checked ? 1 : 0;
      const weight = item.weight_grams ? parseInt(item.weight_grams) || null : null;
      // Resolve bag by name if provided
      let bagId = null;
      if (item.bag?.trim()) {
        const bagName = item.bag.trim();
        const existing = db.prepare('SELECT id FROM packing_bags WHERE trip_id = ? AND name = ?').get(tripId, bagName) as { id: number } | undefined;
        if (existing) {
          bagId = existing.id;
        } else {
          const BAG_COLORS = ['#6366f1', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#f59e0b'];
          const bagCount = (db.prepare('SELECT COUNT(*) as c FROM packing_bags WHERE trip_id = ?').get(tripId) as { c: number }).c;
          const newBag = db.prepare('INSERT INTO packing_bags (trip_id, name, color) VALUES (?, ?, ?)').run(tripId, bagName, BAG_COLORS[bagCount % BAG_COLORS.length]);
          bagId = newBag.lastInsertRowid;
        }
      }
      const result = stmt.run(tripId, item.name.trim(), checked, item.category?.trim() || 'Other', weight, bagId, sortOrder++);
      created.push(db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid));
    }
  });
  insertAll();

  res.status(201).json({ items: created, count: created.length });
  for (const item of created) {
    broadcast(tripId, 'packing:created', { item }, req.headers['x-socket-id'] as string);
  }
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, category, checked } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!name) return res.status(400).json({ error: 'Item name is required' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    'INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(tripId, name, checked ? 1 : 0, category || 'Allgemein', sortOrder);

  const item = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ item });
  broadcast(tripId, 'packing:created', { item }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { name, checked, category, weight_grams, bag_id } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const item = db.prepare('SELECT * FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  db.prepare(`
    UPDATE packing_items SET
      name = COALESCE(?, name),
      checked = CASE WHEN ? IS NOT NULL THEN ? ELSE checked END,
      category = COALESCE(?, category),
      weight_grams = CASE WHEN ? THEN ? ELSE weight_grams END,
      bag_id = CASE WHEN ? THEN ? ELSE bag_id END
    WHERE id = ?
  `).run(
    name || null,
    checked !== undefined ? 1 : null,
    checked ? 1 : 0,
    category || null,
    'weight_grams' in req.body ? 1 : 0,
    weight_grams ?? null,
    'bag_id' in req.body ? 1 : 0,
    bag_id ?? null,
    id
  );

  const updated = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(id);
  res.json({ item: updated });
  broadcast(tripId, 'packing:updated', { item: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const item = db.prepare('SELECT id FROM packing_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  db.prepare('DELETE FROM packing_items WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'packing:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
});

// ── Bags CRUD ───────────────────────────────────────────────────────────────

router.get('/bags', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const bags = db.prepare('SELECT * FROM packing_bags WHERE trip_id = ? ORDER BY sort_order, id').all(tripId);
  res.json({ bags });
});

router.post('/bags', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, color } = req.body;
  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_bags WHERE trip_id = ?').get(tripId) as { max: number | null };
  const result = db.prepare('INSERT INTO packing_bags (trip_id, name, color, sort_order) VALUES (?, ?, ?, ?)').run(tripId, name.trim(), color || '#6366f1', (maxOrder.max ?? -1) + 1);
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ bag });
  broadcast(tripId, 'packing:bag-created', { bag }, req.headers['x-socket-id'] as string);
});

router.put('/bags/:bagId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, bagId } = req.params;
  const { name, color, weight_limit_grams } = req.body;
  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
  if (!bag) return res.status(404).json({ error: 'Bag not found' });
  db.prepare('UPDATE packing_bags SET name = COALESCE(?, name), color = COALESCE(?, color), weight_limit_grams = ? WHERE id = ?').run(name?.trim() || null, color || null, weight_limit_grams ?? null, bagId);
  const updated = db.prepare('SELECT * FROM packing_bags WHERE id = ?').get(bagId);
  res.json({ bag: updated });
  broadcast(tripId, 'packing:bag-updated', { bag: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/bags/:bagId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, bagId } = req.params;
  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const bag = db.prepare('SELECT * FROM packing_bags WHERE id = ? AND trip_id = ?').get(bagId, tripId);
  if (!bag) return res.status(404).json({ error: 'Bag not found' });
  db.prepare('DELETE FROM packing_bags WHERE id = ?').run(bagId);
  res.json({ success: true });
  broadcast(tripId, 'packing:bag-deleted', { bagId: Number(bagId) }, req.headers['x-socket-id'] as string);
});

// ── Apply template ──────────────────────────────────────────────────────────

router.post('/apply-template/:templateId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, templateId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const templateItems = db.prepare(`
    SELECT ti.name, tc.name as category
    FROM packing_template_items ti
    JOIN packing_template_categories tc ON ti.category_id = tc.id
    WHERE tc.template_id = ?
    ORDER BY tc.sort_order, ti.sort_order
  `).all(templateId) as { name: string; category: string }[];
  if (templateItems.length === 0) return res.status(404).json({ error: 'Template not found or empty' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM packing_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  let sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const insert = db.prepare('INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, 0, ?, ?)');
  const added: any[] = [];
  for (const ti of templateItems) {
    const result = insert.run(tripId, ti.name, ti.category, sortOrder++);
    const item = db.prepare('SELECT * FROM packing_items WHERE id = ?').get(result.lastInsertRowid);
    added.push(item);
  }

  res.json({ items: added, count: added.length });
  broadcast(tripId, 'packing:template-applied', { items: added }, req.headers['x-socket-id'] as string);
});

// ── Category assignees ──────────────────────────────────────────────────────

router.get('/category-assignees', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const rows = db.prepare(`
    SELECT pca.category_name, pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    WHERE pca.trip_id = ?
  `).all(tripId);

  // Group by category
  const assignees: Record<string, { user_id: number; username: string; avatar: string | null }[]> = {};
  for (const row of rows as any[]) {
    if (!assignees[row.category_name]) assignees[row.category_name] = [];
    assignees[row.category_name].push({ user_id: row.user_id, username: row.username, avatar: row.avatar });
  }

  res.json({ assignees });
});

router.put('/category-assignees/:categoryName', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, categoryName } = req.params;
  const { user_ids } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const cat = decodeURIComponent(categoryName);
  db.prepare('DELETE FROM packing_category_assignees WHERE trip_id = ? AND category_name = ?').run(tripId, cat);

  if (Array.isArray(user_ids) && user_ids.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO packing_category_assignees (trip_id, category_name, user_id) VALUES (?, ?, ?)');
    for (const uid of user_ids) insert.run(tripId, cat, uid);
  }

  const rows = db.prepare(`
    SELECT pca.user_id, u.username, u.avatar
    FROM packing_category_assignees pca
    JOIN users u ON pca.user_id = u.id
    WHERE pca.trip_id = ? AND pca.category_name = ?
  `).all(tripId, cat);

  res.json({ assignees: rows });
  broadcast(tripId, 'packing:assignees', { category: cat, assignees: rows }, req.headers['x-socket-id'] as string);

  // Notify newly assigned users
  if (Array.isArray(user_ids) && user_ids.length > 0) {
    import('../services/notifications').then(({ notify }) => {
      const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
      for (const uid of user_ids) {
        if (uid !== authReq.user.id) {
          notify({ userId: uid, event: 'packing_tagged', params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, category: cat } }).catch(() => {});
        }
      }
    });
  }
});

router.put('/reorder', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { orderedIds } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const update = db.prepare('UPDATE packing_items SET sort_order = ? WHERE id = ? AND trip_id = ?');
  const updateMany = db.transaction((ids: number[]) => {
    ids.forEach((id, index) => {
      update.run(index, id, tripId);
    });
  });

  updateMany(orderedIds);
  res.json({ success: true });
});

export default router;
