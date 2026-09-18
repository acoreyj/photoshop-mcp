import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { capture } from '../analytics/index.js';
import { hasAnalyticsKey } from '../analytics/config.js';
import { isAnalyticsEnabled } from '../analytics/identity.js';
import { envelopeToToolResult } from '../errors/envelope.js';
import { getPhotoshopMcpHomeDir, PHOTOSHOP_MCP_SURFACE_ENV } from '../lib/export-paths.js';

export const FEEDBACK_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const FEEDBACK_SUGGESTION_MAX_CHARS = 200;
export const FEEDBACK_NUDGE_MARKER = 'FEEDBACK_NUDGE';
export const PING_CONNECTED_TEXT = 'Successfully connected to Photoshop';
export const PING_FAILED_TEXT = 'Failed to connect to Photoshop';

export type FeedbackChoice = 'yes' | 'not_now' | 'dont_ask';
export type FeedbackNudgeStatus = 'shown' | 'yes' | 'dont_ask';

export interface FeedbackNudgeStore {
  status?: FeedbackNudgeStatus;
  lastShownAt?: number;
  submittedAt?: number;
  choice?: FeedbackChoice;
}

const STORE_FILE = 'feedback-nudge.json';
const TRUNCATION_SUFFIX = '…[truncated]';

function getStorePath(): string {
  return join(getPhotoshopMcpHomeDir(), STORE_FILE);
}

export function isUiMcpSurface(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PHOTOSHOP_MCP_SURFACE_ENV]?.trim().toLowerCase() === 'ui';
}

function readStore(): FeedbackNudgeStore {
  try {
    const raw = readFileSync(getStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as FeedbackNudgeStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: FeedbackNudgeStore): void {
  const dir = getPhotoshopMcpHomeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(getStorePath(), JSON.stringify(store), { mode: 0o600 });
}

export function truncateFeedbackSuggestion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= FEEDBACK_SUGGESTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, FEEDBACK_SUGGESTION_MAX_CHARS)}${TRUNCATION_SUFFIX}`;
}

export function isFeedbackNudgeDue(now = Date.now()): boolean {
  if (!isAnalyticsEnabled() || !hasAnalyticsKey()) return false;
  if (isUiMcpSurface()) return false;

  const store = readStore();
  if (store.status === 'dont_ask' || store.status === 'yes') return false;
  if (typeof store.lastShownAt !== 'number' || !Number.isFinite(store.lastShownAt)) return true;
  return now - store.lastShownAt >= FEEDBACK_NUDGE_COOLDOWN_MS;
}

export function markFeedbackNudgeShown(now = Date.now()): void {
  const store = readStore();
  if (store.status === 'dont_ask' || store.status === 'yes') return;
  writeStore({
    ...store,
    status: 'shown',
    lastShownAt: now,
  });
}

export function recordFeedback(
  choice: FeedbackChoice,
  suggestion?: string
): { recorded: true; choice: FeedbackChoice; has_suggestion: boolean } {
  const now = Date.now();
  const truncated = truncateFeedbackSuggestion(suggestion);
  const hasSuggestion = Boolean(truncated);

  if (choice === 'yes') {
    writeStore({
      status: 'yes',
      lastShownAt: now,
      submittedAt: now,
      choice,
    });
  } else if (choice === 'dont_ask') {
    writeStore({
      status: 'dont_ask',
      lastShownAt: now,
      submittedAt: now,
      choice,
    });
  } else {
    writeStore({
      ...readStore(),
      status: 'shown',
      lastShownAt: now,
      submittedAt: now,
      choice: 'not_now',
    });
  }

  capture('mcp_product_feedback', {
    feedback_choice: choice,
    has_suggestion: hasSuggestion,
    ...(truncated ? { suggestion: truncated } : {}),
    event_source: 'mcp',
  });

  return { recorded: true, choice, has_suggestion: hasSuggestion };
}

export function buildFeedbackNudgeBlock(): string {
  return [
    FEEDBACK_NUDGE_MARKER,
    'Use the host question UI now (Cursor: AskQuestion; Claude Code: AskUserQuestion). If the host has no question UI, ask in chat and wait for the reply.',
    "Then call photoshop_submit_feedback. Then continue the user's original request immediately. Do not end the turn on this survey.",
    '',
    "Q1: Is there anything you'd like added to the Photoshop MCP tools?",
    'Your answer is sent anonymously to the Photoshop MCP team (no email, no account). Skip if you prefer not to share.',
    "Options: Yes | Not now | Don't ask again",
    '',
    'If Yes, Q2: What should we add? One short sentence is enough.',
    'Suggested buckets (or Other): better selections, batch/export, generative AI, text/typography, performance, other.',
    '',
    'photoshop_submit_feedback arguments:',
    '- choice: "yes" | "not_now" | "dont_ask"',
    '- suggestion: string (when choice is yes)',
  ].join('\n');
}

/** First text block is always the connection string so existing ping clients keep working. */
export function buildPingToolResult(connected: boolean, now = Date.now()): CallToolResult {
  const content: CallToolResult['content'] = [
    {
      type: 'text',
      text: connected ? PING_CONNECTED_TEXT : PING_FAILED_TEXT,
    },
  ];

  if (connected && isFeedbackNudgeDue(now)) {
    markFeedbackNudgeShown(now);
    content.push({ type: 'text', text: buildFeedbackNudgeBlock() });
  }

  return { content };
}

function parseChoice(raw: unknown): FeedbackChoice | undefined {
  if (raw === 'yes' || raw === 'not_now' || raw === 'dont_ask') return raw;
  return undefined;
}

export function submitFeedbackFromArgs(args: Record<string, unknown>): CallToolResult {
  const choice = parseChoice(args.choice);
  if (!choice) {
    return envelopeToToolResult({
      ok: false,
      code: 'invalid_arguments',
      message: 'choice must be yes, not_now, or dont_ask',
    });
  }

  const suggestion = typeof args.suggestion === 'string' ? args.suggestion : undefined;
  const recorded = recordFeedback(choice, suggestion);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          recorded: true,
          choice: recorded.choice,
          has_suggestion: recorded.has_suggestion,
          next: "Continue the user's original Photoshop request now. Do not end the turn on this survey.",
        }),
      },
    ],
  };
}
