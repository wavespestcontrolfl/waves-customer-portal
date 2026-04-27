/**
 * Partial unique index on dispatch_alerts to enforce DB-level
 * idempotency for tech_late alerts: at most one unresolved tech_late
 * row per job_id.
 *
 * Why this matters: the tech-late detector cron (services/tech-late-detector.js)
 * uses a NOT EXISTS read-side dedupe + an in-memory isRunning mutex.
 * The mutex protects against overlap inside ONE Node process, but
 * Railway's zero-downtime deploys run the old container and the new
 * container in parallel for ~30-60s during a release. Two ticks can
 * both pass NOT EXISTS, both call createAlert, and both insert
 * separate rows that broadcast as duplicate cards in the Action Queue.
 *
 * This index makes that race impossible at the storage layer. The
 * detector wraps createAlert in try/catch on '23505' (unique_violation)
 * so the losing tick fails quiet — winning tick already broadcast
 * the alert.
 *
 * Scope is type-specific (`WHERE type = 'tech_late'`) because other
 * alert types deliberately allow multiple unresolved rows per scope
 * (e.g., a future `truck_idle` could fire repeatedly during one trip
 * if the tech idles in multiple locations). The constraint is a
 * tech_late operational rule, not a global one.
 *
 * `AND job_id IS NOT NULL` is belt-and-suspenders. Postgres treats
 * NULLs as distinct in unique indexes by default, so omitting it
 * still works, but tech_late always has job_id and being explicit
 * matches the one-per-job semantic.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX idx_dispatch_alerts_tech_late_one_unresolved
      ON dispatch_alerts (job_id)
      WHERE type = 'tech_late'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_tech_late_one_unresolved');
};
