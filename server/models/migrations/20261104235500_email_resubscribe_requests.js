// email_resubscribe_requests: one row per "Turn Waves emails back on?" email
// (GATE_PORTAL_EMAIL_RESUBSCRIBE, owner 2026-11-04, gap #18). A customer who
// unsubscribed asks in the app; we email the holder's own address a link, and
// only a click from that mailbox releases the block.
//
//   email         the holder's address, trimmed and lower-cased
//   customer_id   who asked (null if the customer is later deleted)
//   token_hash    sha256 hex of the 32-byte link token; the token itself is
//                 only in the emailed link
//   requested_at  when the row was made; sent_at stays null if the send failed
//   expires_at    requested_at + 7 days
//   used_at       set when the link's button released the block
//   outcome       jsonb note: { send_failed: code } or the release result
//
// At most one email per address per 24 h is sent: the sender looks for a row
// with sent_at inside the last 24 h (lower(email), requested_at index).
// No data is written here; the table starts empty.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_resubscribe_requests')) return;
  await knex.schema.createTable('email_resubscribe_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('email').notNullable();
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.text('token_hash').notNullable().unique();
    t.timestamp('requested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.jsonb('outcome').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX email_resubscribe_requests_email_requested_idx ON email_resubscribe_requests (lower(email), requested_at)');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_resubscribe_requests');
};
