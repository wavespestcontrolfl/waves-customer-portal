/**
 * self_booked_appointments.attribution — persist the FULL client attribution
 * object for every self-booking.
 *
 * The public /book page (and the astro funnel's BookingForm) captures a rich
 * attribution object (UTMs + gclid/wbraid/gbraid/fbclid/_fbc/_fbp + referrer +
 * landing URL) and sends it with /booking/confirm — but the server only ever
 * persisted `source` + `referrer_url`. Everything else was read once by
 * attributeSelfBooking (which only acts on a paid click id for a just-created
 * customer) and then dropped, so organic/repeat bookings lost their capture
 * entirely and even paid bookings kept no raw record.
 *
 * Nullable jsonb: bookings with no client capture (voice-agent confirms, old
 * callers) stay NULL. Raw capture only — classification/grouping happens at
 * read time, so this never needs a backfill or rewrite.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('self_booked_appointments');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('self_booked_appointments', 'attribution');
  if (hasColumn) return;
  await knex.schema.alterTable('self_booked_appointments', (t) => {
    t.jsonb('attribution');
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('self_booked_appointments');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('self_booked_appointments', 'attribution');
  if (!hasColumn) return;
  await knex.schema.alterTable('self_booked_appointments', (t) => {
    t.dropColumn('attribution');
  });
};
