import express, { Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { db } from '../db/database';

const router = express.Router();
const sessions = new Set<string>();

function isEnabled(): boolean {
  const row = db.prepare("SELECT enabled FROM addons WHERE id = 'mcp'").get() as { enabled?: number } | undefined;
  return !!row?.enabled;
}

function getUserId(req: Request): number | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return (jwt.verify(auth.slice('Bearer '.length), JWT_SECRET) as { id: number }).id;
  } catch {
    return null;
  }
}

router.all('/', (req: Request, res: Response) => {
  if (!isEnabled()) return res.status(403).json({ error: 'MCP addon disabled' });

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

  if (req.method === 'DELETE') {
    const sessionId = req.header('Mcp-Session-Id');
    if (!sessionId || !sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    sessions.delete(sessionId);
    return res.json({ success: true });
  }

  if (req.method === 'POST') {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
    res.setHeader('Mcp-Session-Id', sessionId);
    return res.json({ jsonrpc: '2.0', id: (req.body as any)?.id ?? null, result: { userId } });
  }

  res.json({ success: true });
});

export default router;
