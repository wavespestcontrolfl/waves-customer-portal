/**
 * Action queue storage for the dispatch board (Section 2.1 of the
 * tech-tracking spec — the right-pane card stack). Generators (cron
 * jobs and inline detectors that fire on tech_status / job_status
 * transitions) insert rows here; the dispatcher resolves them via
 * a future API endpoint.
 *
 * One row per actionable signal. Examples (loosely typed via the
 * `type` column so future generators can add new kinds without a
 * schema change):
 *   - 'tech_late'       — tech is N min behind on their route
 *   - 'missed_photo'    — job marked complete without required photo
 *   - 'moa_violation'   — same MOA at Nth consecutive lawn
 *   - 'truck_idle'      — Bouncie reports vehicle idle outside route
 *   - 'estimate_pending' — accepted estimate needs to be slotted
 *   - 'customer_cancel' — customer cancelled, suggest a swap
 *
 * Read path is the right-pane: "show me all unresolved alerts,
 * newest first." The partial index makes that read O(unresolved-row-count)
 * regardless of how many resolved alerts have accumulated. Resolved
 * rows stay around for audit / coaching review.
 *
 * severity uses a CHECK constraint (info | warn | critical). type is
 * an open string — frontend renders by type, unknown types fall
 * back to a generic card. Adding the next type is a one-line
 * generator change, not a migration.
 *
 * tech_id and job_id are both nullable: some alerts are scoped to
 * a tech (driver behavior, capacity warnings), some to a job (missed
 * photo, MOA violation), some to neither (a global signal like
 * "estimate_pending" not yet routed). The dispatcher UI shows the
 * scope in the card.
 *
 * resolved_at + resolved_by track WHO closed the card and WHEN —
 * the same audit pattern as job_status_history.transitioned_by.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('dispatch_alerts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('type', 50).notNullable();
    t.string('severity', 20).notNullable().defaultTo('info');
    t.uuid('tech_id')
      .references('id').inTable('technicians').onDelete('SET NULL');
    t.uuid('job_id')
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.jsonb('payload');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('resolved_at', { useTz: true });
    t.uuid('resolved_by')
      .references('id').inTable('technicians').onDelete('SET NULL');
  });

  // CHECK on severity. type is intentionally NOT constrained — see
  // the file header.
  await knex.raw(`
    ALTER TABLE dispatch_alerts
      ADD CONSTRAINT dispatch_alerts_severity_check
      CHECK (severity IN ('info', 'warn', 'critical'))
  `);

  // Primary read path: unresolved alerts, newest first. Partial
  // index keeps the index small as resolved rows accumulate.
  await knex.raw(`
    CREATE INDEX idx_dispatch_alerts_unresolved
      ON dispatch_alerts (created_at DESC)
      WHERE resolved_at IS NULL
  `);

  // Secondary reads: per-tech audit ("show me everything Adam was
  // flagged on this month"), per-job audit ("what alerts fired on
  // this job"). Both nullable, so use partial indexes.
  await knex.raw(`
    CREATE INDEX idx_dispatch_alerts_tech_created
      ON dispatch_alerts (tech_id, created_at DESC)
      WHERE tech_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX idx_dispatch_alerts_job_created
      ON dispatch_alerts (job_id, created_at DESC)
      WHERE job_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('dispatch_alerts');
};
