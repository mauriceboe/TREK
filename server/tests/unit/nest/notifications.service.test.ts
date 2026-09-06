/**
 * Unit tests for the DI-native NotificationsService.send() — NSVC-001 through
 * NSVC-019, NTFY-SVCB-*, NSVC-PLUG-001..007 (moved 1:1 from the legacy
 * tests/unit/services/notificationService.test.ts when the send dispatcher +
 * in-app SQL folded into nest/notifications), plus the NSVC-020 bridge
 * delegation pin. Uses a real in-memory SQLite DB so the SQL is exercised
 * faithfully; email/webhook/ntfy transports are mocked at the nodemailer/fetch
 * boundary.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/nest/common/crypto/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string) => v,
  encrypt_api_key: (v: string) => v,
}));

const { sendMailMock, fetchMock, broadcastMock, logErrorMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn().mockResolvedValue({ accepted: ['test@test.com'] }),
  fetchMock: vi.fn(),
  broadcastMock: vi.fn(),
  logErrorMock: vi.fn(),
}));
vi.mock('../../../src/nest/audit/audit-log.logger', () => ({
  LOG_LEVEL: 'error',
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: logErrorMock,
  logWarn: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

vi.stubGlobal('fetch', fetchMock);
// RealtimeService imports both names from src/websocket, so the mock must
// export both even though only broadcastToUser is asserted here.
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: broadcastMock }));
vi.mock('../../../src/utils/ssrfGuard', () => {
  class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SsrfBlockedError';
    }
  }
  const checkSsrf = vi.fn(async (_url: string) => ({ allowed: true, isPrivate: false, resolvedIp: '1.2.3.4' }));
  return {
    checkSsrf,
    createPinnedDispatcher: vi.fn(() => ({})),
    SsrfBlockedError,
    // The notification transports go through safeFetchFollow now, so the fake
    // has to guard and then hand over to the stubbed fetch the way it does.
    safeFetchFollow: vi.fn(async (url: string, init?: RequestInit) => {
      const verdict = await checkSsrf(url);
      if (!verdict.allowed) {
        throw new SsrfBlockedError((verdict as { error?: string }).error ?? 'Request blocked by SSRF guard');
      }
      return fetch(url, init);
    }),
  };
});

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createAdmin, setAppSetting, setNotificationChannels, disableNotificationPref } from '../../helpers/factories';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import { NotificationsService, type NotificationPayload } from '../../../src/nest/notifications/notifications.service';
import { setPluginChannelSource } from '../../../src/nest/notifications/channel-registry';
// The channel interface lives in notification-events; channel-registry only imports
// it for its own signatures and never re-exported it.
import type { ExternalChannel } from '../../../src/nest/notifications/notification-events';
import { makeNotificationsService, makeNotificationPreferencesService } from '../../helpers/notifications';

const notifications = makeNotificationsService(new DatabaseService(testDb));
const send = (payload: NotificationPayload) => notifications.send(payload);

// ── Helpers ────────────────────────────────────────────────────────────────

function setSmtp(): void {
  setAppSetting(testDb, 'smtp_host', 'mail.test.com');
  setAppSetting(testDb, 'smtp_port', '587');
  setAppSetting(testDb, 'smtp_from', 'trek@test.com');
}

function setUserWebhookUrl(userId: number, url = 'https://hooks.test.com/webhook'): void {
  testDb.prepare("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, 'webhook_url', ?)").run(userId, url);
}

function setAdminWebhookUrl(url = 'https://hooks.test.com/admin-webhook'): void {
  setAppSetting(testDb, 'admin_webhook_url', url);
}

function getInAppNotifications(recipientId: number) {
  return testDb.prepare('SELECT * FROM notifications WHERE recipient_id = ? ORDER BY id').all(recipientId) as Array<{
    id: number;
    type: string;
    scope: string;
    navigate_target: string | null;
    navigate_text_key: string | null;
    title_key: string;
    text_key: string;
  }>;
}

function countAllNotifications(): number {
  return (testDb.prepare('SELECT COUNT(*) as c FROM notifications').get() as { c: number }).c;
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  sendMailMock.mockClear();
  fetchMock.mockClear();
  broadcastMock.mockClear();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
});

afterAll(() => {
  testDb.close();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-channel dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — multi-channel dispatch', () => {
  it('NSVC-001 — dispatches to all 3 channels (inapp, email, webhook) when all are active', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setUserWebhookUrl(user.id);
    setNotificationChannels(testDb, 'email,webhook');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Paris', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(countAllNotifications()).toBe(1);
  });

  it('NSVC-002 — skips email/webhook when no channels are active (in-app still fires)', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setUserWebhookUrl(user.id);
    setNotificationChannels(testDb, 'none');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Rome', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(countAllNotifications()).toBe(1);
  });

  it('NSVC-003 — sends only email when only email channel is active', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setNotificationChannels(testDb, 'email');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Berlin', user.id)).lastInsertRowid as number;

    await send({ event: 'booking_change', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Berlin', actor: 'Bob', booking: 'Hotel', type: 'hotel', tripId: String(tripId) } });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-user preference filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — per-user preference filtering', () => {
  it('NSVC-004 — skips email for a user who disabled trip_invite on email channel', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setNotificationChannels(testDb, 'email');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);
    disableNotificationPref(testDb, user.id, 'trip_invite', 'email');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Paris', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    expect(sendMailMock).not.toHaveBeenCalled();
    // in-app still fires
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('NSVC-005 — skips in-app for a user who disabled the event on inapp channel', async () => {
    const { user } = createUser(testDb);
    setNotificationChannels(testDb, 'none');
    disableNotificationPref(testDb, user.id, 'collab_message', 'inapp');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Trip', user.id)).lastInsertRowid as number;

    await send({ event: 'collab_message', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Trip', actor: 'Alice', tripId: String(tripId) } });

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(countAllNotifications()).toBe(0);
  });

  it('NSVC-006 — still sends webhook when user has email disabled but webhook enabled', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setUserWebhookUrl(user.id);
    setNotificationChannels(testDb, 'email,webhook');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);
    disableNotificationPref(testDb, user.id, 'trip_invite', 'email');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Paris', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — recipient resolution', () => {
  it('NSVC-007 — trip scope sends to owner + members, excludes actorId', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member1 } = createUser(testDb);
    const { user: member2 } = createUser(testDb);
    const { user: actor } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Trip', owner.id)).lastInsertRowid as number;
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, member1.id);
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, member2.id);
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, actor.id);

    await send({ event: 'booking_change', actorId: actor.id, scope: 'trip', targetId: tripId, params: { trip: 'Trip', actor: 'Actor', booking: 'Hotel', type: 'hotel', tripId: String(tripId) } });

    // Owner, member1, member2 get it; actor is excluded
    expect(countAllNotifications()).toBe(3);
    const recipients = (testDb.prepare('SELECT recipient_id FROM notifications ORDER BY recipient_id').all() as { recipient_id: number }[]).map(r => r.recipient_id);
    expect(recipients).toContain(owner.id);
    expect(recipients).toContain(member1.id);
    expect(recipients).toContain(member2.id);
    expect(recipients).not.toContain(actor.id);
  });

  it('NSVC-007b — guests are never notified, on trip or user scope (#1362)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Trip', owner.id)).lastInsertRowid as number;
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, member.id);
    // A guest joined into the trip — assignable, but has no inbox.
    const guestId = (testDb.prepare("INSERT INTO users (username, email, password_hash, role, is_guest) VALUES ('Guest', 'guest-x@guests.invalid', '', 'user', 1)").run()).lastInsertRowid as number;
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?)').run(tripId, guestId);

    await send({ event: 'booking_change', actorId: owner.id, scope: 'trip', targetId: tripId, params: { trip: 'Trip', actor: 'Owner', booking: 'Hotel', type: 'hotel', tripId: String(tripId) } });
    let recipients = (testDb.prepare('SELECT recipient_id FROM notifications').all() as { recipient_id: number }[]).map(r => r.recipient_id);
    expect(recipients).toContain(member.id);
    expect(recipients).not.toContain(guestId);

    // Even a direct user-scope notification (e.g. a todo assigned to the guest) is dropped.
    await send({ event: 'vacay_invite', actorId: owner.id, scope: 'user', targetId: guestId, params: { actor: 'owner@test.com', planId: '1' } });
    recipients = (testDb.prepare('SELECT recipient_id FROM notifications').all() as { recipient_id: number }[]).map(r => r.recipient_id);
    expect(recipients).not.toContain(guestId);
  });

  it('NSVC-008 — user scope sends to exactly one user', async () => {
    const { user: target } = createUser(testDb);
    const { user: other } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    await send({ event: 'vacay_invite', actorId: other.id, scope: 'user', targetId: target.id, params: { actor: 'other@test.com', planId: '42' } });

    expect(countAllNotifications()).toBe(1);
    const notif = testDb.prepare('SELECT recipient_id FROM notifications LIMIT 1').get() as { recipient_id: number };
    expect(notif.recipient_id).toBe(target.id);
  });

  it('NSVC-009 — admin scope sends to all admins (not regular users)', async () => {
    const { user: admin1 } = createAdmin(testDb);
    const { user: admin2 } = createAdmin(testDb);
    createUser(testDb); // regular user — should NOT receive
    setNotificationChannels(testDb, 'none');

    await send({ event: 'version_available', actorId: null, scope: 'admin', targetId: 0, params: { version: '2.0.0' } });

    expect(countAllNotifications()).toBe(2);
    const recipients = (testDb.prepare('SELECT recipient_id FROM notifications ORDER BY recipient_id').all() as { recipient_id: number }[]).map(r => r.recipient_id);
    expect(recipients).toContain(admin1.id);
    expect(recipients).toContain(admin2.id);
  });

  it('NSVC-010 — admin scope fires admin webhook URL when set', async () => {
    createAdmin(testDb);
    setAdminWebhookUrl();
    setNotificationChannels(testDb, 'none');

    await send({ event: 'version_available', actorId: null, scope: 'admin', targetId: 0, params: { version: '2.0.0' } });

    // Wait for fire-and-forget admin webhook
    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = fetchMock.mock.calls[0][0];
    expect(callUrl).toBe('https://hooks.test.com/admin-webhook');
  });

  it('NSVC-011 — does nothing when there are no recipients', async () => {
    // Trip with no members, sending as the trip owner (actor excluded from trip scope)
    const { user: owner } = createUser(testDb);
    setNotificationChannels(testDb, 'none');
    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Solo', owner.id)).lastInsertRowid as number;

    await send({ event: 'booking_change', actorId: owner.id, scope: 'trip', targetId: tripId, params: { trip: 'Solo', actor: 'owner@test.com', booking: 'Hotel', type: 'hotel', tripId: String(tripId) } });

    expect(countAllNotifications()).toBe(0);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-app notification content
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — in-app notification content', () => {
  it('NSVC-012 — creates navigate in-app notification with correct title/text/navigate keys', async () => {
    const { user } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: '42' } });

    const notifs = getInAppNotifications(user.id);
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe('navigate');
    expect(notifs[0].title_key).toBe('notif.trip_invite.title');
    expect(notifs[0].text_key).toBe('notif.trip_invite.text');
    expect(notifs[0].navigate_text_key).toBe('notif.action.view_trip');
    expect(notifs[0].navigate_target).toBe('/trips/42');
  });

  it('NSVC-013 — creates simple in-app notification when no navigate target is available', async () => {
    const { user } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    // vacay_invite without planId → no navigate target → simple type
    await send({ event: 'vacay_invite', actorId: null, scope: 'user', targetId: user.id, params: { actor: 'Alice' } });

    const notifs = getInAppNotifications(user.id);
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe('simple');
    expect(notifs[0].navigate_target).toBeNull();
  });

  it('NSVC-014 — navigate_target uses /admin for version_available event', async () => {
    const { user: admin } = createAdmin(testDb);
    setNotificationChannels(testDb, 'none');

    await send({ event: 'version_available', actorId: null, scope: 'admin', targetId: 0, params: { version: '9.9.9' } });

    const notifs = getInAppNotifications(admin.id);
    expect(notifs.length).toBe(1);
    expect(notifs[0].navigate_target).toBe('/admin');
    expect(notifs[0].title_key).toBe('notif.version_available.title');
  });

  it('NOTIF-RF-002 suppressed > 0 stores the textSuppressed key; 0 keeps the plain key', async () => {
    const { user: admin } = createAdmin(testDb);
    setNotificationChannels(testDb, 'none');

    await send({
      event: 'replica_failure',
      actorId: null,
      scope: 'admin',
      targetId: 0,
      params: { backend: 'minio', op: 'put', key: 'trips/1/a.jpg', error: 'ECONNRESET', suppressed: '3' },
    });

    await send({
      event: 'replica_failure',
      actorId: null,
      scope: 'admin',
      targetId: 0,
      params: { backend: 'minio', op: 'put', key: 'trips/1/b.jpg', error: 'ECONNRESET', suppressed: '0' },
    });

    const notifs = getInAppNotifications(admin.id);
    expect(notifs.length).toBe(2);
    expect(notifs[0].text_key).toBe('notif.replica_failure.textSuppressed');
    expect(notifs[1].text_key).toBe('notif.replica_failure.text');
  });

  it('NOTIF-RF-003 a missing suppressed param is NOT treated as suppressed (truthy guard, not just !== "0")', async () => {
    const { user: admin } = createAdmin(testDb);
    setNotificationChannels(testDb, 'none');

    await send({
      event: 'replica_failure',
      actorId: null,
      scope: 'admin',
      targetId: 0,
      params: { backend: 'minio', op: 'put', key: 'trips/1/c.jpg', error: 'ECONNRESET' },
    });

    const notifs = getInAppNotifications(admin.id);
    expect(notifs.length).toBe(1);
    expect(notifs[0].text_key).toBe('notif.replica_failure.text');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Email/webhook link generation
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — email/webhook links', () => {
  it('NSVC-015 — email subject and body are localized per recipient language', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setNotificationChannels(testDb, 'email');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);
    // Set user language to French
    testDb.prepare("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, 'language', 'fr')").run(user.id);

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Paris', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendMailMock.mock.calls[0][0];
    // French title for trip_invite should contain "Invitation"
    expect(mailArgs.subject).toContain('Invitation');
  });

  it('NSVC-016 — webhook payload includes link field when navigate target is available', async () => {
    const { user } = createUser(testDb);
    setUserWebhookUrl(user.id, 'https://hooks.test.com/generic-webhook');
    setNotificationChannels(testDb, 'webhook');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: '55' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Generic webhook — link should contain /trips/55
    expect(body.link).toContain('/trips/55');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boolean in-app type
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — boolean in-app type', () => {
  it('NSVC-017 — creates boolean in-app notification with callbacks when inApp.type override is boolean', async () => {
    const { user } = createUser(testDb);
    setNotificationChannels(testDb, 'none');

    await send({
      event: 'trip_invite',
      actorId: null,
      scope: 'user',
      targetId: user.id,
      params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: '1' },
      inApp: {
        type: 'boolean',
        positiveTextKey: 'notif.action.accept',
        negativeTextKey: 'notif.action.decline',
        positiveCallback: { action: 'test_approve', payload: { tripId: 1 } },
        negativeCallback: { action: 'test_deny', payload: { tripId: 1 } },
      },
    });

    const notifs = getInAppNotifications(user.id);
    expect(notifs.length).toBe(1);
    const row = notifs[0] as any;
    expect(row.type).toBe('boolean');
    expect(row.positive_callback).toContain('test_approve');
    expect(row.negative_callback).toContain('test_deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel failure resilience
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — channel failure resilience', () => {
  it('NSVC-018 — email failure does not prevent in-app or webhook delivery', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setUserWebhookUrl(user.id);
    setNotificationChannels(testDb, 'email,webhook');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);

    // Make email throw
    sendMailMock.mockRejectedValueOnce(new Error('SMTP connection refused'));

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Trip', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Trip', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    // In-app and webhook still fire despite email failure
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(countAllNotifications()).toBe(1);
  });

  it('NSVC-019 — webhook failure does not prevent in-app or email delivery', async () => {
    const { user } = createUser(testDb);
    setSmtp();
    setUserWebhookUrl(user.id);
    setNotificationChannels(testDb, 'email,webhook');
    testDb.prepare('UPDATE users SET email = ? WHERE id = ?').run('recipient@test.com', user.id);

    // Make webhook throw
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Trip', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Trip', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    // In-app and email still fire despite webhook failure
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(countAllNotifications()).toBe(1);
  });

});

// ── Ntfy dispatch ─────────────────────────────────────────────────────────────

function setUserNtfyTopic(userId: number, topic = 'my-trek-topic'): void {
  testDb.prepare("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, 'ntfy_topic', ?)").run(userId, topic);
}

function setAdminNtfyTopic(topic = 'trek-admin-alerts'): void {
  setAppSetting(testDb, 'admin_ntfy_topic', topic);
}

describe('send() — ntfy channel dispatch', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  });

  it('NTFY-SVCB-001 — ntfy fires when channel active and user has topic configured', async () => {
    const { user } = createUser(testDb);
    setUserNtfyTopic(user.id);
    setNotificationChannels(testDb, 'ntfy');
    const tripId = (testDb.prepare('INSERT INTO trips (title, user_id) VALUES (?, ?)').run('Tokyo', user.id)).lastInsertRowid as number;

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Tokyo', actor: 'Alice', invitee: 'Bob', tripId: String(tripId) } });

    const ntfyCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('ntfy.sh'));
    expect(ntfyCalls.length).toBeGreaterThan(0);
    // Header-based API: metadata in headers, body = plain text
    expect(ntfyCalls[0][1].headers['Priority']).toBe('4'); // trip_invite = high priority
    expect(ntfyCalls[0][1].headers['Tags']).toContain('loudspeaker');
  });

  it('NTFY-SVCB-002 — ntfy skips when channel not in active channels', async () => {
    const { user } = createUser(testDb);
    setUserNtfyTopic(user.id);
    setNotificationChannels(testDb, 'none');

    fetchMock.mockClear();
    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Paris', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    const ntfyCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('ntfy.sh'));
    expect(ntfyCalls.length).toBe(0);
  });

  it('NTFY-SVCB-003 — ntfy skips when user has no topic configured', async () => {
    const { user } = createUser(testDb);
    setNotificationChannels(testDb, 'ntfy');
    // No ntfy_topic set — resolveNtfyUrl requires a user topic, so it returns null

    fetchMock.mockClear();
    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    const ntfyCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('ntfy.sh'));
    expect(ntfyCalls.length).toBe(0);
  });

  it('NTFY-SVCB-005 — ntfy does not fall back to admin topic when user has no topic (#1608)', async () => {
    const { user } = createUser(testDb);
    setAdminNtfyTopic();
    setNotificationChannels(testDb, 'ntfy');

    fetchMock.mockClear();
    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Oslo', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    const ntfyCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('ntfy.sh'));
    expect(ntfyCalls.length).toBe(0);
  });

  it('NTFY-SVCB-004 — admin-scoped version_available fires admin ntfy topic', async () => {
    createAdmin(testDb);
    setAdminNtfyTopic();
    setNotificationChannels(testDb, 'none');

    fetchMock.mockClear();
    await send({ event: 'version_available', actorId: null, scope: 'admin', targetId: 0, params: { version: '3.0.0' } });

    const ntfyCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('ntfy.sh'));
    expect(ntfyCalls.length).toBeGreaterThan(0);
    expect(ntfyCalls[0][1].headers['Priority']).toBe('4'); // version_available = high priority
    expect(ntfyCalls[0][1].headers['Tags']).toContain('package');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin notification channels (hook:notification-channel)
// ─────────────────────────────────────────────────────────────────────────────

describe('send() — plugin notification channels', () => {
  const sendSpy = vi.fn();

  function installPluginChannel(over: Partial<ExternalChannel> = {}): void {
    sendSpy.mockClear();
    sendSpy.mockResolvedValue(undefined);
    setPluginChannelSource(() => [
      {
        id: 'plugin:gotify',
        source: 'plugin',
        label: 'Gotify',
        supportsEvent: (e: string) => e !== 'version_available' && e !== 'synology_session_cleared',
        isConfiguredFor: () => true,
        sendToUser: sendSpy,
        ...over,
      } as ExternalChannel,
    ]);
  }

  afterEach(() => setPluginChannelSource(null));

  it('NSVC-PLUG-001 — delivers to a plugin channel the admin enabled', async () => {
    const { user } = createUser(testDb);
    installPluginChannel();
    setNotificationChannels(testDb, 'plugin:gotify');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [recipientId, msg] = sendSpy.mock.calls[0];
    expect(recipientId).toBe(user.id);
    // The host renders the text — a channel plugin never touches i18n.
    expect(msg.event).toBe('trip_invite');
    expect(msg.title).toBeTruthy();
    expect(msg.body).toContain('Rome');
  });

  it('NSVC-PLUG-002 — delivers with NOTHING in notification_channels: enabling the plugin IS the opt-in', async () => {
    const { user } = createUser(testDb);
    installPluginChannel();
    setNotificationChannels(testDb, 'none');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    // A built-in always exists in the code, so it needs an explicit switch. A plugin
    // channel only exists because an admin installed and enabled that plugin — and
    // nothing can write a `plugin:` id into this CSV anyway, so requiring a second
    // opt-in meant the channel could never be turned on at all.
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('NSVC-PLUG-003 — skipped when the user opted out of this event on it', async () => {
    const { user } = createUser(testDb);
    installPluginChannel();
    setNotificationChannels(testDb, 'plugin:gotify');
    disableNotificationPref(testDb, user.id, 'trip_invite', 'plugin:gotify');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('NSVC-PLUG-004 — skipped when the user has not set their credentials', async () => {
    const { user } = createUser(testDb);
    installPluginChannel({ isConfiguredFor: () => false });
    setNotificationChannels(testDb, 'plugin:gotify');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('NSVC-PLUG-005 — a throwing plugin channel does not stop in-app or email delivery', async () => {
    const { user } = createUser(testDb);
    installPluginChannel({ sendToUser: vi.fn().mockRejectedValue(new Error('gotify is down')) });
    setSmtp();
    setNotificationChannels(testDb, 'email,plugin:gotify');
    sendMailMock.mockClear();

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(getInAppNotifications(user.id).length).toBe(1);
  });

  it('NSVC-PLUG-006 — never receives an admin-scoped event', async () => {
    createAdmin(testDb);
    // Even if a (malicious) channel claims to support it, ADMIN_SCOPED_EVENTS is
    // gated host-side: only a channel that bypasses the toggle (email) delivers those.
    installPluginChannel({ supportsEvent: () => true });
    setNotificationChannels(testDb, 'plugin:gotify');

    await send({ event: 'version_available', actorId: null, scope: 'admin', targetId: 0, params: { version: '3.0.0' } });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('NSVC-PLUG-007 — a channel that narrows its events only gets those', async () => {
    const { user } = createUser(testDb);
    installPluginChannel({ supportsEvent: (e: string) => e === 'booking_change' });
    setNotificationChannels(testDb, 'plugin:gotify');

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });
    expect(sendSpy).not.toHaveBeenCalled();

    await send({ event: 'booking_change', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', tripId: '1' } });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('NSVC-021 — a rejected channel dispatch logs the unwrapped Error message (fix-commit pin)', async () => {
    const { user } = createUser(testDb);
    installPluginChannel({ sendToUser: vi.fn().mockRejectedValue(new Error('gotify is down')) });
    setNotificationChannels(testDb, 'plugin:gotify');
    logErrorMock.mockClear();

    await send({ event: 'trip_invite', actorId: null, scope: 'user', targetId: user.id, params: { trip: 'Rome', actor: 'Alice', invitee: 'Bob', tripId: '1' } });

    const dispatchLog = logErrorMock.mock.calls.map(([msg]) => String(msg)).find(m => m.includes('channel dispatch failed'));
    // The legacy per-recipient log interpolated the raw reason ("Error: gotify
    // is down"); the admin path always unwrapped — now both do.
    expect(dispatchLog).toContain(': gotify is down');
    expect(dispatchLog).not.toContain('Error: gotify is down');
  });
});

// NSVC-020 pinned notifications.instance.ts, which died with the last
// cycle-dodge bridge — every consumer injects the container singleton now.
