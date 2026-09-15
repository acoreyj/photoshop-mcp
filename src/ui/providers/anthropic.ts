import { createAnthropic } from '@ai-sdk/anthropic';
import { resolveCliBinary, runCommand } from './cli-utils.js';
import type { ProviderAdapter, ProviderModel } from './types.js';

function sanitizeCliDetail(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

// Public list pricing (USD per 1M tokens). Cache-write reflects the 5-minute
// tier; we don't currently differentiate the 1-hour tier.
const OPUS_PRICING = {
  inputUsdPerMTok: 5,
  outputUsdPerMTok: 25,
  cachedInputUsdPerMTok: 0.5,
  cachedWriteUsdPerMTok: 6.25,
};

const SONNET_4_PRICING = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cachedInputUsdPerMTok: 0.3,
  cachedWriteUsdPerMTok: 3.75,
};

const MODELS: ProviderModel[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    pricing: {
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 50,
      cachedInputUsdPerMTok: 0.25,
      cachedWriteUsdPerMTok: 12.5,
    },
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    pricing: {
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 50,
      cachedInputUsdPerMTok: 1,
      cachedWriteUsdPerMTok: 12.5,
    },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    pricing: OPUS_PRICING,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    pricing: OPUS_PRICING,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    pricing: OPUS_PRICING,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    pricing: OPUS_PRICING,
  },
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    pricing: OPUS_PRICING,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    pricing: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cachedInputUsdPerMTok: 0.2,
      cachedWriteUsdPerMTok: 2.5,
    },
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    pricing: SONNET_4_PRICING,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    pricing: SONNET_4_PRICING,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    pricing: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cachedInputUsdPerMTok: 0.1,
      cachedWriteUsdPerMTok: 1.25,
    },
  },
];

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  apiKeyHint: 'sk-ant-...',
  apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
  supportedAuthMethods: ['api_key', 'cli_account'],
  cliBinaryName: 'claude',
  validateApiKeyFormat(key) {
    return key.startsWith('sk-ant-');
  },
  async validateApiKey(key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
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
  async validateCliAccount({ cliPath } = {}) {
    const binary = await resolveCliBinary('claude', cliPath);
    if (!binary) {
      return {
        ok: false,
        error: 'cli_not_found',
      };
    }
    const result = await runCommand(binary, ['auth', 'status'], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      const detail = sanitizeCliDetail(result.stderr.trim() || result.stdout.trim());
      return {
        ok: false,
        error: 'not_authenticated',
        detail: detail
          ? `exit ${result.exitCode}: ${detail}`
          : `exit ${result.exitCode}`,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        email?: string;
        account?: { email?: string };
      };
      const accountLabel = parsed.email ?? parsed.account?.email;
      return accountLabel ? { ok: true, accountLabel } : { ok: true };
    } catch {
      return { ok: true };
    }
  },
  listModels() {
    return MODELS.map((m) => ({ ...m }));
  },
  defaultModel() {
    return 'claude-sonnet-5';
  },
  getLanguageModel({ apiKey, modelId }) {
    return createAnthropic({ apiKey })(modelId);
  },
  getModelPricing(modelId) {
    return MODELS.find((m) => m.id === modelId)?.pricing;
  },
};
