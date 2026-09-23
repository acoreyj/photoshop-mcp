import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveChatModelSelection } from '../src/ui/chat-selection.js';
import { getProvider } from '../src/ui/providers/registry.js';
import type { ProviderId } from '../src/ui/providers/types.js';

describe('resolveChatModelSelection', () => {
  const providerFor = (id: ProviderId) =>
    id === 'anthropic' || id === 'opencode' ? { defaultModel: () => 'claude-sonnet-5' } : undefined;

  it('uses the new provider default when only the provider changes', () => {
    const result = resolveChatModelSelection(
      { provider: 'anthropic', model: 'claude-opus-5' },
      { provider: 'opencode' },
      providerFor
    );
    expect(result).toEqual({
      ok: true,
      selection: { provider: 'opencode', model: 'claude-sonnet-5' },
    });
  });

  it('keeps the provider when only the model changes', () => {
    const result = resolveChatModelSelection(
      { provider: 'anthropic', model: 'claude-opus-5' },
      { model: 'claude-haiku-4-5' },
      providerFor
    );
    expect(result).toEqual({
      ok: true,
      selection: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
  });

  it('honors an explicit model alongside a provider change', () => {
    const result = resolveChatModelSelection(
      { provider: 'anthropic', model: 'claude-opus-5' },
      { provider: 'opencode', model: 'deepseek-v4.1-flash' },
      providerFor
    );
    expect(result).toEqual({
      ok: true,
      selection: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    });
  });

  it('rejects an unknown provider', () => {
    expect(
      resolveChatModelSelection(
        { provider: 'anthropic', model: 'claude-opus-5' },
        { provider: 'not-a-provider' as ProviderId },
        providerFor
      )
    ).toEqual({ ok: false, error: 'unknown_provider' });
  });

  it('returns the current selection for an empty patch', () => {
    expect(
      resolveChatModelSelection({ provider: 'anthropic', model: 'claude-opus-5' }, {}, providerFor)
    ).toEqual({
      ok: true,
      selection: { provider: 'anthropic', model: 'claude-opus-5' },
    });
  });
});

describe('chat model selection persistence', () => {
  let home: string;
  let config: typeof import('../src/ui/config.js');
  let chats: typeof import('../src/ui/store/chats.js');
  let db: typeof import('../src/ui/store/db.js');

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'psmcp-chat-selection-'));
    vi.stubEnv('PHOTOSHOP_MCP_HOME', home);
    vi.resetModules();
    config = await import('../src/ui/config.js');
    chats = await import('../src/ui/store/chats.js');
    db = await import('../src/ui/store/db.js');
  });

  afterAll(() => {
    db.closeDB();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('stores the chat selection as the active default for new chats', () => {
    const created = chats.createChat({ provider: 'anthropic', model: 'claude-opus-5' });

    const resolved = resolveChatModelSelection(
      { provider: created.provider as ProviderId, model: created.model },
      { provider: 'opencode', model: 'deepseek-v4.1-flash' },
      (id) => getProvider(id)
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    chats.updateChatModel(created.id, resolved.selection.provider, resolved.selection.model);
    config.saveConfig({
      activeProvider: resolved.selection.provider,
      activeModel: resolved.selection.model,
    });

    const saved = config.loadConfig();
    expect(saved.activeProvider).toBe('opencode');
    expect(saved.activeModel).toBe('deepseek-v4.1-flash');
    expect(chats.getChat(created.id)?.model).toBe('deepseek-v4.1-flash');
  });
});
