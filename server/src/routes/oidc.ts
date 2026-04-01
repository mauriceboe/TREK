import express, { Request, Response } from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { User } from '../types';
import { decrypt_api_key } from '../services/apiKeyCrypto';
import { setAuthCookie } from '../services/cookie';

interface OidcDiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  _issuer?: string;
}

interface OidcTokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
}

interface OidcUserInfo {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
  roles?: string[];
  [key: string]: unknown;
}

const router = express.Router();

const AUTH_CODE_TTL = 60000;          // 1 minute
const AUTH_CODE_CLEANUP = 30000;      // 30 seconds
const STATE_TTL = 5 * 60 * 1000;     // 5 minutes
const STATE_CLEANUP = 60 * 1000;      // 1 minute

const authCodes = new Map<string, { token: string; created: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (now - entry.created > AUTH_CODE_TTL) authCodes.delete(code);
  }
}, AUTH_CODE_CLEANUP);

const pendingStates = new Map<string, { createdAt: number; redirectUri: string; inviteToken?: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > STATE_TTL) pendingStates.delete(state);
  }
}, STATE_CLEANUP);

function getOidcConfig() {
  const get = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || null;
  const issuer = process.env.OIDC_ISSUER || get('oidc_issuer');
  const clientId = process.env.OIDC_CLIENT_ID || get('oidc_client_id');
  const clientSecret = process.env.OIDC_CLIENT_SECRET || decrypt_api_key(get('oidc_client_secret'));
  const displayName = process.env.OIDC_DISPLAY_NAME || get('oidc_display_name') || 'SSO';
  const discoveryUrl = process.env.OIDC_DISCOVERY_URL || get('oidc_discovery_url') || null;
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer: issuer.replace(/\/+$/, ''), clientId, clientSecret, displayName, discoveryUrl };
}

let discoveryCache: OidcDiscoveryDoc | null = null;
let discoveryCacheTime = 0;
const DISCOVERY_TTL = 60 * 60 * 1000; // 1 hour

