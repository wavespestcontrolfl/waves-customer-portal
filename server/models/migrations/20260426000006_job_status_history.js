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
 * The 8-value set, inline so future readers don't need to chase the
 * pointer to migration 20260426000004:
 *   pending | confirmed | rescheduled | en_route | on_site
 *   completed | cancelled | skipped
 * Note: this is NOT the original initial_schema.js enum (which had
 * only 5 values: pending|confirmed|rescheduled|cancelled|completed).
 * Migration 20260426000004 (already on main as part of PR #278,
 * commit 5d41b6f) drops that CHECK and recreates with the 8-value
 * set above. job_status_history runs after ...004, so the mirror
 * matches the live constraint, not the historical one.
 *
 * Historical note: an earlier sketch (`server/services/work-order-status.js`)
 * defined an aspirational 9-value lifecycle that diverged from this
 * CHECK and from scheduled_services_status_check. Codex flagged it
 * during #280 review; investigation confirmed it had zero callers
 * and was already broken against the live schema. Resolved in #281
 * by deleting the file — service delivery and billing lifecycles
 * stay separate (payment states belong on invoice/payment records,
 * not on scheduled_services.status). If a future PR reintroduces a
 * canonical-state-machine helper, BOTH this CHECK and
 * scheduled_services_status_check need extending in lockstep —
 * never widen one without the other or the audit table can record
 * states the source-of-truth column rejects.
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
