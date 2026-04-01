import { WebSocketServer, WebSocket } from 'ws';
import { db, canAccessTrip } from './db/database';
import { consumeEphemeralToken } from './services/ephemeralTokens';
import { User } from './types';
import http from 'http';

interface NomadWebSocket extends WebSocket {
  isAlive: boolean;
}

// Room management: tripId -> Set<WebSocket>
const rooms = new Map<number, Set<NomadWebSocket>>();

// Track which rooms each socket is in
const socketRooms = new WeakMap<NomadWebSocket, Set<number>>();

// Track user info per socket
const socketUser = new WeakMap<NomadWebSocket, User>();

// Track unique socket ID
const socketId = new WeakMap<NomadWebSocket, number>();
let nextSocketId = 1;

let wss: WebSocketServer | null = null;

// Per-connection message rate limiting
const WS_MSG_LIMIT = 30;        // max messages
const WS_MSG_WINDOW = 10_000;   // per 10 seconds
const socketMsgCounts = new WeakMap<NomadWebSocket, { count: number; windowStart: number }>();

/** Attaches a WebSocket server with JWT auth, room-based trip channels, and heartbeat keep-alive. */
function setupWebSocket(server: http.Server): void {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : null;

  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 64 * 1024, // 64 KB max message size
    verifyClient: allowedOrigins
      ? ({ origin }, cb) => {
          if (!origin || allowedOrigins.includes(origin)) cb(true);
          else cb(false, 403, 'Origin not allowed');
        }
      : undefined,
  });

  const HEARTBEAT_INTERVAL = 30000; // 30 seconds
  const heartbeat = setInterval(() => {
    wss!.clients.forEach((ws) => {
      const nws = ws as NomadWebSocket;
      if (nws.isAlive === false) return nws.terminate();
      nws.isAlive = false;
      nws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const nws = ws as NomadWebSocket;
    // Extract token from query param
    const url = new URL(req.url!, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      nws.close(4001, 'Authentication required');
      return;
    }

    const userId = consumeEphemeralToken(token, 'ws');
    if (!userId) {
      nws.close(4001, 'Invalid or expired token');
      return;
    }

    let user: User | undefined;
    user = db.prepare(
      'SELECT id, username, email, role, mfa_enabled FROM users WHERE id = ?'
    ).get(userId) as User | undefined;
    if (!user) {
      nws.close(4001, 'User not found');
      return;
    }
    const requireMfa = (db.prepare("SELECT value FROM app_settings WHERE key = 'require_mfa'").get() as { value: string } | undefined)?.value === 'true';
    const mfaOk = user.mfa_enabled === 1 || user.mfa_enabled === true;
    if (requireMfa && !mfaOk) {
      nws.close(4403, 'MFA required');
      return;
    }

    nws.isAlive = true;
    const sid = nextSocketId++;
    socketId.set(nws, sid);
    socketUser.set(nws, user);
    socketRooms.set(nws, new Set());
    nws.send(JSON.stringify({ type: 'welcome', socketId: sid }));

    nws.on('pong', () => { nws.isAlive = true; });

    socketMsgCounts.set(nws, { count: 0, windowStart: Date.now() });

    nws.on('message', (data) => {
      // Rate limiting
      const rate = socketMsgCounts.get(nws)!;
      const now = Date.now();
      if (now - rate.windowStart > WS_MSG_WINDOW) {
        rate.count = 1;
        rate.windowStart = now;
      } else {
        rate.count++;
        if (rate.count > WS_MSG_LIMIT) {
          nws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
          return;
        }
      }

      let msg: { type: string; tripId?: number | string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Malformed JSON, ignore
      }

      // Basic validation
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      if (msg.type === 'join' && msg.tripId) {
        const tripId = Number(msg.tripId);
        // Verify the user has access to this trip
        if (!canAccessTrip(tripId, user!.id)) {
          nws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
          return;
        }
        // Add to room
        if (!rooms.has(tripId)) rooms.set(tripId, new Set());
        rooms.get(tripId)!.add(nws);
        socketRooms.get(nws)!.add(tripId);
        nws.send(JSON.stringify({ type: 'joined', tripId }));
      }

      if (msg.type === 'leave' && msg.tripId) {
        const tripId = Number(msg.tripId);
        leaveRoom(nws, tripId);
        nws.send(JSON.stringify({ type: 'left', tripId }));
      }
    });

    nws.on('close', () => {
      // Clean up all rooms this socket was in
      const myRooms = socketRooms.get(nws);
      if (myRooms) {
        for (const tripId of myRooms) {
          leaveRoom(nws, tripId);
        }
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}

function leaveRoom(ws: NomadWebSocket, tripId: number): void {
  const room = rooms.get(tripId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(tripId);
  }
  const myRooms = socketRooms.get(ws);
  if (myRooms) myRooms.delete(tripId);
}

/**
 * Broadcast an event to all sockets in a trip room, optionally excluding a socket.
 */
function broadcast(tripId: number | string, eventType: string, payload: Record<string, unknown>, excludeSid?: number | string): void {
  tripId = Number(tripId);
  const room = rooms.get(tripId);
  if (!room || room.size === 0) return;

  const excludeNum = excludeSid ? Number(excludeSid) : null;

  for (const ws of room) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN === 1
    // Exclude the specific socket that triggered the change
    if (excludeNum && socketId.get(ws) === excludeNum) continue;
    ws.send(JSON.stringify({ type: eventType, tripId, ...payload }));
  }
}

/** Send a message to all sockets belonging to a specific user (e.g., for trip invitations). */
function broadcastToUser(userId: number, payload: Record<string, unknown>, excludeSid?: number | string): void {
  if (!wss) return;
  const excludeNum = excludeSid ? Number(excludeSid) : null;
  for (const ws of wss.clients) {
    const nws = ws as NomadWebSocket;
    if (nws.readyState !== 1) continue;
    if (excludeNum && socketId.get(nws) === excludeNum) continue;
    const user = socketUser.get(nws);
    if (user && user.id === userId) {
      nws.send(JSON.stringify(payload));
    }
  }
}

function getOnlineUserIds(): Set<number> {
  const ids = new Set<number>();
  if (!wss) return ids;
  for (const ws of wss.clients) {
    const nws = ws as NomadWebSocket;
    if (nws.readyState !== 1) continue;
    const user = socketUser.get(nws);
    if (user) ids.add(user.id);
  }
  return ids;
}

export { setupWebSocket, broadcast, broadcastToUser, getOnlineUserIds };
