/**
 * card_on_file_reminders: one row per decision of the "add a card" reminder email (services/card-on-file-reminder.js,
 * GATE_CARD_ON_FILE_REMINDER, owner 2026-11-24). Only a FINAL decision is written; a day the customer is not yet due,
 * or a send that did not go out, writes nothing and the next daily pass tries again inside the 7-day grace window.
 *   outcome       'shadow' = the gate is 'shadow': the customer WOULD have got the email and nothing was sent.
 *                 'sent'   = the gate is 'true' and the email went out (email_message_id names it).
 *   trigger_kind  'removed' (the customer's saved method was removed) or 'expired' (a card passed its expiry month).
 *   trigger_key   the event itself ('removed:<email_messages id>' / 'expired:<payment_methods id>'), so one event
 *                 is decided once per outcome even across re-runs and overlapping passes.
 *   trigger_on    the ET calendar day of the event; the email is due 3 days after it.
 * Unique on (customer_id, trigger_key, outcome): a shadow row never blocks the live send of the same event after the
 * owner flips shadow to true. The 30-day rule reads (customer_id, created_at).
 * Additive and idempotent. down() drops the table: it holds decisions only, no customer data the source tables lack.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('card_on_file_reminders')) return;
  await knex.schema.createTable('card_on_file_reminders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.text('trigger_kind').notNullable();
    table.text('trigger_key').notNullable();
    table.date('trigger_on').notNullable();
    table.text('outcome').notNullable();
    table.date('next_visit_date').nullable();
    table.uuid('email_message_id').nullable().references('id').inTable('email_messages').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['customer_id', 'trigger_key', 'outcome']);
    table.index(['customer_id', 'created_at']);
  });
  await knex.raw(`
    ALTER TABLE card_on_file_reminders
      ADD CONSTRAINT card_on_file_reminders_outcome_check CHECK (outcome IN ('shadow', 'sent')),
      ADD CONSTRAINT card_on_file_reminders_kind_check CHECK (trigger_kind IN ('removed', 'expired'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('card_on_file_reminders');
};
