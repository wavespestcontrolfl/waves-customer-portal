exports.up = async function up(knex) {
  if (await knex.schema.hasTable('schedule_quality_refresh_jobs')) return;
  await knex.schema.createTable('schedule_quality_refresh_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.jsonb('payload').notNullable();
    table.timestamp('available_at', { useTz: true }).notNullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.uuid('attempt_token').notNullable();
    table.text('last_error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['available_at', 'created_at'], 'schedule_quality_refresh_jobs_due_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('schedule_quality_refresh_jobs'))) return;
  await knex.schema.dropTable('schedule_quality_refresh_jobs');
};
