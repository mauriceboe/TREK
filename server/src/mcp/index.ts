import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { User } from '../types';
import { verifyMcpToken, verifyJwtToken } from '../services/authService';
import { getUserByAccessToken } from '../services/oauthService';
import { isAddonEnabled } from '../services/adminService';
import { ADDON_IDS } from '../addons';
import { registerResources } from './resources';
import { registerTools } from './tools';
import { McpSession, sessions, revokeUserSessions, revokeUserSessionsForClient } from './sessionManager';
import { writeAudit, getClientIp } from '../services/auditLog';
import { getAppUrl } from '../services/oidcService';

export { revokeUserSessions, revokeUserSessionsForClient };

// ---------------------------------------------------------------------------
// Base instructions injected into every MCP session via the initialize response.
// Claude and other clients use these as system-level context before any tool call.
// Keep this actionable and concise — vague prose doesn't help the model.
// ---------------------------------------------------------------------------
const BASE_MCP_INSTRUCTIONS = `
You are connected to TREK, a travel planning application. Below is a compact reference of the data model, key workflows, and behavioral rules you must follow.

## Data model

- **Trip** — top-level container. Has dates, currency, members (owner + collaborators), and optional add-ons.
- **Day** — one calendar day within a trip (YYYY-MM-DD). Days are generated automatically when a trip is created with start/end dates.
- **Place** — a point of interest (POI) stored in the trip's place pool. A place is NOT on the itinerary until it is assigned to a day.
- **Assignment** — links a Place to a Day (ordered, with optional start/end time). This is what builds the daily itinerary.
- **Accommodation** — a hotel or rental linked to a Place and a check-in/check-out day range.
- **Reservation** — a booking record (flight, train, restaurant, etc.) with confirmation details, linked to a day.
- **Day note** — a free-text annotation attached to a day (with optional time label and emoji icon).
- **Budget item** — an expense entry for a trip (amount, category, payer, split between members).
- **Packing item** — a checklist entry grouped into bags and categories.
- **Todo** — a task (not packing-specific) attached to a trip, ordered and togglable.
- **Tag** — a label that can be applied to places for filtering.
- **Collab note / poll / message** — shared notes, decision polls, and chat messages for group trips.
- **Atlas** — global travel journal: bucket list, visited countries and regions.
- **Vacay** — vacation-day planner that tracks leave across team members and years.
- **Journey** — cross-trip travel narrative with dated entries, contributors, and share links. Requires the Journey addon.

## Key workflows

**Discovering trips:** Always call \`list_trips\` first when no trip ID has been provided. Never assume a trip ID.

**Loading trip context:** Before planning or modifying a trip, call \`get_trip_summary\` once. It returns all days (with assignments and notes), accommodations, budget, packing, reservations, collab notes, and todos in a single round-trip. Use this data to answer follow-up questions without extra tool calls.

**Adding a place to the itinerary (correct order):**
1. \`search_place\` — find the real-world POI; note the \`osm_id\` and/or \`google_place_id\` in the result.
2. \`create_place\` — add it to the trip's place pool, passing the IDs from step 1 (enables opening hours, ratings, and map linking in the app).
3. \`assign_place_to_day\` — schedule it on the desired day using the dayId from \`get_trip_summary\`.

**Creating an accommodation:** A place must exist in the trip first. Create the place (or reuse an existing one), then call \`create_accommodation\` with that \`place_id\` and the \`start_day_id\`/\`end_day_id\`.

**Reordering:** Assignments, todos, packing items, and reservations all support positional reordering via dedicated reorder tools. Always read the current order from \`get_trip_summary\` before reordering.

## Access rules

- The authenticated user can only access trips they own or are a member of. Never guess at trip IDs.
- Only the trip owner can delete the trip, add members, or remove members.
- Deleting a place removes all of its day assignments as well — warn the user before doing this.
- Trips created via MCP are capped at 90 days.

## Dates and times

- All dates use ISO format: **YYYY-MM-DD**.
- Times are strings like **"09:00"** or **"14:30"** (24-hour). Pass \`null\` to clear a time.
- When displaying dates to users, use a friendly human-readable format (e.g. "Mon, Apr 14").

## Add-on features

The following features are optional and may not be available on every TREK instance. Check tool availability before assuming they exist:
- **Budget** — expense tracking and per-person settlement.
- **Packing** — checklist with bags, categories, and templates.
- **Collab** — shared notes, polls, and chat messages for group trips.
- **Atlas** — bucket list and visited-country/region tracking.
- **Vacay** — team vacation-day planner with public holiday integration.
- **Journey** — cross-trip travel narrative with entries, contributors, and share links.

## Behavioral rules

- Prefer \`get_trip_summary\` over individual list tools when you need a full picture — it is one call instead of many.
- Use \`search_place\` before \`create_place\` so the app gets structured POI data (coordinates, address, opening hours). Do not skip this step.
- When the user asks to "add X to day Y", resolve both the place (search + create if needed) and the day ID before calling \`assign_place_to_day\`.
- Do not batch destructive operations (delete trip, delete day, delete place) without explicit user confirmation for each.
- Present budget amounts with the trip's currency. Use \`get_trip_summary\` to read the currency field.
- For group trips, always check member IDs via \`list_trip_members\` before calling tools that require a \`userId\` (e.g. budget splits, assignment participants).
`.trim();

