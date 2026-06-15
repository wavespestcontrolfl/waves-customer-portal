/**
 * Add 'no_show' to the scheduled_services status value set.
 *
 * The dispatch "Mark as no-show" action (MobileAppointmentDetailSheet →
 * PUT /admin/dispatch/:id/status with status='no_show') has always sent
 * 'no_show', but neither scheduled_services_status_check nor the
 * job_status_history mirror constraints (20260426000004 /
 * 20260426000006) included it — so the transition threw a CHECK
 * violation and the button surfaced "Failed to mark no-show: Internal
 * server error". Several services already treat 'no_show' as a terminal
 * status (waveguard-existing-services, prepaid-series, customer-pricing-ai,
 * context-aggregator), so the value was always intended; the constraints
 * just never caught up.
 *
 * Per the lockstep rule documented on 20260426000006, both the
 * source-of-truth constraint and the audit-table mirror are widened
 * together so the history table can never record a state the
 * scheduled_services column rejects.
 */
const STATUS_VALUES = [
  'pending',
  'confirmed',
  'rescheduled',
  'en_route',
  'on_site',
  'completed',
  'cancelled',
  'skipped',
  'no_show',
];

function inList(values) {
  return values.map((v) => `'${v}'`).join(',');
}

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_status_check');
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD CONSTRAINT scheduled_services_status_check
      CHECK (status IN (${inList(STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_to_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_to_status_check
      CHECK (to_status IN (${inList(STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_from_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_from_status_check
      CHECK (from_status IS NULL OR from_status IN (${inList(STATUS_VALUES)}))
  `);
};

exports.down = async function down(knex) {
  // Deliberately keep 'no_show' in the restored CHECK set. Postgres
  // validates existing rows when a CHECK is (re)added, so narrowing the
  // set after any visit was marked no_show — or any job_status_history
  // row recorded a no_show transition — would fail the ADD CONSTRAINT and
  // block the rollback. Mutating those rows instead would either rewrite
  // live operational state or corrupt the append-only audit log. Once the
  // value has been writable in an environment it can't be cleanly removed,
  // so down() re-asserts the same widened constraints (idempotent, never
  // fails); rolling back the feature code simply stops new no_show writes.
  await knex.raw('ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_status_check');
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD CONSTRAINT scheduled_services_status_check
      CHECK (status IN (${inList(STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_to_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_to_status_check
      CHECK (to_status IN (${inList(STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_from_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_from_status_check
      CHECK (from_status IS NULL OR from_status IN (${inList(STATUS_VALUES)}))
  `);
};
