/**
 * Composite index for the SendGrid event-webhook lookup.
 *
 * Batched newsletter sends share a single SendGrid X-Message-Id across all
 * recipients in a personalizations request, so every delivery row in a chunk
 * carries the same `resend_message_id`. The webhook handler used to look up
 * deliveries by message id alone (`.first()`), which non-deterministically
 * picked one row per batch and silently dropped events for the rest. The
 * handler now filters by `(resend_message_id, email)` together — this index
 * makes that the lookup hot path.
 *
 * Drops the redundant single-column resend_message_id index — the leading
 * column of the composite covers it.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.index(['resend_message_id', 'email'], 'newsletter_deliveries_msgid_email_idx');
  });
  // Drop the now-redundant single-column index. Knex's t.dropIndex matches
  // by columns; the original was created via t.index(['resend_message_id'])
  // in 20260418000008.
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.dropIndex(['resend_message_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.index(['resend_message_id']);
  });
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.dropIndex(['resend_message_id', 'email'], 'newsletter_deliveries_msgid_email_idx');
  });
};
