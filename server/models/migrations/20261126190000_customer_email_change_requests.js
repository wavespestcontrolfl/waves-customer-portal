// customer_email_change_requests: one OPEN row per customer while a customer-typed new email address waits to be
// proven (GATE_CUSTOMER_PROFILE_EDIT, owner 2026-11-26). The app sends the new address; the server mails a 6-digit
// code to THAT address and writes nothing to customers.email until the customer types the code back
// (POST /api/customer/profile/confirm-email). An unproven address must never receive invoices, signing links or
// queued sends.
//
//   customer_id  who asked; the row goes with the customer (ON DELETE CASCADE)
//   new_email    the typed address, trimmed and lower-cased
//   from_email   the customer's stored email when the code was issued (lower-cased; null = none on file). A code is
//                good only while customers.email still equals it: staff or another path moving the address
//                in between makes the request stale (answered as expired and consumed)
//   code_hash    HMAC-SHA256 hex of "<id>:<code>" under the server secret; the code itself exists only in the email
//   attempts     wrong codes typed so far; the route refuses at 5 and the customer asks for a new code
//   expires_at   created or re-sent time + 15 minutes
//   consumed_at  set when the code was accepted, or the request was refused for good (address held by another account)
//   sent_at      set after the provider accepted the code email; null if the send failed
//
// At most ONE open request per customer (partial unique index): a new request replaces the open one. Consumed rows are
// kept only until that customer's next request, which clears them. No data is written here; the table starts empty.
// down() drops the table: nothing else references it.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_email_change_requests')) return;
  await knex.schema.createTable('customer_email_change_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.text('new_email').notNullable();
    t.text('from_email').nullable();
    t.text('code_hash').notNullable();
    t.smallint('attempts').notNullable().defaultTo(0);
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consumed_at', { useTz: true }).nullable();
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('ALTER TABLE customer_email_change_requests ADD CONSTRAINT customer_email_change_requests_attempts_chk CHECK (attempts >= 0)');
  await knex.raw('CREATE UNIQUE INDEX customer_email_change_requests_open_uidx ON customer_email_change_requests (customer_id) WHERE consumed_at IS NULL');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_email_change_requests');
};
