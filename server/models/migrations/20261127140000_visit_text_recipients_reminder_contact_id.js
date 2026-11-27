'use strict';

/**
 * visit_text_recipients.reminder_contact_id: the exact customer_reminder_contacts entry a list copy was made from.
 *
 * A copy (source 'customer_reminder_contact') grants texts and its own tracker link only while THAT entry exists and
 * belongs to the visit's current customer. An entry id is never reused, so a later entry for the same number never
 * revives an old copy or its link: services/call-visit-recipient.js rebinds such a copy to the new entry and clears
 * its tracker token first. SET NULL: a deleted entry leaves its copies granting nothing. Rows a call recorded
 * directly keep NULL and do not need it.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw(`ALTER TABLE visit_text_recipients ADD COLUMN IF NOT EXISTS reminder_contact_id uuid
    REFERENCES customer_reminder_contacts(id) ON DELETE SET NULL`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw('ALTER TABLE visit_text_recipients DROP COLUMN IF EXISTS reminder_contact_id');
};
