/**
 * Append-only log of every job (scheduled_services) state transition.
 * Powers:
 *   - dispatch board tech timeline view (Gantt blocks)
 *   - customer-facing 7-step tracker progress strip
 *   - tech KPI rollups (on-time %, avg job time, started→on-site lag)
 *   - compliance audit trail (who flipped what, when)
 *
 * Naming: spec uses "job_status_history"; the existing schema calls
 * the table scheduled_services. job_id references scheduled_services
 * — this table is the terminology bridge.
 *
 * Distinct from the legacy service_status_log table (status + lat/lng,
 * no from→to). That table stays for back-compat; new dispatcher and
 * tech-mobile code reads from this one.
 *
 * transitioned_by → technicians.id. Phase 1 auth investigation
 * confirmed technicians is the unified people-table for everyone who
 * logs into /admin or /tech (role column discriminates). The
 * admin_user_id-to-technicians.id pattern is established across
 * activity_log, sms_log, crm, pwa_push.
 *
 * to_status / from_status CHECK constraint mirrors the value set on
 * scheduled_services_status_check (post 20260426000004) so the two
 * tables can't drift. from_status is nullable — first transition on
 * a freshly-created scheduled_services row has no prior state.
 *
 * Known mismatch: server/services/work-order-status.js defines an
 * aspirational lifecycle (scheduled, in_progress, invoiced, paid)
 * that does NOT match this CHECK or scheduled_services_status_check.
 * That file is orphaned at merge time (zero callers) and would
 * itself crash a CHECK on scheduled_services.status the moment any
 * caller invoked transition() with one of its non-canonical values.
 * Resolution tracked in:
 *   https://github.com/wavespestcontrolfl/waves-customer-portal/issues/281
 * If work-order-status.js is activated before that issue is resolved,
 * BOTH this CHECK and scheduled_services_status_check need extending
 * in lockstep — never widen one without the other or the audit
 * table can record states the source-of-truth column rejects.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('job_status_history', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('job_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.string('from_status', 30);
    t.string('to_status', 30).notNullable();
    t.timestamp('transitioned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('transitioned_by')
      .references('id').inTable('technicians').onDelete('SET NULL');

    t.index(['job_id', 'transitioned_at'], 'idx_job_status_history_job_time');
    t.index('transitioned_at', 'idx_job_status_history_time');
  });

  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_to_status_check
      CHECK (to_status IN (
        'pending',
        'confirmed',
        'rescheduled',
        'en_route',
        'on_site',
        'completed',
        'cancelled',
        'skipped'
      ))
  `);

  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_from_status_check
      CHECK (from_status IS NULL OR from_status IN (
        'pending',
        'confirmed',
        'rescheduled',
        'en_route',
        'on_site',
        'completed',
        'cancelled',
        'skipped'
      ))
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('job_status_history');
};
