import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { AuthRequest, OptionalAuthRequest, User } from '../types';
import { getBetterAuthSession } from '../lib/betterAuth';
import { ensureLocalUserFromBetterAuth } from '../lib/localUserBridge';

const AUTH_COOKIE_NAME = 'auth_token';

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey?.trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('=').trim());
    return acc;
  }, {});
}

function getRequestToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.split(' ')[1];
  if (bearer) return bearer;
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE_NAME] || null;
}

function buildAuthCookie(token: string): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${24 * 60 * 60}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function buildClearedAuthCookie(): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function setAuthCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', buildAuthCookie(token));
}

function clearAuthCookie(res: Response): void {
  res.setHeader('Set-Cookie', buildClearedAuthCookie());
}

function authenticateWithLegacyToken(token: string): User | null {
  const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
  return db.prepare(
    'SELECT id, username, email, role, better_auth_user_id FROM users WHERE id = ?'
  ).get(decoded.id) as User | undefined || null;
}

const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.headers['better-auth-cookie']) {
      const betterAuthSession = await getBetterAuthSession(req);
      if (betterAuthSession?.user) {
        const user = ensureLocalUserFromBetterAuth(betterAuthSession.user as {
          id: string;
          email: string;
          name?: string | null;
          username?: string | null;
          displayUsername?: string | null;
        });
        const authReq = req as AuthRequest;
        authReq.user = user;
        authReq.authProvider = 'better-auth';
        authReq.betterAuthSession = betterAuthSession as { user: Record<string, unknown>; session: Record<string, unknown> };
        next();
        return;
      }
    }
  } catch (err: unknown) {
    console.error('[Auth] Better Auth session lookup failed:', err instanceof Error ? err.message : err);
  }

  const token = getRequestToken(req);

  if (!token) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  try {
    const user = authenticateWithLegacyToken(token);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const authReq = req as AuthRequest;
    authReq.user = user;
    authReq.authToken = token;
    authReq.authProvider = 'legacy';
    authReq.betterAuthSession = null;
    next();
  } catch (err: unknown) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.headers['better-auth-cookie']) {
      const betterAuthSession = await getBetterAuthSession(req);
      if (betterAuthSession?.user) {
        const optionalReq = req as OptionalAuthRequest;
        optionalReq.user = ensureLocalUserFromBetterAuth(betterAuthSession.user as {
          id: string;
          email: string;
          name?: string | null;
          username?: string | null;
          displayUsername?: string | null;
        });
        optionalReq.authProvider = 'better-auth';
        optionalReq.betterAuthSession = betterAuthSession as { user: Record<string, unknown>; session: Record<string, unknown> };
        optionalReq.authToken = null;
        next();
        return;
      }
    }
  } catch (err: unknown) {
    console.error('[Auth] Optional Better Auth lookup failed:', err instanceof Error ? err.message : err);
  }

  const token = getRequestToken(req);

  if (!token) {
    const optionalReq = req as OptionalAuthRequest;
    optionalReq.user = null;
    optionalReq.authToken = null;
    optionalReq.authProvider = null;
    optionalReq.betterAuthSession = null;
    return next();
  }

  try {
    const user = authenticateWithLegacyToken(token);
    const optionalReq = req as OptionalAuthRequest;
    optionalReq.user = user || null;
    optionalReq.authToken = token;
    optionalReq.authProvider = user ? 'legacy' : null;
    optionalReq.betterAuthSession = null;
  } catch (err: unknown) {
    const optionalReq = req as OptionalAuthRequest;
    optionalReq.user = null;
    optionalReq.authToken = null;
    optionalReq.authProvider = null;
    optionalReq.betterAuthSession = null;
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
export { AUTH_COOKIE_NAME, clearAuthCookie, getRequestToken, setAuthCookie };
