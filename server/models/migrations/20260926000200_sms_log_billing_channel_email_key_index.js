// The billing Email obligation's enqueue looks up an existing owner by
// metadata->>'billing_channel_email_key' across customers (cross-customer
// collision refusal) while holding the customer-comms and obligation-key
// advisory locks — without an index that is a sequential scan of sms_log
// inside the lock. Partial expression index: only obligation rows carry the
// key, a small minority, so the build and the index stay tiny. Plain index
// (not CONCURRENTLY: migrations run inside a transaction pre-deploy, same
// reasoning as call_log_metadata_lead_id_index).
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('sms_log');
  if (!has) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS sms_log_billing_channel_email_key_index ON sms_log ((metadata->>'billing_channel_email_key')) WHERE metadata->>'billing_channel_email_key' IS NOT NULL",
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('sms_log');
  if (!has) return;
  await knex.raw('DROP INDEX IF EXISTS sms_log_billing_channel_email_key_index');
};
