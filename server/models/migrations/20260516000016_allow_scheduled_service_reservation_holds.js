/**
 * Slot reservations are created before an estimate has been accepted, so
 * scheduled_services.customer_id must be nullable during the 15-minute hold.
 * commitReservation links the customer and clears reservation_expires_at.
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN customer_id DROP NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex('scheduled_services')
    .whereNull('customer_id')
    .whereNotNull('reservation_expires_at')
    .del();

  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN customer_id SET NOT NULL
  `);
};
