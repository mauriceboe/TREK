/**
 * Unit tests for MCP collab polls and chat tools (collab addon-gated):
 * list_collab_polls, create_collab_poll, vote_collab_poll, close_collab_poll,
 * delete_collab_poll, list_collab_messages, send_collab_message,
 * delete_collab_message, react_collab_message.
 * Resources: trek://trips/{tripId}/collab/polls, trek://trips/{tripId}/collab/messages.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

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
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

vi.mock('../../../src/services/adminService', () => ({
  isAddonEnabled: vi.fn().mockReturnValue(true),
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, parseResourceResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

async function withResourceHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: true });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// list_collab_polls
// ---------------------------------------------------------------------------

describe('Tool: list_collab_polls', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'list_collab_polls',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.polls)).toBe(true);
      expect(data.polls).toHaveLength(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_collab_polls', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// create_collab_poll
// ---------------------------------------------------------------------------

describe('Tool: create_collab_poll', () => {
  it('inserts poll with votes structure and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_collab_poll',
        arguments: {
          tripId: trip.id,
          question: 'Where should we eat?',
          options: ['Pizza', 'Sushi', 'Tacos'],
        },
      });
      const data = parseToolResult(result) as any;
      expect(data.poll).toBeDefined();
      expect(data.poll.question).toBe('Where should we eat?');
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:poll:created', expect.any(Object));
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_collab_poll',
        arguments: { tripId: trip.id, question: 'Q?', options: ['A', 'B'] },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_collab_poll',
        arguments: { tripId: trip.id, question: 'Q?', options: ['A', 'B'] },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// vote_collab_poll
// ---------------------------------------------------------------------------

describe('Tool: vote_collab_poll', () => {
  it('records vote and broadcasts collab:poll:voted', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Create a poll directly in the DB
    const pollId = (testDb.prepare(
      `INSERT INTO collab_polls (trip_id, user_id, question, options, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'Best city?', JSON.stringify(['Paris', 'Rome'])) as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'vote_collab_poll',
        arguments: { tripId: trip.id, pollId: Number(pollId), optionIndex: 0 },
      });
      const data = parseToolResult(result) as any;
      expect(data.poll).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:poll:voted', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'vote_collab_poll',
        arguments: { tripId: trip.id, pollId: 1, optionIndex: 0 },
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// close_collab_poll
// ---------------------------------------------------------------------------

describe('Tool: close_collab_poll', () => {
  it('sets closed flag and broadcasts collab:poll:closed', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const pollId = (testDb.prepare(
      `INSERT INTO collab_polls (trip_id, user_id, question, options, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'Vote now?', JSON.stringify(['Yes', 'No'])) as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'close_collab_poll',
        arguments: { tripId: trip.id, pollId: Number(pollId) },
      });
      const data = parseToolResult(result) as any;
      expect(data.poll).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:poll:closed', expect.any(Object));
    });
  });

  it('returns error for non-existent poll', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'close_collab_poll',
        arguments: { tripId: trip.id, pollId: 99999 },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'close_collab_poll', arguments: { tripId: trip.id, pollId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_collab_poll
// ---------------------------------------------------------------------------

describe('Tool: delete_collab_poll', () => {
  it('removes poll and broadcasts collab:poll:deleted', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const pollId = (testDb.prepare(
      `INSERT INTO collab_polls (trip_id, user_id, question, options, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'Delete me?', JSON.stringify(['Yes', 'No'])) as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_collab_poll',
        arguments: { tripId: trip.id, pollId: Number(pollId) },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:poll:deleted', expect.objectContaining({ pollId: Number(pollId) }));
      expect(testDb.prepare('SELECT id FROM collab_polls WHERE id = ?').get(Number(pollId))).toBeUndefined();
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_collab_poll', arguments: { tripId: trip.id, pollId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// list_collab_messages
// ---------------------------------------------------------------------------

describe('Tool: list_collab_messages', () => {
  it('returns empty array initially', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'list_collab_messages',
        arguments: { tripId: trip.id },
      });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.messages)).toBe(true);
      expect(data.messages).toHaveLength(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_collab_messages', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// send_collab_message
// ---------------------------------------------------------------------------

describe('Tool: send_collab_message', () => {
  it('inserts message and broadcasts collab:message:created', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'send_collab_message',
        arguments: { tripId: trip.id, text: 'Hello team!' },
      });
      const data = parseToolResult(result) as any;
      expect(data.message).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:message:created', expect.any(Object));
    });
  });

  it('sends message with replyTo when parent exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const msgId = (testDb.prepare(
      `INSERT INTO collab_messages (trip_id, user_id, text, created_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'Original message') as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'send_collab_message',
        arguments: { tripId: trip.id, text: 'Reply here', replyTo: Number(msgId) },
      });
      const data = parseToolResult(result) as any;
      expect(data.message).toBeDefined();
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'send_collab_message',
        arguments: { tripId: trip.id, text: 'Hello!' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'send_collab_message', arguments: { tripId: trip.id, text: 'Hi' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_collab_message
// ---------------------------------------------------------------------------

describe('Tool: delete_collab_message', () => {
  it('soft-deletes message and broadcasts collab:message:deleted', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const msgId = (testDb.prepare(
      `INSERT INTO collab_messages (trip_id, user_id, text, created_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'To be deleted') as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_collab_message',
        arguments: { tripId: trip.id, messageId: Number(msgId) },
      });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:message:deleted', expect.any(Object));
    });
  });

  it('returns error when message belongs to different user', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Add other as trip member
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(trip.id, other.id);
    const msgId = (testDb.prepare(
      `INSERT INTO collab_messages (trip_id, user_id, text, created_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'Owner message') as any).lastInsertRowid;

    await withHarness(other.id, async (h) => {
      const result = await h.client.callTool({
        name: 'delete_collab_message',
        arguments: { tripId: trip.id, messageId: Number(msgId) },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_collab_message', arguments: { tripId: trip.id, messageId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// react_collab_message
// ---------------------------------------------------------------------------

describe('Tool: react_collab_message', () => {
  it('toggles reaction and broadcasts collab:message:reacted', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const msgId = (testDb.prepare(
      `INSERT INTO collab_messages (trip_id, user_id, text, created_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(trip.id, user.id, 'React to me') as any).lastInsertRowid;

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'react_collab_message',
        arguments: { tripId: trip.id, messageId: Number(msgId), emoji: '👍' },
      });
      const data = parseToolResult(result) as any;
      expect(data.reactions).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'collab:message:reacted', expect.any(Object));
    });
  });

  it('returns error for non-existent message', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'react_collab_message',
        arguments: { tripId: trip.id, messageId: 99999, emoji: '👍' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'react_collab_message', arguments: { tripId: trip.id, messageId: 1, emoji: '👍' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe('Resource: trek://trips/{tripId}/collab/polls', () => {
  it('returns polls list', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/collab/polls` });
      const data = parseResourceResult(result) as any;
      expect(Array.isArray(data)).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/collab/polls` });
      const data = parseResourceResult(result) as any;
      expect(data.error).toBeDefined();
    });
  });
});

describe('Resource: trek://trips/{tripId}/collab/messages', () => {
  it('returns messages list', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: `trek://trips/${trip.id}/collab/messages` });
      const data = parseResourceResult(result) as any;
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
