/**
 * Durable "a real customer booked" event (Codex #3178 r4 P0).
 *
 * Redemption must credit genuine customer bookings and never seeded series
 * children, bulk rebooks or imports — but prod data shows scheduled_services
 * carries no provenance that separates them. Marking the OFFER row was the
 * first attempt and it is circular: once an offer redeems it stops being
 * markable, so a later booking leaves no trace, and reversal logic then
 * can't tell whether the customer still has a qualifying booking.
 *
 * This table is that evidence, independent of any offer's lifecycle. Every
 * real booking surface writes one row inside its own booking transaction;
 * seeders and imports simply don't. Redemption, rebinding and late-offer
 * adoption all read from here.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('inspection_credit_booking_events')) return;
  await knex.schema.createTable('inspection_credit_booking_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    // One event per booking, ever — a retry or replay must not look like a
    // second booking.
    t.uuid('scheduled_service_id').notNullable().unique()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    // Which surface recorded it (admin_schedule / self_book / lead /
    // estimate_accept) — observability only, never behavior.
    t.string('source', 40);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['customer_id', 'created_at'], 'idx_inspection_credit_booking_customer');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('inspection_credit_booking_events');
};
