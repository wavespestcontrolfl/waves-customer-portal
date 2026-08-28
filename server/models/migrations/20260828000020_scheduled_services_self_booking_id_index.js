/**
 * Index scheduled_services.self_booking_id.
 *
 * The max_self_books_per_day counters (availability.js
 * SELF_BOOKING_EFFECTIVE_DATE_SQL — offer sweep in routes/booking.js and the
 * commit gate countActiveSelfBookingsForDay) resolve every non-cancelled
 * self_booked_appointments row to its linked live visit through a correlated
 * lookup on this column. It was created unindexed
 * (20260401000048_self_scheduling.js), which makes that lookup a full scan of
 * scheduled_services per booking row on the public booking/reschedule path.
 * Plain (non-CONCURRENT) index: knex runs migrations inside a transaction and
 * the table is modest; IF NOT EXISTS keeps the migration idempotent.
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_scheduled_services_self_booking_id ON scheduled_services (self_booking_id) WHERE self_booking_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_self_booking_id');
};
