/**
 * collections_contact_ledger — one row per DELIVERED balance-related contact,
 * written additively by the dunning rails (late-payment-checker,
 * invoice-followups) and, later, by the voice lane. The contact policy's
 * frequency windows (24h any-channel / 7d voice / 7d live-conversation) read
 * from here, so every rail that reaches a customer about an open balance
 * must record its touch — observational, safe ungated.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('collections_contact_ledger')) return;
  await knex.schema.createTable('collections_contact_ledger', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    // sms | email | voice | manual_call
    t.string('channel', 20).notNullable();
    // late_payment | invoice_followup | balance_reminder | ...
    t.string('purpose', 40).notNullable();
    t.jsonb('invoice_ids').notNullable().defaultTo('[]');
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Which rail wrote the row ('late_payment_checker', 'invoice_followups', …).
    t.string('source', 60).notNullable();
    t.jsonb('metadata');

    t.index(['customer_id', 'occurred_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('collections_contact_ledger');
};
