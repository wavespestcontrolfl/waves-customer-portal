/**
 * reschedule_log: the missed OCCURRENCE's own scope, frozen when it is logged.
 *
 * A customer no-show row recorded the slot (original_date + original_window) but
 * not WHAT was missed or WHERE: readers had to join the live scheduled_services
 * row, whose service_type and property_id can be corrected or reused later, so a
 * Pest miss could later read as Lawn, or be judged against another address. The
 * writers now stamp both at insert (missed-appointment onSkip, the rebooker's
 * per-service move). Nullable: rows logged before this migration have no frozen
 * scope, and readers treat that as unknown — never as the current row's values.
 * No FK on the property: a snapshot outlives the row it describes.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('reschedule_log', (t) => {
    t.text('occurrence_service_type');
    t.uuid('occurrence_property_id');
  });
  // the SMS missed-visit read: one customer's no-shows in a short lookback
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_reschedule_log_customer_noshow
    ON reschedule_log (customer_id, original_date) WHERE reason_code = 'customer_noshow'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_reschedule_log_customer_noshow');
  await knex.schema.alterTable('reschedule_log', (t) => {
    t.dropColumn('occurrence_property_id');
    t.dropColumn('occurrence_service_type');
  });
};
