import jwt from 'jsonwebtoken';
import { db } from '../db/database';

const BASE_URL = () => `http://localhost:${process.env.PORT || 3000}`;

function mintToken(userId: number): string {
  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(userId) as {
    id: number; username: string; email: string; role: string;
  } | undefined;
  if (!user) throw new Error(`User ${userId} not found`);
  return jwt.sign(
    { sub: user.id, username: user.username, email: user.email, role: user.role },
    process.env.JWT_SECRET || 'trek-dev-secret',
    { expiresIn: '60s' },
  );
}

async function request(method: string, userId: number, path: string, body?: unknown): Promise<unknown> {
  const token = mintToken(userId);
  const res = await fetch(`${BASE_URL()}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  get:    (userId: number, path: string)                   => request('GET',    userId, path),
  post:   (userId: number, path: string, body: unknown)    => request('POST',   userId, path, body),
  put:    (userId: number, path: string, body: unknown)    => request('PUT',    userId, path, body),
  patch:  (userId: number, path: string, body: unknown)    => request('PATCH',  userId, path, body),
  delete: (userId: number, path: string)                   => request('DELETE', userId, path),
};

/** Wrap a successful response for MCP */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Wrap an error response for MCP */
export function mcpErr(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
