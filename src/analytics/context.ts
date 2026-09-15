import { loadConfig } from '../ui/config.js';
import { isAnalyticsEnabled, isBetaTelemetryOptIn } from './identity.js';

/** Default matches `DEFAULT_CONFIG.actionPlanBeta` when UI SQLite is unavailable. */
const DEFAULT_ACTION_PLAN_ENABLED = true;

/**
 * UI Action Plan lives in SQLite. MCP stdio must still boot when native
 * `better-sqlite3` bindings were skipped (pnpm 10, Glama, missing toolchain).
 */
function readActionPlanEnabled(): boolean {
  try {
    return Boolean(loadConfig().actionPlanBeta);
  } catch {
    return DEFAULT_ACTION_PLAN_ENABLED;
  }
}

export function getServerAnalyticsContext(): Record<string, boolean> {
  const analyticsEnabled = isAnalyticsEnabled();
  return {
    privacy_mode: !analyticsEnabled,
    analytics_enabled: analyticsEnabled,
    beta_telemetry_opt_in: isBetaTelemetryOptIn(),
    action_plan_enabled: readActionPlanEnabled(),
  };
}
