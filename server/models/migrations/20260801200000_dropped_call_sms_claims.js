/**
 * Atomic per-phone claim table for the dropped-call address-request text
 * (services/dropped-call-sms.js) — same contract as voicemail_sms_claims:
 * one text per phone number EVER, enforced DB-atomically (`phone` PRIMARY
 * KEY + INSERT ... ON CONFLICT DO NOTHING) so two concurrently-processed
 * dropped calls from the same number race to exactly one sender. Rows are
 * kept on consumed outcomes (sent / landline / policy-block) and deleted
 * only on outcomes that never consumed the one-shot (gate/template off,
 * quiet hours, unexpected error).
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('dropped_call_sms_claims')) return;
  await knex.schema.createTable('dropped_call_sms_claims', (t) => {
    t.string('phone', 20).primary();
    t.uuid('lead_id');
    t.string('outcome', 30);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('dropped_call_sms_claims');
};
