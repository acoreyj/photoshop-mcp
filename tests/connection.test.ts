import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, platform: () => 'darwin' };
});

vi.mock('../src/platform/detector.js', () => ({
  PhotoshopDetector: class {
    async detect() {
      return {
        version: '27.9.1',
        path: '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app',
        isRunning: true,
        appName: 'Adobe Photoshop 2026',
      };
    }
  },
}));

import { MacOSExecutor } from '../src/platform/macos-executor.js';
import { PhotoshopConnection } from '../src/platform/connection.js';
import { PhotoshopAPIFactory } from '../src/api/photoshop-api.js';

const appNameOf = (executor: MacOSExecutor) =>
  (executor as unknown as { appName: string }).appName;

describe('PhotoshopConnection on macOS', () => {
  const seenAppNames: string[] = [];
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.PHOTOSHOP_MCP_HOME;
    home = mkdtempSync(join(tmpdir(), 'ph-mcp-conn-'));
    process.env.PHOTOSHOP_MCP_HOME = home;
    seenAppNames.length = 0;
    vi.spyOn(MacOSExecutor.prototype, 'isPhotoshopRunning').mockImplementation(async function (
      this: MacOSExecutor
    ) {
      seenAppNames.push(appNameOf(this));
      return true;
    });
    vi.spyOn(MacOSExecutor.prototype, 'execute').mockImplementation(async function (
      this: MacOSExecutor
    ) {
      seenAppNames.push(appNameOf(this));
      return 'ok';
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PHOTOSHOP_MCP_HOME;
    else process.env.PHOTOSHOP_MCP_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('applies the detected app name before the very first script runs', async () => {
    // Regression: the executor is created lazily, and setAppName used to run
    // before getExecutor(), so the first call of every session targeted the
    // hard-coded "Adobe Photoshop 2025" and failed on any other version.
    const connection = new PhotoshopConnection();
    await connection.executeScript('app.version');
    expect(seenAppNames).toEqual(['Adobe Photoshop 2026', 'Adobe Photoshop 2026']);
  });

  it('applies the detected app name in ensurePhotoshopRunning', async () => {
    const connection = new PhotoshopConnection();
    await connection.ensurePhotoshopRunning();
    expect(seenAppNames).toEqual(['Adobe Photoshop 2026']);
  });

  it('createAPI detects Photoshop on first use when info is not resolved yet', async () => {
    // Regression: createAPI() read getPhotoshopInfo() synchronously and threw
    // before executeScript() could run detection, so the first get_state of a
    // session failed with "Photoshop info not available" and the Action Plan
    // repair loop retried the same step until it gave up.
    const connection = new PhotoshopConnection();
    expect(connection.getPhotoshopInfo()).toBeNull();

    const api = await new PhotoshopAPIFactory(connection).createAPI();

    expect(api.getAPIType()).toBe('ExtendScript');
    expect(connection.getPhotoshopInfo()?.path).toContain('Adobe Photoshop 2026');
  });
});
