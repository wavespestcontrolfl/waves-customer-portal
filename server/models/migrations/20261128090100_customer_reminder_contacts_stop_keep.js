// A saved stop on customer_reminder_contacts is a person's (or staff's) choice. A rollback runs this file's down
// before 20261128090000's down, so it refuses while any stop is saved: a re-run never restarts texts for a stopped person.
exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  if (!(await knex.schema.hasColumn('customer_reminder_contacts', 'stopped_at'))) return;
  const stopped = await knex('customer_reminder_contacts').whereNotNull('stopped_at').first('id');
  if (stopped) throw new Error('customer_reminder_contacts has saved stops; refusing a rollback that would drop them');
};
