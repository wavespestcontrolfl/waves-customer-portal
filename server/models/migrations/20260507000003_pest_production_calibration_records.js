exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pest_production_calibration_records'))) {
    await knex.schema.createTable('pest_production_calibration_records', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id').notNullable().unique()
        .references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('estimate_id').references('id').inTable('estimates').onDelete('SET NULL');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('technician_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.date('service_date');
      t.string('service_type', 100);
      t.decimal('predicted_minutes', 8, 2).notNullable();
      t.decimal('actual_minutes', 8, 2).notNullable();
      t.decimal('delta_minutes', 8, 2).notNullable();
      t.string('pricing_confidence', 20);
      t.string('pool_cage_size', 20);
      t.integer('home_sqft');
      t.integer('lot_sqft');
      t.jsonb('review_reasons').notNullable().defaultTo('[]');
      t.jsonb('production_diagnostics').notNullable();
      t.jsonb('property_snapshot').notNullable().defaultTo('{}');
      t.jsonb('estimate_snapshot').notNullable().defaultTo('{}');
      t.string('source', 50).notNullable().defaultTo('estimate_time_entry');
      t.timestamps(true, true);

      t.index(['service_date', 'pricing_confidence'], 'idx_pest_prod_cal_date_conf');
      t.index(['pool_cage_size', 'service_date'], 'idx_pest_prod_cal_pool_date');
      t.index(['lot_sqft'], 'idx_pest_prod_cal_lot');
      t.index(['technician_id', 'service_date'], 'idx_pest_prod_cal_tech_date');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('pest_production_calibration_records');
};
