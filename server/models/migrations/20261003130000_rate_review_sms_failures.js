'use strict';

/**
 * Annual rate review — text failures that arrive before the send log (comms lane).
 *
 * Twilio's failed/undelivered status callback can beat the sender's own sms_log
 * insert: the callback's UPDATE then matches nothing and the failure would be
 * acknowledged and forgotten, while the sender goes on to log the text as sent.
 * The rate review lane records such an unmatched failure here, keyed by the
 * message sid (idempotent), so the delivery stamp and the nightly apply can still
 * see that the text never arrived. Additive; no existing table is touched.
 *
 * down() drops the table (it holds only these transient failure records).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('rate_review_sms_failures')) return;
  await knex.schema.createTable('rate_review_sms_failures', (t) => {
    t.string('twilio_sid', 50).primary();
    t.string('status', 30).notNullable();
    t.string('error_code', 20);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rate_review_sms_failures');
};
