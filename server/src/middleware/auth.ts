import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { AuthRequest, OptionalAuthRequest, User } from '../types';

function extractToken(req: Request): string | null {
  // Prefer httpOnly cookie; fall back to Authorization: Bearer (MCP, API clients)
  const cookieToken = (req as any).cookies?.trek_session;
  if (cookieToken) return cookieToken;
  const authHeader = req.headers['authorization'];
  return (authHeader && authHeader.split(' ')[1]) || null;
}

const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Access token required', code: 'AUTH_REQUIRED' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    const user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
    if (!user) {
      res.status(401).json({ error: 'User not found', code: 'AUTH_REQUIRED' });
      return;
    }
    (req as AuthRequest).user = user;
    next();
  } catch (err: unknown) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_REQUIRED' });
  }
};

const optionalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = extractToken(req);

  if (!token) {
    (req as OptionalAuthRequest).user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
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
