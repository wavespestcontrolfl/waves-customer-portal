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
 * Server-side master switch for actually mutating appointments. Apply mode is
 * IMPOSSIBLE — from cron OR a manual admin run — unless this is explicitly set.
 * Keeps the dry-run validation period safe even though requireAdmin callers can
 * pass {mode:'apply'}: an overrides.mode of 'apply' is downgraded to dry_run
 * here when the gate is off (defense in depth; the route also 403s).
 */
function isApplyAllowed() {
  return process.env.AUTO_DISPATCH_ALLOW_APPLY === 'true';
}

/**
 * Resolve the effective config. `overrides` (e.g. from the manual-run admin
 * endpoint) win over env; `mode` is always validated to dry_run|apply and is
 * force-downgraded to dry_run unless the server apply gate is enabled.
 */
function getAutoDispatchConfig(overrides = {}) {
  const envMode = process.env.AUTO_DISPATCH_MODE;
  let mode = overrides.mode || (VALID_MODES.has(envMode) ? envMode : 'dry_run');
  if (!VALID_MODES.has(mode)) mode = 'dry_run';

  const applyAllowed = isApplyAllowed();
  const applyBlocked = mode === 'apply' && !applyAllowed;
  if (applyBlocked) mode = 'dry_run'; // hard safety: never mutate without the gate

  return {
    mode,
    applyAllowed,
    applyBlocked,
    lockWindowDays: overrides.lockWindowDays
      ?? intEnv('AUTO_DISPATCH_LOCK_WINDOW_DAYS', 14, { min: 0, max: 365 }),
    lookaheadDays: overrides.lookaheadDays
      ?? intEnv('AUTO_DISPATCH_LOOKAHEAD_DAYS', 90, { min: 1, max: 365 }),
    // Candidate slots are searched within ± this many days of the visit's
    // existing scheduled_date, so route optimization can't collapse the
    // recurring cadence by pulling the visit far from its intended date.
    dateToleranceDays: overrides.dateToleranceDays
      ?? intEnv('AUTO_DISPATCH_DATE_TOLERANCE_DAYS', 7, { min: 1, max: 60 }),
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

module.exports = { getAutoDispatchConfig, isApplyAllowed, VALID_MODES };
