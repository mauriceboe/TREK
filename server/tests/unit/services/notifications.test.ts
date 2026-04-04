import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/db/database', () => ({
  db: { prepare: () => ({ get: vi.fn(() => undefined), all: vi.fn(() => []) }) },
}));
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: vi.fn((v) => v),
  maybe_encrypt_api_key: vi.fn((v) => v),
}));
vi.mock('../../../src/services/auditLog', () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  writeAudit: vi.fn(),
  getClientIp: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail: vi.fn() })) } }));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import { getEventText, buildEmailHtml, buildWebhookBody } from '../../../src/services/notifications';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── getEventText ─────────────────────────────────────────────────────────────

describe('getEventText', () => {
  const params = {
    trip: 'Tokyo Adventure',
    actor: 'Alice',
    invitee: 'Bob',
    booking: 'Hotel Sakura',
    type: 'hotel',
    count: '5',
    preview: 'See you there!',
    category: 'Clothing',
  };

  it('returns English title and body for lang=en', () => {
    const result = getEventText('en', 'trip_invite', params);
    expect(result.title).toBeTruthy();
    expect(result.body).toBeTruthy();
    expect(result.title).toContain('Tokyo Adventure');
    expect(result.body).toContain('Alice');
  });

  it('returns German text for lang=de', () => {
    const result = getEventText('de', 'trip_invite', params);
    expect(result.title).toContain('Tokyo Adventure');
    // German version uses "Einladung"
    expect(result.title).toContain('Einladung');
  });

  it('falls back to English for unknown language code', () => {
    const en = getEventText('en', 'trip_invite', params);
    const unknown = getEventText('xx', 'trip_invite', params);
    expect(unknown.title).toBe(en.title);
    expect(unknown.body).toBe(en.body);
  });

  it('interpolates params into trip_invite correctly', () => {
    const result = getEventText('en', 'trip_invite', params);
    expect(result.title).toContain('Tokyo Adventure');
    expect(result.body).toContain('Alice');
    expect(result.body).toContain('Bob');
  });

  it('all 7 event types produce non-empty title and body in English', () => {
    const events = ['trip_invite', 'booking_change', 'trip_reminder', 'vacay_invite', 'photos_shared', 'collab_message', 'packing_tagged'] as const;
    for (const event of events) {
      const result = getEventText('en', event, params);
      expect(result.title, `title for ${event}`).toBeTruthy();
      expect(result.body, `body for ${event}`).toBeTruthy();
    }
  });

  it('all 7 event types produce non-empty title and body in German', () => {
    const events = ['trip_invite', 'booking_change', 'trip_reminder', 'vacay_invite', 'photos_shared', 'collab_message', 'packing_tagged'] as const;
    for (const event of events) {
      const result = getEventText('de', event, params);
      expect(result.title, `de title for ${event}`).toBeTruthy();
      expect(result.body, `de body for ${event}`).toBeTruthy();
    }
  });
});

// ── buildWebhookBody ─────────────────────────────────────────────────────────

describe('buildWebhookBody', () => {
  const payload = {
    event: 'trip_invite',
    title: 'Trip Invite',
    body: 'Alice invited you',
    tripName: 'Tokyo Adventure',
  };

  it('Discord URL produces embeds array format', () => {
    const body = JSON.parse(buildWebhookBody('https://discord.com/api/webhooks/123/abc', payload));
    expect(body).toHaveProperty('embeds');
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(body.embeds[0]).toHaveProperty('title');
    expect(body.embeds[0]).toHaveProperty('description', payload.body);
    expect(body.embeds[0]).toHaveProperty('color');
    expect(body.embeds[0]).toHaveProperty('footer');
    expect(body.embeds[0]).toHaveProperty('timestamp');
  });

  it('Discord embed title is prefixed with compass emoji', () => {
    const body = JSON.parse(buildWebhookBody('https://discord.com/api/webhooks/123/abc', payload));
    expect(body.embeds[0].title).toContain('📍');
    expect(body.embeds[0].title).toContain(payload.title);
  });

  it('Discord embed footer contains trip name when provided', () => {
    const body = JSON.parse(buildWebhookBody('https://discord.com/api/webhooks/123/abc', payload));
    expect(body.embeds[0].footer.text).toContain('Tokyo Adventure');
  });

  it('Discord embed footer defaults to TREK when no trip name', () => {
    const noTrip = { ...payload, tripName: undefined };
    const body = JSON.parse(buildWebhookBody('https://discord.com/api/webhooks/123/abc', noTrip));
    expect(body.embeds[0].footer.text).toBe('TREK');
  });

  it('discordapp.com URL is also detected as Discord', () => {
    const body = JSON.parse(buildWebhookBody('https://discordapp.com/api/webhooks/123/abc', payload));
    expect(body).toHaveProperty('embeds');
  });

  it('Slack URL produces text field format', () => {
    const body = JSON.parse(buildWebhookBody('https://hooks.slack.com/services/X/Y/Z', payload));
    expect(body).toHaveProperty('text');
    expect(body.text).toContain(payload.title);
    expect(body.text).toContain(payload.body);
  });

  it('Slack text includes italic trip name when provided', () => {
    const body = JSON.parse(buildWebhookBody('https://hooks.slack.com/services/X/Y/Z', payload));
    expect(body.text).toContain('Tokyo Adventure');
  });

  it('Slack text omits trip name when not provided', () => {
    const noTrip = { ...payload, tripName: undefined };
    const body = JSON.parse(buildWebhookBody('https://hooks.slack.com/services/X/Y/Z', noTrip));
    // Should not contain the trip name string
    expect(body.text).not.toContain('Tokyo Adventure');
  });

  it('generic URL produces plain JSON with original fields plus timestamp and source', () => {
    const body = JSON.parse(buildWebhookBody('https://mywebhook.example.com/hook', payload));
    expect(body).toHaveProperty('event', payload.event);
    expect(body).toHaveProperty('title', payload.title);
    expect(body).toHaveProperty('body', payload.body);
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('source', 'TREK');
  });
});

// ── buildEmailHtml ────────────────────────────────────────────────────────────

describe('buildEmailHtml', () => {
  it('returns a string containing <!DOCTYPE html>', () => {
    const html = buildEmailHtml('Test Subject', 'Test body text', 'en');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('contains the subject text', () => {
    const html = buildEmailHtml('My Email Subject', 'Some body', 'en');
    expect(html).toContain('My Email Subject');
  });

  it('contains the body text', () => {
    const html = buildEmailHtml('Subject', 'Hello world, this is the body!', 'en');
    expect(html).toContain('Hello world, this is the body!');
  });

  it('uses English i18n strings for lang=en', () => {
    const html = buildEmailHtml('Subject', 'Body', 'en');
    expect(html).toContain('notifications enabled in TREK');
  });

  it('uses German i18n strings for lang=de', () => {
    const html = buildEmailHtml('Subject', 'Body', 'de');
    expect(html).toContain('TREK aktiviert');
  });

  it('falls back to English i18n for unknown language', () => {
    const en = buildEmailHtml('Subject', 'Body', 'en');
    const unknown = buildEmailHtml('Subject', 'Body', 'xx');
    // Both should have the same footer text
    expect(unknown).toContain('notifications enabled in TREK');
  });
});
