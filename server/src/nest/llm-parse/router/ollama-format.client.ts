/**
 * Minimal Ollama native-API client used by the extraction router.
 *
 * Why not the OpenAI-compatible `/v1/chat/completions` path the rest of llm-parse uses?
 * Ollama's `/v1` endpoint does NOT faithfully honour OpenAI's `response_format:{json_schema,strict}`
 * (it's passed through loosely — the schema and `strict` flag are effectively ignored).
 * Ollama's OWN `/api/chat` endpoint with a top-level `format: <jsonSchema>` is the path that
 * actually compiles the schema to a GBNF grammar and constrains token sampling. That hard
 * guarantee — valid, type-correct, all-required-fields JSON — is the router's foundation,
 * so the router talks to `/api/chat` directly. (Cloud providers enforce via their own strict
 * tool/response_format and keep using the existing clients.)
 */

import { parseLenientJson } from '../lenient-json';
import { safeFetchLlm } from '../../../utils/ssrfGuard';
import { readEnv } from '../../../app-config';

export interface EnforcedExtractInput {
  /** Ollama base URL — accepts the addon's `…/v1` form; the `/v1` suffix is stripped. */
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  /** JSON Schema the output is constrained to (grammar-level). */
  schema: Record<string, unknown>;
  apiKey?: string;
  numPredict?: number;
  /** Context window. 8192 fits a typical multi-section booking; raise for long itineraries. */
  numCtx?: number;
}

/** Resolve the native API base from a config base URL that may end in `/v1`. */
export function toNativeBase(baseUrl: string): string {
  // Trailing slashes come off as a scan, not /\/+$/: that pattern is unanchored at the
  // front, so the engine restarts it at every slash of a run and rescans to the end each
  // time (quadratic — 25s on 200k). Same result: the maximal trailing run goes.
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  return baseUrl.slice(0, end).replace(/\/v1$/, '');
}

/**
 * Run one schema-constrained chat completion against Ollama's native `/api/chat`.
 * Returns the parsed JSON object (constrained to `schema`), or null if the request
 * failed or produced unparseable output.
 */
export async function extractEnforced(input: EnforcedExtractInput): Promise<Record<string, unknown> | null> {
  const url = `${toNativeBase(input.baseUrl)}/api/chat`;
  const body = {
    model: input.model,
    stream: false,
    format: input.schema,
    // Disable "thinking" for hybrid/reasoning models (Qwen3, etc.): the reasoning tokens
    // collide with the format-grammar constraint here — they produce unparseable output and
    // blow the latency budget on CPU. Ollama ignores this for non-thinking models, so it's safe.
    think: false,
    // Keep the model resident a while so back-to-back imports don't pay the cold load.
    keep_alive: '30m',
    options: { temperature: 0, num_predict: input.numPredict ?? 512, num_ctx: input.numCtx ?? 8192 },
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readEnv().integrations.llmTimeoutMs);
  let res: Response;
  try {
    // baseUrl is user-configurable — guard it against the cloud-metadata range,
    // while still allowing a local/LAN Ollama.
    res = await safeFetchLlm(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama /api/chat failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const parsed = parseLenientJson(data.message?.content);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}
