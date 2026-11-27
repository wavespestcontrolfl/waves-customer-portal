// Rollback guard for the sticky stop (owner 2026-11-27). A saved stop on customer_reminder_contacts is a person's (or
// staff's) choice: 20261128090000's down would drop it, so this down (which runs first) refuses while any stop is saved.
// It drops nothing itself. The table lock holds to the end of the rollback's transaction (knex runs a batch in one), so
// no stop can be saved between this check and the earlier file's drop.
exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  if (!(await knex.schema.hasColumn('customer_reminder_contacts', 'stopped_at'))) return;
  await knex.raw('LOCK TABLE customer_reminder_contacts IN SHARE ROW EXCLUSIVE MODE');
  if (await knex('customer_reminder_contacts').whereNotNull('stopped_at').first(knex.raw('1 AS x'))) {
    throw new Error('customer_reminder_contacts has saved stops; refusing a rollback that would drop them');
  }
};
