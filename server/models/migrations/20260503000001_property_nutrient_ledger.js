// Durable property-level N/P/K ledger for WaveGuard compliance.
//
// service_products remains the raw completion artifact. This table is the
// audited nutrient math used by the protocol engine: one row per applied
// nutrient product, normalized to lb nutrient / 1,000 sq ft for the property.

exports.up = async function (knex) {
  if (await knex.schema.hasTable('property_nutrient_ledger')) return;

  await knex.schema.createTable('property_nutrient_ledger', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE')
      .onUpdate('CASCADE');
    t.uuid('turf_profile_id')
      .nullable()
      .references('id')
      .inTable('customer_turf_profiles')
      .onDelete('SET NULL')
      .onUpdate('CASCADE');
    t.uuid('service_record_id')
      .nullable()
      .references('id')
      .inTable('service_records')
      .onDelete('SET NULL')
      .onUpdate('CASCADE');
    t.uuid('service_product_id')
      .nullable()
      .references('id')
      .inTable('service_products')
      .onDelete('SET NULL')
      .onUpdate('CASCADE');
    t.uuid('product_id')
      .nullable()
      .references('id')
      .inTable('products_catalog')
      .onDelete('SET NULL')
      .onUpdate('CASCADE');

    t.date('application_date').notNullable();
    t.integer('application_year').notNullable();
    t.string('product_name', 180).notNullable();
    t.string('analysis', 20).nullable();
    t.decimal('rate', 10, 4).nullable();
    t.string('rate_unit', 30).nullable();
    t.decimal('amount_used', 10, 4).nullable();
    t.string('amount_unit', 30).nullable();
    t.integer('lawn_sqft').nullable();

    t.decimal('n_applied_per_1000', 8, 4).notNullable().defaultTo(0);
    t.decimal('p_applied_per_1000', 8, 4).notNullable().defaultTo(0);
    t.decimal('k_applied_per_1000', 8, 4).notNullable().defaultTo(0);
    t.decimal('slow_release_n_pct', 5, 2).nullable();

    t.string('municipality', 80).nullable();
    t.string('county', 60).nullable();
    t.string('blackout_status', 40).nullable();
    t.string('source', 80).notNullable().defaultTo('service_completion');
    t.jsonb('metadata').nullable();
    t.timestamps(true, true);

    t.index(['customer_id', 'application_year'], 'idx_pnl_customer_year');
    t.index(['service_record_id'], 'idx_pnl_service_record');
    t.index(['application_date'], 'idx_pnl_application_date');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('property_nutrient_ledger');
};
