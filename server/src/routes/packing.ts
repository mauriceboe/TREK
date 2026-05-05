import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast, broadcastToUser } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import {
  verifyTripAccess,
  listItems,
  createItem,
  updateItem,
  toggleCheck,
  deleteItem,
  bulkImport,
  listBags,
  createBag,
  updateBag,
  deleteBag,
  applyTemplate,
  saveAsTemplate,
  setBagMembers,
  getCategoryAssignees,
  updateCategoryAssignees,
  reorderItems,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getItemCategoryType,
} from '../services/packingService';

const router = express.Router({ mergeParams: true });

// Trip-wide for shared, actor-only for personal/private.
function broadcastForCategory(
  tripId: string | number,
  categoryType: 'shared' | 'personal' | 'private' | null,
  eventType: string,
  payload: Record<string, unknown>,
  actorUserId: number,
  socketId?: string,
) {
  if (!categoryType || categoryType === 'shared') {
    broadcast(tripId, eventType, payload, socketId);
  } else {
    broadcastToUser(actorUserId, { type: eventType, tripId: Number(tripId), ...payload }, socketId);
  }
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const items = listItems(tripId, authReq.user.id);
  res.json({ items });
});

// Bulk import packing items (must be before /:id)
router.post('/import', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { items } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items must be a non-empty array' });

  const created = bulkImport(tripId, items, authReq.user.id);

  res.status(201).json({ items: created, count: created.length });
  for (const item of created) {
    broadcast(tripId, 'packing:created', { item }, req.headers['x-socket-id'] as string);
  }
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, category, category_id, checked } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!name) return res.status(400).json({ error: 'Item name is required' });

  const item = createItem(tripId, { name, category, category_id, checked }, authReq.user.id);
  res.status(201).json({ item });
  broadcastForCategory(
    tripId,
    (item as any)?.category_type ?? null,
    'packing:created',
    { item },
    authReq.user.id,
    req.headers['x-socket-id'] as string,
  );
});

router.put('/reorder', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { orderedIds } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  reorderItems(tripId, orderedIds);
  res.json({ success: true });
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { name, checked, category_id, weight_grams, bag_id, quantity } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  // Solo `checked` routes through the per-user check path.
  if (checked !== undefined && Object.keys(req.body).length === 1) {
    const updated = toggleCheck(tripId, id, authReq.user.id, !!checked);
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: updated });
    broadcastForCategory(
      tripId,
      (updated as any)?.category_type ?? null,
      'packing:updated',
      { item: updated },
      authReq.user.id,
      req.headers['x-socket-id'] as string,
    );
    return;
  }

  const updated = updateItem(tripId, id, { name, category_id, weight_grams, bag_id, quantity }, Object.keys(req.body), authReq.user.id);
  if (!updated) return res.status(404).json({ error: 'Item not found' });

  if (checked !== undefined) {
    toggleCheck(tripId, id, authReq.user.id, !!checked);
    const fresh = listItems(tripId, authReq.user.id).find((i: any) => i.id === Number(id));
    res.json({ item: fresh ?? updated });
    broadcastForCategory(
      tripId,
      ((fresh ?? updated) as any)?.category_type ?? null,
      'packing:updated',
      { item: fresh ?? updated },
      authReq.user.id,
      req.headers['x-socket-id'] as string,
    );
    return;
  }

  res.json({ item: updated });
  broadcastForCategory(
    tripId,
    (updated as any)?.category_type ?? null,
    'packing:updated',
    { item: updated },
    authReq.user.id,
    req.headers['x-socket-id'] as string,
  );
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const catType = getItemCategoryType(id);

  if (!deleteItem(tripId, id)) return res.status(404).json({ error: 'Item not found' });

  res.json({ success: true });
  broadcastForCategory(
    tripId,
    catType,
    'packing:deleted',
    { itemId: Number(id) },
    authReq.user.id,
    req.headers['x-socket-id'] as string,
  );
});

// ── Categories ──────────────────────────────────────────────────────────────

router.get('/categories', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const categories = listCategories(tripId, authReq.user.id);
  res.json({ categories });
});

router.post('/categories', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, type } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!['shared', 'personal', 'private'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const result = createCategory(tripId, authReq.user.id, { name, type });
  if (result && (result as any).error === 'duplicate') return res.status(409).json({ error: 'Category already exists' });

  res.status(201).json({ category: result });
  if (type === 'shared') {
    broadcast(tripId, 'packing:category-created', { category: result }, req.headers['x-socket-id'] as string);
  } else {
    broadcastToUser(authReq.user.id, { type: 'packing:category-created', tripId: Number(tripId), category: result }, req.headers['x-socket-id'] as string);
  }
});

