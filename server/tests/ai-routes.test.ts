import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-fetch
const mockFetch = vi.fn();
vi.mock('node-fetch', () => ({ default: mockFetch }));

// Track app_settings
const appSettings = new Map<string, string>();

// Mock database
const mockCanAccessTrip = vi.fn(() => true);
vi.mock('../src/db/database', () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('app_settings')) {
          const key = args[0] as string;
          const val = appSettings.get(key);
          return val ? { value: val } : undefined;
        }
        if (sql.includes('FROM trips WHERE')) {
          return { id: 1, user_id: 1, title: 'Test Trip', start_date: '2025-04-01', end_date: '2025-04-07', currency: 'EUR' };
        }
        if (sql.includes('FROM days WHERE')) {
          return { id: 1, day_number: 1, date: '2025-04-01', title: 'Day 1' };
        }
        return undefined;
      },
      all: () => [],
      run: (...args: unknown[]) => {
        if (sql.includes('app_settings')) {
          appSettings.set(args[0] as string, args[1] as string);
        }
      },
    }),
  },
  canAccessTrip: (...args: unknown[]) => mockCanAccessTrip(...args),
}));

vi.mock('../src/config', () => ({ JWT_SECRET: 'test-secret' }));

vi.mock('../src/middleware/auth', () => ({
  authenticate: (req: { user: object }, _res: unknown, next: () => void) => {
    req.user = { id: 1, username: 'admin', email: 'admin@test.com', role: 'admin' };
    next();
  },
}));

import express, { type Application } from 'express';
import http from 'http';

function createApp(): Application {
  const app = express();
  app.use(express.json());
  return app;
}

async function request(
  app: Application,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' } },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode!, body: {} });
            }
          });
        }
      );
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('AI Routes', () => {
  let app: Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    appSettings.clear();
    mockCanAccessTrip.mockReturnValue(true);

    app = createApp();
    const mod = await import('../src/routes/ai');
    app.use('/api/trips/:tripId/ai', mod.default);
    app.use('/api/ai', mod.aiConfigRouter);
  });

  describe('Admin config endpoints', () => {
    it('GET /api/ai/config returns provider settings', async () => {
      appSettings.set('ai_provider', 'minimax');
      appSettings.set('ai_api_key', 'test-key');
      const res = await request(app, 'GET', '/api/ai/config');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('minimax');
      expect(res.body.api_key_set).toBe(true);
    });

    it('PUT /api/ai/config saves settings', async () => {
      const res = await request(app, 'PUT', '/api/ai/config', {
        provider: 'minimax',
        api_key: 'new-key',
        model: 'MiniMax-M2.7',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(appSettings.get('ai_provider')).toBe('minimax');
      expect(appSettings.get('ai_api_key')).toBe('new-key');
    });

    it('POST /api/ai/validate returns invalid when no key', async () => {
      const res = await request(app, 'POST', '/api/ai/validate');
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('Trip AI suggestions', () => {
    it('suggest-packing returns 400 when AI not configured', async () => {
      const res = await request(app, 'POST', '/api/trips/1/ai/suggest-packing');
      expect(res.status).toBe(400);
      expect((res.body.error as string)).toContain('not configured');
    });

    it('suggest-packing returns suggestions', async () => {
      appSettings.set('ai_api_key', 'key');
      appSettings.set('ai_provider', 'openai');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '[{"name":"Sunglasses","category":"Accessories"}]' } }],
        }),
      });

      const res = await request(app, 'POST', '/api/trips/1/ai/suggest-packing');
      expect(res.status).toBe(200);
      expect(res.body.suggestions).toHaveLength(1);
      expect((res.body.suggestions as { name: string }[])[0].name).toBe('Sunglasses');
    });

    it('suggest-places returns suggestions with MiniMax', async () => {
      appSettings.set('ai_api_key', 'mm-key');
      appSettings.set('ai_provider', 'minimax');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '<think>thinking</think>[{"name":"Tower","description":"Tall tower","category":"attraction"}]' } }],
        }),
      });

      const res = await request(app, 'POST', '/api/trips/1/ai/suggest-places', { query: 'landmarks' });
      expect(res.status).toBe(200);
      expect(res.body.suggestions).toHaveLength(1);
      // Verify thinking tags were stripped
      expect((res.body.suggestions as { name: string }[])[0].name).toBe('Tower');
    });

    it('suggest-itinerary returns schedule', async () => {
      appSettings.set('ai_api_key', 'key');
      appSettings.set('ai_provider', 'minimax');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '[{"time":"09:00","activity":"Museum visit","icon":"🏛️","duration_minutes":120}]' } }],
        }),
      });

      const res = await request(app, 'POST', '/api/trips/1/ai/suggest-itinerary', { dayId: 1 });
      expect(res.status).toBe(200);
      expect(res.body.suggestions).toHaveLength(1);
      expect((res.body.suggestions as { activity: string }[])[0].activity).toBe('Museum visit');
    });

    it('returns 404 when trip not accessible', async () => {
      mockCanAccessTrip.mockReturnValue(false);
      appSettings.set('ai_api_key', 'key');

      const res = await request(app, 'POST', '/api/trips/1/ai/suggest-packing');
      expect(res.status).toBe(404);
    });
  });
});
