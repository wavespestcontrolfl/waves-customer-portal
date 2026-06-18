/**
 * Backfill is_callback on existing re-service scheduled_services rows.
 *
 * The server-side auto-flag (admin-schedule POST + edit reclassification) and
 * the completion / Charge-now / project-completion billing suppression all key
 * off `scheduled_services.is_callback`. Rows created BEFORE the auto-flag
 * shipped still have `is_callback = false`, so a pending free
 * "Pest Control Re-Service" / "Lawn Care Re-Service" callback would fall through
 * to the customer's monthly_rate at completion and bill a full month's dues.
 *
 * Backfill the flag on every still-completable re-service row so the single
 * `is_callback` source of truth is correct for the in-flight schedule. Matches
 * the runtime classifier (services/re-service.js): a `service_id` pointing at
 * the pest_re_service / lawn_re_service catalog rows, OR a "re-service"
 * service_type label.
 *
 * Terminal rows (completed / cancelled / ...) are intentionally left alone —
 * completed callbacks report off service_records, and rewriting history would
 * change nothing downstream.
 */

const RE_SERVICE_KEYS = ['pest_re_service', 'lawn_re_service'];
const TERMINAL_STATUSES = ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show'];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasFlag = await knex.schema.hasColumn('scheduled_services', 'is_callback');
  if (!hasFlag) return;

  let reServiceIds = [];
  if (await knex.schema.hasTable('services')) {
    reServiceIds = await knex('services').whereIn('service_key', RE_SERVICE_KEYS).pluck('id');
  }
  const hasServiceIdCol = await knex.schema.hasColumn('scheduled_services', 'service_id');

  await knex('scheduled_services')
    .where(function () {
      this.where('is_callback', false).orWhereNull('is_callback');
    })
    .whereNotIn('status', TERMINAL_STATUSES)
    .where(function () {
      // Matches "Pest Control Re-Service" / "Lawn Care Re-Service" (and the
      // unhyphenated variant) the same way services/re-service.js does.
      this.whereRaw('service_type ILIKE ?', ['%re-service%'])
        .orWhereRaw('service_type ILIKE ?', ['%reservice%']);
      if (hasServiceIdCol && reServiceIds.length > 0) {
        this.orWhereIn('service_id', reServiceIds);
      }
    })
    .update({ is_callback: true });
};

exports.down = async function down() {
  // No-op: backfilled rows are indistinguishable from rows flagged at creation,
  // and clearing the flag would re-expose the monthly-dues billing bug.
};
