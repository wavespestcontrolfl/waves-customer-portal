/**
 * Slot reservation columns on scheduled_services.
 *
 * Enables the customer-facing "inline accept" flow:
 *   1. Customer picks a slot on the estimate view
 *   2. POST /api/public/estimates/:token/reserve creates a
 *      scheduled_services row with reservation_expires_at = NOW() + 15min,
 *      customer_id still null (the estimate may not be linked to a
 *      customer yet — acceptance is what creates that link).
 *   3. Customer taps Reserve → PUT /:token/accept commits the reservation
 *      (customer_id set, reservation_expires_at cleared).
 *   4. Abandoned reservations get reclaimed by releaseExpiredReservations()
 *      (PR B.1 ships the function; a cron caller follows in a later PR).
 *
 * source_estimate_id lets EstimateConverter detect whether a row was
 * already created via the reservation path so accept doesn't
 * double-create a second scheduled_services row for the same visit.
 *
 * payment_method_preference captures the customer's choice at accept
 * time:
 *   'deposit_now'  — front-desk / Stripe flow on confirmation page
 *   'pay_at_visit' — tech collects at service completion
 *   NULL           — pre-PR-B.1 rows, or rows created via other writers
 *                    (calendar-sync, voice-agent, admin booking, etc.)
 *
 * No backfill. Existing scheduled_services rows get NULL for all three
 * columns — correct; those predate this surface entirely.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.uuid('source_estimate_id').references('id').inTable('estimates');
    t.timestamp('reservation_expires_at');
    t.string('payment_method_preference', 20);
  });

  // Partial index — only rows with a live reservation. Cleanup cron
  // scans this narrow set, not the whole table.
  await knex.raw(`
    CREATE INDEX idx_scheduled_services_reservation_cleanup
      ON scheduled_services (reservation_expires_at)
      WHERE reservation_expires_at IS NOT NULL
  `);

  // Partial index — only rows created via an estimate accept.
  // EstimateConverter's "did we already create this?" lookup reads this.
  await knex.raw(`
    CREATE INDEX idx_scheduled_services_source_estimate
      ON scheduled_services (source_estimate_id)
      WHERE source_estimate_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_source_estimate');
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_reservation_cleanup');
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('payment_method_preference');
    t.dropColumn('reservation_expires_at');
    t.dropColumn('source_estimate_id');
  });
};
