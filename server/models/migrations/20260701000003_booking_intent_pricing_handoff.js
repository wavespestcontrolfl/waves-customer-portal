/**
 * Quote→book handoff through abandoned-booking recovery.
 *
 * A /book visitor who arrived from a priced quote link carries
 * estimate_id + estimate_token (the #2251 pay-at-visit handoff). If they abandon,
 * the recovery SMS/email rebuilds a bare /book link — dropping the handoff — so
 * the recovered booking would be created UNPRICED (no estimated_price /
 * payment_method_preference / create_invoice_on_complete) and completion would
 * never auto-invoice. Persist the HMAC-verified handoff on the intent so the
 * recovery link re-carries it (services/booking-abandon-recovery.js
 * bookingUrlFor); /booking/confirm re-verifies everything fail-closed.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('booking_intents'))) return;
  const hasId = await knex.schema.hasColumn('booking_intents', 'pricing_estimate_id');
  if (!hasId) {
    await knex.schema.alterTable('booking_intents', (t) => {
      t.uuid('pricing_estimate_id');       // handoff estimate (PRICING only, never identity)
      t.string('pricing_estimate_token');  // its HMAC token, verified at capture time
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('booking_intents'))) return;
  if (await knex.schema.hasColumn('booking_intents', 'pricing_estimate_id')) {
    await knex.schema.alterTable('booking_intents', (t) => {
      t.dropColumn('pricing_estimate_id');
      t.dropColumn('pricing_estimate_token');
    });
  }
};
