import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { AuthRequest, OptionalAuthRequest, User } from '../types';

const SERVICE_TOKEN_PREFIX = 'trek_mcp_';

const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  // Service token path: long-lived tokens for MCP
  if (token.startsWith(SERVICE_TOKEN_PREFIX)) {
    try {
      const prefix = token.substring(0, Math.min(token.length, 16));
      const rows = db.prepare(
        'SELECT st.*, u.id as uid, u.username, u.email, u.role FROM service_tokens st JOIN users u ON u.id = st.created_by WHERE st.token_prefix = ?'
      ).all(prefix) as Array<{ uid: number; username: string; email: string; role: string; token_hash: string; expires_at: string | null; id: number }>;

      let matched: typeof rows[0] | null = null;
      for (const row of rows) {
        if (bcrypt.compareSync(token, row.token_hash)) {
          matched = row;
          break;
        }
      }

      if (!matched) {
        res.status(401).json({ error: 'Invalid service token' });
        return;
      }

      if (matched.expires_at && new Date(matched.expires_at) < new Date()) {
        res.status(401).json({ error: 'Service token expired' });
        return;
      }

      // Update last_used (fire and forget)
      db.prepare('UPDATE service_tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(matched.id);

      (req as AuthRequest).user = { id: matched.uid, username: matched.username, email: matched.email, role: matched.role as 'admin' | 'user' };
      next();
    } catch (err: unknown) {
      res.status(401).json({ error: 'Service token validation failed' });
    }
    return;
  }

  // Standard JWT path
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    (req as AuthRequest).user = user;
    next();
  } catch (err: unknown) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const optionalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    (req as OptionalAuthRequest).user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
    (req as OptionalAuthRequest).user = user || null;
  } catch (err: unknown) {
    (req as OptionalAuthRequest).user = null;
  }
  next();
};

const adminOnly = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  if (!authReq.user || authReq.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

const demoUploadBlock = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user?.email === 'demo@nomad.app') {
    res.status(403).json({ error: 'Uploads are disabled in demo mode. Self-host NOMAD for full functionality.' });
    return;
  }
  next();
};

export { authenticate, optionalAuth, adminOnly, demoUploadBlock };
