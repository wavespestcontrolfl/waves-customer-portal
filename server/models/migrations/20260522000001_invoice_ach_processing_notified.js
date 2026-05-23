/**
 * Idempotency column for the customer-facing "ACH payment received,
 * processing" acknowledgment fired from the payment_intent.processing
 * webhook. Stamped once the SMS+email pair has been dispatched so Stripe
 * webhook retries (or a duplicate processing event after a status
 * downgrade) don't double-send to the customer.
 */

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('invoices', 'ach_processing_notified_at');
  if (!hasColumn) {
    await knex.schema.alterTable('invoices', (t) => {
      t.timestamp('ach_processing_notified_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('invoices', 'ach_processing_notified_at');
  if (hasColumn) {
    await knex.schema.alterTable('invoices', (t) => {
      t.dropColumn('ach_processing_notified_at');
    });
  }
};
