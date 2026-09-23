import { Output, streamText } from 'ai';
import type { ProviderAdapter } from '../providers/registry.js';
import { planSchema, type Plan } from './plan-schema.js';
import { buildPlannerPrompt, buildRepairPrompt } from './plan-schema.js';
import type {
  PlanInput,
  PlanResult,
  Planner,
  PlannerEvent,
  PlannerKind,
  RepairInput,
} from './planner.js';

export interface SdkStructuredPlannerOptions {
  provider: ProviderAdapter;
  apiKey: string;
  modelId: string;
  sessionId?: string;
}

export class SdkStructuredPlanner implements Planner {
  readonly kind: PlannerKind = 'sdk';

  constructor(private readonly opts: SdkStructuredPlannerOptions) {}

  async *plan(input: PlanInput): AsyncGenerator<PlannerEvent, PlanResult> {
    return yield* this.streamPlan(
      input.systemPrompt,
      buildPlannerPrompt(input.catalog, input.history, input.prompt),
      input.abortSignal
    );
  }

  async *repair(input: RepairInput): AsyncGenerator<PlannerEvent, PlanResult> {
    return yield* this.streamPlan(
      input.systemPrompt,
      buildRepairPrompt(
        input.catalog,
        input.originalPrompt,
        input.remaining,
        input.results,
        input.errorMessage
      ),
      input.abortSignal
    );
  }

  private async *streamPlan(
    system: string,
    prompt: string,
    abortSignal: AbortSignal
  ): AsyncGenerator<PlannerEvent, PlanResult> {
    const model = this.opts.provider.getLanguageModel({
      apiKey: this.opts.apiKey,
      modelId: this.opts.modelId,
      sessionId: this.opts.sessionId,
    });
    const streamed = streamText({
      model,
      output: Output.object({ schema: planSchema }),
      system,
      prompt,
      abortSignal,
    });

    for await (const partial of streamed.partialOutputStream) {
      yield { type: 'partial', plan: partial as Partial<Plan> };
    }

    return {
      plan: await streamed.output,
      usage: await streamed.usage,
    };
  }
}
