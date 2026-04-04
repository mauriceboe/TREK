import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './config';
import { db, canAccessTrip } from './db/database';
import { User } from './types';
import http from 'http';
import type { Request } from 'express';
import { getRequestToken } from './middleware/auth';
import { verifyConvexToken } from './lib/convexAuth';

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

async function authenticateSocketToken(token: string): Promise<User | undefined> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    return db.prepare(
      'SELECT id, username, email, role, better_auth_user_id FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
  } catch {
    const payload = await verifyConvexToken(token);
    const subject = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    if (!subject && !email) return undefined;
    return db.prepare(
      `SELECT id, username, email, role, better_auth_user_id
       FROM users
       WHERE better_auth_user_id = ?
          OR LOWER(email) = LOWER(?)
       LIMIT 1`
    ).get(subject, email) as User | undefined;
  }
}

/** Attaches a WebSocket server with JWT auth, room-based trip channels, and heartbeat keep-alive. */
function setupWebSocket(server: http.Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

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

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    const nws = ws as NomadWebSocket;
    const url = new URL(req.url!, 'http://localhost');
    const token = getRequestToken(req as unknown as Request) || url.searchParams.get('token');

    if (!token) {
      nws.close(4001, 'Authentication required');
      return;
    }

    let user: User | undefined;
    try {
      user = await authenticateSocketToken(token);
      if (!user) {
        nws.close(4001, 'User not found');
        return;
      }
    } catch (err: unknown) {
      nws.close(4001, 'Invalid or expired token');
      return;
    }

    nws.isAlive = true;
    const sid = nextSocketId++;
    socketId.set(nws, sid);
    socketUser.set(nws, user);
    socketRooms.set(nws, new Set());
    nws.send(JSON.stringify({ type: 'welcome', socketId: sid }));

    nws.on('pong', () => { nws.isAlive = true; });

    nws.on('message', (data) => {
      let msg: { type: string; tripId?: number | string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

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
