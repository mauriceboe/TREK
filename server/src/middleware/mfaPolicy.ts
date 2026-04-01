import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';

/** Paths that never require MFA (public or pre-auth). */
function isPublicApiPath(method: string, pathNoQuery: string): boolean {
  if (method === 'GET' && pathNoQuery === '/api/health') return true;
  if (method === 'GET' && pathNoQuery === '/api/auth/app-config') return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/login') return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/register') return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/demo-login') return true;
  if (method === 'GET' && pathNoQuery.startsWith('/api/auth/invite/')) return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/mfa/verify-login') return true;
  if (pathNoQuery.startsWith('/api/auth/oidc/')) return true;
  return false;
}

/** Authenticated paths allowed while MFA is not yet enabled (setup + lockout recovery). */
function isMfaSetupExemptPath(method: string, pathNoQuery: string): boolean {
  if (method === 'GET' && pathNoQuery === '/api/auth/me') return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/mfa/setup') return true;
  if (method === 'POST' && pathNoQuery === '/api/auth/mfa/enable') return true;
  if ((method === 'GET' || method === 'PUT') && pathNoQuery === '/api/auth/app-settings') return true;
  return false;
}

/**
 * When app_settings.require_mfa is true, block API access for users without MFA enabled,
 * except for public routes and MFA setup endpoints.
 */
export function enforceGlobalMfaPolicy(req: Request, res: Response, next: NextFunction): void {
  const pathNoQuery = (req.originalUrl || req.url || '').split('?')[0];

  if (!pathNoQuery.startsWith('/api')) {
    next();
    return;
  }

  if (isPublicApiPath(req.method, pathNoQuery)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    next();
    return;
  }

  let userId: number;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    userId = decoded.id;
  } catch {
    next();
    return;
  }

  const requireRow = db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined;
  if (requireRow?.value !== 'true') {
    next();
    return;
  }

  if (process.env.DEMO_MODE === 'true') {
    const demo = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
    if (demo?.email === 'demo@trek.app' || demo?.email === 'demo@nomad.app') {
      next();
      return;
    }
  }

  const row = db.prepare('SELECT mfa_enabled, role FROM users WHERE id = ?').get(userId) as
    | { mfa_enabled: number | boolean; role: string }
    | undefined;
  if (!row) {
    next();
    return;
  }

  const mfaOk = row.mfa_enabled === 1 || row.mfa_enabled === true;
  if (mfaOk) {
    next();
    return;
  }

  if (isMfaSetupExemptPath(req.method, pathNoQuery)) {
    next();
    return;
  }

  res.status(403).json({
    error: 'Two-factor authentication is required. Complete setup in Settings.',
    code: 'MFA_REQUIRED',
  });
}
