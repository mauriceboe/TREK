import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { db, canAccessTrip } from '../db/database';
import { createOrUpdateShareLink, deleteShareLink, getShareLink, getSharedTripData } from '../services/shareService';

const router = express.Router({ mergeParams: true });

function ensureShareTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      share_map INTEGER DEFAULT 1,
      share_bookings INTEGER DEFAULT 1,
      share_packing INTEGER DEFAULT 0,
      share_budget INTEGER DEFAULT 0,
      share_collab INTEGER DEFAULT 0
    )
  `);
}

router.post('/', authenticate, (req: Request, res: Response) => {
  ensureShareTables();
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const result = createOrUpdateShareLink(tripId, authReq.user.id, req.body || {});
  res.status(201).json({ token: result.token, created: result.created });
});

router.get('/', authenticate, (req: Request, res: Response) => {
  ensureShareTables();
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const share = getShareLink(tripId);
  if (!share) return res.json({ token: null });
  res.json(share);
});

router.delete('/', authenticate, (req: Request, res: Response) => {
  ensureShareTables();
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  deleteShareLink(tripId);
  res.json({ success: true });
});

export const sharedRouter = express.Router();

sharedRouter.get('/:token', (req: Request, res: Response) => {
  ensureShareTables();
  const data = getSharedTripData(req.params.token);
  if (!data) return res.status(404).json({ error: 'Shared trip not found' });
  res.json(data);
});

export default router;
