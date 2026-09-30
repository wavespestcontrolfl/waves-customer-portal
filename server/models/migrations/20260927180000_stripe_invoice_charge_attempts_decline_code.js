/**
 * Codex #4971 r16 P1 (termite annual renewal charge, slice 6b — finding 2).
 *
 * stripe_invoice_charge_attempts.decline_code — the raw Stripe
 * decline_code/error code for a 'failed' attempt, persisted alongside
 * error_message. Crash recovery (termite-annual-renewal-charge.js
 * pendingChargeOutcomeVerdict) used to treat every submitted 'failed'
 * attempt as a genuine decline, but authentication_required is classified
 * AMBIGUOUS by classifyChargeError (the off-session PaymentIntent can still
 * be completed and succeed later) whenever the live in-memory error is
 * available — a crash before that classification ever runs left recovery
 * with nothing but the attempt's own persisted status/error_message, and it
 * read 'failed' as a durable decline, sending a second pay link and a false
 * "your payment didn't go through" notice beside a PaymentIntent that could
 * still complete. This column lets that recovery reader ask the same
 * question the live classifier would.
 *
 * Additive and nullable. Written only by stripe.js's saved-card charge
 * failure path (resolveNoFundsSavedCardChargeAttempt); every other caller
 * omits it and the column stays null, exactly as before this migration.
 */
const COLUMN = 'decline_code';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('stripe_invoice_charge_attempts'))) return;
  if (!(await knex.schema.hasColumn('stripe_invoice_charge_attempts', COLUMN))) {
    await knex.schema.alterTable('stripe_invoice_charge_attempts', (t) => t.string(COLUMN, 64));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_invoice_charge_attempts'))) return;
  if (await knex.schema.hasColumn('stripe_invoice_charge_attempts', COLUMN)) {
    await knex.schema.alterTable('stripe_invoice_charge_attempts', (t) => t.dropColumn(COLUMN));
  }
};
