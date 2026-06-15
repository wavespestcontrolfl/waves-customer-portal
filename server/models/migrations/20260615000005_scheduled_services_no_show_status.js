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

const PREV_STATUS_VALUES = STATUS_VALUES.filter((s) => s !== 'no_show');

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
  // Best-effort revert to the pre-no_show set. Any rows already at
  // 'no_show' would block the narrower CHECK, so leave them be — the
  // down path is only meaningful on a DB that never recorded one.
  await knex.raw('ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS scheduled_services_status_check');
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD CONSTRAINT scheduled_services_status_check
      CHECK (status IN (${inList(PREV_STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_to_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_to_status_check
      CHECK (to_status IN (${inList(PREV_STATUS_VALUES)}))
  `);

  await knex.raw('ALTER TABLE job_status_history DROP CONSTRAINT IF EXISTS job_status_history_from_status_check');
  await knex.raw(`
    ALTER TABLE job_status_history
      ADD CONSTRAINT job_status_history_from_status_check
      CHECK (from_status IS NULL OR from_status IN (${inList(PREV_STATUS_VALUES)}))
  `);
};