router.patch('/categories/:catId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, catId } = req.params;
  const { name, type } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (type && !['shared', 'personal', 'private'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const updated = updateCategory(tripId, catId, authReq.user.id, { name, type });
  if (!updated) return res.status(404).json({ error: 'Category not found' });

  res.json({ category: updated });
  // Broadcast scope follows the new type.
  if ((updated as any).type === 'shared') {
    broadcast(tripId, 'packing:category-updated', { category: updated }, req.headers['x-socket-id'] as string);
  } else {
    broadcastToUser(authReq.user.id, { type: 'packing:category-updated', tripId: Number(tripId), category: updated }, req.headers['x-socket-id'] as string);
  }
});

router.delete('/categories/:catId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, catId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const cat = db.prepare('SELECT type FROM packing_categories WHERE id = ? AND trip_id = ?').get(catId, tripId) as { type: string } | undefined;
  if (!deleteCategory(tripId, catId, authReq.user.id)) return res.status(404).json({ error: 'Category not found' });

  res.json({ success: true });
  if (!cat || cat.type === 'shared') {
    broadcast(tripId, 'packing:category-deleted', { catId: Number(catId) }, req.headers['x-socket-id'] as string);
  } else {
    broadcastToUser(authReq.user.id, { type: 'packing:category-deleted', tripId: Number(tripId), catId: Number(catId) }, req.headers['x-socket-id'] as string);
  }
});

// ── Bags CRUD ───────────────────────────────────────────────────────────────

router.get('/bags', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const bags = listBags(tripId);
  res.json({ bags });
});

router.post('/bags', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, color } = req.body;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const bag = createBag(tripId, { name, color });
  res.status(201).json({ bag });
  broadcast(tripId, 'packing:bag-created', { bag }, req.headers['x-socket-id'] as string);
});

router.put('/bags/:bagId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, bagId } = req.params;
  const { name, color, weight_limit_grams, user_id } = req.body;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const updated = updateBag(tripId, bagId, { name, color, weight_limit_grams, user_id }, Object.keys(req.body));
  if (!updated) return res.status(404).json({ error: 'Bag not found' });
  res.json({ bag: updated });
  broadcast(tripId, 'packing:bag-updated', { bag: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/bags/:bagId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, bagId } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!deleteBag(tripId, bagId)) return res.status(404).json({ error: 'Bag not found' });
  res.json({ success: true });
  broadcast(tripId, 'packing:bag-deleted', { bagId: Number(bagId) }, req.headers['x-socket-id'] as string);
});

// ── Apply template ──────────────────────────────────────────────────────────

router.post('/apply-template/:templateId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, templateId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const added = applyTemplate(tripId, templateId, authReq.user.id);
  if (!added) return res.status(404).json({ error: 'Template not found or empty' });

  res.json({ items: added, count: added.length });
  broadcast(tripId, 'packing:template-applied', { items: added }, req.headers['x-socket-id'] as string);
});

// ── Bag Members ────────────────────────────────────────────────────────────

router.put('/bags/:bagId/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, bagId } = req.params;
  const { user_ids } = req.body;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const members = setBagMembers(tripId, bagId, Array.isArray(user_ids) ? user_ids : []);
  if (!members) return res.status(404).json({ error: 'Bag not found' });
  res.json({ members });
  broadcast(tripId, 'packing:bag-members-updated', { bagId: Number(bagId), members }, req.headers['x-socket-id'] as string);
});

// ── Save as Template ───────────────────────────────────────────────────────

router.post('/save-as-template', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!name?.trim()) return res.status(400).json({ error: 'Template name is required' });

  const template = saveAsTemplate(tripId, authReq.user.id, name.trim());
  if (!template) return res.status(400).json({ error: 'No items to save' });

  res.status(201).json({ template });
});

// ── Category assignees ──────────────────────────────────────────────────────

router.get('/category-assignees', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const assignees = getCategoryAssignees(tripId);
  res.json({ assignees });
});

router.put('/category-assignees/:catId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, catId } = req.params;
  const { user_ids } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const rows = updateCategoryAssignees(tripId, catId, user_ids);
  if (rows === null) return res.status(400).json({ error: 'Assignees only apply to shared categories' });

  res.json({ assignees: rows });
  broadcast(tripId, 'packing:assignees', { categoryId: Number(catId), assignees: rows }, req.headers['x-socket-id'] as string);

  if (Array.isArray(user_ids) && user_ids.length > 0) {
    import('../services/notificationService').then(({ send }) => {
      const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
      const catInfo = db.prepare('SELECT name FROM packing_categories WHERE id = ?').get(catId) as { name: string } | undefined;
      send({ event: 'packing_tagged', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, category: catInfo?.name || '', tripId: String(tripId) } }).catch(() => {});
    });
  }
});

export default router;
