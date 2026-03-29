import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-fetch
const mockFetch = vi.fn();
vi.mock('node-fetch', () => ({ default: mockFetch }));

// Mock database
const mockDbGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({ get: mockDbGet, run: vi.fn() }));
vi.mock('../src/db/database', () => ({
  db: { prepare: mockDbPrepare },
}));

// Import after mocks
const { getAIConfig, chatCompletion } = await import('../src/services/ai');

describe('AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAIConfig', () => {
    it('returns null when no API key is configured', () => {
      mockDbGet.mockReturnValue(undefined);
      const config = getAIConfig();
      expect(config).toBeNull();
    });

    it('returns OpenAI config with defaults', () => {
      mockDbGet.mockImplementation(() => undefined);
      // Override for specific keys
      mockDbPrepare.mockImplementation(() => ({
        get: (key: string) => {
          if (key === 'ai_api_key') return { value: 'sk-test-key' };
          if (key === 'ai_provider') return { value: 'openai' };
          return undefined;
        },
        run: vi.fn(),
      }));

      const config = getAIConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('openai');
      expect(config!.apiKey).toBe('sk-test-key');
      expect(config!.model).toBe('gpt-4o-mini');
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('returns MiniMax config with defaults', () => {
      mockDbPrepare.mockImplementation(() => ({
        get: (key: string) => {
          if (key === 'ai_api_key') return { value: 'mm-test-key' };
          if (key === 'ai_provider') return { value: 'minimax' };
          return undefined;
        },
        run: vi.fn(),
      }));

      const config = getAIConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('minimax');
      expect(config!.apiKey).toBe('mm-test-key');
      expect(config!.model).toBe('MiniMax-M2.7');
      expect(config!.baseUrl).toBe('https://api.minimax.io/v1');
    });

    it('uses custom model and base URL when provided', () => {
      mockDbPrepare.mockImplementation(() => ({
        get: (key: string) => {
          if (key === 'ai_api_key') return { value: 'test-key' };
          if (key === 'ai_provider') return { value: 'minimax' };
          if (key === 'ai_model') return { value: 'MiniMax-M2.7-highspeed' };
          if (key === 'ai_base_url') return { value: 'https://custom.api.io/v1' };
          return undefined;
        },
        run: vi.fn(),
      }));

      const config = getAIConfig();
      expect(config!.model).toBe('MiniMax-M2.7-highspeed');
      expect(config!.baseUrl).toBe('https://custom.api.io/v1');
    });
  });

  describe('chatCompletion', () => {
    it('sends correct request to OpenAI', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello!' } }],
        }),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      const result = await chatCompletion(config, [
        { role: 'user', content: 'Hi' },
      ]);

      expect(result).toBe('Hello!');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        }),
      );
    });

    it('sends correct request to MiniMax', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello from MiniMax!' } }],
        }),
      });

      const config = {
        provider: 'minimax' as const,
        apiKey: 'mm-test',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/v1',
      };

      const result = await chatCompletion(config, [
        { role: 'user', content: 'Hi' },
      ]);

      expect(result).toBe('Hello from MiniMax!');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.minimax.io/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
        }),
      );

      // Verify temperature clamping for MiniMax (minimum 0.01)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('MiniMax-M2.7');
      expect(body.temperature).toBeGreaterThanOrEqual(0.01);
      expect(body.temperature).toBeLessThanOrEqual(1.0);
    });

    it('strips thinking tags for MiniMax responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '<think>Let me think about this...</think>The answer is 42.' } }],
        }),
      });

      const config = {
        provider: 'minimax' as const,
        apiKey: 'mm-test',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/v1',
      };

      const result = await chatCompletion(config, [
        { role: 'user', content: 'What is the answer?' },
      ]);

      expect(result).toBe('The answer is 42.');
    });

    it('does NOT strip thinking tags for OpenAI responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '<think>reasoning</think>Result' } }],
        }),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      const result = await chatCompletion(config, [
        { role: 'user', content: 'test' },
      ]);

      expect(result).toBe('<think>reasoning</think>Result');
    });

    it('throws error on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'bad-key',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      await expect(
        chatCompletion(config, [{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow('AI API error (401)');
    });

    it('throws error on API error in response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          error: { message: 'Rate limit exceeded' },
          choices: [],
        }),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      await expect(
        chatCompletion(config, [{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('clamps MiniMax temperature to valid range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'ok' } }],
        }),
      });

      const config = {
        provider: 'minimax' as const,
        apiKey: 'mm-test',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/v1',
      };

      // Temperature 0 should be clamped to 0.01 for MiniMax
      await chatCompletion(config, [{ role: 'user', content: 'test' }], { temperature: 0 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.01);
    });

    it('includes maxTokens when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'ok' } }],
        }),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      await chatCompletion(config, [{ role: 'user', content: 'test' }], { maxTokens: 500 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(500);
    });

    it('handles empty choices array gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [],
        }),
      });

      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      };

      const result = await chatCompletion(config, [{ role: 'user', content: 'test' }]);
      expect(result).toBe('');
    });
  });
});
