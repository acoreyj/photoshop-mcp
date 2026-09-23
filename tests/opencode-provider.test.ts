import { describe, expect, it } from 'vitest';
import { opencodeAdapter, opencodeGoAdapter } from '../src/ui/providers/opencode.js';
import { getProvider, listProviders } from '../src/ui/providers/registry.js';
import type { LanguageModel } from 'ai';

describe('OpenCode providers', () => {
  it('registers the Zen and Go adapters', () => {
    expect(getProvider('opencode')).toBe(opencodeAdapter);
    expect(getProvider('opencode-go')).toBe(opencodeGoAdapter);
    expect(listProviders().map((p) => p.id)).toEqual(
      expect.arrayContaining(['opencode', 'opencode-go'])
    );
  });

  it('exposes priced model catalogs with a valid default', () => {
    for (const adapter of [opencodeAdapter, opencodeGoAdapter]) {
      const models = adapter.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.pricing)).toBe(true);
      expect(models.some((m) => m.id === adapter.defaultModel())).toBe(true);
      expect(adapter.getModelPricing(adapter.defaultModel())).toBeDefined();
    }
  });

  it('keeps the wire endpoint out of the public model list', () => {
    const models = opencodeAdapter.listModels() as Array<Record<string, unknown>>;
    expect(models.every((m) => !('endpoint' in m))).toBe(true);
  });

  it('accepts any non-empty API key', () => {
    expect(opencodeAdapter.validateApiKeyFormat('opencode-key')).toBe(true);
    expect(opencodeAdapter.validateApiKeyFormat('   ')).toBe(false);
  });

  it('routes each model over the endpoint OpenCode documents', () => {
    const expected: Array<[string, string]> = [
      ['claude-sonnet-5', 'anthropic.messages'],
      ['qwen3.7-max', 'anthropic.messages'],
      ['gpt-5.4', 'openai.responses'],
      ['grok-4.7', 'openai.responses'],
      ['gemini-3.8-flash', 'google.generative-ai'],
      ['deepseek-v4.1-flash', 'openai.chat'],
      ['glm-5.3', 'openai.chat'],
    ];
    for (const [modelId, provider] of expected) {
      const model = opencodeAdapter.getLanguageModel({
        apiKey: 'test',
        modelId,
      }) as unknown as LanguageModel & { modelId: string; provider: string };
      expect(model.provider).toBe(provider);
      expect(model.modelId).toBe(modelId);
    }
  });

  it('falls back to chat completions for unknown Go models', () => {
    const model = opencodeGoAdapter.getLanguageModel({
      apiKey: 'test',
      modelId: 'not-in-catalog',
    }) as unknown as { provider: string };
    expect(model.provider).toBe('openai.chat');
  });
});
