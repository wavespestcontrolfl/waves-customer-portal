/**
 * Partial unique index on dispatch_alerts to enforce DB-level
 * idempotency for unassigned_overdue alerts: at most one unresolved
 * unassigned_overdue row per job_id.
 *
 * Mirrors idx_dispatch_alerts_tech_late_one_unresolved (PR #308's
 * follow-up race fix). Same justification: the read-side NOT EXISTS
 * + in-memory isRunning mutex protect dedupe inside ONE Node
 * process, but Railway's zero-downtime deploys briefly overlap two
 * containers — both ticks can pass NOT EXISTS, both call
 * createAlert, and both insert. The partial unique index closes
 * that window at the storage layer, and the detector wraps
 * createAlert in a 23505 (unique_violation) catch to treat the
 * losing tick as a clean skip.
 *
 * Scope is type-specific (`WHERE type = 'unassigned_overdue'`) so
 * other alert types still allow multiple unresolved rows per scope
 * (e.g., a future `truck_idle` could fire repeatedly during one
 * trip). The constraint is operational, not global.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX idx_dispatch_alerts_unassigned_overdue_one_unresolved
      ON dispatch_alerts (job_id)
      WHERE type = 'unassigned_overdue'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_unassigned_overdue_one_unresolved');
};
