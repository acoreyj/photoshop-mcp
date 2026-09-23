import type { LanguageModelUsage, ModelMessage } from 'ai';
import type { ProviderAdapter } from '../providers/registry.js';
import type { AuthMethod } from '../providers/types.js';
import type { Plan, PlanStep } from './plan-schema.js';
import { SdkStructuredPlanner } from './planner-sdk.js';
import { SubscriptionPlanner } from './planner-subscription.js';

export type PlannerKind = 'sdk' | 'subscription';

export interface PlannerEvent {
  type: 'partial';
  plan: Partial<Plan>;
}

export interface PlanResult {
  plan: Plan;
  usage?: LanguageModelUsage;
}

export interface PlanInput {
  catalog: string;
  history: ModelMessage[];
  prompt: string;
  systemPrompt: string;
  abortSignal: AbortSignal;
}

export interface RepairInput {
  catalog: string;
  originalPrompt: string;
  remaining: PlanStep[];
  results: Record<string, unknown>;
  errorMessage: string;
  systemPrompt: string;
  abortSignal: AbortSignal;
}

export interface Planner {
  readonly kind: PlannerKind;
  plan(input: PlanInput): AsyncGenerator<PlannerEvent, PlanResult>;
  repair(input: RepairInput): AsyncGenerator<PlannerEvent, PlanResult>;
}

export interface CreatePlannerOptions {
  authMethod: AuthMethod;
  provider: ProviderAdapter;
  apiKey?: string;
  modelId: string;
  chatId?: string;
  cliPath?: string;
}

export function plannerKindForAuth(authMethod: AuthMethod): PlannerKind {
  return authMethod === 'cli_account' ? 'subscription' : 'sdk';
}

export function createPlanner(opts: CreatePlannerOptions): Planner {
  if (opts.authMethod === 'cli_account') {
    if (opts.provider.id !== 'anthropic' && opts.provider.id !== 'google') {
      throw new Error(`Action Plan subscription is not supported for ${opts.provider.id}`);
    }
    return new SubscriptionPlanner(opts);
  }
  if (!opts.apiKey) {
    throw new Error('API key is required for Action Plan in api_key mode');
  }
  return new SdkStructuredPlanner({
    provider: opts.provider,
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    sessionId: opts.chatId,
  });
}
