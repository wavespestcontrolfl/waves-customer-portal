/**
 * ad_service_attribution.self_booked_appointment_id — key a self-booking's
 * funnel row to the booking that produced it.
 *
 * Organic (non-paid) self-bookings now get an attribution row too, but they
 * mint no lead, so their rows sit at lead_id NULL — and the existing
 * uq_ad_service_attribution_lead unique index treats NULLs as distinct
 * (verified in 20260626000013), so lead_id can neither dedupe them nor stop a
 * replayed insert from creating a second row for the same booking. This column
 * is that dedupe key: one funnel row per self-booking, enforced by the UNIQUE
 * index (inserts use ON CONFLICT DO NOTHING on it).
 *
 * Nullable + onDelete SET NULL: every existing row (web/call/minted paid
 * self-booking) stays NULL and is unaffected — NULLs are distinct here for the
 * same reason they are on lead_id, so the many NULL rows never collide.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasBookings = await knex.schema.hasTable('self_booked_appointments');
  if (!hasBookings) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'self_booked_appointment_id');
  if (hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.uuid('self_booked_appointment_id').references('id').inTable('self_booked_appointments').onDelete('SET NULL');
    t.unique('self_booked_appointment_id', { indexName: 'uq_ad_service_attribution_self_booking' });
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'self_booked_appointment_id');
  if (!hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('self_booked_appointment_id');
  });
};
