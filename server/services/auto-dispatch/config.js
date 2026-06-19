/**
 * Auto-Dispatch configuration.
 *
 * All knobs are env-driven with conservative defaults. The resolved object is
 * snapshotted into auto_dispatch_runs.config_snapshot on every run so a past
 * run's behavior is always reconstructable even after the env changes.
 *
 * Safety posture: dry_run by default, lock window 14 days, capped changes per
 * run, customer notifications OFF (the move itself is silent — comms are a
 * separate, gated step).
 */

function intEnv(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function boolEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return raw === 'true';
}

const VALID_MODES = new Set(['dry_run', 'apply']);

/**
 * Resolve the effective config. `overrides` (e.g. from the manual-run admin
 * endpoint) win over env; `mode` is always validated to dry_run|apply.
 */
function getAutoDispatchConfig(overrides = {}) {
  const envMode = process.env.AUTO_DISPATCH_MODE;
  let mode = overrides.mode || (VALID_MODES.has(envMode) ? envMode : 'dry_run');
  if (!VALID_MODES.has(mode)) mode = 'dry_run';

  return {
    mode,
    lockWindowDays: overrides.lockWindowDays
      ?? intEnv('AUTO_DISPATCH_LOCK_WINDOW_DAYS', 14, { min: 0, max: 365 }),
    lookaheadDays: overrides.lookaheadDays
      ?? intEnv('AUTO_DISPATCH_LOOKAHEAD_DAYS', 90, { min: 1, max: 365 }),
    minScoreImprovement: overrides.minScoreImprovement
      ?? intEnv('AUTO_DISPATCH_MIN_SCORE_IMPROVEMENT', 15, { min: 0, max: 100 }),
    maxChangesPerRun: overrides.maxChangesPerRun
      ?? intEnv('AUTO_DISPATCH_MAX_CHANGES_PER_RUN', 100, { min: 0, max: 100000 }),
    requirePortalPreferences: overrides.requirePortalPreferences
      ?? boolEnv('AUTO_DISPATCH_REQUIRE_PORTAL_PREFERENCES', false),
    notifyCustomers: overrides.notifyCustomers
      ?? boolEnv('AUTO_DISPATCH_NOTIFY_CUSTOMERS', false),
    // The largest improvement is enough to justify moving an already-moved
    // appointment a second time (defeats the stability penalty). Keeps the
    // job from thrashing the same customer across daily runs.
    removeStabilityFloor: overrides.removeStabilityFloor
      ?? intEnv('AUTO_DISPATCH_RESTABILIZE_IMPROVEMENT', 35, { min: 0, max: 100 }),
  };
}

module.exports = { getAutoDispatchConfig, VALID_MODES };
