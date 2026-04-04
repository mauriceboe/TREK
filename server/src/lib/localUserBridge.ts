import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/database';
import type { User } from '../types';

export interface BetterAuthUserLike {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
}

function sanitizeLocalUsername(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50);
  if (cleaned.length >= 2) return cleaned;
  return `user${Date.now().toString().slice(-6)}`;
}

export function normalizeBetterAuthUsername(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
  if (normalized.length >= 3) return normalized;
  return `user${Date.now().toString().slice(-6)}`;
}

function buildPreferredLocalUsername(identity: BetterAuthUserLike): string {
  const preferred = identity.displayUsername || identity.username || identity.name || identity.email.split('@')[0] || 'user';
  return sanitizeLocalUsername(preferred);
}

function ensureUniqueLocalUsername(username: string, excludeUserId?: number): string {
  let candidate = sanitizeLocalUsername(username);
  let suffix = 1;
  while (true) {
    const row = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(candidate) as { id: number } | undefined;
    if (!row || row.id === excludeUserId) return candidate;
    const base = candidate.slice(0, Math.max(2, 50 - (`_${suffix}`.length)));
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
}

function randomPasswordHash(): string {
  return bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
}

function loadLocalUserById(id: number): User | undefined {
  return db.prepare('SELECT id, username, email, role, avatar, oidc_issuer, created_at, better_auth_user_id FROM users WHERE id = ?').get(id) as User | undefined;
}

export function ensureLocalUserFromBetterAuth(identity: BetterAuthUserLike): User {
  const email = identity.email.trim().toLowerCase();
  let localUser = db.prepare('SELECT * FROM users WHERE better_auth_user_id = ?').get(identity.id) as User | undefined;

  if (!localUser) {
    localUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as User | undefined;
    if (localUser && !localUser.better_auth_user_id) {
      db.prepare('UPDATE users SET better_auth_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(identity.id, localUser.id);
      localUser.better_auth_user_id = identity.id;
    }
  }

  const desiredUsername = buildPreferredLocalUsername(identity);

  if (!localUser) {
    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    const role = userCount === 0 ? 'admin' : 'user';
    const username = ensureUniqueLocalUsername(desiredUsername);
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, better_auth_user_id, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, email, randomPasswordHash(), identity.id, role);
    return loadLocalUserById(Number(result.lastInsertRowid))!;
  }

  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  const uniqueUsername = ensureUniqueLocalUsername(desiredUsername, localUser.id);

  if ((localUser.better_auth_user_id || null) !== identity.id) {
    updates.push('better_auth_user_id = ?');
    params.push(identity.id);
  }
  if (localUser.email.toLowerCase() !== email) {
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, localUser.id) as { id: number } | undefined;
    if (!conflict) {
      updates.push('email = ?');
      params.push(email);
    }
  }
  if (localUser.username !== uniqueUsername) {
    updates.push('username = ?');
    params.push(uniqueUsername);
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(localUser.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  return loadLocalUserById(localUser.id)!;
}
