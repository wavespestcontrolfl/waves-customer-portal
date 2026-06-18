/**
 * Backfill re-service callback state for rows created before the auto-flag.
 *
 * The completion / Charge-now / project-completion billing suppression keys off
 * `scheduled_services.is_callback`, and completed callback history/reporting
 * reads `service_records.is_callback` (record creation copies the scheduled
 * flag). Rows created BEFORE the server-side auto-flag shipped still have
 * `is_callback = false`, so on rollout:
 *   1. pending free "Pest Control Re-Service" / "Lawn Care Re-Service" callbacks
 *      fall through to cust_monthly_rate at completion and bill a full month;
 *   2. any monthly-dues invoice already minted by a pre-migration "Charge now"
 *      survives — completion reuses any non-void invoice by
 *      scheduled_service_id, so the stale dues are still collected; and
 *   3. completed pre-flag re-services are invisible to callback metrics (e.g.
 *      the pest-pressure callback-impact query filters is_callback = true).
 *
 * This migration repairs all three. Matches the runtime classifier
 * (services/re-service.js): a service_id pointing at the pest_re_service /
 * lawn_re_service catalog rows, OR a "re-service" service_type label.
 */

const RE_SERVICE_KEYS = ['pest_re_service', 'lawn_re_service'];
const TERMINAL_STATUSES = ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show'];
const INVOICE_SETTLED_STATUSES = ['paid', 'prepaid', 'void'];

exports.up = async function up(knex) {
  const hasScheduled = await knex.schema.hasTable('scheduled_services');
  if (!hasScheduled) return;
  const ssHasFlag = await knex.schema.hasColumn('scheduled_services', 'is_callback');
  if (!ssHasFlag) return;

  let reServiceIds = [];
  if (await knex.schema.hasTable('services')) {
    reServiceIds = await knex('services').whereIn('service_key', RE_SERVICE_KEYS).pluck('id');
  }

  // Re-service predicate (service_id catalog match OR "re-service" label),
  // bound to whether the target table has a service_id column.
  const reServiceMatch = (hasServiceIdCol) => function reServiceWhere() {
    this.whereRaw('service_type ILIKE ?', ['%re-service%'])
      .orWhereRaw('service_type ILIKE ?', ['%reservice%']);
    if (hasServiceIdCol && reServiceIds.length > 0) this.orWhereIn('service_id', reServiceIds);
  };

  // 1. Flag still-completable scheduled rows so completion suppresses the
  //    monthly-rate fallback. Capture ids so we can also clear their stale
  //    invoices.
  const ssHasServiceId = await knex.schema.hasColumn('scheduled_services', 'service_id');
  const pendingReServiceIds = await knex('scheduled_services')
    .whereNotIn('status', TERMINAL_STATUSES)
    .where(reServiceMatch(ssHasServiceId))
    .pluck('id');

  if (pendingReServiceIds.length > 0) {
    await knex('scheduled_services')
      .whereIn('id', pendingReServiceIds)
      .where(function () { this.where('is_callback', false).orWhereNull('is_callback'); })
      .update({ is_callback: true });

    // 2. Void stale, unpaid invoices minted from the old monthly-rate fallback
    //    (e.g. a pre-migration "Charge now"). Completion reuses any non-void
    //    invoice by scheduled_service_id, so these would still collect monthly
    //    dues on a now-free callback. Only target rows with NO intentional
    //    positive price — a re-service the operator priced on purpose has a
    //    legitimate invoice/pay link that must be preserved. Paid/prepaid are
    //    left alone (refunds are out of scope for a data backfill).
    if (await knex.schema.hasTable('invoices')
        && await knex.schema.hasColumn('invoices', 'scheduled_service_id')) {
      const freeReServiceIds = await knex('scheduled_services')
        .whereIn('id', pendingReServiceIds)
        .where(function () { this.whereNull('estimated_price').orWhere('estimated_price', 0); })
        .pluck('id');
      if (freeReServiceIds.length > 0) {
        const voidUpdate = { status: 'void' };
        if (await knex.schema.hasColumn('invoices', 'updated_at')) voidUpdate.updated_at = knex.fn.now();
        await knex('invoices')
          .whereIn('scheduled_service_id', freeReServiceIds)
          .whereNotIn('status', INVOICE_SETTLED_STATUSES)
          .update(voidUpdate);
      }
    }
  }

  // 3. Repair completed history so callback metrics + report copy see past
  //    re-services. service_records is the reporting source of truth; it copies
  //    is_callback at creation, so pre-flag completed records need the same
  //    classification applied directly.
  if (await knex.schema.hasTable('service_records')
      && await knex.schema.hasColumn('service_records', 'is_callback')) {
    const srHasServiceId = await knex.schema.hasColumn('service_records', 'service_id');
    await knex('service_records')
      .where(function () { this.where('is_callback', false).orWhereNull('is_callback'); })
      .where(reServiceMatch(srHasServiceId))
      .update({ is_callback: true });
  }
};

exports.down = async function down() {
  // No-op: backfilled rows are indistinguishable from rows flagged at creation,
  // clearing the flag would re-expose the monthly-dues billing bug, and voided
  // stale invoices should stay voided.
};
