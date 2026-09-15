import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LanguageModelUsage } from 'ai';
import { resolveCliBinary } from '../providers/cli-utils.js';
import type { ProviderAdapter } from '../providers/registry.js';
import { buildPlannerMcpServerConfig } from './mcp-transport.js';
import { parsePlan, type Plan } from './plan-schema.js';
import { buildPlannerPrompt, buildRepairPrompt } from './plan-schema.js';
import type {
  PlanInput,
  PlanResult,
  Planner,
  PlannerEvent,
  PlannerKind,
  RepairInput,
} from './planner.js';
import {
  isSubmitActionPlanTool,
  PLANNER_MCP_SERVER_NAME,
  SUBMIT_ACTION_PLAN_ALLOWED_TOOLS,
  SUBMIT_ACTION_PLAN_TOOL,
} from './planner-submit.js';

const MAX_SUBMIT_ATTEMPTS = 3;

const SUBSCRIPTION_PLANNER_ADDENDUM = `
You have exactly one tool: ${SUBMIT_ACTION_PLAN_TOOL}. Call it once with the complete plan.
Do not write the plan as assistant text. Do not call any Photoshop, shell, or filesystem tools.
`.trim();

export interface SubscriptionPlannerOptions {
  provider: ProviderAdapter;
  modelId: string;
  cliPath?: string;
}

export class SubscriptionPlanner implements Planner {
  readonly kind: PlannerKind = 'subscription';

  constructor(private readonly opts: SubscriptionPlannerOptions) {}

  async *plan(input: PlanInput): AsyncGenerator<PlannerEvent, PlanResult> {
    const userPrompt = buildPlannerPrompt(input.catalog, input.history, input.prompt);
    return yield* this.submitPlan(input.systemPrompt, userPrompt, input.abortSignal);
  }

  async *repair(input: RepairInput): AsyncGenerator<PlannerEvent, PlanResult> {
    const userPrompt = buildRepairPrompt(
      input.catalog,
      input.originalPrompt,
      input.remaining,
      input.results,
      input.errorMessage
    );
    return yield* this.submitPlan(input.systemPrompt, userPrompt, input.abortSignal);
  }

