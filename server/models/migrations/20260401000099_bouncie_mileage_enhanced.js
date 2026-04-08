/**
 * Migration 099 — Bouncie Mileage Enhanced
 *
 * 1. ALTER mileage_log — add GPS coords, driving behavior, classification fields
 * 2. CREATE mileage_daily_summary — per-vehicle per-day aggregates
 * 3. CREATE mileage_monthly_summary — per-vehicle per-month aggregates + driving score
 * 4. CREATE bouncie_webhook_log — raw webhook event storage
 * 5. CREATE geo_fences — business/personal/supplier geofence zones
 */

exports.up = async function (knex) {

  // ── 1. Extend mileage_log ──────────────────────────────────────
  const addIfMissing = async (col, fn) => {
    const has = await knex.schema.hasColumn('mileage_log', col);
    if (!has) return fn;
    return null;
  };

  await knex.schema.alterTable('mileage_log', (t) => {
    // We wrap each column add in hasColumn checks below
  });

  // Doing individual alter calls with hasColumn checks for re-run safety
  const cols = [
    ['equipment_id',          t => t.uuid('equipment_id').nullable().references('id').inTable('equipment').onDelete('SET NULL')],
    ['customer_id',           t => t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL')],
    ['job_id',                t => t.uuid('job_id').nullable()],
    ['technician_id',         t => t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL')],
    ['start_lat',             t => t.decimal('start_lat', 10, 7).nullable()],
    ['start_lng',             t => t.decimal('start_lng', 10, 7).nullable()],
    ['end_lat',               t => t.decimal('end_lat', 10, 7).nullable()],
    ['end_lng',               t => t.decimal('end_lng', 10, 7).nullable()],
    ['start_odometer',        t => t.integer('start_odometer').nullable()],
    ['end_odometer',          t => t.integer('end_odometer').nullable()],
    ['max_speed_mph',         t => t.integer('max_speed_mph').nullable()],
    ['avg_speed_mph',         t => t.integer('avg_speed_mph').nullable()],
    ['hard_brakes',           t => t.integer('hard_brakes').defaultTo(0)],
    ['hard_accels',           t => t.integer('hard_accels').defaultTo(0)],
    ['idle_minutes',          t => t.integer('idle_minutes').defaultTo(0)],
    ['fuel_consumed_gal',     t => t.decimal('fuel_consumed_gal', 6, 3).nullable()],
    ['fuel_economy_mpg',      t => t.decimal('fuel_economy_mpg', 6, 1).nullable()],
    ['is_business',           t => t.boolean('is_business').defaultTo(true)],
    ['classification_method', t => t.string('classification_method', 20).defaultTo('auto')],
    ['classification_notes',  t => t.text('classification_notes').nullable()],
    ['route_date',            t => t.date('route_date').nullable()],
    ['trip_sequence',         t => t.integer('trip_sequence').nullable()],
  ];

  for (const [colName, addFn] of cols) {
    const has = await knex.schema.hasColumn('mileage_log', colName);
    if (!has) {
      await knex.schema.alterTable('mileage_log', addFn);
    }
  }

  // Indexes for mileage_log new columns
  try {
    await knex.schema.alterTable('mileage_log', (t) => {
      t.index('equipment_id', 'idx_mileage_log_equipment_id');
      t.index('customer_id', 'idx_mileage_log_customer_id');
      t.index('is_business', 'idx_mileage_log_is_business');
      t.index('route_date', 'idx_mileage_log_route_date');
    });
  } catch (_) {
    // indexes may already exist on re-run
  }

  // ── 2. mileage_daily_summary ───────────────────────────────────
  if (!(await knex.schema.hasTable('mileage_daily_summary'))) {
    await knex.schema.createTable('mileage_daily_summary', (t) => {
      t.increments('id').primary();
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.date('summary_date').notNullable();
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.decimal('total_miles', 8, 2).defaultTo(0);
      t.decimal('business_miles', 8, 2).defaultTo(0);
      t.decimal('personal_miles', 8, 2).defaultTo(0);
      t.decimal('business_pct', 5, 2).defaultTo(100);
      t.integer('trip_count').defaultTo(0);
      t.integer('total_drive_minutes').defaultTo(0);
      t.integer('total_idle_minutes').defaultTo(0);
      t.integer('customer_stops').defaultTo(0);
      t.decimal('fuel_consumed_gal', 6, 3).nullable();
      t.decimal('avg_mpg', 6, 1).nullable();
      t.integer('hard_brakes').defaultTo(0);
      t.integer('hard_accels').defaultTo(0);
      t.integer('max_speed_mph').nullable();
      t.integer('odometer_start').nullable();
      t.integer('odometer_end').nullable();
      t.decimal('irs_rate', 6, 4).defaultTo(0.70);
      t.decimal('irs_deduction', 8, 2).defaultTo(0);
      t.integer('jobs_completed').defaultTo(0);
      t.decimal('revenue_generated', 10, 2).defaultTo(0);
      t.timestamps(true, true);

      t.unique(['equipment_id', 'summary_date']);
      t.index('summary_date');
      t.index('technician_id');
    });
  }

  // ── 3. mileage_monthly_summary ─────────────────────────────────
  if (!(await knex.schema.hasTable('mileage_monthly_summary'))) {
    await knex.schema.createTable('mileage_monthly_summary', (t) => {
      t.increments('id').primary();
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.date('summary_month').notNullable();
      t.decimal('total_miles', 10, 2).defaultTo(0);
      t.decimal('business_miles', 10, 2).defaultTo(0);
      t.decimal('personal_miles', 10, 2).defaultTo(0);
      t.decimal('business_pct', 5, 2).defaultTo(100);
      t.integer('trip_count').defaultTo(0);
      t.integer('drive_days').defaultTo(0);
      t.decimal('avg_daily_miles', 8, 2).defaultTo(0);
      t.decimal('fuel_consumed_gal', 8, 3).nullable();
      t.decimal('fuel_cost_estimated', 8, 2).nullable();
      t.decimal('avg_mpg', 6, 1).nullable();
      t.decimal('irs_rate', 6, 4).defaultTo(0.70);
      t.decimal('irs_deduction', 10, 2).defaultTo(0);
      t.integer('hard_brakes_total').defaultTo(0);
      t.integer('hard_accels_total').defaultTo(0);
      t.integer('driving_score').defaultTo(100); // 0-100
      t.timestamps(true, true);

      t.unique(['equipment_id', 'summary_month']);
      t.index('summary_month');
    });
  }

  // ── 4. bouncie_webhook_log ─────────────────────────────────────
  if (!(await knex.schema.hasTable('bouncie_webhook_log'))) {
    await knex.schema.createTable('bouncie_webhook_log', (t) => {
      t.increments('id').primary();
      t.string('event_type', 50);
      t.string('vehicle_imei', 30);
      t.jsonb('payload');
      t.boolean('processed').defaultTo(false);
      t.text('error');
      t.timestamp('received_at').defaultTo(knex.fn.now());

      t.index('event_type', 'idx_webhook_event_type');
      t.index('received_at', 'idx_webhook_received_at');
      t.index('processed', 'idx_webhook_processed');
    });
  }

  // ── 5. geo_fences ──────────────────────────────────────────────
  if (!(await knex.schema.hasTable('geo_fences'))) {
    await knex.schema.createTable('geo_fences', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 200).notNullable();
      t.string('fence_type', 20).notNullable(); // business, personal, supplier, customer_zone
      t.decimal('lat', 10, 7).notNullable();
      t.decimal('lng', 10, 7).notNullable();
      t.integer('radius_meters').defaultTo(200);
      t.boolean('is_active').defaultTo(true);
      t.text('notes');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });

    // Seed default geo-fences
    await knex('geo_fences').insert([
      {
        name: 'Waves HQ',
        fence_type: 'business',
        lat: 27.4900000,
        lng: -82.5740000,
        radius_meters: 200,
        is_active: true,
        notes: 'Waves Pest Control home office / dispatch base',
      },
      {
        name: 'SiteOne #238',
        fence_type: 'supplier',
        lat: 27.4180000,
        lng: -82.4070000,
        radius_meters: 300,
        is_active: true,
        notes: 'SiteOne Landscape Supply — Sarasota',
      },
    ]);
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('geo_fences');
  await knex.schema.dropTableIfExists('bouncie_webhook_log');
  await knex.schema.dropTableIfExists('mileage_monthly_summary');
  await knex.schema.dropTableIfExists('mileage_daily_summary');

  // Remove added columns from mileage_log
  const colsToDrop = [
    'equipment_id', 'customer_id', 'job_id', 'technician_id',
    'start_lat', 'start_lng', 'end_lat', 'end_lng',
    'start_odometer', 'end_odometer', 'max_speed_mph', 'avg_speed_mph',
    'hard_brakes', 'hard_accels', 'idle_minutes',
    'fuel_consumed_gal', 'fuel_economy_mpg',
    'is_business', 'classification_method', 'classification_notes',
    'route_date', 'trip_sequence',
  ];

  for (const col of colsToDrop) {
    const has = await knex.schema.hasColumn('mileage_log', col);
    if (has) {
      await knex.schema.alterTable('mileage_log', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
