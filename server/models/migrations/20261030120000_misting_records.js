/**
 * Misting system records (dark behind GATE_MOSQUITO_MISTING; owner 2026-10-30 "yes"): the install
 * calibration and one row per tank refill for an automatic mosquito misting system.
 *
 * misting_calibrations holds the spray-rate math done at install, so the pesticide label's daily limit
 * can be checked (wiki/protocols/mosquito-misting-systems.md step 7). It is APPEND-ONLY: a
 * re-calibration, or any correction, is a NEW row, and the newest non-voided row for a
 * (customer_id, property_id) pair is that system's current record. property_id NULL is the customer's
 * primary / single home, the same reading as scheduled_services.property_id. The computed columns
 * (treated_volume_cu_ft, output_fl_oz_per_cycle, daily_output_fl_oz, label_daily_cap_fl_oz) are set by
 * the server from the measured inputs, never taken from the client; the CHECKs keep a hand-written row
 * from storing a system that puts out more than the label allows.
 *
 * misting_refills is the refill log the label and Florida's pest-control records rule need: product,
 * EPA reg. no., amount, date, who. A refill belongs to the calibration that was current when it was
 * logged. A row is never deleted by staff: voiding sets voided_at / voided_by / void_reason.
 *
 * source is 'staff' for now; vendor or sensor data can plug in later by a migration that widens the CHECK.
 *
 * The customer app reads both tables (last refill, next mist time) in a later PR; the names here are
 * that contract.
 *
 * down() drops misting_refills, then misting_calibrations. Both hold staff-entered records, so a
 * rollback after real use loses them.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('misting_calibrations'))) {
    await knex.schema.createTable('misting_calibrations', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
      t.date('installed_on').notNullable(); // ET calendar day
      t.string('vendor', 60).notNullable();
      t.string('model', 120).notNullable();
      t.string('serial_number', 80).nullable();
      t.decimal('tank_gallons', 6, 2).notNullable();
      t.integer('zone_count').notNullable().defaultTo(1);
      t.integer('nozzle_count').notNullable();
      t.integer('riser_count').notNullable().defaultTo(0); // each riser carries one nozzle
      t.decimal('nozzle_flow_fl_oz_per_min', 8, 3).notNullable(); // per emitter, one nozzle into a cup for 60 s
      t.integer('cycle_seconds').notNullable();
      t.specificType('mist_times', 'text[]').notNullable(); // "HH:MM" America/New_York, sorted, unique
      t.string('product_name', 120).notNullable();
      t.string('epa_reg_no', 40).notNullable();
      t.decimal('concentrate_fl_oz_per_tank', 8, 2).notNullable();
      t.decimal('label_max_fl_oz_per_1000_cu_ft_day', 8, 3).notNullable();
      t.decimal('treated_area_sq_ft', 10, 1).notNullable();
      t.decimal('treated_height_ft', 4, 1).notNullable();
      // Server-computed (services/misting-calibration-math.js).
      t.decimal('treated_volume_cu_ft', 12, 1).notNullable();
      t.decimal('output_fl_oz_per_cycle', 10, 3).notNullable();
      t.decimal('daily_output_fl_oz', 10, 3).notNullable();
      t.decimal('label_daily_cap_fl_oz', 12, 3).notNullable();
      t.boolean('cabinet_locked').notNullable();
      t.boolean('label_posted').notNullable();
      t.boolean('schedule_avoids_people').notNullable();
      t.text('notes').nullable();
      t.string('source', 20).notNullable().defaultTo('staff');
      t.uuid('recorded_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('voided_at', { useTz: true }).nullable();
      t.uuid('voided_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.text('void_reason').nullable();
      t.timestamps(true, true);

      t.check('tank_gallons > 0', [], 'misting_calibrations_tank_gallons_positive');
      t.check('zone_count >= 1', [], 'misting_calibrations_zone_count_positive');
      t.check('nozzle_count >= 0', [], 'misting_calibrations_nozzle_count_nonneg');
      t.check('riser_count >= 0', [], 'misting_calibrations_riser_count_nonneg');
      t.check('nozzle_count + riser_count >= 1', [], 'misting_calibrations_has_emitter');
      t.check('nozzle_flow_fl_oz_per_min > 0', [], 'misting_calibrations_nozzle_flow_positive');
      t.check('cycle_seconds > 0', [], 'misting_calibrations_cycle_seconds_positive');
      t.check('cardinality(mist_times) >= 1', [], 'misting_calibrations_mist_times_present');
      t.check('concentrate_fl_oz_per_tank > 0', [], 'misting_calibrations_concentrate_positive');
      t.check('label_max_fl_oz_per_1000_cu_ft_day > 0', [], 'misting_calibrations_label_max_positive');
      t.check('treated_area_sq_ft > 0', [], 'misting_calibrations_area_positive');
      t.check('treated_height_ft > 0', [], 'misting_calibrations_height_positive');
      t.check('daily_output_fl_oz <= label_daily_cap_fl_oz', [], 'misting_calibrations_within_label');
      t.check('cabinet_locked AND label_posted AND schedule_avoids_people', [], 'misting_calibrations_checks_all_true');
      t.check("source IN ('staff')", [], 'misting_calibrations_source_known');
      t.check(
        '(voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)',
        [],
        'misting_calibrations_void_consistent',
      );
    });
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS misting_calibrations_customer_recent '
      + 'ON misting_calibrations (customer_id, created_at DESC) WHERE voided_at IS NULL',
    );
  }

  if (!(await knex.schema.hasTable('misting_refills'))) {
    await knex.schema.createTable('misting_refills', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('calibration_id').notNullable().references('id').inTable('misting_calibrations').onDelete('CASCADE');
      // Copied from the calibration at insert.
      t.uuid('property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
      t.date('refilled_on').notNullable(); // ET calendar day
      t.string('product_name', 120).notNullable();
      t.string('epa_reg_no', 40).notNullable();
      t.decimal('concentrate_fl_oz_added', 8, 2).notNullable();
      t.decimal('water_gallons_added', 6, 2).notNullable();
      t.integer('level_before_pct').nullable();
      // Pynamite's level is a mist-time counter that staff reset by hand at each fill.
      t.boolean('counter_reset').notNullable().defaultTo(false);
      t.text('notes').nullable();
      t.string('source', 20).notNullable().defaultTo('staff');
      t.uuid('recorded_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('voided_at', { useTz: true }).nullable();
      t.uuid('voided_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.text('void_reason').nullable();
      t.timestamps(true, true);

      t.index(['calibration_id'], 'misting_refills_calibration');
      t.check('concentrate_fl_oz_added > 0', [], 'misting_refills_concentrate_positive');
      t.check('water_gallons_added > 0', [], 'misting_refills_water_positive');
      t.check('level_before_pct IS NULL OR (level_before_pct BETWEEN 0 AND 100)', [], 'misting_refills_level_pct_range');
      t.check("source IN ('staff')", [], 'misting_refills_source_known');
      t.check(
        '(voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)',
        [],
        'misting_refills_void_consistent',
      );
    });
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS misting_refills_customer_recent '
      + 'ON misting_refills (customer_id, refilled_on DESC) WHERE voided_at IS NULL',
    );
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('misting_refills');
  await knex.schema.dropTableIfExists('misting_calibrations');
};
