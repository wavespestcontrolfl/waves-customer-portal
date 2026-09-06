// Future customer-rescheduled cadence visits await route placement within
// three days of this durable due date; optimization must not compound drift.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'recurring_dispatch_due_date'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.date('recurring_dispatch_due_date').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'recurring_dispatch_due_date')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('recurring_dispatch_due_date');
    });
  }
};
