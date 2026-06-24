/**
 * Lawn Report V2 — area water calibration (Phase 2).
 *
 * Lets the water-balance read "your AREA received X" instead of guessing per
 * property. Three tables + one customers FK:
 *
 *  - `lawn_water_areas`        — named SWFL service areas (polygon or center) with
 *                                rain/demand calibration factors.
 *  - customers.lawn_water_area_id — each customer's assigned area (by lat/lng, with
 *                                admin override).
 *  - `lawn_area_weather_daily` — daily rainfall per area (radar/station), the source
 *                                the report sums over the service week.
 *  - `lawn_water_intake_snapshots` — per-service computed water picture (rain +
 *                                irrigation vs grass×season target → status +
 *                                interpretation + confidence), stored so a permanent
 *                                report token never recomputes historical weather.
 *
 * Schema only; behaviour is gated behind LAWN_REPORT_V2 / the area sync job.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_water_areas'))) {
    await knex.schema.createTable('lawn_water_areas', (t) => {
      t.bigIncrements('id').primary();
      t.string('name').notNullable();
      t.string('slug').notNullable().unique();
      t.string('area_type', 20).notNullable().defaultTo('unknown'); // coastal|inland|urban|unknown
      t.jsonb('polygon_geojson'); // GeoJSON Polygon (outer ring used for point-in-polygon)
      t.decimal('center_lat', 10, 7);
      t.decimal('center_lng', 10, 7);
      t.string('weather_provider', 20).defaultTo('unknown'); // radar|station|manual|unknown
      t.string('weather_provider_key');
      // Multiply observed rain / seasonal demand to calibrate a coarse source to the area.
      t.decimal('rain_adjustment_factor', 6, 3).notNullable().defaultTo(1.0);
      t.decimal('water_demand_factor', 6, 3).notNullable().defaultTo(1.0);
      t.string('confidence', 10).notNullable().defaultTo('medium'); // high|medium|low
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasColumn('customers', 'lawn_water_area_id'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.bigInteger('lawn_water_area_id').references('id').inTable('lawn_water_areas').onDelete('SET NULL');
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_customers_lawn_water_area ON customers(lawn_water_area_id)');
  }

  if (!(await knex.schema.hasTable('lawn_area_weather_daily'))) {
    await knex.schema.createTable('lawn_area_weather_daily', (t) => {
      t.bigIncrements('id').primary();
      t.bigInteger('area_id').notNullable().references('id').inTable('lawn_water_areas').onDelete('CASCADE');
      t.date('date').notNullable();
      t.decimal('rain_inches', 6, 2).notNullable().defaultTo(0);
      t.string('source', 20).notNullable().defaultTo('manual'); // radar|weather_station|manual
      t.string('source_detail');
      t.string('confidence', 10).notNullable().defaultTo('medium');
      t.timestamps(true, true);
      t.unique(['area_id', 'date']);
    });
  }

  if (!(await knex.schema.hasTable('lawn_water_intake_snapshots'))) {
    await knex.schema.createTable('lawn_water_intake_snapshots', (t) => {
      t.bigIncrements('id').primary();
      // One snapshot per service record (the report's stable water picture).
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('CASCADE');
      t.uuid('service_id');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.bigInteger('area_id').references('id').inTable('lawn_water_areas').onDelete('SET NULL');
      t.date('service_date');
      t.decimal('irrigation_inches_per_week', 6, 2);
      t.decimal('rain_today_inches', 6, 2);
      t.decimal('rain_7day_inches', 6, 2);
      t.decimal('rain_14day_inches', 6, 2);
      t.decimal('adjusted_rain_7day_inches', 6, 2);
      t.decimal('total_water_7day_inches', 6, 2);
      t.decimal('target_water_inches_per_week', 6, 2);
      t.decimal('water_gap_inches', 6, 2);
      t.string('status', 12); // low|balanced|high|unknown
      t.string('interpretation', 32); // water_deficit_likely|water_balance_ok|wet_condition_watch|coverage_issue_possible|rain_unknown|irrigation_unknown
      t.string('confidence', 10); // high|medium|low
      t.timestamps(true, true);
      t.unique(['service_record_id']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_water_intake_snapshots');
  await knex.schema.dropTableIfExists('lawn_area_weather_daily');
  if (await knex.schema.hasColumn('customers', 'lawn_water_area_id')) {
    await knex.schema.alterTable('customers', (t) => { t.dropColumn('lawn_water_area_id'); });
  }
  await knex.schema.dropTableIfExists('lawn_water_areas');
};
