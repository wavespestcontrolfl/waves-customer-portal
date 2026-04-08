/**
 * Migration 097 — Equipment Maintenance & Fleet Tracking
 *
 * Extends existing equipment table with fleet fields (asset_tag, VIN, mileage, etc.)
 * Adds: maintenance_schedules, maintenance_records, equipment_downtime_log,
 *        vehicle_mileage_log, maintenance_alerts
 */

exports.up = async function (knex) {
  // ── Extend existing equipment table ────────────────────────────
  const hasAssetTag = await knex.schema.hasColumn('equipment', 'asset_tag');
  if (!hasAssetTag) {
    await knex.schema.alterTable('equipment', (t) => {
      t.string('asset_tag', 50).unique().after('name');
      t.string('subcategory', 50).after('category');
      t.integer('year').after('serial_number');
      t.string('vin', 20).after('year');
      t.string('license_plate', 20).after('vin');
      t.string('purchase_vendor', 200).after('purchase_price');
      t.date('warranty_expiration').after('purchase_vendor');
      t.text('warranty_details').after('warranty_expiration');
      t.uuid('tax_equipment_id').nullable().after('warranty_details');
      t.integer('useful_life_years').after('depreciation_method');
      t.decimal('salvage_value', 10, 2).after('useful_life_years');
      t.integer('condition_rating').defaultTo(8).after('status');
      t.string('location', 100).defaultTo('van').after('condition_rating');
      t.uuid('assigned_vehicle_id').nullable().references('id').inTable('equipment').onDelete('SET NULL').after('assigned_to');
      t.string('engine_type', 100).after('assigned_vehicle_id');
      t.string('fuel_type', 30).after('engine_type');
      t.integer('current_miles').defaultTo(0).after('current_hours');
      t.string('photo_url', 500).after('current_miles');
    });
  }

  // ── Maintenance Schedules ──────────────────────────────────────
  if (!(await knex.schema.hasTable('maintenance_schedules'))) {
    await knex.schema.createTable('maintenance_schedules', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.string('task_name', 200).notNullable();
      t.text('description');
      t.integer('interval_miles');
      t.integer('interval_hours');
      t.integer('interval_days');
      t.integer('interval_months');
      t.timestamp('last_performed_at');
      t.integer('last_performed_miles');
      t.decimal('last_performed_hours', 10, 1);
      t.string('last_performed_by', 200);
      t.date('next_due_at');
      t.integer('next_due_miles');
      t.decimal('next_due_hours', 10, 1);
      t.boolean('is_overdue').defaultTo(false);
      t.string('priority', 20).defaultTo('normal');
      t.integer('notify_days_before').defaultTo(7);
      t.boolean('notify_technician').defaultTo(true);
      t.boolean('notify_admin').defaultTo(true);
      t.decimal('estimated_cost', 10, 2);
      t.decimal('estimated_downtime_hours', 6, 1);
      t.boolean('is_active').defaultTo(true);
      t.timestamps(true, true);

      t.index('equipment_id');
      t.index('next_due_at');
      t.index('is_overdue');
    });
  }

  // ── Maintenance Records ────────────────────────────────────────
  if (!(await knex.schema.hasTable('maintenance_records'))) {
    await knex.schema.createTable('maintenance_records', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.uuid('schedule_id').nullable().references('id').inTable('maintenance_schedules').onDelete('SET NULL');
      t.string('maintenance_type', 20).notNullable().defaultTo('scheduled');
      t.string('task_name', 200).notNullable();
      t.text('description');
      t.timestamp('performed_at').defaultTo(knex.fn.now());
      t.string('performed_by', 200);
      t.string('vendor_name', 200);
      t.integer('miles_at_service');
      t.decimal('hours_at_service', 10, 1);
      t.integer('condition_before');
      t.integer('condition_after');
      t.decimal('parts_cost', 10, 2).defaultTo(0);
      t.decimal('labor_cost', 10, 2).defaultTo(0);
      t.decimal('vendor_cost', 10, 2).defaultTo(0);
      t.decimal('total_cost', 10, 2).defaultTo(0);
      t.string('receipt_url', 500);
      t.decimal('downtime_hours', 8, 1).defaultTo(0);
      t.boolean('equipment_was_down').defaultTo(false);
      t.jsonb('parts_used');
      t.boolean('follow_up_needed').defaultTo(false);
      t.text('follow_up_notes');
      t.date('follow_up_date');
      t.boolean('warranty_claim').defaultTo(false);
      t.string('warranty_claim_status', 30);
      t.timestamps(true, true);

      t.index('equipment_id');
      t.index('performed_at');
      t.index('maintenance_type');
    });
  }

  // ── Equipment Downtime Log ─────────────────────────────────────
  if (!(await knex.schema.hasTable('equipment_downtime_log'))) {
    await knex.schema.createTable('equipment_downtime_log', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.uuid('maintenance_record_id').nullable().references('id').inTable('maintenance_records').onDelete('SET NULL');
      t.string('reason', 200);
      t.timestamp('started_at').notNullable();
      t.timestamp('ended_at').nullable();
      t.decimal('duration_hours', 8, 1);
      t.integer('jobs_affected').defaultTo(0);
      t.decimal('revenue_impact', 10, 2).defaultTo(0);
      t.string('backup_equipment_used', 200);
      t.text('operational_notes');
      t.timestamps(true, true);

      t.index('equipment_id');
      t.index('started_at');
    });
  }

  // ── Vehicle Mileage Log ────────────────────────────────────────
  if (!(await knex.schema.hasTable('vehicle_mileage_log'))) {
    await knex.schema.createTable('vehicle_mileage_log', (t) => {
      t.increments('id').primary();
      t.uuid('vehicle_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.date('log_date').notNullable();
      t.integer('odometer_start');
      t.integer('odometer_end');
      t.decimal('total_miles', 8, 1);
      t.string('source', 30).defaultTo('manual');
      t.jsonb('gps_data');
      t.decimal('business_miles', 8, 1);
      t.decimal('personal_miles', 8, 1).defaultTo(0);
      t.decimal('business_pct', 5, 2);
      t.decimal('fuel_gallons', 6, 2);
      t.decimal('fuel_cost', 8, 2);
      t.decimal('fuel_price_per_gallon', 5, 3);
      t.integer('jobs_serviced');
      t.jsonb('job_ids');
      t.decimal('irs_standard_rate', 5, 2).defaultTo(0.70);
      t.decimal('irs_deduction_amount', 10, 2);
      t.string('logged_by', 200);
      t.text('notes');
      t.timestamps(true, true);

      t.unique(['vehicle_id', 'log_date']);
      t.index('log_date');
      t.index('vehicle_id');
    });
  }

  // ── Maintenance Alerts ─────────────────────────────────────────
  if (!(await knex.schema.hasTable('maintenance_alerts'))) {
    await knex.schema.createTable('maintenance_alerts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
      t.uuid('schedule_id').nullable().references('id').inTable('maintenance_schedules').onDelete('SET NULL');
      t.string('alert_type', 30).notNullable();
      t.string('severity', 10).defaultTo('medium');
      t.string('title', 300).notNullable();
      t.text('description');
      t.string('status', 20).defaultTo('new');
      t.timestamp('resolved_at');
      t.string('resolved_by', 200);
      t.timestamps(true, true);

      t.index('status');
      t.index('severity');
      t.index('equipment_id');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('maintenance_alerts');
  await knex.schema.dropTableIfExists('vehicle_mileage_log');
  await knex.schema.dropTableIfExists('equipment_downtime_log');
  await knex.schema.dropTableIfExists('maintenance_records');
  await knex.schema.dropTableIfExists('maintenance_schedules');

  // Remove added columns from equipment (don't drop the table — it existed before)
  const hasAssetTag = await knex.schema.hasColumn('equipment', 'asset_tag');
  if (hasAssetTag) {
    await knex.schema.alterTable('equipment', (t) => {
      t.dropColumn('asset_tag');
      t.dropColumn('subcategory');
      t.dropColumn('year');
      t.dropColumn('vin');
      t.dropColumn('license_plate');
      t.dropColumn('purchase_vendor');
      t.dropColumn('warranty_expiration');
      t.dropColumn('warranty_details');
      t.dropColumn('tax_equipment_id');
      t.dropColumn('useful_life_years');
      t.dropColumn('salvage_value');
      t.dropColumn('condition_rating');
      t.dropColumn('location');
      t.dropColumn('assigned_vehicle_id');
      t.dropColumn('engine_type');
      t.dropColumn('fuel_type');
      t.dropColumn('current_miles');
      t.dropColumn('photo_url');
    });
  }
};
