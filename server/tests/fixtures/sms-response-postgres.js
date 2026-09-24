// Minimal synthetic SMS schema shared by private PostgreSQL regression suites.
// Call inside the suite transaction; all objects are rolled back at teardown.
async function createSmsResponseTables(trx) {
  await trx.raw(`
      CREATE TABLE customers (id uuid PRIMARY KEY, phone varchar(32));
      CREATE TABLE conversations (id uuid PRIMARY KEY, customer_id uuid, channel varchar(20), contact_phone varchar(32), our_endpoint_id varchar(100));
      CREATE TABLE messages (
        id uuid PRIMARY KEY, conversation_id uuid NOT NULL, channel varchar(20), direction varchar(12),
        body text, media jsonb DEFAULT '[]', metadata jsonb DEFAULT '{}', message_type varchar(30),
        delivery_status varchar(20), twilio_sid varchar(64), is_read boolean, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE sms_log (
        id uuid PRIMARY KEY, customer_id uuid, direction varchar(12), from_phone varchar(32), to_phone varchar(32),
        message_body text, metadata jsonb, message_type varchar(30), status varchar(20), twilio_sid varchar(64), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE blocked_numbers (id uuid PRIMARY KEY, number varchar(32));
      CREATE TABLE message_drafts (id uuid PRIMARY KEY, sms_log_id uuid, customer_id uuid, flags jsonb, intent text, sent_at timestamptz);
      CREATE TABLE messaging_audit_log (
        id uuid PRIMARY KEY, provider_message_id varchar(64), channel varchar(16), metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE inbound_sms_optout_receipts (
        message_sid text PRIMARY KEY, phone text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX messaging_audit_provider_message_id_idx ON messaging_audit_log (provider_message_id)
        WHERE provider_message_id IS NOT NULL;
  `);
}

module.exports = { createSmsResponseTables };
