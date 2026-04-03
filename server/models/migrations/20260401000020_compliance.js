exports.up = async function (knex) {
  // Property application history
  await knex.schema.createTable('property_application_history', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('service_record_id').references('id').inTable('service_records');
    t.uuid('product_id').references('id').inTable('products_catalog');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.date('application_date').notNullable();
    t.decimal('quantity_applied', 8, 3);
    t.string('quantity_unit', 20);
    t.decimal('application_rate', 8, 4);
    t.string('rate_unit', 30);
    t.integer('area_treated_sqft');
    t.string('treatment_zone', 30);
    t.string('moa_group', 30);
    t.string('active_ingredient', 150);
    t.string('category', 30);
    t.text('notes');
    t.string('weather_conditions', 30);
    t.integer('wind_speed_mph');
    t.decimal('soil_temp_f', 5, 1);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['customer_id', 'application_date']);
    t.index(['customer_id', 'product_id']);
    t.index('moa_group');
  });

  // Product limits
  await knex.schema.createTable('product_limits', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('product_id').references('id').inTable('products_catalog');
    t.string('match_type', 30).defaultTo('product'); // product, moa_group, category, nitrogen
    t.string('match_value', 50); // the moa_group or category value to match
    t.enu('limit_type', ['annual_max_apps', 'annual_max_rate', 'seasonal_blackout', 'min_interval_days', 'moa_rotation_max', 'consecutive_use_max']).notNullable();
    t.decimal('limit_value', 10, 4);
    t.string('limit_unit', 30);
    t.date('season_start');
    t.date('season_end');
    t.string('jurisdiction', 30);
    t.enu('severity', ['hard_block', 'warning', 'info']).defaultTo('warning');
    t.text('description');
    t.timestamps(true, true);
  });

  // Inventory alerts
  await knex.schema.createTable('inventory_alerts', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.enu('alert_type', ['low_stock', 'product_limit_approaching', 'product_limit_reached', 'moa_rotation_due', 'price_change', 'expiration_warning']).notNullable();
    t.uuid('product_id').references('id').inTable('products_catalog');
    t.uuid('customer_id').references('id').inTable('customers');
    t.enu('severity', ['info', 'warning', 'critical']).defaultTo('warning');
    t.string('title', 200).notNullable();
    t.text('description');
    t.boolean('resolved').defaultTo(false);
    t.uuid('resolved_by').references('id').inTable('technicians');
    t.timestamp('resolved_at');
    t.jsonb('metadata');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('alert_type');
    t.index('resolved');
  });

  // Seed product limits
  const celsius = await knex('products_catalog').where('name', 'ilike', '%Celsius%').first();
  const dismissNxt = await knex('products_catalog').where('name', 'ilike', '%Dismiss%').first();
  const prodiamine = await knex('products_catalog').where('name', 'ilike', '%Prodiamine 65%').first();
  const headway = await knex('products_catalog').where('name', 'ilike', '%Headway%').first();
  const pillar = await knex('products_catalog').where('name', 'ilike', '%Pillar%').first();

  const limits = [];

  if (celsius) {
    limits.push(
      { product_id: celsius.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: 'Celsius WG: max 3 applications per year per property. Exceeding voids warranty and risks turf damage.' },
      { product_id: celsius.id, match_type: 'product', limit_type: 'min_interval_days', limit_value: 60, limit_unit: 'days', severity: 'warning', description: 'Celsius WG: minimum 60 days between applications. Shorter intervals increase phytotoxicity risk.' },
      { product_id: celsius.id, match_type: 'product', limit_type: 'annual_max_rate', limit_value: 0.171, limit_unit: 'oz/1000sf/year', severity: 'hard_block', description: 'Celsius WG maximum annual rate: 0.171 oz/1000sf/year total.' },
    );
  }
  if (dismissNxt) {
    limits.push({ product_id: dismissNxt.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: 'Dismiss NXT: max 2 applications per year. Use for sedge/kyllinga breakthrough only.' });
  }
  if (prodiamine) {
    limits.push({ product_id: prodiamine.id, match_type: 'product', limit_type: 'annual_max_rate', limit_value: 1.5, limit_unit: 'lb/acre/year', severity: 'hard_block', description: 'Prodiamine 65 WDG: max 1.5 lb ai/acre/year. Split applications recommended.' });
  }
  if (headway) {
    limits.push(
      { product_id: headway.id, match_type: 'product', limit_type: 'consecutive_use_max', limit_value: 2, limit_unit: 'applications', severity: 'warning', description: 'FRAC Group 11+3: max 2 consecutive before rotating to a different MOA. Resistance management.' },
      { product_id: headway.id, match_type: 'product', limit_type: 'min_interval_days', limit_value: 14, limit_unit: 'days', severity: 'warning', description: 'Headway G: minimum 14-day interval between applications.' },
    );
  }
  if (pillar) {
    limits.push({ product_id: pillar.id, match_type: 'product', limit_type: 'consecutive_use_max', limit_value: 2, limit_unit: 'applications', severity: 'warning', description: 'FRAC Group 11+3: same rotation as Headway. Do not use back-to-back.' });
  }

  // MOA Group rotation limits
  limits.push(
    { product_id: null, match_type: 'moa_group', match_value: 'Group 3A', limit_type: 'moa_rotation_max', limit_value: 3, limit_unit: 'applications', severity: 'warning', description: 'IRAC Group 3A (pyrethroids): max 3 consecutive. Rotate to Group 4A or 22A.' },
    { product_id: null, match_type: 'moa_group', match_value: 'Group 4A', limit_type: 'moa_rotation_max', limit_value: 3, limit_unit: 'applications', severity: 'warning', description: 'IRAC Group 4A (neonicotinoids): max 3 consecutive. Pollinator considerations.' },
  );

  // Nitrogen blackout — Sarasota & Manatee counties
  limits.push(
    { product_id: null, match_type: 'nitrogen', limit_type: 'seasonal_blackout', limit_value: 0, limit_unit: 'applications', season_start: '2026-06-01', season_end: '2026-09-30', jurisdiction: 'sarasota_county', severity: 'hard_block', description: 'Sarasota County nitrogen blackout: June 1 — September 30. Use iron + potassium only.' },
    { product_id: null, match_type: 'nitrogen', limit_type: 'seasonal_blackout', limit_value: 0, limit_unit: 'applications', season_start: '2026-06-01', season_end: '2026-09-30', jurisdiction: 'manatee_county', severity: 'hard_block', description: 'Manatee County nitrogen blackout: June 1 — September 30. Switch to 0-0-X + iron.' },
    { product_id: null, match_type: 'nitrogen', limit_type: 'annual_max_rate', limit_value: 4.0, limit_unit: 'lb_N/1000sf/year', jurisdiction: 'sarasota_county', severity: 'hard_block', description: 'Sarasota County: max 4 lb N/1000sf/year. 2 lb max per application, 50%+ slow-release.' },
    { product_id: null, match_type: 'nitrogen', limit_type: 'annual_max_rate', limit_value: 4.0, limit_unit: 'lb_N/1000sf/year', jurisdiction: 'manatee_county', severity: 'hard_block', description: 'Manatee County: max 4 lb N/1000sf/year. Same as Sarasota County.' },
  );

  if (limits.length) await knex('product_limits').insert(limits);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('inventory_alerts');
  await knex.schema.dropTableIfExists('product_limits');
  await knex.schema.dropTableIfExists('property_application_history');
};
