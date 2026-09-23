/**
 * OpenCode Zen / OpenCode Go provider adapters.
 *
 * OpenCode Zen is a model gateway that exposes every model through one base URL
 * but different wire formats per model:
 *   - chat/completions (OpenAI-compatible)
 *   - /messages        (Anthropic-compatible)
 *   - /responses       (OpenAI Responses API)
 *   - /models/<id>     (Google Generative Language API)
 *
 * Endpoint reference: https://opencode.ai/docs/zen/#endpoints
 * OpenCode Go is a subscription on the same account and speaks the same
 * protocols under /zen/go/v1. Its client guidance (identify with your own user
 * agent and send a stable session ID) is documented at
 * https://opencode.ai/docs/go/#where-can-i-use-it
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { getAppVersion } from '../../analytics/app-version.js';
import type { ProviderAdapter, ProviderId, ProviderModel } from './types.js';

/** Wire format OpenCode uses for a given model. */
type OpenCodeEndpoint = 'chat' | 'responses' | 'messages' | 'google';

interface OpenCodeModel extends ProviderModel {
  endpoint: OpenCodeEndpoint;
}

interface OpenCodeAdapterConfig {
  id: ProviderId;
  label: string;
  baseURL: string;
  models: OpenCodeModel[];
}

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

// OpenCode asks clients to identify themselves with their own user agent so
// traffic is not mistaken for a generic SDK (see the Go docs link above).
const USER_AGENT = `photoshop-mcp/${getAppVersion()}`;

function buildAdapter(config: OpenCodeAdapterConfig): ProviderAdapter {
  const modelById = new Map(config.models.map((m) => [m.id, m]));
  const baseHeaders = { 'User-Agent': USER_AGENT };

  return {
    id: config.id,
    label: config.label,
    apiKeyHint: 'OpenCode API key',
    apiKeyHelpUrl: 'https://opencode.ai/auth',
    supportedAuthMethods: ['api_key'],
    validateApiKeyFormat(key) {
      return key.trim().length > 0;
    },
    async validateApiKey(key) {
      try {
        const res = await fetch(`${config.baseURL}/models`, {
          headers: { ...baseHeaders, Authorization: `Bearer ${key}` },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          return { ok: false, error: text };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    listModels() {
      return config.models.map(({ endpoint: _endpoint, ...model }) => ({ ...model }));
    },
    defaultModel() {
      return config.models[0]!.id;
    },
    getLanguageModel({ apiKey, modelId, sessionId }) {
      // OpenCode asks clients to send a stable per-conversation session ID so
      // it can optimize routing and prompt caching (see Go docs link above).
      const headers = sessionId ? { ...baseHeaders, 'x-opencode-session': sessionId } : baseHeaders;
      const endpoint = modelById.get(modelId)?.endpoint ?? 'chat';
      switch (endpoint) {
        case 'messages':
          // Anthropic's SDK sends x-api-key; Zen also accepts the gateway's
          // Bearer token, so send both.
          return createAnthropic({
            apiKey,
            baseURL: config.baseURL,
            headers: { ...headers, Authorization: `Bearer ${apiKey}` },
          })(modelId);
        case 'responses':
          return createOpenAI({ apiKey, baseURL: config.baseURL, headers }).responses(modelId);
        case 'google':
          return createGoogleGenerativeAI({ apiKey, baseURL: config.baseURL, headers })(modelId);
        case 'chat':
        default:
          return createOpenAI({ apiKey, baseURL: config.baseURL, headers }).chat(modelId);
      }
    },
    getModelPricing(modelId) {
      return modelById.get(modelId)?.pricing;
    },
  };
}

// Curated to models with tool calling, from the Zen endpoint table. Prices in
// USD per 1M tokens, per https://opencode.ai/docs/zen/#pricing.
const ZEN_MODELS: OpenCodeModel[] = [
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cachedInputUsdPerMTok: 0.2,
      cachedWriteUsdPerMTok: 2.5,
    },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cachedInputUsdPerMTok: 0.5,
      cachedWriteUsdPerMTok: 6.25,
    },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cachedInputUsdPerMTok: 0.1,
      cachedWriteUsdPerMTok: 1.25,
    },
  },
  {
    id: 'qwen3.7-max',
    label: 'Qwen3.7 Max',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 2.5,
      outputUsdPerMTok: 7.5,
      cachedInputUsdPerMTok: 0.5,
      cachedWriteUsdPerMTok: 3.125,
    },
  },
  {
    id: 'qwen3.8-flash',
    label: 'Qwen3.8 Flash',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 0.15,
      outputUsdPerMTok: 0.47,
      cachedInputUsdPerMTok: 0.016,
      cachedWriteUsdPerMTok: 0.2,
    },
  },
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 5, outputUsdPerMTok: 30, cachedInputUsdPerMTok: 0.5 },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT 5.4',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 15, cachedInputUsdPerMTok: 0.25 },
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT 5.3 Codex',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 1.75, outputUsdPerMTok: 14, cachedInputUsdPerMTok: 0.175 },
  },
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 6, cachedInputUsdPerMTok: 0.5 },
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    endpoint: 'google',
    pricing: { inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5, cachedInputUsdPerMTok: 0.15 },
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    endpoint: 'google',
    pricing: { inputUsdPerMTok: 1.5, outputUsdPerMTok: 9, cachedInputUsdPerMTok: 0.15 },
  },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, cachedInputUsdPerMTok: 0.006 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 1.74, outputUsdPerMTok: 3.48, cachedInputUsdPerMTok: 0.145 },
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 1.4, outputUsdPerMTok: 4.4, cachedInputUsdPerMTok: 0.26 },
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5, cachedInputUsdPerMTok: 0.03 },
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.95, outputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.19 },
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, cachedInputUsdPerMTok: 0.06 },
  },
];

