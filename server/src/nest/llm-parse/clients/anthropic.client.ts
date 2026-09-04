import type { LlmExtractionClient, LlmExtractionInput } from '../llm-provider.interface';
import { safeFetchLlm } from '../../../utils/ssrfGuard';
import { readEnv } from '../../../app-config';
import { toReservationList } from '../lenient-json';

const MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_NAME = 'emit_reservations';

/**
 * Anthropic Messages API client. Structured output via forced tool-use: a single
 * `emit_reservations` tool whose `input_schema` is the reservations schema, with
 * `tool_choice` forcing it — the documented, reliable way to get structured JSON.
 * PDFs go as native base64 `document` blocks (Anthropic reads scanned PDFs).
 * Raw fetch (no SDK) to match the codebase's HTTP style.
 */
export class AnthropicClient implements LlmExtractionClient {
  async extract(input: LlmExtractionInput): Promise<Record<string, unknown>[]> {
    // The lookbehind pins the run to its own start. Without it `\/+$` restarts at every
    // slash of a trailing run that turns out not to end the string, rescanning to the
    // end each time; the assertion only rules out start positions the leftmost match
    // could never have used, so the trimmed result is unchanged.
    const base = (input.baseUrl ?? 'https://api.anthropic.com').replace(/(?<!\/)\/+$/, '');
    const url = `${base}/v1/messages`;

    const content: unknown[] = [];
    if (input.file) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: input.file.mimeType, data: input.file.data.toString('base64') },
      });
    }
    content.push({
      type: 'text',
      text: input.text ? `${USER_TEXT}\n\n${input.text}` : USER_TEXT,
    });

    const body = {
      model: input.model,
      max_tokens: MAX_TOKENS,
      system: input.prompt,
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the travel reservations extracted from the document.',
          input_schema: input.jsonSchema,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), readEnv().integrations.llmTimeoutMs);
    let res: Response;
    try {
      // baseUrl is user-configurable — guard it against pointing at the cloud
      // metadata endpoint, while still allowing a local/LAN gateway.
      res = await safeFetchLlm(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': input.apiKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      stop_reason?: string;
      content?: { type: string; name?: string; input?: { reservations?: unknown } }[];
    };

    if (data.stop_reason === 'refusal') {
      throw new Error('Anthropic declined to process this document');
    }

    const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === TOOL_NAME);
    return toReservationList(toolUse?.input?.reservations);
  }
}

const USER_TEXT = 'Extract every travel reservation from the following document as schema.org JSON-LD.';
