'use strict';

/**
 * customer_reminder_contacts.stopped_at / stopped_by: the sticky stop for a person a caller named for the visit texts
 * (owner 2026-11-26 "simpler", 2026-11-27 "yes").
 *
 * A stop is a mark on the list row, never a delete: services/call-visit-recipient.js declinedByRecipient reads it at
 * every send and on the person's map link, so every visit row of that number on that customer (a list copy or a
 * call's "just this visit" grant) stops at once, and their delivery claims stay (nothing is sent twice after a restore).
 * A later call never clears it (the list insert is ON CONFLICT DO NOTHING). Only the account holder in the app or staff
 * clear it. stopped_by: 'customer' | 'staff'.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS stopped_at timestamptz');
  await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS stopped_by varchar(20)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  await knex.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS stopped_by');
  await knex.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS stopped_at');
};
