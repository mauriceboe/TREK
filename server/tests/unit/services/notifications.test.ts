import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from 'vitest';

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
vi.stubGlobal('fetch', vi.fn());

// ssrfGuard is mocked per-test in the SSRF describe block; default passes all
vi.mock('../../../src/utils/ssrfGuard', () => ({
  checkSsrf: vi.fn(async () => ({ allowed: true, isPrivate: false, resolvedIp: '1.2.3.4' })),
  createPinnedDispatcher: vi.fn(() => ({})),
}));

import { getEventText, buildEmailHtml, buildWebhookBody, sendWebhook, sendNtfy, resolveNtfyUrl, type NtfyConfig } from '../../../src/services/notifications';
import { checkSsrf } from '../../../src/utils/ssrfGuard';
import { logError } from '../../../src/services/auditLog';

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

// ── SEC: XSS escaping in buildEmailHtml ──────────────────────────────────────

describe('buildEmailHtml XSS prevention (SEC-016)', () => {
  it('escapes HTML special characters in subject', () => {
    const html = buildEmailHtml('<script>alert(1)</script>', 'Body', 'en');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML special characters in body', () => {
    const html = buildEmailHtml('Subject', '<img src=x onerror=alert(1)>', 'en');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
  });

  it('escapes double quotes in subject to prevent attribute injection', () => {
    const html = buildEmailHtml('He said "hello"', 'Body', 'en');
    expect(html).toContain('&quot;');
    expect(html).not.toContain('"hello"');
  });

  it('escapes ampersands in body', () => {
    const html = buildEmailHtml('Subject', 'a & b', 'en');
    expect(html).toContain('&amp;');
    expect(html).not.toMatch(/>[^<]*a & b[^<]*</);
  });

  it('escapes user-controlled actor and preview in collab_message body', () => {
    const { body } = getEventText('en', 'collab_message', {
      trip: 'MyTrip',
      actor: '<evil>',
      preview: '<script>xss()</script>',
    });
    const html = buildEmailHtml('Subject', body, 'en');
    expect(html).not.toContain('<evil>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;evil&gt;');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── SEC: SSRF protection in sendWebhook ──────────────────────────────────────

describe('sendWebhook SSRF protection (SEC-017)', () => {
  const payload = { event: 'test', title: 'T', body: 'B' };

  beforeEach(() => {
    vi.mocked(logError).mockClear();
  });

  it('allows a public URL and calls fetch', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);
    vi.mocked(checkSsrf).mockResolvedValueOnce({ allowed: true, isPrivate: false, resolvedIp: '1.2.3.4' });

    const result = await sendWebhook('https://example.com/hook', payload);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('blocks loopback address and returns false', async () => {
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: true, resolvedIp: '127.0.0.1',
      error: 'Requests to loopback and link-local addresses are not allowed',
    });

    const result = await sendWebhook('http://localhost/secret', payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('SSRF'));
  });

  it('blocks cloud metadata endpoint (169.254.169.254) and returns false', async () => {
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: true, resolvedIp: '169.254.169.254',
      error: 'Requests to loopback and link-local addresses are not allowed',
    });

    const result = await sendWebhook('http://169.254.169.254/latest/meta-data', payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('SSRF'));
  });

  it('blocks private network addresses and returns false', async () => {
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: true, resolvedIp: '192.168.1.1',
      error: 'Requests to private/internal network addresses are not allowed',
    });

    const result = await sendWebhook('http://192.168.1.1/hook', payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('SSRF'));
  });

  it('blocks non-HTTP protocols', async () => {
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: false,
      error: 'Only HTTP and HTTPS URLs are allowed',
    });

    const result = await sendWebhook('file:///etc/passwd', payload);
    expect(result).toBe(false);
  });

  it('does not call fetch when SSRF check blocks the URL', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockClear();
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: true, resolvedIp: '127.0.0.1',
      error: 'blocked',
    });

    await sendWebhook('http://localhost/secret', payload);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

afterAll(() => vi.unstubAllGlobals());

// ── resolveNtfyUrl ────────────────────────────────────────────────────────────

