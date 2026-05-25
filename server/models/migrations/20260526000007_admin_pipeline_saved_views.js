exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('admin_pipeline_saved_views'))) {
    await knex.schema.createTable('admin_pipeline_saved_views', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable();
      t.string('name', 80).notNullable();
      t.jsonb('filters').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.index(['technician_id', 'sort_order'], 'admin_pipeline_saved_views_tech_sort_index');
      t.index(['technician_id', 'created_at'], 'admin_pipeline_saved_views_tech_created_index');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('admin_pipeline_saved_views');
};
