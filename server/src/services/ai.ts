import fetch from 'node-fetch';
import { db } from '../db/database';

export type AIProvider = 'openai' | 'minimax';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionChoice {
  message: { content: string };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
  error?: { message: string };
}

const PROVIDER_DEFAULTS: Record<AIProvider, { baseUrl: string; model: string }> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-M2.7',
  },
};

export function getAIConfig(): AIConfig | null {
  const get = (key: string) =>
    (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || '';

  const provider = (get('ai_provider') || 'openai') as AIProvider;
  const apiKey = get('ai_api_key');
  if (!apiKey) return null;

  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey,
    model: get('ai_model') || defaults.model,
    baseUrl: get('ai_base_url') || defaults.baseUrl,
  };
}

function clampTemperature(provider: AIProvider, temp: number): number {
  if (provider === 'minimax') {
    return Math.max(0.01, Math.min(temp, 1.0));
  }
  return Math.max(0, Math.min(temp, 2.0));
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function chatCompletion(
  config: AIConfig,
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const temperature = clampTemperature(config.provider, options.temperature ?? 0.7);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
  };
  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;

  if (data.error) {
    throw new Error(`AI API error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content || '';
  return config.provider === 'minimax' ? stripThinkingTags(content) : content;
}
