import { describe, it, expect, vi, beforeEach } from 'vitest';

// The clients go through safeFetchLlm (SSRF guard: blocks the cloud-metadata
// range, allows a local/LAN Ollama). Mock it here so the tests never do a real
// DNS lookup — the call signature (url, init) matches the raw fetch it wraps, so
// the existing assertions on the recorded call args are unchanged.
const { safeFetchLlmMock } = vi.hoisted(() => ({ safeFetchLlmMock: vi.fn() }));
vi.mock('../../../../src/utils/ssrfGuard', () => ({ safeFetchLlm: safeFetchLlmMock }));

import { OpenAiCompatibleClient } from '../../../../src/nest/llm-parse/clients/openai-compatible.client';
import { AnthropicClient } from '../../../../src/nest/llm-parse/clients/anthropic.client';
import type { LlmExtractionInput } from '../../../../src/nest/llm-parse/llm-provider.interface';
import { readEnv } from '../../../../src/app-config';

const baseInput: LlmExtractionInput = {
  prompt: 'system',
  jsonSchema: { type: 'object' },
  model: 'm',
  text: 'Flight AB123',
};

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  safeFetchLlmMock.mockImplementation(impl as any);
  return safeFetchLlmMock;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => safeFetchLlmMock.mockReset());

describe('OpenAiCompatibleClient', () => {
  it('posts to {baseUrl}/chat/completions and returns the reservations array', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ reservations: [{ '@type': 'FlightReservation' }] }) } }] }),
    );
    const out = await new OpenAiCompatibleClient().extract({ ...baseInput, baseUrl: 'http://localhost:11434/v1/' });
    expect(out).toEqual([{ '@type': 'FlightReservation' }]);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('tolerates code-fenced JSON', async () => {
    mockFetch(() =>
      jsonResponse({ choices: [{ message: { content: '```json\n{"reservations":[{"@type":"TrainReservation"}]}\n```' } }] }),
    );
    const out = await new OpenAiCompatibleClient().extract(baseInput);
    expect(out).toEqual([{ '@type': 'TrainReservation' }]);
  });

  it('tolerates single-quoted, non-strict JSON output (Gemini, #1638)', async () => {
    mockFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content:
                "[{ '@type': 'LodgingReservation', checkinTime: '2026-08-28T00:00:00', price: 146.25, }]",
            },
          },
        ],
      }),
    );
    const out = await new OpenAiCompatibleClient().extract(baseInput);
    expect(out).toEqual([{ '@type': 'LodgingReservation', checkinTime: '2026-08-28T00:00:00', price: 146.25 }]);
  });

  it('returns [] on malformed content', async () => {
    mockFetch(() => jsonResponse({ choices: [{ message: { content: 'not json' } }] }));
    expect(await new OpenAiCompatibleClient().extract(baseInput)).toEqual([]);
  });

  it('throws on non-2xx', async () => {
    mockFetch(() => jsonResponse({ error: 'bad' }, false, 401));
    await expect(new OpenAiCompatibleClient().extract(baseInput)).rejects.toThrow(/401/);
    expect(safeFetchLlmMock).toHaveBeenCalledTimes(1); // no retry on non-400
  });

  it('retries once with json_object when the server rejects json_schema (400)', async () => {
    safeFetchLlmMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'response_format type is unavailable' } }, false, 400))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"reservations":[{"@type":"FlightReservation"}]}' } }] }),
      );
    const out = await new OpenAiCompatibleClient().extract(baseInput);
    expect(out).toEqual([{ '@type': 'FlightReservation' }]);
    expect(safeFetchLlmMock).toHaveBeenCalledTimes(2);

    const first = JSON.parse((safeFetchLlmMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((safeFetchLlmMock.mock.calls[1][1] as RequestInit).body as string);
    expect(first.response_format.type).toBe('json_schema');
    expect(second.response_format).toEqual({ type: 'json_object' });
    expect(second.messages).toEqual(first.messages);
    expect(second.model).toBe(first.model);
  });

  it('retries with max_completion_tokens when the model rejects max_tokens (400, #1760)', async () => {
    safeFetchLlmMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", code: 'unsupported_parameter' } },
          false,
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"reservations":[{"@type":"FlightReservation"}]}' } }] }),
      );
    const out = await new OpenAiCompatibleClient().extract(baseInput);
    expect(out).toEqual([{ '@type': 'FlightReservation' }]);
    expect(safeFetchLlmMock).toHaveBeenCalledTimes(2);

    const first = JSON.parse((safeFetchLlmMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((safeFetchLlmMock.mock.calls[1][1] as RequestInit).body as string);
    expect(first.max_tokens).toBe(4096);
    expect(first.max_completion_tokens).toBeUndefined();
    // The retry swaps the token param but keeps everything else, json_schema included.
    expect(second.max_completion_tokens).toBe(4096);
    expect(second.max_tokens).toBeUndefined();
    expect(second.response_format.type).toBe('json_schema');
    expect(second.messages).toEqual(first.messages);
  });

  it('throws when the json_object retry also fails (400 twice)', async () => {
    safeFetchLlmMock
      .mockResolvedValueOnce(jsonResponse({ error: 'no json_schema' }, false, 400))
      .mockResolvedValueOnce(jsonResponse({ error: 'no json_object either' }, false, 400));
    await expect(new OpenAiCompatibleClient().extract(baseInput)).rejects.toThrow(/400/);
    expect(safeFetchLlmMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry the NuExtract path on 400', async () => {
    safeFetchLlmMock.mockResolvedValueOnce(jsonResponse({ error: 'bad' }, false, 400));
    await expect(
      new OpenAiCompatibleClient().extract({ ...baseInput, model: 'hf.co/numind/NuExtract-2.0-2B-GGUF:latest' }),
    ).rejects.toThrow(/400/);
    expect(safeFetchLlmMock).toHaveBeenCalledTimes(1);
  });

  it('sends an image natively as image_url but never a file/pdf part', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ choices: [{ message: { content: '{"reservations":[]}' } }] }));
    await new OpenAiCompatibleClient().extract({ ...baseInput, file: { mimeType: 'image/png', data: Buffer.from('IMG') } });
    let parts = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string).messages[1].content;
    expect(parts.some((p: any) => p.type === 'image_url')).toBe(true);
    expect(parts.some((p: any) => p.type === 'file')).toBe(false);

    // A PDF must NOT be sent as a content part (Ollama rejects it).
    await new OpenAiCompatibleClient().extract({ ...baseInput, file: { mimeType: 'application/pdf', data: Buffer.from('PDF') } });
    parts = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string).messages[1].content;
    expect(parts.every((p: any) => p.type !== 'file' && p.type !== 'image_url')).toBe(true);
  });
});

