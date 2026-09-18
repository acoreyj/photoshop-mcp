import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/analytics/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/analytics/index.js')>();
  return {
    ...actual,
    capture: vi.fn(),
  };
});

import { capture } from '../src/analytics/index.js';
import { sanitizeAnalyticsProperties } from '../src/analytics/events.js';
import {
  FEEDBACK_NUDGE_COOLDOWN_MS,
  FEEDBACK_NUDGE_MARKER,
  FEEDBACK_SUGGESTION_MAX_CHARS,
  PING_CONNECTED_TEXT,
  PING_FAILED_TEXT,
  buildPingToolResult,
  isFeedbackNudgeDue,
  markFeedbackNudgeShown,
  recordFeedback,
  submitFeedbackFromArgs,
} from '../src/feedback/nudge.js';
import { PHOTOSHOP_MCP_SURFACE_ENV } from '../src/lib/export-paths.js';

function textBlocks(result: { content: Array<{ type: string; text?: string }> }): string[] {
  return result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}

describe('MCP feedback nudge', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousDisabled: string | undefined;
  let previousPosthog: string | undefined;
  let previousSurface: string | undefined;

  beforeEach(() => {
    previousHome = process.env.PHOTOSHOP_MCP_HOME;
    previousDisabled = process.env.ANALYTICS_DISABLED;
    previousPosthog = process.env.POSTHOG_DISABLED;
    previousSurface = process.env[PHOTOSHOP_MCP_SURFACE_ENV];
    home = mkdtempSync(join(tmpdir(), 'ph-mcp-feedback-'));
    process.env.PHOTOSHOP_MCP_HOME = home;
    delete process.env.ANALYTICS_DISABLED;
    delete process.env.POSTHOG_DISABLED;
    delete process.env[PHOTOSHOP_MCP_SURFACE_ENV];
    vi.mocked(capture).mockClear();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PHOTOSHOP_MCP_HOME;
    else process.env.PHOTOSHOP_MCP_HOME = previousHome;
    if (previousDisabled === undefined) delete process.env.ANALYTICS_DISABLED;
    else process.env.ANALYTICS_DISABLED = previousDisabled;
    if (previousPosthog === undefined) delete process.env.POSTHOG_DISABLED;
    else process.env.POSTHOG_DISABLED = previousPosthog;
    if (previousSurface === undefined) delete process.env[PHOTOSHOP_MCP_SURFACE_ENV];
    else process.env[PHOTOSHOP_MCP_SURFACE_ENV] = previousSurface;
    rmSync(home, { recursive: true, force: true });
  });

  it('is due on a fresh install', () => {
    expect(isFeedbackNudgeDue(1_000_000)).toBe(true);
  });

  it('starts a 7-day cooldown when the ping nudge is shown', () => {
    const now = 1_000_000;
    markFeedbackNudgeShown(now);
    expect(isFeedbackNudgeDue(now)).toBe(false);
    expect(isFeedbackNudgeDue(now + FEEDBACK_NUDGE_COOLDOWN_MS - 1)).toBe(false);
    expect(isFeedbackNudgeDue(now + FEEDBACK_NUDGE_COOLDOWN_MS)).toBe(true);
  });

  it('does not ask again after yes', () => {
    const now = 1_000_000;
    markFeedbackNudgeShown(now);
    recordFeedback('yes', 'batch rename layers');
    expect(isFeedbackNudgeDue(now + FEEDBACK_NUDGE_COOLDOWN_MS * 4)).toBe(false);
  });

  it('does not ask again after dont_ask', () => {
    recordFeedback('dont_ask');
    expect(isFeedbackNudgeDue(Date.now() + FEEDBACK_NUDGE_COOLDOWN_MS * 4)).toBe(false);
  });

  it('asks again 7 days after not_now', () => {
    recordFeedback('not_now');
    const stored = JSON.parse(readFileSync(join(home, 'feedback-nudge.json'), 'utf8')) as {
      lastShownAt: number;
    };
    expect(isFeedbackNudgeDue(stored.lastShownAt)).toBe(false);
    expect(isFeedbackNudgeDue(stored.lastShownAt + FEEDBACK_NUDGE_COOLDOWN_MS)).toBe(true);
  });

  it('is not due when analytics are disabled', () => {
    process.env.ANALYTICS_DISABLED = '1';
    expect(isFeedbackNudgeDue(1_000_000)).toBe(false);
  });

  it('is not due on the standalone UI surface', () => {
    process.env[PHOTOSHOP_MCP_SURFACE_ENV] = 'ui';
    expect(isFeedbackNudgeDue(1_000_000)).toBe(false);
  });

  it('keeps the ping connected prefix and appends FEEDBACK_NUDGE when due', () => {
    const result = buildPingToolResult(true, 1_000_000);
    const texts = textBlocks(result);
    expect(texts[0]).toBe(PING_CONNECTED_TEXT);
    expect(texts[1]).toContain(FEEDBACK_NUDGE_MARKER);
    expect(texts[1]).toContain('photoshop_submit_feedback');
    expect(existsSync(join(home, 'feedback-nudge.json'))).toBe(true);
  });

  it('does not append a nudge on a failed ping', () => {
    const result = buildPingToolResult(false, 1_000_000);
    expect(textBlocks(result)).toEqual([PING_FAILED_TEXT]);
    expect(isFeedbackNudgeDue(1_000_000)).toBe(true);
  });

  it('does not append a second nudge in the same cooldown window', () => {
    const first = buildPingToolResult(true, 1_000_000);
    const second = buildPingToolResult(true, 1_000_001);
    expect(textBlocks(first)).toHaveLength(2);
    expect(textBlocks(second)).toEqual([PING_CONNECTED_TEXT]);
  });

  it('truncates suggestions to 200 characters and captures the event', () => {
    const long = 'x'.repeat(FEEDBACK_SUGGESTION_MAX_CHARS + 25);
    recordFeedback('yes', `  ${long}  `);
    expect(capture).toHaveBeenCalledWith(
      'mcp_product_feedback',
      expect.objectContaining({
        feedback_choice: 'yes',
        has_suggestion: true,
        suggestion: `${'x'.repeat(FEEDBACK_SUGGESTION_MAX_CHARS)}…[truncated]`,
        event_source: 'mcp',
      })
    );
  });

  it('rejects an invalid submit choice', () => {
    const result = submitFeedbackFromArgs({ choice: 'maybe' });
    expect(result.isError).toBe(true);
    expect(textBlocks(result).join('')).toContain('invalid_arguments');
  });

  it('tells the agent to continue after a valid submit', () => {
    const result = submitFeedbackFromArgs({
      choice: 'yes',
      suggestion: 'better selections',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textBlocks(result).join('')) as {
      ok: boolean;
      next: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.next).toMatch(/original Photoshop request/i);
  });
});

describe('feedback analytics allowlist', () => {
  it('keeps suggestion and drops blocked prompt text', () => {
    expect(
      sanitizeAnalyticsProperties({
        feedback_choice: 'yes',
        has_suggestion: true,
        suggestion: 'batch rename layers',
        prompt: 'secret chat',
        event_source: 'mcp',
      })
    ).toEqual({
      feedback_choice: 'yes',
      has_suggestion: true,
      suggestion: 'batch rename layers',
      event_source: 'mcp',
    });
  });
});
