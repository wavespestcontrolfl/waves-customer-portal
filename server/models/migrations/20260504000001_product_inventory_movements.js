exports.up = async function (knex) {
  const productCols = await knex('products_catalog').columnInfo().catch(() => ({}));
  if (Object.keys(productCols).length) {
    await knex.schema.alterTable('products_catalog', (t) => {
      if (!productCols.inventory_on_hand) t.decimal('inventory_on_hand', 12, 4);
      if (!productCols.inventory_unit) t.string('inventory_unit', 20);
      if (!productCols.low_stock_threshold) t.decimal('low_stock_threshold', 12, 4);
    });
  }

  if (!(await knex.schema.hasTable('product_inventory_movements'))) {
    await knex.schema.createTable('product_inventory_movements', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
      t.uuid('service_product_id').references('id').inTable('service_products').onDelete('SET NULL');
      t.uuid('scheduled_service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('technician_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.string('movement_type', 30).notNullable().defaultTo('usage');
      t.decimal('quantity', 12, 4).notNullable();
      t.string('unit', 20).notNullable();
      t.decimal('unit_cost', 12, 4);
      t.decimal('cost_used', 12, 4);
      t.decimal('stock_before', 12, 4);
      t.decimal('stock_after', 12, 4);
      t.string('lot_number', 80);
      t.jsonb('metadata');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['product_id', 'created_at']);
      t.index('service_record_id');
      t.index('scheduled_service_id');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('product_inventory_movements');
  const productCols = await knex('products_catalog').columnInfo().catch(() => ({}));
  if (Object.keys(productCols).length) {
    await knex.schema.alterTable('products_catalog', (t) => {
      if (productCols.low_stock_threshold) t.dropColumn('low_stock_threshold');
      if (productCols.inventory_unit) t.dropColumn('inventory_unit');
      if (productCols.inventory_on_hand) t.dropColumn('inventory_on_hand');
    });
  }
};
