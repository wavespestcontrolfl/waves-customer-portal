'use strict';

/**
 * visit_text_recipients: a phone number a caller gave on a call for ONE booked
 * visit, who may be texted about that visit only (owner 2026-11-24, "yes, visit
 * only", narrowing the 2026-10-29 caller-given-contact ruling).
 *
 * Phyllis calls, books a visit and says "text my husband Bob too, here is his
 * number". Bob gets that one visit's booking confirmation, its reminders and its
 * en-route text. Nothing else: not another visit, no portal login, no review ask,
 * no email, and no account-level consent. So the permission lives on a row keyed
 * to the VISIT, never on the customer: customers.service_contacts_consent_at,
 * the service-contact slots, recipient_optin and contact login are not touched.
 *
 * A table, not a column on scheduled_services: a visit row is copied into other
 * visits (follow-up children, series), and a column would carry the permission
 * along. A child row here stays with the one visit and goes with it
 * (ON DELETE CASCADE). The unique key makes a retry of the call processing a
 * no-op, so the record is neither duplicated nor lost.
 *
 * `deliveries` is { "<kind>:<ymd>T<hhmm>": "<iso time>" }: one claim per text
 * kind per visit slot (confirmation, reminder_72h, reminder_24h, en_route). A
 * sender claims the key before it texts and releases it when the text was not
 * accepted, so two senders never text Bob the same message twice, and a visit
 * moved to a new slot gets its own claim.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('visit_text_recipients')) return;

  await knex.schema.createTable('visit_text_recipients', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    // Last 10 digits: the dedupe key against the account holder's number.
    t.string('phone_key', 10).notNullable();
    t.string('phone_e164', 20).notNullable();
    t.string('first_name', 100);
    t.string('last_name', 100);
    t.string('role', 30);
    // Where the permission came from, and the ruling it follows.
    t.string('source', 40).notNullable().defaultTo('call_caller_provided');
    t.string('consent_version', 60).notNullable();
    // The call the number was given on. Audit only: the call row may go.
    t.uuid('call_log_id').references('id').inTable('call_log').onDelete('SET NULL');
    t.jsonb('deliveries').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['scheduled_service_id', 'phone_key'], 'uq_visit_text_recipients_visit_phone');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_text_recipients');
};
