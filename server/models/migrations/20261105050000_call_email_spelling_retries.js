'use strict';

/**
 * call_email_spelling_retries: the one-time resend of a hard-bounced, call-captured email to the other spelling the
 * call settled (owner 2026-11-05, GATE_CALL_BOUNCE_OTHER_SPELLING). This is the ledger of the AUTOMATION path (the first
 * email a new lead gets, automation_step_sends); the email_messages path keeps its ledger in email_bounce_recoveries
 * (correction_rule `call_other_spelling`).
 *
 *   status  resending  the bounced step was re-queued to retry_email, nothing delivered yet
 *           committed  a send to retry_email delivered; the customer email was replaced
 *           failed     retry_email hard-bounced too (the office gets the existing bounced-contact alert)
 *           skipped    nothing was or could be re-sent / replaced (reason says why: sequence_cursor_moved,
 *                      owned_by_other, email_changed, customer_gone)
 *
 * UNIQUE (customer_id, bounced_email): an address is tried at most once per customer, whatever happens next.
 * Append-only log: customer_id, source_call_id and the send ids are plain uuids on purpose (no foreign keys), so a
 * customer merge or delete never has to move or collide with these rows, and the history of what was tried survives.
 * Audit trail of the commit: one audit_log row, `customer.email_replaced_after_bounce_retry`.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('call_email_spelling_retries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable();
    t.uuid('source_call_id');
    t.string('bounced_email').notNullable();
    t.string('retry_email').notNullable();
    t.string('channel', 24).notNullable().defaultTo('automation');
    t.uuid('origin_send_id');
    t.uuid('retry_send_id');
    t.string('status', 24).notNullable().defaultTo('resending');
    t.string('reason', 120);
    t.timestamp('committed_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['customer_id', 'bounced_email']);
    t.index(['retry_email']);
  });
  await knex.raw(`ALTER TABLE call_email_spelling_retries
    ADD CONSTRAINT call_email_spelling_retries_status_check CHECK (status IN ('resending','committed','failed','skipped')),
    ADD CONSTRAINT call_email_spelling_retries_channel_check CHECK (channel IN ('automation'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('call_email_spelling_retries');
};
