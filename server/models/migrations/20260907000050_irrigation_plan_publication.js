// App availability is independent of the email provider's sent_at outcome.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('irrigation_week_plans')) return;
  if (!await knex.schema.hasColumn('irrigation_week_plans', 'published_at')) {
    await knex.schema.alterTable('irrigation_week_plans', (table) => table.timestamp('published_at', { useTz: true }).nullable());
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('irrigation_week_plans')) return;
  if (await knex.schema.hasColumn('irrigation_week_plans', 'published_at')) {
    await knex.schema.alterTable('irrigation_week_plans', (table) => table.dropColumn('published_at'));
  }
};
