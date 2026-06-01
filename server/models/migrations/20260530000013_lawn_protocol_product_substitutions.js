exports.up = async function up(knex) {
  await knex.schema.createTable('lawn_protocol_product_substitutions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
    table.uuid('original_product_id').notNullable().references('id').inTable('products_catalog').onDelete('RESTRICT');
    table.uuid('substitute_product_id').notNullable().references('id').inTable('products_catalog').onDelete('RESTRICT');
    table.decimal('rate_per_1000', 10, 4);
    table.string('rate_unit', 40);
    table.text('reason');
    table.uuid('approved_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.string('approved_by_name', 160);
    table.timestamp('approved_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.boolean('active').notNullable().defaultTo(true);
    table.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    table.timestamps(true, true);

    table.index(['scheduled_service_id']);
    table.index(['original_product_id']);
    table.index(['substitute_product_id']);
    table.unique(['scheduled_service_id', 'original_product_id'], {
      indexName: 'uniq_lawn_protocol_substitution_service_original',
    });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_protocol_product_substitutions');
};
