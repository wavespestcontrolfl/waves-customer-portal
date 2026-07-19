exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('treatment_zone_maps'))) {
    await knex.schema.createTable('treatment_zone_maps', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table
        .uuid('scheduled_service_id')
        .notNullable()
        .unique()
        .references('id')
        .inTable('scheduled_services')
        .onDelete('CASCADE');
      table.uuid('customer_id').nullable();
      table.jsonb('path_points').notNullable();
      table.boolean('closed_loop').notNullable().defaultTo(false);
      table.integer('linear_ft').nullable();
      table.double('center_lat').nullable();
      table.double('center_lng').nullable();
      table.integer('zoom').nullable();
      table.string('address', 300).nullable();
      table.string('snapshot_s3_key', 300).nullable();
      table.uuid('created_by_technician_id').nullable();
      table.timestamps(true, true);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('treatment_zone_maps');
};