async function discover(issuer: string, discoveryUrl?: string | null) {
  const url = discoveryUrl || `${issuer}/.well-known/openid-configuration`;
  if (discoveryCache && Date.now() - discoveryCacheTime < DISCOVERY_TTL && discoveryCache._issuer === url) {
    return discoveryCache;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch OIDC discovery document');
  const doc = await res.json() as OidcDiscoveryDoc;
  doc._issuer = url;
  discoveryCache = doc;
  discoveryCacheTime = Date.now();
  return doc;
}

function generateToken(user: { id: number }) {
  return jwt.sign(
    { id: user.id },
    JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' }
  );
}

// Check if user should be admin based on OIDC claims
// Env: OIDC_ADMIN_CLAIM (default: "groups"), OIDC_ADMIN_VALUE (required, e.g. "app-trek-admins")
function resolveOidcRole(userInfo: OidcUserInfo, isFirstUser: boolean): 'admin' | 'user' {
  if (isFirstUser) return 'admin';
  const adminValue = process.env.OIDC_ADMIN_VALUE;
  if (!adminValue) return 'user'; // No claim mapping configured
  const claimKey = process.env.OIDC_ADMIN_CLAIM || 'groups';
  const claimData = userInfo[claimKey];
  if (Array.isArray(claimData)) {
    return claimData.some(v => String(v) === adminValue) ? 'admin' : 'user';
  }
  if (typeof claimData === 'string') {
    return claimData === adminValue ? 'admin' : 'user';
  }
  return 'user';
}

function frontendUrl(path: string): string {
  const base = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';
  return base + path;
}

router.get('/login', async (req: Request, res: Response) => {
  const config = getOidcConfig();
  if (!config) return res.status(400).json({ error: 'OIDC not configured' });

  if (config.issuer && !config.issuer.startsWith('https://') && process.env.NODE_ENV === 'production') {
    return res.status(400).json({ error: 'OIDC issuer must use HTTPS in production' });
  }

  try {
    const doc = await discover(config.issuer, config.discoveryUrl);
    const state = crypto.randomBytes(32).toString('hex');
    const appUrl = process.env.APP_URL || (db.prepare("SELECT value FROM app_settings WHERE key = 'app_url'").get() as { value: string } | undefined)?.value;
    if (!appUrl) {
      return res.status(500).json({ error: 'APP_URL is not configured. OIDC cannot be used.' });
    }
    const redirectUri = `${appUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
    const inviteToken = req.query.invite as string | undefined;

    pendingStates.set(state, { createdAt: Date.now(), redirectUri, inviteToken });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
    });

    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch (err: unknown) {
    console.error('[OIDC] Login error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'OIDC login failed' });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error: oidcError } = req.query as { code?: string; state?: string; error?: string };

  if (oidcError) {
    console.error('[OIDC] Provider error:', oidcError);
    return res.redirect(frontendUrl('/login?oidc_error=' + encodeURIComponent(oidcError)));
  }

  if (!code || !state) {
    return res.redirect(frontendUrl('/login?oidc_error=missing_params'));
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.redirect(frontendUrl('/login?oidc_error=invalid_state'));
  }
  pendingStates.delete(state);

  const config = getOidcConfig();
  if (!config) return res.redirect(frontendUrl('/login?oidc_error=not_configured'));

  if (config.issuer && !config.issuer.startsWith('https://') && process.env.NODE_ENV === 'production') {
    return res.redirect(frontendUrl('/login?oidc_error=issuer_not_https'));
  }

  try {
    const doc = await discover(config.issuer, config.discoveryUrl);

    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const tokenData = await tokenRes.json() as OidcTokenResponse;
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[OIDC] Token exchange failed: status', tokenRes.status);
      return res.redirect(frontendUrl('/login?oidc_error=token_failed'));
    }

    const userInfoRes = await fetch(doc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoRes.json() as OidcUserInfo;

    if (!userInfo.email) {
      return res.redirect(frontendUrl('/login?oidc_error=no_email'));
    }

    const email = userInfo.email.toLowerCase();
    const name = userInfo.name || userInfo.preferred_username || email.split('@')[0];
    const sub = userInfo.sub;

    let user = db.prepare('SELECT * FROM users WHERE oidc_sub = ? AND oidc_issuer = ?').get(sub, config.issuer) as User | undefined;
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email) as User | undefined;
    }

    if (user) {
      if (!user.oidc_sub) {
        db.prepare('UPDATE users SET oidc_sub = ?, oidc_issuer = ? WHERE id = ?').run(sub, config.issuer, user.id);
      }
      // Update role based on OIDC claims on every login (if claim mapping is configured)
      if (process.env.OIDC_ADMIN_VALUE) {
        const newRole = resolveOidcRole(userInfo, false);
        if (user.role !== newRole) {
          db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, user.id);
          user = { ...user, role: newRole } as User;
        }
      }
    } else {
      const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
      const isFirstUser = userCount === 0;

      let validInvite: any = null;
      if (pending.inviteToken) {
        validInvite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(pending.inviteToken);
        if (validInvite) {
          if (validInvite.max_uses > 0 && validInvite.used_count >= validInvite.max_uses) validInvite = null;
          if (validInvite?.expires_at && new Date(validInvite.expires_at) < new Date()) validInvite = null;
        }
      }

      if (!isFirstUser && !validInvite) {
        const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get() as { value: string } | undefined;
        if (setting?.value === 'false') {
          return res.redirect(frontendUrl('/login?oidc_error=registration_disabled'));
        }
      }

      const role = resolveOidcRole(userInfo, isFirstUser);
      const randomPass = crypto.randomBytes(32).toString('hex');
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(randomPass, 10);

      let username = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30) || 'user';
      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
      if (existing) username = `${username}_${Date.now() % 10000}`;

      const result = db.prepare(
        'INSERT INTO users (username, email, password_hash, role, oidc_sub, oidc_issuer) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, email, hash, role, sub, config.issuer);

      if (validInvite) {
        const updated = db.prepare(
          'UPDATE invite_tokens SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses)'
        ).run(validInvite.id);
        if (updated.changes === 0) {
          console.warn(`[OIDC] Invite token ${pending.inviteToken?.slice(0, 8)}... exceeded max_uses (race condition)`);
        }
      }

      user = { id: Number(result.lastInsertRowid), username, email, role } as User;
    }

    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    const token = generateToken(user);
    const { v4: uuidv4 } = require('uuid');
    const authCode = uuidv4();
    authCodes.set(authCode, { token, created: Date.now() });
    res.redirect(frontendUrl('/login?oidc_code=' + authCode));
  } catch (err: unknown) {
    console.error('[OIDC] Callback error:', err);
    res.redirect(frontendUrl('/login?oidc_error=server_error'));
  }
});

router.get('/exchange', (req: Request, res: Response) => {
  const { code } = req.query as { code?: string };
  if (!code) return res.status(400).json({ error: 'Code required' });
  const entry = authCodes.get(code);
  if (!entry) return res.status(400).json({ error: 'Invalid or expired code' });
  authCodes.delete(code);
  if (Date.now() - entry.created > AUTH_CODE_TTL) return res.status(400).json({ error: 'Code expired' });
  setAuthCookie(res, entry.token);
  res.json({ token: entry.token });
});

export default router;
