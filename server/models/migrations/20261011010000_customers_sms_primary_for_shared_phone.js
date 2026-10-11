/**
 * Shared-phone inbound text link (owner ruling 2026-10-10, "link text").
 *
 * Two or more customer rows can share one phone number (two intentional accounts for one
 * person, or duplicate rows). The inbound SMS handler cannot tell which account a text
 * belongs to, so it files the text as an unknown sender. With GATE_SMS_SHARED_PHONE_LINK on,
 * staff can mark ONE of the accounts as the one that receives texts from the shared number:
 *
 *   sms_primary_for_shared_phone  boolean NOT NULL DEFAULT false
 *
 * Additive, defaults false for every row, no backfill. With no mark the handler falls back to
 * the account texted most recently. The column changes nothing while the gate is off, and
 * nothing is sent to a customer.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('customers', 'sms_primary_for_shared_phone')) return;
  await knex.schema.alterTable('customers', (t) => {
    t.boolean('sms_primary_for_shared_phone').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('customers', 'sms_primary_for_shared_phone'))) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('sms_primary_for_shared_phone');
  });
};
