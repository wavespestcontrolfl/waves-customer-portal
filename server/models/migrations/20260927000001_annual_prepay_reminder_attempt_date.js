// Only an explicitly selected 3-day claim can stamp this promised date.
// NULL leaves legacy and never-attempted reminders outside the 2-day resume.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))
    || await knex.schema.hasColumn('annual_prepay_terms', 'payment_reminder_3d_attempted_for')) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    table.date('payment_reminder_3d_attempted_for').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))
    || !(await knex.schema.hasColumn('annual_prepay_terms', 'payment_reminder_3d_attempted_for'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    table.dropColumn('payment_reminder_3d_attempted_for');
  });
};