describe('resolveNtfyUrl', () => {
  const adminCfg: NtfyConfig = { server: 'https://ntfy.sh', topic: 'admin-topic', token: null };

  it('uses admin server + admin topic when no user config', () => {
    expect(resolveNtfyUrl(adminCfg, null)).toBe('https://ntfy.sh/admin-topic');
  });

  it('uses user topic over admin topic', () => {
    const user: NtfyConfig = { server: null, topic: 'my-topic', token: null };
    expect(resolveNtfyUrl(adminCfg, user)).toBe('https://ntfy.sh/my-topic');
  });

  it('uses user server override', () => {
    const user: NtfyConfig = { server: 'https://ntfy.example.com', topic: 'my-topic', token: null };
    expect(resolveNtfyUrl(adminCfg, user)).toBe('https://ntfy.example.com/my-topic');
  });

  it('strips trailing slash from server', () => {
    const admin: NtfyConfig = { server: 'https://ntfy.sh/', topic: 'alerts', token: null };
    expect(resolveNtfyUrl(admin, null)).toBe('https://ntfy.sh/alerts');
  });

  it('returns null when no topic in admin or user config', () => {
    const noTopic: NtfyConfig = { server: 'https://ntfy.sh', topic: null, token: null };
    expect(resolveNtfyUrl(noTopic, null)).toBeNull();
  });

  it('falls back to https://ntfy.sh when no server configured', () => {
    const noServer: NtfyConfig = { server: null, topic: 'my-topic', token: null };
    expect(resolveNtfyUrl(noServer, null)).toBe('https://ntfy.sh/my-topic');
  });
});

// ── sendNtfy ─────────────────────────────────────────────────────────────────

describe('sendNtfy', () => {
  const ntfyUrl = 'https://ntfy.sh/trek-test';
  const payload = { event: 'trip_invite', title: 'Test Title', body: 'Test body' };

  beforeEach(() => {
    vi.mocked(logError).mockClear();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();
    vi.mocked(checkSsrf).mockResolvedValue({ allowed: true, isPrivate: false, resolvedIp: '1.2.3.4' });
  });

  it('NTFY-001 — sends POST to topic URL with plain text body and metadata in headers', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    const result = await sendNtfy(ntfyUrl, null, payload);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe(ntfyUrl);
    // Body should be plain text, not JSON
    expect(calledOpts.body).toBe('Test body');
    // Title, Priority, Tags go in headers
    expect(calledOpts.headers['Title']).toBe('Test Title');
    expect(calledOpts.headers['Priority']).toBe('4'); // trip_invite maps to priority 4
    expect(calledOpts.headers['Tags']).toContain('loudspeaker');
  });

  it('NTFY-002 — attaches Bearer token when token provided', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, 'my-secret-token', payload);

    const [, calledOpts] = mockFetch.mock.calls[0];
    expect(calledOpts.headers['Authorization']).toBe('Bearer my-secret-token');
  });

  it('NTFY-003 — no Authorization header when token is null', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, null, payload);

    const [, calledOpts] = mockFetch.mock.calls[0];
    expect(calledOpts.headers['Authorization']).toBeUndefined();
  });

  it('NTFY-004 — includes Click header when link is provided', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, null, { ...payload, link: 'https://trek.example.com/trips/5' });

    const [, calledOpts] = mockFetch.mock.calls[0];
    expect(calledOpts.headers['Click']).toBe('https://trek.example.com/trips/5');
  });

  it('NTFY-005 — SSRF guard blocks private URL and returns false', async () => {
    vi.mocked(checkSsrf).mockResolvedValueOnce({
      allowed: false, isPrivate: true, resolvedIp: '192.168.1.1',
      error: 'Requests to private/internal network addresses are not allowed',
    });

    const result = await sendNtfy('http://192.168.1.1/ntfy', null, payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('SSRF'));
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('NTFY-006 — HTTP non-2xx response returns false and logs error', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' } as never);

    const result = await sendNtfy(ntfyUrl, null, payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('403'));
  });

  it('NTFY-007 — network error returns false', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await sendNtfy(ntfyUrl, null, payload);
    expect(result).toBe(false);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining('Network failure'));
  });

  it('NTFY-008 — unknown event falls back to priority 3 and no Tags header', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, null, { event: 'unknown_event', title: 'T', body: 'B' });

    const [, calledOpts] = mockFetch.mock.calls[0];
    expect(calledOpts.headers['Priority']).toBe('3');
    expect(calledOpts.headers['Tags']).toBeUndefined(); // empty tags = no header
  });

  it('NTFY-009 — title with non-Latin-1 chars is RFC 2047 encoded', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, null, { ...payload, title: 'Buy →€ ticket' });

    const [, calledOpts] = mockFetch.mock.calls[0];
    const encoded = calledOpts.headers['Title'] as string;
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    const b64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Buy →€ ticket');
  });

  it('NTFY-010 — ASCII-only title is passed through verbatim', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' } as never);

    await sendNtfy(ntfyUrl, null, { ...payload, title: 'Simple ASCII title' });

    const [, calledOpts] = mockFetch.mock.calls[0];
    expect(calledOpts.headers['Title']).toBe('Simple ASCII title');
  });
});
