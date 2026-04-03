import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import {
  verifyTripAccess,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  bulkImport,
  listBags,
  createBag,
  updateBag,
  deleteBag,
  applyTemplate,
  getCategoryAssignees,
  updateCategoryAssignees,
  reorderItems,
} from '../services/packingService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const items = listItems(tripId);
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

  const created = bulkImport(tripId, items);

  res.status(201).json({ items: created, count: created.length });
  for (const item of created) {
    broadcast(tripId, 'packing:created', { item }, req.headers['x-socket-id'] as string);
  }
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { name, category, checked } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!name) return res.status(400).json({ error: 'Item name is required' });

  const item = createItem(tripId, { name, category, checked });
  res.status(201).json({ item });
  broadcast(tripId, 'packing:created', { item }, req.headers['x-socket-id'] as string);
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
  const { name, checked, category, weight_grams, bag_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const updated = updateItem(tripId, id, { name, checked, category, weight_grams, bag_id }, Object.keys(req.body));
  if (!updated) return res.status(404).json({ error: 'Item not found' });

  res.json({ item: updated });
  broadcast(tripId, 'packing:updated', { item: updated }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteItem(tripId, id)) return res.status(404).json({ error: 'Item not found' });

  res.json({ success: true });
  broadcast(tripId, 'packing:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
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
  const { name, color, weight_limit_grams } = req.body;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const updated = updateBag(tripId, bagId, { name, color, weight_limit_grams });
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

  const added = applyTemplate(tripId, templateId);
  if (!added) return res.status(404).json({ error: 'Template not found or empty' });

  res.json({ items: added, count: added.length });
  broadcast(tripId, 'packing:template-applied', { items: added }, req.headers['x-socket-id'] as string);
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

router.put('/category-assignees/:categoryName', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, categoryName } = req.params;
  const { user_ids } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('packing_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const cat = decodeURIComponent(categoryName);
  const rows = updateCategoryAssignees(tripId, cat, user_ids);

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

export default router;
