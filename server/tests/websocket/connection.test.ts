/**
 * WebSocket connection tests.
 * Covers WS-001 to WS-006, WS-008 to WS-010.
 *
 * Starts a real HTTP server on a random port and connects via the `ws` library.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import WebSocket from 'ws';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip } from '../helpers/factories';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';
import { setupWebSocket } from '../../src/websocket';
import { createEphemeralToken } from '../../src/services/ephemeralTokens';

let server: http.Server;
let wsUrl: string;

beforeAll(async () => {
  createTables(testDb);
  runMigrations(testDb);

  const app = createApp();
  server = http.createServer(app);
  setupWebSocket(server);

  await new Promise<void>(resolve => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => err ? reject(err) : resolve())
  );
  testDb.close();
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

/** Buffered WebSocket wrapper that never drops messages. */
class WsClient {
  private ws: WebSocket;
  private buffer: any[] = [];
  private waiters: Array<(msg: any) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.buffer.push(msg);
      }
    });
  }

  next(timeoutMs = 3000): Promise<any> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error('Message timeout'));
      }, timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  send(msg: object) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }

  /** Wait for any message matching predicate within timeout. */
  waitFor(predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    // Check buffer first
    const idx = this.buffer.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(this.buffer.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs);
      const handler = (msg: any) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        } else {
          this.buffer.push(msg);
          // re-register
          this.waiters.push(handler);
        }
      };
      this.waiters.push(handler);
    });
  }

  /** Collect messages for a given duration. */
  collectFor(ms: number): Promise<any[]> {
    return new Promise(resolve => {
      const msgs: any[] = [...this.buffer.splice(0)];
      const handleMsg = (msg: any) => msgs.push(msg);
      this.ws.on('message', (data) => handleMsg(JSON.parse(data.toString())));
      setTimeout(() => resolve(msgs), ms);
    });
  }
}

function connectWs(token?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const url = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
    const ws = new WebSocket(url);
    const client = new WsClient(ws);
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    ws.once('close', (code) => {
      if (code === 4001) reject(new Error(`WS closed with 4001`));
    });
  });
}

describe('WS connection', () => {
  it('WS-001 — connects with valid ephemeral token and receives welcome', async () => {
    const { user } = createUser(testDb);
    const token = createEphemeralToken(user.id, 'ws')!;

    const client = await connectWs(token);
    try {
      const msg = await client.next();
      expect(msg.type).toBe('welcome');
      expect(typeof msg.socketId).toBe('number');
    } finally {
      client.close();
    }
  });

  it('WS-002 — connecting without token closes with code 4001', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on('error', () => {});
    });
  });

  it('WS-003 — connecting with invalid token closes with code 4001', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${wsUrl}?token=invalid-token-xyz`);
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on('error', () => {});
    });
  });
});

describe('WS rooms', () => {
  it('WS-004 — join trip room receives joined confirmation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const token = createEphemeralToken(user.id, 'ws')!;

    const client = await connectWs(token);
    try {
      await client.next(); // welcome

      client.send({ type: 'join', tripId: trip.id });
      const msg = await client.next();
      expect(msg.type).toBe('joined');
      expect(msg.tripId).toBe(trip.id);
    } finally {
      client.close();
    }
  });

  it('WS-005 — join trip without access receives error', async () => {
    const { user } = createUser(testDb);
    const { user: otherUser } = createUser(testDb);
    const trip = createTrip(testDb, otherUser.id); // trip owned by otherUser
    const token = createEphemeralToken(user.id, 'ws')!;

    const client = await connectWs(token);
    try {
      await client.next(); // welcome

      client.send({ type: 'join', tripId: trip.id });
      const msg = await client.next();
      expect(msg.type).toBe('error');
      expect(msg.message).toMatch(/access denied/i);
    } finally {
      client.close();
    }
  });

  it('WS-006 — leave room receives left confirmation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const token = createEphemeralToken(user.id, 'ws')!;

    const client = await connectWs(token);
    try {
      await client.next(); // welcome

      client.send({ type: 'join', tripId: trip.id });
      await client.next(); // joined

      client.send({ type: 'leave', tripId: trip.id });
      const msg = await client.next();
      expect(msg.type).toBe('left');
      expect(msg.tripId).toBe(trip.id);
    } finally {
      client.close();
    }
  });
});

describe('WS rate limiting', () => {
  it('WS-008 — exceeding 30 messages per window triggers rate-limit error', async () => {
    const { user } = createUser(testDb);
    const token = createEphemeralToken(user.id, 'ws')!;

    const client = await connectWs(token);
    try {
      await client.next(); // welcome

      // Send 35 messages quickly — at least one should trigger rate limit
      for (let i = 0; i < 35; i++) {
        client.send({ type: 'ping' });
      }

      // Collect for up to 2s and find a rate-limit error
      const msgs = await client.collectFor(1500);
      const rateLimitMsg = msgs.find((m: any) => m.type === 'error' && m.message?.includes('Rate limit'));
      expect(rateLimitMsg).toBeDefined();
    } finally {
      client.close();
    }
  });
});