describe('OpenAiCompatibleClient — NuExtract path', () => {
  it('inlines the template in one user message (no system, no response_format) and maps the flat result', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reservations: [
                  { type: 'hotel', name: 'B&B Hotel', booking_reference: '733', checkin_time: '2026-05-01T15:00:00', checkout_time: '2026-05-02T12:00:00' },
                ],
              }),
            },
          },
        ],
      }),
    );
    const out = await new OpenAiCompatibleClient().extract({ ...baseInput, model: 'hf.co/numind/NuExtract-2.0-2B-GGUF:latest', text: 'Hotel doc' });

    expect(out).toEqual([
      {
        '@type': 'LodgingReservation',
        reservationNumber: '733',
        reservationFor: { name: 'B&B Hotel' },
        checkinTime: '2026-05-01T15:00:00',
        checkoutTime: '2026-05-02T12:00:00',
      },
    ]);

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].text.startsWith('# Template:')).toBe(true);
    expect(body.messages[0].content[0].text.endsWith('Hotel doc')).toBe(true);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toBeUndefined();
  });

  it('keeps the system prompt and response_format for non-NuExtract models', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ choices: [{ message: { content: '{"reservations":[]}' } }] }));
    await new OpenAiCompatibleClient().extract({ ...baseInput, model: 'qwen2.5:7b' });
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].role).toBe('system');
    expect(body.response_format).toBeDefined();
  });
});

