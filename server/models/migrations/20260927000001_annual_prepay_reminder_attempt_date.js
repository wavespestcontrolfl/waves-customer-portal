// Only an explicitly selected claim can stamp its promised date.
// NULL leaves legacy and never-attempted reminders outside resumption.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const days of [3, 1]) {
    const column = `payment_reminder_${days}d_attempted_for`;
    if (await knex.schema.hasColumn('annual_prepay_terms', column)) continue;
    await knex.schema.alterTable('annual_prepay_terms', (table) => {
      table.date(column).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const days of [3, 1]) {
    const column = `payment_reminder_${days}d_attempted_for`;
    if (!(await knex.schema.hasColumn('annual_prepay_terms', column))) continue;
    await knex.schema.alterTable('annual_prepay_terms', (table) => {
      table.dropColumn(column);
    });
  }
};
