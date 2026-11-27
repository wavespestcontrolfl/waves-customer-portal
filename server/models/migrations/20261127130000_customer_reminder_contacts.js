'use strict';

/**
 * customer_reminder_contacts: a person a caller named for the appointment texts, kept on the CUSTOMER so they get
 * those texts for every visit (owner 2026-11-24 PM, "auto add them"; owner 2026-11-26 "simpler").
 *
 * This list only says WHO. Before a visit's text goes out, services/call-visit-recipient.js copies each active person
 * onto that visit as a visit_text_recipients row (ON CONFLICT DO NOTHING), and every existing send, claim, recheck,
 * replay and tracker rule then applies to that row unchanged.
 *
 * A stop is sticky: `stopped_at` set means the person gets nothing for this customer, on any visit, including rows
 * already copied. A call never clears it (a call insert is ON CONFLICT DO NOTHING); only staff or the customer's
 * portal will. No other table reads this one: no login, no review ask, no bill, no consent stamp.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_reminder_contacts')) return;

  await knex.schema.createTable('customer_reminder_contacts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    // Last 10 digits: the same key visit_text_recipients uses.
    t.string('phone_key', 10).notNullable();
    t.string('phone_e164', 20).notNullable();
    t.string('first_name', 100);
    t.string('last_name', 100);
    t.string('role', 30);
    t.string('source', 40).notNullable().defaultTo('call_caller_provided');
    t.string('consent_version', 60).notNullable();
    // The call the person was named on. Audit only.
    t.uuid('call_log_id').references('id').inTable('call_log').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('stopped_at', { useTz: true });
    t.string('stop_source', 40);

    t.unique(['customer_id', 'phone_key'], 'uq_customer_reminder_contacts_customer_phone');
  });
};

// A recorded stop is the only record that a person asked not to be texted: never drop it. Rolling back with any stop on file
// refuses; turn GATE_CALL_GIVEN_VISIT_TEXTS off first and carry the stops forward by hand.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  const stop = await knex('customer_reminder_contacts').whereNotNull('stopped_at').first('id');
  if (stop) throw new Error('customer_reminder_contacts holds recorded stops; refusing to drop them (turn GATE_CALL_GIVEN_VISIT_TEXTS off and keep the stops first)');
  await knex.schema.dropTable('customer_reminder_contacts');
};
