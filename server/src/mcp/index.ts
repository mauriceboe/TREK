import { Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { JWT_SECRET } from '../config';
import { db } from '../db/database';
import { User } from '../types';
import { registerResources } from './resources';
import { registerTools } from './tools';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  userId: number;
  lastActivity: number;
}

const sessions = new Map<string, McpSession>();

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS_PER_USER = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // requests per minute per user

interface RateLimitEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<number, RateLimitEntry>();

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function countSessionsForUser(userId: number): number {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let count = 0;
  for (const session of sessions.values()) {
    if (session.userId === userId && session.lastActivity >= cutoff) count++;
  }
  return count;
}

const sessionSweepInterval = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, session] of sessions) {
    if (session.lastActivity < cutoff) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
  const rateCutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [uid, entry] of rateLimitMap) {
    if (entry.windowStart < rateCutoff) rateLimitMap.delete(uid);
  }
}, 10 * 60 * 1000); // sweep every 10 minutes

// Prevent the interval from keeping the process alive if nothing else is running
sessionSweepInterval.unref();

function verifyToken(authHeader: string | undefined): User | null {
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;

  // Long-lived MCP API token (trek_...)
  if (token.startsWith('trek_')) {
    const hash = createHash('sha256').update(token).digest('hex');
    const row = db.prepare(`
      SELECT u.id, u.username, u.email, u.role
      FROM mcp_tokens mt
      JOIN users u ON mt.user_id = u.id
      WHERE mt.token_hash = ?
    `).get(hash) as User | undefined;
    if (row) {
      // Update last_used_at (fire-and-forget, non-blocking)
      db.prepare('UPDATE mcp_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash);
      return row;
    }
    return null;
  }

  // Short-lived JWT
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    const user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
    return user || null;
  } catch {
    return null;
  }
}

export async function mcpHandler(req: Request, res: Response): Promise<void> {
  const mcpAddon = db.prepare("SELECT enabled FROM addons WHERE id = 'mcp'").get() as { enabled: number } | undefined;
  if (!mcpAddon || !mcpAddon.enabled) {
    res.status(403).json({ error: 'MCP is not enabled' });
    return;
  }

  const user = verifyToken(req.headers['authorization']);
  if (!user) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  if (isRateLimited(user.id)) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Resume an existing session
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== user.id) {
      res.status(403).json({ error: 'Session belongs to a different user' });
      return;
    }
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // Only POST can initialize a new session
  if (req.method !== 'POST') {
    res.status(400).json({ error: 'Missing mcp-session-id header' });
    return;
  }

  if (countSessionsForUser(user.id) >= MAX_SESSIONS_PER_USER) {
    res.status(429).json({ error: 'Session limit reached. Close an existing session before opening a new one.' });
    return;
  }

  // Create a new per-user MCP server and session
  const server = new McpServer({ name: 'trek', version: '1.0.0' });
  registerResources(server, user.id);
  registerTools(server, user.id);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { server, transport, userId: user.id, lastActivity: Date.now() });
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** Terminate all active MCP sessions for a specific user (e.g. on token revocation). */
export function revokeUserSessions(userId: number): void {
  for (const [sid, session] of sessions) {
    if (session.userId === userId) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
}

/** Close all active MCP sessions (call during graceful shutdown). */
export function closeMcpSessions(): void {
  clearInterval(sessionSweepInterval);
  for (const [, session] of sessions) {
    try { session.server.close(); } catch { /* ignore */ }
    try { session.transport.close(); } catch { /* ignore */ }
  }
  sessions.clear();
  rateLimitMap.clear();
}
