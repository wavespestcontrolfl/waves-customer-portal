exports.up = async function up(knex) {
  await knex.schema.createTable('product_restock_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    table.uuid('scheduled_service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');
    table.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    table.string('status', 24).notNullable().defaultTo('open');
    table.string('priority', 24).notNullable().defaultTo('normal');
    table.decimal('requested_quantity', 12, 4);
    table.string('unit', 40);
    table.decimal('current_stock', 12, 4);
    table.decimal('target_stock', 12, 4);
    table.string('vendor', 160);
    table.date('needed_by');
    table.text('reason');
    table.string('source', 80).notNullable().defaultTo('manual');
    table.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.string('created_by_name', 160);
    table.uuid('closed_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.timestamp('closed_at', { useTz: true });
    table.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    table.timestamps(true, true);

    table.index(['status']);
    table.index(['product_id', 'status']);
    table.index(['scheduled_service_id']);
  });

  await knex.raw(`
    ALTER TABLE product_restock_requests
      ADD CONSTRAINT product_restock_requests_status_check
      CHECK (status IN ('open', 'ordered', 'received', 'cancelled'))
  `);
  await knex.raw(`
    ALTER TABLE product_restock_requests
      ADD CONSTRAINT product_restock_requests_priority_check
      CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('product_restock_requests');
};
