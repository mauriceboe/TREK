"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupWebSocket = setupWebSocket;
exports.broadcast = broadcast;
exports.broadcastToUser = broadcastToUser;
exports.getOnlineUserIds = getOnlineUserIds;
const ws_1 = require("ws");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("./config");
const database_1 = require("./db/database");
// Room management: tripId -> Set<WebSocket>
const rooms = new Map();
// Track which rooms each socket is in
const socketRooms = new WeakMap();
// Track user info per socket
const socketUser = new WeakMap();
// Track unique socket ID
const socketId = new WeakMap();
let nextSocketId = 1;
let wss = null;
/** Attaches a WebSocket server with JWT auth, room-based trip channels, and heartbeat keep-alive. */
function setupWebSocket(server) {
    wss = new ws_1.WebSocketServer({ server, path: '/ws' });
    const HEARTBEAT_INTERVAL = 30000; // 30 seconds
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            const nws = ws;
            if (nws.isAlive === false)
                return nws.terminate();
            nws.isAlive = false;
            nws.ping();
        });
    }, HEARTBEAT_INTERVAL);
    wss.on('close', () => clearInterval(heartbeat));
    wss.on('connection', (ws, req) => {
        const nws = ws;
        // Extract token from query param
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');
        if (!token) {
            nws.close(4001, 'Authentication required');
            return;
        }
        let user;
        try {
            const decoded = jsonwebtoken_1.default.verify(token, config_1.JWT_SECRET);
            user = database_1.db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id);
            if (!user) {
                nws.close(4001, 'User not found');
                return;
            }
        }
        catch (err) {
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
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (msg.type === 'join' && msg.tripId) {
                const tripId = Number(msg.tripId);
                // Verify the user has access to this trip
                if (!(0, database_1.canAccessTrip)(tripId, user.id)) {
                    nws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
                    return;
                }
                // Add to room
                if (!rooms.has(tripId))
                    rooms.set(tripId, new Set());
                rooms.get(tripId).add(nws);
                socketRooms.get(nws).add(tripId);
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
function leaveRoom(ws, tripId) {
    const room = rooms.get(tripId);
    if (room) {
        room.delete(ws);
        if (room.size === 0)
            rooms.delete(tripId);
    }
    const myRooms = socketRooms.get(ws);
    if (myRooms)
        myRooms.delete(tripId);
}
/**
 * Broadcast an event to all sockets in a trip room, optionally excluding a socket.
 */
function broadcast(tripId, eventType, payload, excludeSid) {
    tripId = Number(tripId);
    const room = rooms.get(tripId);
    if (!room || room.size === 0)
        return;
    const excludeNum = excludeSid ? Number(excludeSid) : null;
    for (const ws of room) {
        if (ws.readyState !== 1)
            continue; // WebSocket.OPEN === 1
        // Exclude the specific socket that triggered the change
        if (excludeNum && socketId.get(ws) === excludeNum)
            continue;
        ws.send(JSON.stringify({ type: eventType, tripId, ...payload }));
    }
}
/** Send a message to all sockets belonging to a specific user (e.g., for trip invitations). */
function broadcastToUser(userId, payload, excludeSid) {
    if (!wss)
        return;
    const excludeNum = excludeSid ? Number(excludeSid) : null;
    for (const ws of wss.clients) {
        const nws = ws;
        if (nws.readyState !== 1)
            continue;
        if (excludeNum && socketId.get(nws) === excludeNum)
            continue;
        const user = socketUser.get(nws);
        if (user && user.id === userId) {
            nws.send(JSON.stringify(payload));
        }
    }
}
function getOnlineUserIds() {
    const ids = new Set();
    if (!wss)
        return ids;
    for (const ws of wss.clients) {
        const nws = ws;
        if (nws.readyState !== 1)
            continue;
        const user = socketUser.get(nws);
        if (user)
            ids.add(user.id);
    }
    return ids;
}
//# sourceMappingURL=websocket.js.map