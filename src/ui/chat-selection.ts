import type { ProviderId } from './providers/types.js';

export interface ChatModelSelection {
  provider: ProviderId;
  model: string;
}

export interface ChatModelPatch {
  provider?: ProviderId;
  model?: string;
}

export type ResolveChatModelResult =
  { ok: true; selection: ChatModelSelection } | { ok: false; error: 'unknown_provider' };

interface ProviderDefaults {
  defaultModel(): string;
}

/**
 * Resolve the provider/model a chat should use after a patch.
 *
 * Changing only the provider falls back to that provider's default model;
 * changing only the model keeps the chat's provider. The provider is always
 * validated so an unknown id is rejected instead of being stored.
 */
export function resolveChatModelSelection(
  current: ChatModelSelection,
  patch: ChatModelPatch,
  providerFor: (id: ProviderId) => ProviderDefaults | undefined
): ResolveChatModelResult {
  const provider = patch.provider ?? current.provider;
  const adapter = providerFor(provider);
  if (!adapter) return { ok: false, error: 'unknown_provider' };
  const model =
    patch.model ?? (patch.provider !== undefined ? adapter.defaultModel() : current.model);
  return { ok: true, selection: { provider, model } };
}