describe('AnthropicClient', () => {
  it('forces the emit_reservations tool and reads its input', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: [{ '@type': 'LodgingReservation' }] } }] }),
    );
    const out = await new AnthropicClient().extract(baseInput);
    expect(out).toEqual([{ '@type': 'LodgingReservation' }]);
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_reservations' });
    expect(body.tools[0].name).toBe('emit_reservations');
  });

  /*
   * The model does not always send its tool input as the array the schema
   * declares — sometimes it sends the same thing JSON-encoded, in one of two
   * shapes. The old check only accepted arrays, so a good extraction was
   * discarded and the import reported "no reservations found" with nothing in
   * the log: exactly what a document containing no booking produces. Whether it
   * happened came down to how the model serialised that particular call, so the
   * same file behaved differently between attempts (#1968).
   */
  it('reads a tool input the model sent as a stringified array', async () => {
    mockFetch(() =>
      jsonResponse({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: JSON.stringify([{ '@type': 'LodgingReservation' }]) } }] }),
    );
    expect(await new AnthropicClient().extract(baseInput)).toEqual([{ '@type': 'LodgingReservation' }]);
  });

  it('reads one the model stringified and wrapped again', async () => {
    mockFetch(() =>
      jsonResponse({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: JSON.stringify({ reservations: [{ '@type': 'FlightReservation' }] }) } }] }),
    );
    expect(await new AnthropicClient().extract(baseInput)).toEqual([{ '@type': 'FlightReservation' }]);
  });

  it('still answers empty when the tool input really is not a list', async () => {
    mockFetch(() =>
      jsonResponse({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: 'no bookings in this document' } }] }),
    );
    expect(await new AnthropicClient().extract(baseInput)).toEqual([]);
  });

  it('throws on a refusal stop_reason', async () => {
    mockFetch(() => jsonResponse({ stop_reason: 'refusal', content: [] }));
    await expect(new AnthropicClient().extract(baseInput)).rejects.toThrow(/declined/i);
  });

  it('throws on non-2xx', async () => {
    mockFetch(() => jsonResponse({ error: 'bad' }, false, 500));
    await expect(new AnthropicClient().extract(baseInput)).rejects.toThrow(/500/);
  });

  it('sends a native pdf as a base64 document block', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: [] } }] }));
    await new AnthropicClient().extract({ ...baseInput, file: { mimeType: 'application/pdf', data: Buffer.from('PDF') } });
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    const blocks = body.messages[0].content;
    expect(blocks.some((b: any) => b.type === 'document' && b.source.type === 'base64')).toBe(true);
  });
});

/**
 * The three per-client constants are gone; what replaced them is a config read.
 * Nothing else in the suite would notice if one of them came back as a literal,
 * so pin the seam itself: the abort deadline has to come from LLM_TIMEOUT_MS.
 */
describe('the abort deadline comes from the configured ceiling (#2230)', () => {
  const setTimeoutSpy = () => vi.spyOn(globalThis, 'setTimeout');

  beforeEach(() => vi.restoreAllMocks());

  it('AnthropicClient arms its AbortController with the configured value', async () => {
    const spy = setTimeoutSpy();
    mockFetch(() => jsonResponse({ content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: [] } }] }));

    await new AnthropicClient().extract(baseInput);

    expect(spy).toHaveBeenCalledWith(expect.any(Function), readEnv().integrations.llmTimeoutMs);
  });

  it('OpenAiCompatibleClient arms its AbortController with the configured value', async () => {
    const spy = setTimeoutSpy();
    mockFetch(() => jsonResponse({ choices: [{ message: { content: '{"reservations":[]}' } }] }));

    await new OpenAiCompatibleClient().extract({ ...baseInput, baseUrl: 'http://ollama.local:11434/v1' });

    expect(spy).toHaveBeenCalledWith(expect.any(Function), readEnv().integrations.llmTimeoutMs);
  });
});
