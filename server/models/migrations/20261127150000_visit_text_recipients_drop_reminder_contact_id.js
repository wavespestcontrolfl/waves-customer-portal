'use strict';

/**
 * Drops visit_text_recipients.reminder_contact_id (added by 20261127140000, never used in production).
 *
 * Design change (owner 2026-11-26 "simpler", advisors 2026-11-27): a copy of the customer's every-visit list is a plain
 * visit grant once written, so it needs no link to the list entry. A stop will be a stopped_at column on the list, read
 * at every send, never a delete.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw('ALTER TABLE visit_text_recipients DROP COLUMN IF EXISTS reminder_contact_id');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw(`ALTER TABLE visit_text_recipients ADD COLUMN IF NOT EXISTS reminder_contact_id uuid
    REFERENCES customer_reminder_contacts(id) ON DELETE SET NULL`);
};
