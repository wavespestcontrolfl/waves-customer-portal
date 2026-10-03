/**
 * reschedule_log: what happened to a flagged visit, decided by a person.
 *
 * The nightly 6 PM check logs `customer_noshow` for every visit still open at
 * that hour. Production (60 days to 2026-10-03): all 74 such rows were written
 * by that check, none by a person; 64% of the visits were later cancelled and
 * 27% later completed on the same appointment. The row therefore means "not
 * closed out", and nothing recorded whether it was really a miss or what the
 * office did about it. These columns hold that answer (owner 2026-10-03):
 *
 *   resolved_at / resolution / resolved_by — the row is settled:
 *     'rebooked'  the appointment was moved to a new time
 *     'completed' the visit was performed
 *     'dismissed' not a miss (cancelled on purpose, duplicate, customer skipped)
 *     'backlog'   existed before this migration (see below)
 *   miss_confirmed_at / miss_confirmed_by — a person said "this was a miss".
 *     Only a confirmed, unresolved row may ever reach a customer-facing apology.
 *
 * Also: one open "visit not closed out" Action Queue card per visit (partial
 * unique index on dispatch_alerts, like the tech_late / unassigned_overdue ones).
 *
 * Backlog (owner 2026-10-03: "clear them"): every existing customer_noshow row
 * is marked resolved as 'backlog' so the worklist starts empty. Only rows that
 * are still unresolved are touched, so a re-run changes nothing.
 */
const COLUMNS = ['resolved_at', 'resolution', 'resolved_by', 'miss_confirmed_at', 'miss_confirmed_by'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('reschedule_log'))) return;
  const has = {};
  for (const col of COLUMNS) has[col] = await knex.schema.hasColumn('reschedule_log', col);
  await knex.schema.alterTable('reschedule_log', (t) => {
    if (!has.resolved_at) t.timestamp('resolved_at', { useTz: true });
    if (!has.resolution) t.string('resolution', 20);
    if (!has.resolved_by) t.string('resolved_by', 80);
    if (!has.miss_confirmed_at) t.timestamp('miss_confirmed_at', { useTz: true });
    if (!has.miss_confirmed_by) t.string('miss_confirmed_by', 80);
  });
  await knex('reschedule_log')
    .where({ reason_code: 'customer_noshow' })
    .whereNull('resolved_at')
    .update({ resolved_at: knex.fn.now(), resolution: 'backlog', resolved_by: 'migration' });
  // the worklist read: a customer's (or everyone's) unresolved flagged visits
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_reschedule_log_noshow_unresolved
    ON reschedule_log (created_at) WHERE reason_code = 'customer_noshow' AND resolved_at IS NULL`);
  // One open "visit not closed out" card per visit — the same DB-level dedupe
  // tech_late and unassigned_overdue have (createAlertOnce's ON CONFLICT relies on it).
  if (await knex.schema.hasTable('dispatch_alerts')) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_not_closed_out_one_unresolved
      ON dispatch_alerts (job_id)
      WHERE type = 'visit_not_closed_out' AND resolved_at IS NULL AND job_id IS NOT NULL`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('reschedule_log'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_reschedule_log_noshow_unresolved');
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_not_closed_out_one_unresolved');
  const has = {};
  for (const col of COLUMNS) has[col] = await knex.schema.hasColumn('reschedule_log', col);
  await knex.schema.alterTable('reschedule_log', (t) => {
    for (const col of COLUMNS) if (has[col]) t.dropColumn(col);
  });
};
