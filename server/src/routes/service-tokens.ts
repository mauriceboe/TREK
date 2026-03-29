import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/database';
import { authenticate, adminOnly } from '../middleware/auth';
import { AuthRequest, ServiceToken } from '../types';

// ── User-facing router (any authenticated user) ─────────────────────────────
const router = express.Router();

router.use(authenticate);

// GET /api/service-tokens — list caller's own tokens
router.get('/', (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user.id;
  const tokens = db.prepare(
    `SELECT id, name, token_prefix, last_used, expires_at, created_at
     FROM service_tokens WHERE created_by = ? ORDER BY created_at DESC`
  ).all(userId) as ServiceToken[];
  res.json({ tokens });
});

// POST /api/service-tokens — create a new token for the caller
router.post('/', (req: Request, res: Response) => {
  const { name, expires_at } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Token name is required' });
  const userId = (req as AuthRequest).user.id;

  const rawToken = 'trek_mcp_' + crypto.randomBytes(32).toString('hex');
  const tokenPrefix = rawToken.substring(0, 16);
  const tokenHash = bcrypt.hashSync(rawToken, 10);

  const result = db.prepare(
    `INSERT INTO service_tokens (name, token_hash, token_prefix, created_by, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(name.trim(), tokenHash, tokenPrefix, userId, expires_at || null);

  res.status(201).json({
    token: rawToken,
    id: result.lastInsertRowid,
    name: name.trim(),
    token_prefix: tokenPrefix,
    expires_at: expires_at || null,
  });
});

// DELETE /api/service-tokens/:id — revoke caller's own token
router.delete('/:id', (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user.id;
  const { id } = req.params;
  const existing = db.prepare('SELECT id FROM service_tokens WHERE id = ? AND created_by = ?').get(id, userId);
  if (!existing) return res.status(404).json({ error: 'Token not found' });
  db.prepare('DELETE FROM service_tokens WHERE id = ?').run(id);
  res.json({ success: true });
});

export default router;

// ── Admin router (admin only — audit & revoke any token) ────────────────────
export const adminRouter = express.Router();

adminRouter.use(authenticate, adminOnly);

// GET /api/admin/service-tokens — all users' tokens with username
adminRouter.get('/', (_req: Request, res: Response) => {
  const tokens = db.prepare(
    `SELECT st.id, st.name, st.token_prefix, st.last_used, st.expires_at, st.created_at,
            u.username as created_by_username
     FROM service_tokens st JOIN users u ON u.id = st.created_by
     ORDER BY st.created_at DESC`
  ).all() as Array<ServiceToken & { created_by_username: string }>;
  res.json({ tokens });
});

// DELETE /api/admin/service-tokens/:id — revoke any token
adminRouter.delete('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT id FROM service_tokens WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Token not found' });
  db.prepare('DELETE FROM service_tokens WHERE id = ?').run(id);
  res.json({ success: true });
});
