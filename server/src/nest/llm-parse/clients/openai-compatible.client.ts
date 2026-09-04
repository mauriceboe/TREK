import type { LlmExtractionClient, LlmExtractionInput } from '../llm-provider.interface';
import { isNuExtractModel, buildNuExtractUserText, nuExtractToKiReservations } from './nuextract';
import { parseLenientJson, toReservationList } from '../lenient-json';
import { safeFetchLlm } from '../../../utils/ssrfGuard';
import { readEnv } from '../../../app-config';

const MAX_TOKENS = 4096;

/**
 * OpenAI-compatible chat-completions client. Covers both the "openai" cloud
 * provider and the "local" provider (Ollama / vLLM / llama.cpp / LM Studio),
 * which all expose `POST {baseUrl}/chat/completions`. Native binaries (PDF) are
 * sent as an OpenAI `file` content part; text goes as a text part. Uses the
 * global fetch (no SDK) to match the codebase's HTTP style.
 *
 * A NuExtract model (detected by id) takes a different request shape: the JSON
 * template inlined in a single user message, no system prompt and no
 * `response_format` (see ./nuextract.ts) — that's how the fine-tune expects to
 * be driven; the generic instruct path applies to every other model.
 *
 * Structured output is requested as `json_schema` first; servers that only
 * support `json_object` (DeepSeek, Mistral, some vLLM/llama.cpp) reject that
 * with a 400, so the request is retried once in `json_object` mode.
 */
export class OpenAiCompatibleClient implements LlmExtractionClient {
  async extract(input: LlmExtractionInput): Promise<Record<string, unknown>[]> {
    // The lookbehind matches only the first slash of the trailing run. Without it the
    // engine retries from every slash, which is quadratic on a slash-heavy value.
    const base = (input.baseUrl ?? 'https://api.openai.com/v1').replace(/(?<!\/)\/+$/, '');
    const url = `${base}/chat/completions`;
    const nuextract = isNuExtractModel(input.model);

    const userContent: unknown[] = nuextract
      ? [{ type: 'text', text: buildNuExtractUserText(input.text ?? '') }]
      : [{ type: 'text', text: input.text ? `${USER_TEXT}\n\n${input.text}` : USER_TEXT }];
    // Only genuine images go natively (as image_url) — OpenAI-compatible servers
    // (notably Ollama) reject `file`/PDF content parts. PDFs reach this client as
    // pre-extracted text (see llm-parse.service.ts), never as bytes.
    if (!nuextract && input.file && input.file.mimeType.startsWith('image/')) {
      const b64 = input.file.data.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${input.file.mimeType};base64,${b64}` },
      });
    }

    // The token cap is `max_tokens` for the chat-completions API and for every
    // local server (Ollama/vLLM/llama.cpp), but newer OpenAI models reject it
    // with a 400 and demand `max_completion_tokens`. Start with the broadly
    // supported spelling and swap on that specific rejection (#1760).
    const buildBody = (tokenParam: 'max_tokens' | 'max_completion_tokens', jsonObject: boolean) => {
      const baseBody = {
        model: input.model,
        [tokenParam]: MAX_TOKENS,
        // Extraction is a deterministic task — Ollama defaults to 0.7, which makes
        // small models (NuExtract) drop fields or return empty. Pin to 0.
        temperature: 0,
        // NuExtract wants the template (in the user turn) to be the only instruction
        // — a system prompt or a json_schema grammar derails it.
        messages: nuextract
          ? [{ role: 'user', content: userContent }]
          : [
              { role: 'system', content: input.prompt },
              { role: 'user', content: userContent },
            ],
      };
      if (nuextract) return baseBody;
      return {
        ...baseBody,
        response_format: jsonObject
          ? { type: 'json_object' as const }
          : { type: 'json_schema' as const, json_schema: { name: 'reservations', schema: input.jsonSchema, strict: false } },
      };
    };

    let tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
    let res = await this.send(url, buildBody(tokenParam, false), input.apiKey);
    let detail = res.ok ? '' : await res.text().catch(() => '');

    // Newer OpenAI models 400 on `max_tokens` — retry the whole request (schema
    // and all) with `max_completion_tokens` before giving up.
    if (!res.ok && res.status === 400 && detail.includes('max_completion_tokens')) {
      tokenParam = 'max_completion_tokens';
      res = await this.send(url, buildBody(tokenParam, false), input.apiKey);
      detail = res.ok ? '' : await res.text().catch(() => '');
    }

    // Servers that only support `json_object` (DeepSeek, Mistral, some
    // vLLM/llama.cpp) reject `json_schema` with a 400 — retry once in
    // `json_object` mode (keeping whichever token param stuck). The system
    // prompt already dictates the exact output shape (and mentions JSON, which
    // json_object mode requires).
    if (!res.ok && res.status === 400 && !nuextract) {
      res = await this.send(url, buildBody(tokenParam, true), input.apiKey);
      detail = res.ok ? '' : await res.text().catch(() => '');
    }

    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    return nuextract ? parseNuExtract(content) : parseReservations(content);
  }

  private async send(url: string, body: unknown, apiKey?: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), readEnv().integrations.llmTimeoutMs);
    try {
      // baseUrl is user-configurable — guard it against pointing at the cloud
      // metadata endpoint, while still allowing a local/LAN Ollama.
      return await safeFetchLlm(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse a NuExtract response and map its flat template output to KiReservation nodes. */
function parseNuExtract(content: string | undefined | null): Record<string, unknown>[] {
  return nuExtractToKiReservations(parseLenientJson(content));
}

const USER_TEXT = 'Extract every travel reservation from the following document as schema.org JSON-LD.';

/** Tolerant parse: strip code fences, JSON(5).parse, pull `reservations`. `[]` on failure. */
function parseReservations(content: string | undefined | null): Record<string, unknown>[] {
  return toReservationList(parseLenientJson(content));
}
