'use strict';

/**
 * visit_text_recipients.reminder_contact_id: ON DELETE CASCADE (was SET NULL, 20261127140000).
 *
 * A list copy goes with the list entry it was made from: the row, its claims and its tracker token are deleted, so no
 * reader (this code, or an older one that does not know copies) can honor it after the entry is gone. A later entry for
 * the same number gets fresh copies with new ids.
 */
const FK = 'visit_text_recipients_reminder_contact_id_fkey';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw(`ALTER TABLE visit_text_recipients DROP CONSTRAINT IF EXISTS ${FK}`);
  await knex.raw(`DELETE FROM visit_text_recipients WHERE source = 'customer_reminder_contact' AND reminder_contact_id IS NULL`);
  await knex.raw(`ALTER TABLE visit_text_recipients ADD CONSTRAINT ${FK}
    FOREIGN KEY (reminder_contact_id) REFERENCES customer_reminder_contacts(id) ON DELETE CASCADE`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw(`ALTER TABLE visit_text_recipients DROP CONSTRAINT IF EXISTS ${FK}`);
  await knex.raw(`ALTER TABLE visit_text_recipients ADD CONSTRAINT ${FK}
    FOREIGN KEY (reminder_contact_id) REFERENCES customer_reminder_contacts(id) ON DELETE SET NULL`);
};
