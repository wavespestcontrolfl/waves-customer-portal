'use strict';

/**
 * call_email_spelling_retries becomes the single once-only claim for BOTH delivery paths of the resend to the other spelling
 * (owner 2026-11-05, GATE_CALL_BOUNCE_OTHER_SPELLING): the automation path (channel `automation`, the original migration) and
 * the tracked email_messages recovery (channel `email_message`, new here). UNIQUE(customer_id, bounced_email) is unchanged, so a
 * claim by either path blocks the other. On the tracked path origin_send_id holds the bounced email_messages id and
 * retry_send_id the recovery message id (both plain uuids, no foreign keys, like the automation path).
 *
 * The original migration is frozen (it ran on the preview database); this one only widens the channel CHECK.
 * `down` removes the tracked-path rows first (the narrow CHECK could not hold them), then restores the original CHECK.
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE call_email_spelling_retries DROP CONSTRAINT IF EXISTS call_email_spelling_retries_channel_check');
  await knex.raw(`ALTER TABLE call_email_spelling_retries
    ADD CONSTRAINT call_email_spelling_retries_channel_check CHECK (channel IN ('automation','email_message'))`);
};

exports.down = async function down(knex) {
  await knex.raw("DELETE FROM call_email_spelling_retries WHERE channel <> 'automation'");
  await knex.raw('ALTER TABLE call_email_spelling_retries DROP CONSTRAINT IF EXISTS call_email_spelling_retries_channel_check');
  await knex.raw(`ALTER TABLE call_email_spelling_retries
    ADD CONSTRAINT call_email_spelling_retries_channel_check CHECK (channel IN ('automation'))`);
};
