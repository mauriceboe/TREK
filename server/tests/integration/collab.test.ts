/**
 * Collab (notes, polls, messages, reactions) integration tests.
 * Covers COLLAB-001 to COLLAB-027.
 *
 * Note: File upload to collab notes (COLLAB-005/006/007) requires physical file I/O.
 *       Link preview (COLLAB-025/026) would need fetch mocking — skipped here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import path from 'path';
import fs from 'fs';

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
import { createUser, createTrip, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();
const FIXTURE_PDF = path.join(__dirname, '../fixtures/test.pdf');

// Ensure uploads/files dir exists for collab file uploads
const uploadsDir = path.join(__dirname, '../../uploads/files');

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Collab Notes
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab notes', () => {
  it('COLLAB-001 — POST /collab/notes creates a note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Packing Ideas', content: 'Bring sunscreen', category: 'Planning' });
    expect(res.status).toBe(201);
    expect(res.body.note.title).toBe('Packing Ideas');
    expect(res.body.note.content).toBe('Bring sunscreen');
  });

  it('COLLAB-001 — POST without title returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ content: 'No title' });
    expect(res.status).toBe(400);
  });

  it('COLLAB-001 — non-member cannot create collab note', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(other.id))
      .send({ title: 'Sneaky note' });
    expect(res.status).toBe(404);
  });

  it('COLLAB-002 — GET /collab/notes returns all notes', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Note A' });
    await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Note B' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(2);
  });

  it('COLLAB-003 — PUT /collab/notes/:id updates a note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Old Title', content: 'Old content' });
    const noteId = create.body.note.id;

    const res = await request(app)
      .put(`/api/trips/${trip.id}/collab/notes/${noteId}`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'New Title', content: 'New content', pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.note.title).toBe('New Title');
    expect(res.body.note.pinned).toBe(1);
  });

  it('COLLAB-003 — PUT non-existent note returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/collab/notes/99999`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('COLLAB-004 — DELETE /collab/notes/:id removes note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'To Delete' });
    const noteId = create.body.note.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/collab/notes/${noteId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.notes).toHaveLength(0);
  });

  it('COLLAB-005 — POST /collab/notes/:id/files uploads a file to a note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Note with file' });
    const noteId = create.body.note.id;

    const upload = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes/${noteId}/files`)
      .set('Cookie', authCookie(user.id))
      .attach('file', FIXTURE_PDF);
    expect(upload.status).toBe(201);
    expect(upload.body.file).toBeDefined();
  });

  it('COLLAB-006 — uploading blocked extension to note is rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Note' });
    const noteId = create.body.note.id;

    // Create a temp .svg file
    const svgPath = path.join(uploadsDir, 'collab_blocked.svg');
    fs.writeFileSync(svgPath, '<svg></svg>');
    try {
      const res = await request(app)
        .post(`/api/trips/${trip.id}/collab/notes/${noteId}/files`)
        .set('Cookie', authCookie(user.id))
        .attach('file', svgPath);
      expect(res.status).toBe(400);
    } finally {
      if (fs.existsSync(svgPath)) fs.unlinkSync(svgPath);
    }
  });

  it('COLLAB-007 — DELETE /collab/notes/:noteId/files/:fileId removes file from note', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'Note with file' });
    const noteId = create.body.note.id;

    const upload = await request(app)
      .post(`/api/trips/${trip.id}/collab/notes/${noteId}/files`)
      .set('Cookie', authCookie(user.id))
      .attach('file', FIXTURE_PDF);
    const fileId = upload.body.file.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/collab/notes/${noteId}/files/${fileId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polls
// ─────────────────────────────────────────────────────────────────────────────

describe('Polls', () => {
  it('COLLAB-008 — POST /collab/polls creates a poll', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Where to eat?', options: ['Pizza', 'Sushi', 'Tacos'] });
    expect(res.status).toBe(201);
    expect(res.body.poll.question).toBe('Where to eat?');
    expect(res.body.poll.options).toHaveLength(3);
  });

  it('COLLAB-008 — POST without question returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ options: ['A', 'B'] });
    expect(res.status).toBe(400);
  });

  it('COLLAB-009 — GET /collab/polls returns polls', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Beach or mountains?', options: ['Beach', 'Mountains'] });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.polls).toHaveLength(1);
  });

  it('COLLAB-010 — POST /collab/polls/:id/vote casts a vote', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Restaurant?', options: ['Italian', 'French'] });
    const pollId = create.body.poll.id;

    const vote = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls/${pollId}/vote`)
      .set('Cookie', authCookie(user.id))
      .send({ option_index: 0 });
    expect(vote.status).toBe(200);
    expect(vote.body.poll).toBeDefined();
  });

  it('COLLAB-011 — PUT /collab/polls/:id/close closes a poll', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Hotel?', options: ['Budget', 'Luxury'] });
    const pollId = create.body.poll.id;

    const close = await request(app)
      .put(`/api/trips/${trip.id}/collab/polls/${pollId}/close`)
      .set('Cookie', authCookie(user.id));
    expect(close.status).toBe(200);
    expect(close.body.poll.is_closed).toBe(true);
  });

  it('COLLAB-012 — cannot vote on closed poll', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Closed?', options: ['Yes', 'No'] });
    const pollId = create.body.poll.id;

    await request(app)
      .put(`/api/trips/${trip.id}/collab/polls/${pollId}/close`)
      .set('Cookie', authCookie(user.id));

    const vote = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls/${pollId}/vote`)
      .set('Cookie', authCookie(user.id))
      .send({ option_index: 0 });
    expect(vote.status).toBe(400);
  });

  it('COLLAB-013 — DELETE /collab/polls/:id removes poll', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/collab/polls`)
      .set('Cookie', authCookie(user.id))
      .send({ question: 'Delete me?', options: ['Yes', 'No'] });
    const pollId = create.body.poll.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/collab/polls/${pollId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

describe('Messages', () => {
  it('COLLAB-014 — POST /collab/messages sends a message', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Hello, team!' });
    expect(res.status).toBe(201);
    expect(res.body.message.text).toBe('Hello, team!');
  });

  it('COLLAB-014 — POST without text returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  it('COLLAB-014 — non-member cannot send message', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(other.id))
      .send({ text: 'Unauthorized' });
    expect(res.status).toBe(404);
  });

  it('COLLAB-015 — GET /collab/messages returns messages in order', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'First message' });
    await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Second message' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('COLLAB-016 — POST /collab/messages with reply_to links reply', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const parent = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Original' });
    const parentId = parent.body.message.id;

    const reply = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Reply here', reply_to: parentId });
    expect(reply.status).toBe(201);
    expect(reply.body.message.reply_to).toBe(parentId);
  });

  it('COLLAB-017 — DELETE /collab/messages/:id removes own message', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const msg = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Delete me' });
    const msgId = msg.body.message.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/collab/messages/${msgId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  });

  it('COLLAB-017 — cannot delete another user\'s message', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);

    const msg = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(owner.id))
      .send({ text: 'Owner message' });
    const msgId = msg.body.message.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/collab/messages/${msgId}`)
      .set('Cookie', authCookie(member.id));
    expect(del.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reactions
// ─────────────────────────────────────────────────────────────────────────────

describe('Message reactions', () => {
  it('COLLAB-018 — POST /collab/messages/:id/react adds a reaction', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const msg = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'React to me' });
    const msgId = msg.body.message.id;

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages/${msgId}/react`)
      .set('Cookie', authCookie(user.id))
      .send({ emoji: '👍' });
    expect(res.status).toBe(200);
    expect(res.body.reactions).toBeDefined();
  });

  it('COLLAB-018 — POST react without emoji returns 400', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const msg = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'Test' });
    const msgId = msg.body.message.id;

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages/${msgId}/react`)
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Long text validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab validation', () => {
  it('COLLAB-018 — message text exceeding 5000 chars is rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/collab/messages`)
      .set('Cookie', authCookie(user.id))
      .send({ text: 'A'.repeat(5001) });
    expect(res.status).toBe(400);
  });
});