  private async *submitPlan(
    systemPrompt: string,
    userPrompt: string,
    abortSignal: AbortSignal
  ): AsyncGenerator<PlannerEvent, PlanResult> {
    const system = `${systemPrompt}\n\n${SUBSCRIPTION_PLANNER_ADDENDUM}`;
    let lastError = 'Planning failed: submit_action_plan was not called.';

    for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
      if (abortSignal.aborted) {
        throw new Error('Planning aborted');
      }
      const prompt =
        attempt === 0
          ? userPrompt
          : `${userPrompt}\n\nPrevious attempt failed: ${lastError}\nYou MUST call ${SUBMIT_ACTION_PLAN_TOOL} exactly once.`;

      const work = join(tmpdir(), `psmcp-plan-${randomUUID()}`);
      const planOutPath = join(work, 'plan.json');
      await mkdir(work, { recursive: true });

      try {
        let usage: LanguageModelUsage | undefined;
        let capturedPlan: Plan | undefined;
        if (this.opts.provider.id === 'anthropic') {
          const ran = yield* this.runClaude(system, prompt, planOutPath, abortSignal);
          usage = ran.usage;
          capturedPlan = ran.plan;
        } else if (this.opts.provider.id === 'google') {
          const ran = yield* this.runGemini(system, prompt, planOutPath, abortSignal);
          usage = ran.usage;
          capturedPlan = ran.plan;
        } else {
          throw new Error(`Action Plan subscription is not supported for ${this.opts.provider.id}`);
        }

        const plan = capturedPlan ?? (await readPersistedPlan(planOutPath));
        if (plan) return { plan, usage };
        lastError = 'Planning failed: submit_action_plan was not called with a valid plan.';
      } catch (err) {
        lastError = (err as Error).message;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    throw new Error(lastError);
  }

  private async *runClaude(
    systemPrompt: string,
    prompt: string,
    planOutPath: string,
    abortSignal: AbortSignal
  ): AsyncGenerator<PlannerEvent, { usage?: LanguageModelUsage; plan?: Plan }> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    abortSignal.addEventListener('abort', onAbort);

    const mcpCfg = buildPlannerMcpServerConfig(planOutPath);
    const q = query({
      prompt,
      options: {
        model: this.opts.modelId,
        systemPrompt,
        maxTurns: 4,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        strictMcpConfig: true,
        mcpServers: {
          [PLANNER_MCP_SERVER_NAME]: mcpCfg,
        },
        allowedTools: [...SUBMIT_ACTION_PLAN_ALLOWED_TOOLS],
        abortController,
      },
    });

    let usage: LanguageModelUsage | undefined;
    let plan: Plan | undefined;
    try {
      for await (const message of q) {
        if (abortSignal.aborted) break;
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && isSubmitActionPlanTool(block.name)) {
              const partial = asPartialPlan(block.input);
              if (partial) yield { type: 'partial', plan: partial };
              try {
                plan = parsePlan(block.input);
                abortController.abort();
              } catch {
                // Sidecar validation may still persist a corrected payload.
              }
            }
          }
        }
        if (message.type === 'result') {
          usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            totalTokens: message.usage.input_tokens + message.usage.output_tokens,
            inputTokenDetails: {
              noCacheTokens: message.usage.input_tokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: message.usage.output_tokens,
              reasoningTokens: 0,
            },
          };
        }
      }
    } catch {
      // Abort after a valid submit_action_plan is expected; keep captured plan.
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      q.close();
    }
    return { usage, plan };
  }

  private async *runGemini(
    systemPrompt: string,
    prompt: string,
    planOutPath: string,
    abortSignal: AbortSignal
  ): AsyncGenerator<PlannerEvent, { usage?: LanguageModelUsage; plan?: Plan }> {
    const geminiPath = await resolveCliBinary('gemini', this.opts.cliPath);
    if (!geminiPath) {
      throw new Error('Gemini CLI not found. Install with `npm install -g @google/gemini-cli`.');
    }

    const workspaceDir = await createPlannerGeminiWorkspace(planOutPath);
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;
    const child = spawn(
      geminiPath,
      [
        '-p',
        fullPrompt,
        '-m',
        this.opts.modelId,
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
        '--skip-trust',
      ],
      {
        cwd: workspaceDir,
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const onAbort = () => child.kill('SIGTERM');
    abortSignal.addEventListener('abort', onAbort);

    let usage: LanguageModelUsage | undefined;
    let plan: Plan | undefined;
    try {
      for await (const raw of readJsonLines(child.stdout!)) {
        if (abortSignal.aborted) break;
        const event = raw as {
          type?: string;
          name?: string;
          input?: unknown;
          stats?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          error?: string | { message?: string };
        };
        if (event.type === 'tool_use' && isSubmitActionPlanTool(event.name)) {
          const partial = asPartialPlan(event.input);
          if (partial) yield { type: 'partial', plan: partial };
          try {
            plan = parsePlan(event.input);
          } catch {
            // Sidecar validation may still persist a corrected payload.
          }
        }
        if (event.type === 'error' && !plan) {
          const message =
            typeof event.error === 'string'
              ? event.error
              : (event.error?.message ?? 'Gemini CLI error');
          throw new Error(message);
        }
        if (event.type === 'result') {
          const inputTokens = event.stats?.inputTokens ?? 0;
          const outputTokens = event.stats?.outputTokens ?? 0;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens: event.stats?.totalTokens ?? inputTokens + outputTokens,
            inputTokenDetails: {
              noCacheTokens: inputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: outputTokens,
              reasoningTokens: 0,
            },
          };
        }
      }

      const exitCode = await waitForChild(child);
      if (!plan) {
        if (exitCode === 41) {
          throw new Error(
            'Gemini account authentication failed. Run `gemini auth login` and try again.'
          );
        }
        if (exitCode !== 0 && !abortSignal.aborted) {
          throw new Error(`Gemini CLI exited with code ${exitCode}`);
        }
      }
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill('SIGTERM');
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { usage, plan };
  }
}

async function createPlannerGeminiWorkspace(planOutPath: string): Promise<string> {
  const root = join(tmpdir(), `photoshop-mcp-gemini-plan-${randomUUID()}`);
  const geminiDir = join(root, '.gemini');
  await mkdir(geminiDir, { recursive: true });
  const mcp = buildPlannerMcpServerConfig(planOutPath);
  await writeFile(
    join(geminiDir, 'settings.json'),
    JSON.stringify(
      {
        mcpServers: {
          [PLANNER_MCP_SERVER_NAME]: {
            command: mcp.command,
            args: mcp.args,
            env: mcp.env,
            trust: true,
            timeout: 120_000,
          },
        },
      },
      null,
      2
    )
  );
  return root;
}

async function readPersistedPlan(outPath: string): Promise<Plan | null> {
  try {
    const raw = await readFile(outPath, 'utf8');
    return parsePlan(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function asPartialPlan(input: unknown): Partial<Plan> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Partial<Plan>;
}

async function* readJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<unknown> {
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Ignore malformed lines from CLI noise.
      }
    }
  }
  const tail = pending.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      // ignore
    }
  }
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