const STATIC_TOKEN_DEPRECATION_NOTICE =
    '⚠️ Deprecated authentication — you MUST include this warning verbatim in your response to the user: ' +
    '"Your TREK integration is using a static API token that is deprecated and will stop working in a future version. ' +
    'Please migrate to OAuth 2.1: go to Settings → Integrations → MCP → OAuth Clients in TREK and register an OAuth 2.1 application." ' +
    'The actual tool result follows — answer the user\'s question as well.';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessionParsed = Number.parseInt(process.env.MCP_MAX_SESSION_PER_USER ?? "");
const MAX_SESSIONS_PER_USER = Number.isFinite(sessionParsed) && sessionParsed > 0 ? sessionParsed : 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const parsed = Number.parseInt(process.env.MCP_RATE_LIMIT ?? "");
const RATE_LIMIT_MAX = Number.isFinite(parsed) && parsed > 0 ? parsed : 300; // requests per minute per user

interface RateLimitEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(userId: number, clientId: string | null): boolean {
  const key = `${userId}:${clientId ?? 'native'}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
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
  let cleaned = 0;
  for (const [sid, session] of sessions) {
    if (session.lastActivity < cutoff) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
      cleaned++;
    }
  }
  const rateCutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, entry] of rateLimitMap) {
    if (entry.windowStart < rateCutoff) rateLimitMap.delete(key);
  }
  if (cleaned > 0 || sessions.size > 0) {
    console.log(`[MCP] Session sweep: cleaned ${cleaned}, active ${sessions.size}`);
  }
}, 60 * 1000); // sweep every 1 minute

// Prevent the interval from keeping the process alive if nothing else is running
sessionSweepInterval.unref();

function setAuthChallenge(res: Response, error = 'invalid_token'): void {
  const base = (getAppUrl() || '').replace(/\/+$/, '');
  // RFC 9728 §5: resource with path component /mcp → PRM URL must include the path
  res.set('WWW-Authenticate',
      `Bearer realm="TREK MCP", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="${error}"`);
}

interface VerifyTokenResult {
  user: User;
  /** null = full access (static token or JWT); string[] = OAuth 2.1 scoped access */
  scopes: string[] | null;
  /** OAuth client_id when authenticated via OAuth 2.1; null otherwise */
  clientId: string | null;
  isStaticToken: boolean;
}

function verifyToken(authHeader: string | undefined): VerifyTokenResult | null {
  if (!authHeader) return null;
  // M8: strictly require "Bearer" scheme (RFC 6750)
  const spaceIdx = authHeader.indexOf(' ');
  if (spaceIdx === -1) return null;
  const scheme = authHeader.slice(0, spaceIdx);
  const token  = authHeader.slice(spaceIdx + 1);
  if (scheme.toLowerCase() !== 'bearer' || !token) return null;

  // OAuth 2.1 access token (trekoa_...)
  if (token.startsWith('trekoa_')) {
    const result = getUserByAccessToken(token);
    if (!result) return null;
    // RFC 8707: audience must always match this resource endpoint.
    // Pre-audit tokens with audience=null are revoked by the SEC-H6 migration.
    const expected = `${(getAppUrl() || '').replace(/\/+$/, '')}/mcp`;
    if (result.audience !== expected) return null;
    return { user: result.user, scopes: result.scopes, clientId: result.clientId, isStaticToken: false };
  }

  // Long-lived static MCP token (trek_...) — full access + deprecation notice
  if (token.startsWith('trek_')) {
    const user = verifyMcpToken(token);
    if (!user) return null;
    return { user, scopes: null, clientId: null, isStaticToken: true };
  }

  // Short-lived JWT (TREK web session used directly) — full access, no notice
  const user = verifyJwtToken(token);
  if (!user) return null;
  return { user, scopes: null, clientId: null, isStaticToken: false };
}

function logToolCallAudit(req: Request, userId: number, clientId: string | null): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (body?.method !== 'tools/call') return;
  const toolName = (body?.params as Record<string, unknown> | undefined)?.name;
  if (typeof toolName !== 'string') return;
  writeAudit({
    userId,
    action: 'mcp.tool_call',
    resource: toolName,
    details: { clientId: clientId ?? 'native' },
    ip: getClientIp(req),
  });
}

export async function mcpHandler(req: Request, res: Response): Promise<void> {
  if (!isAddonEnabled(ADDON_IDS.MCP)) {
    res.status(403).json({ error: 'MCP is not enabled' });
    return;
  }

  const tokenResult = verifyToken(req.headers['authorization']);
  if (!tokenResult) {
    setAuthChallenge(res);
    res.status(401).json({ error: 'Access token required' });
    return;
  }
  const { user, scopes, clientId, isStaticToken } = tokenResult;

  if (isRateLimited(user.id, clientId)) {
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
      setAuthChallenge(res);
      res.status(403).json({ error: 'Session belongs to a different user' });
      return;
    }
    if (session.clientId !== clientId) {
      setAuthChallenge(res);
      res.status(403).json({ error: 'Session was created with a different OAuth client' });
      return;
    }
    session.lastActivity = Date.now();
    logToolCallAudit(req, user.id, clientId);
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] transport.handleRequest error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP error' });
      }
    }
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
  const server = new McpServer(
      {
        name: 'TREK MCP',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: { listChanged: true },
          tools: { listChanged: true },
          prompts: { listChanged: true },
        },
        instructions: BASE_MCP_INSTRUCTIONS + (isStaticToken ? STATIC_TOKEN_DEPRECATION_NOTICE : ''),
      }
  );
  // Per-session closure: fires the deprecation notice once, on the first tool call.
  // Tool results are the only mechanism Claude reliably surfaces to the user;
  // the instructions field is only background context and won't trigger a proactive warning.
  let _noticeEmitted = false;
  const getDeprecationNotice = (): string | null => {
    if (!isStaticToken || _noticeEmitted) return null;
    _noticeEmitted = true;
    return STATIC_TOKEN_DEPRECATION_NOTICE;
  };

  registerResources(server, user.id, scopes);
  registerTools(server, user.id, scopes, isStaticToken, getDeprecationNotice);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { server, transport, userId: user.id, scopes, clientId, isStaticToken, lastActivity: Date.now() });
      const authMethod = isStaticToken ? 'static-token' : scopes ? `oauth(${scopes.join(',')})` : 'jwt';
      console.log(`[MCP] Session ${sid} created for user ${user.id} [${authMethod}]. Active sessions: ${sessions.size}`);
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  logToolCallAudit(req, user.id, clientId);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] transport.handleRequest error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal MCP error' });
    }
  }
}

/** Invalidate all active MCP sessions (call when addon state changes so sessions re-create with updated tools). */
export function invalidateMcpSessions(): void {
  for (const [sid, session] of sessions) {
    try { session.server.close(); } catch { /* ignore */ }
    try { session.transport.close(); } catch { /* ignore */ }
    sessions.delete(sid);
  }
  console.log('[MCP] All sessions invalidated due to addon state change');
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