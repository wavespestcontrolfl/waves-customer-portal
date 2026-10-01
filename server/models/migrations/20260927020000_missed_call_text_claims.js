/**
 * Atomic per-phone claim table for the missed-call text-back
 * (services/missed-call-text-back.js) — same contract as voicemail_sms_claims
 * and dropped_call_sms_claims: one text per phone number EVER, enforced
 * DB-atomically (`phone` PRIMARY KEY + INSERT ... ON CONFLICT DO NOTHING) so
 * two attempts for the same number race to exactly one sender.
 *
 * The lane's own table (owner ruling 2026-09-27: the missed-call text and
 * the voicemail quote-link text stay separate lanes). The claim is taken
 * only at the provider boundary ('dispatching'), kept on consumed outcomes
 * ('sent', 'uncertain', 'blocked'), and deleted only when the provider
 * proves nothing was sent.
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('missed_call_text_claims')) return;
  await knex.schema.createTable('missed_call_text_claims', (t) => {
    t.string('phone', 20).primary();
    t.string('outcome', 30).notNullable();
    // The missed call whose attempt took the claim.
    t.uuid('call_log_id');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('missed_call_text_claims');
};
