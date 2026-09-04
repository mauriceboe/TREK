import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The LLM lane's response ceiling, pinned at the two seams where it is decided:
 * the dispatcher that carries it, and the choice of which callers get it.
 *
 * `createPinnedDispatcher` grew a `responseTimeoutMs` parameter and nothing
 * passed it, so the ceiling stayed undici's default five minutes while
 * LLM_TIMEOUT_MS said fifteen — one setting overruled by another nobody chose.
 * A capability nobody calls looks exactly like a working fix from the outside,
 * which is why this asserts the argument reaches the dispatcher rather than
 * that the option exists.
 *
 * The lane matters as much as the number. `safeFetchAdminConfigured` is also
 * the OIDC lane (discovery, token, userinfo, JWKS) and the plugin OAuth token
 * exchange, and the plugin one sends no AbortSignal of its own: a ceiling
 * applied there would hold a hung identity provider open for a quarter of an
 * hour on the strength of a model setting.
 */
const { AgentMock } = vi.hoisted(() => ({ AgentMock: vi.fn() }));
vi.mock('undici', () => ({ Agent: AgentMock }));

vi.mock('dns/promises', () => ({ default: { lookup: vi.fn() }, lookup: vi.fn() }));

// ssrfGuard reads env at module load, so the mock must answer before the import.
const { readEnvMock } = vi.hoisted(() => ({
  readEnvMock: vi.fn(() => ({ net: { allowInternalNetwork: true }, integrations: { llmTimeoutMs: 900_000 } })),
}));
vi.mock('../../../src/app-config', () => ({ readEnv: readEnvMock }));

import dns from 'dns/promises';
import { createPinnedDispatcher, safeFetchLlm, safeFetchAdminConfigured } from '../../../src/utils/ssrfGuard';

const mockLookup = vi.mocked(dns.lookup);

beforeEach(() => {
  AgentMock.mockClear();
  readEnvMock.mockClear();
  readEnvMock.mockReturnValue({ net: { allowInternalNetwork: true }, integrations: { llmTimeoutMs: 900_000 } });
  mockLookup.mockResolvedValue({ address: '203.0.113.10', family: 4 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const optionsOf = () => AgentMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

function response(opts: { status: number; location?: string }) {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (opts.location ?? null) : null) },
    body: { cancel: () => Promise.resolve() },
  };
}

describe('createPinnedDispatcher — response ceiling', () => {
  it('applies the ceiling it is given to both header and body waits', () => {
    createPinnedDispatcher('10.0.0.5', true, 900_000);

    expect(optionsOf().headersTimeout).toBe(900_000);
    expect(optionsOf().bodyTimeout).toBe(900_000);
  });

  it('leaves undici its own default when no ceiling is given', () => {
    createPinnedDispatcher('10.0.0.5', true);

    expect(optionsOf().headersTimeout).toBeUndefined();
    expect(optionsOf().bodyTimeout).toBeUndefined();
  });

  it('still pins the connection to the validated IP', () => {
    createPinnedDispatcher('10.0.0.5', true, 900_000);

    const lookup = (optionsOf().connect as { lookup: (h: string, o: object, cb: (...a: unknown[]) => void) => void }).lookup;
    const seen: unknown[] = [];
    lookup('evil.example', {}, (...args: unknown[]) => seen.push(...args));
    expect(seen).toContain('10.0.0.5');
  });
});

describe('the ceiling belongs to the model lane only', () => {
  it('safeFetchLlm carries the configured ceiling to the dispatcher', async () => {
    readEnvMock.mockReturnValue({ net: { allowInternalNetwork: true }, integrations: { llmTimeoutMs: 120_000 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 200 })));

    await safeFetchLlm('https://api.provider.example/v1/chat/completions');

    expect(optionsOf().headersTimeout).toBe(120_000);
    expect(optionsOf().bodyTimeout).toBe(120_000);
  });

  it('safeFetchAdminConfigured keeps undici default — OIDC and plugin OAuth ride this lane', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 200 })));

    await safeFetchAdminConfigured('https://idp.example/token', { method: 'POST' });

    expect(optionsOf().headersTimeout).toBeUndefined();
    expect(optionsOf().bodyTimeout).toBeUndefined();
  });

  it('reads the ceiling once per call, so every hop of a redirect chain uses one value', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response({ status: 302, location: 'https://api.provider.example/v2/chat' }))
        .mockResolvedValueOnce(response({ status: 200 })),
    );

    await safeFetchLlm('https://api.provider.example/v1/chat');

    expect(AgentMock).toHaveBeenCalledTimes(2);
    expect(readEnvMock).toHaveBeenCalledTimes(1);
    expect((AgentMock.mock.calls[0][0] as Record<string, unknown>).headersTimeout).toBe(900_000);
    expect((AgentMock.mock.calls[1][0] as Record<string, unknown>).headersTimeout).toBe(900_000);
  });
});