// OpenCode Go (subscription) uses the same protocols under /zen/go/v1. Prices
// in USD per 1M tokens, per https://opencode.ai/docs/go/#endpoints. DeepSeek
// tiers use off-peak rates.
const GO_MODELS: OpenCodeModel[] = [
  {
    id: 'glm-5.3',
    label: 'GLM 5.3',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 1.4, outputUsdPerMTok: 4.4, cachedInputUsdPerMTok: 0.26 },
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5, cachedInputUsdPerMTok: 0.03 },
  },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6, cachedInputUsdPerMTok: 0.003 },
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.95, outputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.19 },
  },
  {
    id: 'longcat-2.0',
    label: 'LongCat-2.0',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, cachedInputUsdPerMTok: 0.006 },
  },
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    endpoint: 'chat',
    pricing: { inputUsdPerMTok: 0.435, outputUsdPerMTok: 0.87, cachedInputUsdPerMTok: 0.003625 },
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    endpoint: 'messages',
    pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, cachedInputUsdPerMTok: 0.06 },
  },
  {
    id: 'qwen3.8-max',
    label: 'Qwen3.8 Max',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 6,
      cachedInputUsdPerMTok: 0.25,
      cachedWriteUsdPerMTok: 2.5,
    },
  },
  {
    id: 'qwen3.7-plus',
    label: 'Qwen3.7 Plus',
    endpoint: 'messages',
    pricing: {
      inputUsdPerMTok: 0.4,
      outputUsdPerMTok: 1.6,
      cachedInputUsdPerMTok: 0.04,
      cachedWriteUsdPerMTok: 0.5,
    },
  },
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 6, cachedInputUsdPerMTok: 0.5 },
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    endpoint: 'responses',
    pricing: {
      inputUsdPerMTok: 0.2,
      outputUsdPerMTok: 1.2,
      cachedInputUsdPerMTok: 0.02,
      cachedWriteUsdPerMTok: 0.25,
    },
  },
  {
    id: 'muse-spark-1.3-contributor',
    label: 'Muse Spark 1.3 Contributor',
    endpoint: 'responses',
    pricing: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.002 },
  },
];

/** OpenCode Zen — pay-as-you-go gateway. */
export const opencodeAdapter = buildAdapter({
  id: 'opencode',
  label: 'OpenCode Zen',
  baseURL: ZEN_BASE_URL,
  models: ZEN_MODELS,
});

/** OpenCode Go — $10/month subscription for open coding models. */
export const opencodeGoAdapter = buildAdapter({
  id: 'opencode-go',
  label: 'OpenCode Go',
  baseURL: GO_BASE_URL,
  models: GO_MODELS,
});
