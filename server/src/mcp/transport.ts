import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { registerTripTools } from './tools/trips';
import { registerDayTools } from './tools/days';
import { registerPlaceTools } from './tools/places';
import { registerPackingTools } from './tools/packing';
import { registerBudgetTools } from './tools/budget';
import { registerSearchTools } from './tools/search';

// Map: sessionId -> { transport, server }
const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

function isMcpEnabled(): boolean {
  const row = db.prepare("SELECT enabled FROM addons WHERE id = 'mcp'").get() as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function createMcpServer(userId: number): McpServer {
  const server = new McpServer({
    name: 'TREK',
    version: '1.0.0',
  });

  registerTripTools(server, userId);
  registerDayTools(server, userId);
  registerPlaceTools(server, userId);
  registerPackingTools(server, userId);
  registerBudgetTools(server, userId);
  registerSearchTools(server, userId);

  return server;
}

const router = express.Router();

// SSE endpoint — clients connect here to establish a session
router.get('/', authenticate, async (req: Request, res: Response) => {
  if (!isMcpEnabled()) {
    return res.status(503).json({ error: 'MCP addon is not enabled' });
  }

  const authReq = req as AuthRequest;
  const server = createMcpServer(authReq.user.id);
  const transport = new SSEServerTransport('/api/mcp/message', res);
  const sessionId = (transport as unknown as { sessionId: string }).sessionId;

  sessions.set(sessionId, { transport, server });

  res.on('close', () => {
    sessions.delete(sessionId);
  });

  await server.connect(transport);
});

// Message endpoint — clients POST tool calls here
router.post('/message', authenticate, async (req: Request, res: Response) => {
  if (!isMcpEnabled()) {
    return res.status(503).json({ error: 'MCP addon is not enabled' });
  }

  const sessionId = req.query.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  await session.transport.handlePostMessage(req, res);
});

export default router;
