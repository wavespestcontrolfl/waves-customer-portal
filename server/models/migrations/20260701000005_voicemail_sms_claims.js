/**
 * Atomic per-phone claim table for the voicemail lead text-back
 * (services/voicemail-lead-sms.js).
 *
 * The one-text-per-phone-EVER contract needs a DB-atomic claim: a plain
 * SELECT-then-send lets two concurrently-processed voicemails from the same
 * phone (two calls, two lead rows) both see "no prior text" and double-send.
 * `phone` is the PRIMARY KEY, so `INSERT ... ON CONFLICT DO NOTHING` makes
 * exactly one processor the sender; the loser skips. Rows are kept forever on
 * consumed outcomes (sent / scheduled / landline / policy-block) and deleted
 * only on outcomes that never consumed the one-shot before (template
 * disabled, missing token secret, re-queue failure).
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('voicemail_sms_claims')) return;
  await knex.schema.createTable('voicemail_sms_claims', (t) => {
    t.string('phone', 20).primary();
    t.uuid('lead_id');
    t.string('outcome', 30);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('voicemail_sms_claims');
};
