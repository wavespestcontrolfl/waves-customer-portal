// The customer activity timeline (GET /api/admin/customers/:id/activity) reads
// a customer's mail by owner: email_messages WHERE recipient_type = 'customer'
// AND recipient_id = <customer id>. The table had indexes on template_key,
// provider_message_id, recipient_email_snapshot and (status, queued_at) but
// none on the owner pair, so that lookup was a sequential scan of the whole
// mail log per customer-screen open. Composite, type first (the timeline pins
// it to a literal; the same pair is read by the customer merge and by
// call-commitments / sms-commitment-fulfillment). Plain CREATE INDEX, not
// CONCURRENTLY: migrations run inside a transaction pre-deploy, and every
// other email_messages index in this repo (slot_recall, appointment_key,
// grouped_key, idempotency_prefix) is created the same way.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_messages'))) return;
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS email_messages_recipient_owner_idx ON email_messages (recipient_type, recipient_id)',
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_recipient_owner_idx');
};
